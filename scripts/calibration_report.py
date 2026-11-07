"""Calibration report from task feedback (ADR-014 section 6.6). Proposes, never changes.

    uv run python scripts/calibration_report.py              # the database in .env
    uv run python scripts/calibration_report.py --json

Reads task_outcomes (choices, counts and levels only; no text) and prints, per model,
capability and need level, the proposals of backend/app/calibration.py. The team decides and
publishes a new catalogue version with scripts/build_catalogue.py or by hand.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.calibration import MIN_COMPLETENESS, MIN_TASKS, proposals  # noqa: E402
from app.providers import Settings  # noqa: E402
from app.storage import Storage  # noqa: E402

TEXT = {
    "lower": "lower this capability (covered the level but solved under 50%)",
    "raise_or_calibrate": "raise it or run the calibration set (fell short but solved over 80%)",
    "review": "review the level or the output limit (many answers per task)",
    "coach_not_catalogue": "no catalogue change: failures come from incomplete descriptions",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    with store.connect() as db:
        rows = [dict(row) for row in db.execute("SELECT * FROM task_outcomes")]
        disagreements = db.execute(
            "SELECT e.provider,e.model,d.capability,count(*) AS users "
            "FROM evaluation_disagreements d JOIN model_evaluations e ON e.id=d.evaluation_id "
            "GROUP BY e.provider,e.model,d.capability ORDER BY users DESC"
        ).fetchall()
    found = proposals(rows)
    if args.json:
        print(json.dumps(found, indent=2))
        return 0
    answered = sum(row["outcome"] != "skipped" for row in rows)
    print(f"# Calibration report\n\n{answered} answered tasks, {len(rows) - answered} skipped.")
    print(
        f"Rules: at least {MIN_TASKS} tasks per model, capability and level, "
        f"completeness >= {MIN_COMPLETENESS}.\n"
    )
    if disagreements:
        print("## Users who disagree with a level\n\n| Model | Capability | Users |\n|---|---|---|")
        for row in disagreements:
            print(f"| {row['provider']} {row['model']} | {row['capability']} | {row['users']} |")
        print()
    if not found:
        print("No proposal: not enough answered tasks yet, or nothing outside the thresholds.")
        return 0
    print("| Model | Capability | Level | Tasks | Proposal |\n|---|---|---|---|---|")
    for item in found:
        print(
            f"| {item['model']} | {item.get('capability', '-')} | {item.get('level', '-')} "
            f"| {item['tasks']} | {TEXT[item['proposal']]} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
