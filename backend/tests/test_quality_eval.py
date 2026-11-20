"""The scoring and the regression gate of the quality evaluation.

These tests check the arithmetic and the rules of the gate with made-up answers. They are
logic tests, not quality evals: they say nothing about how good any model is.
"""

import json
from pathlib import Path

from app import quality_eval as qe

EXPECTED = {"a": {"reasoning": 1, "risk": 3}, "b": {"reasoning": 2}}


def row(task, **levels):
    return {"task": task, "levels": levels}


def report(agreement, **extra):
    base = {
        "status": qe.PASS,
        "task_set": 1,
        "rubric": "rubric-2.0",
        "model": "m",
        "metrics": {
            "analyses": 10,
            "failed": 0,
            "overall": {"n": 30, "agreement": agreement},
            "by_dimension": {"reasoning": {"agreement": agreement}},
        },
    }
    return {**base, **extra}


def test_score_counts_exact_within_one_and_the_error():
    rows = [row("a", reasoning=1, risk=2), row("b", reasoning=2)]
    metrics = qe.score(rows, EXPECTED)
    assert metrics["overall"] == {
        "n": 3,
        "agreement": 66.7,
        "within_1": 100.0,
        "mean_abs_error": 0.33,
        "undetermined": 0,
    }
    assert metrics["by_dimension"]["risk"]["agreement"] == 0.0
    assert metrics["analyses"] == 2 and metrics["failed"] == 0


def test_an_undetermined_level_is_a_disagreement_not_a_skipped_cell():
    metrics = qe.score([row("a", reasoning=None, risk=3)], EXPECTED)
    assert metrics["overall"]["n"] == 2
    assert metrics["overall"]["agreement"] == 50.0
    assert metrics["overall"]["undetermined"] == 1


def test_only_labelled_dimensions_are_scored():
    metrics = qe.score([row("b", reasoning=2, risk=1, tools=3)], EXPECTED)
    assert metrics["overall"]["n"] == 1


def test_failed_analyses_are_counted_and_not_scored():
    rows = [{"task": "a", "error": "provider_rate_limit"}, row("b", reasoning=2)]
    metrics = qe.score(rows, EXPECTED)
    assert metrics["failed"] == 1 and metrics["overall"]["n"] == 1


def test_a_provider_outage_is_not_run_and_never_a_pass():
    rows = [{"task": "a", "error": "provider_unavailable"}] * 5
    assert qe.run_status(qe.score(rows, EXPECTED)) == qe.NOT_RUN
    assert qe.run_status(qe.score([], EXPECTED)) == qe.NOT_RUN
    assert qe.compare(report(90), report(90, status=qe.NOT_RUN))["verdict"] == qe.NOT_RUN


def test_a_few_failures_do_not_hide_a_measurement():
    rows = [row("b", reasoning=2)] * 19 + [{"task": "a", "error": "x"}]
    assert qe.run_status(qe.score(rows, EXPECTED)) == qe.PASS


def test_a_drop_of_five_points_passes_and_more_is_a_regression():
    assert qe.compare(report(85), report(80))["verdict"] == qe.PASS
    result = qe.compare(report(85), report(79.9))
    assert result["verdict"] == qe.REGRESSION and result["drop_points"] == 5.1


def test_an_improvement_passes():
    assert qe.compare(report(70), report(90))["verdict"] == qe.PASS


def test_a_regression_needs_an_adr_for_that_model_and_rubric():
    accepted = [{"model": "m", "rubric": "rubric-2.0", "adr": "ADR-020"}]
    assert qe.compare(report(85), report(70), accepted)["verdict"] == qe.ACCEPTED
    other = [{"model": "other", "rubric": "rubric-2.0", "adr": "ADR-020"}]
    assert qe.compare(report(85), report(70), other)["verdict"] == qe.REGRESSION
    no_adr = [{"model": "m", "rubric": "rubric-2.0"}]
    assert qe.compare(report(85), report(70), no_adr)["verdict"] == qe.REGRESSION


def test_no_baseline_and_a_changed_task_set_are_said_not_hidden():
    assert qe.compare(None, report(80))["verdict"] == qe.NO_BASELINE
    assert qe.compare(report(85), report(80, task_set=2))["verdict"] == qe.NOT_COMPARABLE
    assert qe.compare(report(85), report(80, rubric="rubric-2.1"))["verdict"] == qe.NOT_COMPARABLE


def test_the_task_set_is_well_formed_and_holds_no_user_data():
    path = Path(__file__).resolve().parents[1] / "eval/quality/tasks-1.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    ids = [task["id"] for task in document["tasks"]]
    assert len(ids) == len(set(ids)) == 24
    for task in document["tasks"]:
        assert task["expected"] and set(task["expected"]) <= set(qe.DIMENSIONS)
        assert all(level in (1, 2, 3) for level in task["expected"].values())
    assert 0 < sum(task["subset"] for task in document["tasks"]) < len(ids)
    assert "DRAFT" in document["status"]
