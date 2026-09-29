// Terminal rendering for the GRU surface: colour, banners, escalation
// cards, live turns and the closure report.
//
// Most of what reaches the terminal was written by the model (turn text,
// tool input such as paths) or read from the workspace (tool results).
// That text is T3/T4 and is passed through safeText before it is printed,
// so an escape sequence in a file name cannot repaint the escalation card,
// hide a line, or fake an "approved" banner. The limit: safeText escapes
// control and bidi-override characters, not look-alike Unicode, so a
// homoglyph path still renders as a homoglyph.
//
// Colour is decoration only and is off unless the output is a terminal and
// NO_COLOR is unset or empty (https://no-color.org). Nothing is conveyed by
// colour alone; every status is also a word.

import type { Consequence } from "../avl/consequence.ts";
import type {
  CredentialStatus,
  DirectorDecision,
  EpisodeReport,
  EscalationRequest,
  ModelTurn,
  ProbeResult,
  ProviderConfig,
  RouteDescriptor,
  SafetyMode,
  ToolCall,
  ToolResult,
} from "../types.ts";
import type { Effect } from "../avl/actions.ts";

export interface Style {
  readonly color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export function makeStyle(options: { isTTY: boolean; env: Readonly<Record<string, string | undefined>> }): Style {
  const noColor = options.env.NO_COLOR;
  const color = options.isTTY && (noColor === undefined || noColor === "");
  const wrap = (open: number, close: number) => (text: string) =>
    color ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    color,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

export const PLAIN: Style = makeStyle({ isTTY: false, env: {} });

// The Unicode bidirectional marks, embeddings, overrides and isolates, which
// can reorder what a line appears to say. Written as numbers on purpose:
// the characters themselves are invisible in source.
const BIDI_CONTROLS: ReadonlySet<number> = new Set([
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** C0 controls, DEL, C1 controls and bidi controls; newline and tab only in single-line mode. */
function isUnsafe(code: number, multiline: boolean): boolean {
  if (multiline && (code === 0x0a || code === 0x09)) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || BIDI_CONTROLS.has(code);
}

function escapeCode(code: number): string {
  if (code === 0x0a) return "\\n";
  if (code === 0x09) return "\\t";
  if (code === 0x0d) return "\\r";
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Make untrusted text safe to print. Single-line mode (the default) also
 * escapes newlines, so a model-chosen path cannot add lines to a card.
 */
export function safeText(value: unknown, options: { multiline?: boolean; max?: number } = {}): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const multiline = options.multiline === true;
  let escaped = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    escaped += isUnsafe(code, multiline) ? escapeCode(code) : char;
  }
  const max = options.max ?? Infinity;
  return escaped.length > max ? `${escaped.slice(0, max)}… (${escaped.length - max} more characters)` : escaped;
}

/** Plain-words meaning of each Core threat-model property (Core threat model v0.1 §3). */
const PROPERTY_WORDS: Readonly<Record<string, string>> = {
  P1: "code that a command runs could read secrets GRU holds",
  P2: "code that a command runs could change GRU's policy or ledger state",
  P3: "an effect could happen without an authorization bound to it",
  P4: "delegated authority could be widened",
  P5: "recorded evidence could be modified",
  P6: "a learning proposal could be promoted by its author",
  P7: "the test that certifies a proposal could be weakened",
  P8: "code that a command runs has your user's filesystem, network and credential access",
  P9: "an authorization could be replayed for a different effect",
  P10: "revocation and expiry might not be checked",
};

export function plainProperty(property: string): string {
  const id = /^P\d+/.exec(property)?.[0];
  const words = id === undefined ? undefined : PROPERTY_WORDS[id];
  return words === undefined ? safeText(property) : `${id}  ${words}`;
}

export function safetyLines(safety: SafetyMode, style: Style): string[] {
  if (safety.mode === "GOVERNED" && safety.unmet.length === 0) {
    return [`${style.green("GOVERNED")}  isolation backends: ${safety.backends.map((b) => safeText(b)).join(", ") || "none"}`];
  }
  const head =
    safety.backends.length === 0
      ? "no isolation backend; commands run with your user's authority"
      : `backends ${safety.backends.map((b) => safeText(b)).join(", ")} leave properties unmet`;
  const lines = [`${style.yellow(style.bold(safety.mode))}  ${head}`];
  for (const property of safety.unmet) lines.push(`  unmet ${plainProperty(property)}`);
  return lines;
}

/** Drop userinfo and query from a URL before showing it; either can carry a credential. */
export function displayUrl(url: string | null): string {
  if (url === null || url === "") return "-";
  try {
    const parsed = new URL(url);
    const query = parsed.search === "" ? "" : "?…";
    return safeText(`${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`);
  } catch {
    return "(unparseable url)";
  }
}

export function routeLabel(descriptor: RouteDescriptor): string {
  return `${safeText(descriptor.provider)}/${safeText(descriptor.model)} (${descriptor.kind})`;
}

export function renderEpisodeBanner(
  input: { episode_id: string; route: RouteDescriptor; safety: SafetyMode; workspace: string; director: string },
  style: Style,
): string {
  const rows: [string, string][] = [
    ["episode", safeText(input.episode_id)],
    ["route", routeLabel(input.route)],
    ["workspace", safeText(input.workspace)],
    ["director", safeText(input.director)],
  ];
  const lines = [style.bold("GRU episode")];
  for (const [key, value] of rows) lines.push(`  ${key.padEnd(10)} ${value}`);
  const [first, ...rest] = safetyLines(input.safety, style);
  lines.push(`  ${"safety".padEnd(10)} ${first ?? ""}`);
  for (const line of rest) lines.push(`  ${" ".repeat(10)} ${line.trimStart()}`);
  return `${lines.join("\n")}\n`;
}

export function describeEffect(effect: Effect): string {
  switch (effect.kind) {
    case "fs.read":
    case "fs.list":
    case "fs.delete":
      return `${effect.kind} ${safeText(effect.path)}`;
    case "fs.write":
      return `${effect.kind} ${safeText(effect.path)} (${effect.bytes} bytes, sha256 ${effect.content_sha256.slice(0, 12)})`;
    case "process.run":
      return `${effect.kind} ${safeText(effect.command_id)}`;
    case "host.exec":
      return `${effect.kind} via ${safeText(effect.tool)}: ${safeText(effect.command, { max: 200 })}`;
    case "host.fetch":
      return `${effect.kind} via ${safeText(effect.tool)}: ${safeText(effect.url, { max: 200 })}`;
    case "host.other":
      return `${effect.kind} via ${safeText(effect.tool)} (input sha256 ${safeText(effect.input_sha256).slice(0, 12)})`;
  }
}

/** One-line summary of a tool call's input. The input is model output, so every field is escaped. */
export function describeCall(call: ToolCall): string {
  const input = call.input;
  const name = safeText(call.name, { max: 60 });
  if (typeof input !== "object" || input === null || Array.isArray(input)) return `${name} (malformed input)`;
  const record = input as Record<string, unknown>;
  if (typeof record.command_id === "string") return `${name} ${safeText(record.command_id, { max: 80 })}`;
  if (typeof record.path === "string") {
    const size = typeof record.content === "string" ? ` (${record.content.length} chars)` : "";
    return `${name} ${safeText(record.path, { max: 200 })}${size}`;
  }
  return `${name} ${safeText(JSON.stringify(record) ?? "", { max: 120 })}`;
}

function firstLine(text: string, max = 160): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return safeText(line.trim(), { max });
}

export function renderTurn(turn: ModelTurn, style: Style, expectedModel?: string): string {
  const lines: string[] = [];
  const text = turn.text.trim();
  if (text !== "") {
    const body = safeText(text, { multiline: true, max: 4000 }).split("\n");
    for (const line of body) lines.push(`${style.dim("minion │")} ${line}`);
  }
  if (expectedModel !== undefined && turn.served_model !== "" && turn.served_model !== expectedModel) {
    lines.push(style.yellow(`  served by ${safeText(turn.served_model)} (route asked for ${safeText(expectedModel)})`));
  }
  if (turn.stop === "refusal") lines.push(style.yellow(`  the model refused${turn.detail ? `: ${safeText(turn.detail, { max: 200 })}` : ""}`));
  if (turn.stop === "max_tokens") lines.push(style.yellow("  the turn hit the output limit; its tool calls are not run"));
  if (turn.stop === "other") lines.push(style.yellow(`  the turn stopped abnormally${turn.detail ? `: ${safeText(turn.detail, { max: 200 })}` : ""}`));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function renderCall(call: ToolCall, result: ToolResult, style: Style): string {
  const mark = result.ok ? style.green("✓") : style.red("✗");
  const status = result.ok ? "done" : "refused or failed";
  let line = `  ${mark} ${describeCall(call)}  ${style.dim(status)}`;
  if (!result.ok || call.name === "run_command") {
    const detail = firstLine(result.content);
    if (detail !== "") line += `\n      ${style.dim(detail)}`;
  }
  return `${line}\n`;
}

export function renderEscalation(request: EscalationRequest, style: Style): string {
  const bar = "─".repeat(60);
  const lines = [
    style.yellow(bar),
    style.bold(style.yellow("Director approval needed")),
    `  tool          ${safeText(request.tool, { max: 80 })}`,
    `  effect        ${describeEffect(request.effect)}`,
    `  consequences  ${request.consequences.map((c: Consequence) => safeText(c)).join(", ") || "-"}`,
    `  proposed by   ${safeText(request.principal)}`,
    `  authorization ${safeText(request.authorization_id)}`,
    "  AVL says:",
    ...request.reasons.map((reason) => `    - ${safeText(reason, { max: 300 })}`),
    style.yellow(bar),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderDecision(request: EscalationRequest, decision: DirectorDecision, style: Style): string {
  const verdict = decision.decision === "APPROVE" ? style.green("APPROVED") : style.red("REJECTED");
  const consequences = request.consequences.map((c) => safeText(c)).join(", ");
  return (
    `  ${style.yellow("⚑")} escalated ${describeEffect(request.effect)} [${consequences}]\n` +
    `      ${verdict} by ${safeText(decision.actor)}: ${safeText(decision.reason, { max: 200 })}\n`
  );
}

const CLOSURE_COLOUR: Record<string, (style: Style, text: string) => string> = {
  PASS: (style, text) => style.green(text),
  FAIL: (style, text) => style.red(text),
  PARTIAL: (style, text) => style.yellow(text),
  ABANDONED: (style, text) => style.yellow(text),
};

export function renderReport(report: EpisodeReport, style: Style): string {
  const v = report.verification;
  const status = report.closure.status;
  const paint = CLOSURE_COLOUR[status] ?? ((_: Style, text: string) => text);
  const lines = [
    style.bold("Closure"),
    `  status        ${paint(style, style.bold(status))}`,
    `  rationale     ${safeText(report.closure.rationale, { max: 500 })}`,
    `  verification  ${v.outcome}, strength ${v.strength} (required ${v.required})`,
  ];
  for (const check of v.checks) {
    lines.push(`    ${check.passed ? style.green("✓") : style.red("✗")} check ${safeText(check.id)}  exit ${check.exit_code}  ${check.passed ? "passed" : "failed"}`);
  }
  for (const check of v.must_fail) {
    lines.push(
      `    ${check.failed_as_required ? style.green("✓") : style.red("✗")} must-fail ${safeText(check.id)}  exit ${check.exit_code}  ${check.failed_as_required ? "failed as required" : "did not fail"}`,
    );
  }
  lines.push(`  protected     ${v.protected_unchanged ? "unchanged" : style.red("changed during the episode")}`);
  lines.push(`  admissibility ${report.admissibility.verdict}`);
  if (report.violations.length === 0) {
    lines.push("  violations    none");
  } else {
    lines.push(`  violations    ${style.red(String(report.violations.length))}`);
    for (const violation of report.violations) lines.push(`    - ${safeText(violation, { max: 300 })}`);
  }
  const [first, ...rest] = safetyLines(report.safety, style);
  lines.push(`  safety        ${first ?? ""}`);
  for (const line of rest) lines.push(`                ${line.trimStart()}`);
  lines.push(`  ledger        ${report.ledger_path === null ? "in memory (not persisted)" : safeText(report.ledger_path)}`);
  return `${lines.join("\n")}\n`;
}

export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const format = (row: readonly string[]) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  ").trimEnd();
  return `${[format(header), ...rows.map(format)].join("\n")}\n`;
}

/**
 * The provider table shows where a credential would come from and whether
 * it is present, never its value; headers are not shown at all because
 * they are where a pasted credential would sit.
 */
export function renderProviders(rows: readonly { config: ProviderConfig; credential: CredentialStatus }[]): string {
  if (rows.length === 0) return "no providers configured\n";
  return formatTable(
    ["id", "kind", "base url", "credential"],
    rows.map(({ config, credential }) => [
      safeText(config.id),
      config.kind,
      displayUrl(config.base_url),
      config.api_key_env === null ? credential : `${credential} (env ${safeText(config.api_key_env)})`,
    ]),
  );
}

export function renderProbes(probes: readonly ProbeResult[]): string {
  return formatTable(
    ["model", "result", "latency", "error"],
    probes.map((probe) => [
      safeText(probe.model),
      probe.ok ? "ok" : "failed",
      probe.latency_ms === null ? "-" : `${probe.latency_ms} ms`,
      probe.error === null ? "" : safeText(probe.error, { max: 120 }),
    ]),
  );
}
