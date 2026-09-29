import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { toolDefinitions } from "../src/avl/actions.ts";
import {
  AnthropicRoute,
  listAnthropicModels,
  loadAnthropicSdk,
  type AnthropicClient,
  type AnthropicRequest,
  type AnthropicResponse,
} from "../src/routes/anthropic.ts";
import { RouteError } from "../src/types.ts";

type Block = { type: string; [key: string]: unknown };
type Scripted = AnthropicResponse | { throws: unknown };
type Message = { role: string; content: unknown };

function reply(content: Block[], stop_reason: string | null, extra: Partial<AnthropicResponse> = {}): AnthropicResponse {
  return {
    content,
    model: "claude-opus-5-5",
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null },
    ...extra,
  };
}

function fake(script: Scripted[]): { client: AnthropicClient; requests: AnthropicRequest[] } {
  const requests: AnthropicRequest[] = [];
  const client: AnthropicClient = {
    beta: {
      messages: {
        async create(params) {
          // Snapshot: the route must not be able to change what was "sent" after the fact.
          requests.push(structuredClone(params));
          const next = script.shift();
          if (next === undefined) throw new Error("fake client: no scripted response left");
          if ("throws" in next) throw next.throws;
          return next;
        },
      },
    },
  };
  return { client, requests };
}

function messagesOf(request: AnthropicRequest | undefined): Message[] {
  assert.ok(request, "request was sent");
  return request.messages as unknown as Message[];
}

const TOOLS = toolDefinitions(["test"]);
const OPEN = { system: "You are a Minion.", task: "Fix the bug.", tools: TOOLS };

test("anthropic: request shape -- strict tools, adaptive thinking, effort, fallbacks, nothing forbidden", async () => {
  const { client, requests } = fake([reply([{ type: "text", text: "hi" }], "end_turn")]);
  await new AnthropicRoute({ client }).open(OPEN).next({ results: [] });
  const request = requests[0]!;
  assert.equal(request.model, "claude-opus-5-5");
  assert.equal(request.max_tokens, 16000);
  assert.equal(request.system, "You are a Minion.");
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.deepEqual(request.output_config, { effort: "high" });
  assert.deepEqual(request.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(request.fallbacks, "default");
  assert.deepEqual(request.tools, TOOLS.map((tool) => ({ ...tool, strict: true })));
  assert.deepEqual(messagesOf(request), [{ role: "user", content: "Fix the bug." }]);
  for (const forbidden of ["tool_choice", "temperature", "top_p", "top_k", "stream"]) {
    assert.ok(!(forbidden in request), `${forbidden} must not be sent`);
  }
  assert.ok(!JSON.stringify(request).includes("budget_tokens"));
});

test("anthropic: constructor options reach the request; an empty system prompt is omitted", async () => {
  const { client, requests } = fake([reply([{ type: "text", text: "hi" }], "end_turn")]);
  await new AnthropicRoute({ client, model: "claude-sonnet-5-5", effort: "xhigh", max_tokens: 4000 })
    .open({ ...OPEN, system: "" })
    .next({ results: [] });
  assert.equal(requests[0]!.model, "claude-sonnet-5-5");
  assert.equal(requests[0]!.max_tokens, 4000);
  assert.deepEqual(requests[0]!.output_config, { effort: "xhigh" });
  assert.ok(!("system" in requests[0]!));
  assert.throws(() => new AnthropicRoute({ effort: "extreme" as never }), RouteError);
});

test("anthropic: descriptor", () => {
  assert.deepEqual(new AnthropicRoute({ model: "claude-opus-5-5" }).descriptor, {
    id: "anthropic/claude-opus-5-5",
    kind: "anthropic",
    provider: "anthropic",
    model: "claude-opus-5-5",
    base_url: null,
    credential_ref: "env:ANTHROPIC_API_KEY",
  });
});

const TURN_1: Block[] = [
  { type: "thinking", thinking: "", signature: "sig-1" },
  { type: "text", text: "Reading first." },
  { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "a.ts" } },
  { type: "tool_use", id: "tu-2", name: "list_dir", input: { path: "." } },
];
const TURN_2: Block[] = [
  { type: "thinking", thinking: "", signature: "sig-2" },
  { type: "tool_use", id: "tu-3", name: "write_file", input: { path: "a.ts", content: "fixed" } },
];
const TURN_3: Block[] = [{ type: "text", text: "Done." }];

test("anthropic: history is append-only across turns, thinking blocks echoed unchanged", async () => {
  const { client, requests } = fake([
    reply(TURN_1, "tool_use"),
    reply(TURN_2, "tool_use"),
    reply(TURN_3, "end_turn"),
    reply([{ type: "text", text: "ok" }], "end_turn"),
  ]);
  const session = new AnthropicRoute({ client }).open(OPEN);

  const first = await session.next({ results: [] });
  assert.deepEqual(first.calls.map((call) => call.id), ["tu-1", "tu-2"]);
  assert.equal(first.stop, "tool_use");
  assert.equal(first.text, "Reading first.");
  await session.next({
    results: [
      { call_id: "tu-1", ok: true, content: "export const a = 1;" },
      { call_id: "tu-2", ok: false, content: "denied" },
    ],
  });
  const third = await session.next({ results: [{ call_id: "tu-3", ok: true, content: "written" }] });
  assert.equal(third.stop, "end_turn");
  await session.next({ results: [], user: "Also add a test." });

  const sent = requests.map(messagesOf);
  assert.deepEqual(sent.map((messages) => messages.length), [1, 3, 5, 7]);
  for (let index = 1; index < sent.length; index += 1) {
    assert.deepEqual(
      sent[index]!.slice(0, sent[index - 1]!.length),
      sent[index - 1],
      `request ${index} must start with request ${index - 1}'s messages, unchanged`,
    );
  }
  assert.deepEqual(sent[1]![1], { role: "assistant", content: TURN_1 }, "full content, thinking included");
  assert.deepEqual(sent[2]![3], { role: "assistant", content: TURN_2 });
  assert.deepEqual(sent[3]![5], { role: "assistant", content: TURN_3 });
  assert.deepEqual(sent[3]![6], { role: "user", content: "Also add a test." });
});

test("anthropic: tool results go back as ONE user message with is_error", async () => {
  const { client, requests } = fake([reply(TURN_1, "tool_use"), reply(TURN_3, "end_turn")]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  await session.next({ results: [] });
  await session.next({
    results: [
      { call_id: "tu-1", ok: true, content: "file body" },
      { call_id: "tu-2", ok: false, content: "denied: no grant" },
    ],
  });
  const sent = messagesOf(requests[1]);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu-1", content: "file body", is_error: false },
      { type: "tool_result", tool_use_id: "tu-2", content: "denied: no grant", is_error: true },
    ],
  });
});

test("anthropic: results must answer exactly the outstanding calls; nothing is sent otherwise", async () => {
  const { client, requests } = fake([reply(TURN_1, "tool_use"), reply(TURN_3, "end_turn")]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  await assert.rejects(session.next({ results: [{ call_id: "tu-1", ok: true, content: "x" }] }), RouteError);
  assert.equal(requests.length, 0, "tool results before the first turn are refused locally");
  await session.next({ results: [] });
  for (const results of [
    [],
    [{ call_id: "tu-1", ok: true, content: "x" }],
    [{ call_id: "tu-1", ok: true, content: "x" }, { call_id: "tu-9", ok: true, content: "x" }],
    [{ call_id: "tu-1", ok: true, content: "x" }, { call_id: "tu-1", ok: true, content: "x" }],
  ]) {
    await assert.rejects(session.next({ results }), (error: unknown) => error instanceof RouteError && !error.retryable);
  }
  assert.equal(requests.length, 1);
});

test("anthropic: refusal -> no calls even when tool_use blocks are present; detail from stop_details", async () => {
  const content: Block[] = [
    { type: "text", text: "Starting." },
    { type: "tool_use", id: "tu-1", name: "delete_file", input: { path: "x" } },
  ];
  const { client } = fake([
    reply(content, "refusal", {
      stop_details: { category: "cyber", explanation: "This looks like exploit development." },
    }),
    reply(content, "refusal", { stop_details: null }),
  ]);
  const route = new AnthropicRoute({ client });
  const refused = await route.open(OPEN).next({ results: [] });
  assert.equal(refused.stop, "refusal");
  assert.deepEqual(refused.calls, []);
  assert.equal(refused.detail, "cyber: This looks like exploit development.");
  const bare = await route.open(OPEN).next({ results: [] });
  assert.deepEqual(bare.calls, []);
  assert.equal(bare.detail, "unknown: ");
});

test("anthropic: max_tokens -> max_tokens with no calls; unknown stops -> other with no calls", async () => {
  const truncated: Block[] = [{ type: "tool_use", id: "tu-1", name: "write_file", input: { path: "a" } }];
  const { client } = fake([
    reply(truncated, "max_tokens"),
    reply(truncated, "model_context_window_exceeded"),
    reply([{ type: "text", text: "s" }], "stop_sequence"),
  ]);
  const route = new AnthropicRoute({ client });
  const cut = await route.open(OPEN).next({ results: [] });
  assert.equal(cut.stop, "max_tokens");
  assert.deepEqual(cut.calls, []);
  const other = await route.open(OPEN).next({ results: [] });
  assert.equal(other.stop, "other");
  assert.deepEqual(other.calls, []);
  assert.equal(other.detail, "stop_reason: model_context_window_exceeded");
  assert.equal((await route.open(OPEN).next({ results: [] })).stop, "end_turn");
});

test("anthropic: fallback -- blocks before the last fallback filtered in history; calls only after it", async () => {
  const fallback = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: null };
  const content: Block[] = [
    { type: "thinking", thinking: "", signature: "s-before" },
    { type: "text", text: "partial" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "server_tool_use", id: "srv-unanswered", name: "web_search", input: { query: "a" } },
    { type: "server_tool_use", id: "srv-answered", name: "web_search", input: { query: "b" } },
    { type: "web_search_tool_result", tool_use_id: "srv-answered", content: [] },
    { type: "tool_use", id: "tu-before", name: "read_file", input: { path: "before" } },
    fallback,
    { type: "thinking", thinking: "", signature: "s-after" },
    { type: "text", text: "after" },
    { type: "tool_use", id: "tu-after", name: "read_file", input: { path: "after" } },
  ];
  const { client, requests } = fake([
    reply(content, "tool_use", { model: "claude-opus-4-8" }),
    reply(TURN_3, "end_turn", { model: "claude-opus-4-8" }),
  ]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  const turn = await session.next({ results: [] });
  assert.deepEqual(turn.calls, [{ id: "tu-after", name: "read_file", input: { path: "after" } }]);
  assert.equal(turn.served_model, "claude-opus-4-8");

  await session.next({ results: [{ call_id: "tu-after", ok: true, content: "x" }] });
  assert.deepEqual(messagesOf(requests[1])[1], {
    role: "assistant",
    content: [
      { type: "text", text: "partial" },
      { type: "server_tool_use", id: "srv-answered", name: "web_search", input: { query: "b" } },
      { type: "web_search_tool_result", tool_use_id: "srv-answered", content: [] },
      fallback,
      { type: "thinking", thinking: "", signature: "s-after" },
      { type: "text", text: "after" },
      { type: "tool_use", id: "tu-after", name: "read_file", input: { path: "after" } },
    ],
  });
});

test("anthropic: with several fallback blocks only the LAST one is the boundary", async () => {
  const first = { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: null };
  const second = { type: "fallback", from: { model: "b" }, to: { model: "c" }, trigger: null };
  const content: Block[] = [
    { type: "tool_use", id: "tu-a", name: "read_file", input: { path: "a" } },
    first,
    { type: "thinking", thinking: "", signature: "s-b" },
    { type: "tool_use", id: "tu-b", name: "read_file", input: { path: "b" } },
    second,
    { type: "tool_use", id: "tu-c", name: "read_file", input: { path: "c" } },
  ];
  const { client, requests } = fake([reply(content, "tool_use"), reply(TURN_3, "end_turn")]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  const turn = await session.next({ results: [] });
  assert.deepEqual(turn.calls.map((call) => call.id), ["tu-c"]);
  await session.next({ results: [{ call_id: "tu-c", ok: true, content: "x" }] });
  assert.deepEqual(messagesOf(requests[1])[1], {
    role: "assistant",
    content: [first, second, { type: "tool_use", id: "tu-c", name: "read_file", input: { path: "c" } }],
  });
});

test("anthropic: pause_turn is re-sent automatically with no extra user message", async () => {
  const paused1: Block[] = [
    { type: "text", text: "Searching." },
    { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "q" } },
  ];
  const paused2: Block[] = [
    { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
    { type: "text", text: "Found it." },
  ];
  const { client, requests } = fake([
    reply(paused1, "pause_turn"),
    reply(paused2, "pause_turn", { usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 4 } }),
    reply([{ type: "text", text: "Answer." }], "end_turn", { model: "claude-opus-4-8" }),
  ]);
  const turn = await new AnthropicRoute({ client }).open(OPEN).next({ results: [] });
  assert.equal(requests.length, 3);
  const task = { role: "user", content: "Fix the bug." };
  assert.deepEqual(messagesOf(requests[1]), [task, { role: "assistant", content: paused1 }]);
  assert.deepEqual(messagesOf(requests[2]), [
    task,
    { role: "assistant", content: paused1 },
    { role: "assistant", content: paused2 },
  ]);
  assert.equal(turn.stop, "end_turn");
  assert.equal(turn.text, "Searching.\nFound it.\nAnswer.");
  assert.equal(turn.served_model, "claude-opus-4-8");
  assert.deepEqual(turn.usage, { input_tokens: 40, output_tokens: 16, cache_read_input_tokens: 4 });
});

test("anthropic: pause_turn is re-sent at most 3 times, then the turn ends as other", async () => {
  const paused = reply([{ type: "server_tool_use", id: "s", name: "web_search", input: {} }], "pause_turn");
  const { client, requests } = fake([paused, paused, paused, paused, paused]);
  const turn = await new AnthropicRoute({ client }).open(OPEN).next({ results: [] });
  assert.equal(requests.length, 4, "the original request plus three re-sends");
  assert.equal(turn.stop, "other");
  assert.deepEqual(turn.calls, []);
  assert.match(turn.detail ?? "", /pause_turn/);
});

test("anthropic: served_model and usage come from the response; a null cache count is 0", async () => {
  const { client } = fake([
    reply([{ type: "text", text: "a" }], "end_turn", {
      model: "claude-opus-4-8",
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11 },
    }),
    reply([{ type: "text", text: "b" }], "end_turn"),
  ]);
  const route = new AnthropicRoute({ client });
  const first = await route.open(OPEN).next({ results: [] });
  assert.equal(first.served_model, "claude-opus-4-8");
  assert.deepEqual(first.usage, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11 });
  const second = await route.open(OPEN).next({ results: [] });
  assert.equal(second.usage.cache_read_input_tokens, 0);
  assert.equal(second.detail, null);
});

test("anthropic: returned call inputs are copies; mutating one cannot edit history", async () => {
  // The fake hands back its blocks by reference, so compare against a snapshot taken first.
  const expected = structuredClone(TURN_1);
  const { client, requests } = fake([reply(structuredClone(TURN_1), "tool_use"), reply(TURN_3, "end_turn")]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  const turn = await session.next({ results: [] });
  (turn.calls[0]!.input as { path: string }).path = "../../etc/shadow";
  await session.next({
    results: [
      { call_id: "tu-1", ok: true, content: "x" },
      { call_id: "tu-2", ok: true, content: "y" },
    ],
  });
  assert.deepEqual(messagesOf(requests[1])[1], { role: "assistant", content: expected });
});

test("anthropic: SDK typed errors map to RouteError by class, never by message", async () => {
  const A = (await loadAnthropicSdk()).default;
  const headers = new Headers();
  const body = { type: "error", error: { type: "api_error", message: "m" } };
  const cases: [unknown, boolean, number | null][] = [
    [new A.RateLimitError(429, body, "please continue", headers), true, 429],
    [new A.InternalServerError(500, body, "fine", headers), true, 500],
    [new A.InternalServerError(529, body, "overloaded", headers), true, 529],
    [new A.APIConnectionError({ message: "socket hang up" }), true, null],
    [new A.APIConnectionTimeoutError(), true, null],
    // The message claims a retryable condition; the class says otherwise, and the class wins.
    [new A.BadRequestError(400, body, "rate limit exceeded, overloaded, retry", headers), false, 400],
    [new A.AuthenticationError(401, body, "invalid x-api-key", headers), false, 401],
    [new A.NotFoundError(404, body, "model not found", headers), false, 404],
    [new A.APIUserAbortError(), false, null],
  ];
  for (const [thrown, retryable, status] of cases) {
    const { client } = fake([{ throws: thrown }]);
    await assert.rejects(new AnthropicRoute({ client }).open(OPEN).next({ results: [] }), (error: unknown) => {
      assert.ok(error instanceof RouteError, `${(thrown as Error).name} -> RouteError`);
      assert.equal(error.retryable, retryable, `${(thrown as Error).name} retryable`);
      assert.equal(error.status, status, `${(thrown as Error).name} status`);
      return true;
    });
  }
});

test("anthropic: non-SDK errors -- numeric status classified by status, anything else not retryable", async () => {
  const cases: [unknown, boolean, number | null][] = [
    [{ status: 503 }, true, 503],
    [{ status: 429 }, true, 429],
    [{ status: 422 }, false, 422],
    [new TypeError("x is not a function"), false, null],
    ["a string", false, null],
  ];
  for (const [thrown, retryable, status] of cases) {
    const { client } = fake([{ throws: thrown }]);
    await assert.rejects(new AnthropicRoute({ client }).open(OPEN).next({ results: [] }), (error: unknown) => {
      assert.ok(error instanceof RouteError);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test("anthropic: next() is atomic -- a failed call leaves history unchanged, so the same input can be retried", async () => {
  const A = (await loadAnthropicSdk()).default;
  const overloaded = { throws: new A.InternalServerError(529, undefined, "overloaded", new Headers()) };
  const { client, requests } = fake([
    overloaded,
    reply(TURN_1, "tool_use"),
    overloaded,
    reply(TURN_3, "end_turn"),
  ]);
  const session = new AnthropicRoute({ client }).open(OPEN);
  await assert.rejects(session.next({ results: [] }), RouteError);
  await session.next({ results: [] });
  const results = [
    { call_id: "tu-1", ok: true, content: "x" },
    { call_id: "tu-2", ok: true, content: "y" },
  ];
  await assert.rejects(session.next({ results }), RouteError);
  await session.next({ results });
  const sent = requests.map(messagesOf);
  assert.deepEqual(sent[1], sent[0], "the retry of the first turn sends the task once");
  assert.deepEqual(sent[3], sent[2], "the retry of the results sends them once");
  assert.equal(sent[3]!.length, 3);
});

test("anthropic: ping sends one tiny request with no tools and returns the served model", async () => {
  const { client, requests } = fake([reply([{ type: "text", text: "OK" }], "end_turn", { model: "claude-opus-5-5" })]);
  assert.equal(await new AnthropicRoute({ client }).ping(), "claude-opus-5-5");
  assert.deepEqual(requests[0], {
    model: "claude-opus-5-5",
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
});

test("anthropic: listAnthropicModels walks the paginated list, sorted and unique", async () => {
  const client = {
    models: {
      async *list() {
        yield { id: "claude-sonnet-5-5" };
        yield { id: "claude-opus-5-5" };
        yield { id: "claude-sonnet-5-5" };
      },
    },
  };
  assert.deepEqual(await listAnthropicModels(client), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  const failing = {
    models: {
      async *list(): AsyncGenerator<{ id: string }> {
        yield { id: "claude-opus-5-5" };
        throw { status: 500 };
      },
    },
  };
  await assert.rejects(listAnthropicModels(failing), (error: unknown) => error instanceof RouteError && error.retryable);
});

test("anthropic: only src/routes/anthropic.ts imports the SDK, and only lazily", () => {
  const root = new URL("../src/", import.meta.url);
  const sdkImport = /(from\s*|import\s*\(\s*|require\s*\(\s*)["']@anthropic-ai\/sdk/;
  const importers: string[] = [];
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    if (!entry.endsWith(".ts")) continue;
    if (sdkImport.test(readFileSync(new URL(entry, root), "utf8"))) importers.push(entry.split("\\").join("/"));
  }
  assert.deepEqual(importers, ["routes/anthropic.ts"]);
  const source = readFileSync(new URL("routes/anthropic.ts", root), "utf8");
  const staticValueImport = /^\s*import\s+(?!type\b)[^;]*from\s*["']@anthropic-ai\/sdk/m;
  assert.ok(!staticValueImport.test(source), "no static value import: GRU must load without the SDK");
  assert.match(source, /import\("@anthropic-ai\/sdk"\)/);
});
