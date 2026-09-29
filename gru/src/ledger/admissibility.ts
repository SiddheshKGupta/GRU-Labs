// Corpus admission (Core schema §5, with the v0.2 verdict names and spec
// decisions D1/D2): can this episode enter a learning corpus, and as what?
//
// Computed from recorded events alone, never asserted. It deliberately
// does not import the session: `gru verify` must reach the same verdict
// from a ledger file as closure reached in-process, and a condition that
// needed session state would be one the ledger cannot vouch for. Every
// condition is mechanical; one that would need judgement is UNDECIDABLE.
//
// Limit: it trusts the event bodies as recorded. trace_complete catches a
// broken chain, but a consistent rewrite of the whole ledger is not
// detectable here (see ledger.ts).

import type { AdmissibilityVerdict, Classification, ConditionResult, Strength } from "../types.ts";
import { floorFor, isStrength, rank } from "../avl/verification.ts";
import type { Json } from "./canonical.ts";
import type { LedgerEvent } from "./ledger.ts";
import { verifyChain, verifyStructure } from "./validate.ts";

export const ADMISSIBILITY_CHECKER = "gru-admissibility@0.1.0";

export interface Admissibility {
  verdict: AdmissibilityVerdict;
  conditions: Record<string, ConditionResult>;
  computed_by: typeof ADMISSIBILITY_CHECKER;
}

type Body = { [key: string]: Json };

function record(value: Json | undefined): Body | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function filled(body: Body | null, key: string): boolean {
  const value = body?.[key];
  return typeof value === "string" && value.trim().length > 0;
}

function find(events: readonly LedgerEvent[], type: LedgerEvent["type"], from: "first" | "last"): Body | null {
  const found = from === "first" ? events.find((event) => event.type === type) : events.findLast((event) => event.type === type);
  return found === undefined ? null : (record(found.body) ?? {});
}

/** The requirement the contract implies, recomputed rather than taken from the verification event. */
function requiredFromContract(opened: Body | null): Strength | null {
  const contract = record(opened?.contract);
  const classification = contract?.classification;
  if (classification !== "MICRO" && classification !== "MATERIAL" && classification !== "PROGRAM") return null;
  const floor = floorFor(classification as Classification);
  const raised = record(contract?.verification)?.required_strength;
  return isStrength(raised) && rank(raised) > rank(floor) ? raised : floor;
}

function verificationSufficient(opened: Body | null, verification: Body | null): ConditionResult {
  const strength = verification?.strength;
  const recorded = verification?.required;
  if (!isStrength(strength)) return "FAIL";
  const candidates = [requiredFromContract(opened), isStrength(recorded) ? recorded : null].filter(
    (candidate): candidate is Strength => candidate !== null,
  );
  if (candidates.length === 0) return "FAIL";
  const required = candidates.reduce((high, candidate) => (rank(candidate) > rank(high) ? candidate : high));
  return rank(strength) >= rank(required) ? "PASS" : "FAIL";
}

function identityRecorded(opened: Body | null, events: readonly LedgerEvent[]): ConditionResult {
  const provenance = record(opened?.provenance);
  if (provenance === null) return "FAIL";
  for (const key of ["gru_version", "contract_digest", "capability_set_digest", "environment_digest"]) {
    if (!filled(provenance, key)) return "FAIL";
  }
  if (!Object.hasOwn(provenance, "route")) return "FAIL";
  if (provenance.route !== null) {
    const route = record(provenance.route);
    if (!filled(route, "provider") || !filled(route, "model")) return "FAIL";
  }
  const turnsNamed = events
    .filter((event) => event.type === "model.turn")
    .every((event) => filled(record(event.body), "served_model"));
  return turnsNamed ? "PASS" : "FAIL";
}

function interventionExplained(events: readonly LedgerEvent[]): ConditionResult {
  const explained = events
    .filter((event) => event.type === "director.decision" || event.type === "director.override")
    .every((event) => filled(record(event.body), "actor") && filled(record(event.body), "reason"));
  return explained ? "PASS" : "FAIL";
}

function noEvidenceGap(events: readonly LedgerEvent[]): ConditionResult {
  const evidence = new Set(
    events
      .filter((event) => event.type === "evidence")
      .map((event) => record(event.body)?.evidence_id)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const event of events) {
    if (event.type !== "verification") continue;
    const body = record(event.body);
    for (const key of ["checks", "must_fail"]) {
      const entries = body?.[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) return "FAIL";
      for (const entry of entries) {
        const ref = record(entry)?.evidence_ref;
        if (typeof ref !== "string" || !evidence.has(ref)) return "FAIL";
      }
    }
  }
  return "PASS";
}

export function computeAdmissibility(recorded: readonly LedgerEvent[]): Admissibility {
  // A malformed entry fails trace_complete below; the other conditions read what is well-formed.
  const events = recorded.filter((event) => typeof event === "object" && event !== null);
  const opened = find(events, "episode.opened", "first");
  const closure = find(events, "closure", "last");
  const verification = find(events, "verification", "last");
  const status = closure?.status;

  const conditions: Record<string, ConditionResult> = {
    // D1: PARTIAL and ABANDONED are unresolved outcomes, not failed conditions.
    outcome_resolved:
      status === "PASS" || status === "FAIL"
        ? "PASS"
        : status === "PARTIAL" || status === "ABANDONED"
          ? "UNDECIDABLE"
          : "FAIL",
    verification_sufficient: verificationSufficient(opened, verification),
    trace_complete: verifyChain(recorded).length === 0 && verifyStructure(recorded).length === 0 ? "PASS" : "FAIL",
    identity_recorded: identityRecorded(opened, events),
    intervention_explained: interventionExplained(events),
    environment_recorded: filled(record(opened?.provenance), "environment_digest") ? "PASS" : "FAIL",
    no_evidence_gap: noEvidenceGap(events),
    no_policy_violation: events.some((event) => event.type === "violation") ? "FAIL" : "PASS",
  };

  const results = Object.values(conditions);
  // D2: nothing above reads director.override except to check it was
  // explained, so an override cannot turn a FAIL into a positive record.
  let verdict: AdmissibilityVerdict;
  if (results.includes("FAIL")) verdict = "INADMISSIBLE";
  else if (results.includes("UNDECIDABLE")) verdict = "UNRESOLVED";
  else verdict = status === "PASS" ? "ADMISSIBLE_POSITIVE" : "ADMISSIBLE_NEGATIVE";

  return { verdict, conditions, computed_by: ADMISSIBILITY_CHECKER };
}
