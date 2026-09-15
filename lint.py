#!/usr/bin/env python3
"""Deterministic checks over the research wiki.

This script decides only what can be decided mechanically. Anything
requiring judgement -- whether a new paper contradicts an existing claim,
whether a methodology is sound -- is reported as REVIEW and never
resolved here.

That boundary is deliberate. A contradiction lint that adjudicates
semantics is self-certification wearing a checker's clothes, which is the
exact failure that produced a contract checker passing the defect it was
written to catch.

Standard library only.
"""

from __future__ import annotations

import datetime as dt
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WIKI = ROOT / "wiki"
RAW = ROOT / "raw"
INDEX = ROOT / "index.md"

STATUSES = {
    "SUPPORTED", "PARTIALLY_SUPPORTED", "CONTESTED",
    "NEGATIVE_RESULT", "SUPERSEDED", "UNTESTED",
}
VERIFIED = {"yes", "no", "partial"}
REQUIRED = ("title", "kind", "status", "verified_by_us", "last_reviewed")
KINDS = {"system", "concept", "finding", "baseline", "question", "decision"}
STALE_DAYS = 120

WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")


def parse_frontmatter(text: str) -> tuple[dict[str, object], str] | None:
    """Minimal YAML-subset parser: scalars and '- ' lists only.

    Deliberately not PyYAML -- one dependency for five key types is not a
    trade worth making, and the subset we accept is small enough to read.
    """
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    block, body = text[3:end], text[end + 4:]
    data: dict[str, object] = {}
    key = None
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.lstrip().startswith("- ") and key:
            data.setdefault(key, [])
            if isinstance(data[key], list):
                data[key].append(line.lstrip()[2:].strip())
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            key, value = key.strip(), value.strip()
            data[key] = value if value else []
    return data, body


def slug(path: Path) -> str:
    return path.stem


def main() -> int:
    failures: list[str] = []
    warnings: list[str] = []

    pages = sorted(WIKI.rglob("*.md"))
    if not pages:
        print("FAIL: no wiki pages found")
        return 1

    known = {slug(p) for p in pages}
    linked: set[str] = set()
    today = dt.date.today()

    index_text = INDEX.read_text(encoding="utf-8") if INDEX.exists() else ""
    for match in WIKILINK.finditer(index_text):
        linked.add(match.group(1).strip())

    for page in pages:
        rel = page.relative_to(ROOT).as_posix()
        text = page.read_text(encoding="utf-8")

        parsed = parse_frontmatter(text)
        if parsed is None:
            failures.append(f"{rel}: missing or unparseable frontmatter")
            continue
        meta, body = parsed

        for field in REQUIRED:
            if field not in meta or meta[field] in ("", []):
                failures.append(f"{rel}: missing required field '{field}'")

        status = meta.get("status")
        if status and status not in STATUSES:
            failures.append(f"{rel}: status '{status}' not in vocabulary")

        kind = meta.get("kind")
        if kind and kind not in KINDS:
            failures.append(f"{rel}: kind '{kind}' not in vocabulary")

        verified = meta.get("verified_by_us")
        if verified and verified not in VERIFIED:
            failures.append(f"{rel}: verified_by_us '{verified}' invalid")

        sources = meta.get("sources") or []
        if status == "SUPPORTED" and not sources:
            failures.append(
                f"{rel}: status SUPPORTED with zero sources -- "
                f"a claim nothing backs cannot be supported"
            )

        # raw/ references must resolve; external URLs are not checked here
        for source in sources if isinstance(sources, list) else []:
            if source.startswith("raw/") and not (ROOT / source).exists():
                failures.append(f"{rel}: source path does not exist: {source}")

        reviewed = meta.get("last_reviewed")
        if isinstance(reviewed, str) and reviewed:
            try:
                age = (today - dt.date.fromisoformat(reviewed)).days
                if age > STALE_DAYS:
                    warnings.append(f"{rel}: last reviewed {age} days ago")
            except ValueError:
                failures.append(f"{rel}: last_reviewed '{reviewed}' not ISO date")

        sup_by = meta.get("superseded_by")
        if isinstance(sup_by, str) and sup_by and sup_by not in known:
            failures.append(f"{rel}: superseded_by '{sup_by}' does not exist")
        if status == "SUPERSEDED" and not sup_by:
            failures.append(f"{rel}: SUPERSEDED without superseded_by")

        for match in WIKILINK.finditer(body):
            target = match.group(1).strip()
            linked.add(target)
            if target not in known:
                failures.append(f"{rel}: [[{target}]] does not exist")

    orphans = sorted(known - linked)
    for orphan in orphans:
        warnings.append(f"wiki/**/{orphan}.md: orphan -- linked from nowhere")

    unverified = []
    for page in pages:
        parsed = parse_frontmatter(page.read_text(encoding="utf-8"))
        if parsed and parsed[0].get("verified_by_us") == "no":
            unverified.append(page.relative_to(ROOT).as_posix())

    print(f"pages: {len(pages)}")
    for failure in failures:
        print(f"[FAIL] {failure}")
    for warning in warnings:
        print(f"[WARN] {warning}")

    if unverified:
        print(f"\n[REVIEW] {len(unverified)} page(s) not independently verified:")
        for path in unverified:
            print(f"  - {path}")
        print("  Not a failure. Recorded so it cannot blend in unnoticed.")

    print(f"\nFailures: {len(failures)}  Warnings: {len(warnings)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
