// The Workbench view: every panel is a fold over ledger events, nothing else.
//
// Pure and I/O-free: ledgers come in as parsed events plus the problems
// verifyChain/verifyStructure found, the view goes out as plain JSON. The
// page draws only what this returns, so the Workbench can never show a
// state the ledger does not record. Text that came from a Minion (claims,
// paths, command ids) is carried as data; the page must render it as text.

import type { Json } from "../ledger/canonical.ts";
import { challenge, type Objection } from "../dru/challenge.ts";
import type { LedgerEvent } from "../ledger/ledger.ts";

export interface EpisodeInput {
  episode_id: string;
  events: readonly LedgerEvent[];
  /** verifyChain + verifyStructure findings; empty means the ledger verifies. */
  problems: readonly string[];
  /** Evidence blob reader, so DRU can read what the Minion wrote. */
  blob?: (digest: string) => string | undefined;
}

export type Tone = "ok" | "warn" | "bad" | "info";
export type MinionStatus = "RUNNING" | "PASS" | "FAIL" | "PARTIAL" | "ABANDONED";

export interface FeedItem {
  at: string;
  seq: number;
  episode_id: string;
  minion: string;
  type: string;
  /** Who speaks in the terminal: GRU, AVL, DRU, NEFARIO, DIRECTOR or MINION. */
  actor: string;
  text: string;
  tone: Tone;
}

export interface PendingApproval {
  episode_id: string;
  minion: string;
  authorization_id: string;
  tool: string;
  effect: string;
  consequences: string[];
  reasons: string[];
  at: string;
}

export interface CheckView {
  episode_id: string;
  minion: string;
  id: string;
  kind: "check" | "must_fail";
  /** The check did what the contract needs: passed, or (must_fail) failed. */
  ok: boolean;
  exit_code: number;
}

export interface MinionView {
  episode_id: string;
  minion: string;
  task: string;
  classification: string;
  status: MinionStatus;
  activity: string;
  turns: number;
  tool_calls: number;
  /** Share of the contract's tool-call budget used; not a completion estimate. */
  budget_used: number | null;
  allowed: number;
  escalated: number;
  denied: number;
  refusals: number;
  violations: number;
  evidence: number;
  strength: string | null;
  required: string | null;
  admissibility: string | null;
  rationale: string | null;
  route: string | null;
  safety: { mode: string; unmet: string[]; backends: string[] } | null;
  started_at: string;
  last_at: string;
  ledger_ok: boolean;
  problems: string[];
  /** DRU v0's objections to this episode, most severe first. */
  objections: Objection[];
  /** Model usage summed over the episode's turns, as the route reported it. */
  tokens: { input: number; output: number; cache_read: number };
  served_model: string | null;
  duration_ms: number;
}

export interface WorkbenchView {
  generated_at: string;
  episodes: MinionView[];
  feed: FeedItem[];
  pending: PendingApproval[];
  checks: CheckView[];
  totals: {
    episodes: number;
    running: number;
    pass: number;
    fail: number;
    partial: number;
    abandoned: number;
    escalations: number;
    denials: number;
    refusals: number;
    violations: number;
    evidence: number;
    ledgers_broken: number;
    objections: number;
    high_objections: number;
  };
  dru: { top: (Objection & { minion: string }) | null; by_question: Record<string, number> };
  lab: { routes: { id: string; episodes: number }[]; backends: { id: string; episodes: number }[]; unmet: string[] };
}

export const FEED_LIMIT = 300;

type Body = { [key: string]: Json };

function body(event: LedgerEvent): Body {
  const b = event.body;
  return typeof b === "object" && b !== null && !Array.isArray(b) ? b : {};
}

function str(value: Json | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: Json | undefined): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/** One line for an effect, from its structured fields only. */
export function describeEffect(effect: Json | undefined): string {
  const e = record(effect);
  const kind = str(e.kind, "effect");
  if (typeof e.path === "string") return `${kind} ${e.path}`;
  if (typeof e.command_id === "string") return `${kind} ${e.command_id}`;
  return kind;
}

function shortName(principal: string): string {
  return principal.replace(/^minion:/, "");
}

function statusOf(value: string): MinionStatus {
  return value === "PASS" || value === "FAIL" || value === "PARTIAL" || value === "ABANDONED" ? value : "RUNNING";
}

function foldEpisode(input: EpisodeInput, feed: FeedItem[], pending: PendingApproval[], checks: CheckView[]): MinionView {
  const events = input.events;
  const opened = events[0] !== undefined && events[0].type === "episode.opened" ? body(events[0]) : {};
  const contract = record(opened.contract);
  const minion = shortName(str(opened.minion, "unknown"));
  const budget = num(record(contract.budget).max_tool_calls);
  const provenance = record(opened.provenance);
  const route = typeof record(provenance.route).id === "string" ? str(record(provenance.route).id) : null;
  const safetyBody = record(opened.safety);
  const view: MinionView = {
    episode_id: input.episode_id,
    minion,
    task: str(contract.task),
    classification: str(contract.classification),
    status: "RUNNING",
    activity: "opened",
    turns: 0,
    tool_calls: 0,
    budget_used: null,
    allowed: 0,
    escalated: 0,
    denied: 0,
    refusals: 0,
    violations: 0,
    evidence: 0,
    strength: null,
    required: null,
    admissibility: null,
    rationale: null,
    route,
    safety: typeof safetyBody.mode === "string"
      ? { mode: str(safetyBody.mode), unmet: strings(safetyBody.unmet), backends: strings(safetyBody.backends) }
      : null,
    started_at: str(opened.started_at, events[0]?.at ?? ""),
    last_at: events.at(-1)?.at ?? "",
    ledger_ok: input.problems.length === 0,
    problems: [...input.problems],
    objections: challenge(events, input.problems, input.blob),
    tokens: { input: 0, output: 0, cache_read: 0 },
    served_model: null,
    duration_ms: 0,
  };

  const proposals = new Map<string, { tool: string; effect: string; consequences: string[] }>();
  const escalations = new Map<string, PendingApproval>();
  const decided = new Set<string>();
  // The card shows the most telling moment: the latest warning or failure, else the latest action.
  let notable: string | null = null;
  let latest = "opened";
  const say = (event: LedgerEvent, text: string, tone: Tone): void => {
    feed.push({ at: event.at, seq: event.seq, episode_id: input.episode_id, minion, type: event.type, actor: actorOf(event.type), text, tone });
    if (event.type === "closure" || event.type === "episode.opened") return;
    if (tone === "warn" || tone === "bad") notable = text;
    latest = text;
  };

  for (const event of events) {
    const b = body(event);
    switch (event.type) {
      case "episode.opened":
        say(event, "opened the episode", "info");
        break;
      case "model.turn": {
        view.turns++;
        const usage = record(b.usage);
        view.tokens.input += num(usage.input_tokens) ?? 0;
        view.tokens.output += num(usage.output_tokens) ?? 0;
        view.tokens.cache_read += num(usage.cache_read_input_tokens) ?? 0;
        if (typeof b.served_model === "string") view.served_model = b.served_model;
        break;
      }
      case "proposal": {
        view.tool_calls++;
        proposals.set(str(b.proposal_id), { tool: str(b.tool), effect: describeEffect(b.effect), consequences: strings(b.consequences) });
        break;
      }
      case "authorization": {
        const proposal = proposals.get(str(b.proposal_id)) ?? { tool: "?", effect: "?", consequences: [] };
        const verdict = str(b.verdict);
        if (verdict === "ALLOW") {
          view.allowed++;
          say(event, `allowed ${proposal.effect}`, "ok");
        } else if (verdict === "ESCALATE") {
          view.escalated++;
          escalations.set(str(b.authorization_id), {
            episode_id: input.episode_id,
            minion,
            authorization_id: str(b.authorization_id),
            tool: proposal.tool,
            effect: proposal.effect,
            consequences: proposal.consequences,
            reasons: strings(b.reasons),
            at: event.at,
          });
          say(event, `needs the Director: ${proposal.effect} (${proposal.consequences.join(", ")})`, "warn");
        } else {
          view.denied++;
          say(event, `denied ${proposal.effect}: ${strings(b.reasons).join("; ")}`, "bad");
        }
        break;
      }
      case "director.decision": {
        decided.add(str(b.authorization_id));
        const approve = str(b.decision) === "APPROVE";
        if (!approve) view.denied++;
        say(event, `Director ${approve ? "approved" : "rejected"}: ${str(b.reason)}`, approve ? "ok" : "warn");
        break;
      }
      case "effect":
        if (b.ok === false) say(event, `effect failed: ${str(b.error, "error")}`, "bad");
        break;
      case "refusal":
        view.refusals++;
        say(event, `gate held: ${str(b.detail, str(b.kind, "refused at execution"))}`, "warn");
        break;
      case "violation":
        view.violations++;
        say(event, `violation ${str(b.kind)}: ${str(b.detail, str(b.message, str(b.path)))}`, "bad");
        break;
      case "evidence":
        view.evidence++;
        break;
      case "claim":
        say(event, `says: "${str(b.text)}"`, "info");
        break;
      case "verification": {
        view.strength = str(b.strength) || null;
        view.required = str(b.required) || null;
        for (const entry of Array.isArray(b.checks) ? b.checks : []) {
          const c = record(entry);
          checks.push({ episode_id: input.episode_id, minion, id: str(c.id), kind: "check", ok: c.passed === true, exit_code: num(c.exit_code) ?? -1 });
        }
        for (const entry of Array.isArray(b.must_fail) ? b.must_fail : []) {
          const c = record(entry);
          checks.push({ episode_id: input.episode_id, minion, id: str(c.id), kind: "must_fail", ok: c.failed_as_required === true, exit_code: num(c.exit_code) ?? -1 });
        }
        const outcome = str(b.outcome);
        say(event, `verification ${outcome} at ${view.strength ?? "?"}`, outcome === "PASS" ? "ok" : outcome === "FAIL" ? "bad" : "info");
        break;
      }
      case "closure":
        view.status = statusOf(str(b.status));
        view.rationale = str(b.rationale) || null;
        say(event, `closed ${view.status}`, view.status === "PASS" ? "ok" : view.status === "FAIL" ? "bad" : "warn");
        break;
      case "director.override":
        say(event, `Director override: ${str(b.decision)} (${str(b.residual_risk, "risk accepted")})`, "warn");
        break;
      case "admissibility":
        view.admissibility = str(b.verdict) || null;
        break;
      default:
        break;
    }
  }

  view.activity = notable ?? latest;
  const span = Date.parse(view.last_at) - Date.parse(view.started_at);
  view.duration_ms = Number.isFinite(span) && span > 0 ? span : 0;
  // DRU speaks in the terminal after the closure it doubts.
  view.objections
    .filter((objection) => objection.rule !== "network-open")
    .forEach((objection, index) =>
      feed.push({
        at: view.last_at, seq: 1_000_000 + index, episode_id: input.episode_id, minion, type: "dru.objection", actor: "DRU",
        text: `${objection.severity} ${objection.question}: ${objection.text}`, tone: objection.severity === "HIGH" ? "bad" : "warn",
      }),
    );
  if (budget !== null && budget > 0) view.budget_used = view.status === "RUNNING" ? Math.min(1, view.tool_calls / budget) : view.tool_calls / budget;
  if (view.status === "RUNNING") {
    for (const [id, approval] of escalations) if (!decided.has(id)) pending.push(approval);
  }
  return view;
}

function actorOf(type: string): string {
  if (type === "episode.opened") return "GRU";
  if (type === "director.decision" || type === "director.override") return "DIRECTOR";
  if (type === "claim" || type === "effect") return "MINION";
  return "AVL";
}

function tally(values: (string | null)[]): { id: string; episodes: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([id, episodes]) => ({ id, episodes })).sort((a, b) => b.episodes - a.episodes || a.id.localeCompare(b.id));
}

function druSummary(episodes: readonly MinionView[]): WorkbenchView["dru"] {
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  let top: (Objection & { minion: string }) | null = null;
  const by_question: Record<string, number> = {};
  for (const episode of episodes) {
    for (const objection of episode.objections) {
      by_question[objection.question] = (by_question[objection.question] ?? 0) + 1;
      // Network-open applies to every episode alike; it is not the headline.
      if (objection.rule === "network-open") continue;
      if (top === null || rank[objection.severity] < rank[top.severity]) top = { ...objection, minion: episode.minion };
    }
  }
  return { top, by_question };
}

export function buildView(inputs: readonly EpisodeInput[], now: Date = new Date()): WorkbenchView {
  const feed: FeedItem[] = [];
  const pending: PendingApproval[] = [];
  const checks: CheckView[] = [];
  const episodes = inputs.map((input) => foldEpisode(input, feed, pending, checks));
  episodes.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.minion.localeCompare(b.minion));
  feed.sort((a, b) => a.at.localeCompare(b.at) || a.episode_id.localeCompare(b.episode_id) || a.seq - b.seq);
  const count = (status: MinionStatus) => episodes.filter((episode) => episode.status === status).length;
  const sum = (key: "escalated" | "denied" | "refusals" | "violations" | "evidence") => episodes.reduce((total, episode) => total + episode[key], 0);
  const routes = tally(episodes.map((episode) => episode.route));
  const backends = tally(episodes.flatMap((episode) => episode.safety?.backends ?? []));
  const unmet = [...new Set(episodes.flatMap((episode) => episode.safety?.unmet ?? []))].sort();
  const shown = feed.slice(-FEED_LIMIT);
  if (shown.length > 0) {
    shown.unshift({
      at: shown[0]!.at, seq: -1, episode_id: "", minion: "", type: "lab", actor: "NEFARIO", tone: "info",
      text: `lab ready: routes ${routes.map((r) => r.id).join(", ") || "none"}; isolation ${backends.map((b) => b.id).join(", ") || "none"}${unmet.length ? `; unmet ${unmet.join(", ")}` : ""}`,
    });
  }
  return {
    generated_at: now.toISOString(),
    episodes,
    feed: shown,
    pending,
    checks,
    totals: {
      episodes: episodes.length,
      running: count("RUNNING"),
      pass: count("PASS"),
      fail: count("FAIL"),
      partial: count("PARTIAL"),
      abandoned: count("ABANDONED"),
      escalations: sum("escalated"),
      denials: sum("denied"),
      refusals: sum("refusals"),
      violations: sum("violations"),
      evidence: sum("evidence"),
      ledgers_broken: episodes.filter((episode) => !episode.ledger_ok).length,
      objections: episodes.reduce((total, episode) => total + episode.objections.length, 0),
      high_objections: episodes.reduce((total, episode) => total + episode.objections.filter((o) => o.severity === "HIGH").length, 0),
    },
    dru: druSummary(episodes),
    lab: { routes, backends, unmet },
  };
}
