// Host configuration for Claude Code and Codex (pure): what `gru install`
// writes, and how it merges into files the user already has.
//
// Why: Escapement's lesson was that an update must report conflicts rather
// than clobber a user's hooks. Every merge here only appends: an identical
// GRU entry is not duplicated, a GRU entry that differs (a stale install)
// is reported and left alone, and a file that is not the expected shape is
// reported and returned unchanged.
//
// The hook commands are shell strings the host runs, so every path placed
// in them is checked: absolute, and free of characters that would end the
// double quotes or expand inside them. GRU itself never runs a shell.
//
// Honest limits: Codex gets an MCP server entry and a SessionStart hook
// only. The Escapement adapter evidences no Codex pre-tool hook, so Codex's
// built-in tools are not mediated (see hooks/host-map.ts). The config.toml
// merge is a line scanner, not a TOML parser: anything that might already
// define the gru server is reported as a conflict rather than guessed at.
// Windows paths are not supported in slice 1 (the hook socket is unix-only).

import { isAbsolute } from "node:path";
import { canonical } from "../ledger/canonical.ts";

export class InstallError extends Error {
  override name = "InstallError";
}

export interface InstallPaths {
  /** Absolute path of the gru CLI entry point (src/cli.ts). */
  cliPath: string;
  contractPath: string;
  workspace: string;
  stateDir: string;
}

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksFile {
  hooks: Record<string, HookGroup[]>;
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface ClaudeCodeConfig {
  /** For .mcp.json (project) or the user's MCP configuration. */
  mcp: { mcpServers: { gru: McpServerEntry } };
  /** For .claude/settings.json. */
  settings: HooksFile;
}

export interface CodexConfig {
  /** Appended to ~/.codex/config.toml. */
  configTomlSnippet: string;
  /** For .codex/hooks.json. */
  hooks: HooksFile;
}

export interface MergeResult<T> {
  merged: T;
  conflicts: string[];
}

/** Seconds. The hook client gives up at 10 s and answers "ask", before the host kills it. */
export const HOOK_TIMEOUT_SECONDS = 15;
/** Seconds. Escalations wait up to 5 min for the Director; verification runs the contract's checks. */
export const CODEX_TOOL_TIMEOUT_SECONDS = 600;

const UNSAFE_IN_QUOTES = /["$`\\\n\r\0]/;

function checkPaths(paths: InstallPaths): void {
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value !== "string" || value.length === 0) throw new InstallError(`${name} must be a non-empty path`);
    if (!isAbsolute(value)) throw new InstallError(`${name} must be absolute: ${value}`);
    if (UNSAFE_IN_QUOTES.test(value)) {
      throw new InstallError(`${name} contains a character that cannot be placed safely in a hook command: ${value}`);
    }
  }
}

function mcpEntry(paths: InstallPaths): McpServerEntry {
  return {
    command: "node",
    args: [paths.cliPath, "mcp", "--contract", paths.contractPath, "--workspace", paths.workspace, "--state", paths.stateDir],
  };
}

function hookCommand(paths: InstallPaths, host: "claude-code" | "codex", event: string): HookCommand {
  return {
    type: "command",
    command: `node "${paths.cliPath}" hook ${host} ${event} --state "${paths.stateDir}"`,
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

export function claudeCodeConfig(paths: InstallPaths): ClaudeCodeConfig {
  checkPaths(paths);
  return {
    mcp: { mcpServers: { gru: mcpEntry(paths) } },
    settings: {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [hookCommand(paths, "claude-code", "PreToolUse")] }],
        PostToolUse: [{ matcher: "*", hooks: [hookCommand(paths, "claude-code", "PostToolUse")] }],
        SessionStart: [{ hooks: [hookCommand(paths, "claude-code", "SessionStart")] }],
      },
    },
  };
}

function tomlString(value: string): string {
  // Paths are already free of quotes, backslashes and control characters,
  // so a JSON string literal is also a valid TOML basic string.
  return JSON.stringify(value);
}

export function codexConfig(paths: InstallPaths): CodexConfig {
  checkPaths(paths);
  const entry = mcpEntry(paths);
  const snippet = [
    "# GRU governed tools (written by gru install). The tool timeout is raised because an",
    "# escalation waits for the Project Director and gru_verify_and_close runs the checks.",
    "[mcp_servers.gru]",
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    "",
  ].join("\n");
  return {
    configTomlSnippet: snippet,
    // SessionStart only: Stop and UserPromptSubmit exist in Codex but GRU has
    // nothing to say there, and no pre-tool event is evidenced.
    hooks: { hooks: { SessionStart: [{ hooks: [hookCommand(paths, "codex", "SessionStart")] }] } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

const GRU_HOOK = /\bhook (claude-code|codex) (\S+) --state\b/;

function commandsIn(groups: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (isRecord(hook) && typeof hook.command === "string") commands.push(hook.command);
    }
  }
  return commands;
}

/**
 * Append GRU's hook groups to an existing hooks file (.claude/settings.json
 * or .codex/hooks.json). Never removes or rewrites an existing entry.
 */
export function mergeHooks(existing: unknown, additions: HooksFile): MergeResult<unknown> {
  if (existing === undefined || existing === null) {
    return { merged: structuredClone(additions), conflicts: [] };
  }
  if (!isRecord(existing)) {
    return { merged: existing, conflicts: ["the existing file is not a JSON object; GRU hooks were not merged"] };
  }
  if (existing.hooks !== undefined && !isRecord(existing.hooks)) {
    return { merged: existing, conflicts: ['"hooks" is not an object; GRU hooks were not merged'] };
  }
  const merged = structuredClone(existing);
  const hooks = (merged.hooks ??= {}) as Record<string, unknown>;
  const conflicts: string[] = [];

  for (const [event, groups] of Object.entries(additions.hooks)) {
    const current = hooks[event];
    if (current === undefined) {
      hooks[event] = structuredClone(groups);
      continue;
    }
    if (!Array.isArray(current)) {
      conflicts.push(`hooks.${event} is not an array; the GRU ${event} hook was not added`);
      continue;
    }
    const present = commandsIn(current);
    for (const group of groups) {
      if (current.some((entry) => same(entry, group))) continue;
      const wanted = group.hooks.map((hook) => hook.command);
      if (wanted.every((command) => present.includes(command))) continue;
      const stale = present.filter((command) => {
        const found = GRU_HOOK.exec(command);
        return found !== null && found[2] === event && !wanted.includes(command);
      });
      if (stale.length > 0) {
        conflicts.push(
          `hooks.${event} already has a different GRU hook (${stale.join(" | ")}); it was not rewritten and the new one was not added`,
        );
        continue;
      }
      current.push(structuredClone(group));
    }
  }
  return { merged, conflicts };
}

/** Add the gru server to an MCP config (.mcp.json shape) without touching other servers. */
export function mergeMcpServers(
  existing: unknown,
  additions: { mcpServers: Record<string, McpServerEntry> },
): MergeResult<unknown> {
  if (existing === undefined || existing === null) return { merged: structuredClone(additions), conflicts: [] };
  if (!isRecord(existing)) {
    return { merged: existing, conflicts: ["the existing file is not a JSON object; the gru server was not merged"] };
  }
  if (existing.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
    return { merged: existing, conflicts: ['"mcpServers" is not an object; the gru server was not merged'] };
  }
  const merged = structuredClone(existing);
  const servers = (merged.mcpServers ??= {}) as Record<string, unknown>;
  const conflicts: string[] = [];
  for (const [name, entry] of Object.entries(additions.mcpServers)) {
    if (servers[name] === undefined) servers[name] = structuredClone(entry);
    else if (!same(servers[name], entry)) conflicts.push(`mcpServers.${name} already exists with a different definition; not rewritten`);
  }
  return { merged, conflicts };
}

const KEY_GRU = String.raw`(?:gru|"gru"|'gru')`;
const TABLE_HEADER = /^\s*\[\s*([^\]]*?)\s*\]/;
const GRU_TABLE = new RegExp(String.raw`^mcp_servers\s*\.\s*${KEY_GRU}\s*(?:\.|$)`);
const GRU_DOTTED_TOP = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${KEY_GRU}\s*[.=]`);
const GRU_IN_SERVERS = new RegExp(String.raw`^\s*${KEY_GRU}\s*[.=]`);
const INLINE_SERVERS = /^\s*mcp_servers\s*=/;

/** Append the snippet to config.toml text unless something may already define the gru server. */
export function mergeCodexToml(existing: string, snippet: string): MergeResult<string> {
  if (existing.includes(snippet.trim())) return { merged: existing, conflicts: [] };
  let table = "";
  for (const line of existing.split(/\r?\n/)) {
    const header = TABLE_HEADER.exec(line);
    if (header && !line.trim().startsWith("[[")) {
      table = header[1] ?? "";
      if (GRU_TABLE.test(table)) {
        return { merged: existing, conflicts: [`config.toml already defines [${table}]; not rewritten`] };
      }
      continue;
    }
    const topLevel = table === "";
    if ((topLevel && (GRU_DOTTED_TOP.test(line) || INLINE_SERVERS.test(line))) || (table === "mcp_servers" && GRU_IN_SERVERS.test(line))) {
      return { merged: existing, conflicts: [`config.toml may already define the gru MCP server (${line.trim()}); not rewritten`] };
    }
  }
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { merged: `${existing}${separator}${snippet}`, conflicts: [] };
}
