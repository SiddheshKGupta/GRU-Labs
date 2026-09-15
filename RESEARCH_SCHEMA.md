# Research Schema

The rules every wiki page follows. Enforced mechanically by `lint.py`
where enforcement is possible, and left to human review where it is not —
that split is the whole design.

---

## 1. The one invariant

```text
raw/     immutable source material      AUTHORITATIVE
wiki/    our synthesis over it          DERIVED
```

A wiki page is never the source of truth. It is a claim *about* sources,
and it must name them. If a wiki page and a raw source disagree, the raw
source wins and the wiki page is wrong.

Never edit anything under `raw/`. Add a new file instead.

## 2. Page frontmatter

Every page under `wiki/` starts with:

```yaml
---
title:          human-readable name
kind:           system | concept | finding | baseline | question | decision
status:         SUPPORTED | PARTIALLY_SUPPORTED | CONTESTED
                | NEGATIVE_RESULT | SUPERSEDED | UNTESTED
verified_by_us: yes | no | partial
last_reviewed:  YYYY-MM-DD
sources:
  - url or raw/ path
supersedes:     [optional page slugs]
superseded_by:  [optional page slug]
---
```

### `status` vocabulary

| Status | Meaning |
|---|---|
| `SUPPORTED` | evidence backs this and we have checked the evidence |
| `PARTIALLY_SUPPORTED` | some claims hold, others are unverified or narrower than stated |
| `CONTESTED` | credible evidence on both sides; do not act as if settled |
| `NEGATIVE_RESULT` | investigated and did not hold — kept deliberately visible |
| `SUPERSEDED` | replaced by a later page; retained for lineage |
| `UNTESTED` | recorded because it is interesting; nothing has been checked |

### `verified_by_us` is separate from `status`, deliberately

`status` is about the world. `verified_by_us` is about *our own diligence*.
A paper can be `SUPPORTED` by its authors and `verified_by_us: no`.

This field exists because of a specific incident: a paper cited as *"Gated
Semantic Quality-Diversity"* with figures of "+9 to +15.5 points" turned
out to be **HarnessBank**, reporting **5.1–15.4%**, and its abstract did
not contain the deterministic-crediting split attributed to it. It was
the single most load-bearing citation in that round. Nothing else in the
set was wrong — which is exactly why an unverified claim must be visibly
marked rather than blending in.

```text
verified_by_us: yes      we fetched the primary source and checked the claims
verified_by_us: partial  we checked some claims, or only the abstract
verified_by_us: no       taken on trust from a secondary source
```

## 3. Claim blocks

Any non-trivial claim inside a page carries its own provenance:

```yaml
claim:
  statement: "Recursion improves long-context tasks under conditions X"
  status: CONTESTED
  sources: [raw/papers/rah.md, raw/papers/rlm-reproduction.md]
  implications:
    - recursion stays a routed strategy, never a default
```

A claim with `status: SUPPORTED` and zero sources is a lint failure.

## 4. Fact / inference / decision are different things

Borrowed from the Continuum handoff, which used the distinction to good
effect:

```text
FACT        demonstrated by a source or by repository evidence
INFERENCE   our interpretation; may be wrong
DECISION    a choice we made; has an owner and a date
HYPOTHESIS  falsifiable, not yet tested
RESULT      an experiment ran and produced this
```

Label them inline. Do not let an inference acquire the authority of a
fact by being restated confidently in a later page.

## 5. What the lint checks, and what it cannot

**Mechanical — `python lint.py` fails the build:**

```text
frontmatter present and parseable
status drawn from the vocabulary
verified_by_us present
SUPPORTED page with zero sources
last_reviewed older than the staleness window
[[wikilink]] pointing at a page that does not exist
orphan page: exists but is linked from nowhere
raw/ path in sources that does not resolve
superseded_by pointing at a missing page
```

**Not mechanical — flagged for human review, never auto-resolved:**

```text
does this new source contradict an existing claim?
is this source's methodology sound?
does this claim still hold in a changed environment?
is this inference actually supported by its sources?
```

This split is the point. A contradiction lint that an LLM adjudicates is
self-certification wearing a checker's clothes — the same failure that
produced a contract checker which passed the exact defect it was written
to catch. When the machine cannot decide, it must say so rather than
guess.

## 6. Superseding, not deleting

Findings are never deleted, including wrong ones. Set
`status: SUPERSEDED`, add `superseded_by:`, and leave the page.

A research record that quietly removes its mistakes cannot be used to
learn what kinds of mistake we make — and that history has already
proved more valuable here than most of the conclusions.

## 7. Adding a source

```text
1. put the primary material in raw/  (never edit it afterwards)
2. write or update the wiki page that interprets it
3. set verified_by_us honestly
4. append one line to log.md
5. run python lint.py
```

`log.md` is append-only. It records what changed and why, so the wiki's
own history is legible without reading a diff.
