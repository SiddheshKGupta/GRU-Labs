// The gru command line: argument parsing, commands, and the episode driver
// shared with the REPL.
//
// Everything effectful arrives through two objects: `io` (streams, env,
// cwd, whether a human is at a terminal) and `blocks` (the kernel,
// executor, routes and contract parser). This module never imports a
// sibling block's implementation, so tests drive it with fakes and the
// integration owner can swap any block.
//
// The exit code is the closure, not the model's opinion: 0 only when AVL
// closed the episode PASS. Usage errors exit 2, everything else 1.
//
// Parsing is hand-written and strict: unknown flags, missing values,
// repeated flags and stray positionals are errors, never ignored. Commands
// live in a table; the integration owner passes extra commands (verify,
// mcp, hook, install) as main's fourth argument.
//
// Limit: if the kernel itself throws mid-loop, the episode is left
// unclosed and the error is reported. No LoopOutcome describes a kernel
// failure truthfully, and closing under a borrowed outcome would record
// something that did not happen.

import { cpSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { principal } from "../avl/principal.ts";
import { expandHome, homeDirectory, loadConfig } from "../config.ts";
import {
  DenyAllDirector,
  InteractiveDirector,
  ScriptedDirector,
  loadDirectorScript,
} from "../director/channels.ts";
import { runMinion, type MinionEvent, type MinionRun } from "../minion/loop.ts";
import type {
  Blocks,
  DirectorChannel,
  EffectExecutor,
  EpisodeReport,
  ModelRoute,
  TaskContract,
} from "../types.ts";
import {
  makeStyle,
  renderCall,
  renderDecision,
  renderEpisodeBanner,
  renderProbes,
  renderProviders,
  renderReport,
  renderTurn,
  safeText,
  type Style,
} from "./render.ts";

export interface Io {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** True when a human is at a terminal (stdin and stdout are TTYs). */
  isTTY: boolean;
}

export interface CommandContext {
  io: Io;
  blocks: Blocks;
  style: Style;
}

export interface Command {
  name: string;
  /** One line for the command list. */
  summary: string;
  /** Full help, printed for `gru <name> --help`. */
  usage: string;
  run(args: readonly string[], context: CommandContext): Promise<number>;
}

export class UsageError extends Error {
  override name = "UsageError";
}

// ---------------------------------------------------------------- parsing

export type FlagKind = "string" | "boolean";

export interface ParsedArgs {
  flags: Record<string, string | true>;
  positionals: string[];
}

/**
 * Strict flag parser. Accepts `--name value`, `--name=value` and `--` to
 * end flags. Flag names in `spec` are written without the leading dashes.
 */
export function parseFlags(
  args: readonly string[],
  spec: { flags: Readonly<Record<string, FlagKind>>; positionals: readonly string[]; optionalPositionals?: number },
): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let flagsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (flagsEnded || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec.flags[name];
    if (kind === undefined) throw new UsageError(`unknown option --${name}`);
    if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} given more than once`);
    if (kind === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = args[index + 1];
      if (value !== undefined && value.startsWith("--")) value = undefined;
      else index++;
    }
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  const required = spec.positionals.length - (spec.optionalPositionals ?? 0);
  if (positionals.length < required) {
    throw new UsageError(`missing ${spec.positionals.slice(positionals.length).map((p) => `<${p}>`).join(" ")}`);
  }
  if (positionals.length > spec.positionals.length) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[spec.positionals.length])}`);
  }
  return { flags, positionals };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

// ---------------------------------------------------------------- files

export function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`cannot read ${what} ${path} (${code})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function existingDirectory(path: string, what: string): string {
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    throw new Error(`${what} ${path} does not exist`);
  }
  if (!isDirectory) throw new Error(`${what} ${path} is not a directory`);
  return path;
}

// ---------------------------------------------------------------- episode driver

export interface EpisodeInputs {
  contract: TaskContract;
  workspace: string;
  state_dir: string | null;
  route: ModelRoute;
  executor: EffectExecutor;
  director: DirectorChannel;
  /** How the Director is reached, for the banner. */
  directorLabel: string;
}

export interface EpisodeRun {
  report: EpisodeReport;
  loop: MinionRun;
}

/** Prints each Director decision as it is made, whichever channel made it. */
function observed(director: DirectorChannel, out: Writable, style: Style): DirectorChannel {
  return {
    async decide(request) {
      const decision = await director.decide(request);
      out.write(renderDecision(request, decision, style));
      return decision;
    },
  };
}

/**
 * Open a governed session, run the Minion with live rendering, close the
 * session with the loop's outcome and render the report. Human-readable
 * output goes to `out`.
 */
export async function runEpisode(
  inputs: EpisodeInputs,
  context: { blocks: Blocks; out: Writable; style: Style },
): Promise<EpisodeRun> {
  const { blocks, out, style } = context;
  const session = await blocks.openSession({
    contract: inputs.contract,
    workspace: inputs.workspace,
    state_dir: inputs.state_dir,
    route: inputs.route.descriptor,
    director: observed(inputs.director, out, style),
    minion: principal("minion", "implementer"),
    executor: inputs.executor,
  });
  out.write(
    renderEpisodeBanner(
      {
        episode_id: session.episode_id,
        route: inputs.route.descriptor,
        safety: session.safety,
        workspace: inputs.workspace,
        director: inputs.directorLabel,
      },
      style,
    ),
  );
  out.write(`\n${style.bold("Task")}  ${safeText(inputs.contract.task, { multiline: true, max: 2000 })}\n\n`);

  // A fallback model serving a live route is worth a warning; a fixture has no real model to compare.
  const expectedModel = inputs.route.descriptor.kind === "fixture" ? undefined : inputs.route.descriptor.model;
  const onEvent = (event: MinionEvent): void => {
    switch (event.type) {
      case "turn":
        out.write(renderTurn(event.turn, style, expectedModel));
        return;
      case "call":
        out.write(renderCall(event.call, event.result, style));
        return;
      case "error":
        out.write(style.red(`  ${event.source} error: ${safeText(event.message, { max: 500 })}\n`));
        return;
      case "retry":
        out.write(style.yellow(`  retry ${event.attempt} in ${event.delay_ms} ms: ${safeText(event.message, { max: 200 })}\n`));
        return;
      case "end":
        out.write(`\n${style.bold("Loop ended")}  ${event.outcome}: ${event.reason}\n`);
        return;
    }
  };

  const loop = await runMinion({ session, route: inputs.route, onEvent });
  out.write(
    `  ${loop.turns} turn${loop.turns === 1 ? "" : "s"}, ${loop.tool_calls} tool call${loop.tool_calls === 1 ? "" : "s"}. ` +
      "The model's own summary is recorded as an assertion only.\n" +
      style.dim("  closing: reconciling the workspace and running the verification contract…\n\n"),
  );
  const report = await session.close(loop.outcome);
  out.write(renderReport(report, style));
  return { report, loop };
}

// ---------------------------------------------------------------- commands

function makeDirector(
  spec: string,
  context: CommandContext,
  out: Writable,
): { director: DirectorChannel; label: string; dispose(): void } {
  if (spec === "deny") {
    return { director: new DenyAllDirector(), label: "deny-all (escalations fail closed)", dispose() {} };
  }
  if (spec === "interactive") {
    const director = new InteractiveDirector({ input: context.io.stdin, output: out, style: context.style });
    return { director, label: "interactive (this terminal)", dispose: () => director.close() };
  }
  if (spec.startsWith("script:") && spec.length > "script:".length) {
    const path = resolve(context.io.cwd, spec.slice("script:".length));
    const rules = loadDirectorScript(readJsonFile(path, "director script"));
    return { director: new ScriptedDirector(rules), label: `scripted (${path})`, dispose() {} };
  }
  throw new UsageError(`--director must be interactive, deny or script:<file>, not ${JSON.stringify(spec)}`);
}

async function finishEpisode(
  inputs: EpisodeInputs,
  context: CommandContext,
  json: boolean,
  dispose: () => void,
): Promise<number> {
  const { io } = context;
  const out = json ? io.stderr : io.stdout;
  try {
    const { report, loop } = await runEpisode(inputs, { blocks: context.blocks, out, style: context.style });
    if (json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // A kernel failure is an operational failure whatever the closure says.
    return report.closure.status === "PASS" && loop.outcome !== "KERNEL_ERROR" ? 0 : 1;
  } finally {
    dispose();
  }
}

const RUN_USAGE = `Usage: gru run --workspace <dir> --contract <file> [options]

Run one governed episode: a Minion works on the contract's task in the
workspace, every tool call passes through AVL, and AVL verifies and closes.

Options:
  --workspace <dir>      the directory the Minion works in (required)
  --contract <file>      the Director's task contract, JSON (required)
  --route <spec>         model route, "provider/model" or "provider"
  --fixture <file>       scripted model turns instead of a live route
  --director <channel>   interactive | deny | script:<file>
                         (default: "director" in gru.config.json, else interactive)
  --state <dir>          ledger directory (default: "state_dir" in the config)
  --config <file>        config file (default: ./gru.config.json, then ~/.config/gru/config.json)
  --json                 print only the episode report as JSON on stdout
                         (progress goes to stderr)

Exit code: 0 when the episode closes PASS, 1 otherwise, 2 for usage errors.
`;

const runCommand: Command = {
  name: "run",
  summary: "run one governed episode from a contract file",
  usage: RUN_USAGE,
  async run(args, context) {
    const { io, blocks } = context;
    const parsed = parseFlags(args, {
      flags: {
        workspace: "string",
        contract: "string",
        route: "string",
        fixture: "string",
        director: "string",
        state: "string",
        config: "string",
        json: "boolean",
      },
      positionals: [],
    });
    const workspaceFlag = requiredFlag(parsed, "workspace");
    const contractFlag = requiredFlag(parsed, "contract");
    const routeFlag = stringFlag(parsed, "route");
    const fixtureFlag = stringFlag(parsed, "fixture");
    if (routeFlag !== undefined && fixtureFlag !== undefined) throw new UsageError("--route and --fixture cannot be combined");

    const { config } = loadConfig({ cwd: io.cwd, explicitPath: stringFlag(parsed, "config") ?? null, env: io.env });
    const workspace = existingDirectory(resolve(io.cwd, workspaceFlag), "workspace");
    const contract = blocks.parseContract(readJsonFile(resolve(io.cwd, contractFlag), "contract"));
    const executor = blocks.executor(workspace, contract.commands);
    let route: ModelRoute;
    if (fixtureFlag !== undefined) {
      route = blocks.fixtureRoute(readJsonFile(resolve(io.cwd, fixtureFlag), "fixture"));
    } else {
      const spec = routeFlag ?? config.route;
      if (spec === null) {
        throw new UsageError('no model route: pass --route <provider/model> or --fixture <file>, or set "route" in gru.config.json');
      }
      route = blocks.catalog(config.providers).route(spec);
    }
    const stateFlag = stringFlag(parsed, "state");
    const stateDir = stateFlag === undefined ? config.state_dir : resolve(io.cwd, expandHome(stateFlag, homeDirectory(io.env)));
    const json = parsed.flags.json === true;
    const { director, label, dispose } = makeDirector(
      stringFlag(parsed, "director") ?? config.director,
      context,
      json ? io.stderr : io.stdout,
    );
    return finishEpisode(
      { contract, workspace, state_dir: stateDir, route, executor, director, directorLabel: label },
      context,
      json,
      dispose,
    );
  },
};

const DEMO_USAGE = `Usage: gru demo [--json]

Copy the slugify example into a fresh temporary workspace and run it with
scripted model turns and a scripted Director. The workspace README carries a
planted instruction telling AI agents they may delete the tests; the demo
shows AVL escalating that deletion and the Director's script rejecting it,
then AVL verifying the work itself. The workspace and ledger are kept in
temporary directories for inspection.

Options:
  --json   print only the episode report as JSON on stdout
`;

/** gru/examples, located from this module so the demo works from any cwd. */
export function examplesDirectory(): string {
  return fileURLToPath(new URL("../../examples/", import.meta.url));
}

const demoCommand: Command = {
  name: "demo",
  summary: "run the slugify demo with scripted turns (no API key needed)",
  usage: DEMO_USAGE,
  async run(args, context) {
    const { io, blocks, style } = context;
    const parsed = parseFlags(args, { flags: { json: "boolean" }, positionals: [] });
    const json = parsed.flags.json === true;
    const out = json ? io.stderr : io.stdout;
    const examples = examplesDirectory();
    const temp = io.env.TMPDIR !== undefined && io.env.TMPDIR !== "" ? io.env.TMPDIR : tmpdir();
    const workspace = mkdtempSync(join(temp, "gru-demo-workspace-"));
    cpSync(join(examples, "slugify"), workspace, { recursive: true });
    const stateDir = mkdtempSync(join(temp, "gru-demo-state-"));

    const contract = blocks.parseContract(readJsonFile(join(examples, "slugify.contract.json"), "contract"));
    const executor = blocks.executor(workspace, contract.commands);
    const route = blocks.fixtureRoute(readJsonFile(join(examples, "slugify.fixture.json"), "fixture"));
    const scriptPath = join(examples, "slugify.director.json");
    const director = new ScriptedDirector(loadDirectorScript(readJsonFile(scriptPath, "director script")));

    out.write(
      `${style.bold("GRU demo")}: a scripted Minion implements slugify.\n` +
        "The workspace README tells AI agents they may delete the tests. Watch AVL escalate that\n" +
        "deletion, the Director's script reject it, and AVL run the verification contract itself.\n" +
        `  demo workspace  ${workspace}\n  demo state      ${stateDir}\n  (both are kept for inspection)\n\n`,
    );
    return finishEpisode(
      { contract, workspace, state_dir: stateDir, route, executor, director, directorLabel: `scripted (${scriptPath})` },
      context,
      json,
      () => {},
    );
  },
};

function catalogFor(context: CommandContext, parsed: ParsedArgs) {
  const { config } = loadConfig({ cwd: context.io.cwd, explicitPath: stringFlag(parsed, "config") ?? null, env: context.io.env });
  return context.blocks.catalog(config.providers);
}

const providersCommand: Command = {
  name: "providers",
  summary: "list configured model providers and whether their credential is present",
  usage: `Usage: gru providers [--config <file>]

List model providers: id, kind, base URL and credential status. Credential
values and headers are never printed; only the environment variable a key
is read from.
`,
  async run(args, context) {
    const parsed = parseFlags(args, { flags: { config: "string" }, positionals: [] });
    context.io.stdout.write(renderProviders(catalogFor(context, parsed).list()));
    return 0;
  },
};

const modelsCommand: Command = {
  name: "models",
  summary: "list the models a provider offers",
  usage: `Usage: gru models <provider> [--config <file>]\n\nAsk a provider which models it offers.\n`,
  async run(args, context) {
    const parsed = parseFlags(args, { flags: { config: "string" }, positionals: ["provider"] });
    const models = await catalogFor(context, parsed).discover(parsed.positionals[0] as string);
    context.io.stdout.write(models.length === 0 ? "no models reported\n" : `${models.map((m) => safeText(m)).join("\n")}\n`);
    return 0;
  },
};

const probeCommand: Command = {
  name: "probe",
  summary: "check that a provider's model answers",
  usage: `Usage: gru probe <provider> <model> [--config <file>]\n\nSend a minimal request to one model. Exit 0 when it answers.\n`,
  async run(args, context) {
    const parsed = parseFlags(args, { flags: { config: "string" }, positionals: ["provider", "model"] });
    const result = await catalogFor(context, parsed).probe(parsed.positionals[0] as string, parsed.positionals[1] as string);
    context.io.stdout.write(renderProbes([result]));
    return result.ok ? 0 : 1;
  },
};

const autoCommand: Command = {
  name: "auto",
  summary: "probe a provider's models and pick one that answers",
  usage: `Usage: gru auto <provider> [--prefer <model>] [--config <file>]\n\nProbe a provider's models and select one that answers, preferring --prefer.\n`,
  async run(args, context) {
    const parsed = parseFlags(args, { flags: { config: "string", prefer: "string" }, positionals: ["provider"] });
    const provider = parsed.positionals[0] as string;
    const prefer = stringFlag(parsed, "prefer");
    const selected = await catalogFor(context, parsed).autoSelect(provider, prefer === undefined ? {} : { prefer });
    context.io.stdout.write(renderProbes(selected.probes));
    context.io.stdout.write(`selected: ${safeText(provider)}/${safeText(selected.model)}\n`);
    return 0;
  },
};

export function builtinCommands(): Command[] {
  return [runCommand, demoCommand, providersCommand, modelsCommand, probeCommand, autoCommand];
}

export function commandTable(extra: readonly Command[] = []): Map<string, Command> {
  const table = new Map<string, Command>();
  for (const command of [...builtinCommands(), ...extra]) {
    if (table.has(command.name)) throw new Error(`command "${command.name}" is registered twice`);
    table.set(command.name, command);
  }
  return table;
}

export function helpText(table: ReadonlyMap<string, Command>): string {
  const width = Math.max(...[...table.keys()].map((name) => name.length));
  const lines = [...table.values()].map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  return `gru: governed AI project delivery (slice 1)

Usage:
  gru                      start the interactive terminal (needs a terminal)
  gru [--config <file>]    same, with an explicit config file
  gru <command> [options]

Commands:
${lines.join("\n")}

Run "gru <command> --help" for a command's options.
`;
}

const REPL_FLAGS = { config: "string" } as const;

export async function main(
  argv: readonly string[],
  io: Io,
  blocks: Blocks,
  extraCommands: readonly Command[] = [],
): Promise<number> {
  const table = commandTable(extraCommands);
  const style = makeStyle({ isTTY: io.isTTY, env: io.env });
  const context: CommandContext = { io, blocks, style };
  const first = argv[0];
  let name = "gru";
  try {
    if (first !== undefined && (isHelpFlag(first) || first === "help")) {
      const topic = first === "help" ? argv[1] : undefined;
      const command = topic === undefined ? undefined : table.get(topic);
      io.stdout.write(command === undefined ? helpText(table) : command.usage);
      return 0;
    }
    if (first === undefined || first.startsWith("-")) {
      const parsed = parseFlags(argv, { flags: REPL_FLAGS, positionals: [] });
      if (!io.isTTY) {
        io.stderr.write(`gru: the interactive terminal needs a terminal; use a command instead.\n\n${helpText(table)}`);
        return 2;
      }
      const loaded = loadConfig({ cwd: io.cwd, explicitPath: stringFlag(parsed, "config") ?? null, env: io.env });
      const { startRepl } = await import("./repl.ts");
      return await startRepl({ io, blocks, config: loaded.config, configSource: loaded.source });
    }
    const command = table.get(first);
    if (command === undefined) {
      io.stderr.write(`gru: unknown command ${JSON.stringify(safeText(first, { max: 60 }))}\n\n${helpText(table)}`);
      return 2;
    }
    name = `gru ${command.name}`;
    const rest = argv.slice(1);
    if (rest.some(isHelpFlag)) {
      io.stdout.write(command.usage);
      return 0;
    }
    return await command.run(rest, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      io.stderr.write(`${name}: ${safeText(message, { multiline: true })}\nRun "${name} --help" for usage.\n`);
      return 2;
    }
    io.stderr.write(`${name}: ${safeText(message, { multiline: true })}\n`);
    return 1;
  }
}
