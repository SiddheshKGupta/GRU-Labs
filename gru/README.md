# GRU — slice 1

A governed agent harness. A Minion (a model on any route) proposes; AVL,
the Authority & Verification Layer, decides, executes, records and
verifies; the Project Director (you) approves what only a human may. It
runs standalone in a terminal, and inside Claude Code and Codex.

```text
Status     slice 1 of the GRU freeze (raw/internal/gru-freeze-v1.1.md)
Safety     UNSAFE_DEVELOPMENT -- no isolation backend; approved commands
           run with your user's authority (P1, P2, P8 unmet)
Runtime    Node >= 22.18, TypeScript run directly; kernel has zero
           runtime dependencies; the Claude route uses @anthropic-ai/sdk
Not yet    run against a live model API
```

## Quick start

```bash
cd gru && npm ci
node src/cli.ts demo                     # scripted episode, real kernel, real checks
node src/cli.ts                          # interactive terminal (needs a TTY)
node src/cli.ts providers                # model APIs and credential status
node src/cli.ts run --workspace <dir> --contract <file> --route anthropic/claude-opus-5-5
node src/cli.ts verify --state ~/.gru/state
```

The demo is the argument in one screen: the Minion reads a README that
"authorizes" it to delete the tests, tries to, AVL escalates
(`DESTROY_WORKSPACE_DATA`, `ALTER_VERIFICATION`), the Director rejects,
and AVL runs the Director's checks itself. Closure: PASS at ADVERSARIAL
strength, because a must-fail check proves the tests catch a broken
implementation.

## The organisation

```text
Director (T0)  you: grants, approvals, revocations, overrides     built
AVL (T1)       gate, ledger, verification, truthful closure       built
Minion (T3)    one specialist on one governed task                built
Nefario (T3)   capability and route engineering                   seed: the provider catalog
GRU, DRU (T3)  delivery manager, shadow manager                   slice 2
Minion Mind    shared project cognition                           slice 2
```

Every role but the Director and AVL is untrusted intelligence. Seniority
confers no authority; a principal's trust class is derived from its kind.

## Blocks

Each block implements one interface in `src/types.ts` and is wired in
`src/blocks.ts`; surfaces never import a sibling's implementation.

| Block | Files | Does |
|---|---|---|
| kernel | `session.ts`, `avl/*`, `ledger/*`, `contract.ts` | opens episodes, classifies consequences, authorizes, verifies, closes |
| executor | `executors/*` | confined filesystem effects and argv-only commands, re-bound at execution |
| route | `routes/*` | fixture, Claude, any OpenAI-compatible API; discovery, live probes, auto-select |
| director | `director/*` | terminal, scripted, MCP elicitation, deny-all (fail closed) |
| surfaces | `cli/*`, `mcp/*`, `hooks/*`, `install/*` | REPL and commands, MCP server, Claude Code / Codex hooks |

Presets: Anthropic, OpenAI, DeepSeek, OpenRouter, Groq, Ollama, LM
Studio; anything else OpenAI-compatible through `gru.config.json`. Keys
are referenced by environment variable; a key pasted into config is
refused.

## Inside Claude Code and Codex

```bash
node src/cli.ts install claude-code --contract <file> --workspace <dir> --state <dir> --write
node src/cli.ts install codex       --contract <file> --workspace <dir> --state <dir>
```

Claude Code gets governed `gru_*` tools and PreToolUse/PostToolUse hooks
that route its own tool calls through AVL (allow / deny / ask). Codex
gets the `gru_*` tools only; its built-in shell is not mediated. See
`wiki/decisions/cdr-005-host-surfaces-mcp-hooks.md`.

## Conformance: predicted before, observed after

Predictions are in `docs/SLICE_1.md` §8 and §9, written before any test.

| Invariant | Predicted | Observed |
|---|---|---|
| S1 effect mediation | PARTIAL | PARTIAL — every tool proposal is gated; code run by a declared command is not, but in-workspace changes it makes are caught |
| S2 reconstruction | PASS | PASS — proposal, authorization, effect and evidence resolve by id; `gru verify` recomputes from disk |
| S3 truthful closure | PASS | PASS — assertion alone is PARTIAL and INADMISSIBLE; a failing check is FAIL whatever the model says |
| S4 promotion independence | N/A | N/A — analogue passes: protected files need the Director, and changing them caps strength |
| S5, S6 | N/A | N/A — no learning or promotion yet |
| S7 ambient authority | FAIL | FAIL — credentials are stripped, but a declared command can still write outside the workspace |
| S8 TOCTOU | PASS | PASS — revoked grant, replay, forgery, a target appearing and a symlinked parent are all refused |

Every result matched its prediction. Core's own rule applies: that is a
reason for suspicion, not comfort — the predictions and the tests share
authors. What *did* move was the specification. The kernel block's
report showed the spec made every verified failure inadmissible (D6),
recorded a Director's revocation as a breach (D7), and let INDEPENDENT
be reached vacuously (D8). Two of the integration owner's own
conformance expectations were also wrong. All are corrected in place.

## Checks

```bash
npm run typecheck
npm test                    # 520 tests
npm run mutation            # 9 mutants, each removes one guarantee; all must be caught
```

`test/surface.test.ts` is Core's effect-surface audit as a test: every
source file is scanned and each effectful module is allowed only where
the architecture puts it. CI runs all of this plus the demo.

## What this does not claim

- That GRU beats a strong null (Claude Code or Codex with their own
  sandbox and approvals, plus CI). No comparison has been run.
- That anything is confined. It is not; the mode label says so.
- That the host-mode hook payload shapes match live Claude Code exactly.
  They are tested against payloads we wrote.
- That the ledger is tamper-proof. It is tamper-evident.
