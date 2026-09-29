// Hook daemon: a unix-socket listener inside the MCP server process.
//
// Why: hosts run a hook as a fresh process per event, but a GovernedSession
// lives in memory. The MCP server is the one long-lived process a host
// starts per session, so it owns the session and also listens here; `gru
// hook` is a thin client that forwards one event and prints one answer.
//
// Protocol: one JSON line {host, event, payload} in, one JSON line out:
// {ok: true, output} carrying the hook output JSON, or {ok: false, error}.
// The envelope exists so the client can tell a daemon error from an answer
// and turn an error on PreToolUse into "ask", never into no decision.
//
// Honest ceiling: any process running as the same user can connect to the
// socket and submit fake PostToolUse records (evidence poisoning). It
// cannot mint authority: decisions come only from the kernel's decideHost,
// and a PostToolUse only attaches a result to an authorization the kernel
// already issued. The socket is chmod 0600 after listen; before that its
// mode follows the umask (on Linux connecting needs write permission, which
// a 022 umask does not give others). Two MCP servers sharing one state
// directory are refused rather than hijacked: a live socket is never removed.

import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { canonical, sha256 } from "../ledger/canonical.ts";
import type { GovernedSession } from "../types.ts";
import { isHost, mapHostTool, type Host, type HostMapContext, type HostMapping } from "./host-map.ts";
import {
  emptyOutput,
  HOST_EVENTS,
  toClaudeFailure,
  toClaudePassthrough,
  toClaudePreToolUse,
  toSessionStart,
  type HookOutput,
} from "./respond.ts";

export const SOCKET_NAME = "hook.sock";
/** sun_path is 108 bytes on Linux and 104 on macOS, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RECORDED_OUTPUT_BYTES = 64 * 1024;
/** Pre-tool decisions awaiting their PostToolUse. Oldest are dropped first. */
export const MAX_PENDING_CORRELATIONS = 4096;

export class SocketPathError extends Error {
  override name = "SocketPathError";
}

/** The one place the hook socket's location is derived from the state directory. */
export function socketPathFor(stateDir: string): string {
  const path = join(stateDir, SOCKET_NAME);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new SocketPathError(
      `hook socket path ${path} is longer than ${MAX_SOCKET_PATH_BYTES} bytes; choose a shorter state directory`,
    );
  }
  return path;
}

export interface HookRequest {
  host: Host;
  event: string;
  payload: Record<string, unknown>;
}

export type HookReply = { ok: true; output: HookOutput } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Correlates a PostToolUse with the PreToolUse decision it follows. */
export function correlationKey(payload: Record<string, unknown>): string {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id.length > 0) {
    return `id:${payload.tool_use_id}`;
  }
  const input = payload.tool_input === undefined ? null : payload.tool_input;
  return `call:${String(payload.tool_name)}:${sha256(canonical(input))}`;
}

/**
 * Best-effort reading of the host's own report of whether its tool call
 * failed. It is host-reported information (T2/T4), recorded as such.
 */
export function responseLooksOk(response: unknown): boolean {
  if (!isRecord(response)) return true;
  if (response.is_error === true || response.isError === true) return false;
  if (response.success === false || response.interrupted === true) return false;
  return !(typeof response.error === "string" && response.error.length > 0);
}

export function truncateOutput(value: unknown, maxBytes = MAX_RECORDED_OUTPUT_BYTES): string | null {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return null;
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const marker = `...[truncated ${bytes.length} bytes to ${maxBytes}]`;
  const kept = new TextDecoder().decode(bytes.subarray(0, maxBytes - Buffer.byteLength(marker) - 3));
  // A cut mid-character decodes to U+FFFD (3 bytes), which the 3 spare bytes above absorb.
  return `${kept}${marker}`;
}

class Correlations {
  readonly #queues = new Map<string, string[]>();
  #size = 0;

  remember(key: string, authorizationId: string): void {
    const queue = this.#queues.get(key);
    if (queue) queue.push(authorizationId);
    else this.#queues.set(key, [authorizationId]);
    this.#size++;
    while (this.#size > MAX_PENDING_CORRELATIONS) {
      const oldest = this.#queues.keys().next();
      if (oldest.done) break;
      this.#take(oldest.value);
    }
  }

  take(key: string): string | undefined {
    return this.#take(key);
  }

  #take(key: string): string | undefined {
    const queue = this.#queues.get(key);
    if (!queue) return undefined;
    const id = queue.shift();
    this.#size--;
    if (queue.length === 0) this.#queues.delete(key);
    return id;
  }
}

export interface HookHandlerOptions {
  getSession: () => Promise<GovernedSession>;
  ctx: HostMapContext;
  log?: (line: string) => void;
}

/** The daemon's request logic, separate from socket I/O. */
export class HookHandler {
  readonly #getSession: () => Promise<GovernedSession>;
  readonly #ctx: HostMapContext;
  readonly #log: (line: string) => void;
  readonly #correlations = new Correlations();

  constructor(options: HookHandlerOptions) {
    this.#getSession = options.getSession;
    this.#ctx = options.ctx;
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** Never rejects: every failure becomes {ok: false}. */
  async handleLine(line: string): Promise<HookReply> {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false, error: "request is not valid JSON" };
    }
    if (!isRecord(request) || !isHost(request.host) || typeof request.event !== "string" || !isRecord(request.payload)) {
      return { ok: false, error: "request must be {host: \"claude-code\"|\"codex\", event: string, payload: object}" };
    }
    try {
      return { ok: true, output: await this.handle({ host: request.host, event: request.event, payload: request.payload }) };
    } catch (error) {
      this.#log(`gru hook daemon: ${request.event} failed: ${(error as Error).message}`);
      return { ok: false, error: (error as Error).message };
    }
  }

  async handle(request: HookRequest): Promise<HookOutput> {
    const { host, event, payload } = request;
    if (!HOST_EVENTS[host].includes(event)) {
      throw new Error(`${host} ${event} is not a hook event GRU handles`);
    }
    switch (event) {
      case "SessionStart":
        return toSessionStart(await this.#getSession());
      case "PreToolUse":
        return this.#preToolUse(host, payload);
      case "PostToolUse":
        await this.#postToolUse(payload);
        return emptyOutput();
      default:
        // Stop fires at the end of every turn, not at the end of the work;
        // the episode is closed explicitly by gru_verify_and_close (or with
        // HOST_ENDED when the host closes the MCP server).
        return emptyOutput();
    }
  }

  async #preToolUse(host: Host, payload: Record<string, unknown>): Promise<HookOutput> {
    const tool = payload.tool_name;
    if (typeof tool !== "string" || tool.length === 0) return toClaudeFailure("PreToolUse payload has no tool_name");
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    let mapped: HostMapping;
    try {
      mapped = mapHostTool(host, tool, payload.tool_input, cwd === undefined ? this.#ctx : { ...this.#ctx, cwd });
    } catch (error) {
      return toClaudeFailure(`could not map ${tool}: ${(error as Error).message}`);
    }
    if (mapped.kind === "passthrough") return toClaudePassthrough(mapped.reason);
    try {
      const session = await this.#getSession();
      const decision = await session.decideHost(tool, mapped.effect);
      // Remembered for every verdict: if the host performs a DENY'd call
      // anyway, the PostToolUse attaches to that authorization and the
      // kernel's structural check can see it.
      this.#correlations.remember(correlationKey(payload), decision.authorization_id);
      return toClaudePreToolUse(decision);
    } catch (error) {
      return toClaudeFailure((error as Error).message);
    }
  }

  async #postToolUse(payload: Record<string, unknown>): Promise<void> {
    const key = correlationKey(payload);
    const authorizationId = this.#correlations.take(key);
    if (authorizationId === undefined) {
      this.#log(`gru hook daemon: PostToolUse for ${String(payload.tool_name)} matches no PreToolUse decision; nothing recorded`);
      return;
    }
    const session = await this.#getSession();
    session.recordHostEffect(authorizationId, {
      ok: responseLooksOk(payload.tool_response),
      summary: { tool: typeof payload.tool_name === "string" ? payload.tool_name : null },
      output: truncateOutput(payload.tool_response),
    });
  }
}

export interface HookDaemonOptions extends HookHandlerOptions {
  socketPath: string;
}

export interface HookDaemon {
  readonly socketPath: string;
  close(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Remove a stale socket file; refuse to touch a live socket or anything that is not a socket. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(socketPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error(`${socketPath} exists and is not a socket; not removing it`);
  if (await isLive(socketPath)) throw new Error(`another GRU hook daemon is live on ${socketPath}`);
  await unlink(socketPath);
}

export async function startHookDaemon(options: HookDaemonOptions): Promise<HookDaemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const handler = new HookHandler({ ...options, log });
  const connections = new Set<Socket>();
  await clearStaleSocket(options.socketPath);

  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", (error) => log(`gru hook daemon: connection error: ${error.message}`));
    socket.setEncoding("utf8");
    let buffer = "";
    let answered = false;
    const answer = (reply: HookReply): void => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
          answered = true;
          answer({ ok: false, error: `request larger than ${MAX_REQUEST_BYTES} bytes` });
        }
        return;
      }
      answered = true;
      void handler.handleLine(buffer.slice(0, newline)).then(answer);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
  server.on("error", (error) => log(`gru hook daemon: ${error.message}`));

  let closing: Promise<void> | null = null;
  return {
    socketPath: options.socketPath,
    close(): Promise<void> {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of connections) socket.destroy();
        await stopped;
        try {
          await unlink(options.socketPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") log(`gru hook daemon: could not remove ${options.socketPath}: ${(error as Error).message}`);
        }
      })();
      return closing;
    },
  };
}
