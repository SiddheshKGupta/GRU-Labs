# Log

Append-only. Newest entries at the bottom. One entry per change, saying
what moved and why, so the wiki's history is legible without reading a
diff.

---

## 2026-08-11 — initial seeding

Dated to the verification round: every page carries
`last_reviewed: 2026-08-11`, the date the primary sources were fetched.

**Added:** `index.md`, `README.md`, this log, and 25 wiki pages on top of
the two that already existed ([[deepseek-harness]], [[nooa]]) — 27 pages
total. `python lint.py` exits 0 with no warnings.

**Added to raw/:** `raw/internal/gru-freeze-v1.1.md`, an unmodified copy
of the GRU Product and Architecture Freeze v1.1. It is the primary source
for every §-reference in the wiki, and without it in `raw/` those
citations would resolve to a path on one machine. Not edited, and not to
be edited.

### Verified against primary sources

Fetched and checked this round — `verified_by_us: yes`:

```text
systems   cpex, actplane, agentrfc, microsoft-agt, parallax,
          unfireable-safety-kernel, shepherd, harnessbank,
          self-harness, tracecompiler, lambda-rlm
concepts  containment-is-not-authorization, information-is-not-authority,
          composition-safety, verified-determinization,
          verification-discipline, minion-mind
findings  escapement-effect-surface-audit,
          escapement-typed-boundary-retraction,
          continuum-negative-result
question  linux-only-enforcement-stack
```

### Checked only in part

`verified_by_us: partial`, with the gap stated on each page:

```text
openshell            mechanisms read from the project's own
                     description; never run, never measured
gru-strong-null      three components taken on trust (below)
foundation-selection the scorecard is verified; "nothing has been
                     scored" is verified by absence, which is weaker
code-intelligence-is-evidence-not-subsystem
                     supporting evidence is our own prior findings —
                     self-authored source material
```

### Taken on trust

No page is `verified_by_us: no`, so the lint's `[REVIEW]` block is
currently empty. **That is misleading and worth recording.** Three
components inside [[gru-strong-null]] were not fetched, not read and not
run:

```text
Rivet Sandbox Agent    universal host layer
Sandlock               containment
AgentSight             system observation
```

`verified_by_us` is a page-level field, so an unverified component named
*inside* a verified page has nowhere to declare itself. They are marked
`[UNVERIFIED]` inline on that page. If more pages start carrying mixed
provenance, per-claim blocks (`RESEARCH_SCHEMA.md` §3) should be used
rather than leaning on the page-level field.

### One citation-integrity finding recorded

[[harnessbank]] exists partly as a record of a wrong citation: a paper
cited as *"Gated Semantic Quality-Diversity"* with *"+9 to +15.5
percentage points across seven domains"* is HarnessBank, reporting
5.1%–15.4% across seven agent benchmarks, with no trace in its abstract
of the deterministic-crediting split attributed to it. It was the most
load-bearing citation in its round and the only one that was wrong. See
[[verification-discipline]].

### Two pages written to satisfy existing links

[[minion-mind]] and [[code-intelligence-is-evidence-not-subsystem]] were
already wikilinked from `wiki/systems/deepseek-harness.md` and did not
exist, which failed the lint. Both are written from
`raw/internal/gru-freeze-v1.1.md` and from our own findings — no new
external sources.

### Not done

`wiki/decisions/` is still empty. GRU §18 requires a component decision
record per meaningful external dependency and §19 a licence gate before
adoption; the candidates are already on the shelf ([[openshell]],
[[cpex]], [[microsoft-agt]], Cedar, [[deepseek-harness]]) and none has a
record. Nothing has been adopted, so nothing is overdue yet — but the
first adoption must not precede the first record.
