"""Save a snapshot of the public LMArena leaderboards (ADR-014 A10, layer 1).

Public dataset lmarena-ai/leaderboard-dataset on Hugging Face: no account, no key, licence
CC BY 4.0 (attribution required: every level taken from it names LMArena). Run by the
"Catalogue sources" workflow (the sandbox cannot reach Hugging Face):

    uv run --with pyarrow==17.0.0 python scripts/snapshot_lmarena.py

Writes backend/data/catalogue/sources/lmarena-<publish date>.json with, per model name and
per category we map (docs/plan-model-coverage.md), the rating, its interval and the votes.
Fails, writing nothing, if the dataset is gated, the licence changed or a column is missing.
"""

import io
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

DATASET = "lmarena-ai/leaderboard-dataset"
LICENCE = "cc-by-4.0"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "backend/data/catalogue/sources"
# subset -> (categories kept, rating column, lower, upper, count column)
SUBSETS = {
    "text_style_control": (
        ["overall", "math", "hard_prompts", "expert", "longer_query", "instruction_following"],
        "rating",
        "rating_lower",
        "rating_upper",
        "vote_count",
    ),
    "text_factuality": (["overall"], "rating", "rating_lower", "rating_upper", "vote_count"),
    "agent": (["overall"], "score", "score_ci_lower", "score_ci_upper", "session_count"),
}


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "adaptai-catalogue-sources"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def carry_over(snapshot: dict, keep_days: int = 180) -> None:
    """A model that left the leaderboard keeps its last entries for 180 days, with their date."""
    previous = sorted(
        path
        for path in OUT_DIR.glob("lmarena-2*.json")
        if path.stem.removeprefix("lmarena-") < snapshot["observed_on"]
    )
    if not previous:
        return
    old = json.loads(previous[-1].read_text(encoding="utf-8"))
    today = date.fromisoformat(snapshot["observed_on"])
    for subset, models in old["subsets"].items():
        current = snapshot["subsets"].setdefault(subset, {})
        for name, categories in models.items():
            if name in current:
                continue
            seen = next(iter(categories.values())).get("seen_on") or old["publish_dates"][subset]
            if (today - date.fromisoformat(seen)).days <= keep_days:
                current[name] = {
                    category: {**entry, "seen_on": seen} for category, entry in categories.items()
                }
        snapshot["subsets"][subset] = dict(sorted(current.items()))


def main() -> int:
    import pyarrow.parquet as pq  # only the workflow installs it

    info = json.loads(get(f"https://huggingface.co/api/datasets/{DATASET}"))
    licence = (info.get("cardData") or {}).get("license")
    if info.get("gated") or info.get("private") or licence != LICENCE:
        print(f"Refused: gated={info.get('gated')} licence={licence}", file=sys.stderr)
        return 1
    listing = json.loads(get(f"https://datasets-server.huggingface.co/parquet?dataset={DATASET}"))
    urls: dict[str, list[str]] = {}
    for item in listing.get("parquet_files", []):
        if item["split"] == "latest":
            urls.setdefault(item["config"], []).append(item["url"])
    snapshot = {
        "source": f"LMArena leaderboard, https://huggingface.co/datasets/{DATASET}",
        "licence": "CC BY 4.0",
        "attribution": "LMArena (lmarena.ai), CC BY 4.0",
        "subsets": {},
        "publish_dates": {},
    }
    for subset, (categories, rating, lower, upper, count) in SUBSETS.items():
        if subset not in urls:
            print(f"Refused: subset {subset} is missing", file=sys.stderr)
            return 1
        rows = []
        for url in urls[subset]:
            rows += pq.read_table(io.BytesIO(get(url))).to_pylist()
        needed = {"model_name", "category", "leaderboard_publish_date", rating, lower, upper, count}
        if not rows or needed - set(rows[0]):
            print(f"Refused: {subset} lacks {sorted(needed - set(rows[0] if rows else []))}")
            return 1
        models: dict[str, dict] = {}
        for row in rows:
            if row["category"] not in categories or row[rating] is None:
                continue
            models.setdefault(row["model_name"], {})[row["category"]] = {
                "rating": round(float(row[rating]), 4),
                "lower": round(float(row[lower]), 4),
                "upper": round(float(row[upper]), 4),
                "votes": int(row[count] or 0),
            }
        snapshot["subsets"][subset] = dict(sorted(models.items()))
        snapshot["publish_dates"][subset] = max(str(r["leaderboard_publish_date"]) for r in rows)
    snapshot["observed_on"] = snapshot["publish_dates"]["text_style_control"]
    carry_over(snapshot)
    out = OUT_DIR / f"lmarena-{snapshot['observed_on']}.json"
    out.write_text(json.dumps(snapshot, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"Wrote {out.relative_to(ROOT)}: "
        + ", ".join(f"{name} {len(models)} models" for name, models in snapshot["subsets"].items())
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
