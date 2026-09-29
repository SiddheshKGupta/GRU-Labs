---
title: CDR-002 — Anthropic TypeScript SDK as the first live model route
kind: decision
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-29
sources:
  - raw/internal/gru-freeze-v1.1.md
  - https://www.npmjs.com/package/@anthropic-ai/sdk
  - https://github.com/anthropics/anthropic-sdk-typescript
---

# CDR-002 — Anthropic TypeScript SDK as the first live model route

**DECISION** (Director, 2026-09-29): the first live route is Claude
through `@anthropic-ai/sdk`, isolated in `gru/src/routes/anthropic.ts`.
Every test uses a deterministic fixture route instead.

## Problem

Slice 1 needs one real model behind its route interface (§23) so the
governed loop can be exercised on live output, not only on fixtures.

## GRU requirement

A route is an object, not a hardcoded model name (§23, §35). The kernel
must run and be tested with no credentials and no network — the
Continuum lesson that a conformance run must not be able to call out.

## Candidates

```text
A  @anthropic-ai/sdk, manual tool loop                    <- chosen
B  raw HTTPS to the Messages API
C  an OpenAI-compatible endpoint covering several providers
```

B re-implements retries, typed errors and types the SDK already has. C
loses Claude-native tool use and the refusal/fallback surface. A
multi-provider route remains open for Nefario's route fabric (§23.1).

## FACT — licence and supply chain (installed tree, 2026-09-29)

```text
@anthropic-ai/sdk     0.129.0   MIT
  json-schema-to-ts   3.1.1     MIT
  @babel/runtime      7.29.7    MIT
  ts-algebra          2.0.0     MIT
  standardwebhooks    1.1.1     MIT
  @stablelib/base64   1.0.1     MIT
  fast-sha256         1.3.0     Unlicense
```

All admissible under §19.1. Pinned exactly in `gru/package.json`, locked
in `package-lock.json`.

## Architecture coupling

One file imports the SDK, loaded lazily, and a test fails the build if
any other source file imports it. The route returns provider-neutral
turns; the provider's own message history stays inside the route and is
append-only.

## Security surface

```text
credential   resolved by the SDK from the operator's environment; never
             placed in model context; stripped from the environment of
             every command the Minion can run
refusals     stop_reason "refusal" ends the loop; that turn's tool calls
             never execute
fallbacks    server-side "default" fallback enabled; the served model is
             recorded per turn because learning is per model
truncation   a tool call cut off by max_tokens is never executed
```

## Configuration

`claude-opus-5-5` at effort `high` with adaptive thinking; tools sent
with `strict: true` and `tool_choice` left at `auto` (forced tool choice
is rejected on this model).

## Recommendation

`INTEGRATE`.

## Reason

Commodity infrastructure with a clean seam and permissive licensing,
saving real engineering (§17.2), and replaceable behind the route
interface.
