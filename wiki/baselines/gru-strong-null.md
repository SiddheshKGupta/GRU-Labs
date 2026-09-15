---
title: GRU strong null
kind: baseline
status: UNTESTED
verified_by_us: partial
last_reviewed: 2026-09-15
sources:
  - raw/internal/gru-freeze-v1.1.md
---

# GRU strong null

The composite system GRU must beat. Not a strawman, not a frozen
historical baseline — every layer here is an existing component given its
obvious enhancements, assembled by someone competent and hostile to the
GRU thesis.

[[continuum-negative-result]] is why this page exists and why it is
written before any experiment is designed.

## The stack

```text
USER / AUTHORITY
        │
Escapement-style delivery semantics
  evidence-backed closure, explicit verification, truthful status
        │
UNIVERSAL HOST LAYER
  Rivet Sandbox Agent                              [UNVERIFIED]
        │
REPLACEABLE UNTRUSTED WORKER
  Claude Code  /  Codex  /  [[nooa]]
        │
REFERENCE MONITOR / PDP
  [[cpex]]  /  [[actplane]]  /  [[microsoft-agt]]  /  Cedar
        │
CONTAINMENT
  [[openshell]]  /  Sandlock [UNVERIFIED]  /  microVM
        │
      EFFECT
        │
SYSTEM OBSERVATION                    DETERMINISTIC VERIFIERS
  AgentSight [UNVERIFIED]               tests, type checks,
  OCSF  /  OpenTelemetry                analysers
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
             EPISODE PROJECTION
                       │
                      CI
                       │
               FINAL EPISODE
                       │
        HARNESS OPTIMIZATION COMPARATOR
          HarnessOpt  /  [[self-harness]]
```

## Not independently verified

```text
Rivet Sandbox Agent    role taken on trust; not fetched, not run
Sandlock               role taken on trust; not fetched, not run
AgentSight             role taken on trust; not fetched, not run
```

Three components of the baseline are themselves unchecked, which is why
this page is `verified_by_us: partial`. A baseline assembled from
unverified parts is still a real obligation — but the parts must be
labelled, not quietly load-bearing. Same rule as [[harnessbank]].

## The question every GRU mechanism must answer

**Given all of the above already exists and composes — what exactly
remains for GRU to implement?**

That question has to be answered per mechanism, in advance, with a
falsifiable difference. GRU §32.1 lists seven experiments; each needs its
own version of this answer:

```text
organization compilation   vs  a strong router with a good prompt
                               and a persisted plan
DRU                        vs  a second pass by the same worker with
                               an adversarial instruction
Minion Mind projection     vs  a well-curated context window plus
                               retrieval
AVL enforcement            vs  Cedar + OS enforcement + CI gates
Nefario readiness gating   vs  a health-checked tool catalogue
route selection            vs  a fixed strong model
Workbench                  vs  a terminal and an editor
```

## Two answers that look plausible now

**INFERENCE — the delivery-governance layer has no occupant.** Every
component above enforces containment or authorization. None of them knows
what a milestone is, what evidence a consequence owes, or what closure
means — [[containment-is-not-authorization]]. That gap is real, but it is
narrower than "GRU", and it is the only part of the stack nothing else
claims.

**INFERENCE — the seam is untested even in the null.** The stack above
is drawn as composing. Nobody has shown it does.
[[composition-safety]]'s eight-route test has not been run against any of
these layers, and GRU §32.2 requires exactly that. Demonstrating that the
strong null *fails* to preserve an invariant under composition would be a
stronger result for GRU than any component-level comparison.

## What this page is not

It is not an argument that GRU is redundant. It is the specification of
what a positive result would have to look like — and per
[[continuum-negative-result]] rule 3, it must be written while it can
still change the plan, not after an experiment has produced a number.
