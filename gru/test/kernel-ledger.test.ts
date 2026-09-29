import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ledger, parseLedger, type EventType, type LedgerEvent } from "../src/ledger/ledger.ts";
import { MemoryStore } from "../src/ledger/store.ts";
import { verifyChain, verifyStructure } from "../src/ledger/validate.ts";

const clock = () => new Date("2026-09-29T00:00:00.000Z");

function chain(entries: [EventType, unknown][]): LedgerEvent[] {
  const ledger = new Ledger("ep_test", new MemoryStore(), clock);
  for (const [type, body] of entries) ledger.append(type, body);
  return [...ledger.events];
}

const OPENED: [EventType, unknown] = ["episode.opened", { contract: {}, provenance: {} }];
const proposal = (id: string): [EventType, unknown] => ["proposal", { proposal_id: id }];
const authorization = (id: string, proposalId: string, verdict: string, digest: string | null = "d1"): [EventType, unknown] => [
  "authorization",
  { authorization_id: id, proposal_id: proposalId, verdict, effect_digest: digest },
];
const decision = (authorizationId: string, verdict: "APPROVE" | "REJECT"): [EventType, unknown] => [
  "director.decision",
  { decision_id: "dd-1", authorization_id: authorizationId, decision: verdict, actor: "director:alice", reason: "ok" },
];
const effect = (authorizationId: string, proposalId: string, digest: string | null = "d1", refs: string[] = []): [EventType, unknown] => [
  "effect",
  { effect_id: `ef-${authorizationId}`, authorization_id: authorizationId, proposal_id: proposalId, effect_digest: digest, evidence_refs: refs },
];
const evidence = (id: string): [EventType, unknown] => ["evidence", { evidence_id: id }];

describe("verifyChain", () => {
  function recorded(): { store: MemoryStore; lines: string[] } {
    const store = new MemoryStore();
    const ledger = new Ledger("ep_test", store, clock);
    ledger.append("episode.opened", { n: 0 });
    ledger.append("proposal", { proposal_id: "pr-1" });
    ledger.append("authorization", { authorization_id: "au-1", proposal_id: "pr-1", verdict: "DENY" });
    ledger.append("closure", { status: "PARTIAL" });
    return { store, lines: store.lines() };
  }

  it("accepts the chain the ledger wrote", () => {
    assert.deepEqual(verifyChain(parseLedger(recorded().lines)), []);
  });

  it("detects an edit to one stored line and names that event", () => {
    const { store, lines } = recorded();
    store.tamper(2, lines[2]!.replace('"DENY"', '"ALLOW"'));
    assert.deepEqual(verifyChain(parseLedger(store.lines())), ["event 2: hash does not match its contents"]);
  });

  it("detects a field added to an event", () => {
    const { store, lines } = recorded();
    const event = JSON.parse(lines[1]!);
    store.tamper(1, JSON.stringify({ ...event, note: "added later" }));
    assert.deepEqual(verifyChain(parseLedger(store.lines())), ["event 1: hash does not match its contents"]);
  });

  it("detects a deleted event", () => {
    const { lines } = recorded();
    const problems = verifyChain(parseLedger([lines[0]!, lines[2]!, lines[3]!]));
    assert.ok(problems.includes("event 1: seq is 2, expected 1"), problems.join("\n"));
    assert.ok(problems.includes("event 1: prev does not link to the preceding event"), problems.join("\n"));
  });

  it("detects reordered events", () => {
    const { lines } = recorded();
    const problems = verifyChain(parseLedger([lines[0]!, lines[2]!, lines[1]!, lines[3]!]));
    assert.ok(problems.some((problem) => problem.startsWith("event 1: seq")), problems.join("\n"));
  });

  it("detects an event from another episode and a non-object line", () => {
    const events = chain([OPENED, proposal("pr-1")]);
    const foreign = { ...events[1]!, episode_id: "ep_other" };
    assert.ok(verifyChain([events[0]!, foreign]).some((problem) => problem.includes("episode_id ep_other")));
    assert.deepEqual(verifyChain([null as unknown as LedgerEvent]), ["event 0: not an object"]);
  });
});

describe("verifyStructure", () => {
  it("accepts proposal -> ALLOW -> effect -> evidence", () => {
    const events = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW"), evidence("e1"), effect("au-1", "pr-1", "d1", ["e1"])]);
    assert.deepEqual(verifyStructure(events), []);
  });

  it("accepts evidence recorded after the effect that cites it", () => {
    const events = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW"), effect("au-1", "pr-1", "d1", ["e1"]), evidence("e1")]);
    assert.deepEqual(verifyStructure(events), []);
  });

  it("rejects an effect with no authorization", () => {
    const events = chain([OPENED, proposal("pr-1"), effect("au-1", "pr-1")]);
    assert.deepEqual(verifyStructure(events), ["event 2 (effect): effect refers to no earlier authorization (au-1)"]);
  });

  it("rejects an effect recorded before its authorization", () => {
    const events = chain([OPENED, proposal("pr-1"), effect("au-1", "pr-1"), authorization("au-1", "pr-1", "ALLOW")]);
    assert.ok(verifyStructure(events).some((problem) => problem.includes("refers to no earlier authorization")));
  });

  it("rejects an effect after a DENY", () => {
    const events = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "DENY", null), effect("au-1", "pr-1", null)]);
    assert.deepEqual(verifyStructure(events), ["event 3 (effect): effect follows authorization au-1 with verdict DENY"]);
  });

  it("rejects an effect after an ESCALATE that was never approved, or was rejected", () => {
    const pending = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ESCALATE"), effect("au-1", "pr-1")]);
    assert.deepEqual(verifyStructure(pending), [
      "event 3 (effect): effect follows authorization au-1 with verdict ESCALATE and no earlier Director APPROVE",
    ]);
    const rejected = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ESCALATE"), decision("au-1", "REJECT"), effect("au-1", "pr-1")]);
    assert.equal(verifyStructure(rejected).length, 1);
  });

  it("accepts an effect after an ESCALATE the Director approved first, and only first", () => {
    const approved = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ESCALATE"), decision("au-1", "APPROVE"), effect("au-1", "pr-1")]);
    assert.deepEqual(verifyStructure(approved), []);
    const late = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ESCALATE"), effect("au-1", "pr-1"), decision("au-1", "APPROVE")]);
    assert.equal(verifyStructure(late).length, 1);
  });

  it("rejects two effects under one authorization", () => {
    const events = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW"), effect("au-1", "pr-1"), effect("au-1", "pr-1")]);
    assert.deepEqual(verifyStructure(events), ["event 4 (effect): a second effect under authorization au-1"]);
  });

  it("rejects an effect whose digest differs from the one authorized", () => {
    const events = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW", "d1"), effect("au-1", "pr-1", "d2")]);
    assert.deepEqual(verifyStructure(events), [
      "event 3 (effect): effect digest differs from the digest authorization au-1 approved",
    ]);
  });

  it("rejects an effect that names a different proposal than its authorization", () => {
    const events = chain([OPENED, proposal("pr-1"), proposal("pr-2"), authorization("au-1", "pr-1", "ALLOW"), effect("au-1", "pr-2")]);
    assert.deepEqual(verifyStructure(events), ["event 4 (effect): effect's proposal_id differs from authorization au-1's"]);
  });

  it("rejects an authorization with no earlier proposal, and a proposal authorized twice", () => {
    const orphan = chain([OPENED, authorization("au-1", "pr-1", "ALLOW")]);
    assert.deepEqual(verifyStructure(orphan), ["event 1 (authorization): authorization au-1 refers to no earlier proposal (pr-1)"]);
    const twice = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "DENY", null), authorization("au-2", "pr-1", "ALLOW")]);
    assert.deepEqual(verifyStructure(twice), ["event 3 (authorization): proposal pr-1 was already authorized once"]);
  });

  it("rejects duplicate proposal and authorization ids", () => {
    const events = chain([OPENED, proposal("pr-1"), proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW"), proposal("pr-2"), authorization("au-1", "pr-2", "ALLOW")]);
    const problems = verifyStructure(events);
    assert.ok(problems.includes("event 2 (proposal): duplicate proposal pr-1"), problems.join("\n"));
    assert.ok(problems.includes("event 5 (authorization): duplicate authorization au-1"), problems.join("\n"));
  });

  it("rejects a Director decision on anything but an earlier ESCALATE, and a second decision", () => {
    const onAllow = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ALLOW"), decision("au-1", "APPROVE")]);
    assert.deepEqual(verifyStructure(onAllow), ["event 3 (director.decision): decision on au-1, which was ALLOW, not ESCALATE"]);
    const twice = chain([OPENED, proposal("pr-1"), authorization("au-1", "pr-1", "ESCALATE"), decision("au-1", "REJECT"), decision("au-1", "APPROVE")]);
    assert.deepEqual(verifyStructure(twice), ["event 4 (director.decision): a second decision on au-1"]);
  });

  it("rejects evidence references that resolve to nothing", () => {
    const events = chain([
      OPENED,
      proposal("pr-1"),
      authorization("au-1", "pr-1", "ALLOW"),
      effect("au-1", "pr-1", "d1", ["missing"]),
      ["verification", { checks: [{ id: "unit", evidence_ref: "gone" }], must_fail: [{ id: "mut", evidence_ref: "e1" }] }],
      evidence("e1"),
    ]);
    assert.deepEqual(verifyStructure(events), [
      "event 3 (effect) evidence_refs[0]: evidence missing is not recorded in this ledger",
      "event 4 (verification) checks[0]: evidence gone is not recorded in this ledger",
    ]);
  });

  it("requires the ledger to open with exactly one episode.opened", () => {
    assert.deepEqual(verifyStructure([]), ["the first event is not episode.opened"]);
    assert.deepEqual(verifyStructure(chain([proposal("pr-1"), OPENED])), ["the first event is not episode.opened"]);
    assert.deepEqual(verifyStructure(chain([OPENED, OPENED])), ["event 1 (episode.opened): a second episode.opened"]);
  });
});
