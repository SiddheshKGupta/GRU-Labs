---
title: Verification discipline
kind: concept
status: SUPPORTED
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - Internal review record, prior project — four consecutive independent reviews
  - https://arxiv.org/abs/2607.13683
  - raw/internal/gru-freeze-v1.1.md
---

# Verification discipline

Why the wiki carries a `verified_by_us` field separate from `status`.

## FACT — the incident record

Four consecutive independent reviews of one prior project each found real
defects in work its author had assessed as correct. Four out of four.
Among them:

```text
two announced fixes that were structurally inert
  - the change was made, described accurately, and did
    not alter the behaviour it claimed to alter

a contract checker that passed the exact defect it was
written to catch
```

The third one is the important one. It is not a case of skipped
verification. Verification was built, run, and passed — and the thing it
was built to detect was present the whole time.

## FACT — the citation failure

[[harnessbank]]: a paper cited as *"Gated Semantic Quality-Diversity"*
with *"+9 to +15.5 percentage points across seven domains"* is actually
HarnessBank, reporting 5.1%–15.4% across seven agent benchmarks, and its
abstract does not contain the deterministic-crediting split attributed to
it. It was the most load-bearing citation in its round and the only one
that was wrong.

## INFERENCE — the failure is structural, not attentional

The tempting reading is that these were lapses: rushed work, insufficient
care, a bad day. That reading predicts that more care prevents
recurrence. It does not survive the record.

```text
if the cause were carelessness
  -> a careful reviewer would sometimes catch their own work
  -> four for four would be unlikely

if the cause is structural
  -> the author's model of what the change does is the
     same model used to check it
  -> the check inherits every blind spot it should catch
  -> four for four is the expected result
```

A self-authored check cannot detect a defect that lives in the author's
understanding of the problem, because the check is written from that
understanding. This is why the inert fixes were *described accurately* —
the description and the code shared an assumption, and the assumption was
the defect.

**The mitigation is separation of author from verifier. It is not more
care.** More care was already being applied.

## Where this is already encoded

```text
GRU §12.1   the implementing Minion cannot be the sole verifier of
            consequential work
GRU §9      DRU as a persistent independent role, not a self-critique
            prompt
GRU §29     the proposer cannot weaken the verification criteria that
            decide whether its own proposal is promoted
GRU §7      the Director may not convert a failed verification into a
            passing result
```

[[parallax]] arrives at the same conclusion from evaluation design, and
[[unfireable-safety-kernel]]'s fourth property — evidence signed and
verifiable *outside* the controlled system's trust boundary — is the
machine-facing version of the same rule.

## Consequence for this wiki

`lint.py` deliberately refuses to adjudicate semantics. A contradiction
lint that an LLM resolves would be this failure rebuilt: the system
checking its own claims with the model that made them. What it can check
mechanically it fails the build on; what it cannot, it prints and leaves
alone.

`verified_by_us: no` is printed in a `[REVIEW]` block for the same
reason. The HarnessBank citation was wrong in a set where everything else
was right — which is exactly the condition under which an unchecked claim
blends in.

Related evidence from our own record: [[escapement-effect-surface-audit]],
[[escapement-typed-boundary-retraction]], [[continuum-negative-result]].
