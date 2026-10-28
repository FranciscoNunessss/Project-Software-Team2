"""Score M1 against blinded human tier labels; this script is not an AI judge."""

import argparse
import json
import math
from pathlib import Path

TIERS = {"Small", "Medium", "Large"}
Z_95 = 1.959963984540054


def evaluate(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("the evaluation file must contain a JSON object")
    if not data.get("task_set_version"):
        raise ValueError("task_set_version is required")
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("tasks must be a non-empty list")

    reviewer_ids: set[str] | None = None
    task_ids = set()
    correct = 0
    for task in tasks:
        if not isinstance(task, dict):
            raise ValueError("each task result must be an object")
        task_id = task.get("task_id")
        recommendation = task.get("recommended_tier")
        reviewers = task.get("reviewers")
        if not task_id or recommendation not in TIERS or not isinstance(reviewers, list):
            raise ValueError("each task needs task_id, recommended_tier, and reviewer labels")
        if task_id in task_ids:
            raise ValueError(f"duplicate task_id: {task_id}")
        task_ids.add(task_id)
        if len(reviewers) not in {2, 3}:
            raise ValueError("each task must have labels from two or three human reviewers")

        current_ids = set()
        tier_votes = {tier: 0 for tier in TIERS}
        for reviewer in reviewers:
            if not isinstance(reviewer, dict):
                raise ValueError("each reviewer label must be an object")
            reviewer_id = reviewer.get("reviewer_id")
            acceptable = reviewer.get("acceptable_tiers")
            if not reviewer_id or not isinstance(acceptable, list):
                raise ValueError("each reviewer needs reviewer_id and acceptable_tiers")
            if not set(acceptable) <= TIERS:
                raise ValueError(f"invalid tier in human labels for task {task_id}")
            current_ids.add(reviewer_id)
            for tier in set(acceptable):
                tier_votes[tier] += 1
        if len(current_ids) != len(reviewers):
            raise ValueError(f"duplicate reviewer for task {task_id}")
        if reviewer_ids is None:
            reviewer_ids = current_ids
        elif current_ids != reviewer_ids:
            raise ValueError("the same reviewers must label every task")

        acceptable_by_majority = {
            tier for tier, votes in tier_votes.items() if votes > len(reviewers) / 2
        }
        correct += recommendation in acceptable_by_majority

    n = len(tasks)
    proportion = correct / n
    denominator = 1 + Z_95**2 / n
    centre = (proportion + Z_95**2 / (2 * n)) / denominator
    margin = (
        Z_95 * math.sqrt(proportion * (1 - proportion) / n + Z_95**2 / (4 * n**2)) / denominator
    )
    return {
        "task_set_version": data["task_set_version"],
        "metric": "M1 Tier correctness",
        "correct": correct,
        "total": n,
        "rate": proportion,
        "wilson_95_ci": [max(0, centre - margin), min(1, centre + margin)],
        "target_16_of_20_met": correct >= 16 if n == 20 else None,
        "target_status": "evaluated" if n == 20 else "requires exactly 20 tasks",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "labels", type=Path, help="JSON file with blinded human labels and system tiers"
    )
    args = parser.parse_args()
    try:
        result = evaluate(json.loads(args.labels.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"status": "invalid_evaluation_input", "error": str(error)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
