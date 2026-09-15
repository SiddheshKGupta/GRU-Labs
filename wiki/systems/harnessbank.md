---
title: HarnessBank
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2607.13683
---

# HarnessBank

**This page exists as much to record a citation failure as to describe a
paper.** Read the misattribution section before using anything here.

## FACT — what the paper actually is, verified 2026-08-11

```text
arXiv     2607.13683
title     HarnessBank: Semantic Gene-Bank Search with Gated
          Verification for Agent-Harness Self-Evolution
authors   Luo, Xue, Wang, Hu, Deng
```

Mechanism:

```text
task agent  +  separate evolver agent
Harness Gene Bank            store of harness variants
Gated Harness Screening      admission gate on proposals
```

Reported result:

```text
5.1% - 15.4%  across seven agent benchmarks
```

Key finding, and the part worth keeping: improvements come from a
**model-specific** self-evolving process, **not** from a universally
optimal harness.

## FACT — the misattribution

It was cited to us as:

```text
cited title   "Gated Semantic Quality-Diversity"
cited figure  "+9 to +15.5 percentage points across seven domains"
cited claim   deterministic code owns sampling / measurement /
              significance testing / sealed evaluation
```

Against the primary source:

```text
title    wrong
figure   wrong  (abstract reports 5.1%-15.4% across seven
                 agent benchmarks, not +9 to +15.5 points
                 across seven domains)
claim    not present in the abstract at all
```

Percentage points and percentages are not the same unit, "domains" and
"agent benchmarks" are not the same population, and the third item —
the deterministic-crediting split — was the reason the citation was being
used.

This was **the single most load-bearing citation in its round, and the
only one in that round that was wrong.** Every other source checked out.
See [[verification-discipline]]; this incident is why `verified_by_us`
exists as a field at all.

## INFERENCE — the surviving claim is the more useful one

The model-specific finding, taken seriously, says a harness optimized
against one model does not transfer. That makes "which harness is best"
the wrong question and "best harness *for this route*" the right one —
which is GRU §23's route model, arrived at independently.

It also sets the comparator for any GRU learning loop: the baseline is
not a fixed harness, it is a **self-evolving** one. [[self-harness]]
reports the same shape of result from a different direction, and
[[gru-strong-null]] treats both as the harness-optimization arm that GRU
must beat rather than ignore.

## Why PARTIALLY_SUPPORTED

We verified the title, authorship, mechanism and reported range against
the abstract. We have not read the full paper, inspected the benchmark
set, or checked whether the seven benchmarks overlap.
