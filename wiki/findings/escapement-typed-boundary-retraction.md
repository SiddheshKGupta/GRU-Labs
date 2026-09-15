---
title: Escapement typed-boundary retraction
kind: finding
status: NEGATIVE_RESULT
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - Internal design record, Escapement v1 AuthorizedAction boundary
  - https://github.com/NVIDIA-NeMo/labs-OO-Agents
---

# Escapement typed-boundary retraction

## FACT — the claim, as designed

A Python type was to make bypass **structurally impossible**:

```text
AuthorizedAction      no public constructor
                      only the authorizer can produce one

executor.execute(proposal)   "must not type-check"
```

The argument: if the executor accepts only `AuthorizedAction`, and only
the authorizer can construct one, then an unauthorized proposal cannot
reach the executor. Structure, not policy.

## FACT — retracted

It fails **mypy**. It does not fail **Python**. A private constructor is
not a construction barrier at runtime:

```text
__new__
object.__new__
copy.copy
dataclasses.replace
pickle
```

Each reaches around it. None require unusual knowledge, and several are
what ordinary library code does by default — `copy` and `pickle` are
reached by serialisation, caching and multiprocessing without anyone
intending to bypass anything.

**A lint had been presented as a structural guarantee.**

## FACT — independent corroboration

[[nooa]]'s README states the same limit about its own AST checks and
module deny-lists:

> defense-in-depth guardrails, not a containment boundary

and names OS-level isolation as the actual boundary. NVIDIA reached this
conclusion about their own system with no knowledge of ours.

## INFERENCE — what "structural" requires

The property being claimed needs the checker to be *in the execution
path*. mypy is not; it runs before, out of band, and its verdict has no
runtime representation.

```text
in path      kernel LSM, seccomp, a reference monitor, a
             process boundary, a serialised protocol
out of path  type checker, linter, AST scan, code review
```

[[unfireable-safety-kernel]] names this as its second required property —
pre-action enforcement on a **structurally-only** path — and gets it
through process separation in Rust. The word is load-bearing, and it does
not survive translation into a dynamic language's type annotations.

## What survives

The *design* survives; only the claimed enforcement mechanism was wrong.
An authorization type is still a good way to express intent and to catch
mistakes in review. It is a guardrail. It becomes a boundary only when
something in the execution path enforces it — see
[[containment-is-not-authorization]], and
[[code-intelligence-is-evidence-not-subsystem]] for the general rule.
