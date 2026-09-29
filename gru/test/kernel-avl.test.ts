import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideClosure } from "../src/avl/closure.ts";
import { reconcile, type ReconcileInput } from "../src/avl/reconcile.ts";
import { computeSafety } from "../src/avl/safety.ts";
import { atLeast, computeStrength, floorFor, rank, requiredFor, type StrengthFacts } from "../src/avl/verification.ts";
import type { LoopOutcome, VerificationOutcome } from "../src/types.ts";

describe("verification ladder", () => {
  it("orders strengths and states the floors", () => {
    assert.ok(rank("NONE") < rank("ASSERTED") && rank("ASSERTED") < rank("CHECKED"));
    assert.ok(rank("CHECKED") < rank("INDEPENDENT") && rank("INDEPENDENT") < rank("ADVERSARIAL"));
    assert.equal(floorFor("MICRO"), "CHECKED");
    assert.equal(floorFor("MATERIAL"), "INDEPENDENT");
    assert.equal(floorFor("PROGRAM"), "INDEPENDENT");
    assert.ok(atLeast("ADVERSARIAL", "INDEPENDENT"));
    assert.ok(!atLeast("CHECKED", "INDEPENDENT"));
    assert.throws(() => rank("SURE" as never), /unknown verification strength/);
  });

  it("never lets ASSERTED meet any floor", () => {
    for (const classification of ["MICRO", "MATERIAL", "PROGRAM"] as const) {
      assert.ok(!atLeast("ASSERTED", floorFor(classification)), classification);
    }
  });

  it("requiredFor raises to required_strength and never drops below the floor", () => {
    assert.equal(requiredFor({ classification: "MICRO", verification: { required_strength: null } }), "CHECKED");
    assert.equal(requiredFor({ classification: "MICRO", verification: { required_strength: "ADVERSARIAL" } }), "ADVERSARIAL");
    // A hand-built contract that skipped the parser still cannot lower the floor.
    assert.equal(requiredFor({ classification: "MATERIAL", verification: { required_strength: "ASSERTED" } }), "INDEPENDENT");
  });

  const facts = (overrides: Partial<StrengthFacts>): StrengthFacts => ({
    checks_declared: true,
    all_checks_ran: true,
    protected_unchanged: true,
    must_fail_declared: false,
    all_must_fail_failed: true,
    asserted: false,
    ...overrides,
  });

  it("computes each rung from observed facts", () => {
    assert.equal(computeStrength(facts({ checks_declared: false })), "NONE");
    assert.equal(computeStrength(facts({ checks_declared: false, asserted: true })), "ASSERTED");
    // A check that never reached a verdict (timeout, could not start) is no evidence.
    assert.equal(computeStrength(facts({ all_checks_ran: false })), "NONE");
    assert.equal(computeStrength(facts({ all_checks_ran: false, asserted: true })), "ASSERTED");
    assert.equal(computeStrength(facts({ protected_unchanged: false })), "CHECKED");
    assert.equal(computeStrength(facts({})), "INDEPENDENT");
    assert.equal(computeStrength(facts({ must_fail_declared: true, all_must_fail_failed: false })), "INDEPENDENT");
    assert.equal(computeStrength(facts({ must_fail_declared: true })), "ADVERSARIAL");
    // A model's assertion adds nothing once checks exist.
    assert.equal(computeStrength(facts({ asserted: true })), "INDEPENDENT");
  });
});

describe("computeSafety", () => {
  it("is UNSAFE_DEVELOPMENT with every confinement property unmet when no backend is admitted", () => {
    assert.deepEqual(computeSafety([]), { mode: "UNSAFE_DEVELOPMENT", unmet: ["P1", "P2", "P8"], backends: [] });
  });

  it("lists only what the admitted backends leave unmet", () => {
    const safety = computeSafety([{ id: "seccomp", provides: ["P8", "P2"] }]);
    assert.deepEqual(safety, { mode: "UNSAFE_DEVELOPMENT", unmet: ["P1"], backends: ["seccomp"] });
  });

  it("is GOVERNED only when the union of backends covers P1, P2 and P8", () => {
    const safety = computeSafety([
      { id: "vm", provides: ["P1", "P2"] },
      { id: "net", provides: ["P8"] },
    ]);
    assert.deepEqual(safety, { mode: "GOVERNED", unmet: [], backends: ["vm", "net"] });
  });
});

describe("reconcile", () => {
  const base = (overrides: Partial<ReconcileInput>): ReconcileInput => ({
    before: new Map(),
    after: new Map(),
    fsWrites: [],
    fsDeletes: [],
    commandGlobs: [],
    hostExecRan: false,
    hostWrites: [],
    ...overrides,
  });

  it("explains a change whose final hash is the last authorized write", () => {
    const result = reconcile(
      base({
        before: new Map([["a.ts", "h0"]]),
        after: new Map([["a.ts", "h2"]]),
        fsWrites: [
          { path: "a.ts", sha256: "h1" },
          { path: "a.ts", sha256: "h2" },
        ],
      }),
    );
    assert.deepEqual(result, { explained: ["a.ts"], opaque: [], unexplained: [] });
  });

  it("flags a file reverted to an earlier write's content, because only the last write explains it", () => {
    const result = reconcile(
      base({
        before: new Map([["a.ts", "h0"]]),
        after: new Map([["a.ts", "h1"]]),
        fsWrites: [
          { path: "a.ts", sha256: "h1" },
          { path: "a.ts", sha256: "h2" },
        ],
      }),
    );
    assert.deepEqual(result.unexplained, [{ path: "a.ts", change: "modified" }]);
  });

  it("explains an authorized delete, and a command's declared writes and deletes", () => {
    const result = reconcile(
      base({
        before: new Map([
          ["gone.ts", "h"],
          ["tmp/cache", "c"],
          ["dist/old.js", "o"],
        ]),
        after: new Map([["dist/new.js", "n"]]),
        fsDeletes: ["gone.ts"],
        commandGlobs: [{ writes: ["dist/**"], deletes: ["tmp/**", "dist/**"] }],
      }),
    );
    assert.deepEqual(result, { explained: ["dist/new.js", "dist/old.js", "gone.ts", "tmp/cache"], opaque: [], unexplained: [] });
  });

  it("does not let a writes glob explain a deletion", () => {
    const result = reconcile(
      base({
        before: new Map([["dist/a.js", "h"]]),
        after: new Map(),
        commandGlobs: [{ writes: ["dist/**"], deletes: [] }],
      }),
    );
    assert.deepEqual(result.unexplained, [{ path: "dist/a.js", change: "deleted" }]);
  });

  it("reports every unexplained change with its kind, sorted", () => {
    const result = reconcile(
      base({
        before: new Map([
          ["b.ts", "1"],
          ["c.ts", "1"],
        ]),
        after: new Map([
          ["a.ts", "1"],
          ["b.ts", "2"],
        ]),
      }),
    );
    assert.deepEqual(result.unexplained, [
      { path: "a.ts", change: "created" },
      { path: "b.ts", change: "modified" },
      { path: "c.ts", change: "deleted" },
    ]);
  });

  it("explains a host write by path, since GRU cannot know the final bytes", () => {
    const result = reconcile(
      base({ before: new Map([["a.ts", "1"]]), after: new Map([["a.ts", "2"]]), hostWrites: ["a.ts"] }),
    );
    assert.deepEqual(result.explained, ["a.ts"]);
  });

  it("marks otherwise-unexplained changes opaque, not violations, after an approved host command", () => {
    const result = reconcile(
      base({ before: new Map(), after: new Map([["built.js", "1"]]), hostExecRan: true }),
    );
    assert.deepEqual(result, { explained: [], opaque: ["built.js"], unexplained: [] });
  });
});

describe("decideClosure", () => {
  const verification = (overrides: Partial<VerificationOutcome>): VerificationOutcome => ({
    outcome: "PASS",
    strength: "INDEPENDENT",
    required: "INDEPENDENT",
    checks: [{ id: "unit", exit_code: 0, passed: true, evidence_ref: "e1" }],
    must_fail: [],
    protected_unchanged: true,
    ...overrides,
  });
  const close = (loop: LoopOutcome, overrides: Partial<VerificationOutcome> = {}, violations: string[] = []) =>
    decideClosure({ loop, verification: verification(overrides), violations });

  it("fails on any violation, even when every check passed", () => {
    const result = close("COMPLETED", {}, ["UNMEDIATED_CHANGE: modified src/a.ts"]);
    assert.equal(result.status, "FAIL");
    assert.match(result.rationale, /UNMEDIATED_CHANGE: modified src\/a\.ts/);
  });

  it("fails when verification failed, naming the failed check", () => {
    const result = close("COMPLETED", {
      outcome: "FAIL",
      strength: "CHECKED",
      checks: [{ id: "unit", exit_code: 1, passed: false, evidence_ref: "e1" }],
    });
    assert.equal(result.status, "FAIL");
    assert.match(result.rationale, /failed checks \[unit\]/);
  });

  it("abandons a refused or errored loop with nothing verified", () => {
    for (const loop of ["REFUSED", "ROUTE_ERROR"] as const) {
      const result = close(loop, { outcome: "NOT_RUN", strength: "NONE", checks: [] });
      assert.equal(result.status, "ABANDONED", loop);
      assert.match(result.rationale, new RegExp(loop));
    }
  });

  it("does not abandon a refused loop whose checks passed; it is PARTIAL", () => {
    assert.equal(close("REFUSED").status, "PARTIAL");
  });

  it("is PARTIAL when nothing was checked, however the loop ended", () => {
    const result = close("COMPLETED", { outcome: "NOT_RUN", strength: "ASSERTED", checks: [] });
    assert.equal(result.status, "PARTIAL");
    assert.match(result.rationale, /NOT_RUN/);
  });

  it("is PARTIAL when checks passed below the required strength, naming both", () => {
    const result = close("COMPLETED", { strength: "CHECKED", required: "INDEPENDENT" });
    assert.equal(result.status, "PARTIAL");
    assert.match(result.rationale, /strength CHECKED is below required INDEPENDENT/);
  });

  it("is PARTIAL when checks passed but the loop did not finish", () => {
    for (const loop of ["BUDGET_EXHAUSTED", "TRUNCATED"] as const) {
      const result = close(loop);
      assert.equal(result.status, "PARTIAL", loop);
      assert.match(result.rationale, new RegExp(`loop ended ${loop}`));
    }
  });

  it("passes only a finished loop with sufficient, passing verification", () => {
    assert.equal(close("COMPLETED").status, "PASS");
    assert.equal(close("HOST_ENDED").status, "PASS");
  });
});
