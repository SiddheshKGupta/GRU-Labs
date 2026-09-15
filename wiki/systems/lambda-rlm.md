---
title: lambda-RLM
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2603.20105
---

# lambda-RLM

Actual title: *"The Y-Combinator for LLMs: Solving Long-Context Rot with
λ-Calculus"* — Roy, Tutunov, Ji, Zimmer, Bou-Ammar.

## FACT — verified 2026-08-11

```text
arXiv       2603.20105
licence     open source
mechanism   replaces free-form recursive code generation with a
            typed functional runtime grounded in λ-calculus
```

Formal guarantees:

```text
termination
cost bounds
```

Results:

```text
accuracy    +21.9 points maximum, across model tiers
latency     reduced up to 4.1x
```

## INFERENCE — the interesting word is "typed", not "λ"

The move is to stop asking a model to emit arbitrary recursive code and
instead have it emit terms in a runtime whose structure is known in
advance. Termination and cost bounds then come from the runtime, not from
trusting the generated program.

That is the same shape as [[tracecompiler]]'s refusal rules and
[[cpex]]'s enforcement against state the model cannot observe: a
guarantee is worth having only when it holds independently of what the
model produced.

## INFERENCE — relevance to Minion Mind

Long-context rot is the failure [[minion-mind]]'s context projection
exists to avoid, and GRU §13.2 currently addresses it by *selecting less*
— role, task, dependency, freshness, materiality and authority decide
what a Minion sees. lambda-RLM addresses it by *structuring the
computation* so long context is not accumulated in the first place.

These are complementary, not competing, and they answer different
failure cases. Projection cannot help a single Minion on a genuinely long
task; a typed runtime cannot decide what another Minion should be told.

## Not yet examined

The cost-bound guarantee is the claim with the most direct bearing on GRU
§12's per-Minion budget, and we have read it only as stated in the
abstract, not as proven in the paper.
