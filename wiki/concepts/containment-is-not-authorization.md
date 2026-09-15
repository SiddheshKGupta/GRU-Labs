---
title: Containment is not authorization
kind: concept
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-08-11
sources:
  - https://github.com/NVIDIA/OpenShell
  - https://github.com/NVIDIA-NeMo/labs-OO-Agents
  - raw/internal/gru-freeze-v1.1.md
---

# Containment is not authorization

Three distinct layers keep getting collapsed into one word — "guardrails",
"safety", "governance". They answer different questions, fail
independently, and cannot substitute for one another.

```text
CONTAINMENT           where may execution physically go?
AUTHORIZATION         is this particular operation permitted?
DELIVERY GOVERNANCE   has this satisfied the project-delivery
                      conditions required before it should happen?
```

## The three layers

**CONTAINMENT** — [[openshell]]. Landlock, seccomp, namespaces, a
default-deny network. Kernel-enforced, independent of the process it
contains. It does not know what the operation *means*; it knows which
syscalls and paths are reachable.

**AUTHORIZATION** — [[cpex]], [[microsoft-agt]], Cedar. Identity, policy
evaluation, credential reduction, redaction, audit, per operation. It
knows what the operation is and who is asking. It does not know whether
the project is ready for it.

**DELIVERY GOVERNANCE** — AVL, and this is the layer GRU is actually
about. GRU §14.1: action → project consequence → authority obligation →
evidence obligation → independent verification → state transition →
truthful closure. A `git push` may be fully contained and fully
authorized and still not permitted, because the evidence obligation for
the milestone it closes is unmet.

## FACT — the distinction is stated by outside parties too

[[nooa]]'s README says its AST checks and module deny-lists are
*"defense-in-depth guardrails, not a containment boundary"*, and names
OS-level isolation as the boundary. That is a vendor drawing the
containment/authorization line in their own documentation, with no
knowledge of this project.

[[actplane]] draws the same line from the enforcement side: tool-layer
guardrails miss system actions that bypass the tool layer.

## INFERENCE — why the conflation is expensive

Each layer's failure looks like the others' success.

```text
contained but unauthorized   sandbox holds; wrong operation runs
                             happily inside it
authorized but ungoverned    policy says yes; the project had no
                             evidence that it should happen
governed but uncontained     obligations satisfied; a second route
                             reached the same effect anyway
```

The third row is [[composition-safety]]. The first is what a sandbox
alone buys you. The second is the gap GRU exists to fill, and the reason
no off-the-shelf policy engine is a substitute for AVL.

## Consequence for sourcing

Containment and authorization are commodity infrastructure with clean
seams — GRU §17.2, INTEGRATE. Delivery governance defines the machine —
GRU §17.1, BUILD NATIVE. Getting the three layers straight is what makes
that split decidable rather than a matter of taste.
