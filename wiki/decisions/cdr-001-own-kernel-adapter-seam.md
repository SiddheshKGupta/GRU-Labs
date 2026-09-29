---
title: CDR-001 — Own kernel, DeepSeek Harness behind an adapter seam
kind: decision
status: PARTIALLY_SUPPORTED
verified_by_us: partial
last_reviewed: 2026-09-29
sources:
  - raw/internal/gru-freeze-v1.1.md
  - https://github.com/deepseek-ai/deepseek-harness
---

# CDR-001 — Own kernel, DeepSeek Harness behind an adapter seam

**DECISION** (Director, 2026-09-29): GRU slice 1 builds its AVL, episode
ledger and one Minion loop as a dependency-free TypeScript kernel with
its own small agent loop. [[deepseek-harness]] attaches in slice 2
through an adapter, and is held to the same conformance suite.

## Problem

GRU needs an agent loop whose every tool call passes through AVL (§14,
§32.1 item 4). The freeze names DeepSeek Harness as the chassis (§21),
but GRU semantics must not couple to its internals (§21.1).

## GRU requirement

Mediation of every model-proposed effect, typed reconstruction of each
one, and a test that can tell when mediation is bypassed — Core's S1,
S2, S7 and S8.

## Candidates

```text
A  GRU as DSH plugins from day one
B  own kernel + own loop now; DSH adapter in slice 2      <- chosen
C  Python, reusing Escapement v1
```

## FACT — what DSH provides today (checked 2026-09-29, shallow clone)

```text
version        0.2.0-rc.1, MIT, pnpm monorepo, node ^22.19 || >=24
packages       ~60, including hooks/, sandbox/, sdk/, credentials/,
               guard/, subagent/, session/, mcp/
hooks          runs Claude-Code/Codex-style command hooks; can block
               tool calls with a model-visible message
sandbox        read-only / workspace-write / danger-full-access,
               same-machine confinement, one-time user escalation
sdk            newline-delimited JSON-RPC to drive a runtime from
               another process
```

Read from package READMEs only; nothing was built or run. The freeze's
claims about durable sessions and routing remain unconfirmed, as
[[foundation-selection]] records.

## Licence / asset terms

MIT at the inspected head. No DSH code is imported in slice 1, so no
obligation arises yet. Re-verify against the pinned version when the
adapter lands (§19).

## Integration cost, coupling, maintenance

```text
A  every test needs the full monorepo; GRU objects become DSH plugin
   shapes; upstream states compatibility-breaking changes will happen
B  small kernel testable offline; the adapter is the only coupling
   point; the loop is duplicated until slice 2 retires or keeps it
C  keeps 296 files of Python the freeze does not want (§2, §35)
```

## Security surface

B keeps the whole mediation path in code this project owns and can
test, which is the point of slice 1. DSH's hooks are the natural slice-2
seam: a PreToolUse-style hook that calls AVL, plus its `workspace-write`
sandbox as the first candidate isolation backend.

## INFERENCE — what B does not settle

Whether DSH's hook seam can make AVL *mandatory* rather than advisory is
exactly what the slice-2 conformance run must answer. A hook the worker
can edit is Core's P2 failure again.

## Recommendation

`OPTIONAL ADAPTER` for DeepSeek Harness; `BUILD NATIVE` for AVL, the
ledger and the Minion loop (§17.1).

## Reason

GRU's constitutional layer is the part no dependency supplies, and the
one question Core never ran. Proving it offline first keeps the chassis
replaceable (§21.3) and gives the adapter a fixed target.
