// Host mode end to end, the way Claude Code drives it: the host starts
// `gru mcp` once, calls gru_* tools over MCP, and runs `gru hook` per event.
// Real processes, real socket, real ledger; `gru verify` checks the result.
//
// The hook payloads are shaped like Claude Code's but written by us; no live
// host is involved (CDR-005 records that limit).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const GRU = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/slugify", import.meta.url));
const CONTRACT = fileURLToPath(new URL("../examples/slugify.contract.json", import.meta.url));
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

class McpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  readonly #waiting = new Map<number, (message: any) => void>();

  constructor(args: string[]) {
    this.#child = spawn(process.execPath, [GRU, "mcp", ...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (let newline = this.#buffer.indexOf("\n"); newline !== -1; newline = this.#buffer.indexOf("\n")) {
        const message = JSON.parse(this.#buffer.slice(0, newline));
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#waiting.get(message.id)?.(message);
      }
    });
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  end(): Promise<number | null> {
    return new Promise((resolve) => {
      this.#child.on("exit", resolve);
      this.#child.stdin.end();
    });
  }
}

function hook(state: string, event: string, payload: unknown): any {
  const result = spawnSync(process.execPath, [GRU, "hook", "claude-code", event, "--state", state], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Claude Code host mode: MCP tools and hooks share one governed episode", async () => {
  const workspace = temp("gru-host-ws-");
  cpSync(EXAMPLE, workspace, { recursive: true });
  const state = temp("gru-host-state-");
  const client = new McpClient(["--contract", CONTRACT, "--workspace", workspace, "--state", state]);

  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "gru");
  client.notify("notifications/initialized");
  const listed = await client.request("tools/list");
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "gru_write_file"));

  const read = await client.request("tools/call", { name: "gru_read_file", arguments: { path: "README.md" } });
  assert.equal(read.result.isError, false);

  // No elicitation capability was declared, so an escalation fails closed.
  const protectedWrite = await client.request("tools/call", {
    name: "gru_write_file",
    arguments: { path: "test/slugify.test.js", content: "// gutted\n" },
  });
  assert.equal(protectedWrite.result.isError, true);
  assert.match(protectedWrite.result.content[0].text, /REJECTED/);

  const pre = (tool_name: string, tool_input: unknown, tool_use_id: string) =>
    hook(state, "PreToolUse", { session_id: "s", cwd: workspace, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id });
  const decision = (output: any) => output.hookSpecificOutput.permissionDecision;

  assert.equal(decision(pre("Read", { file_path: join(workspace, "src/slugify.js") }, "t1")), "allow");
  assert.equal(decision(pre("Bash", { command: "rm -rf test" }, "t2")), "ask");
  assert.equal(decision(pre("Write", { file_path: join(workspace, "test/x.test.js"), content: "x" }, "t3")), "ask");
  assert.equal(decision(pre("Read", { file_path: "/etc/passwd" }, "t4")), "ask");

  // The host performed the Read it was allowed; it reports back.
  hook(state, "PostToolUse", {
    session_id: "s", cwd: workspace, hook_event_name: "PostToolUse",
    tool_name: "Read", tool_input: { file_path: join(workspace, "src/slugify.js") }, tool_use_id: "t1",
    tool_response: { content: "export function slugify() {}" },
  });

  // The Minion (the host) never implemented slugify, so verification must fail.
  const closed = await client.request("tools/call", { name: "gru_verify_and_close", arguments: {} });
  const report = JSON.parse(closed.result.content[0].text);
  assert.equal(closed.result.isError, true);
  assert.equal(report.closure.status, "FAIL");
  assert.equal(report.admissibility.verdict, "ADMISSIBLE_NEGATIVE");
  await client.end();

  const verified = spawnSync(process.execPath, [GRU, "verify", "--state", state, "--json"], { encoding: "utf8", shell: false });
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  const [result] = JSON.parse(verified.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.closure, "FAIL");

  // The Director accepts the risk; the closure stays FAIL.
  const override = spawnSync(
    process.execPath,
    [GRU, "override", "--state", state, "--episode", result.episode_id, "--actor", "director:test", "--reason", "known gap, shipping behind a flag"],
    { encoding: "utf8", shell: false },
  );
  assert.equal(override.status, 0, override.stderr);
  assert.match(override.stdout, /Verification FAIL \/ Director PROCEED/);
  const again = JSON.parse(spawnSync(process.execPath, [GRU, "verify", "--state", state, "--json"], { encoding: "utf8", shell: false }).stdout);
  assert.equal(again[0].ok, true);
  assert.equal(again[0].closure, "FAIL");
});

test("an unreachable daemon makes PreToolUse ask with a warning, never allow", () => {
  const state = temp("gru-host-none-");
  writeFileSync(join(state, "placeholder"), "");
  const output = hook(state, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "x" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "ask");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /NOT governed/);
});
