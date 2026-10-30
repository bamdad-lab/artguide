"""Classify reverse-search URLs and map canonical ones to work ids.

This mapping is what defines coverage. Phase 0 resolves the Met and the
Art Institute of Chicago. Add institutions here as retrievers are added.
"""
import re
from urllib.parse import urlparse

from .models import SourceType

CANONICAL_PATTERNS = [
    ("met", re.compile(r"^(?:www\.)?metmuseum\.org$"), re.compile(r"/art/collection/search/(\d+)")),
    ("aic", re.compile(r"^(?:www\.)?artic\.edu$"), re.compile(r"/artworks/(\d+)")),
]

# Museum domains we trust but cannot yet resolve to a structured record.
# Matches from these count as canonical evidence but cannot produce narration.
CANONICAL_UNRESOLVED = re.compile(
    r"(nga\.gov|moma\.org|louvre\.fr|nationalgallery\.org\.uk|rijksmuseum\.nl|"
    r"tate\.org\.uk|museodelprado\.es|clevelandart\.org|getty\.edu|vangoghmuseum\.nl)$"
)
REFERENCE = re.compile(r"(wikipedia\.org|wikidata\.org|wikiart\.org|britannica\.com)$")


def classify(url: str) -> tuple[SourceType, str | None]:
    """Return (source_type, work_id or None)."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    for prefix, host_re, path_re in CANONICAL_PATTERNS:
        if host_re.match(host):
            m = path_re.search(parsed.path)
            return SourceType.CANONICAL, (f"{prefix}:{m.group(1)}" if m else None)
    if CANONICAL_UNRESOLVED.search(host):
        return SourceType.CANONICAL, None
    if REFERENCE.search(host):
        return SourceType.REFERENCE, None
    return SourceType.WEAK, None
