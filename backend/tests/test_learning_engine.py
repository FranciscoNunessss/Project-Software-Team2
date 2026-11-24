"""WS4 indicator engine (L2, L3, L12): one test per rule and per boundary (PR5 spec)."""

from app.learning_engine import (
    DIMENSIONS,
    CoachUse,
    TaskRecord,
    compute,
    confidence,
    level_history,
    lower_median,
    raw_level,
)


def scored(values, dimension="success_criteria", **extra):
    """Tasks where only ``dimension`` is assessed (others not applicable)."""
    tasks = []
    for index, value in enumerate(values):
        scores = {name: None for name in DIMENSIONS}
        scores[dimension] = value
        tasks.append(TaskRecord(task_id=f"t{index}", scores=scores, **extra))
    return tasks


def codes(indicators, dimension=None):
    return [p.code for p in indicators.patterns if dimension is None or p.dimension == dimension]


# ---- missing dimension (3 of the last 5 applicable) ----------------------------------------


def test_missing_dimension_fires_at_three_of_five():
    result = compute(scored([2, 0, 1, 0, 0]))
    pattern = next(p for p in result.patterns if p.code == "missing_dimension")
    assert (pattern.hits, pattern.window, pattern.dimension) == (3, 5, "success_criteria")


def test_missing_dimension_does_not_fire_at_two_of_five():
    assert "missing_dimension" not in codes(compute(scored([2, 0, 1, 0, 2])))


def test_no_pattern_and_no_level_with_four_tasks():
    result = compute(scored([0, 0, 0, 0]))
    assert result.patterns == []
    assert result.dimensions["success_criteria"].level is None
    assert result.overall_level is None


def test_not_applicable_tasks_never_count():
    tasks = scored([0, 0, 0, 0])
    tasks += [TaskRecord(task_id=f"na{i}", scores={n: None for n in DIMENSIONS}) for i in range(6)]
    result = compute(tasks)
    assert result.dimensions["success_criteria"].tasks == 4
    assert result.dimensions["success_criteria"].level is None


# ---- maturity levels (shares after dropping the weakest 20%) --------------------------------


def test_two_weak_tasks_of_ten_do_not_lower_level_four():
    assert raw_level([2, 2, 0, 2, 2, 2, 0, 2, 2, 2]) == 4


def test_level_thresholds():
    assert raw_level([2] * 7 + [0] * 3) == 4  # 7 of 8 kept at 2
    assert raw_level([2] * 4 + [1] * 4 + [0] * 2) == 3  # 100% at 1+, 50% at 2
    assert raw_level([1] * 4 + [0] * 6) == 2  # 4 of 8 kept at 1 or more = 50%
    assert raw_level([1] * 2 + [0] * 8) == 1  # 2 of 8 = 25%


def test_level_needs_five_scores():
    assert raw_level([2, 2, 2, 2]) is None
    assert raw_level([2, 2, 2, 2, 2]) == 4


def test_one_bad_task_keeps_the_level():
    history = level_history([2, 2, 1, 2, 1, 2, 1, 2, 0])
    assert history[-1] == history[-2]


def test_level_drops_after_three_consecutive_tasks_below():
    scores = [2] * 10 + [0, 0, 0, 0, 0, 0, 0]
    history = level_history(scores)
    assert history[9] == 4
    drops = [i for i in range(10, len(history)) if history[i] < history[i - 1]]
    assert drops, "the level must eventually drop"
    first = drops[0]
    raw = [raw_level(scores[max(0, i + 1 - 10) : i + 1]) for i in range(len(scores))]
    below = [i for i in range(10, first + 1) if raw[i] < 4]
    assert len(below) >= 3


def test_level_goes_up_at_once():
    history = level_history([0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2])
    rises = [i for i in range(1, len(history)) if (history[i] or 0) > (history[i - 1] or 0)]
    assert rises


def test_overall_level_is_the_median():
    assert lower_median([1, 2, 2, 3, 3, 4, 4]) == 3
    assert lower_median([1, 4]) == 1
    assert lower_median([]) is None


# ---- exclusion and pause ---------------------------------------------------------------------


def test_excluded_and_paused_tasks_are_ignored():
    tasks = scored([0, 0, 0, 2, 2])
    tasks[0] = TaskRecord(task_id="x", scores=tasks[0].scores, excluded=True)
    tasks[1] = TaskRecord(task_id="p", scores=tasks[1].scores, paused=True)
    result = compute(tasks)
    assert result.tasks == 3
    assert result.dimensions["success_criteria"].tasks == 3
    assert "missing_dimension" not in codes(result)


# ---- confidence ------------------------------------------------------------------------------


def test_confidence_high_with_ten_steady_scores():
    assert confidence([2] * 10, 1.0) == ("high", [])


def test_confidence_low_with_six_varied_scores_on_unstable_dimension():
    label, reasons = confidence([0, 2, 0, 2, 0, 2], 0.6)
    assert label == "low"
    assert reasons == ["few_tasks", "varied_scores", "less_stable_dimension"]


def test_confidence_medium_with_seven_scores():
    assert confidence([2] * 7, 1.0) == ("medium", ["few_tasks"])


def test_confidence_none_below_five():
    assert confidence([2] * 4, 1.0) == (None, ["few_tasks"])


def test_stability_from_m3_lowers_confidence():
    result = compute(scored([2] * 10), stability={"success_criteria": 0.5})
    assert result.dimensions["success_criteria"].confidence == "medium"
    assert "less_stable_dimension" in result.dimensions["success_criteria"].confidence_reasons


# ---- sizing ----------------------------------------------------------------------------------


def sized(pairs):
    return [TaskRecord(task_id=f"s{i}", sizing=s, outcome=o) for i, (s, o) in enumerate(pairs)]


def test_over_sizing_when_bigger_models_solved_three_of_five():
    tasks = sized(
        [("over", "yes"), ("match", "yes"), ("over", "partly"), ("over", "yes"), ("match", "no")]
    )
    assert "over_sizing" in codes(compute(tasks))


def test_over_sizing_needs_the_task_resolved():
    tasks = sized(
        [("over", "no"), ("over", "no"), ("over", "yes"), ("match", "yes"), ("match", "yes")]
    )
    assert "over_sizing" not in codes(compute(tasks))


def test_under_sizing_when_smaller_models_failed():
    tasks = sized([("under", "no")] * 3 + [("match", "yes")] * 2)
    assert "under_sizing" in codes(compute(tasks))


def test_good_model_choice_four_of_five():
    assert "good_model_choice" in codes(compute(sized([("match", "yes")] * 4 + [("over", "no")])))
    assert "good_model_choice" not in codes(
        compute(sized([("match", "yes")] * 3 + [("over", "no")] * 2))
    )


def test_sizing_needs_five_decided_tasks():
    assert codes(compute(sized([("over", "yes")] * 4))) == []


def test_sizing_uses_only_the_last_five():
    tasks = sized([("over", "yes")] * 5 + [("match", "partly")] * 5)
    assert "over_sizing" not in codes(compute(tasks))


# ---- Coach -----------------------------------------------------------------------------------


def coached(items):
    return [
        TaskRecord(task_id=f"c{i}", coach=CoachUse(gaps, accepted), outcome=outcome)
        for i, (gaps, accepted, outcome) in enumerate(items)
    ]


def test_coach_ignored_three_of_five_with_gaps():
    tasks = coached(
        [(2, False, None), (3, False, None), (2, True, None), (2, False, None), (4, True, None)]
    )
    assert "coach_ignored" in codes(compute(tasks))


def test_coach_ignored_skips_tasks_with_few_gaps():
    tasks = coached([(1, False, None)] * 5)
    assert "coach_ignored" not in codes(compute(tasks))


def test_coach_pays_off_needs_five_of_each():
    tasks = coached([(2, True, "yes")] * 5 + [(2, False, "no")] * 5)
    assert "coach_pays_off" in codes(compute(tasks))
    assert "coach_pays_off" not in codes(compute(tasks[:9]))


# ---- interaction -----------------------------------------------------------------------------


def test_long_chats_against_the_users_own_median():
    turns = [2, 2, 2, 2, 2, 8, 9, 2, 7, 2]
    tasks = [TaskRecord(task_id=f"l{i}", turns=t, outcome="yes") for i, t in enumerate(turns)]
    assert "long_chats" in codes(compute(tasks))


def test_model_switching_three_of_five():
    flags = [True, False, True, True, False]
    tasks = [TaskRecord(task_id=f"m{i}", switched_model=f) for i, f in enumerate(flags)]
    assert "model_switching" in codes(compute(tasks))
    tasks[0] = TaskRecord(task_id="m0", switched_model=False)
    assert "model_switching" not in codes(compute(tasks))


# ---- improving and determinism ---------------------------------------------------------------


def test_improving_dimension_is_positive():
    result = compute(scored([0] * 6 + [2] * 6))
    pattern = next(p for p in result.patterns if p.code == "improving_dimension")
    assert pattern.kind == "positive"
    assert pattern.level_to > pattern.level_from


def test_same_input_gives_same_output():
    tasks = scored([2, 0, 1, 0, 0, 2, 2, 1, 0, 2, 2])
    assert compute(tasks).as_dict() == compute(tasks).as_dict()


def test_output_holds_no_text_fields():
    data = compute(scored([2] * 6)).as_dict()
    assert set(data) == {"version", "tasks", "overall_level", "dimensions", "patterns"}
