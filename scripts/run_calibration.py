"""Run the calibration set with one model and score the reviews (ADR-014 section 7.4).

    # 1. Answers and a review sheet (may consume provider quota):
    uv run python scripts/run_calibration.py run --provider groq --model openai/gpt-oss-120b
    # 2. Two reviewers fill in "reviewer_1" and "reviewer_2" with pass or fail.
    # 3. Proposed calibrated levels (both reviewers must pass a task):
    uv run python scripts/run_calibration.py score backend/eval/calibration/runs/<file>.csv

The set is synthetic, not user data. Answers stay in backend/eval/calibration/runs/.
"""

import argparse
import asyncio
import csv
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.calibration import levels_from_reviews  # noqa: E402
from app.providers import Settings, chat_model  # noqa: E402

SET = ROOT / "backend/eval/calibration/calibration-set-1.json"
RUNS = ROOT / "backend/eval/calibration/runs"
FIELDS = ["id", "capability", "level", "task", "pass", "answer", "reviewer_1", "reviewer_2"]


async def answer(llm, task: str) -> str:
    reply = await llm.ainvoke([("human", task)])
    content = reply.content
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content.strip()


def run(args) -> int:
    settings = Settings()
    field = f"{args.provider}_model"
    settings = settings.model_copy(update={field: args.model})
    llm = chat_model(args.provider, settings, 1024)
    tasks = json.loads(SET.read_text(encoding="utf-8"))["tasks"]
    RUNS.mkdir(parents=True, exist_ok=True)
    out = RUNS / f"{args.model.replace('/', '_')}-{date.today().isoformat()}.csv"
    with out.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        for item in tasks:
            try:
                text = asyncio.run(answer(llm, item["task"]))
            except Exception as exc:  # noqa: BLE001 - recorded for the reviewers
                text = f"[error: {type(exc).__name__}]"
            writer.writerow({**{key: item[key] for key in FIELDS[:5]}, "answer": text})
            print(f"{item['id']}: {len(text)} characters")
    print(f"wrote {out.relative_to(ROOT)}: give it to two reviewers")
    return 0


def score(args) -> int:
    with open(args.sheet, newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    missing = [row["id"] for row in rows if not row["reviewer_1"] or not row["reviewer_2"]]
    if missing:
        print("Not reviewed by both reviewers yet: " + ", ".join(missing), file=sys.stderr)
        return 1
    reviews = [
        {
            "capability": row["capability"],
            "level": row["level"],
            "passed": row["reviewer_1"].strip().lower() == "pass"
            and row["reviewer_2"].strip().lower() == "pass",
        }
        for row in rows
    ]
    for capability, reached in levels_from_reviews(reviews).items():
        print(f"{capability:12} calibrated level: {reached if reached else 'below 1'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("--provider", required=True)
    runner.add_argument("--model", required=True)
    scorer = sub.add_parser("score")
    scorer.add_argument("sheet")
    args = parser.parse_args()
    return run(args) if args.command == "run" else score(args)


if __name__ == "__main__":
    raise SystemExit(main())
