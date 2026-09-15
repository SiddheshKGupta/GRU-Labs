---
title: TraceCompiler
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2608.02680
---

# TraceCompiler

Mines clusters of noisy agent traces and compiles them into executable,
mostly-deterministic workflows. The reference implementation of
[[verified-determinization]].

## FACT — the failure mode, stated first on purpose

```text
leave-one-out tests passed   15 of 21
cause                        required branches had not been observed
```

**Roughly 29% failure on unseen branches.** A compiled workflow is only
correct over the behaviour space its traces covered. Placing this after
the accuracy figures would misrepresent the system, because this is the
number that decides where determinization is safe to use.

## FACT — verified 2026-08-11

```text
arXiv   2608.02680
```

Dependency detection:

```text
precision / recall   0.928 / 0.943   across 15,775 edges
precision            0.993           on validation
```

Compression, Venmo intent:

```text
34 API calls  ->  11 runtime calls
```

## FACT — two refusal rules that make it trustworthy

**Dependency admission.** An inter-tool dependency is admitted **only**
when a consumer argument contains a value uniquely attributable to an
earlier producer. Anything weaker is marked `suspected` and **imposes no
ordering**. A suspected edge that constrained execution would be a guess
wearing a constraint's clothes.

**Under-determined side effects.** It refuses to compile when an
irreversible side effect is under-determined — demonstrated on a
Spotify/Todoist workflow.

## INFERENCE — the refusal is the transferable part

Both rules are the same discipline as `lint.py`'s split: decide what can
be decided mechanically, and *say so* rather than guess when it cannot.
A determinizer that resolved ambiguous dependencies by inference would
produce workflows that look deterministic and are not.

GRU §30's ACTIVE / STALE / SUPERSEDED lifecycle plus an
environment/version digest is the containing mechanism for the 15/21
result: a procedure that meets an unobserved branch must fall back to
agentic execution, not fail. Determinization is only safe when the
fallback exists.
