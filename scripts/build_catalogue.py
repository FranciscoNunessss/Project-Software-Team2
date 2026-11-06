"""Build a new catalogue version from a batch of models (ADR-014, steps 1 and 2).

    uv run python scripts/build_catalogue.py --batch backend/data/catalogue/batch-1.json \
        --facts backend/data/catalogue/sources/openrouter-<date>.json \
        --snapshot backend/data/catalogue/sources/aa-<date>.json \
        --mapping benchmark-mapping-1 --version catalogue-2.1 [--activate]

- The benchmark mapping is created from the snapshot the first time (thresholds frozen at the
  34th and 67th percentile) and never changed afterwards: a new one needs a new version.
- Every card gets provider facts from OpenRouter and provisional levels from the mapping.
- The demo cards of the active catalogue are kept. The new file is registered with its
  sha256 in versions.json; ACTIVE changes only with --activate, after review.
"""

import argparse
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.catalogue import CATALOGUE_DIR, Catalogue, load_catalogue  # noqa: E402
from app.classification import build_mapping, facts_from_openrouter, rate  # noqa: E402


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def mapping_for(version: str, snapshot: dict) -> dict:
    path = CATALOGUE_DIR / "mappings" / f"{version}.json"
    if path.exists():
        return read(path)
    mapping = build_mapping(snapshot, version, snapshot["observed_on"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(mapping, indent=2) + "\n", encoding="utf-8")
    print(f"created {path.relative_to(ROOT)} (frozen thresholds)")
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--batch", type=Path, required=True)
    parser.add_argument("--facts", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--mapping", default="benchmark-mapping-1")
    parser.add_argument("--version", required=True)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()

    facts, snapshot = read(args.facts), read(args.snapshot)
    mapping = mapping_for(args.mapping, snapshot)
    router = {model["id"]: model for model in facts["models"]}
    benchmarks = {entry["slug"]: entry for entry in snapshot["models"]}
    current = load_catalogue()
    cards = [card.model_dump() for card in current.cards if card.illustrative]
    problems = []
    for item in read(args.batch)["models"]:
        model = router.get(item["openrouter_id"])
        if model is None:
            problems.append(f"{item['id']}: {item['openrouter_id']} not in the OpenRouter facts")
            continue
        card_facts = facts_from_openrouter(
            {**model, "structured_output": model["structured_output"]}, facts["observed_on"]
        )
        entry = benchmarks.get(item["aa_slug"]) if item.get("aa_slug") else None
        if item.get("aa_slug") and entry is None:
            problems.append(f"{item['id']}: {item['aa_slug']} not in the benchmark snapshot")
        cards.append(
            {
                "id": item["id"],
                "family": item["family"],
                "name": item["name"],
                "aliases": item["aliases"],
                "facts": card_facts,
                "capabilities": rate(entry, mapping, tool_calling=card_facts["tool_calling"]),
            }
        )
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    catalogue = Catalogue.model_validate(
        {
            "version": args.version,
            "rubric_scale": current.rubric_scale,
            "benchmark_mapping": mapping["version"],
            "observed_on": date.today().isoformat(),
            "source": (
                f"Facts: {facts['source']} ({facts['observed_on']}). Levels: "
                f"{mapping['version']} over {mapping['source']} ({mapping['observed_on']}), "
                "provisional until calibrated (docs/model-classification.md)."
            ),
            "cost_bands": current.cost_bands.model_dump(),
            "cards": cards,
        }
    )
    path = CATALOGUE_DIR / "versions" / f"{args.version}.json"
    if path.exists():
        print(f"{path.name} exists: versions are immutable, choose a new version", file=sys.stderr)
        return 1
    data = (json.dumps(catalogue.model_dump(), indent=2) + "\n").encode()
    path.write_bytes(data)
    registry_path = CATALOGUE_DIR / "versions.json"
    registry = read(registry_path)
    registry[args.version] = hashlib.sha256(data).hexdigest()
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    if args.activate:
        (CATALOGUE_DIR / "ACTIVE").write_text(args.version + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}{' (active)' if args.activate else ''}")
    for card in catalogue.cards:
        levels = " ".join(
            f"{name[:4]}={rating.level or '-'}" for name, rating in card.capabilities.items()
        )
        print(f"  {card.id:28} {levels}  price={card.blended_price}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
