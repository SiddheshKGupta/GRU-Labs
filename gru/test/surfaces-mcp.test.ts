import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AVL } from "../src/avl/principal.ts";
import {
  DIRECTOR_ACTOR,
  ELICITATION_SCHEMA,
  elicitationDirector,
  NO_CHANNEL_REASON,
  PROTOCOL_VERSION,
  startMcpServer,
  type ElicitationPeer,
  type McpServerOptions,
} from "../src/mcp/server.ts";
import type { DirectorChannel, EscalationRequest, ToolResult } from "../src/types.ts";
import { FakeSession, fakeContract, Lines, tick, type FakeScript, type Message } from "./surfaces-fake-session.ts";

interface Harness {
  lines: Lines;
  input: PassThrough;
  server: ReturnType<typeof startMcpServer>;
  opens: () => number;
  session: () => FakeSession;
  directorGiven: () => DirectorChannel | null;
  call: (method: string, params?: unknown) => Promise<Message>;
  send: (message: unknown) => void;
  logs: string[];
}

function harness(script: FakeScript = {}, extra: Partial<McpServerOptions> = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = new Lines(output);
  const logs: string[] = [];
  let opens = 0;
  let session: FakeSession | null = null;
  let director: DirectorChannel | null = null;
  const server = startMcpServer({
    openSession: async ({ director: given }) => {
      opens++;
      director = given;
      await tick(5);
      session = new FakeSession(script, fakeContract(), given);
      return session;
    },
    commandIds: ["test"],
    input,
    output,
    log: (line) => logs.push(line),
    ...extra,
  });
  let nextId = 1;
  const send = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  const call = (method: string, params?: unknown): Promise<Message> => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return lines.next((message) => message.id === id && !("method" in message));
  };
  return {
    lines,
    input,
    server,
    logs,
    send,
    call,
    opens: () => opens,
    session: () => {
      assert.ok(session, "session was opened");
      return session;
    },
    directorGiven: () => director,
  };
}

const initialize = (h: Harness, capabilities: object = {}): Promise<Message> =>
  h.call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities, clientInfo: { name: "test", version: "0" } });

test("mcp: initialize returns the protocol version, tools capability, server info and GRU instructions", async () => {
  const h = harness();
  const reply = await initialize(h);
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.deepEqual(reply.result.serverInfo, { name: "gru", version: "0.1.0" });
  const text: string = reply.result.instructions;
  for (const phrase of ["AVL", "authorized", "recorded", "Project Director", "gru_verify_and_close"]) {
    assert.ok(text.includes(phrase), `instructions mention ${phrase}`);
  }
  assert.equal(h.opens(), 0, "initialize does not open the session");
});

test("mcp: notifications/initialized gets no reply and ping gets {}", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const pong = await h.call("ping");
  assert.deepEqual(pong.result, {});
  assert.equal(h.lines.all.length, 1);
});

test("mcp: tools/list works before the session opens and prefixes the loadout", async () => {
  const h = harness();
  const reply = await h.call("tools/list");
  const names = reply.result.tools.map((tool: Message) => tool.name);
  assert.deepEqual(names, [
    "gru_read_file",
    "gru_list_dir",
    "gru_write_file",
    "gru_delete_file",
    "gru_run_command",
    "gru_status",
    "gru_verify_and_close",
  ]);
  const run = reply.result.tools.find((tool: Message) => tool.name === "gru_run_command");
  assert.deepEqual(run.inputSchema.properties.command_id.enum, ["test"]);
  assert.equal(h.opens(), 0);
});

test("mcp: tools/list has no gru_run_command when no commands are declared", async () => {
  const h = harness({}, { commandIds: [] });
  const names = (await h.call("tools/list")).result.tools.map((tool: Message) => tool.name);
  assert.ok(!names.includes("gru_run_command"));
  assert.ok(names.includes("gru_verify_and_close"));
});

test("mcp: tools/call strips the prefix and routes through session.handle with the JSON-RPC id", async () => {
  const h = harness();
  const reply = await h.call("tools/call", { name: "gru_read_file", arguments: { path: "src/a.ts" } });
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "handled read_file" }], isError: false });
  const handled = h.session().callsTo("handle");
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0]?.args[0], { id: String(reply.id), name: "read_file", input: { path: "src/a.ts" } });
});

test("mcp: a result that is not ok maps to isError true", async () => {
  const h = harness({ handle: (call): ToolResult => ({ call_id: call.id, ok: false, content: "DENY: path escapes" }) });
  const reply = await h.call("tools/call", { name: "gru_write_file", arguments: { path: "../x", content: "" } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "DENY: path escapes");
});

test("mcp: gru_verify_and_close closes with HOST_ENDED; isError unless PASS", async () => {
  for (const [closure, isError] of [["PASS", false], ["FAIL", true], ["PARTIAL", true]] as const) {
    const h = harness({ closure });
    const reply = await h.call("tools/call", { name: "gru_verify_and_close" });
    assert.equal(reply.result.isError, isError, closure);
    assert.equal(JSON.parse(reply.result.content[0].text).closure.status, closure);
    assert.deepEqual(h.session().callsTo("close").map((call) => call.args[0]), ["HOST_ENDED"]);
  }
});

test("mcp: gru_status reports episode id, safety and task", async () => {
  const h = harness();
  const reply = await h.call("tools/call", { name: "gru_status", arguments: {} });
  const status = JSON.parse(reply.result.content[0].text);
  assert.equal(status.episode_id, "ep-fake");
  assert.equal(status.safety.mode, "UNSAFE_DEVELOPMENT");
  assert.equal(status.task, fakeContract().task);
  assert.equal(reply.result.isError, false);
});

test("mcp: an unknown tool is a tool error, not a protocol error, and opens nothing", async () => {
  const h = harness();
  const reply = await h.call("tools/call", { name: "Bash", arguments: { command: "ls" } });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, true);
  assert.equal(h.opens(), 0);
});

test("mcp: tools/call with a malformed name or arguments is invalid params", async () => {
  const h = harness();
  assert.equal((await h.call("tools/call", { arguments: {} })).error.code, -32602);
  assert.equal((await h.call("tools/call", { name: "gru_status", arguments: [1] })).error.code, -32602);
});

test("mcp: the lazy session opens exactly once under concurrent calls", async () => {
  const h = harness();
  const replies = await Promise.all([
    h.call("tools/call", { name: "gru_read_file", arguments: { path: "a" } }),
    h.call("tools/call", { name: "gru_list_dir", arguments: { path: "." } }),
    h.call("tools/call", { name: "gru_status" }),
  ]);
  assert.equal(h.opens(), 1);
  assert.ok(replies.every((reply) => reply.result.isError === false));
  assert.equal(h.session().callsTo("handle").length, 2);
});

test("mcp: a session that fails to open is a tool error and is not retried", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = new Lines(output);
  let opens = 0;
  startMcpServer({
    openSession: async () => {
      opens++;
      throw new Error("state dir is inside the workspace");
    },
    commandIds: [],
    input,
    output,
    log: () => {},
  });
  for (const id of [1, 2]) {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "gru_status" } })}\n`);
    const reply = await lines.next((message) => message.id === id);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /could not be opened: state dir is inside the workspace/);
  }
  assert.equal(opens, 1);
});

test("mcp: end of input closes the episode with HOST_ENDED and resolves closed", async () => {
  const h = harness({ closure: "PARTIAL" });
  await h.call("tools/call", { name: "gru_status" });
  h.input.end();
  const report = await h.server.closed;
  assert.equal(report?.closure.status, "PARTIAL");
  assert.deepEqual(h.session().callsTo("close").map((call) => call.args[0]), ["HOST_ENDED"]);
});

test("mcp: closing a server whose session never opened returns null", async () => {
  const h = harness();
  assert.equal(await h.server.close(), null);
  assert.equal(h.opens(), 0);
});

test("mcp: openSession receives the server's director", async () => {
  const h = harness();
  await h.call("tools/call", { name: "gru_status" });
  assert.equal(h.directorGiven(), h.server.director);
});

// ---------------------------------------------------------------- elicitation director

const ESCALATION: EscalationRequest = {
  authorization_id: "auth-9",
  proposal_id: "prop-9",
  principal: "minion:host",
  tool: "write_file",
  effect: { kind: "fs.write", path: "test/a.test.ts", content_sha256: "ab".repeat(32), bytes: 3 },
  consequences: ["ALTER_VERIFICATION"],
  reasons: ["ALTER_VERIFICATION always requires Project Director approval"],
};

function fakePeer(supports: boolean, answer: () => Promise<unknown>): ElicitationPeer & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    clientSupportsElicitation: supports,
    request(method, params, timeoutMs) {
      sent.push({ method, params, timeoutMs });
      return answer();
    },
  };
}

test("director: elicitation accept with approve true -> APPROVE by the Director", async () => {
  const peer = fakePeer(true, async () => ({ action: "accept", content: { approve: true, reason: "fine" } }));
  const decision = await elicitationDirector(peer).decide(ESCALATION);
  assert.deepEqual(decision, { decision: "APPROVE", actor: DIRECTOR_ACTOR, reason: "fine" });
  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0].method, "elicitation/create");
  assert.deepEqual(peer.sent[0].params.requestedSchema, ELICITATION_SCHEMA);
  assert.equal(peer.sent[0].timeoutMs, 5 * 60_000);
  const text: string = peer.sent[0].params.message;
  for (const part of ["write_file", "test/a.test.ts", "ALTER_VERIFICATION", "always requires Project Director approval"]) {
    assert.ok(text.includes(part), `message includes ${part}`);
  }
});

test("director: decline and approve:false are Director rejections", async () => {
  const declined = await elicitationDirector(fakePeer(true, async () => ({ action: "decline" }))).decide(ESCALATION);
  assert.equal(declined.decision, "REJECT");
  assert.equal(declined.actor, DIRECTOR_ACTOR);
  const no = await elicitationDirector(
    fakePeer(true, async () => ({ action: "accept", content: { approve: false } })),
  ).decide(ESCALATION);
  assert.equal(no.decision, "REJECT");
  assert.equal(no.actor, DIRECTOR_ACTOR);
});

test("director: cancel, malformed answers and errors fail closed as AVL, never approve", async () => {
  const answers: (() => Promise<unknown>)[] = [
    async () => ({ action: "cancel" }),
    async () => ({ action: "accept" }),
    async () => ({ action: "accept", content: { approve: "yes" } }),
    async () => "approve",
    async () => {
      throw new Error("client error");
    },
  ];
  for (const answer of answers) {
    const decision = await elicitationDirector(fakePeer(true, answer)).decide(ESCALATION);
    assert.equal(decision.decision, "REJECT");
    assert.equal(decision.actor, AVL.id);
    assert.ok(decision.reason.length > 0);
  }
});

test("director: without the elicitation capability -> REJECT fail-closed, no request sent", async () => {
  const peer = fakePeer(false, async () => ({ action: "accept", content: { approve: true } }));
  const decision = await elicitationDirector(peer).decide(ESCALATION);
  assert.deepEqual(decision, { decision: "REJECT", actor: "avl:v0", reason: NO_CHANNEL_REASON });
  assert.equal(peer.sent.length, 0);
});

function escalatingScript(): FakeScript {
  return {
    handle: async (call, director) => {
      assert.ok(director);
      const decision = await director.decide(ESCALATION);
      return { call_id: call.id, ok: decision.decision === "APPROVE", content: `${decision.decision} by ${decision.actor}: ${decision.reason}` };
    },
  };
}

test("director over the wire: a client that declared elicitation is asked, and its answer decides", async () => {
  const h = harness(escalatingScript());
  await initialize(h, { elicitation: {} });
  const pending = h.call("tools/call", { name: "gru_write_file", arguments: { path: "test/a.test.ts", content: "x" } });
  const ask = await h.lines.next((message) => message.method === "elicitation/create");
  h.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { approve: true } } });
  const reply = await pending;
  assert.equal(reply.result.isError, false);
  assert.match(reply.result.content[0].text, /^APPROVE by director:mcp-elicitation/);
});

test("director over the wire: no capability declared -> rejected without asking", async () => {
  const h = harness(escalatingScript());
  await initialize(h, {});
  const reply = await h.call("tools/call", { name: "gru_write_file", arguments: { path: "test/a.test.ts", content: "x" } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /^REJECT by avl:v0: no Director channel/);
  assert.ok(!h.lines.all.some((message) => message.method === "elicitation/create"));
});

test("director over the wire: no answer before the timeout -> REJECT", async () => {
  const h = harness(escalatingScript(), { elicitationTimeoutMs: 30 });
  await initialize(h, { elicitation: {} });
  const reply = await h.call("tools/call", { name: "gru_write_file", arguments: { path: "test/a.test.ts", content: "x" } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /^REJECT by avl:v0: the Director was not reached \(no response/);
});
