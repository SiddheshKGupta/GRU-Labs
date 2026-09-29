// Host tool call -> GRU Effect (pure).
//
// Why: under Claude Code the host performs its own tool calls. A PreToolUse
// hook lets AVL decide them first, but AVL only understands typed effects,
// so each host tool is mapped to the effect it will have. Where the mapping
// is uncertain it errs toward the stronger obligation: an unknown tool, a
// malformed input, or a path outside the workspace becomes `host.other`
// (EXECUTE_UNDECLARED, Director approval always), never a guessed fs.* effect.
//
// Honest limits:
// - Containment is lexical (path.relative against the workspace root as the
//   host names it). A symlink inside the workspace that points outside is
//   not seen here; a workspace root reached through a symlink makes host
//   paths look outside, which fails toward host.other.
// - A Bash command that equals a declared command's argv maps to
//   process.run, but the host runs it through its own shell, environment and
//   PATH (including any shell functions it snapshots), not GRU's scrubbed
//   executor. The match proves the argv, not the process.
// - Edit / MultiEdit / NotebookEdit: a pre-hook cannot know the final file
//   content, so content_sha256 hashes the edit request and bytes is 0.
// - Codex: the Escapement adapter this was built from shows Codex hooks only
//   for SessionStart, UserPromptSubmit and Stop, with no pre-tool event and
//   no evidence of Codex's tool names. So under Codex every tool maps to
//   host.other (strongest obligation) and, in practice, Codex's built-in
//   shell and patch tools are not mediated at all; the governed path under
//   Codex is GRU's MCP server only.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Effect } from "../avl/actions.ts";
import { normaliseWorkspacePath } from "../avl/paths.ts";
import { canonical, sha256 } from "../ledger/canonical.ts";

export type Host = "claude-code" | "codex";
export const HOSTS: readonly Host[] = ["claude-code", "codex"];

export function isHost(value: unknown): value is Host {
  return value === "claude-code" || value === "codex";
}

export interface HostMapContext {
  /** Absolute workspace root, spelled the way the host spells paths. */
  workspaceRoot: string;
  declaredCommands: readonly { id: string; argv: readonly string[] }[];
  /** The host's current directory for this call, when the hook payload carries one. */
  cwd?: string;
}

export type HostMapping = { kind: "effect"; effect: Effect } | { kind: "passthrough"; reason: string };

/** Claude Code names MCP tools mcp__<server>__<tool>; GRU installs its server as "gru". */
export const GRU_MCP_PREFIX = "mcp__gru__";

/** Pure bookkeeping: no workspace, process or network consequence. Kept deliberately small. */
const BOOKKEEPING: ReadonlySet<string> = new Set(["TodoWrite"]);

/**
 * Anything a shell would interpret rather than pass through as a literal
 * argv word. Beyond the obvious operators this includes quotes (a quoted
 * word is not whitespace-split), `[ ]` and `~` (globbing and expansion),
 * `#` (comments) and `\r`.
 */
const SHELL_META = /[;|&$`<>(){}*?!\\\n\r'"[\]~#]/;

export function inputDigest(input: unknown): string {
  return sha256(canonical(input === undefined ? null : input));
}

function other(tool: string, input: unknown): HostMapping {
  return { kind: "effect", effect: { kind: "host.other", tool, input_sha256: inputDigest(input) } };
}

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** Workspace-relative path for a host path, or null when it is outside the root or not well formed. */
export function workspacePath(raw: unknown, ctx: HostMapContext): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) return null;
  if (!isAbsolute(ctx.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path");
  const base = ctx.cwd !== undefined && isAbsolute(ctx.cwd) ? ctx.cwd : ctx.workspaceRoot;
  const inside = relative(resolve(ctx.workspaceRoot), resolve(base, raw));
  if (inside === "") return ".";
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  try {
    return normaliseWorkspacePath(inside.split(sep).join("/"));
  } catch {
    return null;
  }
}

function sameDirectory(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === "";
}

function mapBash(input: unknown, ctx: HostMapContext): HostMapping {
  const fields = record(input);
  const command = fields?.command;
  if (typeof command !== "string" || command.trim().length === 0) return other("Bash", input);
  const exec: HostMapping = { kind: "effect", effect: { kind: "host.exec", tool: "Bash", command } };
  if (SHELL_META.test(command)) return exec;
  // A declared command is declared to run in the workspace root.
  if (ctx.cwd !== undefined && !sameDirectory(ctx.cwd, ctx.workspaceRoot)) return exec;
  const words = command.trim().split(/\s+/);
  // "NAME=value cmd" is an assignment to a shell, but a program name to an argv executor.
  if (words[0]?.includes("=")) return exec;
  const match = ctx.declaredCommands.find(
    (declared) => declared.argv.length === words.length && declared.argv.every((word, index) => word === words[index]),
  );
  return match ? { kind: "effect", effect: { kind: "process.run", command_id: match.id } } : exec;
}

function pathEffect(
  tool: string,
  input: unknown,
  field: string,
  ctx: HostMapContext,
  build: (path: string, fields: Record<string, unknown>) => Effect | null,
): HostMapping {
  const fields = record(input);
  if (!fields) return other(tool, input);
  const path = workspacePath(fields[field], ctx);
  if (path === null) return other(tool, input);
  const effect = build(path, fields);
  return effect ? { kind: "effect", effect } : other(tool, input);
}

/** A glob pattern that could reach outside its search root. */
function patternEscapes(pattern: unknown): boolean {
  if (typeof pattern !== "string") return true;
  return pattern.startsWith("/") || pattern.startsWith("~") || /(^|[/\\])\.\.([/\\]|$)/.test(pattern);
}

function mapClaudeCode(tool: string, input: unknown, ctx: HostMapContext): HostMapping {
  if (tool.startsWith(GRU_MCP_PREFIX)) {
    return { kind: "passthrough", reason: "GRU's own MCP tool; AVL gates it inside the MCP server (no double mediation)" };
  }
  if (BOOKKEEPING.has(tool)) {
    return { kind: "passthrough", reason: `${tool} is pure bookkeeping with no workspace, process or network effect` };
  }
  switch (tool) {
    case "Read":
      return pathEffect(tool, input, "file_path", ctx, (path) => ({ kind: "fs.read", path }));
    case "Write":
      return pathEffect(tool, input, "file_path", ctx, (path, fields) => {
        if (path === "." || typeof fields.content !== "string") return null;
        const content = fields.content;
        return { kind: "fs.write", path, content_sha256: sha256(content), bytes: new TextEncoder().encode(content).length };
      });
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      // The final content is unknown before the host applies the edit, so
      // the digest covers the edit request itself and bytes is 0.
      return pathEffect(tool, input, tool === "NotebookEdit" ? "notebook_path" : "file_path", ctx, (path) =>
        path === "." ? null : { kind: "fs.write", path, content_sha256: inputDigest(input), bytes: 0 },
      );
    case "Glob":
    case "Grep":
    case "LS": {
      const fields = record(input);
      if (!fields) return other(tool, input);
      if (tool === "Glob" && patternEscapes(fields.pattern)) return other(tool, input);
      const root = fields.path === undefined || fields.path === null || fields.path === "" ? "." : fields.path;
      const path = workspacePath(root, ctx);
      return path === null ? other(tool, input) : { kind: "effect", effect: { kind: "fs.list", path } };
    }
    case "Bash":
      return mapBash(input, ctx);
    case "WebFetch":
    case "WebSearch": {
      const target = record(input)?.[tool === "WebFetch" ? "url" : "query"];
      if (typeof target !== "string" || target.length === 0) return other(tool, input);
      return { kind: "effect", effect: { kind: "host.fetch", tool, url: target } };
    }
    default:
      return other(tool, input);
  }
}

export function mapHostTool(host: Host, toolName: string, toolInput: unknown, ctx: HostMapContext): HostMapping {
  if (host === "claude-code") return mapClaudeCode(toolName, toolInput, ctx);
  // Codex: no evidenced tool names or pre-tool hook (see header), so no mapping is guessed.
  return other(toolName, toolInput);
}
