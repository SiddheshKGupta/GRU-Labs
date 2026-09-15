---
title: The enforcement stack is Linux-only
kind: question
status: CONTESTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - https://github.com/NVIDIA/OpenShell
  - https://arxiv.org/abs/2606.25189
---

# The enforcement stack is Linux-only

## FACT

```text
Landlock LSM   Linux
seccomp        Linux
eBPF / BPF-LSM Linux
```

Therefore [[openshell]], [[actplane]] and Sandlock cannot run on a
Windows workstation.

**The primary development machine is a Windows workstation.**

This is not a portability inconvenience. Every enforcement mechanism this
research has identified as sound is unavailable on the machine where the
work happens.

## Why it is CONTESTED rather than just open

There is a real argument on both sides, and it is about where development
should live, not about which kernel is better.

```text
FOR resolving it now
  every composition experiment needs it
  the answer changes what "run the tests" means
  a decision made under deadline will be the worst option

AGAINST resolving it now
  none of the enforcement layers is a v0.1 dependency
  GRU §31.2 defers a complex policy engine until AVL v0
    proves the required semantics
  buying a platform decision before the experiment is
    designed is its own mistake
```

## Options

```text
WSL2            lowest friction; kernel feature availability for
                Landlock/seccomp/BPF-LSM NOT verified by us
Linux VM        full control, known kernel; heaviest local setup
CI runner       clean, reproducible, matches how results will be
                reported; slowest iteration loop
```

Nothing above has been tested. The WSL2 row is the one that would change
the answer most if checked, and it is the cheapest to check.

## The actual decision this gates

Any [[composition-safety]] experiment — the eight-route enumeration, the
[[gru-strong-null]] seam test, GRU §32.2's seam matrix — needs a machine
where enforcement can be enforced.

**This must be decided before such an experiment is designed, not
discovered during it.** An experiment designed on a workstation and then
moved to a CI runner is an experiment whose environment changed
mid-flight, which is the condition under which results stop meaning what
they appeared to mean.

## What would settle it

```text
1  check whether WSL2's kernel exposes Landlock, seccomp and
   BPF-LSM in the configuration OpenShell and ActPlane need
2  if yes, WSL2 for iteration + CI runner for reported results
3  if no, VM or CI runner, and local iteration loses enforcement
```

Step 1 is hours of work and currently nobody has done it.
