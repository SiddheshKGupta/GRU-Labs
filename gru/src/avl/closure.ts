// Truthful closure (SLICE_1 §4.4). The status is a pure function of what
// AVL recorded: the loop outcome, the verification it ran itself, and the
// policy violations it found. Nothing a model says is an input, which is
// the whole of v1's truthful-closure rule: "done" is not evidence.
//
// A Director override is not an input either (§7): it is appended after
// closure as an intervention and never edits the status.

import type { ClosureStatus, LoopOutcome, VerificationOutcome } from "../types.ts";
import { atLeast } from "./verification.ts";

export interface ClosureInput {
  loop: LoopOutcome;
  verification: VerificationOutcome;
  violations: readonly string[];
}

export interface ClosureDecision {
  status: ClosureStatus;
  rationale: string;
}

const LOOP_FINISHED: readonly LoopOutcome[] = ["COMPLETED", "HOST_ENDED"];
const LOOP_GAVE_UP: readonly LoopOutcome[] = ["REFUSED", "ROUTE_ERROR", "KERNEL_ERROR"];

export function decideClosure(input: ClosureInput): ClosureDecision {
  const { loop, verification, violations } = input;
  const { outcome, strength, required } = verification;

  if (violations.length > 0) {
    return {
      status: "FAIL",
      rationale:
        `FAIL: ${violations.length} policy violation(s) recorded, the first being "${violations[0]}"; ` +
        "a violation fails closure whatever the checks say.",
    };
  }
  if (outcome === "FAIL") {
    const failed = verification.checks.filter((check) => !check.passed).map((check) => check.id);
    const passedMustFail = verification.must_fail.filter((check) => check.exit_code === 0).map((check) => check.id);
    return {
      status: "FAIL",
      rationale:
        `FAIL: verification outcome FAIL; failed checks [${failed.join(", ")}], ` +
        `must-fail checks that passed [${passedMustFail.join(", ")}].`,
    };
  }
  if (LOOP_GAVE_UP.includes(loop) && outcome !== "PASS") {
    return {
      status: "ABANDONED",
      rationale: `ABANDONED: the loop ended ${loop} and verification outcome was ${outcome}, so nothing was verified.`,
    };
  }
  if (outcome === "NOT_RUN") {
    return {
      status: "PARTIAL",
      rationale: `PARTIAL: verification outcome NOT_RUN (no checks declared); strength ${strength} vs required ${required}.`,
    };
  }
  if (!atLeast(strength, required)) {
    return {
      status: "PARTIAL",
      rationale: `PARTIAL: checks passed but strength ${strength} is below required ${required}.`,
    };
  }
  if (!LOOP_FINISHED.includes(loop)) {
    return {
      status: "PARTIAL",
      rationale:
        `PARTIAL: checks passed at strength ${strength} (required ${required}) ` +
        `but the loop ended ${loop}, not COMPLETED or HOST_ENDED.`,
    };
  }
  return {
    status: "PASS",
    rationale: `PASS: checks passed at strength ${strength} (required ${required}) and the loop ended ${loop}.`,
  };
}
