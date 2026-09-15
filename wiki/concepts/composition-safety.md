---
title: Composition safety
kind: concept
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://arxiv.org/abs/2603.23801
  - raw/internal/gru-freeze-v1.1.md
---

# Composition safety

Individually safe components can compose unsafely.

[[agentrfc]] states it formally:

> security properties that hold for individual protocols can break when
> protocols are composed through shared infrastructure

and builds formal models of five composition patterns that reveal
*"cross-protocol design gaps that individual protocol analysis cannot
detect."*

GRU §4 principle 12 says the same thing in one line — *composition must
be tested* — and GRU §32.2 makes seam testing mandatory for every
integrated component.

## The practical test

Take one material consequence. *Push to a remote git repository.* Now
enumerate the routes that reach it:

```text
1  git push
2  bash -c "git push"
3  subprocess.run(["git", "push"])
4  a libgit API call
5  an MCP GitHub tool
6  a raw GitHub HTTPS API call
7  a child agent
8  a generated script
```

All eight must resolve to the **same consequence class** and therefore
the **same authority obligation**. If one route bypasses, the composition
has failed — not partially, entirely. An obligation that seven of eight
routes honour is an obligation the system does not have.

This is GRU §14.1 consequence semantics executed as a test rather than
asserted as a design, and it is already GRU §32.1 experiment 4: *can the
same material consequence reached through different technical routes
receive equivalent authority and evidence treatment?*

## INFERENCE — the test also locates the enforcement layer

Run the enumeration against each candidate layer and the answer falls
out:

```text
tool layer   catches 5.        Misses 1-4, 6-8.
OS layer     catches 1-4, 6, and whatever 7-8 actually execute.
```

Which is [[actplane]]'s thesis restated: *policy context lives within the
agent closest to the task, while enforcement must happen at the OS to
cover all execution paths.* The enumeration is not an argument for OS
enforcement because OS enforcement is fashionable; it is an argument
because routes 1–4 and 6–8 are not visible anywhere else.

Route 7 is the one no single layer closes. A child agent is a new
instance of the whole problem, and whether its obligations are inherited
is a design decision GRU has not yet made.

## Why this is not satisfied by "we use Cedar"

A policy engine evaluates the requests it is shown. Composition safety is
about the requests it is **not** shown. Adding [[cpex]] or
[[microsoft-agt]] adds a place where a decision can be made correctly; it
does not establish that every route arrives there. Those are different
claims, and only the second one is the property — see
[[containment-is-not-authorization]].
