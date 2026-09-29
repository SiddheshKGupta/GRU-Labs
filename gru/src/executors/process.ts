// Argv-only process execution for declared commands and AVL checks.
//
// Why: v1 once handed a model-authored string to a shell behind a
// `--shell` flag guarded only by the word "trusted" (PR #60). Here there is
// no shell and no way to ask for one. argv goes to spawn as an array with
// shell:false, so ";", "&&", "$(...)" and globs reach the program as
// literal bytes. The environment is rebuilt from nothing (scrubbedEnv), so
// API keys and tokens in the operator's environment never reach code the
// Minion can influence (GRU §14.3).
//
// Evidence over exceptions: a process that cannot start, is killed by a
// signal or runs past its timeout still yields a ProcessOutcome (127,
// 128+n, 124), because a check that could not run must leave evidence, not
// a stack trace (v1 lesson). Only a malformed argv or timeout -- a caller
// bug -- throws.
//
// Honest limits: this is narrowing, not confinement (spec §4.3). The child
// runs with the user's ambient authority. It is started as the leader of
// its own process group so that a timeout kills the whole group, and group
// members still running when the leader exits are killed too. A descendant
// that leaves the group (setsid, a daemonising double fork) escapes both;
// its output is abandoned after DRAIN_GRACE_MS and it keeps running.
// Process groups are POSIX; on Windows only the direct child is killed.

import { spawn, type ChildProcess } from "node:child_process";
import { constants, tmpdir } from "node:os";
import type { ProcessOutcome } from "../types.ts";

/** Per stream. The first and last half are kept; the middle is replaced by a marker. */
export const OUTPUT_CAP_BYTES = 1024 * 1024;
export const EXIT_TIMED_OUT = 124;
export const EXIT_NOT_RUN = 127;
/** After the leader exits or is killed, how long its pipes may take to close. */
export const DRAIN_GRACE_MS = 2_000;
/** setTimeout silently turns anything larger into 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const HEAD_BYTES = OUTPUT_CAP_BYTES / 2;
const TAIL_BYTES = OUTPUT_CAP_BYTES - HEAD_BYTES;

export class ArgvError extends Error {
  override name = "ArgvError";
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeout_ms: number;
}

/**
 * The whole environment a child sees. Nothing from process.env passes
 * through except PATH, so a credential in the operator's shell cannot reach
 * a process the Minion can influence. `extra` is Director-declared.
 */
export function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: tmpdir(),
    ...extra,
  };
}

export function assertArgv(argv: unknown): asserts argv is readonly string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new ArgvError("argv must be a non-empty array");
  argv.forEach((arg: unknown, index) => {
    if (typeof arg !== "string") throw new ArgvError(`argv[${index}] is not a string`);
    if (arg.includes("\0")) throw new ArgvError(`argv[${index}] contains NUL`);
  });
  if (argv[0] === "") throw new ArgvError("argv[0] is empty");
}

export function assertTimeout(timeoutMs: unknown): asserts timeoutMs is number {
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeout_ms must be an integer in 1..${MAX_TIMEOUT_MS}`);
  }
}

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function wholeCharacterPrefix(bytes: Buffer): number {
  let lead = bytes.length - 1;
  while (lead >= 0 && bytes.length - lead < 4 && isContinuation(bytes[lead])) lead--;
  if (lead < 0) return bytes.length;
  const byte = bytes[lead]!;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + width > bytes.length ? lead : bytes.length;
}

/** Number of leading bytes that continue a sequence cut off before the buffer. */
function strayContinuations(bytes: Buffer): number {
  let start = 0;
  while (start < 3 && isContinuation(bytes[start])) start++;
  return start;
}

/**
 * Keeps the first and last half of the cap. The tail matters as much as the
 * head: a test runner prints its verdict last.
 */
class Capture {
  readonly #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  #dropped = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.#headBytes < HEAD_BYTES) {
      const take = Math.min(HEAD_BYTES - this.#headBytes, rest.length);
      this.#head.push(rest.subarray(0, take));
      this.#headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.#tail.push(rest);
    this.#tailBytes += rest.length;
    while (this.#tail.length > 1 && this.#tailBytes - this.#tail[0]!.length >= TAIL_BYTES) {
      const dropped = this.#tail.shift()!;
      this.#tailBytes -= dropped.length;
      this.#dropped += dropped.length;
    }
  }

  text(): string {
    const head = Buffer.concat(this.#head);
    let tail = Buffer.concat(this.#tail);
    let dropped = this.#dropped;
    if (tail.length > TAIL_BYTES) {
      dropped += tail.length - TAIL_BYTES;
      tail = tail.subarray(tail.length - TAIL_BYTES);
    }
    if (dropped === 0) return Buffer.concat([head, tail]).toString("utf8");
    // Cut on character boundaries so the marker is the only artefact of truncation.
    const headEnd = wholeCharacterPrefix(head);
    const tailStart = strayContinuations(tail);
    dropped += head.length - headEnd + tailStart;
    return (
      head.subarray(0, headEnd).toString("utf8") +
      `\n[truncated ${dropped} bytes]\n` +
      tail.subarray(tailStart).toString("utf8")
    );
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // ESRCH: the group is already empty. Fall through for the leader.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

function exitCodeOf(status: { code: number | null; signal: NodeJS.Signals | null } | null): number {
  if (status !== null && status.code !== null && status.code >= 0) return status.code;
  if (status?.signal) {
    const number = (constants.signals as unknown as Record<string, number | undefined>)[status.signal];
    return 128 + (number ?? 0);
  }
  // No exit status was ever reported: the process never demonstrably ran.
  return EXIT_NOT_RUN;
}

/**
 * Run argv with no shell. Resolves for every process failure; throws only
 * for an invalid argv or timeout.
 */
export function runArgv(argv: readonly string[], options: RunOptions): Promise<ProcessOutcome> {
  assertArgv(argv);
  assertTimeout(options.timeout_ms);
  const program = argv[0]!;
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  return new Promise<ProcessOutcome>((resolve) => {
    const notRun = (error: unknown): ProcessOutcome => ({
      exit_code: EXIT_NOT_RUN,
      stdout: "",
      stderr: `gru: could not run "${program}": ${describeError(error)}\n`,
      duration_ms: elapsed(),
      timed_out: false,
    });

    let child: ChildProcess;
    try {
      child = spawn(program, argv.slice(1), {
        shell: false,
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      // Synchronous spawn failures (invalid env, E2BIG, ...) are evidence too.
      resolve(notRun(error));
      return;
    }

    const stdout = new Capture();
    const stderr = new Capture();
    let settled = false;
    let timedOut = false;
    let status: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let grace: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    const finish = (): void => {
      if (settled) return;
      settle({
        exit_code: timedOut ? EXIT_TIMED_OUT : exitCodeOf(status),
        stdout: stdout.text(),
        stderr: stderr.text(),
        duration_ms: elapsed(),
        timed_out: timedOut,
      });
    };
    const drain = (): void => {
      if (grace === undefined && !settled) grace = setTimeout(finish, DRAIN_GRACE_MS);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.on("error", (error) => {
      // Without a pid the process never started (ENOENT, EACCES, ...).
      // With one, this is a failed kill; exit/close still report.
      if (child.pid === undefined) settle(notRun(error));
    });
    child.on("exit", (code, signal) => {
      status = { code, signal };
      killGroup(child);
      drain();
    });
    child.on("close", (code, signal) => {
      status ??= { code, signal };
      finish();
    });
    deadline = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      drain();
    }, options.timeout_ms);
  });
}
