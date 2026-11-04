"""Deterministic grid of synthetic profiles for the policy regression test.

The golden file records what the e886924 policy returned for every profile in this grid.
Regenerate it only when a policy change is intended and recorded in an ADR:

    cd backend && uv run python tests/policy_grid.py --write
"""

import gzip
import itertools
import json
import sys
from pathlib import Path

GOLDEN = Path(__file__).parent / "fixtures" / "policy_baseline.json.gz"
SCORED = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")
CONFIDENCES = ("low", "medium", "high")
MODALITIES = (None, ["text"], ["text", "image"])


def grid():
    combos = itertools.product((None, 1, 2, 3), repeat=len(SCORED))
    for index, (scheme, scores) in enumerate(itertools.product(("mixed", "known"), combos)):
        data = {}
        for position, (name, score) in enumerate(zip(SCORED, scores, strict=True)):
            data[name] = {
                "score": score,
                "confidence": (
                    "undetermined"
                    if score is None
                    else CONFIDENCES[(index + position) % len(CONFIDENCES)]
                    if scheme == "mixed"
                    else ("medium", "high")[(index + position) % 2]
                ),
                "evidence": "Synthetic grid evidence",
            }
        required = MODALITIES[index % len(MODALITIES)]
        data["modality"] = {
            "required": required,
            "confidence": "undetermined" if required is None else "medium",
            "evidence": "Synthetic grid modality",
        }
        data["explanation"] = "Synthetic grid profile"
        yield f"{index:04d}", data


def outcome(data):
    from app.assessment import assessment_advice, capacity_target, required_capabilities
    from app.models import Profile
    from app.workflow import rank

    profile = Profile.model_validate(data)
    questions, guidance, provisional = assessment_advice(profile)
    return {
        "target": capacity_target(profile),
        "ranking": [item.id for item in rank(profile, required_capabilities(profile, ["text"]))],
        "questions": questions,
        "guidance": guidance,
        "provisional": provisional,
    }


def current():
    return {key: outcome(data) for key, data in grid()}


def load_golden():
    with gzip.open(GOLDEN, "rt", encoding="utf-8") as handle:
        return json.load(handle)


if __name__ == "__main__" and "--write" in sys.argv:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    GOLDEN.parent.mkdir(exist_ok=True)
    with gzip.GzipFile(GOLDEN, "wb", mtime=0) as handle:
        handle.write(json.dumps(current(), sort_keys=True, separators=(",", ":")).encode())
    print(f"wrote {GOLDEN}")
