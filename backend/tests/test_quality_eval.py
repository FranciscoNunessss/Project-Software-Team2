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


def pair_row(task, variant, completeness, repeat=0, **extra):
    return {
        "task": task,
        "repeat": repeat,
        "variant": variant,
        "completeness": completeness,
        **extra,
    }


def test_pairs_count_how_often_the_complete_version_is_more_complete():
    rows = [
        pair_row("a", "vague", 40),
        pair_row("a", "complete", 80),
        pair_row("b", "vague", 60),
        pair_row("b", "complete", 60),
    ]
    metrics = qe.score_pairs(rows)
    assert metrics["overall"]["n"] == 2 and metrics["overall"]["agreement"] == 50.0
    assert metrics["failed"] == 0 and metrics["analyses"] == 4


def test_a_pair_with_a_failed_analysis_is_not_counted_and_an_outage_is_not_run():
    rows = [pair_row("a", "vague", 40), {"task": "a", "variant": "complete", "error": "x"}]
    metrics = qe.score_pairs(rows)
    assert metrics["overall"]["n"] == 0 and metrics["overall"]["agreement"] is None
    assert metrics["failed"] == 1
    outage = [{"task": "a", "variant": "vague", "error": "x"}] * 5
    assert qe.run_status(qe.score_pairs(outage)) == qe.NOT_RUN


def test_repeats_of_a_pair_are_scored_separately():
    rows = [
        pair_row("a", "vague", 40, repeat=0),
        pair_row("a", "complete", 80, repeat=0),
        pair_row("a", "vague", 70, repeat=1),
        pair_row("a", "complete", 50, repeat=1),
    ]
    assert qe.score_pairs(rows)["overall"]["agreement"] == 50.0


def test_a_baseline_of_another_suite_is_not_comparable():
    profile = report(85)
    pairs = report(85, suite="pairs")
    assert qe.compare(profile, report(80))["verdict"] == qe.PASS
    assert qe.compare(profile, pairs)["verdict"] == qe.NOT_COMPARABLE


def test_the_injection_and_pairs_sets_are_well_formed_and_hold_no_user_data():
    folder = Path(__file__).resolve().parents[1] / "eval/quality"
    injection = json.loads((folder / "injection-1.json").read_text(encoding="utf-8"))
    assert injection["suite"] == "injection" and "DRAFT" in injection["status"]
    ids = [task["id"] for task in injection["tasks"]]
    assert len(ids) == len(set(ids)) == 8
    for task in injection["tasks"]:
        assert task["expected"] and set(task["expected"]) <= set(qe.DIMENSIONS)
    pairs = json.loads((folder / "pairs-1.json").read_text(encoding="utf-8"))
    assert pairs["suite"] == "pairs" and "DRAFT" in pairs["status"]
    assert len(pairs["pairs"]) == 10 == len({pair["id"] for pair in pairs["pairs"]})
    for pair in pairs["pairs"]:
        assert len(pair["vague"]) < len(pair["complete"])
    assert 0 < sum(pair["subset"] for pair in pairs["pairs"]) < 10


def runner():
    import importlib.util

    path = Path(__file__).resolve().parents[2] / "scripts/run_quality_eval.py"
    spec = importlib.util.spec_from_file_location("run_quality_eval", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_runner_can_assess_with_another_rubric_version_than_the_active_one():
    from app.prompt_builder import build_assessment_prompt, load_rubric

    module = runner()
    older = module.RubricProvider("groq", module.Settings(_env_file=None), "rubric-2.0")
    newer = module.RubricProvider("groq", module.Settings(_env_file=None), "rubric-2.1")
    assert older.prompt == build_assessment_prompt(load_rubric("rubric-2.0"))
    assert older.prompt != newer.prompt


def test_diff_prints_the_two_reports_side_by_side(tmp_path, capsys):
    module = runner()

    def saved(name, rubric, agreement, reasoning):
        data = report(agreement, rubric=rubric, suite="profile")
        data["metrics"]["by_dimension"] = {"reasoning": {"agreement": reasoning}}
        path = tmp_path / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return str(path)

    args = type("Args", (), {})()
    args.first = saved("a.json", "rubric-2.0", 80.0, 70.0)
    args.second = saved("b.json", "rubric-2.1", 86.0, 90.0)
    assert module.diff(args) == 0
    text = capsys.readouterr().out
    assert "rubric-2.0" in text and "rubric-2.1" in text
    assert "+6.0" in text and "+20.0" in text
