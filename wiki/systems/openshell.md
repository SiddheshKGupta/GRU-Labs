---
title: NVIDIA OpenShell
kind: system
status: PARTIALLY_SUPPORTED
verified_by_us: partial
last_reviewed: 2026-09-15
sources:
  - https://github.com/NVIDIA/OpenShell
  - raw/internal/gru-freeze-v1.1.md
---

# OpenShell

Sandbox runtime for agent execution. GRU §20 already lists it as a
**strong optional backend** — an enforcement layer *below* AVL, never a
substitute for AVL's semantics.

## FACT — verified 2026-08-11

```text
licence    Apache-2.0
maturity   ALPHA
platform   Linux only
```

Two kernel mechanisms, enforced independently of the container layer:

```text
Landlock LSM   filesystem access
seccomp        syscall surface
```

Network is **default-deny**, built from namespaces plus a proxy.
Credentials are injected only from attached providers and purged when the
sandbox is deleted. On Kubernetes it exposes a **Sandbox CRD**, one Pod
per agent.

## FACT — it already sandboxes the harnesses we would be comparing

One base image covers:

```text
Claude Code   Codex   OpenCode   OpenClaw   Copilot CLI   Ollama
```

## INFERENCE — this is the fact that matters for experiment design

If every arm of a harness comparison runs inside the same sandbox image
with the same Landlock and seccomp profiles, **isolation becomes a shared
variable rather than a confound between arms.** Without that, any
difference measured between two harnesses is partly a difference between
two isolation setups, and no result separates the two causes.

That is a methodological benefit, not a security one, and it is the
reason to care about OpenShell before any policy question is settled.

## Where it sits

Containment only. It answers *where may execution physically go*, not
*is this operation permitted* and not *has this satisfied its delivery
obligations* — see [[containment-is-not-authorization]].

## What we have NOT verified

`verified_by_us: partial` is literal here. We read the project's own
description of its mechanisms; we have not run it, have not measured its
overhead, and have not confirmed the Landlock/seccomp profiles behave as
described under an adversarial workload.

Alpha status plus Linux-only means testing needs a machine we do not
currently have — [[linux-only-enforcement-stack]] gates this.
