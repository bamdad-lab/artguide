"""Two independent identifiers. The namer never sees reverse-search output."""
import base64
import json
import os
from typing import Protocol

import anthropic
import httpx

from .models import NamerResult, ReverseCandidate
from .sources import classify


def _media_type(photo: bytes) -> str:
    if photo[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if photo[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if photo[:4] == b"RIFF" and photo[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("unsupported image format, use JPEG, PNG or WebP")


class Namer(Protocol):
    def name(self, photo: bytes) -> NamerResult: ...


class ReverseSearch(Protocol):
    def search(self, photo: bytes) -> list[ReverseCandidate]: ...


NAMER_PROMPT = """Identify the artwork in this photo.
Give the exact title and artist only if you recognise this specific work.
If you recognise the artist or series but not the exact work, leave title null.
If you do not recognise it, leave both null. Do not guess."""

NAMER_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": ["string", "null"]},
        "artist": {"type": ["string", "null"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["title", "artist", "confidence"],
    "additionalProperties": False,
}


class ClaudeNamer:
    def __init__(self, model: str | None = None, client: anthropic.Anthropic | None = None):
        self.model = model or os.environ.get("ARTGUIDE_NAMER_MODEL", "claude-opus-5-5")
        self.client = client or anthropic.Anthropic()

    def name(self, photo: bytes) -> NamerResult:
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=2048,
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": NAMER_SCHEMA}},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": _media_type(photo),
                        "data": base64.standard_b64encode(photo).decode(),
                    }},
                    {"type": "text", "text": NAMER_PROMPT},
                ],
            }],
        )
        if response.stop_reason == "refusal":
            return NamerResult(None, None, None)
        text = next(b.text for b in response.content if b.type == "text")
        data = json.loads(text)
        return NamerResult(data["title"], data["artist"], data["confidence"])


class GoogleVisionReverseSearch:
    """Cloud Vision WEB_DETECTION. Needs GOOGLE_VISION_API_KEY."""

    URL = "https://vision.googleapis.com/v1/images:annotate"

    def __init__(self, api_key: str | None = None, http: httpx.Client | None = None):
        self.api_key = api_key or os.environ["GOOGLE_VISION_API_KEY"]
        self.http = http or httpx.Client(timeout=20)

    def search(self, photo: bytes) -> list[ReverseCandidate]:
        body = {"requests": [{
            "image": {"content": base64.standard_b64encode(photo).decode()},
            "features": [{"type": "WEB_DETECTION", "maxResults": 50}],
        }]}
        r = self.http.post(self.URL, params={"key": self.api_key}, json=body)
        r.raise_for_status()
        web = r.json()["responses"][0].get("webDetection", {})
        return parse_web_detection(web)


def parse_web_detection(web: dict) -> list[ReverseCandidate]:
    """Score each matching page: full image matches count more than partial,
    and earlier pages count more than later ones. The raw score is not
    calibrated. Phase 1 calibrates it against the labelled test set."""
    out = []
    pages = web.get("pagesWithMatchingImages", [])
    for rank, page in enumerate(pages):
        full = len(page.get("fullMatchingImages", []))
        partial = len(page.get("partialMatchingImages", []))
        score = (1.0 * min(full, 3) + 0.5 * min(partial, 3)) / (1 + 0.1 * rank)
        source_type, work_id = classify(page["url"])
        out.append(ReverseCandidate(page["url"], source_type, work_id, round(score, 3)))
    return sorted(out, key=lambda c: c.score, reverse=True)
