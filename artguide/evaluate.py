"""Run labelled photos end to end and count the spec's identification numbers.

cases.json: [{"photo": "path.jpg", "expected": "met:436535"}, {"photo": "x.jpg", "expected": null}]
expected null means the correct outcome is a refusal.
Factual-error rate (metric 4) is not automated: review each printed script
against the catalogue page, as spec section 9 requires.
"""
import json
import sys

from .models import Tier
from .pipeline import default_pipeline


def main(path: str) -> int:
    cases = json.load(open(path))
    pipe = default_pipeline(with_tts=False)
    counts = {"confident_correct": 0, "confident_wrong": 0, "correctly_refused": 0, "missed": 0}
    for case in cases:
        photo = open(case["photo"], "rb").read()
        result = pipe.scan(photo)
        got = result.decision.record.work_id if result.decision.tier is Tier.HIGH else None
        exp = case.get("expected")
        if got and got == exp:
            key = "confident_correct"
        elif got:
            key = "confident_wrong"
        elif exp is None:
            key = "correctly_refused"
        else:
            key = "missed"  # refused a work it should know. Acceptable, but tracked.
        counts[key] += 1
        print(f"{case['photo']}: {key} (tier={result.decision.tier.value}, got={got}, expected={exp})")
        if result.script:
            print("  script: " + result.script.text.replace("\n", " "))
            if result.script.guard_violations:
                print("  guard: " + "; ".join(result.script.guard_violations))
    n = len(cases)
    print(json.dumps(counts))
    if n:
        # With zero confident-wrong in n trials, the 95% upper bound is about 3/n.
        print(f"confident-wrong {counts['confident_wrong']}/{n}. If 0, true rate could still be up to ~{3 / n:.0%}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
