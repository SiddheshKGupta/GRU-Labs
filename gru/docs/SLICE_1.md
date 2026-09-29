# GRU Slice 1 — AVL-first governed Minion loop

```text
STATUS      specification, written before implementation
DATE        2026-09-29
SOURCES     raw/internal/gru-freeze-v1.1.md (the freeze; cited as §N)
            Escapement-Core docs/core/CORE_THREAT_MODEL_v0.1.md
            Escapement-Core docs/core/CORE_EPISODE_SCHEMA_v0.1.md
            Escapement-Core docs/core/EXPERIMENT_CORE_000_PREREGISTRATION.md
            Escapement-Core docs/core/GRU_AND_CORE_RELATIONSHIP.md
DECISIONS   wiki/decisions/cdr-001 .. cdr-003
```

> **AMENDED 2026-09-29 — scope widened by the Director mid-slice.** After
> §1–§8 were written, the Director asked for plug-and-play model APIs in
> the style of opencode (with UniMind as a reference), a Lego-style block
> architecture, and for GRU to run inside Claude Code and Codex as well as
> standalone in a terminal. §9 records the additions. §1–§8 are unchanged:
> the kernel's semantics did not move, only the number of surfaces over it.

## 1. What this slice proves, and what it does not

**Question (§32.1 item 4, Core's S1/S7):** can every material project
consequence a Minion attempts reach the workspace only through AVL, with
each one reconstructable as proposal → authorization → effect → evidence,
and can closure be truthful when the model is the thing being governed?

In scope:

```text
AVL v0            consequence normalisation, authority obligations,
                  effect gate, verification ladder, truthful closure,
                  Director override, labelled safety mode
Episode ledger    append-only, hash-chained, structural validator,
                  corpus-admission checker (Core schema §5, v0.2 names)
One Minion loop   one role, one route, a bounded tool loadout
Two routes        deterministic fixture (all tests), Claude (live)
Conformance       Core's S1-S8 as executable tests, plus a mutation
                  check proving those tests can fail
```

Out of scope, deliberately (§31.2 and the reduction ladder): GRU, DRU,
Nefario, Minion Mind, Organization Compiler, the Workbench, learning and
promotion, the DeepSeek Harness adapter (slice 2, cdr-001), and any
isolation backend. The last omission is the most important one and is
labelled, not hidden (§4.3).

## 2. The learnings this slice is built on

Every mechanism below exists because a specific Escapement result says it
must. None exists because it was in v1.

| Learning | Where it was earned | Mechanism in slice 1 |
|---|---|---|
| A model asserting success is not evidence | v1 truthful closure | Model text is recorded as `ASSERTED`; `ASSERTED` never satisfies any tier (§4.4) |
| Evidence must be unforgeable by the writer | v1 forged-check-record fix | Content-addressed evidence blobs; hash-chained ledger; `gru verify` recomputes everything |
| A model-authored string must never reach a shell | v1 PR #60, Core audit | No shell anywhere. Commands are Director-declared argv with no model-supplied arguments |
| "No effect path" was false because the audit was a 2-file grep | Core effect surface audit | The audit is an executable test over every source file (`surface.test.ts`) |
| Python has no private constructors | Core ARCHITECTURE_REDUCTION §2 | `AuthorizedAction` carries an ECMAScript `#brand`; mint token is module-private |
| Process separation is a mechanism, not the property | ADR-003, threat model §2.2 | Properties P1-P10 are the spec; mechanisms are scored against them |
| Proceeding quietly on a weaker boundary is forbidden | ADR-003 §6 | No isolation backend → `UNSAFE_DEVELOPMENT`, stamped on every episode |
| Authority is an event, not a field | Core schema §2, REOPENED | Grants, revocations and Director decisions are ledger events |
| The ordering rule dies under a chassis that already executes | GRU/Core relationship §3.1 | Replaced by conformance: S1-S8 run against this loop and, later, the DSH adapter |
| GRU, DRU, Nefario and Minions are all T3 | GRU/Core relationship §1.3 | Trust class derives from principal kind; only Director (T0) and AVL (T1) sit outside T3 |
| Information is not authority | §14.2, threat model T4 | Tool output is returned to the model as data; no code path parses it for authority |
| Self-authored checkers pass their own defects | Continuum C001, three reviews | Mutation check: each conformance guarantee has a mutant that must turn a test red |
| Compare against the strongest simple alternative | Continuum Phase I | §6 lists what a strong null already gives; nothing here claims to beat it |
| Retract in place | every Core document | This document is amended with `CORRECTED` blocks, never silently edited |

## 3. Trust classes

```text
T0  Director        the user; grants, approves, revokes, overrides
T1  AVL             this kernel: gate, ledger, verification, closure
T2  providers       model API, OS, (later) sandbox, DSH
T3  intelligence    the model and every role it plays: Minion now,
                    GRU / DRU / Nefario later
T4  information     workspace files, command output, tool results
```

A principal's trust class is derived from its kind and cannot be
supplied. Nothing in T3 can mint an authorization, record a Director
decision, alter the verification contract after it is loaded, or write
the ledger.

## 4. AVL v0

### 4.1 Effects and project consequences (§14.1)

A tool call is parsed into one route-level **effect**, then normalised to
**project consequences**. Obligations attach to consequences, never to
routes, so the same consequence reached two ways carries the same
obligation.

| Effect | Consequences |
|---|---|
| `fs.read`, `fs.list` | `OBSERVE_WORKSPACE` |
| `fs.write` | `MODIFY_WORKSPACE`, or `ALTER_VERIFICATION` if the path is protected |
| `fs.delete` | `DESTROY_WORKSPACE_DATA`, plus `ALTER_VERIFICATION` if protected |
| `process.run` | the command's declared consequences, plus those implied by its declared `writes` / `deletes` globs |

| Consequence | Obligation |
|---|---|
| `OBSERVE_WORKSPACE` | scope `workspace:read` |
| `MODIFY_WORKSPACE` | scope `workspace:write` |
| `DESTROY_WORKSPACE_DATA` | scope `workspace:delete`, else per-action Director approval |
| `EXECUTE_WORKSPACE_CODE` | scope `command:<id>` |
| `ALTER_VERIFICATION` | per-action Director approval; never pre-grantable |
| `MUTATE_REPOSITORY` | per-action Director approval |
| `EXTERNAL_SIDE_EFFECT` | per-action Director approval |

Verdicts: `ALLOW` when every obligation is met by an active grant;
`ESCALATE` when an obligation needs the Director; `DENY` when no one can
authorise it in this slice (path escape, undeclared command, malformed
input, unknown tool). Without a Director channel, escalation fails
closed.

### 4.2 Authorization (P3, P9, P10, S8)

`ALLOW` mints an `AuthorizedAction`: frozen effect, SHA-256 digest of the
canonical effect, single use, expiry, and the grant ids it relies on. An
executor redeems it by recomputing the digest from what it is about to
do, resolved against the filesystem **at execution time**. Redemption
fails on: a missing brand, reuse, expiry, a grant revoked since
authorization, or a digest mismatch (including a path that now resolves
elsewhere).

### 4.3 Safety mode

No isolation backend exists in slice 1, so P1, P2 and P8 cannot be met:
a declared command that runs workspace code (`node --test` over tests the
Minion edited) executes with the ambient authority of the user.
Mitigations that exist are narrowing, not confinement: a scrubbed
environment (no credentials), `cwd` pinned to the workspace, and
post-hoc **workspace reconciliation** that flags every in-workspace change
not explained by an authorized effect or a declared command's `writes`.
Changes outside the workspace are undetectable. Every episode records
`UNSAFE_DEVELOPMENT` with the unmet properties, and the CLI prints it.

### 4.4 Verification and closure

The verification contract is authored by the Director before the episode,
hashed into the opening event, and run by AVL — never by the Minion.

```text
NONE         no check ran
ASSERTED     only the model said so                     never sufficient
CHECKED      Director-declared checks ran and passed
INDEPENDENT  CHECKED, and no protected file changed during the episode
ADVERSARIAL  INDEPENDENT, and every must-fail check failed as required
```

> **CORRECTED 2026-09-29 — strength grades the verdict, not the outcome.**
> The ladder above said CHECKED means checks "ran and passed", and the
> first implementation capped any failing episode at CHECKED. Under the
> MATERIAL floor that made every verified failure INADMISSIBLE, the
> opposite of Core schema §5.2 ("a verified failure is among the most
> valuable records"). Corrected: CHECKED means every declared check ran to
> a verdict, pass or fail; a check that timed out or never started yields
> no strength at all. Pass or fail is the separate `outcome`. Found by the
> kernel block's own report, not by a test — the test encoded the error.

Floors: `MICRO` requires `CHECKED`; `MATERIAL` and `PROGRAM` require
`INDEPENDENT`. A contract may raise its requirement, never lower it. A
`MATERIAL` or `PROGRAM` contract that declares checks must protect at
least one path (D8).

```text
policy violation (unmediated change, structural break)  -> FAIL
a check failed                                         -> FAIL
checks passed, strength below requirement              -> PARTIAL
checks passed, loop did not complete                   -> PARTIAL
no checks declared                                     -> PARTIAL
refusal or route error with nothing verified           -> ABANDONED
checks passed, strength sufficient, loop completed     -> PASS
```

A Director override appends `PROCEED` with residual risk `ACCEPTED`. It
never edits closure or verification (§7).

## 5. Episode ledger

One JSONL file per episode, one event per line, each carrying `seq`,
`prev` and `hash = sha256(canonical(event without hash))`. Evidence
bodies are stored by digest beside it. The state directory may not sit
inside the workspace.

Structural invariants (Core schema §3.1), checked by `gru verify` and at
closure:

```text
every effect        -> an authorization that ALLOWed or a Director APPROVE
every authorization -> a recorded proposal
no effect           -> for a proposal that was DENIED or REJECTED
```

Corpus admission is recomputed from events alone and emits
`ADMISSIBLE_POSITIVE | ADMISSIBLE_NEGATIVE | INADMISSIBLE | UNRESOLVED`
over the eight conditions in Core schema §5.

## 6. What the strong null already gives

A competent composition without GRU — Claude Code or Codex with its own
sandbox and approval policy, CI running the same tests on a protected
branch, v1 evidence closure — already provides CHECKED verification, an
approval prompt per tool, and OS confinement this slice lacks. What it
does not provide, per Core's preregistered predictions, is typed
reconstruction (S2), consequence-level obligations independent of route
(S1), and detection of authorization/execution mismatch (S8). Slice 1
claims to implement those three for its own loop. It claims nothing
about being better than the null; that needs the DSH adapter and a real
comparison.

## 7. Decisions this spec had to make

```text
D1  outcome_resolved for PARTIAL/ABANDONED is UNDECIDABLE, not FAIL.
    Schema v0.1 §5.2 makes a PARTIAL episode both INELIGIBLE (via a
    FAILed condition) and UNRESOLVED; the verdict table wins.

D2  A Director override does not change admissibility. It is an
    intervention with actor, time and reason; the closure it follows is
    unchanged, so an overridden FAIL is ADMISSIBLE_NEGATIVE.
    (Relationship doc open question 4.)

D3  A missing grant scope escalates rather than denies, so the Director
    can approve one action without widening the grant.

D4  Commands take no model-supplied arguments in slice 1.

D5  Trust classes are fixed by principal kind; admission of any T2
    backend is a Director action (relationship doc §1.3, Nefario).

D6  Strength is independent of outcome (see the CORRECTED note in §4.4).

D7  The gate refusing an authorized effect at execution -- revoked
    grant, expiry, a changed binding -- is a `refusal` event, not a
    violation. Nothing happened, so governance held; whatever changed the
    binding is caught separately by reconciliation if it was unmediated.
    Violations are reserved for breaches: unmediated changes, a host
    performing a denied action, an executor that skipped redemption, a
    broken ledger.

D8  INDEPENDENT means "no protected file changed", which is vacuous when
    nothing is protected, so a MATERIAL or PROGRAM contract with checks
    must declare protected globs. The parser cannot check that they cover
    what the checks read.
```

## 8. Conformance predictions — recorded before any test ran

| Inv | Prediction | Reason |
|---|---|---|
| S1 effect mediation | **PARTIAL** | every tool proposal is mediated; code run by a declared command is not |
| S2 reconstruction | **PASS** | each effect is linked to proposal, authorization and evidence by id |
| S3 truthful closure | **PASS** | model text is `ASSERTED`; closure reads only AVL-run checks |
| S4 promotion independence | **N/A** | no promotion system; the analogue (contract immutability, protected files) is tested |
| S5 prospective credit | **N/A** | no learning in slice 1 |
| S6 rollback | **N/A** | nothing is promoted; revocation is append-only and tested under S8 |
| S7 ambient authority | **FAIL** | no isolation backend; in-workspace changes are detected, outside changes are not |

> AMENDED 2026-09-29 (CDR-007): with the node-permission backend, S7 is PARTIAL for contracts whose declared argv all run `node` (filesystem confined, P1 and P2 met; network open, P8 unmet). Without a backend the original FAIL still holds and is still tested.
| S8 TOCTOU | **PASS** | digest recomputed at execution; replay, expiry, revocation, symlink swap refused |

If every result matches, suspect the tests were written to agree with
this table. Results are recorded in `gru/README.md` without editing the
predictions.

## 9. Blocks and surfaces (amendment)

```text
                 terminal (REPL, gru run)   MCP server   Claude Code / Codex hooks
                            \                   |                 /
                             ------------ Blocks (types.ts) ------
                            /        |          |           \
                      kernel     executor     route      director
                  session, AVL,  confined fs,  fixture,    terminal,
                  ledger,        argv-only     Anthropic,  scripted,
                  admissibility  commands      OpenAI-     MCP elicitation,
                                               compatible  deny-all
```

Each block implements one interface in `src/types.ts` and is wired in
`src/blocks.ts`. Surfaces receive a `Blocks` object and never import a
sibling's implementation, so a DeepSeek Harness executor, a sandboxed
executor or another provider replaces one block without touching the
others. This is the freeze's "replaceable infrastructure" (§4.3) made
mechanical.

**Routes.** Presets for Anthropic, OpenAI, DeepSeek, OpenRouter, Groq,
Ollama and LM Studio; any OpenAI-compatible endpoint by config. Discovery,
live probes and auto-selection follow UniMind's ideas, reimplemented
(CDR-004). Keys are referenced by environment variable; a key pasted into
a config file is rejected.

**Host mode** (CDR-005). Under Claude Code, PreToolUse/PostToolUse hooks
classify the host's own tool calls; AVL answers allow, deny or ask, and
"ask" hands the decision to the host's permission prompt. The host
performs the effect, so binding at execution is impossible. Additional
predictions for host mode, recorded before any host-mode test ran:

| Inv | Host-mode prediction | Reason |
|---|---|---|
| S1 | **PARTIAL** (Claude Code), **FAIL** (Codex built-ins) | Claude Code's tools pass PreToolUse; Codex exposes no per-tool hook, so only `gru_*` MCP tools are mediated |
| S2 | **PASS** | each host effect is recorded against its authorization |
| S3 | **PASS** | closure still reads only AVL-run checks |
| S8 | **N/A** | GRU does not execute host effects, so there is nothing to bind |
