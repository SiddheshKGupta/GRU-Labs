---
title: CPEX
kind: system
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://docs.rs/cpex/latest/cpex/
  - CPEX 0.2.2 release metadata, published 2026-07-15 (Apache-2.0, Rust)
  - raw/internal/gru-freeze-v1.1.md
---

# CPEX

A deterministic **reference monitor** that sits between an agent and the
capabilities it reaches for.

```text
agent  ──▶  CPEX  ──▶  tools
                       prompts
                       resources
                       inference providers
                       A2A
```

## FACT — verified 2026-08-11

```text
language    Rust
licence     Apache-2.0
version     0.2.2
released    2026-07-15
docs        100% documented
maturity    PRE-1.0
```

Every operation runs a policy pipeline:

```text
identity resolution
authorization        delegated to Cedar / CEL
credential exchange and reduction
redaction
information-flow tracking
audit record
```

Policies are written in **APL** and enforced at operation boundaries
against state **the model cannot observe**. That last property is the
architecturally interesting one: the decision does not depend on anything
the model can talk itself past.

## INFERENCE — closest external analogue to the AVL seam

CPEX's pipeline is roughly the plumbing AVL needs beneath its own
semantics: GRU §20 already assigns Cedar the "candidate dependency" slot
for exactly this, with *"AVL consequence semantics remain GRU-native."*
CPEX bundles Cedar-or-CEL evaluation with credential reduction and
information-flow tracking, which GRU §14.3 and §14.2 both require.

It does **not** supply project-delivery obligations. It authorizes an
operation; it has no concept of whether a milestone's evidence
requirement is satisfied. See [[containment-is-not-authorization]].

## CAVEAT — the stability ordering is inverted

```text
GRU layer        expected lifetime        CPEX
constitutional   longest-lived            0.2.2, pre-1.0, small community
```

A constitutional layer is the part of the system that must change least.
Building it on a pre-1.0 dependency with a small community footprint
means the least-stable component underwrites the most-stable guarantee.

This is not an argument against CPEX as a *reference design*. It is an
argument against a hard dependency at this version, and it is the kind of
call GRU §18 requires a written component decision record for.

## Open question

Does CPEX's per-operation view compose safely with tool-layer and
OS-layer enforcement, or does it add a third place where the same
consequence can be reached by a different route? — [[composition-safety]]
