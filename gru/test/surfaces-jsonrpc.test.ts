import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JsonRpcPeer,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  RpcError,
  type NotificationHandler,
  type RequestHandler,
} from "../src/mcp/jsonrpc.ts";
import { Lines, tick } from "./surfaces-fake-session.ts";

function wire(requests: [string, RequestHandler][] = [], notifications: [string, NotificationHandler][] = []) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = new Lines(output);
  const logs: string[] = [];
  let ended = 0;
  const peer = new JsonRpcPeer({
    input,
    output,
    requests: new Map(requests),
    notifications: new Map(notifications),
    log: (line) => logs.push(line),
    onEnd: () => ended++,
  });
  const send = (message: unknown): void => {
    input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  };
  return { input, output, lines, logs, peer, send, ended: () => ended };
}

test("jsonrpc: a line that is not JSON gets a parse error with id null", async () => {
  const { lines, send } = wire();
  send("{not json");
  const reply = await lines.next();
  assert.deepEqual(reply, { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: reply.error.message } });
});

test("jsonrpc: an unknown method gets -32601 with the request id", async () => {
  const { lines, send } = wire();
  send({ jsonrpc: "2.0", id: 7, method: "no/such" });
  const reply = await lines.next();
  assert.equal(reply.id, 7);
  assert.equal(reply.error.code, METHOD_NOT_FOUND);
});

test("jsonrpc: a prototype member name is not a method", async () => {
  const { lines, send } = wire();
  send({ jsonrpc: "2.0", id: 1, method: "constructor" });
  assert.equal((await lines.next()).error.code, METHOD_NOT_FOUND);
});

test("jsonrpc: a notification is handled and never answered", async () => {
  const seen: unknown[] = [];
  const { lines, send } = wire([["ping", () => ({})]], [["notifications/initialized", (params) => seen.push(params)]]);
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: { a: 1 } });
  send({ jsonrpc: "2.0", method: "notifications/unknown" });
  send({ jsonrpc: "2.0", id: "after", method: "ping" });
  const first = await lines.next();
  assert.equal(first.id, "after", "the first line out must be the ping reply, not a notification reply");
  await tick();
  assert.equal(lines.all.length, 1);
  assert.deepEqual(seen, [{ a: 1 }]);
});

test("jsonrpc: request ids are echoed exactly, string or number, including 0", async () => {
  const { lines, send } = wire([["echo", (params) => params]]);
  for (const id of ["abc", 0, 42]) send({ jsonrpc: "2.0", id, method: "echo", params: { id } });
  for (const id of ["abc", 0, 42]) {
    const reply = await lines.next((message) => message.id === id);
    assert.deepEqual(reply, { jsonrpc: "2.0", id, result: { id } });
  }
});

test("jsonrpc: invalid requests get -32600", async () => {
  const { lines, send } = wire([["ping", () => ({})]]);
  send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.deepEqual((await lines.next()).error.code, INVALID_REQUEST);
  send({ id: 2, method: "ping" });
  const noVersion = await lines.next();
  assert.equal(noVersion.id, 2);
  assert.equal(noVersion.error.code, INVALID_REQUEST);
  send({ jsonrpc: "2.0", id: 3, method: 5 });
  assert.equal((await lines.next()).error.code, INVALID_REQUEST);
  send({ jsonrpc: "2.0", id: { bad: true }, method: "ping" });
  const badId = await lines.next();
  assert.equal(badId.id, null);
  assert.equal(badId.error.code, INVALID_REQUEST);
});

test("jsonrpc: handler errors map to invalid params or internal error", async () => {
  const { lines, send, logs } = wire([
    ["strict", () => {
      throw new RpcError(INVALID_PARAMS, "bad params");
    }],
    ["broken", () => {
      throw new Error("boom");
    }],
  ]);
  send({ jsonrpc: "2.0", id: 1, method: "strict" });
  send({ jsonrpc: "2.0", id: 2, method: "broken" });
  assert.equal((await lines.next((m) => m.id === 1)).error.code, INVALID_PARAMS);
  assert.equal((await lines.next((m) => m.id === 2)).error.code, INTERNAL_ERROR);
  assert.ok(logs.some((line) => line.includes("boom")), "the internal error is logged (stderr), not only returned");
});

test("jsonrpc: a server-initiated request resolves with the client's response", async () => {
  const { lines, send, peer } = wire();
  const pending = peer.request("elicitation/create", { message: "hi" }, 1000);
  const outgoing = await lines.next();
  assert.equal(outgoing.method, "elicitation/create");
  assert.deepEqual(outgoing.params, { message: "hi" });
  send({ jsonrpc: "2.0", id: outgoing.id, result: { action: "accept" } });
  assert.deepEqual(await pending, { action: "accept" });
});

test("jsonrpc: an error response, a timeout and end of input each reject the outgoing request", async () => {
  const { lines, send, peer, input, ended } = wire();
  const errored = peer.request("x", {}, 1000);
  const first = await lines.next();
  send({ jsonrpc: "2.0", id: first.id, error: { code: -1, message: "nope" } });
  await assert.rejects(errored, /nope/);

  await assert.rejects(peer.request("y", {}, 20), /no response to y/);

  const orphan = peer.request("z", {}, 5000);
  input.end();
  await assert.rejects(orphan, /closed/);
  await tick();
  assert.equal(ended(), 1);
});

test("jsonrpc: a response to an unknown id is logged, not written", async () => {
  const { lines, send, logs } = wire();
  send({ jsonrpc: "2.0", id: "gru-99", result: {} });
  await tick();
  assert.equal(lines.all.length, 0);
  assert.ok(logs.some((line) => line.includes("unknown request id")));
});

test("jsonrpc: messages split across chunks and CRLF line ends are parsed", async () => {
  const { lines, input } = wire([["ping", () => ({ pong: true })]]);
  input.write('{"jsonrpc":"2.0","id":1,');
  input.write('"method":"ping"}\r\n');
  assert.deepEqual((await lines.next()).result, { pong: true });
});
