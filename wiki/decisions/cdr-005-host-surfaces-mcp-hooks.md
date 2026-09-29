---
title: CDR-005 — Claude Code and Codex surfaces: hand-written MCP server plus hook daemon
kind: decision
status: UNTESTED
verified_by_us: partial
last_reviewed: 2026-09-29
sources:
  - raw/internal/gru-freeze-v1.1.md
  - https://modelcontextprotocol.io/specification/2025-06-18
  - https://code.claude.com/docs/en/hooks
---

# CDR-005 — Host surfaces

**DECISION** (2026-09-29): GRU runs inside Claude Code and Codex through
two surfaces over the same kernel — an MCP server exposing governed tools,
and host hooks that route the host's *own* tool calls through AVL. The
MCP protocol is implemented by hand; no MCP SDK.

## Problem

The Director asked for GRU to "work under Claude Code and Codex, improving
their capabilities" as well as standalone. ADR-005 D4 in Escapement Core
already fixed the shape: one kernel, several interfaces — an agent is not
an MCP server.

## What each host gets

```text
MCP server      gru_* tools: every call goes through the same gate as the
(both hosts)    standalone loop -- authorized, digest-bound, recorded,
                verified at close. Escalations ask the user through MCP
                elicitation where the client supports it, else fail closed.

Claude Code     PreToolUse / PostToolUse hooks: the host's own Read, Write,
hooks           Edit, Bash, WebFetch calls are classified into GRU
                consequences. AVL answers allow / deny / ask; "ask" hands
                the decision to the host's permission prompt, i.e. the
                Director. Effects are recorded after the fact.

Codex hooks     Codex's hook surface (as used by Escapement v1) has no
                per-tool event, so there is no per-tool mediation of its
                built-in shell. Under Codex the governed path is the MCP
                server only.
```

## INFERENCE — the honest ceiling of host mode

AVL decides; the host executes. So in host mode S8 (TOCTOU) cannot hold:
there is no binding to recompute at execution because GRU never
executes. An approved arbitrary shell command makes every later workspace
change *opaque* rather than *explained*. Host mode improves the host —
typed records, consequence-level obligations, truthful closure — without
claiming mediation it does not have.

## Hooks are processes; the session is not

Each hook invocation is a new process, but a governed session lives in
memory. The long-lived MCP server process owns the session and listens on
a unix socket (mode 0600) in the state directory; `gru hook` is a thin
client. If the daemon is unreachable, PreToolUse answers `ask` with an
explicit "not governed" warning, never a silent `allow`.

Ceiling: any process running as the same user can reach the socket and
submit fabricated PostToolUse records. It cannot mint authority —
decisions come only from the kernel — but it can poison evidence. P5 is
not met in host mode.

## Candidates for the protocol layer

```text
A  @modelcontextprotocol/sdk                  new runtime dependency tree
B  hand-written JSON-RPC 2.0 over stdio        <- chosen
```

B keeps the kernel package at one runtime dependency (the model SDK) and
covers the four methods GRU needs (initialize, tools/list, tools/call,
elicitation). Risk: protocol drift. Mitigation: JSON-RPC conformance
tests, and switching to A is a one-file change behind the same surface.

## Recommendation

`BUILD NATIVE` for the MCP surface and hook adapter.
