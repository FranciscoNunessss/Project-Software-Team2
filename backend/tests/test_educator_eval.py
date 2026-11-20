"""The checks of the Educator evaluation (scripts/run_educator_eval.py), offline.

They test the filter that flags text contradicting the verdict, not a model.
"""

import importlib.util
from pathlib import Path

from usage_histories import HISTORIES


def runner():
    path = Path(__file__).resolve().parents[2] / "scripts/run_educator_eval.py"
    spec = importlib.util.spec_from_file_location("run_educator_eval", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def history(name):
    return next(h for h in HISTORIES if h.name == name)


def report(summary, lesson="Practise describing the task before you send it."):
    advice = {"explanation": "Fine.", "action": "Carry on."}
    return {
        "summary": summary,
        "patterns": {
            "over_provisioning": advice,
            "under_provisioning": advice,
            "prompting": {**advice, "status": "not_assessed"},
        },
        "suggestions": [{"title": "Describe tasks", "explanation": lesson, "action": "Try it."}],
    }


def test_the_input_holds_the_counts_and_the_python_verdict_and_no_task_text():
    module = runner()
    data = module.metadata_of(history("over_provisioning"))
    assert data["usage_patterns"]["over_provisioning"]["status"] == "detected"
    assert data["metrics"]["confirmed_choices"] == 9 and data["metrics"]["pending_choices"] == 1
    assert all(set(row) == {"mode", "choice_gap"} for row in data["assessments"])


def test_a_summary_that_asserts_a_pattern_the_rule_did_not_detect_is_flagged():
    module = runner()
    data = module.metadata_of(history("control_follows_recommendation"))
    flags = module.flags_of(
        report("You tend to over-provision: you choose larger models than the tasks need."),
        None,
        data["usage_patterns"],
    )
    assert flags and flags[0]["pattern"] == "over_provisioning" and flags[0]["where"] == "summary"


def test_saying_that_no_pattern_shows_is_not_a_contradiction():
    module = runner()
    data = module.metadata_of(history("control_follows_recommendation"))
    for text in (
        "No over-provisioning pattern shows in this sample.",
        "There are too few choices to tell whether you over-provision.",
    ):
        assert module.flags_of(report(text), None, data["usage_patterns"]) == []


def test_a_lesson_that_asserts_the_undetected_pattern_is_flagged_too():
    module = runner()
    data = module.metadata_of(history("control_too_few_choices"))
    flags = module.flags_of(
        report("Keep going.", lesson="You pick a model that is too small for your tasks."),
        None,
        data["usage_patterns"],
    )
    assert any(f["pattern"] == "under_provisioning" and "suggestion" in f["where"] for f in flags)


def test_a_detected_pattern_is_not_flagged_for_being_described():
    module = runner()
    data = module.metadata_of(history("over_provisioning"))
    text = "Most of your confirmed choices are larger models than the tasks need."
    assert module.flags_of(report(text), None, data["usage_patterns"]) == []
