# GRU research wiki

Navigation hub. Every page under `wiki/` is linked from here; a page that
is not linked is reported as an orphan by `python lint.py`.

## How to use this

Read `RESEARCH_SCHEMA.md` first. It defines the frontmatter, the `status`
vocabulary, and the one invariant this wiki is built on:

```text
raw/     immutable source material      AUTHORITATIVE
wiki/    our synthesis over it          DERIVED
```

Two fields on every page do different jobs and are both load-bearing:

```text
status           what the world appears to be
verified_by_us   what WE actually checked
```

They are independent. A paper can be `SUPPORTED` by its authors and
`verified_by_us: no`. Read the second before relying on the first —
[[verification-discipline]] explains the incident that made it a field.

Inline, claims are labelled `FACT`, `INFERENCE`, `DECISION`,
`HYPOTHESIS` or `RESULT`. An inference does not become a fact by being
restated confidently on a later page.

---

## Concepts

The load-bearing distinctions. Read these before the system pages.

- [[containment-is-not-authorization]] — three layers that keep getting
  conflated: where execution may go, what is permitted, and what delivery
  conditions must hold first
- [[information-is-not-authority]] — untrusted information may influence
  reasoning; it may never grant itself permission
- [[composition-safety]] — individually safe components composing
  unsafely, and the eight-route test for detecting it
- [[verified-determinization]] — converting verified agentic procedures
  into deterministic workflows, and what that trade costs
- [[verification-discipline]] — why `verified_by_us` exists; self-authored
  verification fails structurally, not through carelessness
- [[minion-mind]] — GRU's shared project cognition layer, as frozen and
  as yet untested
- [[code-intelligence-is-evidence-not-subsystem]] — analysers produce
  evidence with a scope, not properties of the system

## Systems

External systems and papers, one page each.

**Enforcement and governance**

- [[openshell]] — NVIDIA sandbox: Landlock, seccomp, default-deny
  network, K8s Sandbox CRD. Alpha, Linux-only
- [[cpex]] — Rust reference monitor between agent and capabilities.
  Pre-1.0
- [[actplane]] — eBPF/BPF-LSM enforcement at the OS, 1.9%–8.4% overhead
- [[agentrfc]] — security principles and conformance testing across MCP,
  A2A, ANP, ACP; TLA+ model checking
- [[microsoft-agt]] — cross-language governance toolkit, 992 conformance
  tests, Decision BOM
- [[parallax]] — cognitive/executive separation, evaluated by assuming
  the reasoner is already compromised
- [[unfireable-safety-kernel]] — four required properties, including
  evidence verifiable outside the controlled system's trust boundary

**Execution and harnesses**

- [[deepseek-harness]] — GRU's current foundation hypothesis. Developer
  preview
- [[nooa]] — an agent as a Python object; better SWE-bench result at half
  the tokens
- [[shepherd]] — reversible Git-like execution traces; fork and revert
  any past state

**Self-improvement and determinization**

- [[harnessbank]] — gene-bank harness evolution. **Also the record of a
  citation that was wrong**
- [[self-harness]] — weakness mining and regression-gated harness repair,
  per model
- [[tracecompiler]] — compiles noisy traces into deterministic workflows,
  and fails on unobserved branches
- [[lambda-rlm]] — a typed λ-calculus runtime against long-context rot,
  with termination and cost bounds

## Findings

Our own results. All three are negative, and kept visible on purpose.

- [[escapement-effect-surface-audit]] — a "no model-to-effect path" claim
  evidenced by a grep over 2 of 14 files; widening it found 47 matches in
  7
- [[escapement-typed-boundary-retraction]] — a Python type claimed as a
  structural boundary was a lint; retracted
- [[continuum-negative-result]] — an architectural claim that did not
  survive specifying its own strongest baseline; 180 planned runs
  cancelled before execution

## Baselines

- [[gru-strong-null]] — the composite stack GRU must beat, and the
  question every GRU mechanism has to answer

## Questions

Open, and blocking something.

- [[linux-only-enforcement-stack]] — the whole enforcement stack is
  Linux; the development machine is not
- [[foundation-selection]] — GRU §22's scorecard exists and has been
  applied to nothing

## Decisions

Empty. GRU §18 requires a component decision record per meaningful
external dependency and §19 a licence gate before adoption; `wiki/decisions/`
is where those go. Nothing has been adopted yet, so nothing is recorded —
several system pages above are candidates that will need one.
