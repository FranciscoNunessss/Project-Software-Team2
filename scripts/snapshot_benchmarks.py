"""Save a snapshot of Artificial Analysis benchmark results (ADR-014, step 2).

Needs an Artificial Analysis API key in ADAPTAI_AA_API_KEY (environment or .env). The key is
never printed or written. The Pro endpoint (per-benchmark scores) is tried first; with a free
key the free endpoint gives the indices only, and the mapping falls back to them.

    uv run python scripts/snapshot_benchmarks.py

Writes backend/data/catalogue/sources/aa-<date>.json: per model, its slug, name, creator,
release date, prices and numeric evaluation values. Attribution: data from Artificial
Analysis, https://artificialanalysis.ai/.
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.classification import snapshot_entry  # noqa: E402

BASE = "https://artificialanalysis.ai/api/v2/language/models"


def api_key() -> str:
    key = os.environ.get("ADAPTAI_AA_API_KEY", "")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("ADAPTAI_AA_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    return key


def fetch(client: httpx.Client, url: str) -> tuple[list[dict], dict]:
    models, first, page = [], {}, 1
    while True:
        response = client.get(url, params={"page": page})
        response.raise_for_status()
        body = response.json()
        first = first or body
        models.extend(item for item in body.get("data", []) if isinstance(item, dict))
        pagination = body.get("pagination") or {}
        if not pagination.get("has_more"):
            return models, first
        page += 1


def main() -> int:
    key = api_key()
    if not key:
        print("Set ADAPTAI_AA_API_KEY (Artificial Analysis API key) first.", file=sys.stderr)
        return 2
    with httpx.Client(timeout=60, headers={"x-api-key": key}) as client:
        try:
            raw, body = fetch(client, BASE)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code not in {401, 402, 403}:
                print(f"Artificial Analysis answered {exc.response.status_code}", file=sys.stderr)
                return 1
            raw, body = fetch(client, f"{BASE}/free")
    today = date.today().isoformat()
    name = f"aa-{today}.json"
    data = {
        "source": "Artificial Analysis",
        "source_url": "https://artificialanalysis.ai/",
        "attribution": "Benchmark data from Artificial Analysis (https://artificialanalysis.ai/)",
        "tier": body.get("tier"),
        "intelligence_index_version": body.get("intelligence_index_version"),
        "observed_on": today,
        "file": name,
        "models": [entry for item in raw if (entry := snapshot_entry(item))],
    }
    out = ROOT / "backend/data/catalogue/sources" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    metrics = sorted({metric for entry in data["models"] for metric in entry["metrics"]})
    print(f"wrote {out.relative_to(ROOT)}: {len(data['models'])} models, tier {data['tier']}")
    print("metrics:", ", ".join(metrics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
