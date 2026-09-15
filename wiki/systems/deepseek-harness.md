---
title: DeepSeek Harness
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://github.com/deepseek-ai/deepseek-harness
---

# DeepSeek Harness

GRU's current **foundation hypothesis** — the execution chassis GRU builds
on. Explicitly not a constitutional dependency.

## FACT — verified 2026-08-11

```text
licence      MIT (third-party deps listed separately)
stars        224.9k
commits      17,177
language     TypeScript / Node (pnpm, tsconfig)
maturity     DEVELOPER PREVIEW
web UI       http://127.0.0.1:3080
run          npx @deepseek-ai/dsh web
```

Architecture is "everything-is-a-plugin", powered by **Cordis**, described
as a system for spatiotemporal composability.

## FACT — the maturity warning is explicit

The repository states plainly:

> THERE WILL BE COMPATIBILITY-BREAKING CHANGES.

The GRU freeze already accounts for this — *"Developer preview means
isolate GRU semantics from upstream internals."* That isolation is not
hygiene, it is the mitigation for a stated risk.

## FACT — capabilities we could NOT confirm from the repository front page

The freeze attributes a specific capability list to this chassis.

```text
verified present     plugin system, web client
NOT yet confirmed    durable sessions, provider/model routing,
                     terminals, workspaces, agent loop details
```

They may well exist — the freeze cites subsystem docs directly
(`docs/subsystems/workspace.md`, `packages/client`, a provider-routed LLM
adapter note). **We have not opened them.** GRU §22's foundation scorecard
asks exactly these questions, so they must be answered before it is scored.

## INFERENCE — the consequence nobody stated

**DeepSeek Harness is TypeScript. Escapement v1 is pure Python.**

This is a language migration, not only a framework change. It
independently confirms the freeze's own position that Escapement is
research lineage rather than code lineage — there was never a path where
v1's Python carried across.

It also means Escapement's deterministic analysers (Python `ast` effect
auditing, the drift checks) do not port. The *conclusion* in
[[code-intelligence-is-evidence-not-subsystem]] survives; its
implementation does not.

## Open questions

- Can [[minion-mind]] and AVL reconstruct material activity from its event
  surface? (GRU §22 "Events")
- Can execution sit behind a sandbox or reference monitor? (GRU §22
  "Isolation seam") — bears on [[openshell]] and [[actplane]].
- What does tracking upstream actually cost on a preview-stage project
  with 17k commits?
