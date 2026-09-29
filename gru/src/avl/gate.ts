// The effect gate (P3, P9, P10, S8).
//
// An AuthorizedAction is the only thing an executor accepts. It is minted
// here and nowhere else: the constructor demands a module-private symbol,
// the ECMAScript #genuine field is a runtime brand that Object.create,
// structuredClone and a JSON round trip all fail, and the gate also keeps a
// WeakSet of what it minted, so an action minted by one episode's gate is
// refused by another's.
//
// Ceiling, stated rather than implied: code running in this realm that can
// reach this module could still misuse it. No T3 code runs in this realm in
// slice 1 -- model output is data -- so the brand guards against our own
// bugs and against forged objects, not against an attacker inside the
// process (Core ARCHITECTURE_REDUCTION §2, GRU/Core relationship §2.1).

import { digestOf, sha256, type Json } from "../ledger/canonical.ts";
import type { Clock } from "../ledger/ledger.ts";
import type { Effect } from "./actions.ts";

export class GateViolation extends Error {
  override name = "GateViolation";
}

/** Facts about the environment an effect resolves to, captured at authorization and again at execution. */
export type Binding = { [key: string]: Json };

export function effectDigest(effect: Effect, binding: Binding): string {
  return digestOf({ effect, binding });
}

const MINT: unique symbol = Symbol("gru.avl.mint");

export interface MintRequest {
  authorization_id: string;
  proposal_id: string;
  effect: Effect;
  binding: Binding;
  grant_refs: readonly string[];
  /** Bytes an fs.write will put on disk; must hash to effect.content_sha256. */
  payload: string | null;
  ttl_ms: number;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export class AuthorizedAction {
  #genuine = true;
  readonly authorization_id: string;
  readonly proposal_id: string;
  readonly effect: Effect;
  readonly digest: string;
  readonly expires_at: number;
  readonly grant_refs: readonly string[];
  readonly payload: string | null;

  constructor(token: symbol, request: MintRequest, digest: string, expiresAt: number) {
    if (token !== MINT) throw new GateViolation("an AuthorizedAction can only be minted by the gate");
    this.authorization_id = request.authorization_id;
    this.proposal_id = request.proposal_id;
    this.effect = deepFreeze(structuredClone(request.effect));
    this.digest = digest;
    this.expires_at = expiresAt;
    this.grant_refs = Object.freeze([...request.grant_refs]);
    this.payload = request.payload;
    Object.freeze(this);
  }

  static isGenuine(value: unknown): value is AuthorizedAction {
    return typeof value === "object" && value !== null && #genuine in value;
  }
}

export interface Grant {
  grant_id: string;
  scopes: readonly string[];
  issued_by: string;
  issued_at: string;
  expires_at: string | null;
}

export class Gate {
  readonly #clock: Clock;
  readonly #grants = new Map<string, { grant: Grant; revoked: boolean }>();
  readonly #minted = new WeakSet<AuthorizedAction>();
  readonly #consumed = new Set<string>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  addGrant(grant: Grant): void {
    if (this.#grants.has(grant.grant_id)) throw new Error(`duplicate grant ${grant.grant_id}`);
    this.#grants.set(grant.grant_id, { grant: deepFreeze(structuredClone(grant)), revoked: false });
  }

  revoke(grantId: string): void {
    const entry = this.#grants.get(grantId);
    if (!entry) throw new Error(`unknown grant ${grantId}`);
    entry.revoked = true;
  }

  isActive(grantId: string, now: Date = this.#clock()): boolean {
    const entry = this.#grants.get(grantId);
    if (!entry || entry.revoked) return false;
    return entry.grant.expires_at === null || now.getTime() < Date.parse(entry.grant.expires_at);
  }

  /** scope -> grant id, over active grants only, deterministic by grant id. */
  held(now: Date = this.#clock()): Map<string, string> {
    const held = new Map<string, string>();
    for (const grantId of [...this.#grants.keys()].sort()) {
      if (!this.isActive(grantId, now)) continue;
      for (const scope of this.#grants.get(grantId)!.grant.scopes) {
        if (!held.has(scope)) held.set(scope, grantId);
      }
    }
    return held;
  }

  mint(request: MintRequest): AuthorizedAction {
    if (request.effect.kind === "fs.write") {
      if (request.payload === null || sha256(request.payload) !== request.effect.content_sha256) {
        throw new GateViolation("write payload does not match the authorized content digest");
      }
    } else if (request.payload !== null) {
      throw new GateViolation("only fs.write carries a payload");
    }
    const digest = effectDigest(request.effect, request.binding);
    const action = new AuthorizedAction(MINT, request, digest, this.#clock().getTime() + request.ttl_ms);
    this.#minted.add(action);
    return action;
  }

  /**
   * Called by an executor immediately before it acts, with the digest it
   * recomputed from what it is about to do. Any failure consumes the
   * authorization: a TOCTOU attempt does not get a second try.
   */
  redeem(action: unknown, digestNow: string): void {
    if (!AuthorizedAction.isGenuine(action) || !this.#minted.has(action)) {
      throw new GateViolation("not an AuthorizedAction minted by this gate");
    }
    if (this.#consumed.has(action.authorization_id)) {
      throw new GateViolation(`authorization ${action.authorization_id} was already used`);
    }
    this.#consumed.add(action.authorization_id);
    const now = this.#clock();
    if (now.getTime() > action.expires_at) {
      throw new GateViolation(`authorization ${action.authorization_id} expired`);
    }
    for (const grantId of action.grant_refs) {
      if (!this.isActive(grantId, now)) {
        throw new GateViolation(`grant ${grantId} was revoked or expired after authorization`);
      }
    }
    if (digestNow !== action.digest) {
      throw new GateViolation(
        `effect at execution does not match the effect authorized (${action.authorization_id})`,
      );
    }
  }
}
