// An in-memory EffectExecutor for kernel tests. It keeps the executor
// contract that matters to the kernel -- re-bind at execution, recompute
// the digest, redeem BEFORE mutating -- and lets a test script checks,
// commands, symlink swaps, and a pause between authorization and execution.

import type { Effect } from "../src/avl/actions.ts";
import { effectDigest, type AuthorizedAction, type Binding } from "../src/avl/gate.ts";
import { matchesAny } from "../src/avl/paths.ts";
import { sha256 } from "../src/ledger/canonical.ts";
import {
  BindError,
  type CheckSpec,
  type EffectExecutor,
  type EffectResult,
  type ProcessOutcome,
  type Redeem,
} from "../src/types.ts";

export function outcome(exit_code: number, stdout = "", stderr = "", timed_out = false): ProcessOutcome {
  return { exit_code, stdout, stderr, duration_ms: 1, timed_out };
}

export class FakeExecutor implements EffectExecutor {
  readonly root: string;
  /** The workspace: path -> UTF-8 content. Tests may edit it directly to act "behind the session". */
  readonly files: Map<string, string>;
  /** path -> where it now resolves, as a symlink swap would make it. Included in the binding. */
  readonly redirects = new Map<string, string>();
  /** check id -> scripted outcome. Unscripted checks pass. */
  readonly checks = new Map<string, ProcessOutcome>();
  /** command id -> what running it does to the workspace. */
  readonly commands = new Map<string, (files: Map<string, string>) => ProcessOutcome>();
  /** Perform without calling redeem, to model a faulty executor. */
  skipRedeem = false;
  /** Throw this from perform after redeeming, to model an executor crash. */
  crashAfterRedeem: Error | null = null;
  readonly performed: string[] = [];
  readonly checksRun: string[] = [];
  #pause: { arrive: () => void; wait: Promise<void> } | null = null;

  constructor(files: Record<string, string> = {}, root = "/fake/workspace") {
    this.root = root;
    this.files = new Map(Object.entries(files));
  }

  /** The next perform stops before binding until release() is called. */
  pauseNext(): { reached: Promise<void>; release: () => void } {
    let arrive: () => void = () => {};
    let release: () => void = () => {};
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    const wait = new Promise<void>((resolve) => (release = resolve));
    this.#pause = { arrive, wait };
    return { reached, release };
  }

  bind(effect: Effect): Binding {
    switch (effect.kind) {
      case "fs.read":
      case "fs.list":
      case "fs.write":
      case "fs.delete":
        if (effect.path.startsWith("escape")) throw new BindError(`${effect.path} resolves outside the workspace`);
        if (effect.path.startsWith("crash")) throw new Error("EIO: i/o error");
        return { path: effect.path, resolved: this.redirects.get(effect.path) ?? effect.path };
      case "process.run":
        return { command_id: effect.command_id };
      default:
        throw new BindError(`${effect.kind} is performed by the host, not by GRU`);
    }
  }

  async perform(action: AuthorizedAction, redeem: Redeem): Promise<EffectResult> {
    const pause = this.#pause;
    if (pause !== null) {
      this.#pause = null;
      pause.arrive();
      await pause.wait;
    }
    const binding = this.bind(action.effect);
    if (!this.skipRedeem) redeem(action, effectDigest(action.effect, binding));
    if (this.crashAfterRedeem !== null) throw this.crashAfterRedeem;
    this.performed.push(action.authorization_id);

    const effect = action.effect;
    switch (effect.kind) {
      case "fs.read": {
        const content = this.files.get(effect.path);
        if (content === undefined) {
          return { ok: false, summary: { path: effect.path, error: "ENOENT" }, model_content: "no such file", outputs: [] };
        }
        return {
          ok: true,
          summary: { path: effect.path, bytes: content.length },
          model_content: content,
          outputs: [{ label: `read:${effect.path}`, bytes: content, relation: "DERIVED_FROM" }],
        };
      }
      case "fs.list": {
        const prefix = effect.path === "." ? "" : `${effect.path}/`;
        const entries = [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
        return { ok: true, summary: { path: effect.path, entries: entries.length }, model_content: entries.join("\n"), outputs: [] };
      }
      case "fs.write":
        this.files.set(effect.path, action.payload ?? "");
        return { ok: true, summary: { path: effect.path, bytes: effect.bytes }, model_content: `wrote ${effect.path}`, outputs: [] };
      case "fs.delete": {
        const existed = this.files.delete(effect.path);
        return { ok: existed, summary: { path: effect.path, deleted: existed }, model_content: existed ? "deleted" : "no such file", outputs: [] };
      }
      case "process.run": {
        const run = this.commands.get(effect.command_id)?.(this.files) ?? outcome(0, `${effect.command_id} ran`);
        return {
          ok: run.exit_code === 0,
          summary: { command_id: effect.command_id, exit_code: run.exit_code },
          model_content: run.stdout + run.stderr,
          outputs: [{ label: `stdout:${effect.command_id}`, bytes: run.stdout, relation: "DERIVED_FROM" }],
        };
      }
      default:
        throw new Error(`${effect.kind} is never performed by GRU`);
    }
  }

  async runCheck(check: CheckSpec): Promise<ProcessOutcome> {
    this.checksRun.push(check.id);
    return this.checks.get(check.id) ?? outcome(0, `${check.id} passed`);
  }

  manifest(ignore: readonly string[]): Map<string, string> {
    const manifest = new Map<string, string>();
    for (const [path, content] of this.files) {
      if (!matchesAny(path, ignore)) manifest.set(path, sha256(content));
    }
    return manifest;
  }
}
