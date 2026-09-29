// `gru challenge`: DRU's objections to every episode in a state directory.

import { resolve } from "node:path";
import { safeText } from "./render.ts";
import { loadView } from "../workbench/load.ts";
import { parseFlags, UsageError, type Command } from "./main.ts";

export const challengeCommand: Command = {
  name: "challenge",
  summary: "DRU's objections to the episodes in a state directory",
  usage: `Usage: gru challenge --state <dir> [--all]

DRU v0 reads each ledger and the code the Minion wrote, and objects where
a closure rests on something weaker than it looks. Rules, not a model; it
never changes a closure. --all includes the shared open-network caveat.
Exits 1 when any HIGH objection stands.
`,
  async run(args, context) {
    const { flags } = parseFlags(args, { flags: { state: "string", all: "boolean" }, positionals: [] });
    if (typeof flags.state !== "string") throw new UsageError("--state is required");
    const view = loadView(resolve(context.io.cwd, flags.state));
    const out = context.io.stdout;
    let high = 0;
    for (const episode of view.episodes) {
      const objections = episode.objections.filter((o) => flags.all === true || o.rule !== "network-open");
      high += objections.filter((o) => o.severity === "HIGH").length;
      out.write(`${episode.status.padEnd(9)} ${safeText(episode.minion)}  ${objections.length === 0 ? "no objections" : ""}\n`);
      for (const o of objections) out.write(`  ${o.severity.padEnd(6)} ${o.question.padEnd(14)} ${safeText(o.text, { max: 400 })}\n`);
    }
    out.write(`\n${view.episodes.length} episodes, ${high} HIGH objection(s). DRU v0 is rules over the ledger, not a model.\n`);
    return high > 0 ? 1 : 0;
  },
};
