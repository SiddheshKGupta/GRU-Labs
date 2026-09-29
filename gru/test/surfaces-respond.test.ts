import assert from "node:assert/strict";
import { test } from "node:test";
import {
  toClaudeFailure,
  toClaudePassthrough,
  toClaudePreToolUse,
  toSessionStart,
  UNGOVERNED_WARNING,
  unreachableOutput,
  type ClaudePreToolUseOutput,
} from "../src/hooks/respond.ts";
import type { HostDecision } from "../src/types.ts";
import { fakeContract, UNSAFE } from "./surfaces-fake-session.ts";

const decision = (verdict: HostDecision["verdict"]): HostDecision => ({
  authorization_id: "auth-1",
  verdict,
  reasons: ["EXECUTE_UNDECLARED always requires Project Director approval"],
  consequences: ["EXECUTE_UNDECLARED"],
});

test("respond: ALLOW -> allow, DENY -> deny, ASK -> ask, with AVL's reasons and consequences", () => {
  for (const [verdict, permission] of [["ALLOW", "allow"], ["DENY", "deny"], ["ASK", "ask"]] as const) {
    const out = toClaudePreToolUse(decision(verdict)).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, permission);
    assert.match(out.permissionDecisionReason, /auth-1/);
    assert.match(out.permissionDecisionReason, /EXECUTE_UNDECLARED\./);
    assert.match(out.permissionDecisionReason, /always requires Project Director approval/);
  }
});

test("respond: an unreachable daemon -> ask with the ungoverned warning, never allow", () => {
  assert.deepEqual(toClaudePreToolUse({ unreachable: true }), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "GRU AVL is not reachable: this action is NOT governed or recorded",
    },
  });
  const fallback = unreachableOutput("claude-code", "PreToolUse") as ClaudePreToolUseOutput;
  assert.equal(fallback.hookSpecificOutput.permissionDecision, "ask");
  assert.equal(fallback.hookSpecificOutput.permissionDecisionReason, UNGOVERNED_WARNING);
});

test("respond: an unrecognised verdict -> ask", () => {
  const odd = { ...decision("ALLOW"), verdict: "ESCALATE" } as unknown as HostDecision;
  assert.equal(toClaudePreToolUse(odd).hookSpecificOutput.permissionDecision, "ask");
  const proto = { ...decision("ALLOW"), verdict: "toString" } as unknown as HostDecision;
  assert.equal(toClaudePreToolUse(proto).hookSpecificOutput.permissionDecision, "ask");
});

test("respond: passthrough allows and says why; failure asks and says it is ungoverned", () => {
  const pass = toClaudePassthrough("GRU's own MCP tool").hookSpecificOutput;
  assert.equal(pass.permissionDecision, "allow");
  assert.equal(pass.permissionDecisionReason, "not an effect GRU governs: GRU's own MCP tool");
  const failed = toClaudeFailure("kernel error").hookSpecificOutput;
  assert.equal(failed.permissionDecision, "ask");
  assert.match(failed.permissionDecisionReason, /NOT governed or recorded/);
});

test("respond: SessionStart banner carries episode, safety with unmet properties, task and how to finish", () => {
  const out = toSessionStart({ episode_id: "ep-1", safety: UNSAFE, contract: fakeContract() }).hookSpecificOutput;
  assert.equal(out.hookEventName, "SessionStart");
  for (const part of ["ep-1", "UNSAFE_DEVELOPMENT", "P1, P2, P8", fakeContract().task, "gru_verify_and_close"]) {
    assert.ok(out.additionalContext.includes(part), part);
  }
});

test("respond: events other than Claude Code PreToolUse fall back to {}", () => {
  assert.deepEqual(unreachableOutput("claude-code", "PostToolUse"), {});
  assert.deepEqual(unreachableOutput("claude-code", "SessionStart"), {});
  assert.deepEqual(unreachableOutput("codex", "SessionStart"), {});
  assert.deepEqual(unreachableOutput("codex", "PreToolUse"), {});
});
