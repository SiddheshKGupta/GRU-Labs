// HostDecision -> host hook output JSON (pure).
//
// Why: the host, not GRU, performs its own tool calls, so AVL's decision
// reaches it only as hook output. Every path here is written so that no
// failure becomes a silent "allow": an unreachable daemon, a daemon error
// or a verdict this module does not recognise all become "ask", which
// keeps a human in the loop and says plainly that the action is NOT
// governed or recorded.
//
// Honest limits: "allow" tells Claude Code to skip its own permission
// prompt, so an AVL ALLOW is exactly as strong as the grant behind it.
// Codex output is limited to what the Escapement adapter evidenced: a
// SessionStart hookSpecificOutput with additionalContext, and an empty
// object for events with nothing to say. There is no Codex pre-tool output.

import type { HostDecision, SafetyMode, TaskContract } from "../types.ts";
import type { Host } from "./host-map.ts";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface ClaudePreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

export type EmptyOutput = Record<string, never>;
export type HookOutput = ClaudePreToolUseOutput | SessionStartOutput | EmptyOutput;

export const UNGOVERNED_WARNING = "GRU AVL is not reachable: this action is NOT governed or recorded";

/** Events the daemon answers, per host. Codex has no pre/post tool events (see host-map.ts). */
export const HOST_EVENTS: Readonly<Record<Host, readonly string[]>> = {
  "claude-code": ["SessionStart", "PreToolUse", "PostToolUse", "Stop"],
  codex: ["SessionStart", "Stop"],
};

const VERDICT_TO_PERMISSION: Readonly<Record<string, PermissionDecision>> = {
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
};

function preToolUse(permissionDecision: PermissionDecision, reason: string): ClaudePreToolUseOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } };
}

export function toClaudePreToolUse(decision: HostDecision | { unreachable: true }): ClaudePreToolUseOutput {
  if ("unreachable" in decision) return preToolUse("ask", UNGOVERNED_WARNING);
  const permission = Object.hasOwn(VERDICT_TO_PERMISSION, decision.verdict)
    ? VERDICT_TO_PERMISSION[decision.verdict]
    : undefined;
  if (permission === undefined) {
    return preToolUse("ask", `GRU AVL returned an unrecognised verdict (${String(decision.verdict)}); asking instead`);
  }
  const consequences = decision.consequences.length > 0 ? decision.consequences.join(", ") : "none";
  const reasons = decision.reasons.length > 0 ? decision.reasons.join("; ") : "no reason given";
  let reason = `GRU AVL ${decision.verdict} (authorization ${decision.authorization_id}). Consequences: ${consequences}. ${reasons}.`;
  if (decision.verdict === "ASK") {
    reason += " Approving is a Project Director decision for this one action; GRU records what the tool then does.";
  }
  return preToolUse(permission, reason);
}

/** A tool GRU does not govern (its own MCP tools, pure bookkeeping). */
export function toClaudePassthrough(reason: string): ClaudePreToolUseOutput {
  return preToolUse("allow", `not an effect GRU governs: ${reason}`);
}

/** The daemon was reached but could not decide (session failed to open, kernel error). */
export function toClaudeFailure(message: string): ClaudePreToolUseOutput {
  return preToolUse("ask", `GRU AVL could not decide (${message}): this action is NOT governed or recorded`);
}

export function emptyOutput(): EmptyOutput {
  return {};
}

export interface BannerInfo {
  episode_id: string;
  safety: SafetyMode;
  contract: Pick<TaskContract, "task">;
}

export function sessionBanner(info: BannerInfo): string {
  const safety =
    info.safety.mode === "GOVERNED"
      ? "GOVERNED"
      : `${info.safety.mode} (unmet: ${info.safety.unmet.join(", ") || "none listed"}; ` +
        "no isolation backend confines what declared commands run)";
  return [
    `GRU governed episode ${info.episode_id}.`,
    `Safety mode: ${safety}.`,
    `Task: ${info.contract.task}`,
    "Tool calls are decided by GRU's AVL and recorded in the episode ledger. " +
      "Prefer the gru_* tools; protected verification files need Project Director approval.",
    "Finish by calling gru_verify_and_close: it runs the Director's verification contract and returns the " +
      "truthful closure. Saying the work is done does not verify it.",
  ].join("\n");
}

/** Same shape for Claude Code and Codex: the Escapement adapter emitted this for both hosts. */
export function toSessionStart(info: BannerInfo): SessionStartOutput {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionBanner(info) } };
}

/** What the hook client prints when it cannot get an answer from the daemon. */
export function unreachableOutput(host: Host, event: string): HookOutput {
  return host === "claude-code" && event === "PreToolUse" ? toClaudePreToolUse({ unreachable: true }) : emptyOutput();
}
