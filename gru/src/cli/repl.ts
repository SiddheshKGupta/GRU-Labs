// The interactive terminal: type a task, watch a governed Minion work on
// it in the current directory, answer escalations, read the closure.
//
// Each task is its own episode with an ad-hoc MATERIAL contract. Commands
// and the verification contract come from ./gru.contract.json, read once
// when the REPL starts (or on /contract reload, a Director action), never
// re-read behind the Director's back: the file sits in the workspace, so
// a Minion could otherwise rewrite the contract for the next task. For
// the same reason every ad-hoc contract protects gru.contract.json and
// gru.config.json, so changing either needs the Director's approval.
//
// Without declared checks an episode cannot close PASS. The REPL says so
// before running rather than implying the model's "done" means anything.
//
// The REPL and the interactive Director read one shared LineInput, so an
// answer to an escalation is never also read as the next task. Errors are
// printed and the prompt returns; nothing a task does ends the session.
//
// Limit: a running task cannot be interrupted; it stops at its budgets.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GruConfig } from "../config.ts";
import { InteractiveDirector, LineInput } from "../director/channels.ts";
import { sha256 as sha256Of } from "../ledger/canonical.ts";
import type { Blocks, ClosureStatus, ProviderCatalog } from "../types.ts";
import { runEpisode, type Io } from "./main.ts";
import { makeStyle, renderProbes, renderProviders, routeLabel, safeText, type Style } from "./render.ts";

export const CONTRACT_FILE = "gru.contract.json";
export const ALWAYS_PROTECTED = [CONTRACT_FILE, "gru.config.json"] as const;

export interface ContractSource {
  path: string | null;
  sha256: string | null;
  commands: unknown;
  verification: unknown;
  /** Why the file could not be used; tasks are refused until it is fixed or removed. */
  error: string | null;
}

export function loadContractSource(cwd: string): ContractSource {
  const path = join(cwd, CONTRACT_FILE);
  try {
    if (!statSync(path).isFile()) return { path: null, sha256: null, commands: undefined, verification: undefined, error: null };
  } catch {
    return { path: null, sha256: null, commands: undefined, verification: undefined, error: null };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { path, sha256: null, commands: undefined, verification: undefined, error: `cannot read: ${String(error)}` };
  }
  const sha256 = sha256Of(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { path, sha256, commands: undefined, verification: undefined, error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { path, sha256, commands: undefined, verification: undefined, error: "must be a JSON object" };
  }
  const record = json as Record<string, unknown>;
  return { path, sha256, commands: record.commands, verification: record.verification, error: null };
}

function withProtected(verification: unknown): unknown {
  if (typeof verification !== "object" || verification === null || Array.isArray(verification)) return verification;
  const record = verification as Record<string, unknown>;
  if (!Array.isArray(record.protected)) return verification;
  const merged = [...record.protected];
  for (const path of ALWAYS_PROTECTED) if (!merged.includes(path)) merged.push(path);
  return { ...record, protected: merged };
}

/** The raw contract a REPL task hands to blocks.parseContract. */
export function adHocContract(task: string, source: ContractSource): Record<string, unknown> {
  return {
    task,
    classification: "MATERIAL",
    grant: { scopes: ["workspace:read", "workspace:write"], ttl_seconds: 3600 },
    commands: source.commands ?? [],
    verification: withProtected(source.verification ?? { protected: [], checks: [], must_fail: [] }),
  };
}

export function parseSlashCommand(line: string): { name: string; args: string[] } {
  const [head = "/", ...args] = line.trim().split(/\s+/);
  return { name: head.slice(1).toLowerCase(), args };
}

export interface ReplOptions {
  io: Io;
  blocks: Blocks;
  config: GruConfig;
  configSource?: string | null;
}

interface LastEpisode {
  episode_id: string;
  closure: ClosureStatus;
  ledger_path: string | null;
}

const HELP = `Type a task in plain words and press Enter to run it as a governed episode.

  /help                     this list
  /providers                configured providers and credential status
  /model <provider/model>   use this route for the next task (no argument: show it)
  /models <provider>        list a provider's models
  /probe <provider> <model> check that a model answers
  /auto <provider>          probe a provider's models and switch to one that answers
  /status                   route, workspace, last episode and its closure
  /contract                 the commands and verification contract tasks use
  /contract reload          re-read ${CONTRACT_FILE} (a Director action)
  /quit                     leave (Ctrl-D also works)
`;

const UNSAFE_LINE =
  "UNSAFE_DEVELOPMENT: no isolation backend — commands you approve run with your user's authority";

function describeContract(source: ContractSource): string {
  if (source.error !== null) return `${CONTRACT_FILE} is unusable (${safeText(source.error, { max: 200 })}); tasks are refused until it is fixed`;
  if (source.path === null) return `none (no ${CONTRACT_FILE} here): tasks have no checks and cannot close PASS`;
  const ids = (value: unknown): string =>
    Array.isArray(value)
      ? value.map((entry) => (typeof entry === "object" && entry !== null ? safeText(String((entry as { id?: unknown }).id)) : "?")).join(", ") || "none"
      : "none";
  const verification = (source.verification ?? {}) as Record<string, unknown>;
  const protectedGlobs = Array.isArray(verification.protected) ? verification.protected.map((g) => safeText(String(g))).join(", ") : "";
  return [
    `${safeText(source.path)} (sha256 ${source.sha256?.slice(0, 12) ?? "?"})`,
    `    commands   ${ids(source.commands)}`,
    `    checks     ${ids(verification.checks)}`,
    `    must-fail  ${ids(verification.must_fail)}`,
    `    protected  ${protectedGlobs || "none"} (plus ${ALWAYS_PROTECTED.join(", ")} in every REPL task)`,
  ].join("\n");
}

export async function startRepl(options: ReplOptions): Promise<number> {
  const { io, blocks, config } = options;
  const style: Style = makeStyle({ isTTY: io.isTTY, env: io.env });
  const out = io.stdout;
  const lines = new LineInput(io.stdin, io.stdout, { terminal: io.isTTY });
  lines.onIdleInterrupt = () => {
    out.write("\n(a running task cannot be interrupted; it stops at its turn and tool budgets)\n");
  };

  let routeSpec: string | null = config.route;
  let contractSource = loadContractSource(io.cwd);
  let last: LastEpisode | null = null;
  let catalog: ProviderCatalog | null = null;
  const getCatalog = (): ProviderCatalog => {
    catalog ??= blocks.catalog(config.providers);
    return catalog;
  };
  const say = (text: string): void => {
    out.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  const describeRoute = (): string => {
    if (routeSpec === null) return "none (choose one with /model provider/model)";
    try {
      return routeLabel(getCatalog().route(routeSpec).descriptor);
    } catch (error) {
      return `${safeText(routeSpec)} (unusable: ${safeText(error instanceof Error ? error.message : String(error), { max: 200 })})`;
    }
  };

  say(
    [
      style.bold("GRU") + "  governed terminal, slice 1",
      `  workspace  ${safeText(io.cwd)}`,
      `  route      ${describeRoute()}`,
      `  config     ${options.configSource ? safeText(options.configSource) : "defaults (no config file found)"}`,
      `  contract   ${describeContract(contractSource)}`,
      style.yellow(UNSAFE_LINE),
      "Type a task, or /help. /quit or Ctrl-D leaves.",
      "",
    ].join("\n"),
  );

  async function runTask(task: string): Promise<void> {
    if (contractSource.error !== null) {
      throw new Error(`${CONTRACT_FILE} is unusable (${contractSource.error}); fix it and run /contract reload`);
    }
    if (routeSpec === null) throw new Error('no model route selected; use /model <provider/model> or set "route" in gru.config.json');
    const contract = blocks.parseContract(adHocContract(task, contractSource));
    if (contract.verification.checks.length === 0) {
      say(
        style.yellow(
          "No verification checks are declared, so this episode cannot close PASS: nothing independent\n" +
            "will have checked the work. That is the truthful outcome. Add checks in gru.contract.json to change it.",
        ),
      );
    }
    const route = getCatalog().route(routeSpec);
    const executor = blocks.executor(io.cwd, contract.commands);
    const director = new InteractiveDirector({ input: lines, output: out, style });
    const { report } = await runEpisode(
      {
        contract,
        workspace: io.cwd,
        state_dir: config.state_dir,
        route,
        executor,
        director,
        directorLabel: "interactive (this terminal)",
      },
      { blocks, out, style },
    );
    last = { episode_id: report.episode_id, closure: report.closure.status, ledger_path: report.ledger_path };
  }

  /** Returns true when the REPL should end. */
  async function slash(line: string): Promise<boolean> {
    const { name, args } = parseSlashCommand(line);
    const need = (count: number, usage: string): void => {
      if (args.length !== count) throw new Error(`usage: ${usage}`);
    };
    switch (name) {
      case "help":
        say(HELP);
        return false;
      case "quit":
      case "exit":
        return true;
      case "providers":
        say(renderProviders(getCatalog().list()));
        return false;
      case "model": {
        if (args.length === 0) {
          say(`route: ${describeRoute()}`);
          return false;
        }
        need(1, "/model <provider/model>");
        const spec = args[0] as string;
        const route = getCatalog().route(spec);
        routeSpec = spec;
        say(`route for the next task: ${routeLabel(route.descriptor)}`);
        return false;
      }
      case "models": {
        need(1, "/models <provider>");
        const models = await getCatalog().discover(args[0] as string);
        say(models.length === 0 ? "no models reported" : models.map((m) => safeText(m)).join("\n"));
        return false;
      }
      case "probe": {
        need(2, "/probe <provider> <model>");
        say(renderProbes([await getCatalog().probe(args[0] as string, args[1] as string)]));
        return false;
      }
      case "auto": {
        need(1, "/auto <provider>");
        const provider = args[0] as string;
        const selected = await getCatalog().autoSelect(provider);
        say(renderProbes(selected.probes));
        const spec = `${provider}/${selected.model}`;
        getCatalog().route(spec);
        routeSpec = spec;
        say(`route for the next task: ${safeText(spec)}`);
        return false;
      }
      case "status":
        say(
          [
            `  route      ${describeRoute()}`,
            `  workspace  ${safeText(io.cwd)}`,
            `  state      ${safeText(config.state_dir)}`,
            last === null
              ? "  last       no episode yet"
              : `  last       ${safeText(last.episode_id)}  closure ${last.closure}  ledger ${last.ledger_path === null ? "in memory" : safeText(last.ledger_path)}`,
          ].join("\n"),
        );
        return false;
      case "contract":
        if (args.length === 1 && args[0] === "reload") {
          contractSource = loadContractSource(io.cwd);
          say(`reloaded: ${describeContract(contractSource)}`);
          return false;
        }
        need(0, "/contract [reload]");
        say(`contract   ${describeContract(contractSource)}`);
        return false;
      default:
        throw new Error(`unknown command /${safeText(name, { max: 40 })}; /help lists commands`);
    }
  }

  try {
    for (;;) {
      const line = await lines.ask("gru> ");
      if (line === null) {
        say("");
        return 0;
      }
      const input = line.trim();
      if (input === "") continue;
      try {
        if (input.startsWith("/")) {
          if (await slash(input)) return 0;
        } else {
          await runTask(input);
        }
      } catch (error) {
        say(style.red(`error: ${safeText(error instanceof Error ? error.message : String(error), { multiline: true, max: 2000 })}`));
      }
    }
  } finally {
    lines.close();
  }
}
