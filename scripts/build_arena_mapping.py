"""Freeze the LMArena thresholds, or point the mapping to a newer snapshot (ADR-014 A10).

    uv run python scripts/build_arena_mapping.py --new arena-mapping-1 \
        --snapshot sources/lmarena-2026-11-06.json --population sources/openrouter-2026-11-08.json
    uv run python scripts/build_arena_mapping.py --snapshot sources/lmarena-2026-11-13.json

--new computes, per category, the 34th and 67th percentile of the ratings of the arena models
that are on OpenRouter (the models users choose from; all 419 would include 2023 models and
inflate every level) and writes backend/data/catalogue/<version>.json. It refuses to overwrite:
new thresholds need a new version (as benchmark-mapping, A3). Without --new it only moves the
active mapping to a newer snapshot; the thresholds stay frozen.
"""

import argparse
import json
import sys
from pathlib import Path
from statistics import quantiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.arena import MAPPING_FILE, merge_variants, normalise  # noqa: E402
from app.catalogue import CATALOGUE_DIR  # noqa: E402

RULES = {
    "default": {"min_votes": 300, "max_interval": 60},
    "agent": {"min_votes": 100, "max_interval": None},
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--new", help="version of a new mapping, e.g. arena-mapping-1")
    parser.add_argument("--snapshot", required=True, help="path relative to the catalogue dir")
    parser.add_argument("--population", help="OpenRouter facts snapshot (with --new)")
    args = parser.parse_args()
    snapshot = json.loads((CATALOGUE_DIR / args.snapshot).read_text(encoding="utf-8"))
    if not args.new:
        mapping = json.loads(MAPPING_FILE.read_text(encoding="utf-8"))
        mapping["snapshot"] = args.snapshot
        mapping["observed_on"] = snapshot["observed_on"]
        MAPPING_FILE.write_text(json.dumps(mapping, indent=1) + "\n", encoding="utf-8")
        print(f"{mapping['version']} now reads {args.snapshot}; thresholds unchanged")
        return 0
    out = CATALOGUE_DIR / f"{args.new}.json"
    if out.exists():
        print(f"{out.name} exists: new thresholds need a new version", file=sys.stderr)
        return 1
    router = json.loads((CATALOGUE_DIR / args.population).read_text(encoding="utf-8"))
    on_router = {normalise(model["id"]) for model in router["models"]}
    merged = merge_variants(snapshot, RULES)
    thresholds, sizes = {}, {}
    slots = sorted({slot for entries in merged.values() for slot in entries})
    for slot in slots:
        values = sorted(
            e[slot]["rating"] for k, e in merged.items() if slot in e and k in on_router
        )
        if len(values) < 10:
            values = sorted(e[slot]["rating"] for e in merged.values() if slot in e)
        cuts = quantiles(values, n=100, method="inclusive")
        thresholds[slot] = {"level_2_from": round(cuts[33], 4), "level_3_from": round(cuts[66], 4)}
        sizes[slot] = len(values)
    mapping = {
        "version": args.new,
        "description": "Frozen LMArena thresholds (ADR-014 A10). Levels: 3 from level_3_from, "
        "2 from level_2_from, else 1. Population: arena models on OpenRouter in the population "
        "snapshot. See docs/plan-model-coverage.md.",
        "snapshot": args.snapshot,
        "observed_on": snapshot["observed_on"],
        "population": args.population,
        "percentiles": [34, 67],
        "rules": RULES,
        "thresholds": thresholds,
        "population_sizes": sizes,
    }
    out.write_text(json.dumps(mapping, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {out.name}: " + ", ".join(f"{s} n={n}" for s, n in sizes.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
