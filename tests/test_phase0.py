"""Logic tests with hand-built inputs. These do not measure real-world
accuracy. That needs real gallery photos run through evaluate.py."""
import json
from types import SimpleNamespace

from artguide.identify import parse_web_detection
from artguide.models import NamerResult, Record, ReverseCandidate, SourceType, Tier
from artguide.narrate import ClaudeNarrator, check_grounding, facts_text
from artguide.pipeline import Pipeline
from artguide.scorer import decide
from artguide.sources import classify

C, R, W = SourceType.CANONICAL, SourceType.REFERENCE, SourceType.WEAK


def rec(work_id, title, artist, text=""):
    return Record(work_id, f"https://example.org/{work_id}", C, "Test Museum",
                  {"title": title, "artist": artist, "date": "1890", "medium": "Oil on canvas"}, text)


class FakeRetriever:
    def __init__(self, *records):
        self.records = {r.work_id: r for r in records}

    def record(self, work_id):
        return self.records.get(work_id)


def cand(url, work_id=None, score=1.0, st=C):
    return ReverseCandidate(url, st, work_id, score)


# ---- sources ----

def test_classify():
    assert classify("https://www.metmuseum.org/art/collection/search/436535") == (C, "met:436535")
    assert classify("https://www.artic.edu/artworks/27992/a-sunday-on-la-grande-jatte") == (C, "aic:27992")
    assert classify("https://www.nga.gov/collection/art-object-page.1.html") == (C, None)
    assert classify("https://en.wikipedia.org/wiki/Wheat_Field") == (R, None)
    assert classify("https://posterstore.example/van-gogh-print") == (W, None)


def test_parse_web_detection_ranks_full_matches_first():
    web = {"pagesWithMatchingImages": [
        {"url": "https://shop.example/print", "partialMatchingImages": [{}]},
        {"url": "https://www.metmuseum.org/art/collection/search/1", "fullMatchingImages": [{}, {}]},
    ]}
    out = parse_web_detection(web)
    assert out[0].work_id == "met:1"
    assert out[1].source_type is W


# ---- scorer ----

def test_high_when_methods_agree_on_one_canonical_record():
    r = FakeRetriever(rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh"))
    d = decide(NamerResult("Wheat Field with Cypresses", "Van Gogh", "high"),
               [cand("u", "met:1")], r)
    assert d.tier is Tier.HIGH and d.record.work_id == "met:1"


def test_series_is_medium_not_high():
    r = FakeRetriever(rec("met:1", "Water Lilies", "Claude Monet"), rec("aic:2", "Water Lilies", "Claude Monet"))
    d = decide(NamerResult("Water Lilies", "Claude Monet", "high"),
               [cand("a", "met:1", 1.0), cand("b", "aic:2", 0.9)], r)
    assert d.tier is Tier.MEDIUM and d.record is None


def test_artist_only_agreement_is_medium():
    r = FakeRetriever(rec("met:1", "Haystacks (Effect of Snow and Sun)", "Claude Monet"))
    d = decide(NamerResult("Bridge over a Pond of Water Lilies", "Claude Monet", "high"), [cand("u", "met:1")], r)
    assert d.tier is Tier.MEDIUM


def test_disagreement_is_low():
    r = FakeRetriever(rec("met:1", "The Harvesters", "Pieter Bruegel the Elder"))
    d = decide(NamerResult("Wheat Field with Cypresses", "Vincent van Gogh", "high"), [cand("u", "met:1")], r)
    assert d.tier is Tier.LOW


def test_weak_sources_only_is_low_even_if_namer_is_sure():
    d = decide(NamerResult("Starry Night", "Van Gogh", "high"),
               [cand("https://shop.example", None, 5.0, W)], FakeRetriever())
    assert d.tier is Tier.LOW


def test_namer_self_confidence_does_not_rescue_missing_name():
    r = FakeRetriever(rec("met:1", "Untitled", "Unknown"))
    d = decide(NamerResult(None, None, "high"), [cand("u", "met:1")], r)
    assert d.tier is Tier.LOW


def test_namer_matching_lower_ranked_candidate_is_not_high():
    r = FakeRetriever(rec("met:1", "Cypresses", "Vincent van Gogh"), rec("met:2", "The Harvesters", "Pieter Bruegel the Elder"))
    d = decide(NamerResult("The Harvesters", "Bruegel", "high"),
               [cand("a", "met:1", 2.0), cand("b", "met:2", 1.0)], r)
    assert d.tier is Tier.MEDIUM


# ---- narration grounding ----

def test_facts_are_verbatim():
    r = rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh")
    r.facts["date"] = "1889"
    text = facts_text(r)
    assert "Wheat Field with Cypresses" in text and "Vincent van Gogh" in text and "1889" in text


def test_guard_flags_invented_year_and_name():
    r = rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh", "Painted at the asylum in Saint-Remy.")
    v = check_grounding("The sky churns above the field. He made it after leaving Arles in 1888.", r)
    assert "number not in record: 1888" in v
    assert "name not in record: Arles" in v


def test_guard_passes_grounded_text():
    r = rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh", "Painted at the asylum in Saint-Remy.")
    assert check_grounding("Look at how the cypress twists upward. The brushstrokes are thick and curved, "
                           "and the painting came from his time at the asylum.", r) == []


def test_guard_flags_long_verbatim_copy():
    src = "one two three four five six seven eight nine ten eleven twelve thirteen"
    r = rec("met:1", "T", "A", src)
    assert any("verbatim" in x for x in check_grounding("so " + src, r))


class FakeClient:
    """Stands in for anthropic.Anthropic: returns queued interpretations."""
    def __init__(self, drafts):
        self.drafts = list(drafts)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        body = json.dumps({"interpretation": self.drafts.pop(0), "missing": ""})
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=body)])


def test_narrator_retries_then_drops_ungrounded_interpretation():
    r = rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh")
    n = ClaudeNarrator(client=FakeClient(["Made in 1888 in Arles.", "Made in 1888 in Arles again."]))
    s = n.script(r, None)
    assert s.interpretation_dropped and s.text == facts_text(r)


def test_narrator_keeps_grounded_retry():
    r = rec("met:1", "Wheat Field with Cypresses", "Vincent van Gogh")
    n = ClaudeNarrator(client=FakeClient(["Made in Arles.", "Notice the curving strokes in the sky."]))
    s = n.script(r, None)
    assert not s.interpretation_dropped and "curving strokes" in s.text


# ---- pipeline ----

class Fixed:
    def __init__(self, value): self.value = value
    def name(self, photo): return self.value
    def search(self, photo): return self.value


def test_pipeline_refuses_cleanly_without_calling_narrator():
    class Boom:
        def script(self, *a, **k): raise AssertionError("narrator must not run on refusal")
    p = Pipeline(Fixed(NamerResult(None, None)), Fixed([]), FakeRetriever(), Boom())
    assert p.scan(b"").refused
