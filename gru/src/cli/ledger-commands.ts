// Commands over persisted episodes: `gru verify` and `gru override`.
//
// verify re-derives everything from the ledger alone -- chain, structure,
// evidence blobs and admissibility -- and compares the recomputed verdict
// with the one recorded at closure. It trusts nothing the session wrote
// about itself except the events.
//
// override is the Director's way to proceed past a closure that is not
// PASS (spec §4.4, freeze §7). It appends; it never edits closure or
// verification, and admissibility is unchanged by it (D2).
//
// Limit: the ledger is tamper-evident, not tamper-proof. Someone with write
// access to the state directory can rewrite a whole chain consistently;
// verify detects edits, not wholesale replacement.

import { sha256 } from "../ledger/canonical.ts";
import { computeAdmissibility } from "../ledger/admissibility.ts";
import { Ledger, parseLedger, type LedgerEvent } from "../ledger/ledger.ts";
import { FileStore, listEpisodes } from "../ledger/store.ts";
import { verifyChain, verifyStructure } from "../ledger/validate.ts";
import { parseFlags, UsageError, type Command } from "./main.ts";

interface Checked {
  episode_id: string;
  ok: boolean;
  closure: string | null;
  admissibility: string | null;
  problems: string[];
}

export function checkEpisode(stateDir: string, episodeId: string): Checked {
  const store = FileStore.open(stateDir, episodeId);
  const problems: string[] = [];
  let events: LedgerEvent[] = [];
  try {
    events = parseLedger(store.lines());
  } catch (error) {
    return { episode_id: episodeId, ok: false, closure: null, admissibility: null, problems: [(error as Error).message] };
  }
  problems.push(...verifyChain(events), ...verifyStructure(events));
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const id = (event.body as { evidence_id?: unknown }).evidence_id;
    const blob = typeof id === "string" ? store.getBlob(id) : undefined;
    if (blob === undefined) problems.push(`evidence ${String(id)} is missing from the blob store`);
    else if (sha256(blob) !== id) problems.push(`evidence ${String(id)} does not hash to its id`);
  }
  const closure = events.findLast((event) => event.type === "closure");
  const recorded = events.findLast((event) => event.type === "admissibility");
  const upToRecorded = recorded ? events.slice(0, recorded.seq) : events;
  const recomputed = computeAdmissibility(upToRecorded).verdict;
  const recordedVerdict = recorded ? String((recorded.body as { verdict?: unknown }).verdict) : null;
  if (recordedVerdict !== null && recordedVerdict !== recomputed) {
    problems.push(`recorded admissibility ${recordedVerdict} but the ledger recomputes to ${recomputed}`);
  }
  return {
    episode_id: episodeId,
    ok: problems.length === 0,
    closure: closure ? String((closure.body as { status?: unknown }).status) : null,
    admissibility: recordedVerdict,
    problems,
  };
}

const verifyCommand: Command = {
  name: "verify",
  summary: "re-verify episode ledgers: chain, structure, evidence, admissibility",
  usage: `Usage: gru verify --state <dir> [--episode <id>] [--json]

Re-derives every recorded episode from its ledger alone and reports any
break. Exit 0 only when every checked episode verifies.
`,
  async run(args, { io }) {
    const parsed = parseFlags(args, { flags: { state: "string", episode: "string", json: "boolean" }, positionals: [] });
    const state = parsed.flags.state;
    if (typeof state !== "string") throw new UsageError("--state is required");
    const only = parsed.flags.episode;
    const ids = typeof only === "string" ? [only] : listEpisodes(state);
    if (ids.length === 0) throw new UsageError(`no episodes in ${state}`);
    const results = ids.map((id) => checkEpisode(state, id));
    if (parsed.flags.json === true) {
      io.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else {
      for (const result of results) {
        io.stdout.write(`${result.ok ? "ok  " : "FAIL"}  ${result.episode_id}  closure=${result.closure ?? "-"}  admissibility=${result.admissibility ?? "-"}\n`);
        for (const problem of result.problems) io.stdout.write(`      ${problem}\n`);
      }
    }
    return results.every((result) => result.ok) ? 0 : 1;
  },
};

const overrideCommand: Command = {
  name: "override",
  summary: "record a Project Director override of a closure that is not PASS",
  usage: `Usage: gru override --state <dir> --episode <id> --actor director:<name> --reason <text>

Records Director Decision PROCEED with residual risk ACCEPTED. The closure
and verification stay exactly as recorded: an override never turns a
FAIL into a PASS.
`,
  async run(args, { io }) {
    const parsed = parseFlags(args, {
      flags: { state: "string", episode: "string", actor: "string", reason: "string" },
      positionals: [],
    });
    const { state, episode, actor, reason } = parsed.flags;
    if (typeof state !== "string" || typeof episode !== "string" || typeof actor !== "string" || typeof reason !== "string") {
      throw new UsageError("--state, --episode, --actor and --reason are all required");
    }
    if (!/^director:[a-z0-9][a-z0-9._-]{0,63}$/.test(actor)) {
      throw new UsageError("--actor must be director:<name>; only the Project Director can override");
    }
    if (reason.trim().length === 0) throw new UsageError("--reason must say why the risk is accepted");
    const ledger = Ledger.resume(episode, FileStore.open(state, episode));
    const closure = ledger.events.findLast((event) => event.type === "closure");
    if (closure === undefined) throw new UsageError(`episode ${episode} has not closed; there is nothing to override`);
    const status = String((closure.body as { status?: unknown }).status);
    if (status === "PASS") throw new UsageError(`episode ${episode} closed PASS; an override would record nothing`);
    ledger.append("director.override", {
      closure_seq: closure.seq,
      closure_status: status,
      decision: "PROCEED",
      residual_risk: "ACCEPTED",
      actor,
      reason,
    });
    io.stdout.write(`recorded: Verification ${status} / Director PROCEED / Residual risk ACCEPTED by ${actor}\n`);
    return 0;
  },
};

export function ledgerCommands(): Command[] {
  return [verifyCommand, overrideCommand];
}
