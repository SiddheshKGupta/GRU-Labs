// Ledger validation: the checks `gru verify` and closure run over a list of
// events, with no access to the session that wrote them.
//
// verifyChain answers "is this the sequence that was written?" (a single
// edited, deleted or reordered event is detected; a consistent rewrite of
// the whole chain is not -- there is no external anchor yet).
// verifyStructure answers "does the sequence reconstruct?" (Core schema
// §3.1): every effect traces to a proposal and to an authorization that
// allowed it or that the Director approved, and every evidence reference
// resolves. Both return problems as strings and never throw on bad input,
// because a ledger that fails to parse is itself the finding.

import type { Json } from "./canonical.ts";
import { eventHash, GENESIS, type LedgerEvent } from "./ledger.ts";

type Body = { [key: string]: Json };

function bodyOf(event: LedgerEvent): Body {
  const body = event.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
}

function text(body: Body, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function verifyChain(events: readonly LedgerEvent[]): string[] {
  const problems: string[] = [];
  const episodeId = events[0]?.episode_id;
  let expectedPrev = GENESIS;
  events.forEach((event, index) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      problems.push(`event ${index}: not an object`);
      expectedPrev = "";
      return;
    }
    if (event.seq !== index) problems.push(`event ${index}: seq is ${String(event.seq)}, expected ${index}`);
    if (event.episode_id !== episodeId) {
      problems.push(`event ${index}: episode_id ${String(event.episode_id)} differs from ${String(episodeId)}`);
    }
    if (event.prev !== expectedPrev) problems.push(`event ${index}: prev does not link to the preceding event`);
    // Hash everything except the hash, so an added field is caught too.
    const { hash, ...unsigned } = event;
    try {
      if (eventHash(unsigned as Omit<LedgerEvent, "hash">) !== hash) {
        problems.push(`event ${index}: hash does not match its contents`);
      }
    } catch (error) {
      problems.push(`event ${index}: cannot be canonicalised (${message(error)})`);
    }
    expectedPrev = typeof hash === "string" ? hash : "";
  });
  return problems;
}

interface AuthorizationRecord {
  proposal_id: string | null;
  verdict: string | null;
  effect_digest: Json | undefined;
}

export function verifyStructure(events: readonly LedgerEvent[]): string[] {
  const problems: string[] = [];
  if (events[0]?.type !== "episode.opened") problems.push("the first event is not episode.opened");

  // Evidence may be recorded before or after the event that cites it.
  const evidenceIds = new Set<string>();
  for (const event of events) {
    if (event?.type !== "evidence") continue;
    const id = text(bodyOf(event), "evidence_id");
    if (id !== null) evidenceIds.add(id);
  }
  const requireEvidence = (at: string, ref: Json | undefined): void => {
    if (typeof ref !== "string" || !evidenceIds.has(ref)) {
      problems.push(`${at}: evidence ${String(ref)} is not recorded in this ledger`);
    }
  };

  const proposals = new Set<string>();
  const authorizations = new Map<string, AuthorizationRecord>();
  const authorizedProposals = new Set<string>();
  const decisions = new Map<string, string>();
  const effected = new Set<string>();
  let opened = 0;

  events.forEach((event, index) => {
    if (typeof event !== "object" || event === null) return;
    const at = `event ${index} (${String(event.type)})`;
    const body = bodyOf(event);
    switch (event.type) {
      case "episode.opened":
        opened++;
        if (opened > 1) problems.push(`${at}: a second episode.opened`);
        break;

      case "proposal": {
        const id = text(body, "proposal_id");
        if (id === null) problems.push(`${at}: no proposal_id`);
        else if (proposals.has(id)) problems.push(`${at}: duplicate proposal ${id}`);
        else proposals.add(id);
        break;
      }

      case "authorization": {
        const id = text(body, "authorization_id");
        const proposalId = text(body, "proposal_id");
        const verdict = text(body, "verdict");
        if (id === null) {
          problems.push(`${at}: no authorization_id`);
          break;
        }
        if (authorizations.has(id)) problems.push(`${at}: duplicate authorization ${id}`);
        if (proposalId === null || !proposals.has(proposalId)) {
          problems.push(`${at}: authorization ${id} refers to no earlier proposal (${String(proposalId)})`);
        } else if (authorizedProposals.has(proposalId)) {
          problems.push(`${at}: proposal ${proposalId} was already authorized once`);
        }
        if (verdict !== "ALLOW" && verdict !== "ESCALATE" && verdict !== "DENY") {
          problems.push(`${at}: authorization ${id} has unknown verdict ${String(verdict)}`);
        }
        if (proposalId !== null) authorizedProposals.add(proposalId);
        if (!authorizations.has(id)) {
          authorizations.set(id, { proposal_id: proposalId, verdict, effect_digest: body.effect_digest });
        }
        break;
      }

      case "director.decision": {
        const id = text(body, "authorization_id");
        const decision = text(body, "decision");
        const authorization = id === null ? undefined : authorizations.get(id);
        if (id === null || authorization === undefined) {
          problems.push(`${at}: decision refers to no earlier authorization (${String(id)})`);
          break;
        }
        if (authorization.verdict !== "ESCALATE") {
          problems.push(`${at}: decision on ${id}, which was ${String(authorization.verdict)}, not ESCALATE`);
        }
        if (decision !== "APPROVE" && decision !== "REJECT") problems.push(`${at}: unknown decision ${String(decision)}`);
        if (decisions.has(id)) problems.push(`${at}: a second decision on ${id}`);
        else if (decision !== null) decisions.set(id, decision);
        break;
      }

      case "effect": {
        const id = text(body, "authorization_id");
        const authorization = id === null ? undefined : authorizations.get(id);
        if (id === null || authorization === undefined) {
          problems.push(`${at}: effect refers to no earlier authorization (${String(id)})`);
        } else {
          if (text(body, "proposal_id") !== authorization.proposal_id) {
            problems.push(`${at}: effect's proposal_id differs from authorization ${id}'s`);
          }
          if (body.effect_digest !== authorization.effect_digest) {
            problems.push(`${at}: effect digest differs from the digest authorization ${id} approved`);
          }
          const approved = authorization.verdict === "ESCALATE" && decisions.get(id) === "APPROVE";
          if (authorization.verdict !== "ALLOW" && !approved) {
            problems.push(
              `${at}: effect follows authorization ${id} with verdict ${String(authorization.verdict)}` +
                (authorization.verdict === "ESCALATE" ? " and no earlier Director APPROVE" : ""),
            );
          }
          if (effected.has(id)) problems.push(`${at}: a second effect under authorization ${id}`);
          effected.add(id);
        }
        const refs = body.evidence_refs;
        if (refs !== undefined) {
          if (!Array.isArray(refs)) problems.push(`${at}: evidence_refs is not a list`);
          else refs.forEach((ref, position) => requireEvidence(`${at} evidence_refs[${position}]`, ref));
        }
        break;
      }

      case "verification": {
        for (const key of ["checks", "must_fail"] as const) {
          const entries = body[key];
          if (!Array.isArray(entries)) continue;
          entries.forEach((entry, position) => {
            const ref =
              typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry.evidence_ref : undefined;
            requireEvidence(`${at} ${key}[${position}]`, ref);
          });
        }
        break;
      }

      default:
        break;
    }
  });
  return problems;
}
