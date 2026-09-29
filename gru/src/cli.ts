#!/usr/bin/env node
// The `gru` entry point: the default Lego block set plus every command.

import { defaultBlocks } from "./blocks.ts";
import { hostCommands } from "./cli/host-commands.ts";
import { ledgerCommands } from "./cli/ledger-commands.ts";
import { main } from "./cli/main.ts";

process.exitCode = await main(
  process.argv.slice(2),
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  },
  defaultBlocks,
  [...ledgerCommands(), ...hostCommands()],
);
