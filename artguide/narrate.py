"""Grounded script. Hard facts are templated verbatim from the record in code.
The model writes only the interpretation paragraph, and a guard checks it."""
import base64
import json
import os
import re
from typing import Protocol

import anthropic

from .identify import _media_type
from .models import Record, Script


def facts_text(record: Record) -> str:
    f = record.facts
    parts = []
    lead = f"This is {f['title']}" if f.get("title") else "This work"
    if f.get("artist"):
        lead += f", by {f['artist']}"
    if f.get("date"):
        lead += f", dated {f['date']}"
    parts.append(lead + ".")
    if f.get("medium"):
        parts.append(f"Medium: {f['medium']}.")
    owner = f"It is in the collection of {record.institution}"
    if f.get("credit_line"):
        owner += f", {f['credit_line']}"
    parts.append(owner + ".")
    return " ".join(parts)


# ---- grounding guard ----------------------------------------------------

ALWAYS_OK = {"I", "The", "This", "It", "Its", "In", "A", "An"}


def _allowed_text(record: Record) -> str:
    return " ".join([record.institution, record.source_text, *record.facts.values()]).lower()


def check_grounding(interpretation: str, record: Record) -> list[str]:
    """Heuristic. Catches new numbers, new proper names and long verbatim
    copying. It cannot catch an unsupported claim written in plain words,
    so the factual-error rate still needs a human check (spec section 9)."""
    allowed = _allowed_text(record)
    violations = []

    for num in set(re.findall(r"\d[\d,.]*\d|\d", interpretation)):
        if num not in allowed:
            violations.append(f"number not in record: {num}")

    # Capitalised words that do not start a sentence.
    for m in re.finditer(r"(?<![.!?:]\s)(?<!^)\b([A-Z][a-zA-ZÀ-ſ'-]+)", interpretation):
        word = m.group(1)
        if word in ALWAYS_OK:
            continue
        if word.lower() not in allowed:
            violations.append(f"name not in record: {word}")

    src_words = record.source_text.lower().split()
    if len(src_words) >= 12:
        shingles = {" ".join(src_words[i:i + 12]) for i in range(len(src_words) - 11)}
        out_words = interpretation.lower().split()
        for i in range(len(out_words) - 11):
            if " ".join(out_words[i:i + 12]) in shingles:
                violations.append("copies 12+ words verbatim from the source")
                break

    return sorted(set(violations))


# ---- narrator -----------------------------------------------------------

class Narrator(Protocol):
    def script(self, record: Record, photo: bytes | None, style: dict | None = None) -> Script: ...


SYSTEM = """You write one short paragraph of spoken commentary for a museum audio guide.
The listener has already heard the title, artist, date and medium. Do not repeat them.

Rules:
- Use only two sources: the RECORD below, and what is plainly visible in the photo.
- Do not state any date, number, person, place, movement, or event that is not in the RECORD.
- Do not use general knowledge about the artist or period. If the RECORD has no
  descriptive text, describe only what to look at in the work.
- Ignore glare, frames, labels, walls and people in the photo.
- Summarise in your own words. Never quote more than a few words of the RECORD.
- If there is little to say from these sources, say less. A short paragraph is fine.
- Write plain spoken English, 60 to 110 words, no lists."""

SCHEMA = {
    "type": "object",
    "properties": {
        "interpretation": {"type": "string"},
        "missing": {"type": "string", "description": "what the sources did not cover, or empty"},
    },
    "required": ["interpretation", "missing"],
    "additionalProperties": False,
}


class ClaudeNarrator:
    def __init__(self, model: str | None = None, client: anthropic.Anthropic | None = None):
        self.model = model or os.environ.get("ARTGUIDE_NARRATOR_MODEL", "claude-opus-5-5")
        self.client = client or anthropic.Anthropic()

    def _interpret(self, record: Record, photo: bytes | None, feedback: str | None) -> str:
        record_json = json.dumps({"facts": record.facts, "description": record.source_text}, ensure_ascii=False)
        content = []
        if photo:
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": _media_type(photo),
                "data": base64.standard_b64encode(photo).decode()}})
        text = f"RECORD:\n{record_json}"
        if feedback:
            text += f"\n\nYour previous draft broke the rules: {feedback}. Rewrite it without those."
        content.append({"type": "text", "text": text})
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=4096,
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            system=SYSTEM,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": content}],
        )
        if response.stop_reason == "refusal":
            return ""
        out = next(b.text for b in response.content if b.type == "text")
        return json.loads(out)["interpretation"].strip()

    def script(self, record: Record, photo: bytes | None, style: dict | None = None) -> Script:
        facts = facts_text(record)
        interpretation = self._interpret(record, photo, None)
        violations = check_grounding(interpretation, record)
        if violations:
            interpretation = self._interpret(record, photo, "; ".join(violations))
            violations = check_grounding(interpretation, record)
        dropped = bool(violations) or not interpretation
        text = facts if dropped else f"{facts}\n\n{interpretation}"
        return Script(
            text=text,
            facts_text=facts,
            interpretation="" if dropped else interpretation,
            citations=[f"{record.institution}: {record.source_url}"],
            guard_violations=violations,
            interpretation_dropped=dropped,
        )
