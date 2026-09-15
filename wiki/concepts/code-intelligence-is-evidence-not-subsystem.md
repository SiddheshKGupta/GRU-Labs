---
title: Code intelligence is evidence, not a subsystem
kind: concept
status: PARTIALLY_SUPPORTED
verified_by_us: partial
last_reviewed: 2026-08-11
sources:
  - raw/internal/gru-freeze-v1.1.md
---

# Code intelligence is evidence, not a subsystem

Static analysis, AST auditing, type checking, language servers,
Tree-sitter, drift detection: these produce **evidence objects that feed
an obligation**. They are not part of the constitutional layer, and a
system that treats them as one has mislabelled a lint as a guarantee.

## FACT — the freeze already sorts them this way

```text
GRU §15.1   deterministic analyzers and code intelligence tools are
            CAPABILITIES that Nefario discovers, admits and maintains
GRU §17.2   language servers, Tree-sitter and compiler tooling are
            INTEGRATE  (commodity infrastructure, clean seam)
GRU §17.1   AVL consequence semantics are BUILD NATIVE
```

Nothing in §17.1 lists an analyser. The boundary is already drawn in the
document; this page names the reason it has to be.

## FACT — we established the reason the expensive way

[[escapement-typed-boundary-retraction]]: a Python type was claimed to
make bypass structurally impossible. It fails mypy, not Python. A lint
had been presented as a structural guarantee.

[[escapement-effect-surface-audit]]: a text search over two files was
treated as a structural claim about all fourteen. Widening the same class
of search found 47 matches in 7 files.

Both failures are the same category error — an analyser's output read as
a property of the system rather than as evidence about it. [[nooa]]'s
README states the limit for its own AST checks independently:
*"defense-in-depth guardrails, not a containment boundary."*

## INFERENCE — what follows

An analyser result is an input to an evidence obligation, so it inherits
every property evidence has:

```text
it has provenance            which tool, which version, which config
it has a scope               what it examined, and what it did not
it can be stale              GRU §30's digest problem
it can be wrong              and must be falsifiable, not assumed
it does not close anything   AVL closes; evidence supports closure
```

The scope line is the one that bit us twice. A clean analyser run is a
statement about the analyser's coverage, and coverage is the part nobody
reports.

## INFERENCE — the conclusion survives the language migration

[[deepseek-harness]] is TypeScript; Escapement v1 was Python. Its `ast`
effect auditing and drift checks do not port. That costs the
*implementation* and nothing else — the architectural position, that code
intelligence sits below AVL as a capability rather than inside it as a
subsystem, is language-independent and survives intact.

This is also why the migration is survivable at all. Had code
intelligence been built as a constitutional subsystem, losing the Python
implementation would have removed part of the constitution.

## Why `verified_by_us: partial`

The GRU-side sorting is verified against the freeze. The supporting
evidence is our own prior failures, recorded in our own findings —
self-authored source material, which [[verification-discipline]] says is
precisely the kind that should not be marked fully verified.
