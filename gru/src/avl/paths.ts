// Lexical path rules. Filesystem resolution (symlinks, realpath) happens in
// the executor at both authorization and execution time; this module only
// decides whether a model-supplied string is a well-formed workspace path.

import { posix } from "node:path";

export class PathError extends Error {
  override name = "PathError";
}

export function normaliseWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) throw new PathError("path must be a non-empty string");
  if (input.length > 1024) throw new PathError("path longer than 1024 characters");
  if (input.includes("\0")) throw new PathError("path contains NUL");
  if (input.includes("\\")) throw new PathError("backslashes are not accepted; use / separators");
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw new PathError("absolute paths are not accepted");
  const normalised = posix.normalize(input).replace(/\/+$/, "");
  if (normalised === ".." || normalised.startsWith("../")) throw new PathError("path escapes the workspace");
  if (normalised === "" || normalised === ".") return ".";
  return normalised.replace(/^\.\//, "");
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const segmentStart = index === 0 || glob[index - 1] === "/";
        index++;
        if (segmentStart && glob[index + 1] === "/") {
          source += "(?:.*/)?";
          index++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += (char ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith("/**") && path === glob.slice(0, -3)) return true;
  return globToRegExp(glob).test(path);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

/** The literal directory prefix of a glob, up to its first wildcard. */
function literalPrefix(glob: string): string {
  const wildcard = glob.search(/[*?]/);
  return wildcard === -1 ? glob : glob.slice(0, wildcard);
}

/**
 * Whether two globs could match a common path. Deliberately conservative:
 * it compares literal prefixes, so `**` overlaps everything and
 * `coverage/**` does not overlap `test/**`. A false positive costs a
 * Director prompt; a false negative would let a declared command rewrite a
 * protected file without one.
 */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
