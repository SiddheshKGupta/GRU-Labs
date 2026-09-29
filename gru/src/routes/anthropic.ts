// The Claude route (CDR-002): the one file allowed to touch @anthropic-ai/sdk.
//
// The SDK is loaded lazily with a dynamic import, so GRU starts, runs its
// tests and drives the fixture route on a machine without it. Credentials
// are resolved by the SDK from the operator's environment; this file never
// reads, stores or logs a key.
//
// What the route guarantees to the kernel:
//   - history is append-only: the assistant turn goes back exactly as the
//     API returned it (thinking blocks included), except for the one edit
//     the fallback echo rule requires before the last `fallback` block;
//   - a refused, truncated or otherwise abnormal turn yields no tool calls,
//     so a call the model never finished cannot reach AVL;
//   - next() is atomic: if it throws, history is unchanged and the same
//     input can be retried;
//   - every failure surfaces as a RouteError, retryable only for the SDK's
//     typed rate-limit, server and connection errors.
//
// Honest limits: served_model is whatever the API reports, so a server-side
// fallback is visible only because the API says so. A pause_turn that is
// still paused after three re-sends ends the turn as "other". After a
// refusal or a truncation the history ends in tool_use blocks that were
// never answered, so the conversation cannot usefully continue; the loop is
// expected to stop there. Nothing here has been run against the live API in
// this slice's tests -- they use an injected client.

import type Anthropic from "@anthropic-ai/sdk";
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
  type TurnUsage,
} from "../types.ts";

type AnthropicSdk = typeof import("@anthropic-ai/sdk");

let sdkModule: Promise<AnthropicSdk> | null = null;

/** Load the SDK once, on first use. Exported so tests can build genuine SDK error instances. */
export function loadAnthropicSdk(): Promise<AnthropicSdk> {
  if (sdkModule === null) {
    sdkModule = import("@anthropic-ai/sdk").catch((error: unknown) => {
      sdkModule = null;
      throw error;
    });
  }
  return sdkModule;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

export type AnthropicRequest = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The provider-neutral view of a response content block; everything else is carried through untouched. */
export interface AnthropicBlock {
  readonly type: string;
}

export interface AnthropicResponse {
  readonly content: readonly AnthropicBlock[];
  readonly model: string;
  readonly stop_reason: string | null;
  readonly stop_details?: { readonly category?: string | null; readonly explanation?: string | null } | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number | null;
  };
}

/** The part of the SDK client the route uses. The real client satisfies it; tests inject a fake. */
export interface AnthropicClient {
  readonly beta: { readonly messages: { create(params: AnthropicRequest): PromiseLike<AnthropicResponse> } };
}

export interface AnthropicModelsClient {
  readonly models: { list(): AsyncIterable<{ readonly id: string }> };
}

export interface AnthropicRouteOptions {
  model?: string;
  effort?: AnthropicEffort;
  max_tokens?: number;
  client?: AnthropicClient;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_PAUSE_RESENDS = 3;
const PROBE_PROMPT = "Reply with OK.";
const PROBE_MAX_TOKENS = 8;
const MAX_ERROR_CHARS = 300;

// ---------------------------------------------------------------- errors

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}...` : flat;
}

function describe(error: unknown): string {
  if (error instanceof Error) return short(`${error.name}: ${error.message}`);
  return "non-Error value thrown";
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * Map anything the client threw to a RouteError by the SDK's typed classes,
 * never by message text. An object that is not an SDK error but carries a
 * numeric status (another SDK copy, a test double) is classified by status.
 */
export async function toAnthropicRouteError(error: unknown): Promise<RouteError> {
  if (error instanceof RouteError) return error;
  const message = `anthropic: ${describe(error)}`;
  let sdk: AnthropicSdk | null;
  try {
    sdk = await loadAnthropicSdk();
  } catch {
    sdk = null;
  }
  if (sdk !== null) {
    const A = sdk.default;
    if (error instanceof A.APIConnectionTimeoutError || error instanceof A.APIConnectionError) {
      return new RouteError(message, { retryable: true, status: null });
    }
    if (error instanceof A.RateLimitError || error instanceof A.InternalServerError) {
      return new RouteError(message, { retryable: true, status: error.status });
    }
    if (error instanceof A.APIError) {
      return new RouteError(message, { retryable: false, status: statusOf(error) });
    }
  }
  const status = statusOf(error);
  if (status !== null) return new RouteError(message, { retryable: status === 429 || status >= 500, status });
  return new RouteError(message, { retryable: false, status: null });
}

async function createSdkClient(): Promise<AnthropicClient & AnthropicModelsClient> {
  let sdk: AnthropicSdk;
  try {
    sdk = await loadAnthropicSdk();
  } catch {
    throw new RouteError("anthropic: the Anthropic SDK is not installed (run npm install in gru/)", {
      retryable: false,
      status: null,
    });
  }
  try {
    return new sdk.default();
  } catch (error) {
    throw await toAnthropicRouteError(error);
  }
}

/** Model ids the account can use, via the SDK's auto-paginating models.list(). Sorted, unique. */
export async function listAnthropicModels(client?: AnthropicModelsClient): Promise<string[]> {
  const source = client ?? (await createSdkClient());
  const ids = new Set<string>();
  try {
    for await (const model of source.models.list()) ids.add(model.id);
  } catch (error) {
    throw await toAnthropicRouteError(error);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------- content

function field(block: AnthropicBlock, key: string): unknown {
  return (block as unknown as Record<string, unknown>)[key];
}

function lastFallbackIndex(content: readonly AnthropicBlock[]): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === "fallback") return index;
  }
  return -1;
}

const DROPPED_BEFORE_FALLBACK = new Set(["thinking", "redacted_thinking", "tool_use"]);

/**
 * The assistant content to append to history. Unchanged, unless the turn
 * contains a `fallback` block: then thinking, redacted_thinking and tool_use
 * blocks before the last one are omitted, and so is any server_tool_use
 * there without its matching result. Everything from the boundary on is kept.
 */
export function echoContent(content: readonly AnthropicBlock[]): AnthropicBlock[] {
  const boundary = lastFallbackIndex(content);
  if (boundary < 0) return [...content];
  const answered = new Set<unknown>();
  for (const block of content) {
    const toolUseId = field(block, "tool_use_id");
    if (typeof toolUseId === "string") answered.add(toolUseId);
  }
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (DROPPED_BEFORE_FALLBACK.has(block.type)) return false;
    if (block.type === "server_tool_use") return answered.has(field(block, "id"));
    return true;
  });
}

/** Tool calls come only from tool_use blocks after the last fallback block (or all, if there is none). */
export function extractCalls(content: readonly AnthropicBlock[]): ToolCall[] {
  const boundary = lastFallbackIndex(content);
  const calls: ToolCall[] = [];
  content.forEach((block, index) => {
    if (index <= boundary || block.type !== "tool_use") return;
    const id = field(block, "id");
    const name = field(block, "name");
    calls.push({
      id: typeof id === "string" ? id : "",
      name: typeof name === "string" ? name : "",
      // A copy: the kernel may do what it likes with it without touching history.
      input: structuredClone(field(block, "input")),
    });
  });
  return calls;
}

function textOf(content: readonly AnthropicBlock[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    const text = field(block, "text");
    if (block.type === "text" && typeof text === "string") texts.push(text);
  }
  return texts;
}

// ---------------------------------------------------------------- session

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

type HistoryMessage =
  | { readonly role: "user"; readonly content: string | readonly ToolResultBlock[] }
  | { readonly role: "assistant"; readonly content: readonly AnthropicBlock[] };

interface SessionConfig {
  model: string;
  effort: AnthropicEffort;
  max_tokens: number;
  client: () => Promise<AnthropicClient>;
}

function routeFault(message: string): RouteError {
  return new RouteError(`anthropic: ${message}`, { retryable: false, status: null });
}

class AnthropicSession implements RouteSession {
  readonly #config: SessionConfig;
  readonly #system: string;
  readonly #task: string;
  readonly #tools: AnthropicRequest["tools"];
  readonly #history: HistoryMessage[] = [];
  #started = false;
  #outstanding: string[] = [];

  constructor(config: SessionConfig, input: { system: string; task: string; tools: readonly ToolDefinition[] }) {
    this.#config = config;
    this.#system = input.system;
    this.#task = input.task;
    this.#tools = input.tools.map((tool) => ({ ...structuredClone(tool), strict: true }));
  }

  #pending(input: { results: readonly ToolResult[]; user?: string }): HistoryMessage[] {
    const pending: HistoryMessage[] = [];
    if (!this.#started) {
      if (input.results.length > 0) throw routeFault("tool results were supplied before the first turn");
      pending.push({ role: "user", content: this.#task });
      if (input.user !== undefined) pending.push({ role: "user", content: input.user });
      return pending;
    }
    const ids = input.results.map((result) => result.call_id);
    const expected = new Set(this.#outstanding);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== expected.size ||
      ids.some((id) => !expected.has(id))
    ) {
      throw routeFault(
        `tool results must answer exactly the outstanding calls [${this.#outstanding.join(", ")}]`,
      );
    }
    if (input.results.length > 0) {
      // All results in ONE user message: splitting them teaches the model to stop calling tools in parallel.
      pending.push({
        role: "user",
        content: input.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.call_id,
          content: result.content,
          is_error: !result.ok,
        })),
      });
    }
    if (input.user !== undefined) pending.push({ role: "user", content: input.user });
    if (pending.length === 0) throw routeFault("nothing to send: no tool results and no user message");
    return pending;
  }

  async #send(messages: readonly HistoryMessage[]): Promise<AnthropicResponse> {
    const client = await this.#config.client();
    const request: AnthropicRequest = {
      model: this.#config.model,
      max_tokens: this.#config.max_tokens,
      ...(this.#system === "" ? {} : { system: this.#system }),
      tools: this.#tools,
      messages: messages.slice() as unknown as AnthropicRequest["messages"],
      thinking: { type: "adaptive" },
      output_config: { effort: this.#config.effort },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    };
    try {
      return await client.beta.messages.create(request);
    } catch (error) {
      throw await toAnthropicRouteError(error);
    }
  }

  async next(input: { results: readonly ToolResult[]; user?: string }): Promise<ModelTurn> {
    // Work on a copy; history is committed only when the whole turn succeeds.
    const working: HistoryMessage[] = [...this.#history, ...this.#pending(input)];
    const usage: TurnUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const texts: string[] = [];
    let resends = 0;
    let response: AnthropicResponse;
    for (;;) {
      response = await this.#send(working);
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
      texts.push(...textOf(response.content));
      working.push({ role: "assistant", content: echoContent(response.content) });
      if (response.stop_reason !== "pause_turn" || resends >= MAX_PAUSE_RESENDS) break;
      // The server resumes from the trailing assistant content; no extra user message is added.
      resends += 1;
    }

    let stop: StopKind;
    let calls: ToolCall[] = [];
    let detail: string | null = null;
    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        stop = "end_turn";
        calls = extractCalls(response.content);
        break;
      case "tool_use":
        stop = "tool_use";
        calls = extractCalls(response.content);
        break;
      case "refusal":
        // A refused turn's tool calls never run.
        stop = "refusal";
        detail = `${response.stop_details?.category ?? "unknown"}: ${response.stop_details?.explanation ?? ""}`;
        break;
      case "max_tokens":
        // A tool call cut off by max_tokens is never executed.
        stop = "max_tokens";
        break;
      case "pause_turn":
        stop = "other";
        detail = `pause_turn: still paused after ${MAX_PAUSE_RESENDS} re-sends`;
        break;
      default:
        stop = "other";
        detail = `stop_reason: ${response.stop_reason ?? "null"}`;
    }

    this.#history.push(...working.slice(this.#history.length));
    this.#started = true;
    this.#outstanding = calls.map((call) => call.id);
    return { text: texts.join("\n"), calls, stop, served_model: response.model, usage, detail };
  }
}

// ---------------------------------------------------------------- route

export class AnthropicRoute implements ModelRoute {
  readonly descriptor: RouteDescriptor;
  readonly #config: SessionConfig;
  #client: AnthropicClient | null;

  constructor({ model = "claude-opus-5-5", effort = "high", max_tokens = 16000, client }: AnthropicRouteOptions = {}) {
    if (typeof model !== "string" || model === "") throw routeFault("model must be a non-empty string");
    if (!EFFORTS.includes(effort)) throw routeFault(`effort must be one of ${EFFORTS.join(", ")}`);
    if (!Number.isInteger(max_tokens) || max_tokens < 1) throw routeFault("max_tokens must be a positive integer");
    this.#client = client ?? null;
    this.#config = { model, effort, max_tokens, client: () => this.#getClient() };
    this.descriptor = Object.freeze({
      id: `anthropic/${model}`,
      kind: "anthropic",
      provider: "anthropic",
      model,
      base_url: null,
      credential_ref: "env:ANTHROPIC_API_KEY",
    });
  }

  async #getClient(): Promise<AnthropicClient> {
    if (this.#client === null) this.#client = await createSdkClient();
    return this.#client;
  }

  open(input: { system: string; task: string; tools: readonly ToolDefinition[] }): RouteSession {
    return new AnthropicSession(this.#config, input);
  }

  /** One tiny real request, no tools. Resolves to the served model; throws RouteError. */
  async ping(): Promise<string> {
    const client = await this.#getClient();
    try {
      const response = await client.beta.messages.create({
        model: this.#config.model,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: "user", content: PROBE_PROMPT }],
      });
      return response.model;
    } catch (error) {
      throw await toAnthropicRouteError(error);
    }
  }
}
