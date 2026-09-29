import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runHookClient } from "../src/hooks/client.ts";
import {
  MAX_RECORDED_OUTPUT_BYTES,
  socketPathFor,
  SocketPathError,
  startHookDaemon,
  truncateOutput,
  type HookDaemon,
} from "../src/hooks/daemon.ts";
import type { Host, HostMapContext } from "../src/hooks/host-map.ts";
import { UNGOVERNED_WARNING } from "../src/hooks/respond.ts";
import { startMcpServer } from "../src/mcp/server.ts";
import { FakeSession, Lines, tick, type FakeScript, type Message } from "./surfaces-fake-session.ts";

const ctx: HostMapContext = { workspaceRoot: "/ws", declaredCommands: [{ id: "test", argv: ["npm", "test"] }] };

async function tempDir(): Promise<string> {
  // Unix socket paths are short (about 100 bytes); fall back to /tmp if TMPDIR is deep.
  const base = tmpdir().length > 60 ? "/tmp" : tmpdir();
  return mkdtemp(join(base, "gru-s-"));
}

interface Fixture {
  dir: string;
  socketPath: string;
  session: FakeSession;
  daemon: HookDaemon;
  getSessionCalls: () => number;
  logs: string[];
  cleanup: () => Promise<void>;
}

async function fixture(script: FakeScript = {}): Promise<Fixture> {
  const dir = await tempDir();
  const socketPath = socketPathFor(dir);
  const session = new FakeSession(script);
  const logs: string[] = [];
  let calls = 0;
  const daemon = await startHookDaemon({
    socketPath,
    getSession: async () => {
      calls++;
      return session;
    },
    ctx,
    log: (line) => logs.push(line),
  });
  return {
    dir,
    socketPath,
    session,
    daemon,
    logs,
    getSessionCalls: () => calls,
    cleanup: async () => {
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

interface ClientRun {
  code: number;
  output: Message;
  logs: string[];
}

async function client(
  socketPath: string,
  event: string,
  payload: unknown,
  options: { host?: Host; timeout_ms?: number; connect_wait_ms?: number } = {},
): Promise<ClientRun> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = new Lines(stdout);
  const logs: string[] = [];
  stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  const code = await runHookClient({
    host: options.host ?? "claude-code",
    event,
    socketPath,
    stdin,
    stdout,
    timeout_ms: options.timeout_ms ?? 3000,
    connect_wait_ms: options.connect_wait_ms ?? 0,
    log: (line) => logs.push(line),
  });
  const output = await lines.next();
  await tick(5);
  assert.equal(lines.all.length, 1, "exactly one line on stdout");
  return { code, output, logs };
}

const pre = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: "s-1",
  cwd: "/ws",
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
  ...extra,
});

const post = (tool_name: string, tool_input: unknown, tool_response: unknown, extra: Record<string, unknown> = {}) => ({
  ...pre(tool_name, tool_input, extra),
  hook_event_name: "PostToolUse",
  tool_response,
});

const permission = (run: ClientRun): string => run.output.hookSpecificOutput.permissionDecision;

test("hooks: PreToolUse answers allow / ask / deny from AVL's verdict", async () => {
  const f = await fixture({ verdicts: { Read: "ALLOW", Bash: "ASK", WebFetch: "DENY" } });
  try {
    const read = await client(f.socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a.ts" }));
    assert.equal(read.code, 0);
    assert.equal(permission(read), "allow");
    const bash = await client(f.socketPath, "PreToolUse", pre("Bash", { command: "rm -rf build" }));
    assert.equal(permission(bash), "ask");
    const fetch = await client(f.socketPath, "PreToolUse", pre("WebFetch", { url: "https://x.test" }));
    assert.equal(permission(fetch), "deny");
    assert.deepEqual(
      f.session.callsTo("decideHost").map((call) => call.args),
      [
        ["Read", { kind: "fs.read", path: "a.ts" }],
        ["Bash", { kind: "host.exec", tool: "Bash", command: "rm -rf build" }],
        ["WebFetch", { kind: "host.fetch", tool: "WebFetch", url: "https://x.test" }],
      ],
    );
  } finally {
    await f.cleanup();
  }
});

test("hooks: the payload cwd reaches the mapping (declared command run elsewhere is host.exec)", async () => {
  const f = await fixture();
  try {
    await client(f.socketPath, "PreToolUse", pre("Bash", { command: "npm test" }));
    await client(f.socketPath, "PreToolUse", pre("Bash", { command: "npm test" }, { cwd: "/elsewhere" }));
    assert.deepEqual(
      f.session.callsTo("decideHost").map((call) => (call.args[1] as { kind: string }).kind),
      ["process.run", "host.exec"],
    );
  } finally {
    await f.cleanup();
  }
});

test("hooks: Pre/Post correlate by tool_use_id, in any order", async () => {
  const f = await fixture();
  try {
    const input = { file_path: "/ws/a.ts" };
    await client(f.socketPath, "PreToolUse", pre("Read", input, { tool_use_id: "tu-1" }));
    await client(f.socketPath, "PreToolUse", pre("Read", input, { tool_use_id: "tu-2" }));
    const second = await client(f.socketPath, "PostToolUse", post("Read", input, { content: "b" }, { tool_use_id: "tu-2" }));
    const first = await client(f.socketPath, "PostToolUse", post("Read", input, { content: "a" }, { tool_use_id: "tu-1" }));
    assert.deepEqual(second.output, {});
    assert.deepEqual(first.output, {});
    assert.deepEqual(f.session.callsTo("recordHostEffect").map((call) => call.args), [
      ["auth-2", { ok: true, summary: { tool: "Read" }, output: '{"content":"b"}' }],
      ["auth-1", { ok: true, summary: { tool: "Read" }, output: '{"content":"a"}' }],
    ]);
  } finally {
    await f.cleanup();
  }
});

test("hooks: without tool_use_id, Pre/Post correlate by tool and input digest, first in first out", async () => {
  const f = await fixture();
  try {
    const same = { command: "npm test" };
    await client(f.socketPath, "PreToolUse", pre("Bash", same));
    await client(f.socketPath, "PreToolUse", pre("Bash", { command: "ls" }));
    await client(f.socketPath, "PreToolUse", pre("Bash", same));
    await client(f.socketPath, "PostToolUse", post("Bash", same, { stdout: "1" }));
    await client(f.socketPath, "PostToolUse", post("Bash", same, { stdout: "2" }));
    await client(f.socketPath, "PostToolUse", post("Bash", { command: "ls" }, { stdout: "3" }));
    assert.deepEqual(
      f.session.callsTo("recordHostEffect").map((call) => call.args[0]),
      ["auth-1", "auth-3", "auth-2"],
    );
  } finally {
    await f.cleanup();
  }
});

test("hooks: a PostToolUse with no matching decision records nothing and is logged", async () => {
  const f = await fixture();
  try {
    const run = await client(f.socketPath, "PostToolUse", post("Read", { file_path: "/ws/a" }, {}, { tool_use_id: "never" }));
    assert.deepEqual(run.output, {});
    assert.equal(f.session.callsTo("recordHostEffect").length, 0);
    assert.ok(f.logs.some((line) => line.includes("matches no PreToolUse decision")));
  } finally {
    await f.cleanup();
  }
});

test("hooks: a host-reported error records ok false, and output is capped at 64 KB", async () => {
  const f = await fixture();
  try {
    await client(f.socketPath, "PreToolUse", pre("Bash", { command: "ls" }, { tool_use_id: "a" }));
    await client(f.socketPath, "PostToolUse", post("Bash", { command: "ls" }, { is_error: true, error: "exit 1" }, { tool_use_id: "a" }));
    await client(f.socketPath, "PreToolUse", pre("Read", { file_path: "/ws/big" }, { tool_use_id: "b" }));
    await client(f.socketPath, "PostToolUse", post("Read", { file_path: "/ws/big" }, { content: "x".repeat(100_000) }, { tool_use_id: "b" }));
    const [failed, big] = f.session.callsTo("recordHostEffect").map((call) => call.args[1] as Message);
    assert.equal(failed.ok, false);
    assert.equal(big.ok, true);
    assert.ok(Buffer.byteLength(big.output) <= MAX_RECORDED_OUTPUT_BYTES);
    assert.match(big.output, /truncated 100014 bytes/);
  } finally {
    await f.cleanup();
  }
});

test("hooks: truncation stays within the cap even when it cuts a multi-byte character", () => {
  const text = truncateOutput("é".repeat(100), 51);
  assert.ok(text !== null && Buffer.byteLength(text) <= 51);
  assert.equal(truncateOutput(undefined), null);
});

test("hooks: GRU's own MCP tools pass through as allow without opening the session", async () => {
  const f = await fixture();
  try {
    const run = await client(f.socketPath, "PreToolUse", pre("mcp__gru__gru_read_file", { path: "a" }));
    assert.equal(permission(run), "allow");
    assert.match(run.output.hookSpecificOutput.permissionDecisionReason, /^not an effect GRU governs: /);
    assert.equal(f.getSessionCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test("hooks: SessionStart returns the banner; Stop returns {}", async () => {
  const f = await fixture();
  try {
    const start = await client(f.socketPath, "SessionStart", { session_id: "s-1", source: "startup" });
    assert.equal(start.output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(start.output.hookSpecificOutput.additionalContext, /ep-fake[\s\S]*UNSAFE_DEVELOPMENT[\s\S]*gru_verify_and_close/);
    const stop = await client(f.socketPath, "Stop", { session_id: "s-1", stop_hook_active: false });
    assert.deepEqual(stop.output, {});
    assert.equal(f.session.callsTo("close").length, 0, "Stop does not close the episode");
  } finally {
    await f.cleanup();
  }
});

test("hooks: a kernel error on PreToolUse -> ask, stating the action is ungoverned", async () => {
  const f = await fixture({ decideHostError: "ledger write failed" });
  try {
    const run = await client(f.socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(permission(run), "ask");
    assert.match(run.output.hookSpecificOutput.permissionDecisionReason, /ledger write failed.*NOT governed or recorded/);
  } finally {
    await f.cleanup();
  }
});

test("hooks: Codex has no pre-tool event; the daemon refuses it and the client prints {}", async () => {
  const f = await fixture();
  try {
    const run = await client(f.socketPath, "PreToolUse", pre("shell", { command: ["ls"] }), { host: "codex" });
    assert.deepEqual(run.output, {});
    assert.equal(f.session.callsTo("decideHost").length, 0);
    const start = await client(f.socketPath, "SessionStart", { session_id: "c-1" }, { host: "codex" });
    assert.equal(start.output.hookSpecificOutput.hookEventName, "SessionStart");
  } finally {
    await f.cleanup();
  }
});

function rawExchange(socketPath: string, line: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => resolve(JSON.parse(buffer)));
    socket.on("error", reject);
    socket.write(line);
  });
}

test("hooks: a malformed request gets an error line and the daemon keeps serving", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await rawExchange(f.socketPath, "garbage\n"), { ok: false, error: "request is not valid JSON" });
    const shape = await rawExchange(f.socketPath, `${JSON.stringify({ host: "vim", event: "PreToolUse", payload: {} })}\n`);
    assert.equal(shape.ok, false);
    const good = await rawExchange(f.socketPath, `${JSON.stringify({ host: "claude-code", event: "Stop", payload: {} })}\n`);
    assert.deepEqual(good, { ok: true, output: {} });
  } finally {
    await f.cleanup();
  }
});

test("hooks: an unreachable daemon -> ask with the ungoverned warning, exit 0", async () => {
  const dir = await tempDir();
  try {
    const run = await client(socketPathFor(dir), "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(run.code, 0);
    assert.deepEqual(run.output, {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: UNGOVERNED_WARNING },
    });
    const start = await client(socketPathFor(dir), "SessionStart", {});
    assert.equal(start.code, 0);
    assert.deepEqual(start.output, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hooks: malformed stdin is answered without contacting the daemon, exit 0", async () => {
  const f = await fixture();
  try {
    for (const raw of ["{not json", "[1,2]", ""]) {
      const run = await client(f.socketPath, "PreToolUse", raw);
      assert.equal(run.code, 0);
      assert.equal(permission(run), "ask");
      assert.equal(run.output.hookSpecificOutput.permissionDecisionReason, UNGOVERNED_WARNING);
      const other = await client(f.socketPath, "PostToolUse", raw);
      assert.deepEqual(other.output, {});
    }
    assert.equal(f.getSessionCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test("hooks: the socket file is mode 0600 and is removed on close", async () => {
  const f = await fixture();
  const mode = (await stat(f.socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  await f.daemon.close();
  await assert.rejects(lstat(f.socketPath), { code: "ENOENT" });
  await rm(f.dir, { recursive: true, force: true });
});

test("hooks: the client refuses a symlinked or loosened socket (treated as unreachable)", async () => {
  const f = await fixture();
  try {
    const link = join(f.dir, "link.sock");
    await symlink(f.socketPath, link);
    const viaLink = await client(link, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(viaLink.output.hookSpecificOutput.permissionDecisionReason, UNGOVERNED_WARNING);
    assert.ok(viaLink.logs.some((line) => line.includes("is not a socket")), viaLink.logs.join("\n"));
    await chmod(f.socketPath, 0o666);
    const loosened = await client(f.socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(loosened.output.hookSpecificOutput.permissionDecisionReason, UNGOVERNED_WARNING);
    assert.ok(loosened.logs.some((line) => line.includes("accessible to group or others")), loosened.logs.join("\n"));
    assert.equal(f.session.callsTo("decideHost").length, 0);
  } finally {
    await f.cleanup();
  }
});

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

test("hooks: a stale socket is replaced; a live daemon or a regular file is never removed", async () => {
  const dir = await tempDir();
  const socketPath = socketPathFor(dir);
  try {
    // A stale socket: bound elsewhere, moved into place, then its listener closed.
    const old = createServer();
    await listen(old, join(dir, "old.sock"));
    await rename(join(dir, "old.sock"), socketPath);
    await new Promise<void>((resolve) => old.close(() => resolve()));
    assert.ok((await lstat(socketPath)).isSocket());
    const daemon = await startHookDaemon({ socketPath, getSession: async () => new FakeSession(), ctx, log: () => {} });
    const run = await client(socketPath, "Stop", {});
    assert.deepEqual(run.output, {});

    await assert.rejects(
      startHookDaemon({ socketPath, getSession: async () => new FakeSession(), ctx, log: () => {} }),
      /another GRU hook daemon is live/,
    );
    const still = await client(socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(permission(still), "allow", "the first daemon still answers");
    await daemon.close();

    await writeFile(socketPath, "not a socket");
    await assert.rejects(
      startHookDaemon({ socketPath, getSession: async () => new FakeSession(), ctx, log: () => {} }),
      /not a socket/,
    );
    assert.ok((await lstat(socketPath)).isFile(), "the regular file is left alone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hooks: the client waits for a daemon that is still starting", async () => {
  const dir = await tempDir();
  const socketPath = socketPathFor(dir);
  let daemon: HookDaemon | null = null;
  try {
    const later = tick(150).then(async () => {
      daemon = await startHookDaemon({ socketPath, getSession: async () => new FakeSession(), ctx, log: () => {} });
    });
    const run = await client(socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }), { connect_wait_ms: 2000 });
    await later;
    assert.equal(permission(run), "allow");
  } finally {
    await (daemon as HookDaemon | null)?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hooks: a daemon that never answers, or answers garbage, -> ask within the timeout", async () => {
  const dir = await tempDir();
  const socketPath = socketPathFor(dir);
  // Reads (so it sees the client hang up) but never answers.
  const silent = createServer((socket) => socket.resume());
  try {
    await listen(silent, socketPath);
    await chmod(socketPath, 0o600);
    const started = Date.now();
    const run = await client(socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }), { timeout_ms: 200 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(run.code, 0);
    assert.equal(run.output.hookSpecificOutput.permissionDecisionReason, UNGOVERNED_WARNING);
  } finally {
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
  const garbage = createServer((socket) => {
    socket.resume();
    socket.end('{"ok":false,"error":"x"}\n');
  });
  try {
    await listen(garbage, socketPath);
    await chmod(socketPath, 0o600);
    const run = await client(socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(permission(run), "ask");
  } finally {
    await new Promise<void>((resolve) => garbage.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("hooks: socketPathFor refuses a path too long for a unix socket", () => {
  assert.throws(() => socketPathFor(`/${"d".repeat(120)}`), SocketPathError);
  assert.equal(socketPathFor("/state"), "/state/hook.sock");
});

test("mcp + hooks: one server process, one lazily opened session shared by tools and hooks", async () => {
  const dir = await tempDir();
  const socketPath = socketPathFor(dir);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = new Lines(output);
  let opens = 0;
  const session = new FakeSession();
  const server = startMcpServer({
    openSession: async () => {
      opens++;
      return session;
    },
    commandIds: ["test"],
    input,
    output,
    socketPath,
    hostContext: ctx,
    log: () => {},
  });
  try {
    await server.ready;
    const start = await client(socketPath, "SessionStart", {});
    assert.match(start.output.hookSpecificOutput.additionalContext, /ep-fake/);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gru_status" } })}\n`);
    const reply = await lines.next((message) => message.id === 1);
    assert.equal(JSON.parse(reply.result.content[0].text).episode_id, "ep-fake");
    await client(socketPath, "PreToolUse", pre("Read", { file_path: "/ws/a" }));
    assert.equal(opens, 1);
    assert.equal(session.callsTo("decideHost").length, 1);
    const report = await server.close();
    assert.equal(report?.closure.status, "PASS");
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp + hooks: a socket without hostContext is a configuration error", () => {
  assert.throws(
    () =>
      startMcpServer({
        openSession: async () => new FakeSession(),
        commandIds: [],
        input: new PassThrough(),
        output: new PassThrough(),
        socketPath: "/tmp/x.sock",
      }),
    /hostContext/,
  );
});
