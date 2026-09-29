---
title: CDR-006 — Munder Difflin: the event-to-avatar metaphor, reimplemented as a terminal office
kind: decision
status: PARTIALLY_SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-29
sources:
  - https://github.com/chaitanyagiri/munder-difflin
  - raw/internal/gru-freeze-v1.1.md
---

# CDR-006 — Munder Difflin and the GRU office

**DECISION** (Director, 2026-09-29): GRU gets an animated project office
in the terminal, driven only by ledger events. It borrows Munder
Difflin's idea of mapping agent events to avatar behaviour and draws
everything itself.

## FACT — what Munder Difflin is (inspected at commit `0dd161c`, 2026-09-29)

```text
shape        Electron desktop app: Pixi.js 2D office floor, xterm.js
             terminals, node-pty processes; wraps Claude Code, Codex,
             Gemini CLI, OpenCode and others as real PTY agents
licence      source MIT (LICENSE present); bundled tilesets are LimeZu
             "Modern Interiors", separately licensed, commercial use
             allowed with credit; cast sprites are procedural and MIT
model        SPEC §4 "the Sims metaphor": hook events move an avatar
             between stations (file shelf, terminal, web portal, MCP
             corner, mailbox); DESIGN §1 "information through motion"
commercial   the project also sells a Pro plan
```

The freeze had already classified it: `INSPIRE + SELECTIVE PATTERNS`,
"build original GRU visuals" (§20), and "the 8-bit office remains an
observability metaphor, not the runtime itself" (§26).

## What GRU takes

The event-to-behaviour mapping, stations, and the rule that motion *is*
the status. What GRU adds is governance: its ledger records AVL verdicts,
escalations, Director decisions, verification and closure, so the office
can show a Minion walking a proposal to AVL's desk, a denial stamped red,
a Minion waiting at the Director's door, and the verdict at closure.

## What GRU does not take

Any code, the LimeZu tilesets, the Electron/Pixi stack, and PTY-wrapped
agents with ambient authority.

## INFERENCE — why a ledger-driven office is the honest version

Every frame is derived from a recorded event, so the office cannot show
work that did not happen, and any past episode can be replayed. It is a
pure reader of the ledger: it cannot affect governance.

## Recommendation

`INSPIRE + REIMPLEMENT`. A desktop or web office stays with the GRU
Workbench (§25–§26), revisited alongside CDR-004.
