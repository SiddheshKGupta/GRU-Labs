// The episode ledger: append-only, hash-chained, one event per line.
//
// Tamper-evident, not tamper-proof. Anyone with write access to the state
// directory can rewrite the whole chain consistently; there is no external
// anchor yet. What the chain does guarantee is that an edit to any single
// event, or a deletion or reordering, is detected by `verifyChain`.

import { canonical, sha256, toJson, type Json } from "./canonical.ts";
import type { LedgerStore } from "./store.ts";

export type EventType =
  | "episode.opened"
  | "grant.issued"
  | "grant.revoked"
  | "model.turn"
  | "claim"
  | "proposal"
  | "authorization"
  | "director.decision"
  | "effect"
  | "evidence"
  | "violation"
  // The gate held: an authorized effect was refused at execution (revoked
  // grant, expiry, a changed binding). Governance working, not a breach.
  | "refusal"
  | "reconciliation"
  | "verification"
  | "closure"
  | "director.override"
  | "admissibility";

export interface LedgerEvent {
  seq: number;
  episode_id: string;
  at: string;
  type: EventType;
  body: Json;
  prev: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function eventHash(event: Omit<LedgerEvent, "hash">): string {
  return sha256(canonical(event));
}

export class Ledger {
  readonly episodeId: string;
  readonly store: LedgerStore;
  readonly #clock: Clock;
  readonly #events: LedgerEvent[] = [];

  constructor(episodeId: string, store: LedgerStore, clock: Clock = systemClock) {
    this.episodeId = episodeId;
    this.store = store;
    this.#clock = clock;
  }

  get events(): readonly LedgerEvent[] {
    return this.#events;
  }

  append(type: EventType, body: unknown): LedgerEvent {
    const last = this.#events.at(-1);
    const unsigned = {
      seq: this.#events.length,
      episode_id: this.episodeId,
      at: this.#clock().toISOString(),
      type,
      body: toJson(body),
      prev: last ? last.hash : GENESIS,
    };
    const event: LedgerEvent = { ...unsigned, hash: eventHash(unsigned) };
    this.store.append(canonical(event));
    this.#events.push(event);
    return event;
  }

  /** Store bytes by digest and record what they are evidence of. */
  evidence(
    bytes: string | Uint8Array,
    meta: { producer: string; relation: "SUPPORTS" | "FALSIFIES" | "VERIFIES" | "DERIVED_FROM"; subjects: string[]; label: string },
  ): string {
    const digest = this.store.putBlob(bytes);
    const size = typeof bytes === "string" ? new TextEncoder().encode(bytes).length : bytes.length;
    this.append("evidence", {
      evidence_id: digest,
      producer: meta.producer,
      relation: meta.relation,
      subject_refs: meta.subjects,
      label: meta.label,
      bytes: size,
    });
    return digest;
  }
}

export function parseLedger(lines: string[]): LedgerEvent[] {
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as LedgerEvent;
    } catch {
      throw new Error(`ledger line ${index} is not JSON`);
    }
  });
}
