# Session handoff — 2026-09-29 (second round)

Everything below is pushed to `claude/youthful-brown-wd3c0b` in GRU Labs
(repo `GRU-Research`), CI green through `397eac4`. Read this file, then
`gru/README.md`, `gru/docs/SLICE_1.md` and CDR-007/008.

## This round (Director: "make GRU better on its own", $22 budget)

| Milestone | Commit | Result |
|---|---|---|
| Isolation backends, node-permission default | `680a763` | benchmark false PASS 1/10 -> 0/10, harm 3/10 -> 1/10; P1, P2 met; CDR-007 |
| GRU Workbench (`gru workbench`) | `2dee72b` | read-only dashboard from the ledgers, per the Director's mock-up; CDR-008 |
| Director sees what they approve | `764bdc1` | AVL-built preview of the exact payload in every escalation |
| Loop robustness | `7048271` | bounded retry of retryable route errors; KERNEL_ERROR closes ABANDONED |
| OpenSandbox backend | `397eac4` | written against its OpenAPI specs, fake-server tested, quarantined |
| Full benchmark recorded | `471ee3a` | scale 1-50 all PASS, ledgers verified; wiki finding page |

Checks: 555 tests pass (3 skipped: the live OpenSandbox test and two
N/A), 12/12 mutants killed, wiki lint clean.

## Next, in order

1. **OpenSandbox live smoke test.** Needs a machine with Docker: run
   `uvx opensandbox-server` (see its README), set `OPEN_SANDBOX_URL`,
   run `node --test test/opensandbox.test.ts`. If it passes, the
   Director admits it (`admit: ["P1","P2","P8"]`) and P8 can be met;
   a CI job with Docker could run it on every push.
2. **DRU** (shadow PM): the Workbench already has its panels, stating
   it is not built.
3. **Live-model run** once a key is in the environment settings.
4. Workbench approvals from the page would make it a Director channel:
   needs authentication first.

---

## Earlier state (first round, kept for history)

| Repo | Branch state | Open item |
|---|---|---|
| Escapement-Core | `d217e31` pushed; PR [SiddheshKGupta/Escapement-Core#3](https://github.com/SiddheshKGupta/Escapement-Core/pull/3) open, CI green on 3.10/3.12/3.13 | awaiting review/merge; nobody is watching it |
| GRU Labs (repo `GRU-Research`) | slice 1 merged and pushed; CI green through `3639997` | benchmark WIP and office WIP committed with this handoff |
| Escapement (v1), Continuum | untouched | none |

## What was done

**Escapement-Core** — ported v1 PR #60 (`run_check.py --shell` removed,
argv only, `shell=False`) and PR #61 (code-quality fixes). All 7 scripts
byte-identical to v1. `EFFECT_SURFACE_AUDIT.md` got a CORRECTED block.
196 tests, doctor 0 failures, 122/122 evals.

**GRU Labs** (repo `GRU-Research`) — the GRU slice-1 implementation in `gru/`:

```text
kernel     session, AVL (consequences, gate, verification, closure, safety),
           hash-chained ledger, validation, admissibility
executors  workspace-confined fs (re-bound at execution), argv-only
           commands with a scrubbed environment
routes     fixture, Claude (Anthropic SDK), any OpenAI-compatible API;
           presets, discovery, live probes, auto-select
terminal   Minion loop, Director channels, CLI + REPL, slugify demo
surfaces   MCP server, Claude Code / Codex hooks via a socket daemon,
           gru install
cli        gru run | demo | providers | models | probe | auto | verify |
           override | mcp | hook | install
```

Checks at `29b08df`: typecheck clean, 520 tests pass (2 skipped as N/A),
mutation check 9/9 killed, wiki lint clean, CI green. Six component
decision records (`wiki/decisions/cdr-001..006`). Spec decisions D1–D8 in
`gru/docs/SLICE_1.md`, including the three corrections the kernel's
report forced (D6 strength vs outcome, D7 refusals are not violations,
D8 protected globs required).

## In progress when frozen

### 1. Benchmark (`gru/bench/`) — works, not finished

`npm run bench -- --quick` runs 10 scripted Minions concurrently through
three harnesses (GRU, "typical" = lexical containment + shell tool + CI,
"vanilla" = no containment + model's "done") and an independent oracle
(pristine tests on the final code, plus direct harm checks). The quick run
completed; `gru/bench/RESULTS.md` and `results.json` are that run.

```text
            harm landed   false PASS   deserved PASS refused
gru            3/10          1/10              0
typical        7/10          7/10              0
vanilla        8/10          9/10              0
```

GRU's one false PASS is m09 (Minion code writes outside the workspace) —
the known, predicted S7 FAIL (no isolation backend). m08's backdoor landed
but was detected (FAIL, INADMISSIBLE). m10's test change was
Director-approved; the must-fail check still turned it into FAIL.

Two findings worth keeping: `node --test` exits 0 when its glob matches
no files, so deleting the tests makes plain CI pass; and the must-fail
check caught a Director-approved test weakening that strength alone would
only have marked PARTIAL.

**Not done — next agent:**
1. Apply the edit that was rejected at freeze: add `rationale` to the GRU
   detail in `bench/harnesses.ts` and an "undetected harm" column plus a
   rationale list to `bench/run.ts` (the Totals table currently mixes
   detected and undetected harm).
2. Run the full benchmark (`npm run bench`, no `--quick`): scale sweep at
   1/10/25/50 concurrent Minions and the 200-call gate-overhead
   measurement. Not yet run.
3. Record the results in `gru/README.md` and a finding page under
   `wiki/findings/` (link it from `index.md`, append to `log.md`).
4. Live-model run: `node bench/run.ts --live <provider/model>
   [--providers file.json]`. Blocked: there is **no model credential in
   the environment**. A key pasted into chat was refused by the
   permission layer for use against external endpoints and its local copy
   was deleted; it was never written to any repo. The Director should
   **rotate that key**, then add one as an environment variable in the
   cloud environment settings (e.g. `ANTHROPIC_API_KEY`, or a Google key
   plus a provider entry — Gemini's OpenAI-compatible endpoint is
   unverified here) and start a new session. The `--live` path is written
   but has never executed.

### 2. Office block (`gru/wip/office/`) — partial, unverified

The animated terminal office (CDR-006): Munder Difflin's event-to-avatar
idea, original ANSI art, driven only by ledger events. The builder agent
stopped after two files (`model.ts` reducer, `text.ts` helpers, 882
lines). **No renderer, no player, no tests, never typechecked.** Kept
outside `src/` so it cannot break the build. Next agent: move to
`gru/src/office/`, add `render.ts`, `player.ts` and `test/office-*.test.ts`
per the brief in CDR-006 and the rules below, wire `gru office --state
<dir> --episode <id> [--follow]`, add `office/*` to nothing in the
surface allowlist (it must stay I/O-free; ledger lines are injected).
Must handle the `refusal` event type (render as the gate holding, not an
alarm) and show verification outcome and strength separately.

## Decisions waiting on the Director

1. Whether to merge Escapement-Core#3, and whether to have an agent watch it.
2. UniMind's licence: its README says MIT but has no LICENSE file, and it
   belongs to a different GitHub account. Code stays quarantined
   (CDR-004) until ownership or a LICENSE is confirmed.
3. Whether to act on GRU/Core relationship doc §5 (close Core's build
   programme via an ADR; reissue EXPERIMENT_CORE_000 as GRU's AVL
   conformance experiment). Not started.
4. Slice 2 scope: DeepSeek Harness adapter (CDR-001), an isolation
   backend (the only fix for S7/P1/P2/P8), GRU/DRU/Nefario roles.

## Known gaps (from builder reports, not yet fixed)

- ~~`EscalationRequest` carries no write payload~~ Fixed: AVL builds a
  preview from the exact payload the digest binds (`avl/preview.ts`).
- Host mode: Claude Code hook payload shapes and Codex's `tool_timeout_sec`
  are from memory, tested only against payloads we wrote. Codex's
  built-in shell is not mediated at all.
- `ProviderCatalog` lacks `invalidateAuto`. ~~The loop does not retry
  retryable route errors~~ Fixed: bounded exponential retry (3 retries,
  1 s base, 16 s cap) of turns the route marks retryable.
- ~~A kernel error mid-loop leaves an episode unclosed~~ Fixed: the loop
  ends `KERNEL_ERROR`, the episode closes ABANDONED, the CLI exits 1.
- Reconciliation compares two snapshots: changes made and reverted, or
  outside the workspace, are invisible.

## Hard-won rules for the next session

- **The scratchpad directory is shared by every agent.** Keep scratch
  files in a uniquely named subfolder; never run a script you did not
  just write. (One agent ran another's mutation script against the wrong
  worktree.)
- **Verify every agent report yourself** before merging: typecheck and
  the block's tests in its worktree. Two reports were written during a
  permission-checker outage with nothing actually run.
- If the permission checker returns "no verdict" repeatedly, stop after
  a few tries; ten in a row ends the turn.
- **Never** paste credentials into chat or files; use environment
  settings.
- Tests of a spec can agree with a flawed spec. D6–D8 were found by
  reading a builder's report, not by any test.

## Resume

```bash
cd GRU-Research/gru && npm ci
npm run typecheck && npm test && npm run mutation
node src/cli.ts demo
npm run bench -- --quick
```
