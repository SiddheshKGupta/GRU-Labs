---
title: Foundation selection
kind: question
status: UNTESTED
verified_by_us: partial
last_reviewed: 2026-08-11
sources:
  - raw/internal/gru-freeze-v1.1.md
  - https://github.com/deepseek-ai/deepseek-harness
---

# Foundation selection

GRU §22 defines a fourteen-dimension scorecard for choosing the execution
chassis. **It has not been applied to anything.**

## FACT — the fourteen dimensions (GRU §22)

```text
Runtime               does it execute the Minion workload classes?
Extensibility         extendable without invasive patches?
Events                can Minion Mind and AVL reconstruct activity?
Models                heterogeneous provider/model routes?
Tools                 tool calls observable, constrained, extensible?
Sessions              persistence, resume, fork semantics?
Workspace             project directories and sessions represented?
Isolation seam        can execution sit behind a sandbox/monitor?
Capability lifecycle  can Nefario add/remove capabilities safely?
Observability         material runtime events externally visible?
Performance           latency and resource overhead?
Maintainability       cost of keeping pace with upstream?
License               exact version compatible with distribution?
GRU fit               how much translation and glue?
```

## FACT — the current candidate is unscored

[[deepseek-harness]] is the freeze's *foundation hypothesis* and has
**not been scored against this scorecard.** What is verified is the
licence, the scale, the plugin architecture, the web client and the
explicit compatibility-breaking warning. What is not verified is most of
what the scorecard asks about.

Four cited references remain unopened beyond the repository front page.
GRU §37 names three subsystem documents alongside the repository root:

```text
docs/subsystems/workspace.md                    unopened
packages/client  (web client architecture)      unopened
provider-routed LLM adapter note                unopened
repository root beyond the front page           unread
```

Durable sessions, provider/model routing, terminals, workspaces and the
agent loop are all attributed to the chassis by the freeze and all
unconfirmed by us. Those map onto Sessions, Models, Workspace and Runtime
— four of the fourteen dimensions, answered by citation rather than by
reading.

## INFERENCE — a scorecard nobody has filled in is not a decision procedure

Its purpose per GRU §21.3 is to make foundation replacement an evidence
question. Unscored, it makes the *incumbent* unchallengeable: there is no
number to beat, so any alternative is compared against an impression.

Filling it in for the incumbent is cheap and has to happen first.

## Missing dimensions

Two things the scorecard does not ask, both surfaced by this round of
reading:

**Optimizability.** [[self-harness]] and [[harnessbank]] both improve a
harness mechanically. Neither is possible on a chassis that cannot be
modified by an optimizer, and no dimension asks whether it can.

**Determinizability.** GRU §30 and [[verified-determinization]] require
that a repeated procedure be extractable as a deterministic workflow with
an environment digest. Whether the chassis exposes enough structure to
support that is a foundation property, not an application one.

## Why `verified_by_us: partial`

The scorecard itself is verified against GRU §22. The claim that
DeepSeek Harness is unscored is verified by absence — we have not seen a
scoring, which is weaker evidence than seeing that none exists.
