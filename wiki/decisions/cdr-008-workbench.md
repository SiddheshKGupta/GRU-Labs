---
title: CDR-008 — the GRU Workbench, a read-only web view of the ledgers
kind: decision
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-29
sources:
  - raw/internal/gru-freeze-v1.1.md
---

# CDR-008 — the GRU Workbench

**DECISION** (Director's mock-up, 2026-09-29): `gru workbench --state
<dir>` serves a dashboard of every episode in a state directory: GRU,
DRU and Nefario panels, the Minions' workspace, a terminal feed, project
status, the GRU–DRU debate, verification and AVL. `--snapshot` writes
one self-contained HTML file instead. It is the freeze's "GRU Workbench"
product surface (§0), in a first read-only form.

## FACT — how it is built

- Every panel is a pure fold over ledger events (`workbench/model.ts`);
  the page cannot show a state the ledger does not record. A ledger that
  fails `verifyChain`/`verifyStructure` is shown as broken, not dropped.
- DRU and the debate are not built, and the page says so rather than
  showing placeholder objections.
- Minion text is untrusted: the page inserts ledger strings with
  `textContent` only, and inline JSON escapes `<`, U+2028 and U+2029.
- The server answers GET `/` and `/api/state` only, binds 127.0.0.1,
  refuses requests whose Host is not loopback (DNS rebinding) and sends
  a `default-src 'none'` CSP. It cannot approve, revoke or run anything.
- It is the only `node:http` importer in `src/`; the effect-surface test
  enforces that.

## INFERENCE — what it replaces

CDR-006 planned an animated terminal office; the Director's mock-up
asked for this dashboard instead, so the terminal office stays parked
in `gru/wip/office/`. The avatars are hand-drawn pixel fan art of Gru,
Dru, Dr. Nefario and the Minions: the Director's decision (2026-09-29)
for personal, non-commercial use with friends. Revisit before the repo
or the Workbench is published or distributed.

Next steps that would change the design: approvals from the page (it
would then be a Director channel and need authentication), and DRU
panels once DRU exists.
