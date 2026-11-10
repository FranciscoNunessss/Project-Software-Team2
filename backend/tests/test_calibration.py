"""Calibration proposals from feedback and levels from the calibration set (ADR-014)."""

import json
from pathlib import Path

from app.calibration import levels_from_reviews, proposals

NEEDS = {"needs": {"reasoning": {"estimated": 3, "top": 3, "determined": True}}}


def rows(count, outcome, capability, completeness=90, reason=None, turns=1):
    return [
        {
            "outcome": outcome,
            "reason": reason,
            "model_card_id": "m",
            "needs_json": json.dumps(NEEDS),
            "capabilities_json": json.dumps({"reasoning": capability}),
            "completeness": completeness,
            "turns": turns,
        }
        for _ in range(count)
    ]


def test_covered_but_mostly_unsolved_proposes_lowering():
    found = proposals(rows(6, "not_resolved", 3) + rows(4, "resolved", 3))
    assert found == [
        {
            "model": "m",
            "source": "catalogue",
            "capability": "reasoning",
            "level": 3,
            "tasks": 10,
            "solved": 0.4,
            "proposal": "lower",
        }
    ]


def test_short_but_mostly_solved_proposes_raising():
    found = proposals(rows(9, "resolved", 2) + rows(1, "not_resolved", 2))
    assert found[0]["proposal"] == "raise_or_calibrate"


def test_fewer_than_ten_tasks_or_incomplete_descriptions_propose_nothing():
    assert proposals(rows(9, "not_resolved", 3)) == []
    found = proposals(rows(12, "not_resolved", 3, completeness=40))
    assert found == [{"model": "m", "tasks": 12, "proposal": "coach_not_catalogue"}]


def test_many_answers_per_task_ask_for_a_review():
    found = proposals(rows(10, "resolved", 3, turns=5))
    assert found[0]["proposal"] == "review"


def test_levels_from_reviews_need_every_task_of_the_level_and_below():
    reviews = [
        {"capability": "reasoning", "level": 1, "passed": True},
        {"capability": "reasoning", "level": 2, "passed": True},
        {"capability": "reasoning", "level": 3, "passed": False},
        {"capability": "tools", "level": 1, "passed": False},
        {"capability": "tools", "level": 2, "passed": True},
    ]
    assert levels_from_reviews(reviews) == {"reasoning": 2, "tools": None}


def test_the_calibration_set_has_two_tasks_per_level_and_capability():
    data = json.loads(
        (Path(__file__).parents[1] / "eval/calibration/calibration-set-1.json").read_text()
    )
    counts = {}
    for task in data["tasks"]:
        key = (task["capability"], task["level"])
        counts[key] = counts.get(key, 0) + 1
        assert task["task"] and task["pass"]
    assert len(counts) == 15 and set(counts.values()) == {2}


def test_outcomes_are_grouped_by_the_source_of_the_levels():
    """A10: a public source that predicts outcomes badly shows up in the report."""
    from app.calibration import by_source

    data = rows(10, "resolved", 3)
    for item in data[:4]:
        item["levels_source"] = "arena"
    for item in data[:3]:
        item["outcome"] = "not_resolved"
    assert by_source(data) == [
        {"source": "arena", "tasks": 4, "solved": 0.25},
        {"source": "catalogue", "tasks": 6, "solved": 1.0},
    ]
    found = proposals(
        [{**row, "levels_source": "arena"} for row in rows(6, "not_resolved", 3)]
        + [{**row, "levels_source": "arena"} for row in rows(4, "resolved", 3)]
    )
    assert found[0]["source"] == "arena" and found[0]["proposal"] == "lower"
