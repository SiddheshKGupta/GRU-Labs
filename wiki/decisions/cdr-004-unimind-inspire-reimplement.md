---
title: CDR-004 — UniMind AI Hub: inspire and reimplement; code quarantined
kind: decision
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-29
sources:
  - https://github.com/InfinityArtist006/UniMind-Ai---Unified-Api-Workbench
  - raw/internal/gru-freeze-v1.1.md
---

# CDR-004 — UniMind AI Hub

**DECISION** (2026-09-29, pending the Director's answer on ownership):
GRU reimplements UniMind's provider-routing ideas natively. No UniMind
code is copied until its licence is resolved.

## Problem

The Director asked for plug-and-play model APIs "like opencode", pointing
at UniMind as the reference. GRU needs a route fabric (§23) that can take
a provider, discover its models, prove which ones answer, and choose one.

## FACT — what UniMind is (inspected at commit `4d40787`, 2026-09-29)

```text
shape        TanStack Start web app, React 19, Vite, Bun; VS Code-style
             workbench shell; Vercel AI SDK (@ai-sdk/anthropic,
             @ai-sdk/openai-compatible); ~2,800 lines in src/lib
ideas        provider discovery from the /models catalogue; a live probe
             that sends a real tiny chat to each model and keeps only the
             ones that answer; auto model selection ranked coding/chat
             first, reasoning last, cached 5 minutes, invalidated on
             failure; base-URL normalisation; probe host restrictions;
             one-click MCP / plugin / skill install state; shared memories
author       GitHub account InfinityArtist006 ("Infinity Artist"), a
             different account from this project's owner
```

## FACT — the licence is unresolved

The README carries an MIT badge and says "Licensed under the MIT License
(LICENSE)". **No LICENSE file exists in the repository.** Under §19.1 an
unknown licence means quarantine: do not copy. A README sentence may well
express the author's intent, but MIT's one condition is that its notice
travels with the code, and there is no notice to carry.

## FACT — a security finding

`src/lib/coding-tools.server.ts` gives the chat assistant a `run_command`
tool that passes the model's command string to `child_process.exec`,
which runs it through a shell. That is the pattern Escapement v1 removed
in PR #60 and the Core effect-surface audit exists because of. Its path
containment (`path.relative`, not `startsWith`) is correct.

## Candidates

```text
A  integrate UniMind as a dependency / fork
B  inspire + reimplement its routing ideas in gru/src/routes   <- chosen
C  ignore it
```

A brings a second ontology (web framework, Vercel AI SDK message model,
localStorage state) that §35 forbids, plus the licence gap. C discards
good, field-tested ideas.

## What GRU takes, reimplemented

```text
discovery      GET {base}/models, parse the catalogue
live probe     a real one-message request per model, latency or error
auto-select    rank, probe in order, cache 5 min, invalidate on failure
URL hygiene    strip /models and /chat/completions, add /v1 to bare hosts
key hygiene    credentials by env-var reference only; a pasted key is
               rejected from config files
```

What GRU does not take: any code, the web stack, and the unmediated
`run_command`.

## Recommendation

`INSPIRE + REIMPLEMENT` for routing (§17.3). `DEFER` the UI: it is the
closest existing thing to the freeze's GRU Workbench (§25–§26) and worth
revisiting as a Workbench front end once the licence is settled and the
kernel exposes an API.

## What would change this

The Director confirming ownership of UniMind, or its author adding a
LICENSE file, reopens A for the Workbench UI — never for its tool
execution path.
