---
title: Minion Mind
kind: concept
status: UNTESTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - raw/internal/gru-freeze-v1.1.md
---

# Minion Mind

GRU's shared project cognition layer. GRU §17.1 puts it firmly in BUILD
NATIVE: *"Minion Mind is central to GRU coherence."*

## FACT — what the freeze specifies (GRU §13)

Contents:

```text
Project State      Claim Graph         Capability Graph
Task Graph         Decision Register   Minion State
Blackboard         Evidence            Event History
Knowledge + Provenance                 Verified Episodes
```

Two properties are stated explicitly.

**One shared view, not one shared opinion.** Disagreement is preserved,
not collapsed. A claim carries a status and both its supporting and its
contradicting evidence:

```text
SUPPORTED   CONTESTED   REJECTED   SUPERSEDED   UNVERIFIED
```

**Context projection.** No agent receives the whole project history:

```text
MINION MIND
     ↓
role + task + dependency + freshness + materiality + authority
     ↓
CONTEXT COMPOSER
     ↓
MINION OBSERVABLE STATE
```

Private working context stays local until a meaningful state transition,
claim, decision or evidence object is published.

## INFERENCE — this wiki is a manual prototype of it

The status vocabulary in `RESEARCH_SCHEMA.md` is Minion Mind's claim
vocabulary with one addition (`NEGATIVE_RESULT`) and one omission
(`REJECTED`, folded into negative results that are kept visible). That
correspondence was not designed; it fell out of needing the same thing.

If the wiki's vocabulary proves insufficient under real use, that is
cheap evidence about the claim model before any of it is built.

## Open questions

**Projection is a security boundary, not only a context-window
optimisation.** GRU §13.2 lists `authority` among the projection inputs,
which means the composer decides what a Minion may *know* as well as what
it needs. [[information-is-not-authority]] then applies internally: a
published claim is information, and must not be able to alter what
another Minion is permitted to do.

**Projection versus structure.** Projection fights long-context rot by
selecting less. [[lambda-rlm]] fights it by structuring the computation.
Neither subsumes the other and GRU currently plans only the first.

**Cognition is not execution.** [[shepherd]]'s reversible trace is a
record of what ran; Minion Mind is a record of what is believed and why.
Merging them would put an infrastructure dependency inside the layer GRU
§17.1 requires to be native.

**Nothing here has been tested.** `status: UNTESTED` is accurate: we
verified what the freeze says, and the freeze is a design. GRU §32.1
experiment 3 — does structured project cognition reduce duplicated or
stale context versus transcript sharing — has not been run.
