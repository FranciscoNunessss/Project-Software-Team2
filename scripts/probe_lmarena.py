"""Checks, before we build on it, what the LMArena leaderboard dataset really offers (ADR-014 A10).

Run by the "LMArena probe" workflow (the sandbox cannot reach Hugging Face). Writes
backend/data/catalogue/sources/lmarena-probe.json with: access (gated, private, license),
for each subset of interest the publish dates, categories, models and vote counts of the
latest split, and how many models of our OpenRouter facts snapshot have an exact name match.
No key, no account: if the dataset needs either, this script fails and says so.
"""

import collections
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import pyarrow.parquet as pq

DATASET = "lmarena-ai/leaderboard-dataset"
SUBSETS = ["text", "text_style_control", "text_factuality", "agent", "agent_tool_hallucination"]
ROOT = Path(__file__).resolve().parents[1]
OPENROUTER = sorted((ROOT / "backend/data/catalogue/sources").glob("openrouter-*.json"))[-1]
OUT = ROOT / "backend/data/catalogue/sources/lmarena-probe.json"


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "adaptai-catalogue-probe"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def median(values: list):
    values = sorted(value for value in values if value is not None)
    return round(values[len(values) // 2], 1) if values else None


def normalise(name: str) -> str:
    """Comparison key: no vendor, :variant, bracket, date or -it suffix; - for . _ space."""
    name = re.sub(r"\s*\(.*?\)", "", name)  # "(High)", "(20250514)", "(Thinking 16K, ...)"
    name = name.lower().lstrip("~").split("/")[-1].split(":")[0]
    name = re.sub(r"[._ ]+", "-", name)
    name = re.sub(r"-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$", "", name)
    name = re.sub(r"-(preview|latest|exp|instruct|it|chat)$", "", name)
    return name


def main() -> None:
    info = json.loads(get(f"https://huggingface.co/api/datasets/{DATASET}"))
    report: dict = {
        "dataset": DATASET,
        "access": {
            "gated": info.get("gated"),
            "private": info.get("private"),
            "disabled": info.get("disabled"),
            "license": (info.get("cardData") or {}).get("license"),
            "last_modified": info.get("lastModified"),
            "downloaded_without_account": True,
        },
        "subsets": {},
    }
    listing = json.loads(get(f"https://datasets-server.huggingface.co/parquet?dataset={DATASET}"))
    files = collections.defaultdict(list)
    for item in listing.get("parquet_files", []):
        files[(item["config"], item["split"])].append(item["url"])

    router = json.loads(OPENROUTER.read_text())["models"]
    router_keys = collections.defaultdict(list)
    for model in router:
        router_keys[normalise(model["id"])].append(model["id"])

    for subset in SUBSETS:
        urls = files.get((subset, "latest"))
        if not urls:
            report["subsets"][subset] = {"found": False}
            continue
        rows = []
        size = 0
        for url in urls:
            data = get(url)
            size += len(data)
            rows += pq.read_table(io.BytesIO(data)).to_pylist()
        by_category = collections.defaultdict(list)
        for row in rows:
            by_category[row.get("category")].append(row)
        overall = by_category.get("overall") or rows
        names = sorted({row["model_name"] for row in overall})
        matched = {
            name: router_keys[normalise(name)] for name in names if normalise(name) in router_keys
        }
        report["subsets"][subset] = {
            "found": True,
            "download_bytes": size,
            "rows": len(rows),
            "columns": sorted(rows[0]) if rows else [],
            "first_row": rows[0] if rows else None,
            "publish_dates": sorted({str(row.get("leaderboard_publish_date")) for row in rows}),
            "categories": {
                name: {
                    "models": len({row["model_name"] for row in items}),
                    "median_votes": median([row.get("vote_count") for row in items]),
                    "median_ci_width": median(
                        [
                            row["rating_upper"] - row["rating_lower"]
                            if row.get("rating_upper") is not None
                            and row.get("rating_lower") is not None
                            else None
                            for row in items
                        ]
                    ),
                }
                for name, items in sorted(by_category.items())
            },
            "models_overall": len(names),
            "openrouter_models_in_snapshot": len(router),
            "openrouter_exact_matches": sum(len(ids) for ids in matched.values()),
            "openrouter_ids_matched": len({i for ids in matched.values() for i in ids}),
            "openrouter_free_ids_matched": len(
                {i for ids in matched.values() for i in ids if i.endswith(":free")}
            ),
            "openrouter_free_ids_total": sum(1 for m in router if m["id"].endswith(":free")),
            "openrouter_ids_unmatched": sorted(
                m["id"] for m in router if normalise(m["id"]) not in {normalise(n) for n in names}
            ),
            "examples_matched": dict(list(matched.items())[:40]),
            "examples_unmatched": [name for name in names if name not in matched][:60],
            "families": {
                family: sorted(name for name in names if family in name.lower())[:15]
                for family in ["gpt-oss", "gemma", "llama", "qwen", "mistral", "deepseek"]
            },
        }
    OUT.write_text(json.dumps(report, indent=1, sort_keys=True, default=str) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "subsets"}, indent=1))
    for subset, item in report["subsets"].items():
        print(
            subset,
            {
                k: item.get(k)
                for k in [
                    "found",
                    "rows",
                    "publish_dates",
                    "models_overall",
                    "openrouter_exact_matches",
                    "openrouter_ids_matched",
                    "openrouter_free_ids_matched",
                    "openrouter_free_ids_total",
                ]
            },
        )
        print("  columns:", item.get("columns"))
        print("  categories:", list(item.get("categories", {})))
    if report["access"]["gated"] not in (False, None):
        sys.exit("The dataset is gated: it needs an account and accepting terms")


if __name__ == "__main__":
    main()
