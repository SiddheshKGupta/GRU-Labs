---
title: Microsoft Agent Governance Toolkit
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://github.com/microsoft/agent-governance-toolkit
  - raw/internal/gru-freeze-v1.1.md
---

# Microsoft AGT

The largest single overlap with AVL's plumbing that exists as shipped
code. GRU §20 already files it as *candidate integration / benchmark*.

## FACT — verified 2026-08-11

```text
licence      MIT
languages    Python, TypeScript, .NET, Rust, Go
conformance  992 tests
```

Surface:

```text
policy enforcement     YAML / OPA / Cedar
audit                  tamper-evident
identity               SPIFFE / DID / mTLS, zero-trust
privilege model        four rings
MCP security gateway   tool-poisoning detection
workflow               approvals, delegation control
artifact               Decision BOM
```

It states coverage of the OWASP Agentic Top 10, and alignment with NIST
AI RMF, the EU AI Act and SOC 2.

## INFERENCE — two things GRU should take, one it should not

Take:

- **Decision BOM.** A per-decision bill of materials is close to what GRU
  §18's component decision record and §19's licence gate need to emit
  anyway, and having a named external artifact format is cheaper than
  inventing one.
- **Tool-poisoning detection at an MCP gateway.** Directly serves
  [[information-is-not-authority]] at the one boundary where untrusted
  description text enters the system.

Do not take: the governance model as AVL. Four privilege rings describe
*who may do what*. AVL's question is *has this consequence met its
evidence and verification obligations yet* — a delivery-state question a
privilege ring cannot express. GRU §20's wording is the right constraint:
integrate only where it reduces AVL plumbing without replacing AVL
semantics.

## Why PARTIALLY_SUPPORTED

Everything above is verified as **what the project states about itself**.
We have not run the 992 conformance tests, and compliance alignment
claims (NIST, EU AI Act, SOC 2) are vendor self-assessments, not
third-party attestations. Those are exactly the claims [[verification-discipline]]
says must not be allowed to blend in with checked ones.

Five languages and 992 tests is also a maintenance surface. A dependency
that large is a coupling decision, not a convenience.
