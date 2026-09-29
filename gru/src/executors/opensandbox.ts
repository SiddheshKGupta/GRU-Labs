// OpenSandbox isolation backend (CDR-007): each command or check runs in a
// fresh sandbox (container or microVM) created through an OpenSandbox
// server, with egress denied, and is torn down afterwards.
//
// Written against the public OpenAPI contracts (specs/sandbox-lifecycle.yml
// and specs/execd-api.yaml at 3738975) rather than the SDK, so the kernel
// stays dependency-free. Commands use execd's native argv mode: no shell.
//
// QUARANTINED: this client has only run against a fake server built from
// those contracts. It provides no threat-model property until the Director
// admits it after a live smoke test (`admit`), per Nefario readiness.
//
// The workspace is uploaded, not mounted: whatever the command writes stays
// in the sandbox and is discarded, which is what a check should do. The
// OpenSandbox API key stays in GRU's process; the sandbox never sees it.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessOutcome } from "../types.ts";
import type { IsolatedRunOptions, IsolationBackend } from "./isolation.ts";

export const EXECD_PORT = 44772;
const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export interface OpenSandboxOptions {
  /** Lifecycle API base, e.g. http://localhost:8080/v1 */
  url: string;
  /** Image the sandbox runs, e.g. node:22 */
  image: string;
  /** Environment variable holding the API key; read at run time, never logged. */
  apiKeyEnv?: string;
  /** Properties the Director admits after a live smoke test; empty until then. */
  admit?: readonly string[];
  readyTimeoutMs?: number;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface SandboxEndpoint {
  base: string;
  headers: Record<string, string>;
}

function workspaceFiles(root: string): { path: string; data: Buffer }[] {
  const files: { path: string; data: Buffer }[] = [];
  let total = 0;
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const rel = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(join(root, rel));
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(rel);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > UPLOAD_LIMIT_BYTES) throw new Error(`workspace exceeds ${UPLOAD_LIMIT_BYTES} bytes; not uploading`);
        files.push({ path: rel, data: readFileSync(join(root, rel)) });
      }
      // Symlinks and special files are not uploaded: they could point outside the workspace.
    }
  };
  walk("");
  return files;
}

/** execd streams events as SSE or as bare JSON lines; accept both. */
export function parseEventStream(text: string): { type: string; text?: string; [key: string]: unknown }[] {
  const events: { type: string; text?: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
    if (line === "" || !line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (typeof event.type === "string") events.push(event as { type: string });
    } catch {
      // A partial or non-JSON line is not an event.
    }
  }
  return events;
}

export class OpenSandboxIsolation implements IsolationBackend {
  readonly id = "opensandbox";
  readonly provides: readonly string[];
  readonly limits: readonly string[];
  readonly #options: OpenSandboxOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OpenSandboxOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.provides = [...(options.admit ?? [])];
    this.limits = [
      ...(this.provides.length === 0 ? ["quarantined: not admitted after a live smoke test, so it provides nothing"] : []),
      "the workspace is uploaded, not mounted: command writes are discarded with the sandbox",
      "node_modules and .git are not uploaded; symlinks are skipped",
    ];
  }

  covers(argv: readonly string[]): boolean {
    return argv.length > 0;
  }

  #lifecycleHeaders(): Record<string, string> {
    const name = this.#options.apiKeyEnv ?? "OPEN_SANDBOX_API_KEY";
    const key = (this.#options.env ?? process.env)[name];
    return { "content-type": "application/json", ...(key ? { "OPEN-SANDBOX-API-KEY": key } : {}) };
  }

  async #json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  }

  async #create(timeoutMs: number): Promise<string> {
    const body = {
      image: { uri: this.#options.image },
      entrypoint: ["sleep", "infinity"],
      timeout: Math.max(60, Math.ceil(timeoutMs / 1000) + 60),
      resourceLimits: { cpu: "1", memory: "1Gi" },
      networkPolicy: { defaultAction: "deny", egress: [] },
      metadata: { created_by: "gru" },
    };
    const created = await this.#json(`${this.#options.url}/sandboxes`, { method: "POST", headers: this.#lifecycleHeaders(), body: JSON.stringify(body) });
    if (typeof created.id !== "string") throw new Error("OpenSandbox returned no sandbox id");
    return created.id;
  }

  async #waitRunning(id: string): Promise<void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 120_000);
    for (;;) {
      const sandbox = await this.#json(`${this.#options.url}/sandboxes/${encodeURIComponent(id)}`, { method: "GET", headers: this.#lifecycleHeaders() });
      const state = (sandbox.status as { state?: unknown } | undefined)?.state;
      if (state === "Running") return;
      if (state === "Failed" || state === "Terminated") throw new Error(`sandbox ${id} is ${String(state)}`);
      if (Date.now() > deadline) throw new Error(`sandbox ${id} not running after ${this.#options.readyTimeoutMs ?? 120_000} ms`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async #endpoint(id: string): Promise<SandboxEndpoint> {
    const found = await this.#json(`${this.#options.url}/sandboxes/${encodeURIComponent(id)}/endpoints/${EXECD_PORT}`, { method: "GET", headers: this.#lifecycleHeaders() });
    if (typeof found.endpoint !== "string") throw new Error("OpenSandbox returned no execd endpoint");
    const scheme = new URL(this.#options.url).protocol;
    const base = /^https?:\/\//.test(found.endpoint) ? found.endpoint : `${scheme}//${found.endpoint}`;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((found.headers as Record<string, unknown> | undefined) ?? {})) {
      if (typeof value === "string") headers[key] = value;
    }
    return { base: base.replace(/\/$/, ""), headers };
  }

  async #upload(endpoint: SandboxEndpoint, root: string): Promise<void> {
    const files = workspaceFiles(root);
    if (files.length === 0) return;
    const form = new FormData();
    for (const file of files) {
      form.append("metadata", JSON.stringify({ path: `/workspace/${file.path}`, mode: 644 }));
      form.append("file", new Blob([new Uint8Array(file.data)]), file.path.split("/").at(-1)!);
    }
    const response = await this.#fetch(`${endpoint.base}/files/upload`, { method: "POST", headers: endpoint.headers, body: form });
    if (!response.ok) throw new Error(`upload -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  async run(argv: readonly string[], options: IsolatedRunOptions): Promise<ProcessOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    // The host's absolute node path means nothing inside the image.
    const program = argv[0] === process.execPath ? "node" : argv[0]!;
    // PATH and HOME are the host's; the image brings its own.
    const { PATH: _path, HOME: _home, ...envs } = options.env;
    let id: string | null = null;
    try {
      id = await this.#create(options.timeout_ms);
      await this.#waitRunning(id);
      const endpoint = await this.#endpoint(id);
      await this.#upload(endpoint, options.root);
      const response = await this.#fetch(`${endpoint.base}/command`, {
        method: "POST",
        headers: { ...endpoint.headers, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ argv: [program, ...argv.slice(1)], cwd: "/workspace", background: false, timeout: options.timeout_ms, envs }),
      });
      if (!response.ok) throw new Error(`command -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const events = parseEventStream(await response.text());
      const text = (type: string) => events.filter((e) => e.type === type).map((e) => e.text ?? "").join("");
      const commandId = events.find((e) => e.type === "init")?.text;
      let exit: number | null = null;
      if (commandId) {
        const status = await this.#json(`${endpoint.base}/command/status/${encodeURIComponent(commandId)}`, { method: "GET", headers: endpoint.headers });
        exit = typeof status.exit_code === "number" ? status.exit_code : null;
      }
      const timedOut = events.some((e) => e.type === "error" && /timeout|timed out/i.test(JSON.stringify(e)));
      return {
        exit_code: exit ?? (timedOut ? 124 : -1),
        stdout: text("stdout"),
        stderr: text("stderr"),
        duration_ms: elapsed(),
        timed_out: timedOut,
        isolation: this.id,
      };
    } catch (error) {
      // The command never reached a verdict: -1 means "did not run" to AVL.
      return {
        exit_code: -1,
        stdout: "",
        stderr: `gru: opensandbox run failed: ${error instanceof Error ? error.message : String(error)}\n`,
        duration_ms: elapsed(),
        timed_out: false,
        isolation: this.id,
      };
    } finally {
      if (id !== null) {
        await this.#fetch(`${this.#options.url}/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.#lifecycleHeaders() }).catch(() => undefined);
      }
    }
  }
}
