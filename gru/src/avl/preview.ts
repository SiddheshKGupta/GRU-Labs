// What the Director sees before approving an escalated action.
//
// Built by AVL (T1) from the parsed effect, the exact payload whose sha256
// the effect carries, and the binding AVL resolved -- never from the
// Minion's description of what it is doing. The gate re-checks the digest
// at execution, so the bytes previewed are the bytes that run or nothing
// runs. Payload text is Minion-authored: surfaces must render it as text.

import type { Binding } from "./gate.ts";
import type { Effect } from "./actions.ts";
import type { DeclaredCommand } from "./consequence.ts";

export const PREVIEW_MAX_LINES = 60;
export const PREVIEW_MAX_CHARS = 4000;

function excerpt(payload: string): string {
  const lines = payload.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown: string[] = [];
  let chars = 0;
  for (const [index, line] of lines.entries()) {
    if (index >= PREVIEW_MAX_LINES || chars + line.length > PREVIEW_MAX_CHARS) break;
    shown.push(`${String(index + 1).padStart(4)} | ${line}`);
    chars += line.length + 1;
  }
  const hidden = lines.length - shown.length;
  return hidden > 0 ? `${shown.join("\n")}\n     ... ${hidden} more line${hidden === 1 ? "" : "s"} not shown` : shown.join("\n");
}

export function effectPreview(effect: Effect, payload: string | undefined, binding: Binding, command?: DeclaredCommand): string {
  switch (effect.kind) {
    case "fs.write": {
      const text = payload ?? "";
      const bytes = new TextEncoder().encode(text).length;
      const action = binding.target_exists === true ? "replaces the existing file" : "creates a new file";
      return `write ${effect.path}: ${action}, ${bytes} bytes, sha256 ${effect.content_sha256.slice(0, 16)}...\n${excerpt(text)}`;
    }
    case "fs.delete":
      return `delete ${effect.path}`;
    case "process.run":
      return `run ${effect.command_id}: argv ${JSON.stringify(command?.argv ?? [])}`;
    default:
      return `${effect.kind} ${JSON.stringify(effect)}`;
  }
}
