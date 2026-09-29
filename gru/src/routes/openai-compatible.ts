// One route for every OpenAI-compatible chat-completions endpoint: OpenAI,
// DeepSeek, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM.
//
// Plug-and-play means the operator names a base URL, a model and the NAME
// of an environment variable; the key itself is read at request time, sent
// only in the Authorization header, and scrubbed from anything this file
// says back (errors, descriptor). Base URLs are normalised because people
// paste the site root, a URL ending in /models, or the full
// /chat/completions endpoint.
//
// What the route guarantees to the kernel:
//   - history is append-only; the assistant message goes back as returned
//     (role, content, tool_calls -- provider extras such as DeepSeek's
//     reasoning_content are not echoed, because those APIs reject them);
//   - unparseable tool arguments become {__invalid_json: raw} so AVL
//     rejects the call instead of this route throwing;
//   - a truncated (length), filtered (content_filter) or unrecognised
//     finish yields no tool calls;
//   - next() is atomic: if it throws, history is unchanged;
//   - 429, >=500, network failures and timeouts are retryable RouteErrors,
//     every other failure is not.
//
// Honest limits: the chat-completions dialect varies. The `ok` flag of a
// tool result cannot be expressed in a `tool` message, so the model sees
// only its content. Some servers report finish_reason "stop" alongside tool
// calls; that is treated as tool_use. Newer OpenAI reasoning models reject
// `max_tokens`, so ping() (used by probes) fails for them. Cached-token
// counts are not mapped (cache_read_input_tokens is always 0).

import type { ToolDefinition } from "../avl/actions.ts";
import {
  RouteError,
  type ModelRoute,
  type ModelTurn,
  type RouteDescriptor,
  type RouteSession,
  type StopKind,
  type ToolCall,
  type ToolResult,
} from "../types.ts";

export type Env = Readonly<Record<string, string | undefined>>;
export type FetchLike = typeof globalThis.fetch;

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_UPSTREAM_CHARS = 200;
const PROBE_PROMPT = "Reply with OK.";
const PROBE_MAX_TOKENS = 8;

function fault(message: string): RouteError {
  return new RouteError(message, { retryable: false, status: null });
}

/**
 * Accepts what people paste: the site root, a trailing "/", the /models
 * listing URL or the /chat/completions endpoint. Returns the API base
 * without a trailing slash. Credentials, query strings and fragments are
 * refused: a key must never live in a URL.
 */
export function normaliseBaseUrl(raw: string): string {
  if (typeof raw !== "string") throw fault("base_url must be a string");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw fault("base_url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fault(`base_url must use http or https, not ${url.protocol.replace(/:$/, "")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw fault("base_url must not contain credentials; name an environment variable in api_key_env");
  }
  if (url.search !== "" || url.hash !== "") throw fault("base_url must not contain a query string or fragment");
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/models"]) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (path === "") path = "/v1";
  return `${url.origin}${path}`;
}

// ---------------------------------------------------------------- transport

interface Endpoint {
  provider: string;
  base_url: string;
  api_key_env: string | null;
  headers: Readonly<Record<string, string>>;
  env: Env;
  fetch: FetchLike;
  timeout_ms: number;
}

function scrub(text: string, key: string | null): string {
  return key === null || key === "" ? text : text.split(key).join("[REDACTED]");
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_UPSTREAM_CHARS ? `${flat.slice(0, MAX_UPSTREAM_CHARS)}...` : flat;
}

function readKey(endpoint: Endpoint): string | null {
  if (endpoint.api_key_env === null) return null;
  const key = endpoint.env[endpoint.api_key_env];
  if (key === undefined || key === "") {
    throw fault(
      `${endpoint.provider}: missing credential: environment variable ${endpoint.api_key_env} is not set`,
    );
  }
  return key;
}

function upstreamMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as { error?: unknown; message?: unknown }).error;
      if (typeof error === "string") return error;
      if (typeof error === "object" && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body;
}

/** One HTTP exchange. Returns the parsed JSON body of a 2xx response; everything else is a RouteError. */
async function exchange(endpoint: Endpoint, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const key = readKey(endpoint);
  const headers = new Headers();
  for (const [name, value] of Object.entries(endpoint.headers)) headers.set(name, value);
  headers.set("Accept", "application/json");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (key !== null) headers.set("Authorization", `Bearer ${key}`);

  const where = endpoint.provider;
  let response: Response;
  let text: string;
  try {
    response = await endpoint.fetch(`${endpoint.base_url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(endpoint.timeout_ms),
    });
    text = await response.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RouteError(`${where}: request timed out after ${endpoint.timeout_ms} ms`, {
        retryable: true,
        status: null,
      });
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
    const causeCode: unknown = cause === null ? undefined : (cause as { code?: unknown }).code;
    const code = typeof causeCode === "string" ? causeCode : (cause?.name ?? name);
    throw new RouteError(scrub(`${where}: network error (${code || "unknown"})`, key), {
      retryable: true,
      status: null,
    });
  }

  if (!response.ok) {
    const status = response.status;
    const upstream = short(scrub(upstreamMessage(text), key));
    throw new RouteError(scrub(`${where}: HTTP ${status}${upstream === "" ? "" : `: ${upstream}`}`, key), {
      retryable: status === 429 || status >= 500,
      status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteError(`${where}: HTTP ${response.status} with a body that is not JSON`, {
      retryable: false,
      status: response.status,
    });
  }
}

/** GET {base}/models: data[].id, or models[].id / models[].name. Sorted, unique. */
export async function listOpenAICompatibleModels(options: {
  provider: string;
  base_url: string;
  api_key_env?: string | null;
  headers?: Readonly<Record<string, string>>;
  env?: Env;
  fetch?: FetchLike;
  timeout_ms?: number;
}): Promise<string[]> {
  const endpoint: Endpoint = {
    provider: options.provider,
    base_url: normaliseBaseUrl(options.base_url),
    api_key_env: options.api_key_env ?? null,
    headers: options.headers ?? {},
    env: options.env ?? process.env,
    fetch: options.fetch ?? globalThis.fetch,
    timeout_ms: options.timeout_ms ?? 30_000,
  };
  const body = await exchange(endpoint, "GET", "/models");
  const ids = new Set<string>();
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
  if (entries === null) throw fault(`${options.provider}: /models returned no data[] or models[] list`);
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id === "string" && id !== "") ids.add(id);
    else if (typeof name === "string" && name !== "") ids.add(name);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------- session

interface ChatToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: unknown; readonly tool_calls?: readonly unknown[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

function parseArguments(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null) return structuredClone(raw);
  if (typeof raw !== "string") return { __invalid_json: raw === undefined ? null : raw };
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __invalid_json: raw };
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

class OpenAICompatibleSession implements RouteSession {
  readonly #endpoint: Endpoint;
  readonly #model: string;
  readonly #task: string;
  readonly #tools: unknown[];
  readonly #history: ChatMessage[];
  #started = false;
  #turn = 0;
  #outstanding: string[] = [];

  constructor(endpoint: Endpoint, model: string, input: { system: string; task: string; tools: readonly ToolDefinition[] }) {
    this.#endpoint = endpoint;
    this.#model = model;
    this.#task = input.task;
    this.#tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.input_schema) },
    }));
    this.#history = [{ role: "system", content: input.system }];
  }

  #pending(input: { results: readonly ToolResult[]; user?: string }): ChatMessage[] {
    const provider = this.#endpoint.provider;
    const pending: ChatMessage[] = [];
    if (!this.#started) {
      if (input.results.length > 0) throw fault(`${provider}: tool results were supplied before the first turn`);
      pending.push({ role: "user", content: this.#task });
      if (input.user !== undefined) pending.push({ role: "user", content: input.user });
      return pending;
    }
    const ids = input.results.map((result) => result.call_id);
    const expected = new Set(this.#outstanding);
    if (new Set(ids).size !== ids.length || ids.length !== expected.size || ids.some((id) => !expected.has(id))) {
      throw fault(`${provider}: tool results must answer exactly the outstanding calls [${this.#outstanding.join(", ")}]`);
    }
    for (const result of input.results) {
      pending.push({ role: "tool", tool_call_id: result.call_id, content: result.content });
    }
    if (input.user !== undefined) pending.push({ role: "user", content: input.user });
    if (pending.length === 0) throw fault(`${provider}: nothing to send: no tool results and no user message`);
    return pending;
  }

  async next(input: { results: readonly ToolResult[]; user?: string }): Promise<ModelTurn> {
    const provider = this.#endpoint.provider;
    const messages = [...this.#history, ...this.#pending(input)];
    const request: Record<string, unknown> = { model: this.#model, messages };
    if (this.#tools.length > 0) {
      request.tools = this.#tools;
      request.tool_choice = "auto";
    }
    const body = await exchange(this.#endpoint, "POST", "/chat/completions", request);

    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const choice = Array.isArray(record.choices) ? (record.choices[0] as Record<string, unknown> | undefined) : undefined;
    const message = choice !== undefined && typeof choice.message === "object" && choice.message !== null
      ? (choice.message as Record<string, unknown>)
      : null;
    if (message === null) throw fault(`${provider}: response has no choices[0].message`);

    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
    const turn = this.#turn;
    const parsed: ToolCall[] = [];
    rawCalls.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null) return;
      const call = raw as ChatToolCall;
      if (call.type !== undefined && call.type !== "function") return;
      const name = call.function?.name;
      parsed.push({
        id: typeof call.id === "string" && call.id !== "" ? call.id : `${provider}-call-${turn}-${index}`,
        name: typeof name === "string" ? name : "",
        input: parseArguments(call.function?.arguments),
      });
    });

    const finish = choice?.finish_reason;
    let stop: StopKind;
    let calls: ToolCall[] = [];
    let detail: string | null = null;
    if (finish === "tool_calls" || (finish === "stop" && parsed.length > 0)) {
      stop = "tool_use";
      calls = parsed;
    } else if (finish === "stop") {
      stop = "end_turn";
    } else if (finish === "length") {
      // A tool call cut off by the token limit is never executed.
      stop = "max_tokens";
    } else if (finish === "content_filter") {
      stop = "refusal";
      detail = "content_filter";
    } else {
      stop = "other";
      detail = `finish_reason: ${typeof finish === "string" ? finish : "null"}`;
    }

    // Append the assistant message as returned: role, content, tool_calls. Nothing earlier is touched.
    const assistant: ChatMessage = rawCalls.length > 0
      ? { role: "assistant", content: message.content ?? null, tool_calls: rawCalls }
      : { role: "assistant", content: message.content ?? null };
    this.#history.push(...messages.slice(this.#history.length), assistant);
    this.#started = true;
    this.#turn += 1;
    this.#outstanding = calls.map((call) => call.id);

    const usage = typeof record.usage === "object" && record.usage !== null
      ? (record.usage as Record<string, unknown>)
      : {};
    return {
      text: typeof message.content === "string" ? message.content : "",
      calls,
      stop,
      served_model: typeof record.model === "string" && record.model !== "" ? record.model : this.#model,
      usage: {
        input_tokens: count(usage.prompt_tokens),
        output_tokens: count(usage.completion_tokens),
        cache_read_input_tokens: 0,
      },
      detail,
    };
  }
}

// ---------------------------------------------------------------- route

export interface OpenAICompatibleOptions {
  provider: string;
  base_url: string;
  model: string;
  api_key_env?: string | null;
  headers?: Readonly<Record<string, string>>;
  env?: Env;
  fetch?: FetchLike;
  timeout_ms?: number;
}

export class OpenAICompatibleRoute implements ModelRoute {
  readonly descriptor: RouteDescriptor;
  readonly #endpoint: Endpoint;
  readonly #model: string;

  constructor({
    provider,
    base_url,
    model,
    api_key_env = null,
    headers = {},
    env = process.env,
    fetch = globalThis.fetch,
    timeout_ms = 120_000,
  }: OpenAICompatibleOptions) {
    if (typeof provider !== "string" || provider === "") throw fault("provider must be a non-empty string");
    if (typeof model !== "string" || model === "") throw fault(`${provider}: model must be a non-empty string`);
    if (api_key_env !== null && !ENV_NAME.test(api_key_env)) {
      // Never echo the value: it may be a pasted key.
      throw fault(`${provider}: api_key_env must be an environment variable name like OPENAI_API_KEY`);
    }
    if (!Number.isInteger(timeout_ms) || timeout_ms < 1) throw fault(`${provider}: timeout_ms must be a positive integer`);
    const base = normaliseBaseUrl(base_url);
    this.#endpoint = { provider, base_url: base, api_key_env, headers: { ...headers }, env, fetch, timeout_ms };
    this.#model = model;
    this.descriptor = Object.freeze({
      id: `${provider}/${model}`,
      kind: "openai-compatible",
      provider,
      model,
      base_url: base,
      credential_ref: api_key_env === null ? null : `env:${api_key_env}`,
    });
  }

  open(input: { system: string; task: string; tools: readonly ToolDefinition[] }): RouteSession {
    return new OpenAICompatibleSession(this.#endpoint, this.#model, input);
  }

  /** One tiny real request, no tools. Resolves to the served model; throws RouteError. */
  async ping(): Promise<string> {
    const body = await exchange(this.#endpoint, "POST", "/chat/completions", {
      model: this.#model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_TOKENS,
    });
    const model = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : undefined;
    return typeof model === "string" && model !== "" ? model : this.#model;
  }
}
