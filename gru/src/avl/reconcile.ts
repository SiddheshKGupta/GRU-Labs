// Workspace reconciliation (SLICE_1 §4.3): the post-hoc check that stands
// in for the isolation backend slice 1 does not have. Every in-workspace
// change between the opening and closing manifests must be explained by an
// effect AVL authorized, or it is reported as unmediated.
//
// Limits, stated rather than implied:
//   - it compares two snapshots, so a change made and reverted between them
//     is invisible, and paths the contract ignores are never seen;
//   - changes outside the workspace are undetectable (S7 is predicted FAIL);
//   - authorized writes and deletes are matched separately, not replayed in
//     order, so a path written, deleted by AVL and then recreated with the
//     written bytes by something else reads as explained;
//   - after an approved arbitrary host command, a change it could have made
//     is "opaque": unverifiable, but not evidence of a bypass.

import { matchesAny } from "./paths.ts";

export type Change = "created" | "modified" | "deleted";

export interface ReconcileInput {
  before: ReadonlyMap<string, string>;
  after: ReadonlyMap<string, string>;
  /** Authorized fs.write effects that completed, in the order performed. */
  fsWrites: readonly { path: string; sha256: string }[];
  /** Paths removed by authorized fs.delete effects. */
  fsDeletes: readonly string[];
  /** Declared globs of every command that executed. */
  commandGlobs: readonly { writes: readonly string[]; deletes: readonly string[] }[];
  /** An approved arbitrary host command ran; its effects cannot be enumerated. */
  hostExecRan: boolean;
  /** Paths a host wrote or edited under authorization; GRU cannot know the final bytes. */
  hostWrites: readonly string[];
}

export interface Reconciliation {
  explained: string[];
  opaque: string[];
  unexplained: { path: string; change: Change }[];
}

function changeOf(before: string | undefined, after: string | undefined): Change | null {
  if (before === undefined) return after === undefined ? null : "created";
  if (after === undefined) return "deleted";
  return before === after ? null : "modified";
}

export function reconcile(input: ReconcileInput): Reconciliation {
  const lastWrite = new Map<string, string>();
  for (const write of input.fsWrites) lastWrite.set(write.path, write.sha256);
  const deleted = new Set(input.fsDeletes);
  const hostWritten = new Set(input.hostWrites);

  const explained: string[] = [];
  const opaque: string[] = [];
  const unexplained: { path: string; change: Change }[] = [];

  const paths = new Set([...input.before.keys(), ...input.after.keys()]);
  for (const path of [...paths].sort()) {
    const change = changeOf(input.before.get(path), input.after.get(path));
    if (change === null) continue;
    let ok: boolean;
    if (change === "deleted") {
      ok = deleted.has(path) || input.commandGlobs.some((command) => matchesAny(path, command.deletes));
    } else {
      ok =
        (lastWrite.has(path) && lastWrite.get(path) === input.after.get(path)) ||
        input.commandGlobs.some((command) => matchesAny(path, command.writes)) ||
        hostWritten.has(path);
    }
    if (ok) explained.push(path);
    else if (input.hostExecRan) opaque.push(path);
    else unexplained.push({ path, change });
  }
  return { explained, opaque, unexplained };
}
