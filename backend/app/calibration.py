"""Calibration of the catalogue from task feedback and from the calibration set (ADR-014).

Nothing here changes the catalogue: it proposes. The team reviews the proposals and
publishes a new catalogue version (decision D11).

Feedback report (``proposals``): for each model, capability and need level, the answered
tasks where the description was complete enough (completeness >= 75) are counted:

| Condition (at least 10 tasks)                          | Proposal                        |
|--------------------------------------------------------|---------------------------------|
| The model covered level L and solved under 50%         | lower that capability           |
| The model fell short at L and solved over 80%          | raise it, or run the set        |
| Failures mostly with low completeness or "described poorly" | nothing in the catalogue; Coach |
| Many answers per task with a model on tasks it covers  | review the level or output limit |

Calibration set (``levels_from_reviews``): level L for a capability when the model passes
every task of level L and of every level below it.
"""

import json
from collections import defaultdict

MIN_TASKS = 10
MIN_COMPLETENESS = 75
LOWER_BELOW = 0.5
RAISE_ABOVE = 0.8
MANY_TURNS = 4
SOLVED = {"resolved", "resolved_with_refinement"}


def proposals(rows: list[dict]) -> list[dict]:
    """Rows: task_outcomes with needs_json and capabilities_json decoded or as text."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    poorly_described: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row["outcome"] == "skipped" or not row.get("model_card_id"):
            continue
        needs = _json(row.get("needs_json"))
        levels = _json(row.get("capabilities_json"))
        if not needs or not levels:
            continue
        complete = (row.get("completeness") or 0) >= MIN_COMPLETENESS
        if row["outcome"] == "not_resolved" and (
            not complete or row.get("reason") == "description"
        ):
            poorly_described[row["model_card_id"]].append(row)
        if not complete:
            continue
        for name, need in needs.get("needs", {}).items():
            capability = levels.get(name)
            if capability is None:
                continue
            state = (
                "covers"
                if capability >= need["top"]
                else ("short" if capability < need["estimated"] else "as_described")
            )
            source = row.get("levels_source") or "catalogue"
            groups[(row["model_card_id"], source, name, need["estimated"], state)].append(row)
    result = []
    for (model, source, name, level, state), items in sorted(groups.items()):
        if len(items) < MIN_TASKS:
            continue
        rate = sum(item["outcome"] in SOLVED for item in items) / len(items)
        base = {
            "model": model,
            "source": source,
            "capability": name,
            "level": level,
            "tasks": len(items),
        }
        if state == "covers" and rate < LOWER_BELOW:
            result.append({**base, "solved": round(rate, 2), "proposal": "lower"})
        elif state == "short" and rate > RAISE_ABOVE:
            result.append({**base, "solved": round(rate, 2), "proposal": "raise_or_calibrate"})
        turns = [item["turns"] for item in items if item.get("turns") is not None]
        if state == "covers" and turns and sum(turns) / len(turns) >= MANY_TURNS:
            result.append(
                {**base, "mean_turns": round(sum(turns) / len(turns), 1), "proposal": "review"}
            )
    for model, items in sorted(poorly_described.items()):
        if len(items) >= MIN_TASKS:
            result.append({"model": model, "tasks": len(items), "proposal": "coach_not_catalogue"})
    return result


def levels_from_reviews(reviews: list[dict]) -> dict[str, int | None]:
    """Reviews: {capability, level, passed} per calibration task, both reviewers agreeing."""
    by_capability: dict[str, dict[int, list[bool]]] = defaultdict(lambda: defaultdict(list))
    for review in reviews:
        by_capability[review["capability"]][int(review["level"])].append(bool(review["passed"]))
    result = {}
    for capability, levels in by_capability.items():
        reached = None
        for level in (1, 2, 3):
            if levels.get(level) and all(levels[level]):
                reached = level
            else:
                break
        result[capability] = reached
    return result


def _json(value):
    if value is None or isinstance(value, dict):
        return value
    return json.loads(value)


def by_source(rows: list[dict]) -> list[dict]:
    """Answered tasks and solved rate per source of the levels (A10): shows whether a public
    source (LMArena, Artificial Analysis) predicts outcomes worse than measured levels."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row["outcome"] != "skipped":
            groups[row.get("levels_source") or "catalogue"].append(row)
    return [
        {
            "source": source,
            "tasks": len(items),
            "solved": round(sum(item["outcome"] in SOLVED for item in items) / len(items), 2),
        }
        for source, items in sorted(groups.items())
    ]
