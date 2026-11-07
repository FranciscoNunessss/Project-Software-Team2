"""Save the facts of OpenRouter's public model catalogue (ADR-014, step 1 of the classification).

No API key: the catalogue is public. The file keeps, per model, what a capability card needs
(context window, modalities, tools, structured output, prices), with the date it was read.

    uv run python scripts/import_openrouter_facts.py
    uv run python scripts/import_openrouter_facts.py --search gemma --search gpt-oss

Writes backend/data/catalogue/sources/openrouter-<date>.json unless --search is given, in
which case it only prints the matching ids.
"""

import argparse
import asyncio
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.openrouter import BASE_URL, build_catalogue, fetch_models  # noqa: E402

KEEP = (
    "id",
    "name",
    "context_length",
    "price_input_per_million",
    "price_output_per_million",
    "free",
    "input_modalities",
    "output_modalities",
    "supported_parameters",
    "top_provider",
    "structured_output",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--search", action="append", default=[], help="print ids containing this")
    parser.add_argument("--out", type=Path, help="output file (default: sources/openrouter-<date>)")
    args = parser.parse_args()
    models = build_catalogue(asyncio.run(fetch_models(60)))
    if args.search:
        for model in models:
            if any(term.lower() in model["id"].lower() for term in args.search):
                price = model["price_input_per_million"], model["price_output_per_million"]
                print(f"{model['id']:60} ctx={model['context_length']} price={price}")
        return 0
    today = date.today().isoformat()
    out = args.out or ROOT / f"backend/data/catalogue/sources/openrouter-{today}.json"
    data = {
        "source": "OpenRouter public model catalogue",
        "source_url": f"{BASE_URL}/models",
        "observed_on": today,
        "models": [{key: model[key] for key in KEEP} for model in models],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({len(models)} models)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
