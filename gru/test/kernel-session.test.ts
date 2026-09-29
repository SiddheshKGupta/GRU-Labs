import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Effect } from "../src/avl/actions.ts";
import { principal, type Principal } from "../src/avl/principal.ts";
import { parseContract } from "../src/contract.ts";
import { digestOf, sha256 } from "../src/ledger/canonical.ts";
import { computeAdmissibility } from "../src/ledger/admissibility.ts";
import { parseLedger, type EventType, type LedgerEvent } from "../src/ledger/ledger.ts";
import { verifyChain, verifyStructure } from "../src/ledger/validate.ts";
import { episodeEvents, openSession } from "../src/session.ts";
import type {
  DirectorChannel,
  DirectorDecision,
  EscalationRequest,
  GovernedSession,
  ModelTurn,
  OpenSessionOptions,
  RouteDescriptor,
  TaskContract,
  ToolCall,
} from "../src/types.ts";
import { FakeExecutor, outcome } from "./kernel-fake-executor.ts";

// ------------------------------------------------------------------ fixtures

class ScriptedDirector implements DirectorChannel {
  readonly requests: EscalationRequest[] = [];
  readonly answers: DirectorDecision[];
  constructor(answers: DirectorDecision[] = []) {
    this.answers = [...answers];
  }
  async decide(request: EscalationRequest): Promise<DirectorDecision> {
    this.requests.push(request);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("the test did not expect an escalation");
    return answer;
  }
}

const MINION = principal("minion", "coder");
const ROUTE: RouteDescriptor = {
  id: "fixture",
  kind: "fixture",
  provider: "fixture",
  model: "fixture-1",
  base_url: null,
  credential_ref: null,
};
const approve: DirectorDecision = { decision: "APPROVE", actor: "director:alice", reason: "the test fixture is wrong" };
const reject: DirectorDecision = { decision: "REJECT", actor: "director:alice", reason: "do not touch the tests" };

function contract(overrides: Record<string, unknown> = {}): TaskContract {
  return parseContract({
    task: "Make the parser accept empty input",
    classification: "MATERIAL",
    grant: { scopes: ["workspace:read", "workspace:write", "workspace:delete"], ttl_seconds: 3600 },
    commands: [],
    verification: { protected: ["test/**"], checks: [{ id: "unit", argv: ["node", "--test"], timeout_ms: 1000 }] },
    ...overrides,
  });
}

const FILES = { "src/parser.ts": "export const parse = () => 1;\n", "test/parser.test.ts": "assert(parse() === 1)\n" };

interface Opened {
  session: GovernedSession;
  executor: FakeExecutor;
  director: ScriptedDirector;
}

async function open(options: Partial<OpenSessionOptions> & { director?: ScriptedDirector; executor?: FakeExecutor } = {}): Promise<Opened> {
  const executor = options.executor ?? new FakeExecutor(FILES);
  const director = options.director ?? new ScriptedDirector();
  const session = await openSession({
    contract: options.contract ?? contract(),
    workspace: executor.root,
    state_dir: options.state_dir ?? null,
    route: options.route === undefined ? ROUTE : options.route,
    director,
    minion: options.minion ?? MINION,
    executor,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { session, executor, director };
}

type Body = Record<string, unknown>;
const bodyOf = (event: LedgerEvent): Body => event.body as Body;
const ofType = (session: GovernedSession, type: EventType): Body[] =>
  episodeEvents(session)
    .filter((event) => event.type === type)
    .map(bodyOf);

const read = (id: string, path: string): ToolCall => ({ id, name: "read_file", input: { path } });
const write = (id: string, path: string, content: string): ToolCall => ({ id, name: "write_file", input: { path, content } });
const turn = (text: string): ModelTurn => ({
  text,
  calls: [],
  stop: "end_turn",
  served_model: "fixture-1",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  detail: null,
});

const temporary: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gru-kernel-")));
  temporary.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ opening

describe("openSession", () => {
  it("requires an executor and says why", async () => {
    await assert.rejects(
      openSession({ contract: contract(), workspace: "/w", state_dir: null, route: ROUTE, director: new ScriptedDirector(), minion: MINION }),
      /needs options\.executor/,
    );
  });

  it("rejects a Minion that is not T3, including a forged one claiming T3", async () => {
    await assert.rejects(open({ minion: principal("director", "alice") }), /must be a T3/);
    await assert.rejects(open({ minion: principal("avl", "v0") }), /cannot be the Director or AVL/);
    const forged = { kind: "director", id: "director:alice", trust: "T3" } as unknown as Principal;
    await assert.rejects(open({ minion: forged }), /must be a T3/);
  });

  it("re-parses the contract, so a hand-built one cannot lower the floor", async () => {
    const lowered = { ...contract(), verification: { ...contract().verification, required_strength: "CHECKED" } } as TaskContract;
    await assert.rejects(open({ contract: lowered }), /never lower it/);
  });

  it("records the opening: contract, provenance, labelled safety, manifest evidence and the contract grant", async () => {
    const { session } = await open();
    const events = episodeEvents(session);
    assert.deepEqual(
      events.map((event) => event.type),
      ["episode.opened", "evidence", "grant.issued"],
    );
    const opened = bodyOf(events[0]!);
    assert.deepEqual(opened.contract, session.contract);
    const provenance = opened.provenance as Body;
    assert.equal(provenance.gru_version, "0.1.0");
    assert.equal(provenance.contract_digest, digestOf(session.contract));
    assert.deepEqual(provenance.route, ROUTE);
    assert.equal(opened.host_mode, false);
    assert.deepEqual(opened.safety, { mode: "UNSAFE_DEVELOPMENT", unmet: ["P1", "P2", "P8"], backends: [] });
    assert.deepEqual(session.safety, opened.safety);
    assert.equal(bodyOf(events[1]!).label, "workspace-manifest-at-open");
    const grant = bodyOf(events[2]!);
    assert.equal(grant.grant_id, "gr-0");
    assert.deepEqual(grant.scopes, ["workspace:read", "workspace:write", "workspace:delete"]);
    assert.equal(Date.parse(grant.expires_at as string) - Date.parse(grant.issued_at as string), 3600 * 1000);
    assert.match(session.episode_id, /^ep_[0-9a-f]{24}$/);
    assert.ok(!session.tools.some((tool) => tool.name === "run_command"));
  });

  it("refuses a state directory inside the workspace", async () => {
    const root = tempDir();
    const executor = new FakeExecutor(FILES, root);
    await assert.rejects(open({ executor, state_dir: join(root, ".gru-state") }), /overlap/);
  });
});

// ------------------------------------------------------------------ the gate path

describe("handle", () => {
  it("links proposal -> authorization -> effect -> evidence by id on the ALLOW path", async () => {
    const { session } = await open();
    const result = await session.handle(read("call-1", "src/parser.ts"));
    assert.deepEqual(result, { call_id: "call-1", ok: true, content: FILES["src/parser.ts"] });

    const events = episodeEvents(session).slice(3);
    assert.deepEqual(
      events.map((event) => event.type),
      ["proposal", "authorization", "evidence", "effect"],
    );
    const [proposal, authorization, evidence, effect] = events.map(bodyOf) as [Body, Body, Body, Body];
    assert.equal(proposal.call_id, "call-1");
    assert.equal(proposal.principal, "minion:coder");
    assert.equal(proposal.trust, "T3");
    assert.deepEqual(proposal.consequences, ["OBSERVE_WORKSPACE"]);
    assert.equal(authorization.proposal_id, proposal.proposal_id);
    assert.equal(authorization.verdict, "ALLOW");
    assert.deepEqual(authorization.grant_refs, ["gr-0"]);
    assert.equal(effect.authorization_id, authorization.authorization_id);
    assert.equal(effect.proposal_id, proposal.proposal_id);
    assert.equal(effect.effect_digest, authorization.effect_digest);
    assert.equal(effect.performed_by, "gru");
    assert.equal(effect.redeemed, true);
    assert.deepEqual(effect.evidence_refs, [evidence.evidence_id]);
    assert.deepEqual(evidence.subject_refs, [effect.effect_id]);
    assert.equal(evidence.evidence_id, sha256(FILES["src/parser.ts"]));
    assert.deepEqual(verifyStructure(episodeEvents(session)), []);
  });

  it("never records a write's payload, only its digest", async () => {
    const { session, executor } = await open();
    const secret = "the full new file content 12345";
    await session.handle(write("c", "src/parser.ts", secret));
    assert.equal(executor.files.get("src/parser.ts"), secret);
    const [proposal] = ofType(session, "proposal");
    assert.equal((proposal!.effect as Body).content_sha256, sha256(secret));
    assert.ok(!JSON.stringify(episodeEvents(session)).includes(secret));
  });

  it("records a DENY for invalid input and performs nothing", async () => {
    const { session, executor } = await open();
    const escape = await session.handle(write("c1", "../outside.txt", "x"));
    assert.equal(escape.ok, false);
    assert.match(escape.content, /^AVL DENY: path escapes the workspace/);
    const unknown = await session.handle({ id: "c2", name: "run_shell", input: { command: "rm -rf /" } });
    assert.match(unknown.content, /^AVL DENY: unknown tool "run_shell"/);

    const proposals = ofType(session, "proposal");
    assert.deepEqual(proposals.map((proposal) => proposal.effect), [null, null]);
    assert.equal(proposals[1]!.error, 'unknown tool "run_shell"');
    assert.deepEqual(ofType(session, "authorization").map((entry) => entry.verdict), ["DENY", "DENY"]);
    assert.deepEqual(ofType(session, "effect"), []);
    assert.deepEqual(executor.performed, []);
  });

  it("denies an effect the executor cannot bind", async () => {
    const { session, executor } = await open();
    const result = await session.handle(read("c", "escape/link"));
    assert.equal(result.content, "AVL DENY: escape/link resolves outside the workspace");
    const [authorization] = ofType(session, "authorization");
    assert.equal(authorization!.verdict, "DENY");
    assert.equal(authorization!.effect_digest, null);
    assert.deepEqual(ofType(session, "effect"), []);
    assert.deepEqual(executor.performed, []);
  });

  it("fails closed when binding throws something other than a BindError", async () => {
    const { session, executor } = await open();
    const result = await session.handle(read("c", "crash/file"));
    assert.equal(result.content, "AVL DENY: the executor could not bind the effect: EIO: i/o error");
    assert.equal(ofType(session, "authorization")[0]!.verdict, "DENY");
    assert.deepEqual(executor.performed, []);
  });

  it("escalates a protected write; a Director REJECT means no effect", async () => {
    const director = new ScriptedDirector([reject]);
    const { session, executor } = await open({ director });
    const result = await session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    assert.deepEqual(result, { call_id: "c", ok: false, content: "AVL ESCALATED; Project Director REJECTED: do not touch the tests" });
    assert.equal(director.requests.length, 1);
    assert.deepEqual(director.requests[0]!.consequences, ["ALTER_VERIFICATION"]);
    assert.equal(ofType(session, "authorization")[0]!.verdict, "ESCALATE");
    const [decision] = ofType(session, "director.decision");
    assert.equal(decision!.decision, "REJECT");
    assert.equal(decision!.actor, "director:alice");
    assert.deepEqual(ofType(session, "effect"), []);
    assert.equal(executor.files.get("test/parser.test.ts"), FILES["test/parser.test.ts"]);
  });

  it("performs an escalated effect only after a Director APPROVE, recorded first", async () => {
    const { session, executor } = await open({ director: new ScriptedDirector([approve]) });
    const result = await session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    assert.equal(result.ok, true);
    assert.equal(executor.files.get("test/parser.test.ts"), "assert(true)");
    const types = episodeEvents(session).map((event) => event.type);
    assert.ok(types.indexOf("director.decision") < types.indexOf("effect"));
    assert.deepEqual(verifyStructure(episodeEvents(session)), []);
  });

  it("fails closed when the Director channel fails", async () => {
    const { session, executor } = await open({ director: new ScriptedDirector([]) });
    const result = await session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    assert.match(result.content, /REJECTED: the Director channel failed .*fails closed/);
    const [decision] = ofType(session, "director.decision");
    assert.equal(decision!.decision, "REJECT");
    assert.equal(decision!.actor, "avl:v0");
    assert.equal(decision!.fail_closed, true);
    assert.deepEqual(executor.performed, []);
  });

  it("fails closed on a malformed Director decision", async () => {
    const malformed = { decision: "MAYBE", actor: "director:alice", reason: "?" } as unknown as DirectorDecision;
    const { session, executor } = await open({ director: new ScriptedDirector([malformed]) });
    const result = await session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    assert.match(result.content, /REJECTED: the Director channel returned a malformed decision/);
    assert.equal(ofType(session, "director.decision")[0]!.fail_closed, true);
    assert.deepEqual(executor.performed, []);
  });

  it("records nothing after closure when the Director answers late", async () => {
    let answer: (decision: DirectorDecision) => void = () => {};
    const director = new ScriptedDirector();
    director.decide = async (request) => {
      director.requests.push(request);
      return new Promise<DirectorDecision>((resolve) => (answer = resolve));
    };
    const { session, executor } = await open({ director });
    const pending = session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(director.requests.length, 1);
    await session.close("TRUNCATED");
    answer(approve);
    const result = await pending;
    assert.match(result.content, /closed before the Project Director decided/);
    assert.equal(episodeEvents(session).at(-1)!.type, "admissibility");
    assert.deepEqual(ofType(session, "director.decision"), []);
    assert.deepEqual(executor.performed, []);
  });

  it("hands out a copy of the events, so editing it cannot change the record", async () => {
    const { session } = await open();
    await session.handle(read("c", "src/parser.ts"));
    const copy = episodeEvents(session);
    (copy[3]!.body as Body).effect = null;
    copy.length = 1;
    assert.equal(episodeEvents(session).length, 7);
    const report = await session.close("COMPLETED");
    assert.deepEqual(report.violations, []);
  });

  it("refuses execution when the grant is revoked between authorization and perform", async () => {
    const { session, executor } = await open();
    const pause = executor.pauseNext();
    const pending = session.handle(write("c", "src/parser.ts", "changed"));
    await pause.reached;
    session.revoke("gr-0", "director:alice", "stop all writes");
    pause.release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.content, /^AVL refused execution: grant gr-0 was revoked or expired after authorization/);
    assert.equal(executor.files.get("src/parser.ts"), FILES["src/parser.ts"]);
    const [violation] = ofType(session, "violation");
    assert.equal(violation!.kind, "GATE_REFUSED");
    assert.equal(ofType(session, "grant.revoked")[0]!.actor, "director:alice");
    assert.deepEqual(ofType(session, "effect"), []);
    const report = await session.close("COMPLETED");
    assert.equal(report.closure.status, "FAIL");
  });

  it("refuses execution when the path resolves elsewhere at execution time", async () => {
    const { session, executor } = await open();
    const pause = executor.pauseNext();
    const pending = session.handle(write("c", "src/parser.ts", "changed"));
    await pause.reached;
    executor.redirects.set("src/parser.ts", "/home/user/.ssh/authorized_keys");
    pause.release();
    const result = await pending;
    assert.match(result.content, /does not match the effect authorized/);
    assert.equal(executor.files.get("src/parser.ts"), FILES["src/parser.ts"]);
    assert.equal(ofType(session, "violation")[0]!.kind, "GATE_REFUSED");
  });

  it("refuses execution after the authorization expires", async () => {
    let now = Date.parse("2026-09-29T10:00:00.000Z");
    const { session, executor } = await open({ clock: () => new Date(now) });
    const pause = executor.pauseNext();
    const pending = session.handle(write("c", "src/parser.ts", "changed"));
    await pause.reached;
    now += 61_000;
    pause.release();
    assert.match((await pending).content, /expired/);
    assert.equal(executor.files.get("src/parser.ts"), FILES["src/parser.ts"]);
  });

  it("records a violation when an executor reports a result without redeeming", async () => {
    const { session, executor } = await open();
    executor.skipRedeem = true;
    await session.handle(write("c", "src/parser.ts", "changed"));
    const [effect] = ofType(session, "effect");
    assert.equal(effect!.redeemed, false);
    assert.equal(ofType(session, "violation")[0]!.kind, "GATE_BYPASSED");
    const report = await session.close("COMPLETED");
    assert.equal(report.closure.status, "FAIL");
    // The unredeemed write explains nothing, so it is also an unmediated change.
    assert.ok(report.violations.includes("UNMEDIATED_CHANGE: modified src/parser.ts"), report.violations.join("\n"));
  });

  it("records an effect that failed after redemption as ok:false", async () => {
    const { session, executor } = await open();
    executor.crashAfterRedeem = new Error("disk full");
    const result = await session.handle(write("c", "src/parser.ts", "changed"));
    assert.deepEqual(result, { call_id: "c", ok: false, content: "effect failed: disk full" });
    const [effect] = ofType(session, "effect");
    assert.equal(effect!.ok, false);
    assert.equal(effect!.redeemed, true);
    assert.equal(effect!.error, "disk full");
    assert.deepEqual(ofType(session, "violation"), []);
  });

  it("explains a declared command's writes by its globs and flags the rest", async () => {
    const executor = new FakeExecutor(FILES);
    executor.commands.set("build", (files) => {
      files.set("dist/parser.js", "compiled");
      files.set("src/generated.ts", "not declared");
      return outcome(0, "built");
    });
    const { session } = await open({
      executor,
      contract: contract({
        // Declared writes imply MODIFY_WORKSPACE, so the grant needs workspace:write too.
        grant: { scopes: ["workspace:read", "workspace:write", "command:build"], ttl_seconds: 60 },
        commands: [
          { id: "build", argv: ["npm", "run", "build"], consequences: ["EXECUTE_WORKSPACE_CODE"], writes: ["dist/**"], timeout_ms: 1000 },
        ],
      }),
    });
    assert.ok(session.tools.some((tool) => tool.name === "run_command"));
    const result = await session.handle({ id: "c", name: "run_command", input: { command_id: "build" } });
    assert.equal(result.ok, true);
    const report = await session.close("COMPLETED");
    const [reconciliation] = ofType(session, "reconciliation");
    assert.deepEqual(reconciliation!.explained, ["dist/parser.js"]);
    assert.deepEqual(report.violations, ["UNMEDIATED_CHANGE: created src/generated.ts"]);
  });

  it("records a model turn and its text as an ASSERTED claim", async () => {
    const { session } = await open();
    session.recordTurn({ ...turn("Done."), calls: [{ id: "x", name: "read_file", input: {} }] });
    session.recordTurn(turn("   "));
    const turns = ofType(session, "model.turn");
    assert.deepEqual(turns.map((entry) => entry.turn), [1, 2]);
    assert.deepEqual(turns[0]!.call_ids, ["x"]);
    assert.equal(turns[0]!.served_model, "fixture-1");
    assert.deepEqual(ofType(session, "claim"), [{ principal: "minion:coder", strength: "ASSERTED", turn: 1, text: "Done." }]);
  });

  it("lets only a director:<name> actor revoke, with a reason, a grant that exists", async () => {
    const { session } = await open();
    assert.throws(() => session.revoke("gr-0", "minion:coder", "I want to"), /only the Project Director/);
    assert.throws(() => session.revoke("gr-0", "director:", "x"), /only the Project Director/);
    assert.throws(() => session.revoke("gr-0", "director:alice", " "), /must state its reason/);
    assert.throws(() => session.revoke("gr-9", "director:alice", "x"), /unknown grant/);
    assert.deepEqual(ofType(session, "grant.revoked"), []);
  });
});

// ------------------------------------------------------------------ closure

describe("close", () => {
  it("never passes on the model's assertion alone", async () => {
    const { session } = await open({ contract: contract({ classification: "MICRO", verification: { protected: [], checks: [] } }) });
    session.recordTurn(turn("All tests pass. The task is complete."));
    const report = await session.close("COMPLETED");
    assert.equal(report.closure.status, "PARTIAL");
    assert.equal(report.verification.outcome, "NOT_RUN");
    assert.equal(report.verification.strength, "ASSERTED");
    assert.equal(ofType(session, "claim")[0]!.strength, "ASSERTED");
    assert.equal(report.admissibility.conditions.verification_sufficient, "FAIL");
    assert.equal(report.admissibility.verdict, "INADMISSIBLE");
  });

  it("fails when a Director-declared check fails, with falsifying evidence", async () => {
    const { session, executor } = await open();
    executor.checks.set("unit", outcome(1, "", "1 failing"));
    const report = await session.close("COMPLETED");
    assert.equal(report.closure.status, "FAIL");
    assert.equal(report.verification.outcome, "FAIL");
    assert.deepEqual(report.verification.checks.map((check) => [check.id, check.exit_code, check.passed]), [["unit", 1, false]]);
    const evidence = ofType(session, "evidence").find((entry) => entry.label === "check:unit");
    assert.equal(evidence!.relation, "FALSIFIES");
    assert.equal(evidence!.evidence_id, report.verification.checks[0]!.evidence_ref);
  });

  it("treats a check that could not run as failed", async () => {
    const { session, executor } = await open();
    executor.runCheck = async () => {
      throw new Error("ENOENT: node");
    };
    const report = await session.close("COMPLETED");
    assert.equal(report.verification.outcome, "FAIL");
    assert.equal(report.closure.status, "FAIL");
  });

  it("passes a MATERIAL episode at INDEPENDENT when checks pass and protected files are unchanged", async () => {
    const { session } = await open();
    await session.handle(write("c", "src/parser.ts", "export const parse = () => 0;\n"));
    session.recordTurn(turn("Fixed it."));
    const report = await session.close("COMPLETED");
    assert.equal(report.verification.strength, "INDEPENDENT");
    assert.equal(report.verification.required, "INDEPENDENT");
    assert.equal(report.verification.protected_unchanged, true);
    assert.equal(report.closure.status, "PASS");
    assert.deepEqual(report.violations, []);
    assert.equal(report.admissibility.verdict, "ADMISSIBLE_POSITIVE");
    assert.deepEqual(ofType(session, "reconciliation")[0]!.explained, ["src/parser.ts"]);
    assert.equal(ofType(session, "evidence").find((entry) => entry.label === "check:unit")!.relation, "VERIFIES");
  });

  it("drops to CHECKED and PARTIAL when an approved write changed a protected file", async () => {
    const { session } = await open({ director: new ScriptedDirector([approve]) });
    await session.handle(write("c", "test/parser.test.ts", "assert(true)"));
    const report = await session.close("COMPLETED");
    assert.equal(report.verification.protected_unchanged, false);
    assert.equal(report.verification.strength, "CHECKED");
    assert.equal(report.closure.status, "PARTIAL");
    assert.match(report.closure.rationale, /strength CHECKED is below required INDEPENDENT/);
    assert.equal(report.admissibility.verdict, "INADMISSIBLE");
  });

  it("reaches ADVERSARIAL only when every must-fail check fails as required", async () => {
    const mustFail = contract({
      verification: {
        protected: ["test/**"],
        checks: [{ id: "unit", argv: ["node", "--test"], timeout_ms: 1000 }],
        must_fail: [{ id: "mutant", argv: ["node", "--test", "mutant"], timeout_ms: 1000 }],
      },
    });
    const failed = await open({ contract: mustFail });
    failed.executor.checks.set("mutant", outcome(1, "", "mutant killed"));
    const adversarial = await failed.session.close("COMPLETED");
    assert.equal(adversarial.verification.strength, "ADVERSARIAL");
    assert.equal(adversarial.verification.must_fail[0]!.failed_as_required, true);
    assert.equal(adversarial.closure.status, "PASS");

    const survived = await open({ contract: mustFail });
    survived.executor.checks.set("mutant", outcome(0, "mutant survived"));
    const report = await survived.session.close("COMPLETED");
    assert.equal(report.verification.outcome, "FAIL");
    assert.equal(report.verification.strength, "INDEPENDENT");
    assert.equal(report.closure.status, "FAIL");

    const timedOut = await open({ contract: mustFail });
    timedOut.executor.checks.set("mutant", outcome(124, "", "killed", true));
    const slow = await timedOut.session.close("COMPLETED");
    assert.equal(slow.verification.strength, "INDEPENDENT");
    assert.equal(slow.verification.outcome, "PASS");
  });

  it("flags a change made behind the session: UNMEDIATED_CHANGE, FAIL, INADMISSIBLE", async () => {
    const { session, executor } = await open();
    await session.handle(write("c", "src/parser.ts", "export const parse = () => 0;\n"));
    executor.files.set("src/backdoor.ts", "export {}");
    executor.files.delete("test/parser.test.ts");
    const report = await session.close("COMPLETED");
    assert.deepEqual(report.violations, ["UNMEDIATED_CHANGE: created src/backdoor.ts", "UNMEDIATED_CHANGE: deleted test/parser.test.ts"]);
    assert.equal(report.closure.status, "FAIL");
    assert.equal(report.admissibility.conditions.no_policy_violation, "FAIL");
    assert.equal(report.admissibility.verdict, "INADMISSIBLE");
  });

  it("is idempotent: one closure, one verification run, the same report", async () => {
    const { session, executor } = await open();
    const first = session.close("COMPLETED");
    const second = session.close("BUDGET_EXHAUSTED");
    assert.equal(first, second);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(a.closure.status, "PASS");
    assert.deepEqual(executor.checksRun, ["unit"]);
    assert.equal(ofType(session, "closure").length, 1);
    assert.equal(ofType(session, "admissibility").length, 1);
    await assert.rejects(session.handle(read("c", "src/parser.ts")), /is closed/);
    assert.throws(() => session.recordTurn(turn("late")), /is closed/);
  });

  it("records admissibility that recomputes identically from the events", async () => {
    const { session } = await open();
    await session.handle(read("c", "src/parser.ts"));
    const report = await session.close("COMPLETED");
    const events = episodeEvents(session);
    assert.equal(events.at(-1)!.type, "admissibility");
    const recomputed = computeAdmissibility(events);
    assert.deepEqual(bodyOf(events.at(-1)!), { ...recomputed });
    assert.deepEqual(report.admissibility, { verdict: recomputed.verdict, conditions: recomputed.conditions });
  });
});

// ------------------------------------------------------------------ host mode

describe("host mode", () => {
  const hostWrite = (path: string, content: string): Effect => ({
    kind: "fs.write",
    path,
    content_sha256: sha256(content),
    bytes: content.length,
  });

  it("turns ESCALATE into ASK without calling the Director, then infers approval when the host performs it", async () => {
    const { session, executor, director } = await open({ route: null });
    assert.equal(bodyOf(episodeEvents(session)[0]!).host_mode, true);
    const decision = await session.decideHost("Write", hostWrite("test/parser.test.ts", "assert(true)"));
    assert.equal(decision.verdict, "ASK");
    assert.deepEqual(decision.consequences, ["ALTER_VERIFICATION"]);
    assert.equal(director.requests.length, 0);
    const [authorization] = ofType(session, "authorization");
    assert.equal(authorization!.verdict, "ESCALATE");
    assert.equal(authorization!.host_prompt, true);
    assert.equal(ofType(session, "proposal")[0]!.host_mode, true);

    executor.files.set("test/parser.test.ts", "assert(true)");
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: { written: true }, output: "File written" });
    const [inferred] = ofType(session, "director.decision");
    assert.equal(inferred!.decision, "APPROVE");
    assert.equal(inferred!.actor, "director:host-ui");
    assert.equal(inferred!.inferred, true);
    const [effect] = ofType(session, "effect");
    assert.equal(effect!.performed_by, "host");
    assert.equal(effect!.authorization_id, decision.authorization_id);
    assert.equal((effect!.evidence_refs as string[]).length, 1);

    const report = await session.close("HOST_ENDED");
    assert.deepEqual(report.violations, []);
    assert.equal(report.verification.strength, "CHECKED");
    assert.equal(report.closure.status, "PARTIAL");
  });

  it("allows what the grant covers", async () => {
    const { session } = await open({ route: null });
    const decision = await session.decideHost("Read", { kind: "fs.read", path: "src/parser.ts" });
    assert.equal(decision.verdict, "ALLOW");
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null });
    assert.equal(ofType(session, "director.decision").length, 0);
    const report = await session.close("HOST_ENDED");
    assert.equal(report.closure.status, "PASS");
    assert.equal(report.admissibility.conditions.identity_recorded, "PASS");
  });

  it("treats changes after an approved host command or opaque host tool as opaque, not as violations", async () => {
    const opaqueEffects: Effect[] = [
      { kind: "host.exec", tool: "Bash", command: "npm run build" },
      { kind: "host.other", tool: "NotebookEdit", input_sha256: sha256("{}") },
    ];
    for (const effect of opaqueEffects) {
      const { session, executor } = await open({ route: null });
      const decision = await session.decideHost("Tool", effect);
      assert.equal(decision.verdict, "ASK");
      assert.deepEqual(decision.consequences, ["EXECUTE_UNDECLARED"]);
      executor.files.set("dist/parser.js", "compiled");
      session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: "done" });
      const report = await session.close("HOST_ENDED");
      assert.deepEqual(report.violations, [], effect.kind);
      assert.deepEqual(ofType(session, "reconciliation")[0]!.opaque, ["dist/parser.js"], effect.kind);
    }
  });

  it("does not treat a host fetch as able to change the workspace", async () => {
    const { session, executor } = await open({ route: null });
    const decision = await session.decideHost("WebFetch", { kind: "host.fetch", tool: "WebFetch", url: "https://example.com" });
    assert.deepEqual(decision.consequences, ["EXTERNAL_SIDE_EFFECT"]);
    executor.files.set("downloaded.html", "<html>");
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null });
    const report = await session.close("HOST_ENDED");
    assert.deepEqual(report.violations, ["UNMEDIATED_CHANGE: created downloaded.html"]);
  });

  it("explains a delete the host performed under authorization", async () => {
    const { session, executor } = await open({ route: null });
    const decision = await session.decideHost("Delete", { kind: "fs.delete", path: "src/parser.ts" });
    assert.equal(decision.verdict, "ALLOW");
    executor.files.delete("src/parser.ts");
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null });
    const report = await session.close("HOST_ENDED");
    assert.deepEqual(report.violations, []);
    assert.deepEqual(ofType(session, "reconciliation")[0]!.explained, ["src/parser.ts"]);
  });

  it("denies host effects AVL cannot bind or that are malformed", async () => {
    const { session } = await open({ route: null });
    const cases: [Effect, RegExp][] = [
      [hostWrite("escape/x", "x"), /resolves outside the workspace/],
      [{ kind: "fs.read", path: "../etc/passwd" }, /escapes the workspace/],
      [{ kind: "fs.read", path: "src/../../etc/passwd" }, /escapes the workspace/],
      [{ kind: "fs.read", path: "./src/parser.ts" }, /not normalised/],
      [{ kind: "process.run", command_id: "build" }, /performed by GRU, never by a host/],
      [{ kind: "fs.write", path: "a.ts", content_sha256: "nothex", bytes: 1 }, /sha256/],
      [{ kind: "host.exec", tool: "Bash", command: "ls", extra: 1 } as unknown as Effect, /exactly/],
    ];
    for (const [effect, pattern] of cases) {
      const decision = await session.decideHost("Tool", effect);
      assert.equal(decision.verdict, "DENY", JSON.stringify(effect));
      assert.match(decision.reasons[0]!, pattern);
    }
  });

  it("records an effect the host performed despite a DENY, and a HOST_EXECUTED_DENIED violation", async () => {
    const { session, executor } = await open({ route: null });
    const decision = await session.decideHost("Write", hostWrite("escape/x", "x"));
    assert.equal(decision.verdict, "DENY");
    executor.files.set("escape/x", "x");
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null });
    assert.equal(ofType(session, "effect")[0]!.performed_by, "host");
    assert.equal(ofType(session, "violation")[0]!.kind, "HOST_EXECUTED_DENIED");
    const report = await session.close("HOST_ENDED");
    assert.equal(report.closure.status, "FAIL");
    assert.ok(report.violations.some((violation) => violation.startsWith("HOST_EXECUTED_DENIED:")));
    assert.ok(report.violations.some((violation) => violation.startsWith("STRUCTURE:")), report.violations.join("\n"));
  });

  it("rejects an unknown authorization id and a second effect under one authorization", async () => {
    const { session } = await open({ route: null });
    assert.throws(() => session.recordHostEffect("au-99", { ok: true, summary: null, output: null }), /no host authorization au-99/);
    const decision = await session.decideHost("Read", { kind: "fs.read", path: "src/parser.ts" });
    session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null });
    assert.throws(
      () => session.recordHostEffect(decision.authorization_id, { ok: true, summary: null, output: null }),
      /single-use/,
    );
  });
});

// ------------------------------------------------------------------ persistence

describe("FileStore persistence", () => {
  it("writes a ledger that re-parses, verifies and recomputes to the same admissibility", async () => {
    const workspace = tempDir();
    const state = tempDir();
    const executor = new FakeExecutor(FILES, workspace);
    const { session } = await open({ executor, state_dir: state });
    await session.handle(write("c", "src/parser.ts", "export const parse = () => 0;\n"));
    session.recordTurn(turn("Done."));
    const report = await session.close("COMPLETED");

    assert.equal(report.ledger_path, join(state, "episodes", session.episode_id, "ledger.jsonl"));
    assert.ok(existsSync(report.ledger_path!));
    const lines = readFileSync(report.ledger_path!, "utf8").split("\n").filter((line) => line.length > 0);
    const events = parseLedger(lines);
    assert.deepEqual(events, episodeEvents(session));
    assert.deepEqual(verifyChain(events), []);
    assert.deepEqual(verifyStructure(events), []);
    const recomputed = computeAdmissibility(events);
    assert.equal(recomputed.verdict, report.admissibility.verdict);
    assert.equal(recomputed.verdict, "ADMISSIBLE_POSITIVE");
    // Evidence blobs sit beside the ledger, addressed by digest.
    for (const ref of report.verification.checks.map((check) => check.evidence_ref)) {
      assert.ok(existsSync(join(state, "blobs", ref)));
    }
  });

  it("detects at close a persisted ledger line edited mid-episode", async () => {
    const workspace = tempDir();
    const state = tempDir();
    const { session } = await open({ executor: new FakeExecutor(FILES, workspace), state_dir: state });
    await session.handle(read("c", "src/parser.ts"));
    const path = join(state, "episodes", session.episode_id, "ledger.jsonl");
    const lines = readFileSync(path, "utf8").split("\n");
    lines[0] = lines[0]!.replace("Make the parser accept empty input", "Anything goes");
    writeFileSync(path, lines.join("\n"));
    const report = await session.close("COMPLETED");
    assert.equal(report.closure.status, "FAIL");
    assert.ok(report.violations.includes("STRUCTURE: event 0: hash does not match its contents"), report.violations.join("\n"));
  });
});
