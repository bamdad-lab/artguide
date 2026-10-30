"""Fetch canonical records. Facts come from these, never from a model."""
import html
import re
from typing import Protocol

import httpx

from .models import Record, SourceType


class Retriever(Protocol):
    def record(self, work_id: str) -> Record | None: ...


def _clean(value) -> str:
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


class MetRetriever:
    BASE = "https://collectionapi.metmuseum.org/public/collection/v1/objects/"

    def __init__(self, http: httpx.Client | None = None):
        self.http = http or httpx.Client(timeout=15)

    def record(self, work_id: str) -> Record | None:
        object_id = work_id.split(":", 1)[1]
        r = self.http.get(self.BASE + object_id)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return met_record(work_id, r.json())


def met_record(work_id: str, d: dict) -> Record:
    facts = {
        "title": _clean(d.get("title")),
        "artist": _clean(d.get("artistDisplayName")),
        "date": _clean(d.get("objectDate")),
        "medium": _clean(d.get("medium")),
        "dimensions": _clean(d.get("dimensions")),
        "credit_line": _clean(d.get("creditLine")),
        "department": _clean(d.get("department")),
    }
    return Record(
        work_id=work_id,
        source_url=d.get("objectURL") or f"https://www.metmuseum.org/art/collection/search/{d.get('objectID')}",
        source_type=SourceType.CANONICAL,
        institution="The Metropolitan Museum of Art",
        facts={k: v for k, v in facts.items() if v},
        source_text="",  # the Met API carries no descriptive text
    )


class AICRetriever:
    BASE = "https://api.artic.edu/api/v1/artworks/"
    FIELDS = "id,title,artist_display,date_display,medium_display,dimensions,credit_line,description,place_of_origin"

    def __init__(self, http: httpx.Client | None = None):
        self.http = http or httpx.Client(timeout=15)

    def record(self, work_id: str) -> Record | None:
        object_id = work_id.split(":", 1)[1]
        r = self.http.get(self.BASE + object_id, params={"fields": self.FIELDS})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return aic_record(work_id, r.json()["data"])


def aic_record(work_id: str, d: dict) -> Record:
    facts = {
        "title": _clean(d.get("title")),
        # artist_display is "Name\nNationality, years". Keep the name line as the
        # attribution and the rest as its own field so neither is rewritten.
        "artist": _clean((d.get("artist_display") or "").split("\n")[0]),
        "artist_details": _clean("\n".join((d.get("artist_display") or "").split("\n")[1:])),
        "date": _clean(d.get("date_display")),
        "medium": _clean(d.get("medium_display")),
        "dimensions": _clean(d.get("dimensions")),
        "credit_line": _clean(d.get("credit_line")),
        "place_of_origin": _clean(d.get("place_of_origin")),
    }
    return Record(
        work_id=work_id,
        source_url=f"https://www.artic.edu/artworks/{d['id']}",
        source_type=SourceType.CANONICAL,
        institution="The Art Institute of Chicago",
        facts={k: v for k, v in facts.items() if v},
        source_text=_clean(d.get("description")),
    )


class CompositeRetriever:
    def __init__(self, by_prefix: dict[str, Retriever] | None = None):
        self.by_prefix = by_prefix or {"met": MetRetriever(), "aic": AICRetriever()}

    def record(self, work_id: str) -> Record | None:
        prefix = work_id.split(":", 1)[0]
        retriever = self.by_prefix.get(prefix)
        return retriever.record(work_id) if retriever else None
