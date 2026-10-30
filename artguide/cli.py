"""python -m artguide.cli photo.jpg [--out guide.mp3] [--no-tts]"""
import argparse
import json
import sys

from .pipeline import REFUSAL_TEXT, default_pipeline


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("photo")
    p.add_argument("--out", default="guide.mp3")
    p.add_argument("--no-tts", action="store_true")
    args = p.parse_args(argv)

    with open(args.photo, "rb") as f:
        photo = f.read()
    result = default_pipeline(with_tts=not args.no_tts).scan(photo, None if args.no_tts else args.out)

    d = result.decision
    print(f"tier: {d.tier.value}  reason: {d.reason}")
    print(json.dumps(d.evidence, indent=2, default=str), file=sys.stderr)
    if result.refused:
        print(REFUSAL_TEXT)
    else:
        print("\n" + result.script.text + "\n")
        print("source: " + "; ".join(result.script.citations))
        if result.script.interpretation_dropped:
            print("note: interpretation dropped by grounding guard: " + "; ".join(result.script.guard_violations))
    if result.audio_path:
        print(f"audio: {result.audio_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
