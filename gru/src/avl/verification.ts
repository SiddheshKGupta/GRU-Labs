// The verification strength ladder (SLICE_1 §4.4, Core schema §5.1).
//
// Strength says how much an outcome can be trusted, not what the outcome
// was. It is computed only from facts AVL itself observed -- which checks
// it ran, what they exited with, whether protected files moved -- and a
// model's text can lift it no higher than ASSERTED, which no floor accepts.
//
// Limit: INDEPENDENT means "no file matched by the contract's protected
// globs changed". If the Director protects nothing, or protects the wrong
// files, that condition holds vacuously; this module cannot tell.

import { STRENGTHS, type Classification, type Strength } from "../types.ts";

const FLOORS: Readonly<Record<Classification, Strength>> = Object.freeze({
  MICRO: "CHECKED",
  MATERIAL: "INDEPENDENT",
  PROGRAM: "INDEPENDENT",
});

export function isStrength(value: unknown): value is Strength {
  return typeof value === "string" && (STRENGTHS as readonly string[]).includes(value);
}

export function floorFor(classification: Classification): Strength {
  const floor = FLOORS[classification];
  if (floor === undefined) throw new Error(`unknown classification ${String(classification)}`);
  return floor;
}

export function rank(strength: Strength): number {
  const index = (STRENGTHS as readonly string[]).indexOf(strength);
  if (index === -1) throw new Error(`unknown verification strength ${String(strength)}`);
  return index;
}

export function atLeast(actual: Strength, required: Strength): boolean {
  return rank(actual) >= rank(required);
}

/** max(floor, required_strength): a contract may raise the floor, and even a malformed one cannot lower it. */
export function requiredFor(contract: {
  classification: Classification;
  verification: { required_strength: Strength | null };
}): Strength {
  const floor = floorFor(contract.classification);
  const raised = contract.verification.required_strength;
  return raised !== null && rank(raised) > rank(floor) ? raised : floor;
}

export interface StrengthFacts {
  checks_declared: boolean;
  all_checks_passed: boolean;
  protected_unchanged: boolean;
  must_fail_declared: boolean;
  all_must_fail_failed: boolean;
  /** A model (or anyone other than AVL) stated an outcome. */
  asserted: boolean;
}

export function computeStrength(facts: StrengthFacts): Strength {
  if (!facts.checks_declared) return facts.asserted ? "ASSERTED" : "NONE";
  // A failed check still ran; the FAIL outcome is decided separately, so a
  // failing episode is not stronger evidence than CHECKED.
  if (!facts.all_checks_passed || !facts.protected_unchanged) return "CHECKED";
  if (!facts.must_fail_declared || !facts.all_must_fail_failed) return "INDEPENDENT";
  return "ADVERSARIAL";
}
