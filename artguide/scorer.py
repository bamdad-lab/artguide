"""Phase 0 gate: proceed only when two independent methods agree on one
specific work and that work resolves to a canonical record.

This is agreement logic, not a weighted sum. Namer self-confidence is
recorded for calibration later but never moves the tier.
"""
import re
import unicodedata

from .models import Decision, NamerResult, Record, ReverseCandidate, SourceType, Tier
from .retrieve import Retriever

STOPWORDS = {"the", "a", "an", "of", "and", "in", "on", "at", "le", "la", "les", "de", "du", "der", "die", "das"}
MAX_RECORDS = 3


def _tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return {t for t in re.findall(r"[a-z0-9]+", text) if t not in STOPWORDS}


def title_matches(a: str | None, b: str | None) -> bool:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return False
    if ta <= tb or tb <= ta:
        return True
    return len(ta & tb) / len(ta | tb) >= 0.6


def artist_matches(a: str | None, b: str | None) -> bool:
    # Surname overlap. "Vincent van Gogh" vs "Van Gogh" passes.
    # "Claude Monet" vs "Camille Monet" also passes, which the title check must catch.
    ta, tb = _tokens(a), _tokens(b)
    return bool(ta and tb and (ta & tb))


def decide(namer: NamerResult, candidates: list[ReverseCandidate], retriever: Retriever) -> Decision:
    evidence = {
        "namer": {"title": namer.title, "artist": namer.artist, "self_confidence": namer.self_confidence},
        "reverse_top": [(c.source_url, c.source_type.value, c.work_id, c.score) for c in candidates[:10]],
    }

    # Aggregate reverse-search score per resolvable canonical work.
    by_work: dict[str, float] = {}
    for c in candidates:
        if c.source_type is SourceType.CANONICAL and c.work_id:
            by_work[c.work_id] = by_work.get(c.work_id, 0.0) + c.score
    ranked = sorted(by_work, key=by_work.get, reverse=True)[:MAX_RECORDS]
    evidence["canonical_works"] = {w: round(by_work[w], 3) for w in ranked}

    if not ranked:
        has_ref = any(c.source_type is SourceType.REFERENCE for c in candidates)
        why = ("matches only reference sources, no canonical record" if has_ref
               else "no match to a trusted source")
        return Decision(Tier.LOW, None, why, evidence)

    if not namer.artist:
        return Decision(Tier.LOW, None, "the visual namer did not recognise the work, so there is no cross-check", evidence)

    records: list[Record] = [r for w in ranked if (r := retriever.record(w))]
    exact = [r for r in records if artist_matches(namer.artist, r.facts.get("artist"))
             and title_matches(namer.title, r.facts.get("title"))]
    same_artist = [r for r in records if artist_matches(namer.artist, r.facts.get("artist"))]
    evidence["records_checked"] = [r.work_id for r in records]
    evidence["exact_matches"] = [r.work_id for r in exact]

    if len(exact) == 1 and records and exact[0].work_id == records[0].work_id:
        return Decision(Tier.HIGH, exact[0], "namer and reverse search agree on one canonical record", evidence)
    if len(exact) > 1:
        return Decision(Tier.MEDIUM, None, "several canonical records match, possibly a series or versions", evidence)
    if exact:
        return Decision(Tier.MEDIUM, None, "namer agrees with a lower-ranked match, not the top one", evidence)
    if same_artist:
        return Decision(Tier.MEDIUM, None, "methods agree on the artist but not the exact work", evidence)
    return Decision(Tier.LOW, None, "namer and reverse search disagree", evidence)
