// `gru workbench`: the Director's view of every episode in a state directory.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadView } from "../workbench/load.ts";
import { workbenchHtml } from "../workbench/page.ts";
import { startWorkbench } from "../workbench/server.ts";
import { parseFlags, UsageError, type Command } from "./main.ts";

export const workbenchCommand: Command = {
  name: "workbench",
  summary: "open the GRU Workbench on the episodes in a state directory",
  usage: `Usage: gru workbench --state <dir> [--port <n>] [--snapshot <file.html>]

Serves a read-only dashboard on http://127.0.0.1:<port>/ (default 7420)
that follows every ledger in the state directory as it is written: GRU,
the Minions, the terminal feed, AVL's authorizations and verification.
--snapshot writes one self-contained HTML file of the current state
instead of serving.
`,
  async run(args, context) {
    const { flags } = parseFlags(args, { flags: { state: "string", port: "string", snapshot: "string" }, positionals: [] });
    if (typeof flags.state !== "string") throw new UsageError("--state is required");
    const state = resolve(context.io.cwd, flags.state);
    if (typeof flags.snapshot === "string") {
      const out = resolve(context.io.cwd, flags.snapshot);
      writeFileSync(out, workbenchHtml({ mode: "snapshot", view: loadView(state) }));
      context.io.stdout.write(`wrote ${out}\n`);
      return 0;
    }
    const port = typeof flags.port === "string" ? Number(flags.port) : 7420;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be 0-65535");
    const server = await startWorkbench({ view: () => loadView(state), port });
    context.io.stdout.write(`GRU Workbench on ${server.url} (read-only; Ctrl-C to stop)\n`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    await server.close();
    return 0;
  },
};
