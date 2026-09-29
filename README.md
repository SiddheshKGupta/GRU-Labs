# GRU Labs

GRU Labs (formerly GRU Research; the GitHub repository is still named
`GRU-Research` until it is renamed there) is the research wiki for
**GRU** (Governed Recurrent Unit), a governed AI project-delivery
system. It holds what we have read, what we have
checked, and what we got wrong.

It also holds the implementation, in [`gru/`](gru/README.md). The code is
not part of the wiki: nothing under `gru/` is a source for a wiki claim
until a finding page cites it, and `lint.py` does not read it.

Start at [`index.md`](index.md). The rules are in
[`RESEARCH_SCHEMA.md`](RESEARCH_SCHEMA.md).

## The invariant

```text
raw/     immutable source material      AUTHORITATIVE
wiki/    our synthesis over it          DERIVED
```

A wiki page is never the source of truth. It is a claim *about* sources
and must name them in its frontmatter. If a page and a raw source
disagree, the raw source wins and the page is wrong.

**Never edit anything under `raw/`.** Add a new file instead.

## Layout

```text
raw/
  papers/      fetched primary literature
  github/      repository snapshots
  standards/   specifications
  internal/    our own primary documents (architecture freezes, etc.)

wiki/
  systems/     one external system or paper per page
  concepts/    the load-bearing distinctions
  findings/    our own results, including the negative ones
  baselines/   what a mechanism has to beat
  questions/   open and blocking
  decisions/   component decision records (GRU §18) + licence gate (§19)

gru/           the implementation (slice 1); see gru/README.md

index.md       navigation hub; every page must be linked from here
log.md         append-only change log
lint.py        deterministic checks
```

## Lint

```sh
python lint.py      # stdlib only, no deps; exit 0 == clean
```

It fails the build on: missing or unparseable frontmatter, a `status` or
`kind` outside the vocabulary, a missing `verified_by_us`, a `SUPPORTED`
page with zero sources, a `[[wikilink]]` to a page that does not exist, a
`raw/` source path that does not resolve, and a `superseded_by` pointing
at nothing.

It warns on orphan pages and on anything not reviewed in 120 days.

It **does not** adjudicate semantics — whether a new source contradicts an
existing claim, whether a methodology is sound. Those print as review
items and stay unresolved. A contradiction check that a model resolves is
the system verifying itself with the model that wrote the claim; see
`wiki/concepts/verification-discipline.md` for the incident behind that
line.

## Status vs verified_by_us

Two independent fields. `status` is a claim about the world;
`verified_by_us` is a claim about our own diligence.

```text
verified_by_us: yes      we fetched the primary source and checked it
verified_by_us: partial  some claims checked, or the abstract only
verified_by_us: no       taken on trust from a secondary source
```

For papers, `status: SUPPORTED` is used where the claim is a plain
checkable fact or a result on a public benchmark;
`PARTIALLY_SUPPORTED` where the headline number is self-reported on an
author-designed protocol, or where part of the evidence is withheld.

## Adding a source

```text
1  put the primary material in raw/        (never edit it afterwards)
2  write or update the wiki page over it
3  set verified_by_us honestly
4  link the page from index.md             (or lint reports an orphan)
5  append one line to log.md
6  python lint.py
```

Findings are never deleted, including wrong ones. Set
`status: SUPERSEDED`, add `superseded_by:`, leave the page. The record of
what kinds of mistake we make has been worth more than most of the
conclusions.
