// `gru hook <host> <event>`: stdin JSON -> daemon socket -> stdout JSON.
//
// Why: a host runs each hook as a fresh process, so this client carries one
// event to the daemon inside the MCP server (which owns the session) and
// prints the one answer it gets back.
//
// Fail-safe, not fail-open: if the daemon cannot be reached, answers with
// an error, or does not answer in time, a PreToolUse prints "ask" with an
// explicit "NOT governed or recorded" warning, and every other event prints
// {}. The exit code is always 0: Claude Code treats exit 2 as a blocking
// error fed back to the model and other non-zero codes as non-blocking
// errors, and neither means "ask the human". The decision travels in
// stdout JSON only.
//
// Before connecting, the socket file must be a real socket (not a symlink),
// owned by this user, with no group or other permission bits; anything
// else is treated as unreachable, so a socket planted by someone else is
// never trusted for a decision. Ownership cannot be checked on platforms
// without process.getuid (Windows, which slice 1 does not support).

import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Host } from "./host-map.ts";
import { unreachableOutput } from "./respond.ts";

export interface HookClientOptions {
  host: Host;
  event: string;
  socketPath: string;
  stdin: Readable;
  stdout: Writable;
  /** Whole exchange, connect included. Below the 15 s hook timeout `gru install` writes. */
  timeout_ms?: number;
  /** How long to keep retrying the connection (the MCP server may still be starting). */
  connect_wait_ms?: number;
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readAll(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) text += chunk as string;
  return text;
}

async function checkSocketFile(socketPath: string): Promise<void> {
  const stats = await lstat(socketPath);
  if (!stats.isSocket()) throw new Error(`${socketPath} is not a socket`);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error(`${socketPath} is owned by another user`);
  if ((stats.mode & 0o077) !== 0) throw new Error(`${socketPath} is accessible to group or others`);
}

async function connectOnce(socketPath: string): Promise<Socket> {
  await checkSocketFile(socketPath);
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

async function connect(socketPath: string, waitUntil: number, track: (socket: Socket) => void): Promise<Socket> {
  for (;;) {
    try {
      const socket = await connectOnce(socketPath);
      track(socket);
      return socket;
    } catch (error) {
      const remaining = waitUntil - Date.now();
      if (remaining <= 0) throw error;
      await delay(Math.min(100, remaining));
    }
  }
}

function exchangeLine(socket: Socket, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch {
        reject(new Error("daemon reply is not valid JSON"));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("daemon closed the connection without answering")));
    socket.write(`${line}\n`);
  });
}

function outputOf(reply: unknown): Record<string, unknown> {
  if (!isRecord(reply)) throw new Error("daemon reply is not an object");
  if (reply.ok === true && isRecord(reply.output)) return reply.output;
  throw new Error(`daemon error: ${typeof reply.error === "string" ? reply.error : "malformed reply"}`);
}

export async function runHookClient(options: HookClientOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const timeout = options.timeout_ms ?? 10_000;
  const started = Date.now();
  let output: unknown = unreachableOutput(options.host, options.event);

  let payload: unknown;
  try {
    payload = JSON.parse(await readAll(options.stdin));
  } catch {
    payload = undefined;
  }

  if (!isRecord(payload)) {
    log(`gru hook: ${options.event} input is not a JSON object; answering without GRU`);
  } else {
    const sockets: Socket[] = [];
    let finished = false;
    // A connection that completes after the deadline is closed at once, so
    // nothing keeps this process alive past its answer.
    const track = (socket: Socket): void => {
      sockets.push(socket);
      if (finished) socket.destroy();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeout} ms`)), timeout);
    });
    try {
      const waitUntil = started + Math.min(options.connect_wait_ms ?? 2_000, timeout);
      const line = JSON.stringify({ host: options.host, event: options.event, payload });
      const exchange = (async () => {
        const connected = await connect(options.socketPath, waitUntil, track);
        return outputOf(await exchangeLine(connected, line));
      })();
      exchange.catch(() => {});
      output = await Promise.race([exchange, deadline]);
    } catch (error) {
      log(`gru hook: ${options.event}: ${(error as Error).message}; answering without GRU`);
    } finally {
      finished = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
    }
  }

  await new Promise<void>((resolve) => options.stdout.write(`${JSON.stringify(output)}\n`, () => resolve()));
  return 0;
}
