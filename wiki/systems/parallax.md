---
title: Parallax
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://arxiv.org/abs/2604.12986
---

# Parallax

*"Parallax: Why AI Agents That Think Must Never Act"* — Joel Fokou, April
2026. Reference implementation: OpenParallax.

## FACT — verified 2026-08-11

```text
arXiv   2604.12986
```

Four principles:

```text
Cognitive-Executive Separation
Adversarial Validation with Graduated Determinism
Information Flow Control
Reversible Execution
```

## FACT — the evaluation method is the contribution

**Assume-Compromise Evaluation** does not try to prevent the reasoning
component from being compromised. It *deliberately compromises it* and
then measures what still gets through.

```text
attacks blocked   98.9%
false positives   zero
cases             280 adversarial
```

## Arithmetic check — resolved, not confirmed

98.9% of 280 is 276.92, which is not an integer, so the two figures cannot
both be raw as stated. They reconcile at **277 of 280 blocked**:

```text
276/280 = 98.57%  -> rounds to 98.6%
277/280 = 98.93%  -> rounds to 98.9%   <- consistent
```

So the pair is internally coherent. The raw blocked-count is an
INFERENCE, not something we read in the paper — we have not opened the
evaluation table. Recorded because an unexplained discrepancy in a
headline number is how a figure gets repeated into authority.

## INFERENCE — the evaluation matters more than the number

A defence evaluated against attacks it was designed to anticipate
measures the designer's imagination. A defence evaluated with its
reasoning component assumed hostile measures the *structure*: whatever
survives that is a property of where the boundary sits, not of how well
the prompt was written.

This is the same move [[verification-discipline]] arrives at from the
opposite direction — separate the author from the verifier — and the same
move [[unfireable-safety-kernel]] makes by putting an escape-seeking
adversary on the controlled side of the boundary.

For GRU, the principle lands on the Minion/AVL seam. Minion Mind and the
Minion are *reasoning*; AVL is *executive*. Parallax's claim is that this
separation is the only part that survives a compromised reasoner, which
is a much stronger justification for AVL's existence than "governance is
good practice."

## Why PARTIALLY_SUPPORTED

98.9% with zero false positives across 280 cases is self-reported on an
author-designed protocol with an author-chosen case set. We verified the
paper states it. Nobody has replicated it, and "zero false positives" is
the figure most sensitive to how the case set was constructed.
