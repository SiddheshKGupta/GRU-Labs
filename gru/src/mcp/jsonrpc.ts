// Newline-delimited JSON-RPC 2.0 over a pair of streams (the MCP stdio
// transport).
//
// Written by hand because slice 1 takes no MCP SDK dependency, and the
// transport is small: one JSON object per line; requests are answered by
// id; notifications are never answered; responses are routed back to the
// requests this side sent (MCP elicitation is a server -> client request).
// stdout is the protocol channel, so this module writes nothing to `output`
// except JSON-RPC messages. Diagnostics go to `log`, which defaults to
// stderr.
//
// Limits, stated: no batching (MCP 2025-06-18 removed it, so an array is an
// invalid request), no cancellation of in-flight requests, and one peer per
// stream pair. Handlers run concurrently, so responses may be written out
// of order; JSON-RPC correlates by id, not by position.

import type { Readable, Writable } from "node:stream";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type RequestHandler = (params: unknown, id: JsonRpcId) => unknown;
export type NotificationHandler = (params: unknown) => void;

export interface PeerOptions {
  input: Readable;
  output: Writable;
  /** Method -> handler. A Map, so "constructor" or "__proto__" can never resolve to a prototype member. */
  requests: ReadonlyMap<string, RequestHandler>;
  notifications?: ReadonlyMap<string, NotificationHandler>;
  log?: (line: string) => void;
  /** Called once when the input stream ends or errors. */
  onEnd?: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function stderrLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

export class JsonRpcPeer {
  readonly #output: Writable;
  readonly #requests: ReadonlyMap<string, RequestHandler>;
  readonly #notifications: ReadonlyMap<string, NotificationHandler>;
  readonly #log: (line: string) => void;
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #buffer = "";
  #closed = false;

  constructor(options: PeerOptions) {
    this.#output = options.output;
    this.#requests = options.requests;
    this.#notifications = options.notifications ?? new Map();
    this.#log = options.log ?? stderrLog;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      this.#failPending("the peer closed the stream");
      options.onEnd?.();
    };
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => this.#receive(chunk));
    options.input.on("end", end);
    options.input.on("close", end);
    options.input.on("error", (error: Error) => {
      this.#log(`gru mcp: input error: ${error.message}`);
      end();
    });
  }

  /** Send a request to the other side and wait for its response. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("JSON-RPC peer is closed"));
    const id = `gru-${this.#nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no response to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Stop writing and fail every outstanding outgoing request. Input is no longer processed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending("JSON-RPC peer closed");
  }

  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed || this.#output.destroyed || this.#output.writableEnded) return;
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch (error) {
      this.#log(`gru mcp: could not serialise a message: ${(error as Error).message}`);
      if ("id" in message && isId(message.id)) {
        line = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: INTERNAL_ERROR, message: "result could not be serialised" },
        });
      } else {
        return;
      }
    }
    this.#output.write(`${line}\n`);
  }

  #error(id: JsonRpcId | null, code: number, message: string): void {
    this.#send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #receive(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length > 0) this.#dispatch(line);
      if (this.#closed) return;
      newline = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#error(null, PARSE_ERROR, "Parse error: a line was not valid JSON");
      return;
    }
    if (!isRecord(message)) {
      this.#error(null, INVALID_REQUEST, "Invalid Request: expected a JSON object (batches are not supported)");
      return;
    }
    const hasId = "id" in message;
    const echoId = hasId && isId(message.id) ? message.id : null;
    if (message.jsonrpc !== "2.0") {
      this.#error(echoId, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
      return;
    }
    if (!("method" in message)) {
      if (hasId && isId(message.id) && ("result" in message || "error" in message)) {
        this.#settle(message.id, message);
        return;
      }
      this.#error(echoId, INVALID_REQUEST, "Invalid Request: no method, and not a response");
      return;
    }
    if (typeof message.method !== "string") {
      this.#error(echoId, INVALID_REQUEST, "Invalid Request: method must be a string");
      return;
    }
    if (!hasId) {
      const handler = this.#notifications.get(message.method);
      if (handler) {
        try {
          handler(message.params);
        } catch (error) {
          this.#log(`gru mcp: notification ${message.method} failed: ${(error as Error).message}`);
        }
      }
      return;
    }
    if (!isId(message.id)) {
      this.#error(null, INVALID_REQUEST, "Invalid Request: id must be a string or a number");
      return;
    }
    void this.#answer(message.id, message.method, message.params);
  }

  async #answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#requests.get(method);
    if (!handler) {
      this.#error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params, id);
      this.#send({ jsonrpc: "2.0", id, result: result === undefined ? {} : result });
    } catch (error) {
      if (error instanceof RpcError) {
        this.#error(id, error.code, error.message);
      } else {
        this.#log(`gru mcp: ${method} failed: ${(error as Error).stack ?? String(error)}`);
        this.#error(id, INTERNAL_ERROR, `Internal error: ${(error as Error).message}`);
      }
    }
  }

  #settle(id: JsonRpcId, message: Record<string, unknown>): void {
    const key = String(id);
    const pending = this.#pending.get(key);
    if (!pending) {
      this.#log(`gru mcp: response to unknown request id ${key} ignored`);
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    if ("error" in message) {
      const error = message.error;
      const text = isRecord(error) && typeof error.message === "string" ? error.message : "unknown error";
      const code = isRecord(error) && typeof error.code === "number" ? error.code : INTERNAL_ERROR;
      pending.reject(new RpcError(code, text));
    } else {
      pending.resolve(message.result);
    }
  }
}
