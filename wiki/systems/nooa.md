---
title: NOOA (NVIDIA Object-Oriented Agents)
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://github.com/NVIDIA-NeMo/labs-OO-Agents
  - https://arxiv.org/abs/2607.20709
  - https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/
---

# NOOA

An agent is a Python object: methods are actions, fields are state,
docstrings are prompts, type annotations are contracts. Methods whose body
is `...` are completed at runtime by an LLM loop; ordinary methods stay
deterministic Python.

## FACT — verified 2026-08-11

```text
licence   Apache-2.0
stars     1.5k   (early)
paper     arXiv:2607.20709, submitted 2026-07-22
```

| Benchmark | Result |
|---|---|
| SWE-bench Verified | **82.2%** with GPT-5.5, from a 253-line general-purpose agent with no benchmark-specific prompts (prior SOTA 79.2%) |
| SWE-bench Verified | 79.8% with Opus 4.6 |
| CyberGym L1 | 86.8% with GPT-5.5, top-scoring open-source agent |
| ARC-AGI-3 | 50.2% RHAE (GPT-5.5); 85.1% (GPT-5.6-sol) |

## FACT — the token result matters more than the accuracy result

```text
NOOA         82.2%  at ~1.1M tokens per task
comparison   78.2%  at  2.2M tokens, 66 calls
```

Better outcome at half the cost. Mechanism: *"tool results become live
Python variables composed directly in code, instead of round-tripping
through the context window as text."*

For any system whose learning loop is priced per episode, cost-per-episode
is a first-class constraint rather than a footnote.

## FACT — NVIDIA states the containment limit themselves

The README says AST checks and module deny-lists are:

> defense-in-depth guardrails, not a containment boundary

and:

> The containment boundary is OS-level isolation — always run agents that
> execute generated code inside a sandbox such as a container, VM, or
> NVIDIA OpenShell.

Independent corroboration of [[containment-is-not-authorization]], from a
party with no knowledge of this project. See also
[[escapement-typed-boundary-retraction]], where the same conclusion was
reached the expensive way.

## INFERENCE — pass-by-reference survives a trust boundary

The natural objection is that isolating NOOA behind a serialised protocol
destroys its main advantage. It does not. Pass-by-reference operates
*inside the worker's own process*, keeping large objects out of the
**model's context window**. What crosses a trust boundary is a small
serialised proposal. Different channels — the token win is preserved.

## Risk worth naming

Adopting NOOA couples a system to NVIDIA's roadmap, to Python, and to a
framework three weeks old at paper submission. The mitigation is that the
worker stays untrusted and replaceable — but that only holds **if the
protocol is ours, not NOOA's types.**
