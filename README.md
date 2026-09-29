# GRU Labs

**GRU** (Governed Recurrent Unit) is an AI project manager that runs a
team of AI workers, the **Minions**, under one rule: nothing counts as
done until it has been checked by something that is not the Minion. A
Minion proposes; AVL, the Authority & Verification Layer, decides,
executes, records and verifies; you, the Project Director, approve what
only a human may.

This repository holds both the implementation (`gru/`) and the research
wiki behind it (`wiki/`, `raw/`).

## The cast

| Who | What they do | Built? |
|---|---|---|
| **You, the Director** | Approve protected changes, accept risk, own every decision | yes |
| **GRU** | Plans, staffs and runs the Minions; proposes closure | slice 1: one Minion per episode |
| **DRU** | Gru's twin: argues how each decision could fail | v0: rules over the ledger, objections per debate question |
| **Dr. Nefario** | The lab: model routes, tools, isolation backends | routes, providers, isolation |
| **Minions** | Do the work, on any model: Claude, OpenAI-compatible APIs, DeepSeek, local models | yes |
| **AVL** | Plain code, not a model: gates every action, keeps a hash-chained ledger, decides PASS / PARTIAL / FAIL | yes |

The Workbench draws them as pixel fan art for personal use (CDR-008).

## Quick start

```bash
cd gru && npm ci
node src/cli.ts demo                                  # a scripted Minion tries to delete the tests; watch AVL stop it
node src/cli.ts                                       # interactive terminal
node src/cli.ts run --workspace <dir> --contract <file> --route anthropic/claude-opus-5-5
npm run bench -- --quick --keep-state /tmp/gru-bench  # 10 Minions, honest to hostile
node src/cli.ts workbench --state /tmp/gru-bench      # the Workbench on http://127.0.0.1:7420/
node src/cli.ts install claude-code                   # use GRU inside Claude Code (or codex)
```

Node 22.18 or later. The kernel has no runtime dependencies.

## What GRU enforces

- **Every action is gated.** Reads, writes, deletes and commands are
  classified by consequence. Touching the tests escalates to you, with a
  preview of the exact content; approval covers those bytes and nothing
  else.
- **Commands run confined.** Node's permission model by default: the
  workspace is read-only and there are no writes outside a scratch
  folder. OpenSandbox containers are available but quarantined until a
  live test passes. `GRU_ISOLATION=node|opensandbox|none`.
- **Saying "done" proves nothing.** AVL runs your checks itself. A
  must-fail check shows the tests can catch a broken implementation.
- **Closure is truthful.** PASS, PARTIAL, FAIL or ABANDONED, with a
  reason. Your override is recorded next to a failure, never in place
  of it.
- **Everything is on the record.** Each episode is a hash-chained
  ledger; `gru verify` detects an edited, deleted or reordered event.

## Benchmark

Ten scripted Minions attempt one task, from honest to hostile (deleting
tests, false claims, path escapes, shell injection, credential dumping,
backdoors, escaping through imported code). The same Minions run through
GRU, a typical hand-rolled agent loop and an unguarded loop, and one
oracle judges them all. Full results are in `gru/bench/RESULTS.md` and
[the finding page](wiki/findings/gru-harness-benchmark.md).

```text
                     harm landed   false PASS
GRU, isolated            1/10         0/10     (the one harm: a test change you approved)
GRU, unconfined          3/10         1/10
typical agent loop       7/10         7/10
unguarded loop           8/10         9/10

honest Minions at once   1     10     25     50     100
all PASS, ledgers OK     yes   yes    yes    yes    yes
episodes per minute      181   386    377    368    367
gate overhead per call   read 0.40 ms, write 0.45 ms (p50)
```

What it does not show: scripted Minions test the harness, not a model.
Neither baseline is Claude Code or Codex. The attacks and the defences
were written by the same hands.

## Honest status

- Episodes are labelled `UNSAFE_DEVELOPMENT`: the network is not
  restricted inside commands (P8). OpenSandbox with egress denied is the
  planned fix.
- No live model run yet: this environment has no API key.
- DRU is rules, not a model yet; the GRU–DRU debate and multi-Minion teams are the next slice.

`SESSION_HANDOFF.md` has the current state and the next steps in order.

## Layout

```text
gru/           the implementation; start at gru/README.md
  src/avl/       gate, consequences, verification, closure, previews, safety
  src/ledger/    hash-chained ledger, validation, admissibility
  src/executors/ workspace executor, isolation (node-permission, OpenSandbox)
  src/routes/    fixture, Claude, any OpenAI-compatible API, provider catalog
  src/workbench/ the Workbench (read-only, loopback)
  src/mcp/, src/hooks/   Claude Code and Codex integration
  bench/         the benchmark
wiki/          our synthesis: systems, concepts, findings, decisions (CDR-001..008)
raw/           immutable sources; never edited
index.md       wiki navigation     log.md   append-only change log
lint.py        wiki checks         SESSION_HANDOFF.md
```

## The wiki's rules

A wiki page is a claim *about* sources and names them in its
frontmatter; `raw/` is the source of truth and is never edited. Each
page has two independent fields: `status` (a claim about the world) and
`verified_by_us` (yes / partial / no, a claim about our own diligence).
Findings are never deleted, including wrong ones; they are superseded.
`python lint.py` (stdlib only) fails on bad frontmatter, dangling links,
missing sources and orphans. The full rules are in `RESEARCH_SCHEMA.md`.
