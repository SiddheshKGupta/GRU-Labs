// The workspace executor: the code that performs authorized effects on the
// Minion's workspace (spec §4.2; P3, P9, S8).
//
// Every effect is resolved against the filesystem twice -- when AVL
// authorizes it (bind) and again immediately before it happens (perform) --
// and the gate compares the digests of the two. A path that now resolves
// elsewhere, a parent swapped for a symlink, a file that appeared since
// authorization: each changes the binding, redemption fails, and the gate
// spends the authorization. perform calls redeem before its first side
// effect. A binding that can no longer be computed at all is still sent to
// redeem, as a digest that cannot match, so the gate records the refusal
// rather than this executor deciding it privately.
//
// Rules: the final component is never a symlink. Writes and deletes also
// refuse a symlink anywhere between the root and the target, and a write
// refuses a hard-linked target, whose bytes would also land wherever the
// other link lives. Reads and listings may pass through a directory symlink
// only when the realpath stays inside the root. Containment is decided with
// path.relative, never a string prefix, so "/work-evil" is not inside
// "/work".
//
// Honest limits: between redeem and the syscall that acts there is still a
// window. O_NOFOLLOW, O_EXCL and a non-recursive mkdir close it for the
// final component; a parent directory swapped for a symlink inside that
// window is not caught (Node exposes no openat/O_BENEATH), nor is a
// directory swapped under a listing or a manifest walk. With no isolation
// backend (spec §4.3) a declared command running concurrently could make
// such a swap; this executor narrows the window, it does not remove it.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Effect } from "../avl/actions.ts";
import type { DeclaredCommand } from "../avl/consequence.ts";
import { AuthorizedAction, GateViolation, effectDigest, type Binding } from "../avl/gate.ts";
import { globToRegExp, matchesAny, normaliseWorkspacePath } from "../avl/paths.ts";
import { sha256 } from "../ledger/canonical.ts";
import {
  BindError,
  type CheckSpec,
  type EffectExecutor,
  type EffectResult,
  type ProcessOutcome,
  type Redeem,
} from "../types.ts";
import { assertArgv, assertTimeout, runArgv, scrubbedEnv } from "./process.ts";

export const MAX_READ_BYTES = 256 * 1024;
/** How much of each output stream the model sees after a command. */
export const MODEL_TAIL_BYTES = 8 * 1024;
/** Directory entries a manifest walk may visit, ignored ones included. */
export const MANIFEST_CAP = 50_000;

// Absent on Windows; `undefined | n` is n, so the flags degrade to plain opens there.
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

type FileBinding = { real: string; type: "file" | "dir" };
type WriteBinding = { real_parent: string; missing: string[]; target_exists: boolean };
type RunBinding = { argv: string[]; cwd: string; env_keys: string[] };
type HostEffect = Extract<Effect, { kind: "host.exec" | "host.fetch" | "host.other" }>;

const isHostEffect = (effect: Effect): effect is HostEffect => effect.kind.startsWith("host.");

/** Lexical containment by path.relative: a sibling sharing the root's prefix is outside. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * True only when every path below `dir` is ignored, so a walk may skip the
 * directory without hiding anything a per-path matchesAny would report.
 *
 * A glob whose trailing run of `*` has even length ends in a `**` that
 * globToRegExp turns into `.*`, and everything before it converts exactly
 * as it would on its own. So if the glob minus that `**` matches some
 * prefix of "dir/", the whole glob matches "dir/" followed by anything.
 * "node_modules/**", "**\/node_modules/**", "*\/**" and "**" all prune; a
 * glob that merely matches the directory's own name ("build", "*.log")
 * does not, and the files below it are checked one by one.
 */
export function prunesDirectory(dir: string, ignore: readonly string[]): boolean {
  const withSlash = `${dir}/`;
  return ignore.some((glob) => {
    const stars = /\*+$/.exec(glob)?.[0].length ?? 0;
    if (stars < 2 || stars % 2 !== 0) return false;
    const head = globToRegExp(glob.slice(0, -2));
    for (let end = 0; end <= withSlash.length; end++) {
      if (head.test(withSlash.slice(0, end))) return true;
    }
    return false;
  });
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? String(error);
}

/** lstat, with "does not exist" as null and every other failure as a BindError. */
function lstatOrNull(absolute: string, shown: string): fs.Stats | null {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "ENOTDIR") throw new BindError(`${shown}: a parent is not a directory`);
    throw new BindError(`${shown} cannot be inspected (${errorCode(error)})`);
  }
}

function readUpTo(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const count = fs.readSync(fd, buffer, filled, limit - filled, null);
    if (count === 0) break;
    filled += count;
  }
  return buffer.subarray(0, filled);
}

function hashFile(absolute: string, shown: string): string {
  const fd = fs.openSync(absolute, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${shown} changed during the manifest walk`);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function specialKind(stat: fs.Stats): string {
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "char-device";
  if (stat.isBlockDevice()) return "block-device";
  return "unknown";
}

/** The last MODEL_TAIL_BYTES of a stream, with a marker saying how much that is. */
function section(label: string, text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.max(0, bytes.length - MODEL_TAIL_BYTES);
  while (start < bytes.length && start > 0 && (bytes[start]! & 0xc0) === 0x80) start++;
  const shown = bytes.subarray(start).toString("utf8");
  const size = start === 0 ? `${bytes.length} bytes` : `last ${bytes.length - start} of ${bytes.length} bytes`;
  return `--- ${label} (${size}) ---\n${shown}${shown.endsWith("\n") || shown === "" ? "" : "\n"}`;
}

export class WorkspaceExecutor implements EffectExecutor {
  readonly root: string;
  readonly #commands: ReadonlyMap<string, DeclaredCommand>;

  constructor(root: string, commands: readonly DeclaredCommand[]) {
    let real: string;
    try {
      real = fs.realpathSync(root);
    } catch (error) {
      throw new Error(`workspace root ${root} cannot be resolved (${errorCode(error)})`);
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`workspace root ${root} is not a directory`);
    this.root = real;
    // A private snapshot: mutating the caller's array after construction changes nothing that runs.
    const table = new Map<string, DeclaredCommand>();
    for (const command of commands) {
      if (table.has(command.id)) throw new Error(`command ${command.id} is declared twice`);
      assertArgv(command.argv);
      assertTimeout(command.timeout_ms);
      table.set(command.id, structuredClone(command));
    }
    this.#commands = table;
  }

  bind(effect: Effect): Binding {
    switch (effect.kind) {
      case "fs.read":
        return this.#bindExisting(effect.path, "file");
      case "fs.list":
        return this.#bindExisting(effect.path, "dir");
      case "fs.write":
        return this.#bindWrite(effect.path);
      case "fs.delete":
        return this.#bindDelete(effect.path);
      case "process.run": {
        const command = this.#commands.get(effect.command_id);
        if (command === undefined) throw new BindError(`${effect.command_id} is not a declared command`);
        const binding: RunBinding = {
          argv: [...command.argv],
          cwd: this.root,
          env_keys: Object.keys(scrubbedEnv(command.env)).sort(),
        };
        return binding;
      }
      case "host.exec":
      case "host.fetch":
      case "host.other":
        throw new BindError("host effects are performed by the host");
      default:
        throw new BindError(`unknown effect kind ${String((effect as { kind: unknown }).kind)}`);
    }
  }

  async perform(action: AuthorizedAction, redeem: Redeem): Promise<EffectResult> {
    const effect = action.effect;
    if (isHostEffect(effect)) throw new BindError("host effects are performed by the host, never by this executor");
    // Defence in depth: the gate already refused this at mint.
    if (effect.kind === "fs.write") {
      const payload = action.payload;
      if (typeof payload !== "string" || sha256(payload) !== effect.content_sha256) {
        throw new GateViolation("write payload does not hash to the authorized content_sha256");
      }
    }
    // redeem is the authority; this only stops a forged object meeting a permissive redeem.
    if (!AuthorizedAction.isGenuine(action)) throw new GateViolation("not an AuthorizedAction minted by a gate");

    let binding: Binding;
    let unbindable: BindError | null = null;
    try {
      binding = this.bind(effect);
    } catch (error) {
      if (!(error instanceof BindError)) throw error;
      unbindable = error;
      // No successful bind produces this key, so the digest cannot match.
      binding = { unbindable: error.message };
    }
    redeem(action, effectDigest(effect, binding));
    if (unbindable !== null) throw unbindable;

    switch (effect.kind) {
      case "fs.read":
        return this.#read(effect.path, binding as FileBinding);
      case "fs.list":
        return this.#list(effect.path, binding as FileBinding);
      case "fs.write":
        return this.#write(effect.path, effect.content_sha256, binding as WriteBinding, action.payload as string);
      case "fs.delete":
        return this.#delete(effect.path, binding as FileBinding);
      case "process.run":
        return this.#run(effect.command_id);
    }
  }

  async runCheck(check: CheckSpec): Promise<ProcessOutcome> {
    return runArgv(check.argv, { cwd: this.root, env: scrubbedEnv(check.env), timeout_ms: check.timeout_ms });
  }

  manifest(ignore: readonly string[]): Map<string, string> {
    const entries: [string, string][] = [];
    let visited = 0;
    const pending: string[] = [""];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      for (const name of fs.readdirSync(path.join(this.root, dir)).sort()) {
        if (++visited > MANIFEST_CAP) {
          throw new Error(`workspace has more than ${MANIFEST_CAP} entries; add ignore globs such as "node_modules/**"`);
        }
        const relative = dir === "" ? name : `${dir}/${name}`;
        const absolute = path.join(this.root, relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) {
          if (!prunesDirectory(relative, ignore)) pending.push(relative);
          continue;
        }
        if (matchesAny(relative, ignore)) continue;
        if (stat.isSymbolicLink()) entries.push([relative, `symlink:${fs.readlinkSync(absolute)}`]);
        else if (stat.isFile()) entries.push([relative, hashFile(absolute, relative)]);
        // Never opened: reading a FIFO would block the walk forever.
        else entries.push([relative, `special:${specialKind(stat)}`]);
      }
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return new Map(entries);
  }

  // ------------------------------------------------------------ binding

  /** Workspace-relative components of an effect path, which must already be in normal form. */
  #components(effectPath: string): string[] {
    let normal: string;
    try {
      normal = normaliseWorkspacePath(effectPath);
    } catch (error) {
      throw new BindError(`invalid workspace path: ${(error as Error).message}`);
    }
    if (normal !== effectPath) throw new BindError(`path "${effectPath}" is not in normal form ("${normal}")`);
    return normal === "." ? [] : normal.split("/");
  }

  #contained(absolute: string, shown: string): string {
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch (error) {
      throw new BindError(`${shown} cannot be resolved (${errorCode(error)})`);
    }
    if (!isInside(this.root, real)) throw new BindError(`${shown} resolves outside the workspace`);
    return real;
  }

  #bindExisting(effectPath: string, type: "file" | "dir"): FileBinding {
    const absolute = path.join(this.root, ...this.#components(effectPath));
    const stat = lstatOrNull(absolute, effectPath);
    if (stat === null) throw new BindError(`${effectPath} does not exist`);
    if (stat.isSymbolicLink()) throw new BindError(`${effectPath} is a symlink; symlinks are not followed`);
    if (type === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new BindError(`${effectPath} is not a ${type === "file" ? "regular file" : "directory"}`);
    }
    return { real: this.#contained(absolute, effectPath), type };
  }

  /** Walk the parent directories of `parts` from the root, following nothing. */
  #parents(parts: readonly string[]): { dir: string; missing: string[] } {
    let dir = this.root;
    for (let index = 0; index < parts.length - 1; index++) {
      const next = path.join(dir, parts[index]!);
      const shown = parts.slice(0, index + 1).join("/");
      const stat = lstatOrNull(next, shown);
      if (stat === null) return { dir, missing: parts.slice(index, -1) };
      if (stat.isSymbolicLink()) throw new BindError(`${shown} is a symlink; symlinks are not followed`);
      if (!stat.isDirectory()) throw new BindError(`${shown} is not a directory`);
      dir = next;
    }
    return { dir, missing: [] };
  }

  #bindWrite(effectPath: string): WriteBinding {
    const parts = this.#components(effectPath);
    if (parts.length === 0) throw new BindError("cannot write the workspace root");
    const { dir, missing } = this.#parents(parts);
    let targetExists = false;
    if (missing.length === 0) {
      const stat = lstatOrNull(path.join(dir, parts.at(-1)!), effectPath);
      if (stat !== null) {
        if (stat.isSymbolicLink()) throw new BindError(`${effectPath} is a symlink; symlinks are not followed`);
        if (stat.isDirectory()) throw new BindError(`${effectPath} is a directory`);
        if (!stat.isFile()) throw new BindError(`${effectPath} is not a regular file`);
        if (stat.nlink > 1) {
          throw new BindError(`${effectPath} has ${stat.nlink} hard links; writing it would change the other links too`);
        }
        targetExists = true;
      }
    }
    return { real_parent: this.#contained(dir, effectPath), missing, target_exists: targetExists };
  }

  #bindDelete(effectPath: string): FileBinding {
    const parts = this.#components(effectPath);
    if (parts.length === 0) throw new BindError("cannot delete the workspace root");
    const { dir, missing } = this.#parents(parts);
    if (missing.length > 0) throw new BindError(`${effectPath} does not exist`);
    const absolute = path.join(dir, parts.at(-1)!);
    const stat = lstatOrNull(absolute, effectPath);
    if (stat === null) throw new BindError(`${effectPath} does not exist`);
    if (stat.isSymbolicLink()) throw new BindError(`${effectPath} is a symlink; symlinks are not followed`);
    if (!stat.isFile()) throw new BindError(`${effectPath} is not a regular file`);
    return { real: this.#contained(absolute, effectPath), type: "file" };
  }

  // ------------------------------------------------------------ effects (only after redeem)

  #read(effectPath: string, binding: FileBinding): EffectResult {
    // O_NONBLOCK: a file swapped for a FIFO since redeem must not hang the open.
    const fd = fs.openSync(binding.real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new GateViolation(`${effectPath} changed after authorization`);
      if (stat.size > MAX_READ_BYTES) return tooLarge(effectPath, stat.size, `is ${stat.size} bytes`);
      bytes = readUpTo(fd, MAX_READ_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    if (bytes.length > MAX_READ_BYTES) return tooLarge(effectPath, null, `grew past ${MAX_READ_BYTES} bytes while being read`);
    const digest = sha256(bytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        summary: { path: effectPath, bytes: bytes.length, sha256: digest },
        model_content: `${effectPath} is not valid UTF-8 text (${bytes.length} bytes); read_file only returns text.`,
        outputs: [],
      };
    }
    return {
      ok: true,
      summary: { path: effectPath, bytes: bytes.length, sha256: digest },
      model_content: text,
      outputs: [{ label: "read", bytes: text, relation: "SUPPORTS" }],
    };
  }

  #list(effectPath: string, binding: FileBinding): EffectResult {
    const stat = fs.lstatSync(binding.real);
    if (!stat.isDirectory()) throw new GateViolation(`${effectPath} changed after authorization`);
    const entries = fs
      .readdirSync(binding.real, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const listing = entries.join("\n");
    return {
      ok: true,
      summary: { path: effectPath, entries: entries.length },
      model_content: entries.length === 0 ? `${effectPath} is empty` : listing,
      outputs: [{ label: "list", bytes: listing, relation: "SUPPORTS" }],
    };
  }

  #write(effectPath: string, contentSha256: string, binding: WriteBinding, payload: string): EffectResult {
    let dir = binding.real_parent;
    for (const name of binding.missing) {
      const next = path.join(dir, name);
      if (!isInside(this.root, next)) throw new GateViolation(`${effectPath} would create a directory outside the workspace`);
      // Not recursive: anything that appeared here since redeem is an error, never reused.
      fs.mkdirSync(next);
      dir = next;
    }
    const target = path.join(dir, path.posix.basename(effectPath));
    if (!isInside(this.root, target)) throw new GateViolation(`${effectPath} resolves outside the workspace`);
    const data = Buffer.from(payload, "utf8");
    // Existing: never follow, never block on a FIFO. New: O_EXCL, so nothing that appeared since redeem is overwritten.
    const flags = binding.target_exists ? O_WRONLY | O_NOFOLLOW | O_NONBLOCK : O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
    const fd = fs.openSync(target, flags, 0o666);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new GateViolation(`${effectPath} changed after authorization`);
      fs.ftruncateSync(fd, 0);
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset, offset);
    } finally {
      fs.closeSync(fd);
    }
    return {
      ok: true,
      summary: { path: effectPath, bytes: data.length, sha256: contentSha256, created: !binding.target_exists },
      model_content: `wrote ${data.length} bytes to ${effectPath}${binding.target_exists ? "" : " (new file)"}`,
      outputs: [{ label: "written", bytes: payload, relation: "SUPPORTS" }],
    };
  }

  #delete(effectPath: string, binding: FileBinding): EffectResult {
    // unlink removes a name and never follows a symlink, even one swapped in since redeem.
    fs.unlinkSync(binding.real);
    return { ok: true, summary: { path: effectPath }, model_content: `deleted ${effectPath}`, outputs: [] };
  }

  async #run(commandId: string): Promise<EffectResult> {
    const command = this.#commands.get(commandId);
    if (command === undefined) throw new BindError(`${commandId} is not a declared command`);
    const outcome = await runArgv(command.argv, {
      cwd: this.root,
      env: scrubbedEnv(command.env),
      timeout_ms: command.timeout_ms,
    });
    const status = outcome.timed_out ? `exit ${outcome.exit_code} (timed out after ${command.timeout_ms} ms)` : `exit ${outcome.exit_code}`;
    return {
      ok: outcome.exit_code === 0,
      summary: {
        command_id: commandId,
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
        duration_ms: outcome.duration_ms,
      },
      model_content: `${status}\n${section("stdout", outcome.stdout)}${section("stderr", outcome.stderr)}`,
      outputs: [
        { label: "stdout", bytes: outcome.stdout, relation: "SUPPORTS" },
        { label: "stderr", bytes: outcome.stderr, relation: "SUPPORTS" },
      ],
    };
  }
}

function tooLarge(effectPath: string, size: number | null, why: string): EffectResult {
  return {
    ok: false,
    summary: { path: effectPath, bytes: size, sha256: null },
    model_content: `${effectPath} ${why}; read_file returns files of at most ${MAX_READ_BYTES} bytes. Nothing was read.`,
    outputs: [],
  };
}
