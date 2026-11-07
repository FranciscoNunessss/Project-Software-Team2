"""Turn measurement runs into a new catalogue version (ADR-014, measure-suite-1).

    uv run python scripts/apply_measurements.py backend/eval/measure/runs/*.json \
        --version catalogue-2.2 [--activate]

Each measured card gets status "measured" levels with the pass rates as source. A run with
more than 10% failed calls (errors, not wrong answers) is refused: measure it again. Cards
without a run keep their levels. The version is registered with its sha256; ACTIVE changes
only with --activate, after the team reviewed the printed table.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.catalogue import CATALOGUE_DIR, Catalogue, load_catalogue  # noqa: E402

MAX_ERRORS = 6


def ratings(run: dict, path: Path) -> dict:
    result = {}
    for name, item in run["levels"].items():
        rates = ", ".join(
            f"L{level} {rate:.0%}" for level, rate in item["pass_rates"].items() if rate is not None
        )
        floor = "" if item["level"] else " (below the level 1 threshold, shown as 1)"
        result[name] = {
            "level": item["level"] or 1,
            "status": "measured",
            "source": f"{run['suite']} seed {run['seed']} via {run['provider']} {run['model']}: "
            f"{rates}{floor} ({path.name})",
            "observed_on": run["measured_on"],
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("runs", nargs="+", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    current = load_catalogue()
    data = current.model_dump()
    by_id = {card["id"]: card for card in data["cards"]}
    for path in args.runs:
        run = json.loads(path.read_text(encoding="utf-8"))
        if run["errors"] > MAX_ERRORS:
            print(f"{path.name}: {run['errors']} failed calls, measure again", file=sys.stderr)
            return 1
        if run["card"] not in by_id:
            print(f"{path.name}: card {run['card']} not in {current.version}", file=sys.stderr)
            return 1
        by_id[run["card"]]["capabilities"] = ratings(run, path)
    data["version"] = args.version
    data["source"] = (
        current.source + " Measured levels: measure-suite-1 (backend/eval/measure/runs)."
    )
    catalogue = Catalogue.model_validate(data)
    path = CATALOGUE_DIR / "versions" / f"{args.version}.json"
    if path.exists():
        print(f"{path.name} exists: versions are immutable", file=sys.stderr)
        return 1
    raw = (json.dumps(catalogue.model_dump(), indent=2) + "\n").encode()
    path.write_bytes(raw)
    registry_path = CATALOGUE_DIR / "versions.json"
    registry = json.loads(registry_path.read_text())
    registry[args.version] = hashlib.sha256(raw).hexdigest()
    registry_path.write_text(json.dumps(registry, indent=2) + "\n")
    if args.activate:
        (CATALOGUE_DIR / "ACTIVE").write_text(args.version + "\n")
    print(f"wrote {path.relative_to(ROOT)}{' (active)' if args.activate else ''}")
    print(f"{'card':22} {'reason':>6} {'cont':>5} {'dom':>4} {'rel':>4} {'tool':>5}  status")
    for card in catalogue.cards:
        levels = [card.capabilities[name].level or "-" for name in card.capabilities]
        status = {rating.status for rating in card.capabilities.values()}
        print(
            f"{card.id:22} "
            + " ".join(f"{str(level):>5}" for level in levels)
            + f"  {','.join(sorted(status))}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
