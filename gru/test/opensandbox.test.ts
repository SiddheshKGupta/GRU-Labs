// The OpenSandbox backend against a fake server built from its OpenAPI
// contracts (specs/sandbox-lifecycle.yml, specs/execd-api.yaml). A live
// smoke test runs only when OPEN_SANDBOX_URL points at a real server.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { isolationFrom } from "../src/blocks.ts";
import { EXECD_PORT, OpenSandboxIsolation, parseEventStream } from "../src/executors/opensandbox.ts";

interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; body: string }
const seen: Seen[] = [];
let exitCode = 0;
let base = "";
let root = "";
const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const path = request.url ?? "/";
  seen.push({ method: request.method ?? "", path, headers: request.headers, body });
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.method === "POST" && path === "/v1/sandboxes") return json(202, { id: "sb-1", status: { state: "Pending" } });
  if (request.method === "GET" && path === "/v1/sandboxes/sb-1") return json(200, { id: "sb-1", status: { state: "Running" } });
  if (request.method === "GET" && path === `/v1/sandboxes/sb-1/endpoints/${EXECD_PORT}`) {
    return json(200, { endpoint: `${base.replace("http://", "")}/execd`, headers: { "X-EXECD-ACCESS-TOKEN": "execd-token" } });
  }
  if (request.method === "POST" && path === "/execd/files/upload") return json(200, {});
  if (request.method === "POST" && path === "/execd/command") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(['data: {"type":"init","text":"cmd-1"}', 'data: {"type":"stdout","text":"hello\\n"}', 'data: {"type":"execution_complete"}', ""].join("\n\n"));
    return;
  }
  if (request.method === "GET" && path === "/execd/command/status/cmd-1") return json(200, { id: "cmd-1", running: false, exit_code: exitCode });
  if (request.method === "DELETE" && path === "/v1/sandboxes/sb-1") return json(204, {});
  return json(404, { error: path });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  root = mkdtempSync(join(tmpdir(), "gru-osb-ws-"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/a.test.js"), "ok\n");
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function backend(admit: string[] = []) {
  return new OpenSandboxIsolation({ url: `${base}/v1`, image: "node:22", env: { OPEN_SANDBOX_API_KEY: "lifecycle-key" }, admit, readyTimeoutMs: 2_000 });
}

test("runs argv natively in a fresh egress-denied sandbox, then deletes it", async () => {
  seen.length = 0;
  exitCode = 0;
  const outcome = await backend().run([process.execPath, "--test"], { root, env: { PATH: "/host/bin", HOME: "/tmp", LANG: "C.UTF-8" }, timeout_ms: 30_000, purpose: "check" });
  assert.equal(outcome.exit_code, 0);
  assert.equal(outcome.stdout, "hello\n");
  assert.equal(outcome.isolation, "opensandbox");
  const create = JSON.parse(seen.find((s) => s.path === "/v1/sandboxes")!.body);
  assert.deepEqual(create.networkPolicy, { defaultAction: "deny", egress: [] });
  assert.equal(create.image.uri, "node:22");
  const command = JSON.parse(seen.find((s) => s.path === "/execd/command")!.body);
  assert.deepEqual(command.argv, ["node", "--test"], "native argv, host node path mapped, no shell string");
  assert.equal(command.command, undefined);
  assert.deepEqual(command.envs, { LANG: "C.UTF-8" }, "host PATH and HOME are not sent");
  assert.ok(seen.some((s) => s.method === "DELETE" && s.path === "/v1/sandboxes/sb-1"));
  assert.ok(seen.find((s) => s.path === "/execd/files/upload")!.body.includes("/workspace/test/a.test.js"));
});

test("the lifecycle key goes to the lifecycle API only; execd gets its own token", async () => {
  seen.length = 0;
  await backend().run(["node", "-e", "1"], { root, env: {}, timeout_ms: 30_000, purpose: "command" });
  for (const request of seen) {
    const lifecycle = request.path.startsWith("/v1/");
    assert.equal(request.headers["open-sandbox-api-key"], lifecycle ? "lifecycle-key" : undefined, request.path);
    if (!lifecycle) assert.equal(request.headers["x-execd-access-token"], "execd-token");
  }
});

test("a failing command reports its exit code; the sandbox is still deleted", async () => {
  seen.length = 0;
  exitCode = 3;
  const outcome = await backend().run(["node", "x.js"], { root, env: {}, timeout_ms: 30_000, purpose: "check" });
  assert.equal(outcome.exit_code, 3);
  assert.ok(seen.some((s) => s.method === "DELETE"));
});

test("an unreachable server is 'did not run' (-1), never a pass", async () => {
  const outcome = await new OpenSandboxIsolation({ url: "http://127.0.0.1:9/v1", image: "node:22", env: {} }).run(["node"], { root, env: {}, timeout_ms: 1_000, purpose: "check" });
  assert.equal(outcome.exit_code, -1);
  assert.match(outcome.stderr, /opensandbox run failed/);
});

test("quarantined until admitted: provides nothing by default", () => {
  assert.deepEqual(backend().provides, []);
  assert.deepEqual(backend(["P1", "P2", "P8"]).provides, ["P1", "P2", "P8"]);
});

test("event streams parse as SSE or JSON lines", () => {
  assert.deepEqual(parseEventStream('data: {"type":"stdout","text":"a"}\n\n{"type":"stderr","text":"b"}\nnoise').map((e) => e.type), ["stdout", "stderr"]);
});

test("GRU_ISOLATION selects the backend and refuses unknown values", () => {
  assert.equal(isolationFrom({})?.id, "node-permission");
  assert.equal(isolationFrom({ GRU_ISOLATION: "opensandbox" })?.id, "opensandbox");
  assert.equal(isolationFrom({ GRU_ISOLATION: "none" }), undefined);
  assert.throws(() => isolationFrom({ GRU_ISOLATION: "docker" }), /not node, opensandbox or none/);
});

test("live smoke test against a real OpenSandbox server", { skip: process.env.OPEN_SANDBOX_URL ? false : "OPEN_SANDBOX_URL not set" }, async () => {
  const live = new OpenSandboxIsolation({ url: process.env.OPEN_SANDBOX_URL!, image: process.env.GRU_SANDBOX_IMAGE ?? "node:22" });
  const outcome = await live.run(["node", "-e", "require('fs').writeFileSync('/tmp/x','1'); console.log('ran')"], { root, env: {}, timeout_ms: 60_000, purpose: "check" });
  assert.equal(outcome.exit_code, 0, outcome.stderr);
  assert.match(outcome.stdout, /ran/);
});
