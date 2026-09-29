import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { toolDefinitions } from "../src/avl/actions.ts";
import { normaliseBaseUrl, OpenAICompatibleRoute, type OpenAICompatibleOptions } from "../src/routes/openai-compatible.ts";
import { RouteError } from "../src/types.ts";
import { startMockServer, type MockReply, type MockRequest, type MockServer } from "./routes-mock-server.ts";

const SENTINEL = "sk-SENTINEL-do-not-leak-7f3a9c";
const ENV = { TEST_API_KEY: SENTINEL };
const TOOLS = toolDefinitions([]);
const OPEN = { system: "You are a Minion.", task: "Fix the bug.", tools: TOOLS };

// One server for the file; each test installs its own script.
let server: MockServer;
let script: (request: MockRequest, index: number) => MockReply = () => ({ status: 500 });
let offset = 0;

before(async () => {
  server = await startMockServer((request, index) => script(request, index - offset));
});
after(async () => {
  await server.close();
});

/** Install this test's replies; the returned function lists the requests the test caused. */
function useScript(replies: MockReply[] | ((request: MockRequest, index: number) => MockReply)): () => MockRequest[] {
  offset = server.requests.length;
  script = typeof replies === "function" ? replies : (_request, index) => replies[index] ?? { status: 500 };
  const start = offset;
  return () => server.requests.slice(start);
}

function route(overrides: Partial<OpenAICompatibleOptions> = {}): OpenAICompatibleRoute {
  return new OpenAICompatibleRoute({
    provider: "mock",
    base_url: server.origin,
    model: "mock-coder",
    api_key_env: "TEST_API_KEY",
    env: ENV,
    ...overrides,
  });
}

function completion(message: Record<string, unknown>, finish_reason: string | null, extra: Record<string, unknown> = {}) {
  return {
    body: {
      id: "cmpl-1",
      model: "mock-coder-served",
      choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
      ...extra,
    },
  };
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: "function", function: { name, arguments: args } };
}

test("openai: normaliseBaseUrl accepts what people paste", () => {
  const cases: [string, string][] = [
    ["https://api.openai.com", "https://api.openai.com/v1"],
    ["https://api.openai.com/", "https://api.openai.com/v1"],
    ["  https://api.deepseek.com/v1/  ", "https://api.deepseek.com/v1"],
    ["https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1"],
    ["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1"],
    ["https://openrouter.ai/api/v1/chat/completions/", "https://openrouter.ai/api/v1"],
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434/v1"],
    ["http://localhost:1234/v1/models", "http://localhost:1234/v1"],
    ["http://127.0.0.1:8000/models", "http://127.0.0.1:8000/v1"],
  ];
  for (const [raw, expected] of cases) assert.equal(normaliseBaseUrl(raw), expected, raw);
});

test("openai: normaliseBaseUrl rejects other schemes, credentials, queries and garbage", () => {
  for (const raw of [
    "ftp://example.com/v1",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1?key=abc",
    "https://api.example.com/v1#frag",
  ]) {
    assert.throws(() => normaliseBaseUrl(raw), RouteError, raw);
  }
});

test("openai: descriptor carries the env var name, never the key", () => {
  const descriptor = route({ base_url: "https://api.deepseek.com/" }).descriptor;
  assert.deepEqual(descriptor, {
    id: "mock/mock-coder",
    kind: "openai-compatible",
    provider: "mock",
    model: "mock-coder",
    base_url: "https://api.deepseek.com/v1",
    credential_ref: "env:TEST_API_KEY",
  });
  assert.ok(!JSON.stringify(descriptor).includes(SENTINEL));
  assert.equal(route({ api_key_env: null }).descriptor.credential_ref, null);
});

test("openai: tool-call round trip with correct message history and request shape", async () => {
  const requests = useScript([
    completion(
      {
        content: null,
        reasoning_content: "provider extra that must not be echoed",
        tool_calls: [
          toolCall("call_1", "read_file", '{"path":"a.ts"}'),
          toolCall("call_2", "list_dir", '{"path":"."}'),
        ],
      },
      "tool_calls",
    ),
    completion({ content: "Fixed it." }, "stop"),
    completion({ content: "Test added." }, "stop"),
  ]);
  const session = route({ headers: { "X-Title": "gru" } }).open(OPEN);

  const first = await session.next({ results: [] });
  assert.equal(first.stop, "tool_use");
  assert.deepEqual(first.calls, [
    { id: "call_1", name: "read_file", input: { path: "a.ts" } },
    { id: "call_2", name: "list_dir", input: { path: "." } },
  ]);
  assert.equal(first.text, "");
  assert.equal(first.served_model, "mock-coder-served");
  assert.deepEqual(first.usage, { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0 });

  const second = await session.next({
    results: [
      { call_id: "call_1", ok: true, content: "export const a = 1;" },
      { call_id: "call_2", ok: false, content: "denied" },
    ],
  });
  assert.equal(second.stop, "end_turn");
  assert.equal(second.text, "Fixed it.");
  assert.deepEqual(second.calls, []);
  await session.next({ results: [], user: "Also add a test." });

  const [r0, r1, r2] = requests() as [MockRequest, MockRequest, MockRequest];
  assert.equal(r0.method, "POST");
  assert.equal(r0.path, "/v1/chat/completions");
  assert.equal(r0.headers.authorization, `Bearer ${SENTINEL}`);
  assert.equal(r0.headers["content-type"], "application/json");
  assert.equal(r0.headers["x-title"], "gru");
  const body0 = r0.body as Record<string, unknown>;
  assert.equal(body0.model, "mock-coder");
  assert.equal(body0.tool_choice, "auto");
  assert.deepEqual(
    body0.tools,
    TOOLS.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    })),
  );
  const system = { role: "system", content: "You are a Minion." };
  const task = { role: "user", content: "Fix the bug." };
  assert.deepEqual(body0.messages, [system, task]);

  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [toolCall("call_1", "read_file", '{"path":"a.ts"}'), toolCall("call_2", "list_dir", '{"path":"."}')],
  };
  const history1 = [
    system,
    task,
    assistant,
    { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
    { role: "tool", tool_call_id: "call_2", content: "denied" },
  ];
  assert.deepEqual((r1.body as { messages: unknown }).messages, history1);
  assert.deepEqual((r2.body as { messages: unknown }).messages, [
    ...history1,
    { role: "assistant", content: "Fixed it." },
    { role: "user", content: "Also add a test." },
  ]);
});

test("openai: no tools -> neither tools nor tool_choice is sent; no key -> no Authorization", async () => {
  const requests = useScript([completion({ content: "hi" }, "stop")]);
  await route({ api_key_env: null }).open({ ...OPEN, tools: [] }).next({ results: [] });
  const body = requests()[0]!.body as Record<string, unknown>;
  assert.ok(!("tools" in body));
  assert.ok(!("tool_choice" in body));
  assert.equal(requests()[0]!.headers.authorization, undefined);
});

test("openai: invalid JSON arguments become {__invalid_json: raw} instead of throwing", async () => {
  useScript([completion({ content: null, tool_calls: [toolCall("call_1", "write_file", '{"path": "a.ts", "content": ')] }, "tool_calls")]);
  const turn = await route().open(OPEN).next({ results: [] });
  assert.deepEqual(turn.calls, [
    { id: "call_1", name: "write_file", input: { __invalid_json: '{"path": "a.ts", "content": ' } },
  ]);
});

test("openai: finish_reason length -> max_tokens with no calls; content_filter -> refusal with no calls", async () => {
  const calls = [toolCall("call_1", "write_file", '{"path":"a","content":"b"}')];
  useScript([
    completion({ content: null, tool_calls: calls }, "length"),
    completion({ content: null, tool_calls: calls }, "content_filter"),
    completion({ content: null, tool_calls: calls }, "function_call"),
    completion({ content: null, tool_calls: calls }, null),
  ]);
  const cut = await route().open(OPEN).next({ results: [] });
  assert.equal(cut.stop, "max_tokens");
  assert.deepEqual(cut.calls, []);
  const filtered = await route().open(OPEN).next({ results: [] });
  assert.equal(filtered.stop, "refusal");
  assert.deepEqual(filtered.calls, []);
  assert.equal(filtered.detail, "content_filter");
  const odd = await route().open(OPEN).next({ results: [] });
  assert.equal(odd.stop, "other");
  assert.deepEqual(odd.calls, []);
  assert.equal(odd.detail, "finish_reason: function_call");
  assert.equal((await route().open(OPEN).next({ results: [] })).stop, "other");
});

test("openai: finish_reason stop WITH tool calls (some local servers) -> tool_use", async () => {
  useScript([completion({ content: null, tool_calls: [toolCall("call_1", "read_file", '{"path":"a"}')] }, "stop")]);
  const turn = await route().open(OPEN).next({ results: [] });
  assert.equal(turn.stop, "tool_use");
  assert.equal(turn.calls.length, 1);
});

test("openai: served_model falls back to the configured model; missing usage counts 0", async () => {
  useScript([{ body: { choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] } }]);
  const turn = await route().open(OPEN).next({ results: [] });
  assert.equal(turn.served_model, "mock-coder");
  assert.deepEqual(turn.usage, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
});

test("openai: 429 and 5xx are retryable; 400 is not and carries the upstream message", async () => {
  useScript([
    { status: 429, body: { error: { message: "Rate limit reached" } } },
    { status: 503, body: { error: { message: "overloaded" } } },
    { status: 400, body: { error: { message: "Invalid model name", type: "invalid_request_error" } } },
    { status: 404, raw: "not here" },
  ]);
  const expectations: [boolean, number, RegExp][] = [
    [true, 429, /Rate limit reached/],
    [true, 503, /overloaded/],
    [false, 400, /HTTP 400: Invalid model name/],
    [false, 404, /not here/],
  ];
  for (const [retryable, status, pattern] of expectations) {
    await assert.rejects(route().open(OPEN).next({ results: [] }), (error: unknown) => {
      assert.ok(error instanceof RouteError);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("openai: network failure and timeout are retryable", async () => {
  const closed = await startMockServer(() => ({ status: 200 }));
  const deadOrigin = closed.origin;
  await closed.close();
  await assert.rejects(route({ base_url: deadOrigin }).open(OPEN).next({ results: [] }), (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, null);
    assert.match(error.message, /network error/);
    return true;
  });

  useScript([{ ...completion({ content: "late" }, "stop"), delay_ms: 400 }]);
  await assert.rejects(route({ timeout_ms: 50 }).open(OPEN).next({ results: [] }), (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /timed out after 50 ms/);
    return true;
  });
});

test("openai: a missing key names the env var, is not retryable, and sends nothing", async () => {
  const requests = useScript([completion({ content: "x" }, "stop")]);
  await assert.rejects(route({ env: {} }).open(OPEN).next({ results: [] }), (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /TEST_API_KEY/);
    return true;
  });
  await assert.rejects(route({ env: { TEST_API_KEY: "" } }).ping(), /TEST_API_KEY/);
  assert.equal(requests().length, 0);
});

test("openai: the key never appears in an error, even when upstream echoes it", async () => {
  useScript((request) => ({
    status: 401,
    body: { error: { message: `Incorrect API key provided: ${String(request.headers.authorization)}` } },
  }));
  await assert.rejects(route().open(OPEN).next({ results: [] }), (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(SENTINEL), error.message);
    assert.ok(!String(error.stack).includes(SENTINEL));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  useScript(() => ({ status: 500, raw: `upstream crashed near ${SENTINEL}` }));
  await assert.rejects(route().ping(), (error: unknown) => error instanceof RouteError && !error.message.includes(SENTINEL));
  assert.throws(
    () => route({ api_key_env: SENTINEL }),
    (error: unknown) => error instanceof RouteError && !error.message.includes(SENTINEL),
  );
});

test("openai: results must answer exactly the outstanding calls; next() is atomic under failure", async () => {
  const requests = useScript([
    { status: 503, body: {} },
    completion({ content: null, tool_calls: [toolCall("call_1", "read_file", '{"path":"a"}')] }, "tool_calls"),
    { status: 502, body: {} },
    completion({ content: "done" }, "stop"),
  ]);
  const session = route().open(OPEN);
  await assert.rejects(session.next({ results: [{ call_id: "x", ok: true, content: "" }] }), RouteError);
  assert.equal(requests().length, 0);
  await assert.rejects(session.next({ results: [] }), (error: unknown) => error instanceof RouteError && error.retryable);
  await session.next({ results: [] });
  await assert.rejects(session.next({ results: [] }), (error: unknown) => error instanceof RouteError && !error.retryable);
  await assert.rejects(session.next({ results: [{ call_id: "call_9", ok: true, content: "" }] }), RouteError);
  const results = [{ call_id: "call_1", ok: true, content: "A" }];
  await assert.rejects(session.next({ results }), RouteError);
  await session.next({ results });
  const sent = requests().map((request) => (request.body as { messages: unknown[] }).messages);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[1], sent[0], "the retried first turn sends the task once");
  assert.deepEqual(sent[3], sent[2], "the retried results are sent once");
  assert.equal(sent[3]!.length, 4);
});

test("openai: ping sends one tiny request with max_tokens 8 and no tools", async () => {
  const requests = useScript([completion({ content: "OK" }, "stop")]);
  assert.equal(await route().ping(), "mock-coder-served");
  assert.deepEqual(requests()[0]!.body, {
    model: "mock-coder",
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
  });
});
