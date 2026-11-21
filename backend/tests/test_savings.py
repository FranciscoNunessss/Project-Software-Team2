"""M4 savings method for KR1.2 (docs/ws5/m4-savings-method.md).

Logic tests with made-up rows and prices: they check the arithmetic and the rules, not any model.
Cases S1 to S9 of the spec, one test each, plus the verdict mapping from the blind review.
"""

import pytest
from app import savings as sv

PRICES = {
    "cheap": {"in": 0.1, "out": 0.5, "local": False},
    "top": {"in": 2.0, "out": 10.0, "local": False},
    "box": {"in": None, "out": None, "local": True},
    "unknown": {"in": None, "out": None, "local": False},
}
REFERENCE = {
    "model": "top",
    "price_in_per_mtok": 2.0,
    "price_out_per_mtok": 10.0,
    "observed_on": "2026-11-06",
}


def row(task, model, tokens_in=1000, tokens_out=500, **extra):
    return {"task": task, "model": model, "tokens_in": tokens_in, "tokens_out": tokens_out, **extra}


def test_the_ratio_is_the_recommended_cost_over_the_top_cost_at_dated_prices():
    rows = [row("a", "cheap"), row("b", "top")]

    result = sv.savings(rows, PRICES, REFERENCE)

    # a: 0.1*1000 + 0.5*500 = 350 vs 2*1000 + 10*500 = 7000 ; b: 7000 vs 7000 (per million)
    assert result["ratio_percent"] == round(100 * 7350 / 14000, 1)
    assert result["status"] == sv.MEASURED
    assert result["reference"]["observed_on"] == "2026-11-06"


def test_following_the_top_model_everywhere_costs_exactly_100_percent():
    result = sv.savings([row("a", "top"), row("b", "top", 50, 2000)], PRICES, REFERENCE)

    assert result["ratio_percent"] == 100.0 and result["passes"] is False


def test_a_local_model_costs_nothing_and_is_counted_apart():
    result = sv.savings([row("a", "box"), row("b", "top")], PRICES, REFERENCE)

    assert result["local"] == ["a"]
    assert result["ratio_percent"] == 50.0


def test_exactly_fifty_percent_passes():
    result = sv.savings([row("a", "box"), row("b", "top")], PRICES, REFERENCE)

    assert result["passes"] is True


def test_a_missing_price_or_token_count_marks_the_result_incomplete():
    rows = [row("a", "cheap"), row("b", "unknown"), row("c", "cheap", tokens_out=None)]

    result = sv.savings(rows, PRICES, REFERENCE)

    assert result["status"] == sv.INCOMPLETE
    assert result["unpriced"] == ["b", "c"]
    assert result["passes"] is False


def test_an_under_sized_task_is_charged_the_retry_on_the_top_model():
    rows = [row("a", "cheap"), row("b", "cheap")]

    result = sv.savings(rows, PRICES, REFERENCE, {"a": sv.UNDER, "b": sv.CORRECT})

    assert result["under_sized"] == ["a"]
    assert result["ratio_without_review_penalty"] == 5.0
    assert result["ratio_percent"] == round(100 * (350 + 7000 + 350) / 14000, 1)


def test_injection_tasks_are_priced_like_others_and_listed_apart():
    rows = [row("inj", "top", injection=True), row("a", "cheap")]

    result = sv.savings(rows, PRICES, REFERENCE)

    assert [item["task"] for item in result["injection"]] == ["inj"]
    assert result["tasks"] == 2


def test_a_row_with_a_text_field_is_rejected():
    with pytest.raises(ValueError, match="not allowed: prompt"):
        sv.savings([row("a", "cheap", prompt="secret task text")], PRICES, REFERENCE)


def test_a_not_run_evaluation_gives_no_ratio_never_a_partial_pass():
    result = sv.savings([row("a", "cheap")], PRICES, REFERENCE, run_status="not_run")

    assert result["status"] == sv.NOT_RUN and "ratio_percent" not in result
    assert sv.savings([], PRICES, REFERENCE)["status"] == sv.NOT_RUN


def test_the_sensitivity_line_prices_the_top_model_with_more_output():
    result = sv.savings([row("a", "cheap")], PRICES, REFERENCE)

    assert result["ratio_if_top_writes_1_5x"] < result["ratio_percent"]


def test_review_votes_map_to_verdicts_and_a_tie_keeps_the_fault():
    votes = {"a": ["A", "B", "D"], "b": ["A", "D"], "c": ["C", "C", "A"], "d": []}

    assert sv.verdicts_from_votes(votes) == {"a": sv.CORRECT, "b": sv.UNDER, "c": sv.OVER}


def test_rows_from_a_report_take_the_first_repeat_and_the_answer_tokens():
    report = {
        "injection_tasks": ["inj"],
        "rows": [
            {
                "task": "inj",
                "repeat": 0,
                "recommended": "cheap",
                "levels": {"risk": 1},
                "answer_tokens": {"input_tokens": 10, "output_tokens": 20},
            },
            {"task": "inj", "repeat": 1, "recommended": "top"},
            {"task": "x", "repeat": 0, "error": "rate_limited"},
        ],
    }

    assert sv.rows_from_report(report) == [
        {"task": "inj", "model": "cheap", "tokens_in": 10, "tokens_out": 20, "injection": True}
    ]


def test_free_quota_is_still_priced_at_the_catalogue_price():
    assert sv.cost(1_000_000, 0, {"in": 0.1, "out": 0.5, "local": False}) == 0.1
