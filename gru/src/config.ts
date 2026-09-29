// gru.config.json: which model providers exist, the default route, the
// default Director channel and where ledgers live.
//
// Search order, first file found wins (no merging): --config, then
// <cwd>/gru.config.json, then ~/.config/gru/config.json; none -> defaults.
// Validation is strict about the keys this module owns and shallow about
// providers, whose shape the provider catalog validates.
//
// A config file is a place credentials leak from, so any string that looks
// like an API key (a value starting "sk-", or an sk- token inside a value
// such as "Bearer sk-...") is refused with the location of the offending
// value, never the value. Keys belong in environment variables named by
// api_key_env. The detector only knows the sk- shape; a key in another
// format is not caught.
//
// Limit: <cwd>/gru.config.json lives in whatever directory gru starts in,
// which may be a workspace a Minion can write. The REPL protects that file
// in its ad-hoc contracts; a `gru run` contract has to protect it itself.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProviderConfig } from "./types.ts";

export interface GruConfig {
  /** Validated shallowly here (array of objects); the catalog validates each entry. */
  providers: ProviderConfig[];
  /** "provider/model" or "provider"; null means a route must be chosen explicitly. */
  route: string | null;
  director: "interactive" | "deny";
  state_dir: string;
}

export interface LoadedConfig {
  config: GruConfig;
  /** The file the config came from, or null when defaults were used. */
  source: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const KNOWN_KEYS = ["providers", "route", "director", "state_dir"] as const;

export function homeDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : homedir();
}

/** "~" and "~/x" expand to the home directory; "~user" is not supported and is left alone. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function defaultConfig(env: Readonly<Record<string, string | undefined>>): GruConfig {
  return { providers: [], route: null, director: "interactive", state_dir: join(homeDirectory(env), ".gru", "state") };
}

const KEY_LIKE = /(^sk-)|(\bsk-[A-Za-z0-9_-]{16,})/;

function findKeyLike(value: unknown, at: string): string | null {
  if (typeof value === "string") return KEY_LIKE.test(value) ? at : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findKeyLike(value[index], `${at}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (KEY_LIKE.test(key)) return `${at} (a key name)`;
      const found = findKeyLike(inner, `${at}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * JSON.parse messages can quote the source text around the error, which
 * would print a pasted key. Keep only the position.
 */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const where = /position \d+(?: \(line \d+ column \d+\))?/.exec(message)?.[0];
    throw new ConfigError(`${path}: not valid JSON${where === undefined ? "" : ` (${where})`}`);
  }
}

export function validateConfig(json: unknown, path: string, env: Readonly<Record<string, string | undefined>>): GruConfig {
  const keyAt = findKeyLike(json, "$");
  if (keyAt !== null) {
    throw new ConfigError(
      `${path}: the value at ${keyAt} looks like an API key. Keys belong in environment variables: ` +
        `name the variable in the provider's "api_key_env" and remove the key from this file.`,
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigError(`${path}: the config must be a JSON object`);
  }
  const record = json as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${path}: unknown key "${key}" (known keys: ${KNOWN_KEYS.join(", ")})`);
    }
  }
  const config = defaultConfig(env);
  const home = homeDirectory(env);

  if (record.providers !== undefined) {
    if (!Array.isArray(record.providers)) throw new ConfigError(`${path}: "providers" must be an array`);
    record.providers.forEach((provider, index) => {
      if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
        throw new ConfigError(`${path}: providers[${index}] must be an object`);
      }
    });
    config.providers = record.providers as ProviderConfig[];
  }
  if (record.route !== undefined && record.route !== null) {
    if (typeof record.route !== "string" || record.route.trim() === "") {
      throw new ConfigError(`${path}: "route" must be a non-empty string such as "anthropic/claude-sonnet-4-5", or null`);
    }
    config.route = record.route;
  }
  if (record.director !== undefined) {
    if (record.director !== "interactive" && record.director !== "deny") {
      throw new ConfigError(`${path}: "director" must be "interactive" or "deny"`);
    }
    config.director = record.director;
  }
  if (record.state_dir !== undefined) {
    if (typeof record.state_dir !== "string" || record.state_dir === "") {
      throw new ConfigError(`${path}: "state_dir" must be a non-empty string`);
    }
    const expanded = expandHome(record.state_dir, home);
    // A relative state_dir is relative to the file that declares it, not to wherever gru was started.
    config.state_dir = isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
  }
  return config;
}

export function loadConfig(options: {
  cwd: string;
  explicitPath?: string | null;
  env: Readonly<Record<string, string | undefined>>;
}): LoadedConfig {
  const home = homeDirectory(options.env);
  let source: string | null = null;
  if (options.explicitPath !== undefined && options.explicitPath !== null) {
    const explicit = resolve(options.cwd, expandHome(options.explicitPath, home));
    if (!isFile(explicit)) throw new ConfigError(`config file not found: ${explicit}`);
    source = explicit;
  } else {
    const candidates = [join(options.cwd, "gru.config.json"), join(home, ".config", "gru", "config.json")];
    source = candidates.find(isFile) ?? null;
  }
  if (source === null) return { config: defaultConfig(options.env), source: null };

  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    throw new ConfigError(`${source}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  return { config: validateConfig(parseJson(text, source), source, options.env), source };
}
