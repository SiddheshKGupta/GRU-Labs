---
title: AgentRFC
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://arxiv.org/abs/2603.23801
---

# AgentRFC

*"AgentRFC: Security Design Principles and Conformance Testing for Agent
Protocols"* — Shenghan Zheng, Qifan Zhang.

## FACT — verified 2026-08-11

```text
arXiv      2603.23801
covers     MCP, A2A, ANP, ACP
tooling    AgentConform, two-phase conformance checker
method     TLA+ model checking
```

Gap classes identified across the four protocols:

```text
credential lifecycle
consent enforcement
audit completeness
composition safety
```

## FACT — the principle worth taking

Composition Safety, stated by the authors:

> security properties that hold for individual protocols can break when
> protocols are composed through shared infrastructure.

The paper builds formal models of **five composition patterns**, which it
says reveal

> cross-protocol design gaps that individual protocol analysis cannot
> detect.

## INFERENCE — the method, not only the result

Formal models of composition patterns and TLA+ model checking are a
different evidence class from "we tested each protocol and found bugs."
A bug list ages. A model of a composition pattern stays applicable to any
new protocol dropped into the same pattern — which is the situation GRU
is in, given that Minions reach capabilities through MCP, A2A and direct
SDK routes simultaneously.

GRU §32.2 already mandates seam testing rather than component testing.
AgentRFC is the closest external instance of that discipline being
carried out formally, and its five patterns are a candidate starting set
for GRU's own seam matrix.

## Why PARTIALLY_SUPPORTED rather than SUPPORTED

Some findings are under **coordinated disclosure**. We can read the
principle and the method; we cannot inspect the specific withheld
findings or judge their severity. A paper whose evidence is partly
sealed is partly unverifiable by construction, and should be recorded
that way rather than rounded up.

See [[composition-safety]] for the practical test derived from this.
