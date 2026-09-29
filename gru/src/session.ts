// The governed session (SLICE_1 §4-§5): the one place where a Minion's
// proposals become effects. Every tool call takes the same path --
// parse -> classify -> authorize -> (Director) -> mint -> redeem at
// execution -> evidence -- and each step is a ledger event before the next
// one starts, so an effect can always be traced back by id (S2).
//
// The session is the only writer of its ledger. Model output reaches it
// as data (tool input, turn text); nothing here reads authority from it,
// and turn text is recorded as an ASSERTED claim that no closure accepts.
//
// Limits, stated rather than implied:
//   - a declared command runs with the user's ambient authority; the
//     episode says UNSAFE_DEVELOPMENT and reconciliation after the fact is
//     the only check on what the command did inside the workspace;
//   - the kernel detects an executor that never redeems an authorization,
//     not one that acts first and redeems afterwards;
//   - in host mode the host performs the effect and reports it; GRU records
//     that report and cannot verify it;
//   - paths matched by the contract's `ignore` globs are invisible to
//     reconciliation and to the protected-file comparison.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ActionError,
  parseToolCall,
  toolDefinitions,
  type Effect,
  type ParsedAction,
  type ToolDefinition,
} from "./avl/actions.ts";
import { decideClosure } from "./avl/closure.ts";
import {
  consequencesOf,
  evaluate,
  obligationsFor,
  type ClassificationContext,
  type Consequence,
  type DeclaredCommand,
} from "./avl/consequence.ts";
import { effectDigest, Gate, GateViolation, type Binding } from "./avl/gate.ts";
import { matchesAny, normaliseWorkspacePath, PathError } from "./avl/paths.ts";
import { principal, type Principal } from "./avl/principal.ts";
import { reconcile } from "./avl/reconcile.ts";
import { computeSafety } from "./avl/safety.ts";
import { computeStrength, requiredFor } from "./avl/verification.ts";
import { parseContract } from "./contract.ts";
import { computeAdmissibility } from "./ledger/admissibility.ts";
import { canonical, digestOf, sha256, toJson, type Json } from "./ledger/canonical.ts";
import { Ledger, parseLedger, systemClock, type Clock, type LedgerEvent } from "./ledger/ledger.ts";
import { assertOutsideWorkspace, FileStore, MemoryStore } from "./ledger/store.ts";
import { verifyChain, verifyStructure } from "./ledger/validate.ts";
import {
  BindError,
  type CheckSpec,
  type DirectorChannel,
  type DirectorDecision,
  type EffectExecutor,
  type EffectResult,
  type EpisodeReport,
  type EscalationRequest,
  type GovernedSession,
  type HostDecision,
  type LoopOutcome,
  type ModelTurn,
  type OpenSession,
  type OpenSessionOptions,
  type ProcessOutcome,
  type Redeem,
  type SafetyMode,
  type TaskContract,
  type ToolCall,
  type ToolResult,
  type VerificationOutcome,
} from "./types.ts";

export const GRU_VERSION = "0.1.0";
const PRODUCER = "avl:v0";
const ACTION_TTL_MS = 60_000;
const CONTRACT_GRANT = "gr-0";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inputDigest(input: unknown): string {
  try {
    return digestOf(input);
  } catch {
    return sha256(String(input));
  }
}

function jsonOrNull(value: unknown): Json {
  try {
    return toJson(value);
  } catch {
    return null;
  }
}

function sortedEntries(manifest: ReadonlyMap<string, string>): [string, string][] {
  return [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameUnder(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, globs: readonly string[]): boolean {
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (matchesAny(path, globs) && before.get(path) !== after.get(path)) return false;
  }
  return true;
}

/** Trust is re-derived from the kind, so a hand-built object claiming T3 is not taken at its word. */
function admitMinion(candidate: Principal): Principal {
  const kind = candidate?.kind;
  let derived: Principal | null = null;
  try {
    derived = principal(kind, String(candidate?.id).slice(`${String(kind)}:`.length));
  } catch {
    derived = null;
  }
  if (derived === null || derived.id !== candidate.id || derived.trust !== candidate.trust || derived.trust !== "T3") {
    throw new Error(
      `a Minion must be a T3 (model-driven) principal; ${String(candidate?.id)} is not: ` +
        "a Minion cannot be the Director or AVL",
    );
  }
  return derived;
}

const HEX64 = /^[0-9a-f]{64}$/;

function exactKeys(effect: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(effect).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * A host effect arrives from a surface that translated a host payload. It
 * is checked as strictly as a Minion's tool input: a path the host could
 * resolve differently from the workspace-relative one GRU binds is refused.
 */
function checkHostEffect(effect: Effect): void {
  if (typeof effect !== "object" || effect === null) throw new ActionError("host effect must be an object");
  const record = effect as unknown as Record<string, unknown>;
  const strings = (keys: readonly string[]): void => {
    if (!exactKeys(record, ["kind", ...keys])) throw new ActionError(`${effect.kind} must have exactly [kind, ${keys.join(", ")}]`);
    for (const key of keys) {
      if (typeof record[key] !== "string") throw new ActionError(`${effect.kind}.${key} must be a string`);
    }
  };
  switch (effect.kind) {
    case "fs.read":
    case "fs.list":
    case "fs.delete":
    case "fs.write": {
      if (effect.kind === "fs.write") {
        if (!exactKeys(record, ["kind", "path", "content_sha256", "bytes"])) {
          throw new ActionError("fs.write must have exactly [kind, path, content_sha256, bytes]");
        }
        if (typeof effect.content_sha256 !== "string" || !HEX64.test(effect.content_sha256)) {
          throw new ActionError("fs.write.content_sha256 must be a sha256 hex digest");
        }
        if (!Number.isInteger(effect.bytes) || effect.bytes < 0) throw new ActionError("fs.write.bytes must be a count");
      } else {
        strings(["path"]);
      }
      const normalised = normaliseWorkspacePath(effect.path);
      if (normalised !== effect.path) {
        throw new PathError(`host path "${effect.path}" is not normalised (expected "${normalised}")`);
      }
      if (normalised === "." && (effect.kind === "fs.write" || effect.kind === "fs.delete")) {
        throw new PathError(`cannot ${effect.kind} the workspace root`);
      }
      return;
    }
    case "process.run":
      throw new ActionError("process.run is performed by GRU, never by a host; a host command is host.exec");
    case "host.exec":
      return strings(["tool", "command"]);
    case "host.fetch":
      return strings(["tool", "url"]);
    case "host.other":
      strings(["tool", "input_sha256"]);
      if (!HEX64.test(effect.input_sha256)) throw new ActionError("host.other.input_sha256 must be a sha256 hex digest");
      return;
    default:
      throw new ActionError(`unknown effect kind ${String((effect as { kind?: unknown }).kind)}`);
  }
}

function wellFormedDecision(value: unknown): value is DirectorDecision {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as Record<string, unknown>;
  return (
    (decision.decision === "APPROVE" || decision.decision === "REJECT") &&
    typeof decision.actor === "string" &&
    decision.actor.length > 0 &&
    typeof decision.reason === "string"
  );
}

interface Pending {
  authorization_id: string;
  proposal_id: string;
  effect: Effect;
  binding: Binding;
  digest: string;
  grant_refs: string[];
  payload: string | null;
}

interface HostAuthorization {
  proposal_id: string;
  tool: string;
  effect: Effect | null;
  verdict: "ALLOW" | "ESCALATE" | "DENY";
  effect_digest: string | null;
  decided: boolean;
  recorded: boolean;
}

const LEDGERS = new WeakMap<object, Ledger>();

/** A copy of a session's events, for inspection and tests. The session keeps the only writable ledger. */
export function episodeEvents(session: GovernedSession): LedgerEvent[] {
  const ledger = LEDGERS.get(session);
  if (ledger === undefined) throw new Error("not a session opened by this kernel");
  return structuredClone([...ledger.events]);
}

class Session implements GovernedSession {
  readonly episode_id: string;
  readonly safety: SafetyMode;
  readonly tools: readonly ToolDefinition[];
  readonly contract: TaskContract;

  readonly #ledger: Ledger;
  readonly #ledgerPath: string | null;
  readonly #gate: Gate;
  readonly #executor: EffectExecutor;
  readonly #director: DirectorChannel;
  readonly #minion: Principal;
  readonly #clock: Clock;
  readonly #commandIds: string[];
  readonly #classify: ClassificationContext;
  readonly #manifest0: Map<string, string>;
  readonly #manifest0Ref: string;
  readonly #counters = { pr: 0, au: 0, dd: 0, ef: 0 };
  #turns = 0;
  readonly #host = new Map<string, HostAuthorization>();

  // What reconciliation needs to explain workspace changes at close.
  readonly #fsWrites: { path: string; sha256: string }[] = [];
  readonly #fsDeletes: string[] = [];
  readonly #commandGlobs: { writes: readonly string[]; deletes: readonly string[] }[] = [];
  readonly #hostWrites: string[] = [];
  #hostExecRan = false;

  #closing: Promise<EpisodeReport> | null = null;

  constructor(options: OpenSessionOptions) {
    const executor = options.executor;
    if (executor === undefined || executor === null) {
      throw new Error(
        "openSession needs options.executor: the kernel performs no filesystem effect itself, " +
          "so without an executor there is nothing to govern",
      );
    }
    this.#executor = executor;
    this.#director = options.director;
    this.#minion = admitMinion(options.minion);
    // Parsed again so the session holds its own frozen copy, and so a
    // hand-built contract meets the same rules as a loaded one.
    this.contract = parseContract(options.contract);
    this.#clock = options.clock ?? systemClock;
    this.#commandIds = this.contract.commands.map((command) => command.id);
    const commands = this.contract.commands;
    this.#classify = {
      protectedGlobs: this.contract.verification.protected,
      command: (id: string): DeclaredCommand | undefined => commands.find((command) => command.id === id),
    };

    const stateDir =
      typeof options.state_dir === "string" && options.state_dir.length > 0
        ? assertOutsideWorkspace(options.state_dir, executor.root)
        : null;

    this.#manifest0 = executor.manifest(this.contract.ignore);
    this.tools = toolDefinitions(this.#commandIds);
    this.safety = computeSafety(
      options.backends ?? (executor.isolation ? [executor.isolation] : []),
      [
        ...this.contract.commands.map((command) => command.argv),
        ...this.contract.verification.checks.map((check) => check.argv),
        ...this.contract.verification.must_fail.map((check) => check.argv),
      ],
    );

    const route = options.route ?? null;
    const provenance = {
      gru_version: GRU_VERSION,
      route,
      contract_digest: digestOf(this.contract),
      capability_set_digest: digestOf({ tools: this.tools, commands: this.contract.commands }),
      environment_digest: digestOf({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        workspace_manifest: digestOf(sortedEntries(this.#manifest0)),
      }),
      workspace_root: executor.root,
    };
    const started_at = this.#clock().toISOString();
    const nonce = randomUUID();
    this.episode_id = `ep_${digestOf({ provenance, started_at, nonce }).slice(0, 24)}`;

    const store = stateDir === null ? new MemoryStore() : new FileStore(stateDir, this.episode_id);
    this.#ledgerPath = stateDir === null ? null : join(stateDir, "episodes", this.episode_id, "ledger.jsonl");
    this.#ledger = new Ledger(this.episode_id, store, this.#clock);
    this.#gate = new Gate(this.#clock);
    LEDGERS.set(this, this.#ledger);

    this.#ledger.append("episode.opened", {
      intent: {
        request: this.contract.task,
        classification: this.contract.classification,
        success_criteria: this.contract.success_criteria,
      },
      contract: this.contract,
      provenance,
      safety: this.safety,
      minion: this.#minion.id,
      host_mode: route === null,
      started_at,
      nonce,
    });
    this.#manifest0Ref = this.#ledger.evidence(canonical(sortedEntries(this.#manifest0)), {
      producer: PRODUCER,
      relation: "DERIVED_FROM",
      subjects: [this.episode_id],
      label: "workspace-manifest-at-open",
    });
    const issuedAt = this.#clock();
    const grant = {
      grant_id: CONTRACT_GRANT,
      scopes: [...this.contract.grant.scopes],
      issued_by: "director:contract",
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.contract.grant.ttl_seconds * 1000).toISOString(),
    };
    this.#gate.addGrant(grant);
    this.#ledger.append("grant.issued", grant);
  }

  #next(kind: "pr" | "au" | "dd" | "ef"): string {
    this.#counters[kind] += 1;
    return `${kind}-${this.#counters[kind]}`;
  }

  #assertOpen(): void {
    if (this.#closing !== null) throw new Error(`episode ${this.episode_id} is closed`);
  }

  #expiry(): string {
    return new Date(this.#clock().getTime() + ACTION_TTL_MS).toISOString();
  }

  #deny(authorization_id: string, proposal_id: string, reason: string): void {
    this.#ledger.append("authorization", {
      authorization_id,
      proposal_id,
      verdict: "DENY",
      reasons: [reason],
      effect_digest: null,
      binding: null,
      grant_refs: [],
      expires_at: null,
      host_prompt: false,
    });
  }

  /** Binding failures deny: an effect AVL cannot resolve is an effect it cannot authorize. */
  #bind(effect: Effect): { binding: Binding } | { denied: string } {
    try {
      return { binding: this.#executor.bind(effect) };
    } catch (error) {
      if (error instanceof BindError) return { denied: error.message };
      return { denied: `the executor could not bind the effect: ${message(error)}` };
    }
  }

  #violation(kind: string, fields: Record<string, Json>, detail: string): void {
    this.#ledger.append("violation", { kind, ...fields, detail });
  }

  async handle(call: ToolCall): Promise<ToolResult> {
    this.#assertOpen();
    const call_id = String(call.id);
    const tool = String(call.name);
    const proposal_id = this.#next("pr");
    const authorization_id = this.#next("au");
    const proposal = {
      proposal_id,
      call_id,
      principal: this.#minion.id,
      trust: this.#minion.trust,
      tool,
      input_digest: inputDigest(call.input),
      host_mode: false,
    };

    let parsed: ParsedAction;
    try {
      parsed = parseToolCall(tool, call.input, this.#commandIds);
    } catch (error) {
      if (!(error instanceof ActionError || error instanceof PathError)) throw error;
      this.#ledger.append("proposal", { ...proposal, effect: null, consequences: [], error: error.message });
      this.#deny(authorization_id, proposal_id, error.message);
      return { call_id, ok: false, content: `AVL DENY: ${error.message}` };
    }
    const effect = parsed.effect;
    const consequences = consequencesOf(effect, this.#classify);
    // The write payload is never recorded; the effect carries its digest.
    this.#ledger.append("proposal", { ...proposal, effect, consequences, error: null });

    const bound = this.#bind(effect);
    if ("denied" in bound) {
      this.#deny(authorization_id, proposal_id, bound.denied);
      return { call_id, ok: false, content: `AVL DENY: ${bound.denied}` };
    }
    const binding = bound.binding;
    const evaluation = evaluate(obligationsFor(effect, consequences), this.#gate.held());
    const digest = effectDigest(effect, binding);
    this.#ledger.append("authorization", {
      authorization_id,
      proposal_id,
      verdict: evaluation.verdict,
      reasons: evaluation.reasons,
      effect_digest: digest,
      binding,
      grant_refs: evaluation.grantRefs,
      expires_at: this.#expiry(),
      host_prompt: false,
    });

    if (evaluation.verdict === "ESCALATE") {
      const decision = await this.#escalate({
        authorization_id,
        proposal_id,
        principal: this.#minion.id,
        tool,
        effect: structuredClone(effect),
        consequences: [...consequences],
        reasons: [...evaluation.reasons],
      });
      if (decision === null) {
        return { call_id, ok: false, content: "AVL ESCALATED; the episode closed before the Project Director decided" };
      }
      if (decision.decision !== "APPROVE") {
        return { call_id, ok: false, content: `AVL ESCALATED; Project Director REJECTED: ${decision.reason}` };
      }
    }

    return this.#execute(call_id, {
      authorization_id,
      proposal_id,
      effect,
      binding,
      digest,
      grant_refs: evaluation.grantRefs,
      payload: effect.kind === "fs.write" ? (parsed.payload ?? null) : null,
    });
  }

  /** Without a usable Director answer, escalation fails closed and says so. */
  async #escalate(request: EscalationRequest): Promise<DirectorDecision | null> {
    let decision: DirectorDecision;
    let failClosed = false;
    try {
      const answer: unknown = await this.#director.decide(request);
      if (wellFormedDecision(answer)) {
        decision = { decision: answer.decision, actor: answer.actor, reason: answer.reason };
      } else {
        failClosed = true;
        decision = { decision: "REJECT", actor: PRODUCER, reason: "the Director channel returned a malformed decision; escalation fails closed" };
      }
    } catch (error) {
      failClosed = true;
      decision = { decision: "REJECT", actor: PRODUCER, reason: `the Director channel failed (${message(error)}); escalation fails closed` };
    }
    if (this.#closing !== null) return null;
    this.#ledger.append("director.decision", {
      decision_id: this.#next("dd"),
      authorization_id: request.authorization_id,
      proposal_id: request.proposal_id,
      decision: decision.decision,
      actor: decision.actor,
      reason: decision.reason,
      inferred: false,
      fail_closed: failClosed,
    });
    return decision;
  }

  async #execute(call_id: string, pending: Pending): Promise<ToolResult> {
    const { authorization_id, proposal_id, effect } = pending;
    // Set only once the gate accepts the executor's recomputed digest.
    const gate = { redeemed: false };
    const redeem: Redeem = (action, digestNow) => {
      this.#gate.redeem(action, digestNow);
      gate.redeemed = true;
    };
    const command = effect.kind === "process.run" ? this.#classify.command(effect.command_id) : undefined;
    const trackCommand = (): void => {
      // A command that got past the gate may have run even if it then failed.
      if (command !== undefined && gate.redeemed) {
        this.#commandGlobs.push({ writes: command.writes, deletes: command.deletes });
      }
    };

    let result: EffectResult;
    try {
      const action = this.#gate.mint({
        authorization_id,
        proposal_id,
        effect,
        binding: pending.binding,
        grant_refs: pending.grant_refs,
        payload: pending.payload,
        ttl_ms: ACTION_TTL_MS,
      });
      result = await this.#executor.perform(action, redeem);
    } catch (error) {
      trackCommand();
      if (error instanceof GateViolation || error instanceof BindError) {
        // The gate held and nothing happened: a refusal, not a violation.
        // Whatever changed the binding is itself caught by reconciliation.
        this.#ledger.append("refusal", { kind: "GATE_REFUSED", authorization_id, detail: error.message });
        return { call_id, ok: false, content: `AVL refused execution: ${error.message}` };
      }
      this.#ledger.append("effect", {
        effect_id: this.#next("ef"),
        authorization_id,
        proposal_id,
        effect_digest: pending.digest,
        performed_by: "gru",
        ok: false,
        redeemed: gate.redeemed,
        summary: null,
        error: message(error),
        evidence_refs: [],
      });
      return { call_id, ok: false, content: `effect failed: ${message(error)}` };
    }
    trackCommand();

    const effect_id = this.#next("ef");
    const evidence_refs = result.outputs.map((output) =>
      this.#ledger.evidence(output.bytes, {
        producer: PRODUCER,
        relation: output.relation,
        subjects: [effect_id],
        label: output.label,
      }),
    );
    this.#ledger.append("effect", {
      effect_id,
      authorization_id,
      proposal_id,
      effect_digest: pending.digest,
      performed_by: "gru",
      ok: result.ok,
      redeemed: gate.redeemed,
      summary: result.summary,
      error: null,
      evidence_refs,
    });
    if (!gate.redeemed) {
      this.#violation(
        "GATE_BYPASSED",
        { authorization_id, effect_id },
        `the executor reported a result for ${authorization_id} without redeeming it at the gate`,
      );
    } else if (result.ok && effect.kind === "fs.write") {
      this.#fsWrites.push({ path: effect.path, sha256: effect.content_sha256 });
    } else if (result.ok && effect.kind === "fs.delete") {
      this.#fsDeletes.push(effect.path);
    }
    return { call_id, ok: result.ok, content: result.model_content };
  }

  recordTurn(turn: ModelTurn): void {
    this.#assertOpen();
    this.#turns += 1;
    this.#ledger.append("model.turn", {
      turn: this.#turns,
      served_model: turn.served_model,
      stop: turn.stop,
      usage: turn.usage,
      call_ids: turn.calls.map((call) => String(call.id)),
      detail: turn.detail,
    });
    if (turn.text.trim().length > 0) {
      this.#ledger.append("claim", { principal: this.#minion.id, strength: "ASSERTED", turn: this.#turns, text: turn.text });
    }
  }

  async decideHost(tool: string, effect: Effect): Promise<HostDecision> {
    this.#assertOpen();
    const proposal_id = this.#next("pr");
    const authorization_id = this.#next("au");
    const proposal = {
      proposal_id,
      call_id: null,
      principal: this.#minion.id,
      trust: this.#minion.trust,
      tool: String(tool),
      input_digest: inputDigest(effect),
      host_mode: true,
    };
    const deny = (reason: string, consequences: Consequence[]): HostDecision => {
      this.#deny(authorization_id, proposal_id, reason);
      this.#host.set(authorization_id, {
        proposal_id,
        tool: String(tool),
        effect: null,
        verdict: "DENY",
        effect_digest: null,
        decided: false,
        recorded: false,
      });
      return { authorization_id, verdict: "DENY", reasons: [reason], consequences };
    };

    let consequences: Consequence[];
    try {
      checkHostEffect(effect);
      consequences = consequencesOf(effect, this.#classify);
    } catch (error) {
      this.#ledger.append("proposal", { ...proposal, effect: jsonOrNull(effect), consequences: [], error: message(error) });
      return deny(message(error), []);
    }
    this.#ledger.append("proposal", { ...proposal, effect, consequences, error: null });

    let binding: Binding;
    if (effect.kind === "host.exec" || effect.kind === "host.fetch" || effect.kind === "host.other") {
      binding = { host: true, tool: String(tool) };
    } else {
      const bound = this.#bind(effect);
      if ("denied" in bound) return deny(bound.denied, consequences);
      binding = bound.binding;
    }

    const evaluation = evaluate(obligationsFor(effect, consequences), this.#gate.held());
    const digest = effectDigest(effect, binding);
    // ESCALATE is not sent to the Director channel: the host's own
    // permission prompt asks the human, so AVL records ASK and waits.
    this.#ledger.append("authorization", {
      authorization_id,
      proposal_id,
      verdict: evaluation.verdict,
      reasons: evaluation.reasons,
      effect_digest: digest,
      binding,
      grant_refs: evaluation.grantRefs,
      expires_at: this.#expiry(),
      host_prompt: evaluation.verdict === "ESCALATE",
    });
    this.#host.set(authorization_id, {
      proposal_id,
      tool: String(tool),
      effect,
      verdict: evaluation.verdict,
      effect_digest: digest,
      decided: false,
      recorded: false,
    });
    return {
      authorization_id,
      verdict: evaluation.verdict === "ALLOW" ? "ALLOW" : "ASK",
      reasons: evaluation.reasons,
      consequences,
    };
  }

  recordHostEffect(authorization_id: string, result: { ok: boolean; summary: Json; output: string | null }): void {
    this.#assertOpen();
    const pending = this.#host.get(authorization_id);
    if (pending === undefined) throw new Error(`no host authorization ${authorization_id} in episode ${this.episode_id}`);
    if (pending.recorded) throw new Error(`an effect was already recorded under ${authorization_id}; authorizations are single-use`);
    pending.recorded = true;

    if (pending.verdict === "ESCALATE" && !pending.decided) {
      // The host ran it, so its permission prompt was answered yes. The
      // decision is recorded as inferred, not as something AVL observed.
      this.#ledger.append("director.decision", {
        decision_id: this.#next("dd"),
        authorization_id,
        proposal_id: pending.proposal_id,
        decision: "APPROVE",
        actor: "director:host-ui",
        reason: "the host performed the action after its own permission prompt",
        inferred: true,
        fail_closed: false,
      });
      pending.decided = true;
    }

    const effect_id = this.#next("ef");
    const evidence_refs =
      result.output === null
        ? []
        : [
            this.#ledger.evidence(result.output, {
              producer: "host",
              relation: "DERIVED_FROM",
              subjects: [effect_id],
              label: `host-output:${pending.tool}`,
            }),
          ];
    // Recorded even when AVL denied it: the ledger has to say what happened.
    this.#ledger.append("effect", {
      effect_id,
      authorization_id,
      proposal_id: pending.proposal_id,
      effect_digest: pending.effect_digest,
      performed_by: "host",
      ok: result.ok,
      redeemed: null,
      summary: result.summary,
      error: null,
      evidence_refs,
    });

    if (pending.verdict === "DENY") {
      this.#violation(
        "HOST_EXECUTED_DENIED",
        { authorization_id, effect_id },
        `the host performed ${authorization_id} (${pending.tool}), which AVL denied`,
      );
      return;
    }
    const effect = pending.effect;
    if (effect?.kind === "fs.write") this.#hostWrites.push(effect.path);
    else if (effect?.kind === "fs.delete") this.#fsDeletes.push(effect.path);
    else if (effect?.kind === "host.exec" || effect?.kind === "host.other") this.#hostExecRan = true;
  }

  revoke(grant_id: string, actor: string, reason: string): void {
    this.#assertOpen();
    if (typeof actor !== "string" || !actor.startsWith("director:") || actor.length === "director:".length) {
      throw new Error(`only the Project Director can revoke a grant; "${String(actor)}" is not a director:<name> actor`);
    }
    if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("a revocation must state its reason");
    this.#gate.revoke(grant_id);
    this.#ledger.append("grant.revoked", { grant_id, actor, reason });
  }

  close(outcome: LoopOutcome): Promise<EpisodeReport> {
    this.#closing ??= this.#close(outcome);
    return this.#closing;
  }

  async #runCheck(check: CheckSpec): Promise<ProcessOutcome> {
    try {
      return await this.#executor.runCheck(check);
    } catch (error) {
      return { exit_code: -1, stdout: "", stderr: `check could not run: ${message(error)}`, duration_ms: 0, timed_out: false };
    }
  }

  #checkEvidence(kind: "check" | "must_fail", check: CheckSpec, run: ProcessOutcome, verifies: boolean): string {
    const record = {
      id: check.id,
      argv: check.argv,
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      duration_ms: run.duration_ms,
      isolation: run.isolation ?? "none",
      stdout: run.stdout,
      stderr: run.stderr,
    };
    return this.#ledger.evidence(canonical(record), {
      producer: PRODUCER,
      relation: verifies ? "VERIFIES" : "FALSIFIES",
      subjects: [this.episode_id],
      label: `${kind}:${check.id}`,
    });
  }

  async #close(loop: LoopOutcome): Promise<EpisodeReport> {
    const contract = this.contract;

    // 1. Reconcile the workspace against what AVL authorized.
    const manifest1 = this.#executor.manifest(contract.ignore);
    const manifest1Ref = this.#ledger.evidence(canonical(sortedEntries(manifest1)), {
      producer: PRODUCER,
      relation: "DERIVED_FROM",
      subjects: [this.episode_id],
      label: "workspace-manifest-at-close",
    });
    const reconciliation = reconcile({
      before: this.#manifest0,
      after: manifest1,
      fsWrites: this.#fsWrites,
      fsDeletes: this.#fsDeletes,
      commandGlobs: this.#commandGlobs,
      hostExecRan: this.#hostExecRan,
      hostWrites: this.#hostWrites,
    });
    this.#ledger.append("reconciliation", {
      ...reconciliation,
      manifest_at_open: this.#manifest0Ref,
      manifest_at_close: manifest1Ref,
    });
    for (const { path, change } of reconciliation.unexplained) {
      this.#violation("UNMEDIATED_CHANGE", { path, change }, `${change} ${path}`);
    }

    // 2. Verification, run by AVL (T1) and never through the Minion's gate.
    const checks: VerificationOutcome["checks"] = [];
    let allChecksRan = true;
    for (const check of contract.verification.checks) {
      const run = await this.#runCheck(check);
      // 127 and -1 mean the program never ran; a timeout never reached a verdict.
      if (run.timed_out || run.exit_code === 127 || run.exit_code < 0) allChecksRan = false;
      const passed = run.exit_code === 0 && !run.timed_out;
      checks.push({ id: check.id, exit_code: run.exit_code, passed, evidence_ref: this.#checkEvidence("check", check, run, passed) });
    }
    const must_fail: VerificationOutcome["must_fail"] = [];
    for (const check of contract.verification.must_fail) {
      const run = await this.#runCheck(check);
      // A timeout is not the failure the check was meant to demonstrate.
      const failed = run.exit_code !== 0 && !run.timed_out;
      must_fail.push({
        id: check.id,
        exit_code: run.exit_code,
        failed_as_required: failed,
        evidence_ref: this.#checkEvidence("must_fail", check, run, failed),
      });
    }
    const protected_unchanged = sameUnder(this.#manifest0, manifest1, contract.verification.protected);
    const asserted = this.#ledger.events.some((event) => event.type === "claim");
    const strength = computeStrength({
      checks_declared: checks.length > 0,
      all_checks_ran: allChecksRan,
      protected_unchanged,
      must_fail_declared: must_fail.length > 0,
      all_must_fail_failed: must_fail.every((check) => check.failed_as_required),
      asserted,
    });
    const failedSomething = checks.some((check) => !check.passed) || must_fail.some((check) => check.exit_code === 0);
    const verification: VerificationOutcome = {
      outcome: failedSomething ? "FAIL" : checks.length + must_fail.length === 0 ? "NOT_RUN" : "PASS",
      strength,
      required: requiredFor(contract),
      checks,
      must_fail,
      protected_unchanged,
    };
    this.#ledger.append("verification", { ...verification, asserted });

    // 3. Validate what was persisted, not only what this process remembers.
    let problems: string[];
    try {
      const persisted = parseLedger(this.#ledger.store.lines());
      problems = [...verifyChain(persisted), ...verifyStructure(persisted)];
    } catch (error) {
      problems = [message(error)];
    }
    for (const problem of problems) this.#violation("STRUCTURE", {}, problem);

    // 4. Closure, from recorded facts only.
    const violations = this.#ledger.events
      .filter((event) => event.type === "violation")
      .map((event) => {
        const body = event.body as { kind: string; detail: string };
        return `${body.kind}: ${body.detail}`;
      });
    const closure = decideClosure({ loop, verification, violations });
    this.#ledger.append("closure", { status: closure.status, rationale: closure.rationale, loop });

    // 5. Admissibility, recomputable later from the ledger alone.
    const admissibility = computeAdmissibility(this.#ledger.events);
    this.#ledger.append("admissibility", admissibility);

    return {
      episode_id: this.episode_id,
      closure,
      verification,
      admissibility: { verdict: admissibility.verdict, conditions: admissibility.conditions },
      safety: this.safety,
      violations,
      ledger_path: this.#ledgerPath,
    };
  }
}

export const openSession: OpenSession = async (options) => new Session(options);
