---
title: Information is not authority
kind: concept
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - raw/internal/gru-freeze-v1.1.md
  - MCP specification, revision 2026-07-28 (tool annotations are untrusted unless from a trusted server)
---

# Information is not authority

Untrusted information may influence reasoning. It cannot grant itself
permission.

## FACT — GRU states it twice, in two registers

GRU §14.2, as an AVL property:

> Untrusted information can influence reasoning. It cannot grant itself
> permission.

GRU §28, as a constitutional principle:

> A model may request authority. It does not grant itself authority.

§28 also gives the escalation ladder that follows from it:

```text
capability discovery  does not imply  installation
installation          does not imply  authorization
authorization         does not imply  verification
```

## FACT — the same rule appears independently in the MCP spec

The MCP specification revision **2026-07-28** warns clients that tool
annotations must be treated as **untrusted** unless they come from a
trusted server.

That is the identical rule at the narrowest possible boundary. A tool
annotation is a description written by whoever authored the server; if a
client lets that text decide what the tool is allowed to do, the text has
granted itself permission.

## INFERENCE — the boundary is text arriving, not text being believed

The rule is often misread as "do not trust tool output." It is stronger.
The model is *allowed* to read, believe and act on untrusted content —
that is what reasoning is for. What the content may never do is change
what the system will permit.

Mechanically this means the authority decision must be evaluated against
state the reasoning process cannot write to. [[cpex]] states exactly this
property: policies are enforced against state the model cannot observe.
[[parallax]]'s Cognitive-Executive Separation is the architectural form
of the same constraint.

```text
untrusted text  ->  reasoning        allowed
untrusted text  ->  authority state  never
```

## Where it will actually be tested in GRU

Every point where external text enters:

```text
MCP tool annotations and descriptions
fetched documents and web content
repository contents under review
capability catalogue entries       (GRU §16: a capability is not
                                    ready because it appears in a
                                    catalogue)
another Minion's published claim
```

The last one is the uncomfortable case. [[minion-mind]] publishes claims
between Minions; a claim is information. If a Minion's published claim can
alter another Minion's authority, the rule has been broken internally
rather than at the perimeter — and [[composition-safety]] says a single
bypassing route is enough to void the property everywhere.
