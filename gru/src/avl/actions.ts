// ProjectAction semantics (GRU §14): the tools a Minion may propose, and
// the parser that turns a model's tool call into exactly one typed effect.
//
// Tool input is T3 output. It is validated here field by field; nothing
// reaches classification or an executor without passing through
// parseToolCall. There is deliberately no tool that takes a command string
// or arguments: a Minion names a Director-declared command and nothing else
// (v1 PR #60, slice-1 spec D4).

import { sha256 } from "../ledger/canonical.ts";
import { normaliseWorkspacePath } from "./paths.ts";

export type Effect =
  | { kind: "fs.read"; path: string }
  | { kind: "fs.list"; path: string }
  | { kind: "fs.write"; path: string; content_sha256: string; bytes: number }
  | { kind: "fs.delete"; path: string }
  | { kind: "process.run"; command_id: string }
  // Host mode: the effect is performed by Claude Code or Codex, not by GRU.
  // AVL decides and records; it cannot bind or execute these itself.
  | { kind: "host.exec"; tool: string; command: string }
  | { kind: "host.fetch"; tool: string; url: string }
  | { kind: "host.other"; tool: string; input_sha256: string };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: "string"; description: string; enum?: string[] }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ParsedAction {
  effect: Effect;
  /** The bytes a write will put on disk; bound to the effect by content_sha256. */
  payload?: string;
}

export class ActionError extends Error {
  override name = "ActionError";
}

export const MAX_WRITE_CHARS = 1_000_000;

const PATH = { type: "string", description: "Workspace-relative path using / separators." } as const;

export function toolDefinitions(commandIds: readonly string[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      input_schema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
    },
    {
      name: "list_dir",
      description: "List the entries of a workspace directory. Use \".\" for the workspace root.",
      input_schema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
    },
    {
      name: "write_file",
      description: "Create or overwrite a workspace file with the given UTF-8 content.",
      input_schema: {
        type: "object",
        properties: { path: PATH, content: { type: "string", description: "Complete new file content." } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_file",
      description: "Delete one workspace file.",
      input_schema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
    },
  ];
  if (commandIds.length > 0) {
    tools.push({
      name: "run_command",
      description:
        "Run one command the Project Director declared for this task, by id. Commands take no arguments.",
      input_schema: {
        type: "object",
        properties: {
          command_id: { type: "string", description: "A declared command id.", enum: [...commandIds] },
        },
        required: ["command_id"],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

function fields(input: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ActionError("tool input must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new ActionError(`tool input must have exactly the fields [${wanted.join(", ")}]`);
  }
  for (const key of wanted) {
    if (typeof record[key] !== "string") throw new ActionError(`field "${key}" must be a string`);
  }
  return record;
}

export function parseToolCall(name: string, input: unknown, commandIds: readonly string[]): ParsedAction {
  switch (name) {
    case "read_file":
      return { effect: { kind: "fs.read", path: normaliseWorkspacePath(fields(input, ["path"]).path) } };
    case "list_dir":
      return { effect: { kind: "fs.list", path: normaliseWorkspacePath(fields(input, ["path"]).path) } };
    case "write_file": {
      const record = fields(input, ["path", "content"]);
      const path = normaliseWorkspacePath(record.path);
      if (path === ".") throw new ActionError("cannot write to the workspace root");
      const content = record.content as string;
      if (content.length > MAX_WRITE_CHARS) throw new ActionError(`content longer than ${MAX_WRITE_CHARS} characters`);
      const bytes = new TextEncoder().encode(content).length;
      return { effect: { kind: "fs.write", path, content_sha256: sha256(content), bytes }, payload: content };
    }
    case "delete_file": {
      const path = normaliseWorkspacePath(fields(input, ["path"]).path);
      if (path === ".") throw new ActionError("cannot delete the workspace root");
      return { effect: { kind: "fs.delete", path } };
    }
    case "run_command": {
      const id = fields(input, ["command_id"]).command_id as string;
      if (!commandIds.includes(id)) throw new ActionError(`"${id}" is not a declared command`);
      return { effect: { kind: "process.run", command_id: id } };
    }
    default:
      throw new ActionError(`unknown tool "${name}"`);
  }
}
