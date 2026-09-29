// Commands that put GRU inside Claude Code and Codex (CDR-005):
//   gru mcp      the long-lived MCP server, which also owns the hook daemon
//   gru hook     the per-event hook client the host runs
//   gru install  prints (or, for Claude Code, merges) the host configuration
//
// install never overwrites: it merges and reports conflicts, and with any
// conflict it writes nothing (Escapement v1's update rule).
//
// Limit: host mode is AVL deciding while the host executes. What each host
// actually gets is stated in CDR-005; under Codex only gru_* tools are
// mediated.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { principal } from "../avl/principal.ts";
import { runHookClient } from "../hooks/client.ts";
import { socketPathFor } from "../hooks/daemon.ts";
import { isHost } from "../hooks/host-map.ts";
import { claudeCodeConfig, codexConfig, mergeHooks, mergeMcpServers } from "../install/hosts.ts";
import { startMcpServer } from "../mcp/server.ts";
import { parseFlags, readJsonFile, UsageError, type Command } from "./main.ts";

const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

function required(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") throw new UsageError(`--${name} is required`);
  return value;
}

const mcpCommand: Command = {
  name: "mcp",
  summary: "run GRU as an MCP server (and hook daemon) for Claude Code or Codex",
  usage: `Usage: gru mcp --contract <file> --workspace <dir> --state <dir>

Speaks MCP on stdin/stdout. Every gru_* tool call goes through AVL; host
hooks reach the same episode through a socket in the state directory.
Normally started by the host from the configuration \`gru install\` writes.
`,
  async run(args, { io, blocks }) {
    const { flags } = parseFlags(args, { flags: { contract: "string", workspace: "string", state: "string" }, positionals: [] });
    const workspace = resolve(io.cwd, required(flags, "workspace"));
    const state = resolve(io.cwd, required(flags, "state"));
    const contract = blocks.parseContract(readJsonFile(resolve(io.cwd, required(flags, "contract")), "contract"));
    const executor = blocks.executor(workspace, contract.commands);
    const server = startMcpServer({
      openSession: ({ director }) =>
        blocks.openSession({
          contract,
          workspace,
          state_dir: state,
          route: null,
          director,
          minion: principal("minion", "host-agent"),
          executor,
        }),
      commandIds: contract.commands.map((command) => command.id),
      input: io.stdin,
      output: io.stdout,
      socketPath: socketPathFor(state),
      hostContext: {
        workspaceRoot: workspace,
        declaredCommands: contract.commands.map((command) => ({ id: command.id, argv: command.argv })),
      },
      log: (line) => io.stderr.write(`${line}\n`),
    });
    await server.ready;
    await server.closed;
    return 0;
  },
};

const hookCommand: Command = {
  name: "hook",
  summary: "forward one host hook event to the running GRU daemon",
  usage: `Usage: gru hook <claude-code|codex> <event> --state <dir>

Reads the hook payload on stdin and prints the host's answer. If GRU is
not reachable a PreToolUse answer is "ask", with a warning that the
action is not governed -- never a silent allow. Always exits 0.
`,
  async run(args, { io }) {
    const { flags, positionals } = parseFlags(args, { flags: { state: "string" }, positionals: ["host", "event"] });
    const [host, event] = positionals as [string, string];
    if (!isHost(host)) throw new UsageError(`unknown host ${JSON.stringify(host)}; expected claude-code or codex`);
    return runHookClient({
      host,
      event,
      socketPath: socketPathFor(resolve(io.cwd, required(flags, "state"))),
      stdin: io.stdin,
      stdout: io.stdout,
      log: (line) => io.stderr.write(`${line}\n`),
    });
  },
};

function readJsonOrUndefined(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

const installCommand: Command = {
  name: "install",
  summary: "print or merge the configuration that runs GRU inside Claude Code or Codex",
  usage: `Usage: gru install <claude-code|codex> --contract <file> --workspace <dir> --state <dir> [--write]

Without --write, prints what to add. With --write (Claude Code only),
merges into <workspace>/.mcp.json and <workspace>/.claude/settings.json
without removing anything; any conflict means nothing is written.
The state directory must be outside the workspace.
`,
  async run(args, { io }) {
    const { flags, positionals } = parseFlags(args, {
      flags: { contract: "string", workspace: "string", state: "string", write: "boolean" },
      positionals: ["host"],
    });
    const host = positionals[0]!;
    const paths = {
      cliPath: CLI_PATH,
      contractPath: resolve(io.cwd, required(flags, "contract")),
      workspace: resolve(io.cwd, required(flags, "workspace")),
      stateDir: resolve(io.cwd, required(flags, "state")),
    };
    if (host === "codex") {
      if (flags.write === true) throw new UsageError("--write is not supported for codex; add the printed snippets yourself");
      const config = codexConfig(paths);
      io.stdout.write(`# Append to ~/.codex/config.toml\n${config.configTomlSnippet}\n`);
      io.stdout.write(`# Merge into .codex/hooks.json\n${JSON.stringify(config.hooks, null, 2)}\n`);
      io.stdout.write("# Under Codex only gru_* tools are mediated; its built-in shell is not (CDR-005).\n");
      return 0;
    }
    if (host !== "claude-code") throw new UsageError(`unknown host ${JSON.stringify(host)}; expected claude-code or codex`);
    const config = claudeCodeConfig(paths);
    if (flags.write !== true) {
      io.stdout.write(`# .mcp.json\n${JSON.stringify(config.mcp, null, 2)}\n`);
      io.stdout.write(`# .claude/settings.json\n${JSON.stringify(config.settings, null, 2)}\n`);
      return 0;
    }
    const mcpPath = join(paths.workspace, ".mcp.json");
    const settingsPath = join(paths.workspace, ".claude", "settings.json");
    const mcp = mergeMcpServers(readJsonOrUndefined(mcpPath), config.mcp);
    const settings = mergeHooks(readJsonOrUndefined(settingsPath), config.settings);
    const conflicts = [...mcp.conflicts.map((c) => `${mcpPath}: ${c}`), ...settings.conflicts.map((c) => `${settingsPath}: ${c}`)];
    if (conflicts.length > 0) {
      for (const conflict of conflicts) io.stderr.write(`conflict: ${conflict}\n`);
      io.stderr.write("nothing was written\n");
      return 1;
    }
    writeFileSync(mcpPath, `${JSON.stringify(mcp.merged, null, 2)}\n`);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings.merged, null, 2)}\n`);
    io.stdout.write(`merged ${mcpPath}\nmerged ${settingsPath}\n`);
    return 0;
  },
};

export function hostCommands(): Command[] {
  return [mcpCommand, hookCommand, installCommand];
}
