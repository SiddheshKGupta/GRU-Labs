---
title: Verified determinization
kind: concept
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://arxiv.org/abs/2608.02680
  - raw/internal/gru-freeze-v1.1.md
---

# Verified determinization

Use intelligence where judgment is required. Convert a procedure to
deterministic machinery once evidence shows judgment is no longer
necessary. (GRU §30.)

```text
repeated + stable + independently verified agentic procedure
        ↓
deterministic workflow or tool
        ↓
lifecycle:  ACTIVE  ->  STALE  ->  SUPERSEDED
        +   environment / version digest
```

[[tracecompiler]] is the external implementation: cluster noisy traces,
compile them into mostly-deterministic workflows, and refuse to compile
where the evidence does not support it.

## FACT — the cost, stated honestly

Determinization trades **adaptability** for **auditability**.
TraceCompiler's own leave-one-out result prices the trade:

```text
15 of 21 passed
failures caused by required branches never observed
~29% failure on unseen branches
```

A compiled procedure is correct over the behaviour space its traces
covered, and silent about everything outside it. That is not a defect in
TraceCompiler; it is what determinization *is*.

## INFERENCE — the digest makes staleness mechanically detectable

The neat consequence of GRU §30's environment/version digest: a
determinized procedure whose environment has moved is exactly `STALE`,
and that is decidable by comparing digests — no judgement, no model, no
review.

```text
digest matches     ACTIVE      run the deterministic path
digest differs     STALE       fall back to agentic execution,
                               collect evidence, re-evaluate
```

This is the same mechanical/judgemental split `lint.py` is built on, and
the reason the lifecycle is worth more than the compilation step. The
fallback is what makes the 29% survivable: an unobserved branch produces
a fallback, not a wrong answer — **provided** the procedure can detect
that it is outside its covered space, which digest comparison alone does
not establish.

## Open question — the gap between the two failure modes

```text
environment moved        detectable by digest
branch never observed    NOT detectable by digest
```

The second is the one that bit TraceCompiler, and GRU §30 as written
addresses only the first. A determinized GRU procedure needs a coverage
predicate as well as a digest, and nothing in the freeze supplies one.

## Why this belongs to GRU rather than to a tool

GRU §29 asks *"which repeated judgment-heavy procedures can be safely
determinized?"* as a learning question. The answer must come from
verified episodes, which means it depends on the verification being
independent — [[verification-discipline]]. A procedure determinized on
the strength of its author's own assessment that it was stable is a
frozen mistake with a digest attached.
