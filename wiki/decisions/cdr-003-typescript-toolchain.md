---
title: CDR-003 — TypeScript run by Node type stripping; zero runtime dependencies in the kernel
kind: decision
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-29
sources:
  - raw/internal/gru-freeze-v1.1.md
  - https://nodejs.org/api/typescript.html
  - https://www.npmjs.com/package/typescript
---

# CDR-003 — TypeScript toolchain

**DECISION** (2026-09-29): GRU source is TypeScript executed directly by
Node's built-in type stripping (Node >= 22.18). No build step, no
bundler, no test framework beyond `node:test`. Type checking is a
development-only step.

## Problem

The freeze fixes TypeScript on a Node chassis (§21). Escapement v1's
standard-library-only discipline made its supply chain auditable in an
afternoon; the kernel should keep that property in a new language.

## Candidates

```text
A  Node type stripping + node:test + tsc --noEmit          <- chosen
B  tsx / ts-node runtime loader
C  compile to JS with tsc or a bundler
```

B adds a runtime dependency; C adds a build artefact that can drift from
source. A needs only `erasableSyntaxOnly` code — no enums, namespaces or
parameter properties — which the kernel does not want anyway.

## FACT — what is installed (2026-09-29)

```text
typescript     7.0.2     Apache-2.0   dev only, type checking
@types/node    22.20.4   MIT          dev only
undici-types   6.21.0    MIT          dev only, via @types/node
node           22.22.2   process.features.typescript = "strip"
```

## Consequences

The kernel's runtime dependency count is zero; the only runtime
dependency in the package is the model SDK ([[gru-strong-null]] lists
what a stronger stack would add). Imports carry explicit `.ts`
extensions. Nothing runs on Node older than 22.18.

## Recommendation

`INTEGRATE` for `typescript` and `@types/node` as development tools;
`BUILD NATIVE` for everything else in the kernel.
