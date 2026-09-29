import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAdmissibility } from "../src/ledger/admissibility.ts";
import { Ledger, type EventType, type LedgerEvent } from "../src/ledger/ledger.ts";
import { MemoryStore } from "../src/ledger/store.ts";

const clock = () => new Date("2026-09-29T00:00:00.000Z");

function chain(entries: [EventType, unknown][]): LedgerEvent[] {
  const ledger = new Ledger("ep_test", new MemoryStore(), clock);
  for (const [type, body] of entries) ledger.append(type, body);
  return [...ledger.events];
}

const PROVENANCE = {
  gru_version: "0.1.0",
  route: null,
  contract_digest: "c".repeat(64),
  capability_set_digest: "k".repeat(64),
  environment_digest: "e".repeat(64),
};

interface Shape {
  classification?: string;
  provenance?: Record<string, unknown>;
  strength?: string;
  required?: string;
  evidenceRef?: string;
  status?: string | null;
  verification?: boolean;
  extra?: [EventType, unknown][];
}

function episode(shape: Shape = {}): LedgerEvent[] {
  const entries: [EventType, unknown][] = [
    [
      "episode.opened",
      {
        contract: { classification: shape.classification ?? "MICRO", verification: { required_strength: null } },
        provenance: shape.provenance ?? PROVENANCE,
      },
    ],
    ["evidence", { evidence_id: "e1" }],
  ];
  if (shape.verification !== false) {
    entries.push([
      "verification",
      {
        outcome: "PASS",
        strength: shape.strength ?? "CHECKED",
        required: shape.required ?? "CHECKED",
        checks: [{ id: "unit", exit_code: 0, passed: true, evidence_ref: shape.evidenceRef ?? "e1" }],
        must_fail: [],
        protected_unchanged: true,
      },
    ]);
  }
  entries.push(...(shape.extra ?? []));
  if (shape.status !== null) entries.push(["closure", { status: shape.status ?? "PASS", rationale: "test" }]);
  return chain(entries);
}

const override: [EventType, unknown] = [
  "director.override",
  { actor: "director:alice", reason: "shipping with the known failure", decision: "PROCEED", residual_risk: "ACCEPTED" },
];

describe("computeAdmissibility verdicts", () => {
  it("ADMISSIBLE_POSITIVE: every condition passes and closure is PASS", () => {
    const result = computeAdmissibility(episode());
    assert.equal(result.verdict, "ADMISSIBLE_POSITIVE");
    assert.equal(result.computed_by, "gru-admissibility@0.1.0");
    assert.deepEqual(Object.keys(result.conditions).sort(), [
      "environment_recorded",
      "identity_recorded",
      "intervention_explained",
      "no_evidence_gap",
      "no_policy_violation",
      "outcome_resolved",
      "trace_complete",
      "verification_sufficient",
    ]);
    assert.ok(Object.values(result.conditions).every((value) => value === "PASS"));
  });

  it("ADMISSIBLE_NEGATIVE: a verified failure is admissible", () => {
    assert.equal(computeAdmissibility(episode({ status: "FAIL" })).verdict, "ADMISSIBLE_NEGATIVE");
  });

  it("INADMISSIBLE: a recorded policy violation", () => {
    const result = computeAdmissibility(episode({ extra: [["violation", { kind: "UNMEDIATED_CHANGE", detail: "created x" }]] }));
    assert.equal(result.conditions.no_policy_violation, "FAIL");
    assert.equal(result.verdict, "INADMISSIBLE");
  });

  it("D1: PARTIAL and ABANDONED are UNRESOLVED, not INADMISSIBLE", () => {
    for (const status of ["PARTIAL", "ABANDONED"]) {
      const result = computeAdmissibility(episode({ status }));
      assert.equal(result.conditions.outcome_resolved, "UNDECIDABLE", status);
      assert.equal(result.verdict, "UNRESOLVED", status);
    }
  });

  it("an episode with no closure is INADMISSIBLE", () => {
    const result = computeAdmissibility(episode({ status: null }));
    assert.equal(result.conditions.outcome_resolved, "FAIL");
    assert.equal(result.verdict, "INADMISSIBLE");
  });

  it("D2: a Director override leaves the verdict unchanged", () => {
    assert.equal(computeAdmissibility(episode({ status: "FAIL", extra: [] })).verdict, "ADMISSIBLE_NEGATIVE");
    const overridden = [...episode({ status: "FAIL" })];
    const withOverride = chain([...overridden.map((event) => [event.type, event.body] as [EventType, unknown]), override]);
    assert.equal(computeAdmissibility(withOverride).verdict, "ADMISSIBLE_NEGATIVE");
    const partial = episode({ status: "PARTIAL" });
    const partialOverridden = chain([...partial.map((event) => [event.type, event.body] as [EventType, unknown]), override]);
    assert.equal(computeAdmissibility(partialOverridden).verdict, "UNRESOLVED");
  });
});

describe("computeAdmissibility conditions", () => {
  it("verification_sufficient: ASSERTED never suffices, and a missing verification fails", () => {
    assert.equal(computeAdmissibility(episode({ strength: "ASSERTED" })).conditions.verification_sufficient, "FAIL");
    assert.equal(computeAdmissibility(episode({ verification: false })).conditions.verification_sufficient, "FAIL");
  });

  it("verification_sufficient: the requirement is recomputed from the contract, not taken from the event", () => {
    // The event claims CHECKED was required, but the contract is MATERIAL.
    const result = computeAdmissibility(episode({ classification: "MATERIAL", strength: "CHECKED", required: "CHECKED" }));
    assert.equal(result.conditions.verification_sufficient, "FAIL");
    assert.equal(result.verdict, "INADMISSIBLE");
    const enough = computeAdmissibility(episode({ classification: "MATERIAL", strength: "INDEPENDENT", required: "INDEPENDENT" }));
    assert.equal(enough.conditions.verification_sufficient, "PASS");
  });

  it("trace_complete: a tampered event or a structural break fails it", () => {
    const events = episode();
    const tampered = events.map((event, index) => (index === 2 ? { ...event, body: { ...(event.body as object), strength: "ADVERSARIAL" } } : event));
    assert.equal(computeAdmissibility(tampered).conditions.trace_complete, "FAIL");
    const broken = episode({ extra: [["effect", { authorization_id: "au-9", proposal_id: "pr-9", effect_digest: "d", evidence_refs: [] }]] });
    assert.equal(computeAdmissibility(broken).conditions.trace_complete, "FAIL");
  });

  it("identity_recorded: provenance fields, route identity and every turn's served model", () => {
    const { environment_digest: _drop, ...noEnvironment } = PROVENANCE;
    const missing = computeAdmissibility(episode({ provenance: noEnvironment }));
    assert.equal(missing.conditions.identity_recorded, "FAIL");
    assert.equal(missing.conditions.environment_recorded, "FAIL");

    const routeNoModel = { ...PROVENANCE, route: { id: "r", provider: "anthropic", model: "" } };
    assert.equal(computeAdmissibility(episode({ provenance: routeNoModel })).conditions.identity_recorded, "FAIL");
    const route = { ...PROVENANCE, route: { id: "r", provider: "anthropic", model: "claude-x" } };
    assert.equal(computeAdmissibility(episode({ provenance: route })).conditions.identity_recorded, "PASS");
    const { route: _route, ...noRouteKey } = PROVENANCE;
    assert.equal(computeAdmissibility(episode({ provenance: noRouteKey })).conditions.identity_recorded, "FAIL");

    const turn = (served_model: string): [EventType, unknown] => ["model.turn", { turn: 1, served_model }];
    assert.equal(computeAdmissibility(episode({ extra: [turn("claude-x")] })).conditions.identity_recorded, "PASS");
    assert.equal(computeAdmissibility(episode({ extra: [turn("")] })).conditions.identity_recorded, "FAIL");
  });

  it("intervention_explained: a decision or override without actor or reason fails it", () => {
    const unexplained: [EventType, unknown] = ["director.override", { actor: "director:alice", reason: " " }];
    assert.equal(computeAdmissibility(episode({ extra: [override] })).conditions.intervention_explained, "PASS");
    assert.equal(computeAdmissibility(episode({ extra: [unexplained] })).conditions.intervention_explained, "FAIL");
  });

  it("no_evidence_gap: a verification result whose evidence is not recorded fails it", () => {
    const result = computeAdmissibility(episode({ evidenceRef: "never-recorded" }));
    assert.equal(result.conditions.no_evidence_gap, "FAIL");
    assert.equal(result.verdict, "INADMISSIBLE");
  });
});
