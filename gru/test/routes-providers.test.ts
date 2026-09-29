import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { AnthropicClient, AnthropicModelsClient } from "../src/routes/anthropic.ts";
import {
  AUTO_TTL_MS,
  parseProviders,
  PRESETS,
  ProviderConfigError,
  ProviderRegistry,
  rankModels,
  type ProviderRegistryOptions,
} from "../src/routes/providers.ts";
import { RouteError, type ProviderConfig } from "../src/types.ts";
import { startMockServer, type MockReply, type MockRequest, type MockServer } from "./routes-mock-server.ts";

const SENTINEL = "sk-proj-SENTINEL0123456789abcdef";
const ENV = { TEST_API_KEY: SENTINEL };

let server: MockServer;
let handler: (request: MockRequest) => MockReply = () => ({ status: 500 });

before(async () => {
  server = await startMockServer((request) => handler(request));
});
after(async () => {
  await server.close();
});

/** Serve a /models list and answer chat probes: 200 for models in `ok`, else the given failure. */
function serve(models: string[], ok: string[], failure: MockReply = { status: 404, body: { error: { message: "model not found" } } }): () => MockRequest[] {
  const start = server.requests.length;
  handler = (request) => {
    if (request.method === "GET" && request.path === "/v1/models") return { body: { object: "list", data: models.map((id) => ({ id })) } };
    const model = (request.body as { model?: string } | null)?.model ?? "";
    if (request.method === "POST" && request.path === "/v1/chat/completions" && ok.includes(model)) {
      return { body: { model, choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] } };
    }
    return failure;
  };
  return () => server.requests.slice(start);
}

function probedModels(requests: MockRequest[]): string[] {
  return requests.filter((request) => request.method === "POST").map((request) => (request.body as { model: string }).model);
}

function mockConfig(overrides: Record<string, unknown> = {}): ProviderConfig[] {
  return parseProviders([
    { id: "mock", kind: "openai-compatible", base_url: server.origin, api_key_env: "TEST_API_KEY", ...overrides },
  ]);
}

function registry(overrides: Record<string, unknown> = {}, options: ProviderRegistryOptions = {}): ProviderRegistry {
  return new ProviderRegistry(mockConfig(overrides), { env: ENV, ...options });
}

test("providers: presets", () => {
  assert.deepEqual(
    PRESETS.map(({ id, kind, base_url, api_key_env, default_model }) => ({ id, kind, base_url, api_key_env, default_model })),
    [
      { id: "anthropic", kind: "anthropic", base_url: null, api_key_env: "ANTHROPIC_API_KEY", default_model: "claude-opus-5-5" },
      { id: "openai", kind: "openai-compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", default_model: null },
      { id: "deepseek", kind: "openai-compatible", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", default_model: null },
      { id: "openrouter", kind: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY", default_model: null },
      { id: "groq", kind: "openai-compatible", base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY", default_model: null },
      { id: "ollama", kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1", api_key_env: null, default_model: null },
      { id: "lmstudio", kind: "openai-compatible", base_url: "http://127.0.0.1:1234/v1", api_key_env: null, default_model: null },
    ],
  );
  for (const config of PRESETS) {
    assert.deepEqual(config.models, []);
    assert.deepEqual(config.headers, {});
  }
  assert.throws(() => {
    (PRESETS[0] as { id: string }).id = "hijacked";
  }, TypeError);
});

test("providers: list() reports credential status from the environment, presets first", () => {
  const list = new ProviderRegistry(mockConfig(), { env: { OPENAI_API_KEY: "x", TEST_API_KEY: "y" } }).list();
  assert.deepEqual(
    list.map((entry) => [entry.config.id, entry.credential]),
    [
      ["anthropic", "MISSING"],
      ["openai", "CONFIGURED"],
      ["deepseek", "MISSING"],
      ["openrouter", "MISSING"],
      ["groq", "MISSING"],
      ["ollama", "NOT_REQUIRED"],
      ["lmstudio", "NOT_REQUIRED"],
      ["mock", "CONFIGURED"],
    ],
  );
  const empty = new ProviderRegistry([], { env: { DEEPSEEK_API_KEY: "" } }).list();
  assert.equal(empty.find((entry) => entry.config.id === "deepseek")?.credential, "MISSING", "an empty value is missing");
  const token = new ProviderRegistry([], { env: { ANTHROPIC_AUTH_TOKEN: "t" } }).list();
  assert.equal(token[0]?.credential, "CONFIGURED");
});

test("providers: list() returns copies", () => {
  const catalog = new ProviderRegistry([], { env: {} });
  catalog.list()[1]!.config.base_url = "https://evil.example/v1";
  catalog.list()[1]!.config.models.push("x");
  assert.equal(catalog.list()[1]!.config.base_url, "https://api.openai.com/v1");
  assert.deepEqual(catalog.list()[1]!.config.models, []);
});

test("providers: config entries override presets field by field; new ids are added", () => {
  const configs = parseProviders([
    { id: "openai", default_model: "gpt-4o" },
    { id: "ollama", base_url: "http://10.0.0.5:11434", models: ["qwen2.5-coder"] },
    { id: "deepseek", api_key_env: null },
    { id: "together", kind: "openai-compatible", base_url: "https://api.together.xyz", api_key_env: "TOGETHER_API_KEY" },
  ]);
  assert.deepEqual(configs[0], {
    id: "openai",
    kind: "openai-compatible",
    base_url: "https://api.openai.com/v1",
    api_key_env: "OPENAI_API_KEY",
    default_model: "gpt-4o",
    models: [],
    headers: {},
  });
  assert.equal(configs[1]!.base_url, "http://10.0.0.5:11434/v1");
  assert.deepEqual(configs[1]!.models, ["qwen2.5-coder"]);
  assert.equal(configs[2]!.api_key_env, null, "an explicit null overrides");
  assert.equal(configs[2]!.base_url, "https://api.deepseek.com/v1", "fields not named keep the preset value");
  assert.deepEqual(configs[3], {
    id: "together",
    kind: "openai-compatible",
    base_url: "https://api.together.xyz/v1",
    api_key_env: "TOGETHER_API_KEY",
    default_model: null,
    models: [],
    headers: {},
  });

  const list = new ProviderRegistry(configs, { env: {} }).list();
  assert.deepEqual(
    list.map((entry) => entry.config.id),
    ["anthropic", "openai", "deepseek", "openrouter", "groq", "ollama", "lmstudio", "together"],
  );
  assert.equal(list[1]!.config.default_model, "gpt-4o");
  assert.equal(list[2]!.credential, "NOT_REQUIRED");
});

test("providers: parseProviders rejects a pasted key without echoing it", () => {
  for (const pasted of [SENTINEL, "sk-ant-api03-SENTINELabc123", "gsk_SENTINEL0123456789abcd"]) {
    assert.throws(
      () => parseProviders([{ id: "openai", api_key_env: pasted }]),
      (error: unknown) =>
        error instanceof ProviderConfigError &&
        /looks like a literal API key/.test(error.message) &&
        !error.message.includes(pasted),
      pasted,
    );
  }
  for (const headers of [{ Authorization: `Bearer ${SENTINEL}` }, { "x-api-key": SENTINEL }, { "X-Custom": SENTINEL }]) {
    assert.throws(
      () => parseProviders([{ id: "openrouter", headers }]),
      (error: unknown) =>
        error instanceof ProviderConfigError && /credential/.test(error.message) && !error.message.includes(SENTINEL),
    );
  }
  assert.throws(
    () => parseProviders([{ id: "openai", api_key_env: "openai_api_key" }]),
    /must be an environment variable name/,
  );
});

test("providers: parseProviders rejects malformed configuration", () => {
  const bad: [unknown, RegExp][] = [
    [{ providers: [] }, /must be an array/],
    [["openai"], /must be an object/],
    [[{ id: "openai", apikey: "x" }], /unknown key "apikey"/],
    [[{ id: "Open AI", kind: "openai-compatible", base_url: "https://x.example" }], /id: must match/],
    [[{ id: "together", base_url: "https://x.example" }], /kind is required/],
    [[{ id: "together", kind: "gemini", base_url: "https://x.example" }], /kind must be/],
    [[{ id: "together", kind: "openai-compatible" }], /base_url is required/],
    [[{ id: "together", kind: "openai-compatible", base_url: "ftp://x.example" }], /http or https/],
    [[{ id: "anthropic", base_url: "https://proxy.example" }], /base_url must be null for kind anthropic/],
    [[{ id: "anthropic", api_key_env: "MY_CLAUDE_KEY" }], /must be ANTHROPIC_API_KEY/],
    [[{ id: "openai", models: ["ok", 3] }], /models must be an array/],
    [[{ id: "openai", default_model: "" }], /default_model/],
    [[{ id: "openai", headers: { "bad header": "x" } }], /header name/],
    [[{ id: "openai" }, { id: "openai" }], /duplicate id "openai"/],
  ];
  for (const [json, pattern] of bad) {
    assert.throws(
      () => parseProviders(json),
      (error: unknown) => error instanceof ProviderConfigError && error instanceof RouteError && pattern.test(error.message),
      JSON.stringify(json),
    );
  }
  assert.throws(() => new ProviderRegistry([{ id: "x" } as unknown as ProviderConfig]), ProviderConfigError);
});

test("providers: route() resolves provider/model and provider-only specs", () => {
  const catalog = new ProviderRegistry(
    parseProviders([
      { id: "mock", kind: "openai-compatible", base_url: server.origin, api_key_env: "TEST_API_KEY", default_model: "m-default" },
    ]),
    { env: ENV },
  );
  assert.deepEqual(catalog.route("mock/m1").descriptor, {
    id: "mock/m1",
    kind: "openai-compatible",
    provider: "mock",
    model: "m1",
    base_url: `${server.origin}/v1`,
    credential_ref: "env:TEST_API_KEY",
  });
  assert.equal(catalog.route("mock").descriptor.model, "m-default");
  assert.equal(catalog.route("openrouter/meta-llama/llama-3.1-8b").descriptor.model, "meta-llama/llama-3.1-8b");
  const claude = catalog.route("anthropic").descriptor;
  assert.equal(claude.kind, "anthropic");
  assert.equal(claude.model, "claude-opus-5-5");
  assert.equal(catalog.route("anthropic/claude-sonnet-5-5").descriptor.id, "anthropic/claude-sonnet-5-5");
});

test("providers: route() errors are clear", () => {
  const catalog = new ProviderRegistry([], { env: {} });
  assert.throws(() => catalog.route("openai"), (error: unknown) => error instanceof RouteError && /gru models openai/.test(error.message));
  assert.throws(
    () => catalog.route("nope/x"),
    (error: unknown) =>
      error instanceof RouteError && /unknown provider "nope"/.test(error.message) && /anthropic, openai, deepseek/.test(error.message),
  );
  assert.throws(() => catalog.route("openai/"), RouteError);
  assert.throws(() => catalog.route(""), RouteError);
});

test("providers: discover() parses the /models catalogue, sorted and unique, with the key sent", async () => {
  const requests = serve(["zeta", "alpha", "zeta", "mid"], []);
  assert.deepEqual(await registry().discover("mock"), ["alpha", "mid", "zeta"]);
  const [request] = requests();
  assert.equal(request?.method, "GET");
  assert.equal(request?.path, "/v1/models");
  assert.equal(request?.headers.authorization, `Bearer ${SENTINEL}`);

  handler = () => ({ body: { models: [{ name: "llama3.2" }, { id: "qwen2.5-coder" }, { name: "" }, 7] } });
  assert.deepEqual(await registry().discover("mock"), ["llama3.2", "qwen2.5-coder"]);
  handler = () => ({ body: { nothing: true } });
  await assert.rejects(registry().discover("mock"), RouteError);
  handler = () => ({ status: 503, body: {} });
  await assert.rejects(registry().discover("mock"), (error: unknown) => error instanceof RouteError && error.retryable);
});

test("providers: discover() for anthropic goes through the SDK's models.list", async () => {
  const client = {
    beta: { messages: { create: async () => { throw new Error("unused"); } } },
    models: {
      async *list() {
        yield { id: "claude-sonnet-5-5" };
        yield { id: "claude-opus-5-5" };
      },
    },
  } as AnthropicClient & AnthropicModelsClient;
  const catalog = new ProviderRegistry([], { env: {}, anthropicClient: client });
  assert.deepEqual(await catalog.discover("anthropic"), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("providers: probe() records latency on success and a short error on failure, never the key", async () => {
  let now = 1_000;
  serve([], ["good-model"], { status: 401, body: { error: { message: `bad key ${SENTINEL}` } } });
  const inner = handler;
  handler = (request) => {
    now += 42;
    return inner(request);
  };
  const catalog = registry({}, { clock: () => now });
  assert.deepEqual(await catalog.probe("mock", "good-model"), {
    provider: "mock",
    model: "good-model",
    ok: true,
    latency_ms: 42,
    error: null,
  });
  const failed = await catalog.probe("mock", "bad-model");
  assert.equal(failed.ok, false);
  assert.equal(failed.latency_ms, null);
  assert.match(failed.error ?? "", /HTTP 401/);
  assert.ok(!(failed.error ?? "").includes(SENTINEL));
});

test("providers: probe() for anthropic uses the route's client with no tools", async () => {
  const sent: unknown[] = [];
  const client = {
    beta: {
      messages: {
        async create(params: unknown) {
          sent.push(params);
          return {
            content: [{ type: "text", text: "OK" }],
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    },
    models: { async *list() {} },
  } as unknown as AnthropicClient & AnthropicModelsClient;
  const result = await new ProviderRegistry([], { env: {}, anthropicClient: client }).probe("anthropic", "claude-opus-5-5");
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ model: "claude-opus-5-5", max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] }]);
});

test("providers: rankModels -- prefer, default, coder/chat/instruct, others, reasoning last", () => {
  assert.deepEqual(
    rankModels(
      ["deepseek-reasoner", "gpt-x", "a-chat", "qwen-coder", "default-m", "pref", "o1-mini", "zeta-instruct", "qwen3-thinking", "deepseek-r1", "llama-3.1-8b"],
      { prefer: "pref", default_model: "default-m" },
    ),
    ["pref", "default-m", "a-chat", "qwen-coder", "zeta-instruct", "gpt-x", "llama-3.1-8b", "deepseek-r1", "deepseek-reasoner", "o1-mini", "qwen3-thinking"],
  );
});

test("providers: autoSelect probes in ranked order and uses the first model that answers", async () => {
  const discovered = ["deepseek-reasoner", "gpt-x", "a-chat", "qwen-coder", "default-m", "pref", "o1-mini"];
  const requests = serve(discovered, ["deepseek-reasoner"]);
  const catalog = registry({ default_model: "default-m" });
  const chosen = await catalog.autoSelect("mock", { prefer: "pref" });
  assert.equal(chosen.model, "deepseek-reasoner");
  const order = ["pref", "default-m", "a-chat", "qwen-coder", "gpt-x", "deepseek-reasoner"];
  assert.deepEqual(chosen.probes.map((probe) => probe.model), order);
  assert.deepEqual(chosen.probes.map((probe) => probe.ok), [false, false, false, false, false, true]);
  assert.deepEqual(probedModels(requests()), order, "o1-mini is never probed once a model answered");
});

test("providers: autoSelect caches for 5 minutes, then re-probes; invalidateAuto forces a re-probe", async () => {
  let now = 0;
  const requests = serve(["a-chat", "b-coder"], ["b-coder"]);
  const catalog = registry({}, { clock: () => now });
  assert.equal((await catalog.autoSelect("mock")).model, "b-coder");
  const afterFirst = requests().length;

  now = AUTO_TTL_MS - 1;
  assert.deepEqual(await catalog.autoSelect("mock"), { model: "b-coder", probes: [] });
  assert.equal(requests().length, afterFirst, "a cache hit sends nothing");

  now = AUTO_TTL_MS;
  const expired = await catalog.autoSelect("mock");
  assert.equal(expired.probes.length, 2, "at exactly 5 minutes the cache has expired");
  const afterSecond = requests().length;
  assert.ok(afterSecond > afterFirst);

  catalog.invalidateAuto("mock");
  const invalidated = await catalog.autoSelect("mock");
  assert.equal(invalidated.probes.length, 2);
  assert.ok(requests().length > afterSecond);
});

test("providers: a prefer that differs from the cached choice bypasses the cache", async () => {
  serve(["a-chat", "b-coder"], ["a-chat", "b-coder"]);
  const catalog = registry({}, { clock: () => 0 });
  assert.equal((await catalog.autoSelect("mock")).model, "a-chat");
  const preferred = await catalog.autoSelect("mock", { prefer: "b-coder" });
  assert.equal(preferred.model, "b-coder");
  assert.equal(preferred.probes.length, 1);
  assert.deepEqual(await catalog.autoSelect("mock", { prefer: "b-coder" }), { model: "b-coder", probes: [] });
});

test("providers: autoSelect with no success throws with every probe error", async () => {
  serve(["a-chat", "b-coder"], []);
  await assert.rejects(registry().autoSelect("mock"), (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.match(error.message, /a-chat: .*HTTP 404.*b-coder: .*HTTP 404/);
    return true;
  });
});

test("providers: autoSelect stops at the first 401/403 -- a rejected key fails every model", async () => {
  const requests = serve(["a-chat", "b-coder", "c-model"], [], { status: 401, body: { error: { message: "invalid key" } } });
  await assert.rejects(registry().autoSelect("mock"), RouteError);
  assert.deepEqual(probedModels(requests()), ["a-chat"]);
});

test("providers: autoSelect probes at most max_probes candidates", async () => {
  const requests = serve(["a-chat", "b-coder", "c-model"], []);
  await assert.rejects(registry({}, { max_probes: 2 }).autoSelect("mock"), RouteError);
  assert.deepEqual(probedModels(requests()), ["a-chat", "b-coder"]);
});

test("providers: autoSelect with a missing key names the env var and sends nothing", async () => {
  const requests = serve(["a-chat"], ["a-chat"]);
  await assert.rejects(
    new ProviderRegistry(mockConfig(), { env: {} }).autoSelect("mock"),
    (error: unknown) => error instanceof RouteError && /TEST_API_KEY/.test(error.message),
  );
  assert.equal(requests().length, 0);
});

test("providers: when discovery fails, configured models are still candidates", async () => {
  const requests = serve([], ["listed-in-config"]);
  const inner = handler;
  handler = (request) => (request.method === "GET" ? { status: 404, body: {} } : inner(request));
  const chosen = await registry({ models: ["listed-in-config"] }).autoSelect("mock");
  assert.equal(chosen.model, "listed-in-config");
  assert.deepEqual(probedModels(requests()), ["listed-in-config"]);
  await assert.rejects(registry().autoSelect("mock"), (error: unknown) => error instanceof RouteError && /discovery failed/.test(error.message));
});
