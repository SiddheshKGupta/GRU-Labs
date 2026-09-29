// The provider catalogue: presets, operator configuration, discovery, live
// probes and automatic model selection.
//
// A provider's model list is a claim; a model that answers a real request
// is evidence. So discovery only proposes candidates, and autoSelect trusts
// the first candidate that answers a tiny live probe, ranked so general
// coding and chat models are tried before slow reasoning models. The choice
// is cached for five minutes and dropped as soon as the loop reports a
// route failure (invalidateAuto).
//
// Keys are referenced by environment-variable name and never stored:
// parseProviders refuses anything that looks like a pasted key, in
// api_key_env or in a credential-bearing header, and never echoes it.
//
// Honest limits: a probe proves the endpoint answered once, not that the
// model can drive tools well. Each probe is a real, billed request, so
// autoSelect stops after max_probes candidates (default 10) and after the
// first 401/403, since a rejected key fails every model alike. The
// anthropic credential status sees only ANTHROPIC_API_KEY and
// ANTHROPIC_AUTH_TOKEN in the given environment; the SDK can also use a
// stored `ant auth login` profile, so MISSING there may be a false alarm.
// invalidateAuto is not on the ProviderCatalog interface yet.

import { AnthropicRoute, listAnthropicModels, type AnthropicClient, type AnthropicModelsClient } from "./anthropic.ts";
import {
  ENV_NAME,
  listOpenAICompatibleModels,
  normaliseBaseUrl,
  OpenAICompatibleRoute,
  type Env,
  type FetchLike,
} from "./openai-compatible.ts";
import {
  RouteError,
  type CredentialStatus,
  type ModelRoute,
  type ProbeResult,
  type ProviderCatalog,
  type ProviderConfig,
} from "../types.ts";

export class ProviderConfigError extends RouteError {
  override name = "ProviderConfigError";
  constructor(message: string) {
    super(message, { retryable: false, status: null });
  }
}

function preset(
  id: string,
  kind: ProviderConfig["kind"],
  base_url: string | null,
  api_key_env: string | null,
  default_model: string | null = null,
): ProviderConfig {
  const config: ProviderConfig = { id, kind, base_url, api_key_env, default_model, models: [], headers: {} };
  Object.freeze(config.models);
  Object.freeze(config.headers);
  return Object.freeze(config);
}

export const PRESETS: readonly ProviderConfig[] = Object.freeze([
  preset("anthropic", "anthropic", null, "ANTHROPIC_API_KEY", "claude-opus-5-5"),
  preset("openai", "openai-compatible", "https://api.openai.com/v1", "OPENAI_API_KEY"),
  preset("deepseek", "openai-compatible", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
  preset("openrouter", "openai-compatible", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
  preset("groq", "openai-compatible", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
  preset("ollama", "openai-compatible", "http://127.0.0.1:11434/v1", null),
  preset("lmstudio", "openai-compatible", "http://127.0.0.1:1234/v1", null),
]);

// ---------------------------------------------------------------- parsing

const KEYS = ["id", "kind", "base_url", "api_key_env", "default_model", "models", "headers"] as const;
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_PREFIX = /^(sk-|sk_|gsk_|xai-|pk-|rk-|bearer\s)/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeKey(value: string): boolean {
  return KEY_PREFIX.test(value) || (value.length >= 20 && /[a-z]/.test(value) && /[0-9]/.test(value));
}

function copyConfig(config: ProviderConfig): ProviderConfig {
  return { ...config, models: [...config.models], headers: { ...config.headers } };
}

function parseEntry(raw: unknown, at: string): ProviderConfig {
  if (!isRecord(raw)) throw new ProviderConfigError(`${at}: must be an object`);
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new ProviderConfigError(`${at}: unknown key "${key}"`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !ID.test(id)) {
    throw new ProviderConfigError(`${at}.id: must match ${ID}`);
  }
  const where = `provider "${id}"`;
  const base = PRESETS.find((candidate) => candidate.id === id);
  const kind = raw.kind;
  if (base === undefined && kind === undefined) {
    throw new ProviderConfigError(`${where}: kind is required for a provider that is not a preset`);
  }
  // Presets are overridden field by field: only keys present in the entry change.
  const merged: ProviderConfig = base !== undefined
    ? copyConfig(base)
    : { id, kind: "openai-compatible", base_url: null, api_key_env: null, default_model: null, models: [], headers: {} };

  if (kind !== undefined) {
    if (kind !== "anthropic" && kind !== "openai-compatible") {
      throw new ProviderConfigError(`${where}: kind must be "anthropic" or "openai-compatible"`);
    }
    merged.kind = kind;
  }
  const baseUrl = raw.base_url;
  if (baseUrl !== undefined) {
    if (baseUrl !== null && typeof baseUrl !== "string") {
      throw new ProviderConfigError(`${where}: base_url must be a string or null`);
    }
    merged.base_url = baseUrl;
  }
  const keyEnv = raw.api_key_env;
  if (keyEnv !== undefined) {
    if (keyEnv !== null) {
      if (typeof keyEnv !== "string") throw new ProviderConfigError(`${where}: api_key_env must be a string or null`);
      if (!ENV_NAME.test(keyEnv)) {
        // Never echo the value: it may be a secret.
        throw new ProviderConfigError(
          looksLikeKey(keyEnv)
            ? `${where}: api_key_env looks like a literal API key. Keys are never stored in configuration: ` +
                `export the key in an environment variable and put that variable's NAME here (e.g. OPENAI_API_KEY)`
            : `${where}: api_key_env must be an environment variable name matching ${ENV_NAME}`,
        );
      }
    }
    merged.api_key_env = keyEnv;
  }
  const defaultModel = raw.default_model;
  if (defaultModel !== undefined) {
    if (defaultModel !== null && (typeof defaultModel !== "string" || defaultModel === "")) {
      throw new ProviderConfigError(`${where}: default_model must be a non-empty string or null`);
    }
    merged.default_model = defaultModel;
  }
  const models = raw.models;
  if (models !== undefined) {
    if (!Array.isArray(models) || models.some((model: unknown) => typeof model !== "string" || model === "")) {
      throw new ProviderConfigError(`${where}: models must be an array of non-empty strings`);
    }
    merged.models = [...new Set(models as string[])];
  }
  const rawHeaders = raw.headers;
  if (rawHeaders !== undefined) {
    if (!isRecord(rawHeaders)) throw new ProviderConfigError(`${where}: headers must be an object`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (!HEADER_NAME.test(name)) throw new ProviderConfigError(`${where}: header name "${name}" is not valid`);
      if (typeof value !== "string") throw new ProviderConfigError(`${where}: header "${name}" must be a string`);
      if (CREDENTIAL_HEADERS.has(name.toLowerCase()) || KEY_PREFIX.test(value)) {
        throw new ProviderConfigError(
          `${where}: header "${name}" would store a credential in configuration; ` +
            `name an environment variable in api_key_env instead`,
        );
      }
      headers[name] = value;
    }
    merged.headers = headers;
  }

  if (merged.kind === "openai-compatible") {
    if (merged.base_url === null) throw new ProviderConfigError(`${where}: base_url is required for kind openai-compatible`);
    try {
      merged.base_url = normaliseBaseUrl(merged.base_url);
    } catch (error) {
      throw new ProviderConfigError(`${where}: ${error instanceof Error ? error.message : "invalid base_url"}`);
    }
  } else {
    // The SDK resolves the Anthropic endpoint and credential itself; a setting it would ignore is refused.
    if (merged.base_url !== null) {
      throw new ProviderConfigError(`${where}: base_url must be null for kind anthropic (the SDK reads ANTHROPIC_BASE_URL)`);
    }
    if (merged.api_key_env !== "ANTHROPIC_API_KEY") {
      throw new ProviderConfigError(`${where}: api_key_env must be ANTHROPIC_API_KEY for kind anthropic (the SDK reads it)`);
    }
  }
  return merged;
}

/**
 * Validate the `providers` array of gru.config.json. Entries whose id is a
 * preset override that preset field by field; other ids define new
 * providers. Returns complete, independent configs.
 */
export function parseProviders(json: unknown): ProviderConfig[] {
  if (!Array.isArray(json)) throw new ProviderConfigError("providers: must be an array");
  const seen = new Set<string>();
  return json.map((raw: unknown, index: number) => {
    const config = parseEntry(raw, `providers[${index}]`);
    if (seen.has(config.id)) throw new ProviderConfigError(`providers: duplicate id "${config.id}"`);
    seen.add(config.id);
    return config;
  });
}

// ---------------------------------------------------------------- ranking

const REASONING = /(^|[^a-z0-9])(o1|o3|r1)([^a-z0-9]|$)|reason|thinking/i;
const GENERAL = /coder|code|chat|instruct/i;

/**
 * Order candidates for probing: prefer, then default_model, then
 * coder/code/chat/instruct names, then the rest, reasoning-style names
 * last. Ties break by name, so the order is deterministic.
 */
export function rankModels(
  models: readonly string[],
  hints: { prefer?: string | null; default_model?: string | null } = {},
): string[] {
  const rank = (model: string): number => {
    if (hints.prefer !== undefined && hints.prefer !== null && model === hints.prefer) return 0;
    if (hints.default_model !== undefined && hints.default_model !== null && model === hints.default_model) return 1;
    if (REASONING.test(model)) return 4;
    if (GENERAL.test(model)) return 2;
    return 3;
  };
  return [...new Set(models)]
    .filter((model) => model !== "")
    .map((model) => ({ model, rank: rank(model) }))
    .sort((a, b) => a.rank - b.rank || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    .map((entry) => entry.model);
}

// ---------------------------------------------------------------- registry

export const AUTO_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_PROBES = 10;

export interface ProviderRegistryOptions {
  env?: Env;
  fetch?: FetchLike;
  clock?: () => number;
  anthropicClient?: AnthropicClient & AnthropicModelsClient;
  max_probes?: number;
}

type ProbeableRoute = ModelRoute & { ping(): Promise<string> };

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

export class ProviderRegistry implements ProviderCatalog {
  readonly #configs = new Map<string, ProviderConfig>();
  readonly #env: Env;
  readonly #fetch: FetchLike | undefined;
  readonly #clock: () => number;
  readonly #anthropicClient: (AnthropicClient & AnthropicModelsClient) | undefined;
  readonly #maxProbes: number;
  readonly #auto = new Map<string, { model: string; at: number }>();

  constructor(configs: readonly ProviderConfig[] = [], options: ProviderRegistryOptions = {}) {
    for (const config of PRESETS) this.#configs.set(config.id, copyConfig(config));
    // Map.set on an existing id keeps its position: presets stay first, new ids follow in order.
    for (const config of parseProviders(configs)) this.#configs.set(config.id, config);
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#anthropicClient = options.anthropicClient;
    const maxProbes = options.max_probes ?? DEFAULT_MAX_PROBES;
    if (!Number.isInteger(maxProbes) || maxProbes < 1) throw new ProviderConfigError("max_probes must be a positive integer");
    this.#maxProbes = maxProbes;
  }

  #credential(config: ProviderConfig): CredentialStatus {
    if (config.api_key_env === null) return "NOT_REQUIRED";
    const present = (name: string): boolean => {
      const value = this.#env[name];
      return value !== undefined && value !== "";
    };
    if (present(config.api_key_env)) return "CONFIGURED";
    if (config.kind === "anthropic" && present("ANTHROPIC_AUTH_TOKEN")) return "CONFIGURED";
    return "MISSING";
  }

  #config(id: string): ProviderConfig {
    const config = this.#configs.get(id);
    if (config === undefined) {
      throw new RouteError(`unknown provider "${id}"; known providers: ${[...this.#configs.keys()].join(", ")}`, {
        retryable: false,
        status: null,
      });
    }
    return config;
  }

  #build(config: ProviderConfig, model: string): ProbeableRoute {
    if (config.kind === "anthropic") {
      return new AnthropicRoute({ model, ...(this.#anthropicClient ? { client: this.#anthropicClient } : {}) });
    }
    return new OpenAICompatibleRoute({
      provider: config.id,
      base_url: config.base_url ?? "",
      model,
      api_key_env: config.api_key_env,
      headers: config.headers,
      env: this.#env,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  list(): { config: ProviderConfig; credential: CredentialStatus }[] {
    return [...this.#configs.values()].map((config) => ({ config: copyConfig(config), credential: this.#credential(config) }));
  }

  route(spec: string): ModelRoute {
    if (typeof spec !== "string" || spec.trim() === "") {
      throw new RouteError('route spec must be "provider/model" or "provider"', { retryable: false, status: null });
    }
    const slash = spec.indexOf("/");
    const id = slash < 0 ? spec : spec.slice(0, slash);
    const config = this.#config(id);
    // Only the first "/" separates provider from model: "openrouter/meta-llama/llama-3.1-8b" is valid.
    const model = slash < 0 ? config.default_model : spec.slice(slash + 1);
    if (model === null || model === "") {
      throw new RouteError(
        `provider "${id}" has no default model; name one as "${id}/<model>" (run \`gru models ${id}\` to list them)`,
        { retryable: false, status: null },
      );
    }
    return this.#build(config, model);
  }

  async discover(providerId: string): Promise<string[]> {
    const config = this.#config(providerId);
    if (config.kind === "anthropic") return listAnthropicModels(this.#anthropicClient);
    return listOpenAICompatibleModels({
      provider: config.id,
      base_url: config.base_url ?? "",
      api_key_env: config.api_key_env,
      headers: config.headers,
      env: this.#env,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  async #probe(config: ProviderConfig, model: string): Promise<{ result: ProbeResult; fatal: boolean }> {
    const started = this.#clock();
    try {
      await this.#build(config, model).ping();
      return {
        result: { provider: config.id, model, ok: true, latency_ms: this.#clock() - started, error: null },
        fatal: false,
      };
    } catch (error) {
      const status = error instanceof RouteError ? error.status : null;
      return {
        result: {
          provider: config.id,
          model,
          ok: false,
          latency_ms: null,
          error: short(error instanceof Error ? error.message : "probe failed"),
        },
        fatal: status === 401 || status === 403,
      };
    }
  }

  async probe(providerId: string, model: string): Promise<ProbeResult> {
    return (await this.#probe(this.#config(providerId), model)).result;
  }

  async autoSelect(providerId: string, options: { prefer?: string } = {}): Promise<{ model: string; probes: ProbeResult[] }> {
    const config = this.#config(providerId);
    const prefer = options.prefer;
    const cached = this.#auto.get(providerId);
    if (
      cached !== undefined &&
      this.#clock() - cached.at < AUTO_TTL_MS &&
      (prefer === undefined || prefer === cached.model)
    ) {
      return { model: cached.model, probes: [] };
    }
    if (config.kind === "openai-compatible" && this.#credential(config) === "MISSING") {
      throw new RouteError(
        `${providerId}: missing credential: environment variable ${config.api_key_env} is not set`,
        { retryable: false, status: null },
      );
    }

    let discovered: string[] = [];
    let discoveryError: string | null = null;
    try {
      discovered = await this.discover(providerId);
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : "discovery failed";
    }
    const pool = [...discovered, ...config.models];
    if (config.default_model !== null) pool.push(config.default_model);
    if (prefer !== undefined && prefer !== "") pool.push(prefer);
    const candidates = rankModels(pool, { prefer: prefer ?? null, default_model: config.default_model });
    if (candidates.length === 0) {
      throw new RouteError(
        `${providerId}: no candidate models${discoveryError === null ? "" : ` (discovery failed: ${discoveryError})`}`,
        { retryable: false, status: null },
      );
    }

    const probes: ProbeResult[] = [];
    for (const model of candidates.slice(0, this.#maxProbes)) {
      const { result, fatal } = await this.#probe(config, model);
      probes.push(result);
      if (result.ok) {
        this.#auto.set(providerId, { model, at: this.#clock() });
        return { model, probes };
      }
      if (fatal) break;
    }
    throw new RouteError(
      `${providerId}: no model answered a probe: ${probes.map((probe) => `${probe.model}: ${probe.error}`).join("; ")}`,
      { retryable: false, status: null },
    );
  }

  /** Forget the auto-selected model, e.g. after the loop saw a RouteError from it. */
  invalidateAuto(providerId: string): void {
    this.#auto.delete(providerId);
  }
}
