# Art guide, Phase 0

Vertical slice from the build spec: photo in, cross-checked identification,
canonical record, grounded script, MP3 out. Python backend and CLI only. No phone app yet.

## Setup

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...        # namer and narrator
export GOOGLE_VISION_API_KEY=...    # reverse image search (WEB_DETECTION), also used for TTS
```

Network must allow: `api.anthropic.com`, `vision.googleapis.com`,
`texttospeech.googleapis.com`, `collectionapi.metmuseum.org`, `api.artic.edu`.

## Run

```bash
python -m artguide.cli photo.jpg --out guide.mp3
python -m artguide.cli photo.jpg --no-tts      # text only
uvicorn artguide.server:app                    # POST /scan with form field "photo"
python -m pytest -q                            # logic tests, no network
```

## Phase 0 acceptance

Make `cases.json` with one known Met or AIC work photographed in a gallery, plus
one photo it should refuse (an unlisted work, or a museum not yet supported):

```json
[{"photo": "known.jpg", "expected": "met:436535"}, {"photo": "unknown.jpg", "expected": null}]
```

```bash
python -m artguide.evaluate cases.json
```

Then check the printed script by hand against the catalogue page. The grounding
guard is a heuristic and does not replace that check.

## How it maps to the spec

| Spec | Code |
|---|---|
| Multimodal namer (one voter) | `identify.ClaudeNamer`, sees only the photo |
| Reverse image search (other voter) | `identify.GoogleVisionReverseSearch` |
| source_type classification | `sources.classify` |
| Agreement gate | `scorer.decide`. Phase 0 narrates on HIGH only |
| Canonical record | `retrieve.MetRetriever`, `retrieve.AICRetriever` |
| Facts verbatim | `narrate.facts_text`, built in code, not by the model |
| Interpretation | `narrate.ClaudeNarrator`, checked by `check_grounding`, retried once, dropped if still failing |
| TTS | `tts.GoogleTTS`, placeholder until chosen by ear |

## Known limits

- Coverage is the Met and the Art Institute of Chicago. Other museum URLs count as
  trusted evidence but cannot be narrated, so they refuse.
- The Met API has no descriptive text, so Met interpretations describe only what is visible.
- Title matching is fuzzy token overlap (`scorer.title_matches`). It is a tuning knob, not calibrated.
- The guard misses names at the start of a sentence and unsupported claims in plain words.
