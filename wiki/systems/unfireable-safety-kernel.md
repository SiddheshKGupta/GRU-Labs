---
title: Unfireable Safety Kernel
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2606.26057
---

# Unfireable Safety Kernel

Positions itself as **execution-time AI alignment** — alignment as a
runtime property of where code sits, not as a training-time property of
the model.

## FACT — verified 2026-08-11

```text
arXiv   2606.26057
impl    Rust
```

Four required properties:

```text
1  process separation
2  pre-action enforcement on a structurally-only path
3  fail-closed at request level AND at system level
4  externalized signed evidence, verifiable OUTSIDE the
   controlled system's trust boundary
```

The implementation governs *"a deterministic, self-improving world
model"* against an adversary actively seeking escape:

```text
704 / 704   safety-critical attempts blocked
across      1,000 self-modifications
```

Verification method: an **SMT theorem (Z3)** plus **exhaustive bounded
model checking**.

## INFERENCE — property 4 is the one nobody else states

Properties 1–3 appear in some form across [[parallax]], [[cpex]] and
[[actplane]]. Property 4 does not: evidence must be signed and checkable
*outside* the trust boundary of the system it describes.

That is the structural version of the rule [[verification-discipline]]
derived from repeated failures — a system's own report about itself is
not evidence about itself. GRU §7 already encodes the human-facing half
("the Director may not convert a failed verification into a passing
result"); property 4 is the machine-facing half, and GRU currently has no
mechanism for it. AVL emits evidence *into* the system it governs.

## INFERENCE — we have already been wrong about "structurally-only"

[[escapement-typed-boundary-retraction]] is exactly a case where a path
believed structural turned out to be a lint. The word doing the work in
property 2 is *structurally*, and in Rust with process separation it
plausibly holds where in Python it demonstrably did not. The lesson is
that the property is real but language- and boundary-specific, and
cannot be restated as a design intention.

## Why PARTIALLY_SUPPORTED

704/704 is a single implementation against a single adversary
configuration, reported by its authors. The formal component (Z3 +
bounded model checking) is stronger evidence than the empirical
component, and bounded model checking is bounded — exhaustive within its
bound, silent outside it.
