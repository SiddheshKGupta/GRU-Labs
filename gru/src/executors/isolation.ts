// Isolation backends: what confines a declared command or a verification
// check while it runs (SLICE_1 §4.3, S7).
//
// Without one, a command the Director declared still runs Minion-written
// code with the operator's filesystem and network: the benchmark's m09
// Minion wrote outside the workspace from inside a test import and closed
// PASS. A backend runs the argv somewhere that cannot do that, and says
// which threat-model properties it gives the commands it covers. Commands
// it does not cover run unconfined and the episode's safety label says so.
//
// Backends here:
//   NodePermissionIsolation  Node's permission model, in-process. Zero
//                            dependencies. Covers argv whose program is node.
//   OpenSandboxIsolation     (opensandbox.ts) a container or microVM per run
//                            via an OpenSandbox server. Covers any argv.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProcessOutcome } from "../types.ts";
import { runArgv } from "./process.ts";

export interface IsolatedRunOptions {
  /** The workspace root, already realpath'd by the executor. */
  root: string;
  /** The scrubbed environment the command would otherwise get. */
  env: Record<string, string>;
  timeout_ms: number;
  purpose: "check" | "command";
}

export interface IsolationBackend {
  readonly id: string;
  /** Properties (P1, P2, P8) this backend gives the argv it covers; the Director's admission (D5). */
  readonly provides: readonly string[];
  /** What it does not confine, stated so the ledger can carry it. */
  readonly limits: readonly string[];
  covers(argv: readonly string[]): boolean;
  run(argv: readonly string[], options: IsolatedRunOptions): Promise<ProcessOutcome>;
}

function isNode(program: string): boolean {
  return program === process.execPath || basename(program) === "node";
}

/** Flags that mean the Director is already managing Node's permission model. */
function managesPermissions(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--permission" || arg === "--experimental-permission" || arg.startsWith("--allow-"));
}

/** Node 22 spells it --experimental-test-isolation; later versions drop the prefix. */
function testIsolationFlag(): string {
  return process.allowedNodeEnvironmentFlags.has("--test-isolation") ? "--test-isolation=none" : "--experimental-test-isolation=none";
}

/**
 * Node's permission model: the process may read the workspace and a
 * per-run scratch directory, may write only the scratch directory, and may
 * not spawn processes, load addons or start WASI. Minion code that runs
 * inside it (a module the tests import) gets ERR_ACCESS_DENIED for
 * anything else. `node --test` normally runs each file in a child
 * process, which the model forbids, so test files run in-process instead.
 */
export class NodePermissionIsolation implements IsolationBackend {
  readonly id = "node-permission";
  readonly provides = ["P1", "P2"] as const;
  readonly limits = [
    "network is not restricted (Node 22's permission model has no network control), so P8 stays unmet",
    "covers only argv whose program is node; other programs run unconfined",
    "the workspace is read-only while a command or check runs; files change only through write_file and delete_file",
    "child processes are refused, so tests that spawn processes fail",
    "symlinks already in the workspace are followed even outside it (a documented limit of Node's permission model); Minions cannot create them",
  ];

  covers(argv: readonly string[]): boolean {
    return argv.length > 0 && isNode(argv[0]!) && !managesPermissions(argv);
  }

  /** The argv actually executed; exported for the ledger and for tests. */
  wrap(argv: readonly string[], root: string, scratch: string): string[] {
    const [program, ...rest] = argv;
    return [
      program!,
      "--permission",
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${scratch}`,
      `--allow-fs-write=${scratch}`,
      ...(rest.includes("--test") ? [testIsolationFlag()] : []),
      ...rest,
    ];
  }

  async run(argv: readonly string[], options: IsolatedRunOptions): Promise<ProcessOutcome> {
    if (!this.covers(argv)) throw new Error(`${this.id} does not cover ${argv[0]}`);
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gru-scratch-")));
    try {
      const outcome = await runArgv(this.wrap(argv, options.root, scratch), {
        cwd: options.root,
        env: { ...options.env, HOME: scratch, TMPDIR: scratch },
        timeout_ms: options.timeout_ms,
      });
      return { ...outcome, isolation: this.id };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
