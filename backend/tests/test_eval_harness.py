"""WS5 M3 evaluation harness: the measurements added to the quality evaluation.

Logic tests with made-up rows and a fake assessor (docs/ws5/m3-evaluation-harness.md). They check
the arithmetic and the rules, not the quality of any model. Cases: S1 every metric, S2 one run,
S3 a changing cell, S5 resume, S6 injection flagged and gated, S7 no task text in the report,
S8 no dev key.
"""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
from app import quality_eval as qe
from app.models import Assessment

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {"a": {"reasoning": 1, "risk": 1}, "inj": {name: 1 for name in qe.DIMENSIONS}}


def runner():
    spec = importlib.util.spec_from_file_location(
        "run_quality_eval", ROOT / "scripts/run_quality_eval.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def levels(value, **override):
    return {name: override.get(name, value) for name in qe.DIMENSIONS}


def row(task, repeat, value=1, **extra):
    return {"task": task, "repeat": repeat, "levels": levels(value), **extra}


def test_stability_is_not_applicable_with_a_single_run():
    result = qe.stability([row("a", 0)], repeats=1)

    assert result["applicable"] is False


def test_a_cell_that_changes_in_one_run_is_not_stable():
    rows = [row("a", 0), row("a", 1), {"task": "a", "repeat": 2, "levels": levels(1, risk=2)}]

    result = qe.stability(rows, repeats=3)

    assert result["cells"] == 6 and result["identical"] == 5 and result["percent"] == 83.3


def test_a_task_with_a_failed_run_is_left_out_of_stability_and_counted():
    rows = [row("a", 0), row("a", 1), row("b", 0), {"task": "b", "repeat": 1, "error": "x"}]

    result = qe.stability(rows, repeats=2)

    assert result["cells"] == 6 and result["tasks_left_out"] == 1


def test_request_quality_stability_is_not_available_until_l1_returns_scores():
    assert qe.stability([row("a", 0), row("a", 1)], 2, "request_quality")["applicable"] is False


def test_recommendation_agreement_counts_same_over_and_under_by_price():
    rows = [
        row("a", 0, recommended="mid"),
        row("b", 0, recommended="top"),
        row("c", 0, recommended="cheap"),
        row("d", 0),  # the recommendation failed
        row("a", 1, recommended="top"),  # later repeats do not count
    ]
    expected = {"a": "mid", "b": "mid", "c": "mid", "d": "mid"}

    result = qe.recommendation_agreement(rows, expected, {"cheap": 0.1, "mid": 1, "top": 5})

    assert result == {
        "n": 3,
        "failed": 1,
        "same": 1,
        "over_sized": 1,
        "under_sized": 1,
        "illustrative": 0,
        "agreement": 33.3,
    }


def test_an_injection_task_with_all_levels_forced_is_flagged():
    rows = [row("inj", 0, 3), row("inj", 1, 1), row("a", 0, 3)]

    result = qe.injection_check(rows, ["inj"], EXPECTED)

    assert result["flagged"] == [{"task": "inj", "repeat": 0}]


def test_an_easy_injection_task_labelled_all_ones_is_not_flagged_for_all_ones():
    assert qe.injection_check([row("inj", 0, 1)], ["inj"], EXPECTED)["flagged"] == []


def test_a_flagged_injection_fails_the_gate_even_when_agreement_passes():
    report = {"measurements": {"injection": {"flagged": [{"task": "inj", "repeat": 0}]}}}

    result = qe.gate_injection({"verdict": qe.PASS}, report)

    assert result["verdict"] == qe.REGRESSION and result["reason"] == qe.INJECTION_FLAGGED
    assert qe.gate_injection({"verdict": qe.NOT_RUN}, report)["verdict"] == qe.NOT_RUN


def test_a_run_stopped_by_a_rate_limit_resumes_from_the_next_analysis():
    done = [row("a", 0), {"task": "b", "repeat": 0, "error": "rate_limited"}]

    assert qe.pending(["a", "b"], 2, done) == [(0, "b"), (1, "a"), (1, "b")]
    merged = qe.latest_rows([*done, row("b", 0)])
    assert sorted((r["task"], "error" in r) for r in merged) == [("a", False), ("b", False)]


def test_the_harness_refuses_to_run_without_the_dev_key():
    with pytest.raises(qe.NoDevKey, match="never use the production key"):
        qe.dev_key("groq", {"ADAPTAI_GROQ_API_KEY": "production"})
    assert qe.dev_key("groq", {"EVAL_GROQ_API_KEY": "dev"}) == "dev"
    assert qe.dev_key("lmstudio", {}) is None


def test_usage_totals_price_the_analysis_tokens():
    rows = [
        row("a", 0, tokens={"input_tokens": 1_000_000, "output_tokens": 0}),
        row("a", 1, tokens={"input_tokens": 0, "output_tokens": 1_000_000}),
    ]

    result = qe.usage_totals(rows, {"in": 0.03, "out": 0.13})

    assert result == {"tokens_in": 1_000_000, "tokens_out": 1_000_000, "estimated_cost_usd": 0.16}


class FakeAssessor:
    """Answers every task with level 1 (a fake model: no network)."""

    def __init__(self, profile):
        self.profile = profile

    async def assess(self, _text):
        return Assessment(profile=self.profile, usage={"input_tokens": 10, "output_tokens": 5})


def easy_profile():
    from app.providers import DemonstrationProvider

    profile = asyncio.run(DemonstrationProvider().assess("x")).profile
    for name in qe.DIMENSIONS:
        setattr(
            profile,
            name,
            getattr(profile, name).model_copy(update={"score": 1, "confidence": "high"}),
        )
    profile.modality = profile.modality.model_copy(update={"required": ["text"]})
    return profile


def test_a_full_run_report_has_every_metric_and_never_the_task_text():
    module = runner()
    from app.catalogue import active_catalogue
    from app.evaluations import Ratings

    marker = "MARKER-7f3a task text that must never be stored"
    tasks = [
        {"id": "a", "task": marker, "expected": {"reasoning": 1}, "expected_model": "gpt-oss-20b"},
        {"id": "inj", "task": marker, "expected": EXPECTED["inj"], "injection": True},
    ]
    assessor = FakeAssessor(easy_profile())
    ratings = Ratings(None, active_catalogue())
    rows = []
    for repeat in range(2):
        for task in tasks:
            result, _ = asyncio.run(module.analyse(assessor, task["task"], ratings))
            rows.append({"task": task["id"], "repeat": repeat, **result})

    extra = module.measurements(rows, tasks, 2, {"in": 0.03, "out": 0.13})
    report = json.dumps({"rows": rows, "measurements": extra})

    assert set(extra) == {
        "level_stability",
        "request_quality_stability",
        "recommendation",
        "injection",
        "usage",
    }
    assert extra["level_stability"]["percent"] == 100.0
    assert extra["recommendation"]["n"] == 1 and extra["recommendation"]["illustrative"] == 0
    assert extra["usage"]["tokens_in"] == 40
    assert all(r["recommended"] and not r["illustrative"] for r in rows)
    assert marker not in report
