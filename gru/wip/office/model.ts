// The office model: a pure reducer from ledger events to what the GRU
// project office shows (CDR-006). Motion is the status, so every pose here
// is derived from a recorded event and nothing else; the office cannot show
// work that did not happen, and any episode can be replayed from its file.
//
// It is a reader. It never writes the ledger, cannot affect governance, and
// does not verify the hash chain -- that is `gru verify`. It trusts event
// bodies as recorded: a rewritten ledger replays as whatever it now says.
//
// Bodies are T1 records that carry T3 text (claims, tool names, paths), so
// every string is passed through clean() on the way in, and every field is
// read defensively: a missing or unexpected field degrades to "?" or to no
// movement, never to an exception. Unknown event types are logged as such.
//
// Cast: the Director and AVL are always present (they are the
// constitution). Minions appear only when a principal appears in the
// ledger; GRU, DRU and Nefario are never invented.

import type { LedgerEvent } from "../ledger/ledger.ts";
import { clean } from "./text.ts";

/** Log lines kept in state. The log is bounded; logTotal counts everything. */
export const LOG_LIMIT = 500;

export type Station = "shelf" | "terminal";
export type MinionPlace = "desk" | "avl" | "door" | Station;
export type MinionActivity =
  | "idle"
  | "carrying"
  | "heading"
  | "waiting"
  | "done"
  | "failed"
  | "denied"
  | "rejected"
  | "refused"
  | "flagged"
  | "thinking"
  | "undecided";

export interface MinionView {
  readonly id: string;
  readonly name: string;
  /** Desk index, in order of first appearance in the ledger. */
  readonly desk: number;
  /** Where the Minion is, or is heading. */
  readonly place: MinionPlace;
  /** Where it set off from when its pose last changed. */
  readonly from: MinionPlace;
  /** A station it worked at on the way from `from` to `place` (an effect). */
  readonly visit: Station | null;
  readonly activity: MinionActivity;
  /** What it carries or last worked on, e.g. "write_file src/a.ts". */
  readonly label: string | null;
  readonly note: string | null;
  readonly warn: boolean;
  /** Excerpt of its latest claim: ASSERTED, never verified. */
  readonly bubble: string | null;
  /** state.step when this pose began; the renderer animates only the latest. */
  readonly step: number;
}

export interface ProposalInfo {
  readonly principal: string | null;
  readonly tool: string;
  readonly kind: string | null;
  readonly label: string;
  readonly station: Station | null;
}

export interface Escalation {
  readonly authorization_id: string;
  readonly proposal_id: string | null;
  readonly principal: string | null;
  readonly label: string;
  /** Host mode: the host's own permission prompt asks the Director. */
  readonly host_prompt: boolean;
}

export interface DoorView {
  readonly waiting: readonly Escalation[];
  /** Escalations still pending when the episode closed. */
  readonly undecided: readonly Escalation[];
  readonly last: {
    readonly decision: string;
    readonly actor: string;
    readonly reason: string;
    readonly label: string;
    readonly inferred: boolean;
    readonly fail_closed: boolean;
  } | null;
  readonly revoked: readonly { readonly grant_id: string; readonly actor: string; readonly reason: string }[];
  readonly override: { readonly decision: string; readonly actor: string; readonly reason: string } | null;
  /** Which door event is the most recent. */
  readonly latest: "waiting" | "decision" | "revoked" | "override" | null;
  readonly step: number;
}

export interface StampView {
  /** ALLOW, DENY, ESCALATE, REFUSED, VIOLATION or CLOSURE (or an unknown verdict, verbatim). */
  readonly verdict: string;
  readonly label: string;
  readonly reason: string;
  readonly principal: string | null;
  readonly step: number;
}

export interface AvlView {
  readonly place: "desk" | "bench";
  readonly from: "desk" | "bench";
  readonly stamp: StampView | null;
  readonly step: number;
}

export interface Alarm {
  readonly kind: string;
  readonly detail: string;
  readonly seq: number | null;
}

export interface StationUse {
  readonly principal: string | null;
  readonly label: string;
  readonly status: "busy" | "ok" | "failed" | "refused";
  readonly step: number;
}

export interface VerificationView {
  readonly outcome: string;
  readonly strength: string;
  readonly required: string;
  readonly checksPassed: number;
  readonly checksTotal: number;
  readonly mustFailOk: number;
  readonly mustFailTotal: number;
  readonly protectedUnchanged: boolean | null;
}

export interface EpisodeView {
  readonly id: string;
  readonly task: string;
  readonly classification: string;
  /** GOVERNED, UNSAFE_DEVELOPMENT, or NOT_RECORDED when the event lacks it. */
  readonly mode: string;
  readonly unmet: readonly string[];
  readonly minion: string | null;
  readonly hostMode: boolean;
}

export interface OfficeState {
  /** Entries applied: events plus unreadable-line notes. */
  readonly step: number;
  readonly events: number;
  readonly unreadable: number;
  readonly episode: EpisodeView | null;
  readonly minions: readonly MinionView[];
  readonly director: DoorView;
  readonly avl: AvlView;
  readonly stations: { readonly shelf: StationUse | null; readonly terminal: StationUse | null };
  /** Every violation, in order. Never cleared, never softened. */
  readonly alarms: readonly Alarm[];
  /** Gate refusals at execution: AVL holding the line, not alarms. */
  readonly refusals: number;
  readonly verification: VerificationView | null;
  readonly closure: { readonly status: string; readonly rationale: string; readonly loop: string } | null;
  readonly admissibility: { readonly verdict: string; readonly failing: readonly string[] } | null;
  readonly proposals: Readonly<Record<string, ProposalInfo>>;
  /** authorization_id -> proposal_id */
  readonly authorizations: Readonly<Record<string, string>>;
  readonly log: readonly string[];
  readonly logTotal: number;
}

// ---------------------------------------------------------------- reading bodies

type Rec = { readonly [key: string]: unknown };

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const cleaned = clean(value, max);
  return cleaned.length > 0 ? cleaned : null;
}

function texts(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, max)).filter((item): item is string => item !== null);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Own-property lookup, so a ledger key like "__proto__" cannot reach Object.prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string | null): T | undefined {
  return key !== null && Object.hasOwn(record, key) ? record[key] : undefined;
}

function withKey<T>(record: Readonly<Record<string, T>>, key: string | null, value: T): Readonly<Record<string, T>> {
  if (key === null) return record;
  const copy: Record<string, T> = { ...record };
  Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
  return copy;
}

/** A principal that can be drawn as a Minion. The Director and AVL are the constitution, not Minions. */
function minionId(value: unknown): string | null {
  const id = text(value, 64);
  if (id === null) return null;
  return /^(director|avl|provider):/.test(id) ? null : id;
}

function nameOf(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 && colon < id.length - 1 ? id.slice(colon + 1) : id;
}

export function stationFor(kind: string | null): Station | null {
  switch (kind) {
    case "fs.read":
    case "fs.list":
    case "fs.write":
    case "fs.delete":
      return "shelf";
    case "process.run":
    // Host effects are performed by Claude Code or Codex; the office shows
    // them at the terminal bench, labelled with the host tool.
    case "host.exec":
    case "host.fetch":
    case "host.other":
      return "terminal";
    default:
      return null;
  }
}

function target(effect: Rec | null): string | null {
  switch (effect?.kind) {
    case "fs.read":
    case "fs.list":
    case "fs.write":
    case "fs.delete":
      return text(effect.path, 80);
    case "process.run":
      return text(effect.command_id, 64);
    case "host.exec":
      return text(effect.command, 80);
    case "host.fetch":
      return text(effect.url, 80);
    default:
      return null;
  }
}

function proposalLabel(body: Rec): string {
  const tool = text(body.tool, 48) ?? "?";
  const effect = rec(body.effect);
  const what = target(effect);
  if (effect === null && text(body.error) !== null) return `${tool} (unparsed)`;
  return what === null ? tool : `${tool} ${what}`;
}

// ---------------------------------------------------------------- state helpers

export function initialOffice(): OfficeState {
  return {
    step: 0,
    events: 0,
    unreadable: 0,
    episode: null,
    minions: [],
    director: { waiting: [], undecided: [], last: null, revoked: [], override: null, latest: null, step: 0 },
    avl: { place: "desk", from: "desk", stamp: null, step: 0 },
    stations: { shelf: null, terminal: null },
    alarms: [],
    refusals: 0,
    verification: null,
    closure: null,
    admissibility: null,
    proposals: {},
    authorizations: {},
    log: [],
    logTotal: 0,
  };
}

/** Director, AVL, then every Minion principal that has appeared in the ledger. */
export function castOf(state: OfficeState): string[] {
  return ["director", "avl", ...state.minions.map((minion) => minion.id)];
}

function episodeMinion(state: OfficeState): string | null {
  return state.episode?.minion ?? state.minions[0]?.id ?? null;
}

function ensureMinion(state: OfficeState, id: string | null): OfficeState {
  if (id === null || state.minions.some((minion) => minion.id === id)) return state;
  const minion: MinionView = {
    id,
    name: nameOf(id),
    desk: state.minions.length,
    place: "desk",
    from: "desk",
    visit: null,
    activity: "idle",
    label: null,
    note: null,
    warn: false,
    bubble: null,
    step: state.step,
  };
  return { ...state, minions: [...state.minions, minion] };
}

type Pose = { -readonly [K in keyof Omit<MinionView, "id" | "name" | "desk" | "step">]?: MinionView[K] };

/** Start a new pose. `from` defaults to where the Minion is now. */
function pose(state: OfficeState, id: string | null, change: Pose): OfficeState {
  if (id === null) return state;
  const next = ensureMinion(state, id);
  return {
    ...next,
    minions: next.minions.map((minion) =>
      minion.id === id ? { ...minion, from: minion.place, visit: null, ...change, step: next.step } : minion,
    ),
  };
}

function minion(state: OfficeState, id: string | null): MinionView | undefined {
  return id === null ? undefined : state.minions.find((candidate) => candidate.id === id);
}

function useStation(state: OfficeState, station: Station | null, use: StationUse): OfficeState {
  if (station === null) return state;
  return { ...state, stations: { ...state.stations, [station]: use } };
}

/** Send a Minion to the station its effect needs (after ALLOW or APPROVE). */
function toStation(state: OfficeState, info: ProposalInfo | undefined): OfficeState {
  if (info === undefined || info.principal === null) return state;
  if (info.station === null) {
    return pose(state, info.principal, { place: "desk", activity: "idle", label: info.label, note: "authorized; no station for this effect" });
  }
  const next = pose(state, info.principal, { place: info.station, activity: "heading", label: info.label, note: null, warn: false });
  return useStation(next, info.station, { principal: info.principal, label: info.label, status: "busy", step: next.step });
}

function appendLog(state: OfficeState, line: string): OfficeState {
  const kept = state.log.length >= LOG_LIMIT ? state.log.slice(state.log.length - LOG_LIMIT + 1) : state.log;
  return { ...state, log: [...kept, line], logTotal: state.logTotal + 1 };
}

// ---------------------------------------------------------------- the reducer

function ids(state: OfficeState, body: Rec): { aid: string | null; pid: string | null; info: ProposalInfo | undefined } {
  const aid = text(body.authorization_id, 64);
  const pid = text(body.proposal_id, 64) ?? own(state.authorizations, aid) ?? null;
  return { aid, pid, info: own(state.proposals, pid) };
}

function apply(state: OfficeState, type: string, body: Rec, seq: number | null, episodeId: string | null): OfficeState {
  switch (type) {
    case "episode.opened": {
      const intent = rec(body.intent);
      const contract = rec(body.contract);
      const safety = rec(body.safety);
      const minionPrincipal = minionId(body.minion);
      const next: OfficeState = {
        ...state,
        episode: {
          id: episodeId ?? "?",
          task: text(intent?.request, 160) ?? text(contract?.task, 160) ?? "?",
          classification: text(intent?.classification, 16) ?? text(contract?.classification, 16) ?? "?",
          mode: text(safety?.mode, 32) ?? "NOT_RECORDED",
          unmet: texts(safety?.unmet, 16),
          minion: minionPrincipal,
          hostMode: body.host_mode === true,
        },
      };
      return ensureMinion(next, minionPrincipal);
    }

    case "proposal": {
      const pid = text(body.proposal_id, 64);
      const principal = body.principal === undefined ? episodeMinion(state) : minionId(body.principal);
      const kind = text(rec(body.effect)?.kind, 32);
      const label = proposalLabel(body);
      const info: ProposalInfo = { principal, tool: text(body.tool, 48) ?? "?", kind, label, station: stationFor(kind) };
      const next = { ...state, proposals: withKey(state.proposals, pid, info) };
      return pose(next, principal, { place: "avl", activity: "carrying", label, note: null, warn: false, bubble: null });
    }

    case "authorization": {
      const { aid, pid, info } = ids(state, body);
      const verdict = text(body.verdict, 24) ?? "?";
      const reason = texts(body.reasons, 160)[0] ?? "";
      const principal = info?.principal ?? null;
      let next: OfficeState = {
        ...state,
        authorizations: pid === null ? state.authorizations : withKey(state.authorizations, aid, pid),
        avl: { ...state.avl, stamp: { verdict, label: info?.label ?? "?", reason, principal, step: state.step } },
      };
      if (verdict === "ALLOW") return toStation(next, info);
      if (verdict === "DENY") {
        return pose(next, principal, { place: "desk", activity: "denied", note: `DENY: ${clean(reason, 80)}`, warn: false });
      }
      if (verdict === "ESCALATE") {
        const hostPrompt = body.host_prompt === true;
        const escalation: Escalation = {
          authorization_id: aid ?? "?",
          proposal_id: pid,
          principal,
          label: info?.label ?? "?",
          host_prompt: hostPrompt,
        };
        next = {
          ...next,
          director: { ...next.director, waiting: [...next.director.waiting, escalation], latest: "waiting", step: next.step },
        };
        return pose(next, principal, {
          place: "door",
          activity: "waiting",
          note: hostPrompt ? "waiting for the host's permission prompt" : "waiting for the Project Director",
        });
      }
      return next;
    }

    case "director.decision": {
      const { aid, info } = ids(state, body);
      const decision = text(body.decision, 16) ?? "?";
      const actor = text(body.actor, 64) ?? "?";
      const next: OfficeState = {
        ...state,
        director: {
          ...state.director,
          waiting: state.director.waiting.filter((escalation) => escalation.authorization_id !== aid),
          last: {
            decision,
            actor,
            reason: text(body.reason, 160) ?? "",
            label: info?.label ?? "?",
            inferred: body.inferred === true,
            fail_closed: body.fail_closed === true,
          },
          latest: "decision",
          step: state.step,
        },
      };
      if (decision === "APPROVE") return toStation(next, info);
      if (decision === "REJECT") {
        return pose(next, info?.principal ?? null, { place: "desk", activity: "rejected", note: `REJECT by ${actor}`, warn: false });
      }
      return next;
    }

    case "effect": {
      const { info } = ids(state, body);
      const principal = info?.principal ?? null;
      const station = info?.station ?? null;
      const recorded = typeof body.ok === "boolean";
      const ok = body.ok === true;
      const error = text(body.error, 120);
      const note = ok ? null : recorded ? `effect failed${error === null ? "" : `: ${error}`}` : "effect outcome not recorded";
      const change: Pose = { place: "desk", visit: station, activity: ok ? "done" : "failed", note, warn: !ok };
      if (info !== undefined) change.label = info.label;
      if (station !== null) change.from = station;
      const next = pose(state, principal, change);
      return useStation(next, station, { principal, label: info?.label ?? "?", status: ok ? "ok" : "failed", step: next.step });
    }

    case "refusal": {
      // The gate refused an authorized effect at execution. Governance held;
      // this is not a breach, so it is not an alarm.
      const { info } = ids(state, body);
      const principal = info?.principal ?? null;
      const detail = text(body.detail, 160) ?? "";
      const station = info?.station ?? null;
      let next: OfficeState = {
        ...state,
        refusals: state.refusals + 1,
        avl: {
          ...state.avl,
          stamp: { verdict: "REFUSED", label: info?.label ?? text(body.kind, 32) ?? "?", reason: detail, principal, step: state.step },
        },
      };
      const change: Pose = { place: "desk", activity: "refused", note: `refused: ${clean(detail, 80)}`, warn: false };
      if (station !== null) change.from = station;
      next = pose(next, principal, change);
      return useStation(next, station, { principal, label: info?.label ?? "?", status: "refused", step: next.step });
    }

    case "violation": {
      const kind = text(body.kind, 48) ?? "UNKNOWN_VIOLATION";
      const detail = text(body.detail, 200) ?? "";
      const { info } = ids(state, body);
      const principal = info?.principal ?? null;
      const next: OfficeState = {
        ...state,
        alarms: [...state.alarms, { kind, detail, seq }],
        avl: { ...state.avl, stamp: { verdict: "VIOLATION", label: kind, reason: detail, principal, step: state.step } },
      };
      const who = minion(next, principal);
      if (who === undefined) return next;
      const change: Pose = { activity: "flagged", note: `VIOLATION ${kind}`, warn: true };
      if (who.place !== "desk" && who.activity !== "waiting") change.place = "desk";
      return pose(next, principal, change);
    }

    case "model.turn": {
      const principal = episodeMinion(state);
      const who = minion(state, principal);
      if (principal === null || (who?.place === "door" && who.activity === "waiting")) return state;
      const turn = count(body.turn);
      const model = text(body.served_model, 48);
      const note = `turn ${turn ?? "?"}${model === null ? "" : ` on ${model}`}`;
      return pose(state, principal, { place: "desk", activity: "thinking", note, warn: false });
    }

    case "claim": {
      const principal = body.principal === undefined ? episodeMinion(state) : minionId(body.principal);
      const bubble = text(body.text, 90) ?? "";
      const who = minion(state, principal);
      if (who?.place === "door" && who.activity === "waiting") {
        return { ...state, minions: state.minions.map((m) => (m.id === principal ? { ...m, bubble } : m)) };
      }
      return pose(state, principal, { place: "desk", activity: "thinking", bubble });
    }

    case "verification": {
      const checks = Array.isArray(body.checks) ? body.checks : [];
      const mustFail = Array.isArray(body.must_fail) ? body.must_fail : [];
      return {
        ...state,
        verification: {
          outcome: text(body.outcome, 16) ?? "?",
          strength: text(body.strength, 16) ?? "?",
          required: text(body.required, 16) ?? "?",
          checksPassed: checks.filter((check) => rec(check)?.passed === true).length,
          checksTotal: checks.length,
          mustFailOk: mustFail.filter((check) => rec(check)?.failed_as_required === true).length,
          mustFailTotal: mustFail.length,
          protectedUnchanged: typeof body.protected_unchanged === "boolean" ? body.protected_unchanged : null,
        },
        avl: { ...state.avl, place: "bench", from: state.avl.place, step: state.step },
      };
    }

    case "closure": {
      const status = text(body.status, 16) ?? "?";
      let next: OfficeState = {
        ...state,
        closure: { status, rationale: text(body.rationale, 400) ?? "", loop: text(body.loop, 24) ?? "?" },
        avl: {
          place: "desk",
          from: state.avl.place,
          stamp: { verdict: "CLOSURE", label: status, reason: "", principal: null, step: state.step },
          step: state.step,
        },
        director: {
          ...state.director,
          waiting: [],
          undecided: [...state.director.undecided, ...state.director.waiting],
        },
      };
      // No decision can arrive after closure: a Minion still at the door goes home undecided.
      for (const waiting of state.minions.filter((m) => m.place === "door" && m.activity === "waiting")) {
        next = pose(next, waiting.id, { place: "desk", activity: "undecided", note: "escalation undecided at closure" });
      }
      return next;
    }

    case "admissibility": {
      const conditions = rec(body.conditions) ?? {};
      const failing = Object.keys(conditions)
        .sort()
        .filter((key) => conditions[key] !== "PASS")
        .map((key) => `${clean(key, 40)}=${text(conditions[key], 16) ?? "?"}`);
      return { ...state, admissibility: { verdict: text(body.verdict, 32) ?? "?", failing } };
    }

    case "grant.revoked":
      return {
        ...state,
        director: {
          ...state.director,
          revoked: [
            ...state.director.revoked,
            { grant_id: text(body.grant_id, 32) ?? "?", actor: text(body.actor, 64) ?? "?", reason: text(body.reason, 160) ?? "" },
          ],
          latest: "revoked",
          step: state.step,
        },
      };

    case "director.override":
      return {
        ...state,
        director: {
          ...state.director,
          override: {
            decision: text(body.decision, 24) ?? "PROCEED",
            actor: text(body.actor, 64) ?? "?",
            reason: text(body.reason, 160) ?? "",
          },
          latest: "override",
          step: state.step,
        },
      };

    default:
      // grant.issued, evidence, reconciliation and unknown types: log only.
      return state;
  }
}

/** Apply one ledger event. Never mutates `state`; never throws on a malformed event. */
export function reduce(state: OfficeState, event: LedgerEvent): OfficeState {
  const record = rec(event as unknown);
  const line = describeEvent(state, event);
  const stepped: OfficeState = { ...state, step: state.step + 1, events: state.events + 1 };
  if (record === null) return appendLog(stepped, line);
  const type = typeof record.type === "string" ? record.type : "?";
  const next = apply(stepped, type, rec(record.body) ?? {}, count(record.seq), text(record.episode_id, 64));
  return appendLog(next, line);
}

/** Record that line `line` (1-based) of the ledger could not be parsed. Earlier state is kept. */
export function noteUnreadable(state: OfficeState, line: number): OfficeState {
  const stepped = { ...state, step: state.step + 1, unreadable: state.unreadable + 1 };
  return appendLog(stepped, `unreadable ledger line ${line}`);
}

export function officeFromEvents(events: readonly LedgerEvent[]): OfficeState {
  return events.reduce(reduce, initialOffice());
}

// ---------------------------------------------------------------- the log line

/** One plain line for an event, in the context of the state before it. Always escape-free. */
export function describeEvent(state: OfficeState, event: LedgerEvent): string {
  const record = rec(event as unknown);
  if (record === null) return "#? malformed event (not a JSON object)";
  const type = text(record.type, 32) ?? "?";
  const seq = count(record.seq);
  const body = rec(record.body) ?? {};
  const episodeId = text(record.episode_id, 64);
  const other = state.episode !== null && episodeId !== null && episodeId !== state.episode.id ? ` [other episode ${episodeId}]` : "";
  const detail = describeBody(state, type, body, episodeId);
  return `#${seq ?? "?"} ${type}${detail.length > 0 ? ` ${detail}` : ""}${other}`;
}

function describeBody(state: OfficeState, type: string, body: Rec, episodeId: string | null): string {
  const q = (value: unknown, max = 120): string => text(value, max) ?? "?";
  switch (type) {
    case "episode.opened": {
      const intent = rec(body.intent);
      const safety = rec(body.safety);
      const unmet = texts(safety?.unmet, 16);
      const mode = text(safety?.mode, 32) ?? "NOT_RECORDED";
      return (
        `${episodeId ?? "?"} ${q(intent?.classification, 16)} "${q(intent?.request, 100)}" safety ${mode}` +
        `${unmet.length > 0 ? ` (unmet ${unmet.join(",")})` : ""} minion ${q(body.minion, 64)}` +
        `${body.host_mode === true ? " host mode" : ""}`
      );
    }
    case "grant.issued":
      return `${q(body.grant_id, 32)} scopes [${texts(body.scopes, 40).join(", ")}] by ${q(body.issued_by, 64)}`;
    case "grant.revoked":
      return `${q(body.grant_id, 32)} revoked by ${q(body.actor, 64)}: ${q(body.reason)}`;
    case "model.turn":
      return `turn ${count(body.turn) ?? "?"} ${q(body.served_model, 48)} stop ${q(body.stop, 16)}`;
    case "claim":
      return `${q(body.principal, 64)} claim (not verified): "${q(body.text, 90)}"`;
    case "proposal": {
      const error = text(body.error, 100);
      return `${q(body.proposal_id, 32)} ${q(body.principal, 64)} proposes ${proposalLabel(body)}${error === null ? "" : ` (${error})`}`;
    }
    case "authorization": {
      const { aid, info } = ids(state, body);
      const verdict = text(body.verdict, 24) ?? "?";
      const reason = texts(body.reasons, 140)[0];
      const why = verdict !== "ALLOW" && reason !== undefined ? `: ${reason}` : "";
      const prompt = body.host_prompt === true ? " (host prompt)" : "";
      return `${aid ?? "?"} ${verdict} ${info?.label ?? "?"}${prompt}${why}`;
    }
    case "director.decision": {
      const { aid, info } = ids(state, body);
      const flags = `${body.inferred === true ? " (inferred)" : ""}${body.fail_closed === true ? " (fail-closed)" : ""}`;
      return `${aid ?? "?"} ${q(body.decision, 16)} ${info?.label ?? "?"} by ${q(body.actor, 64)}${flags}: ${q(body.reason)}`;
    }
    case "effect": {
      const { info } = ids(state, body);
      const outcome = body.ok === true ? "ok" : body.ok === false ? "FAILED" : "outcome not recorded";
      const error = text(body.error, 100);
      return `${q(body.effect_id, 32)} ${outcome} ${info?.label ?? "?"} by ${q(body.performed_by, 16)}${error === null ? "" : `: ${error}`}`;
    }
    case "refusal": {
      const { aid, info } = ids(state, body);
      return `${aid ?? "?"} ${q(body.kind, 32)} ${info?.label ?? "?"} (the gate held): ${q(body.detail, 140)}`;
    }
    case "violation":
      return `VIOLATION ${q(body.kind, 48)}: ${q(body.detail, 160)}`;
    case "evidence": {
      const id = text(body.evidence_id, 64);
      return `${q(body.label, 60)} ${q(body.relation, 16)} ${count(body.bytes) ?? "?"}B ${id === null ? "?" : id.slice(0, 12)}`;
    }
    case "reconciliation": {
      const unexplained = Array.isArray(body.unexplained) ? body.unexplained.length : null;
      const explained = Array.isArray(body.explained) ? body.explained.length : null;
      return `${unexplained ?? "?"} unexplained, ${explained ?? "?"} explained change(s)`;
    }
    case "verification": {
      const checks = Array.isArray(body.checks) ? body.checks : [];
      const passed = checks.filter((check) => rec(check)?.passed === true).length;
      const mustFail = Array.isArray(body.must_fail) ? body.must_fail : [];
      const failed = mustFail.filter((check) => rec(check)?.failed_as_required === true).length;
      return (
        `outcome ${q(body.outcome, 16)}; strength ${q(body.strength, 16)} (required ${q(body.required, 16)}); ` +
        `checks ${passed}/${checks.length} passed; must-fail ${failed}/${mustFail.length} failed as required`
      );
    }
    case "closure":
      return `${q(body.status, 16)} (loop ${q(body.loop, 24)}): ${q(body.rationale, 300)}`;
    case "director.override":
      return `${q(body.decision, 24)} by ${q(body.actor, 64)}: ${q(body.reason)}`;
    case "admissibility": {
      const conditions = rec(body.conditions) ?? {};
      const failing = Object.keys(conditions)
        .sort()
        .filter((key) => conditions[key] !== "PASS")
        .map((key) => `${clean(key, 40)}=${text(conditions[key], 16) ?? "?"}`);
      return `${q(body.verdict, 32)}${failing.length > 0 ? ` (${failing.join(", ")})` : ""}`;
    }
    default:
      return "(not understood by the office)";
  }
}
