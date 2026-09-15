---
title: ActPlane
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2606.25189
  - https://github.com/eunomia-bpf/ActPlane
---

# ActPlane

*"ActPlane: Programmable OS-Level Policy Enforcement for Agent
Harnesses"* — Zheng, Wu, Fu, Yu, Mao, Ma, Williams, Wang, Quinn.

## FACT — verified 2026-08-11

```text
arXiv       2606.25189
licence     CC BY 4.0
code        github.com/eunomia-bpf/ActPlane
mechanism   eBPF / BPF-LSM
overhead    1.9% - 8.4%
platform    Linux only
```

Policies are expressed in an **IFC DSL** capable of spanning events,
rather than one decision per isolated call.

## FACT — the thesis, in the authors' words

> Tool-call guardrails miss system actions that bypass the tool layer.

and:

> policy context lives within the agent closest to the task, while
> enforcement must happen at the OS to cover all execution paths.

## INFERENCE — why this paper is load-bearing here

The first quote is the general form of a failure we hit ourselves. In
[[escapement-effect-surface-audit]], a "no model-to-effect path" claim was
evidenced by grepping for three tool-layer primitives; the actual effect
surface included a `shell=True` site the grep pattern never named. The
paper states as a design premise what that audit discovered by being
wrong: enforcement placed at the tool layer is enforcement placed where
the enumeration has to be complete, and the enumeration is never complete.

Placing enforcement at the OS inverts the burden — a policy covers *all
execution paths* rather than all the paths someone remembered to list.

The 1.9%–8.4% overhead figure matters because it decides whether this can
be on by default. A default-on enforcement layer that nobody turns off
for a benchmark run is worth more than a faster one that gets disabled.

## Relation to the rest of the stack

```text
ActPlane       enforcement at OS event level
OpenShell      containment at kernel policy level
CPEX           authorization at operation level
AVL            delivery obligation at project level
```

These are four different questions, not four implementations of one —
[[containment-is-not-authorization]].

## Constraint

eBPF/BPF-LSM is Linux. Same gate as [[openshell]]:
[[linux-only-enforcement-stack]].
