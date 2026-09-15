---
title: Shepherd
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2605.10913
---

# Shepherd

*"Shepherd: Enabling Programmable Meta-Agents via Reversible Agentic
Execution Traces"* — Simon Yu, Derek Chong, Ananjan Nandi, Dilara Soylu,
Jiuding Sun, Christopher D Manning, Weiyan Shi (Stanford).

## FACT — verified 2026-08-11

```text
arXiv       2605.10913
substrate   Python
core idea   agent execution as a first-class inspectable and
            transformable object
trace       reversible, Git-like; any past state revertible or forkable
speed       5x faster than docker commit
```

Three applications reported:

```text
1  preventing conflicts among parallel coding agents
2  repairing workflows via counterfactual optimization
3  improving credit assignment in agentic RL via
   strategic fork points
```

## INFERENCE — this is the missing substrate under GRU §29

GRU §29 wants to learn from verified delivery episodes: which team
topology, which routes, which objections predicted real failure. That
requires answering counterfactuals — *would this have gone better with a
different staffing decision* — and today the only way to ask is to rerun
the whole episode.

A forkable execution trace turns that from a rerun into a branch. Fork at
the staffing decision, change one variable, compare. The 5x-over-docker-commit
figure is what decides whether that is a research luxury or an affordable
default.

## INFERENCE — and the sharpest fit is DRU

GRU §9 gives DRU the job of producing *"the strongest plausible failure
case"* and *"the strongest alternative."* Against a reversible trace,
those stop being arguments and become executable branches: DRU forks at
the decision it objects to, runs the alternative, and the disposition is
decided by evidence rather than by debate. GRU §10's bounded debate keeps
its deadline; what changes is the quality of what each side brings to it.

Application 1 is also a direct answer to a GRU v0.1 problem: 3–5 Minions
working in one workspace is exactly the parallel-coding-agent conflict
case.

## Caution

The trace is a record of execution, and [[minion-mind]] is a record of
project cognition. They are not the same object and should not be merged
— one is replayable machinery, the other is a claim graph with
provenance. Coupling them would put an infrastructure dependency inside a
GRU-native layer that GRU §17.1 says must be built native.
