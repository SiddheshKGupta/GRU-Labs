---
title: Self-Harness
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://arxiv.org/abs/2606.09498
---

# Self-Harness

An agent improves its own harness from its own failures.

```text
execution traces
     ↓
weakness mining
     ↓
minimal harness proposal
     ↓
regression validation      <- acceptance gate
     ↓
accept / reject
```

## FACT — verified 2026-08-11

```text
arXiv        2606.09498
benchmark    Terminal-Bench-2.0
```

| Model | Before | After |
|---|---|---|
| MiniMax M2.5 | 40.5% | **61.9%** |
| Qwen3.5-35B-A3B | 23.8% | **38.1%** |
| GLM-5 | 42.9% | **57.1%** |

Weakness mining is **per-model**.

## INFERENCE — two design commitments hide in that loop

**Minimal proposal.** The loop proposes the smallest harness change that
addresses a mined weakness, not a redesign. That keeps each change
attributable to the weakness it came from — the same reason GRU §29 wants
prospective evaluation of a single organizational change rather than a
batch.

**Regression validation before acceptance.** The gate runs before the
change lands, not after. GRU §29 states the matching rule from the other
side: *"the proposer cannot weaken the verification criteria that decide
whether its own proposal is promoted."* Self-Harness gets this property
structurally — the regression suite predates the proposal.

## INFERENCE — the size of the gains is the uncomfortable part

A 21-point swing on Terminal-Bench-2.0 from harness changes alone, on a
fixed model, is a large effect from a cheap intervention. Any GRU
mechanism claiming an improvement has to beat this arm, not a
fixed-harness baseline — otherwise it is measuring harness headroom and
calling it governance. That is the whole point of [[gru-strong-null]],
and the specific error [[continuum-negative-result]] recorded.

Per-model mining independently agrees with [[harnessbank]]: harness
quality is a property of the model-harness pair, not of the harness.

## Open question

[[foundation-selection]] scores chassis on GRU fit. Nothing in that
scorecard asks whether the chassis can be *mechanically modified by an
optimizer*, which is a precondition for running this loop at all.
