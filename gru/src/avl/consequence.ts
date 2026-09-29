// Consequence normalisation (GRU §14.1): "different technical routes that
// produce the same material project consequence should carry the same
// project-delivery obligation."
//
// Obligations attach to consequences only. Nothing below looks at which
// tool produced an effect once its consequences are known, which is what
// makes a delete through `delete_file` and a delete through a declared
// command carry the same obligation.

import type { Effect } from "./actions.ts";
import { globsMayOverlap, matchesAny } from "./paths.ts";

export const CONSEQUENCES = [
  "OBSERVE_WORKSPACE",
  "MODIFY_WORKSPACE",
  "DESTROY_WORKSPACE_DATA",
  "EXECUTE_WORKSPACE_CODE",
  "EXECUTE_UNDECLARED",
  "ALTER_VERIFICATION",
  "MUTATE_REPOSITORY",
  "EXTERNAL_SIDE_EFFECT",
] as const;

export type Consequence = (typeof CONSEQUENCES)[number];

export interface DeclaredCommand {
  id: string;
  argv: string[];
  consequences: Consequence[];
  /** Globs this command is declared to create or modify. Checked after the fact by reconciliation. */
  writes: string[];
  /** Globs this command is declared to delete. */
  deletes: string[];
  timeout_ms: number;
  env: Record<string, string>;
}

export interface ClassificationContext {
  protectedGlobs: readonly string[];
  command(id: string): DeclaredCommand | undefined;
}

export interface Obligation {
  consequence: Consequence | "RUN_DECLARED_COMMAND";
  /** Scope that satisfies the obligation, or null when only the Director can. */
  scope: string | null;
  approval: "unless-scope" | "always";
}

function unique(values: Consequence[]): Consequence[] {
  return CONSEQUENCES.filter((consequence) => values.includes(consequence));
}

function touchesProtected(globs: readonly string[], protectedGlobs: readonly string[]): boolean {
  return globs.some((glob) => protectedGlobs.some((guarded) => globsMayOverlap(glob, guarded)));
}

export function consequencesOf(effect: Effect, context: ClassificationContext): Consequence[] {
  switch (effect.kind) {
    case "fs.read":
    case "fs.list":
      return ["OBSERVE_WORKSPACE"];
    case "fs.write":
      return matchesAny(effect.path, context.protectedGlobs) ? ["ALTER_VERIFICATION"] : ["MODIFY_WORKSPACE"];
    case "fs.delete":
      return matchesAny(effect.path, context.protectedGlobs)
        ? ["DESTROY_WORKSPACE_DATA", "ALTER_VERIFICATION"]
        : ["DESTROY_WORKSPACE_DATA"];
    case "process.run": {
      const command = context.command(effect.command_id);
      if (!command) throw new Error(`undeclared command ${effect.command_id}`);
      const found: Consequence[] = [...command.consequences];
      if (command.writes.length > 0) found.push("MODIFY_WORKSPACE");
      if (command.deletes.length > 0) found.push("DESTROY_WORKSPACE_DATA");
      if (touchesProtected([...command.writes, ...command.deletes], context.protectedGlobs)) {
        found.push("ALTER_VERIFICATION");
      }
      return unique(found);
    }
    // An arbitrary host command string can do anything the user can, so it
    // carries the strongest obligation rather than a guessed one.
    case "host.exec":
    case "host.other":
      return ["EXECUTE_UNDECLARED"];
    case "host.fetch":
      return ["EXTERNAL_SIDE_EFFECT"];
  }
}

const TABLE: Readonly<Record<Consequence, { scope: string | null; approval: Obligation["approval"] }>> = {
  OBSERVE_WORKSPACE: { scope: "workspace:read", approval: "unless-scope" },
  MODIFY_WORKSPACE: { scope: "workspace:write", approval: "unless-scope" },
  DESTROY_WORKSPACE_DATA: { scope: "workspace:delete", approval: "unless-scope" },
  EXECUTE_WORKSPACE_CODE: { scope: null, approval: "unless-scope" },
  EXECUTE_UNDECLARED: { scope: null, approval: "always" },
  ALTER_VERIFICATION: { scope: null, approval: "always" },
  MUTATE_REPOSITORY: { scope: null, approval: "always" },
  EXTERNAL_SIDE_EFFECT: { scope: null, approval: "always" },
};

export function obligationsFor(effect: Effect, consequences: readonly Consequence[]): Obligation[] {
  const result: Obligation[] = [];
  if (effect.kind === "process.run") {
    result.push({ consequence: "RUN_DECLARED_COMMAND", scope: `command:${effect.command_id}`, approval: "unless-scope" });
  }
  for (const consequence of consequences) {
    const row = TABLE[consequence];
    // EXECUTE_WORKSPACE_CODE is satisfied by the command scope pushed above.
    if (consequence === "EXECUTE_WORKSPACE_CODE") continue;
    result.push({ consequence, scope: row.scope, approval: row.approval });
  }
  return result;
}

export interface Evaluation {
  verdict: "ALLOW" | "ESCALATE";
  reasons: string[];
  grantRefs: string[];
}

export function evaluate(obligations: readonly Obligation[], held: ReadonlyMap<string, string>): Evaluation {
  const reasons: string[] = [];
  const grantRefs = new Set<string>();
  for (const obligation of obligations) {
    if (obligation.approval === "always") {
      reasons.push(`${obligation.consequence} always requires Project Director approval`);
      continue;
    }
    const grant = obligation.scope === null ? undefined : held.get(obligation.scope);
    if (grant === undefined) {
      reasons.push(`${obligation.consequence} needs scope ${obligation.scope}, which no active grant holds`);
    } else {
      grantRefs.add(grant);
    }
  }
  return {
    verdict: reasons.length === 0 ? "ALLOW" : "ESCALATE",
    reasons: reasons.length === 0 ? ["every obligation is met by an active grant"] : reasons,
    grantRefs: [...grantRefs].sort(),
  };
}

export function isConsequence(value: unknown): value is Consequence {
  return typeof value === "string" && (CONSEQUENCES as readonly string[]).includes(value);
}
