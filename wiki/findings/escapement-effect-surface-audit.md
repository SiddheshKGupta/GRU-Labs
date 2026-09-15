---
title: Escapement effect-surface audit
kind: finding
status: NEGATIVE_RESULT
verified_by_us: yes
last_reviewed: 2026-09-15
sources:
  - Internal audit record, Escapement v1 scripts/ effect surface
---

# Escapement effect-surface audit

A founding claim of Escapement v1 was that **the model had no path to
effect**. It did not survive being checked properly.

## FACT — the evidence originally offered

```text
grep -rniE "subprocess|os\.system|exec\("
scope    2 of 14 files
result   no matches
```

Nothing found, therefore no path. The scope was never stated alongside
the conclusion.

## FACT — what a widened search found

Same class of search, standard effect primitives, across all of
`scripts/`:

```text
47 matches in 7 files
```

Including `run_check.py --shell` — the repository's **only** `shell=True`
site — executing a caller-supplied string. Its sole safeguard:

```text
the word "trusted" in its argparse help text
```

Its only caller passed the `verification` command out of
`feature_list.json`.

**`feature_list.json` is a file the agent itself writes.**

```text
agent writes feature_list.json
        ↓
caller reads verification command from it
        ↓
run_check.py --shell   (shell=True)
        ↓
effect
```

The claimed absent path existed, was short, and ran through the
verification machinery.

## INFERENCE — the actual mistake

The mistake was not the missing scope line, and not the unsafe default.
It was this:

```text
text search       "do these three tokens appear in these files?"
structural claim  "can control reach an effect primitive by any route?"
```

These are different questions. The first was answered, and the answer was
reported as the second. A grep cannot enumerate routes it has no pattern
for, and the pattern set here was three tokens chosen from memory.

This is the general failure [[actplane]] describes — *tool-call guardrails
miss system actions that bypass the tool layer* — arrived at from our own
repository rather than from a paper. It is also
[[composition-safety]]'s eight-route enumeration in miniature: the
enumeration was three, and the live route was not among them.

See [[code-intelligence-is-evidence-not-subsystem]] for the standing rule
this produced: an analyser result is evidence with a scope, never a
property of the system.

## What this does not mean

It does not mean the grep was useless, and it does not mean Escapement's
design intent was dishonest. The tool answered its own question
correctly. The defect was in what its output was allowed to license — and
per [[verification-discipline]], the author of the claim was also the
author of the check.
