"""The automatic measurement suite (measure-suite-1): shape, graders and levels."""

import json

from app.measurement import CAPABILITIES, build_suite, grade, levels


def reference(task) -> str:
    """A correct answer built from the grader, as a careful model would write it."""
    grader = task.grader
    kind = grader["kind"]
    if kind == "number":
        return f"Working it out step by step.\nANSWER: {grader['value']}"
    if kind == "text":
        return f"Reasoning first.\nANSWER: {grader['any'][0]}"
    if kind == "abstain":
        return "I don't know: I have no reliable information about that."
    if kind == "call":
        return json.dumps(grader["call"])
    if kind == "plan":
        return "```json\n" + json.dumps(grader["calls"]) + "\n```"
    rules = {rule["kind"]: rule.get("value") for rule in grader["rules"]}
    if "exact" in rules:
        return rules["exact"]
    if "json_keys" in rules:
        return json.dumps(dict.fromkeys(rules["json_keys"], "ok"))
    if "bullets" in rules:
        line = "- KEEP COPIES OFFSITE" if "uppercase" in rules else "- red"
        return "\n".join([line] * rules["bullets"])
    if "lines" in rules:
        return "Tests catch regressions early.\nThey document intended behaviour."
    if "starts" in rules:
        return "Summary: the deadline moves to Friday."
    if "include" in rules and "max_words" not in rules:
        values = [rule["value"] for rule in grader["rules"]]
        return "ANSWER: " + "; ".join(values)
    if "max_words" in rules:
        return "To catch bugs and share knowledge."
    raise AssertionError(task.id)


def test_sixty_tasks_four_per_capability_and_level_and_repeatable():
    suite = build_suite(1)
    assert len(suite) == 60
    for capability in CAPABILITIES:
        for level in (1, 2, 3):
            assert sum(t.capability == capability and t.level == level for t in suite) == 4
    assert [t.prompt for t in build_suite(1)] == [t.prompt for t in suite]
    assert [t.prompt for t in build_suite(2)] != [t.prompt for t in suite]


def test_every_task_accepts_a_correct_answer():
    for seed in (1, 2, 3):
        for task in build_suite(seed):
            assert grade(task, reference(task)), task.id


def test_wrong_answers_fail():
    suite = {task.id: task for task in build_suite(1)}
    assert not grade(suite["reasoning-1-0"], "ANSWER: 999999")
    assert not grade(suite["reliability-2-0"], "The winner was Maria Silva.")
    assert not grade(suite["tools-1-0"], '{"name": "get_weather", "arguments": {"city": "Paris"}}')
    assert not grade(suite["tools-3-0"], "[]")
    assert not grade(suite["reliability-1-1"], "Approved.")
    # Whole words only: "output" does not contain the answer "put".
    put = next(task for task in suite.values() if task.grader.get("any") == ["PUT"])
    assert not grade(put, "ANSWER: output")
    assert grade(put, "ANSWER: PUT")


def test_context_tasks_grow_with_the_level():
    suite = build_suite(1)
    size = {
        level: max(len(t.prompt) for t in suite if t.capability == "context" and t.level == level)
        for level in (1, 2, 3)
    }
    assert size[1] < size[2] < size[3]
    # Small enough for free provider tiers (about 8,000 tokens per minute).
    assert size[3] / 4 < 7000


def test_levels_need_three_quarters_at_the_level_and_below():
    results = [
        {"capability": "reasoning", "level": 1, "passed": True},
        {"capability": "reasoning", "level": 2, "passed": True},
        {"capability": "reasoning", "level": 3, "passed": False},
    ] * 4
    summary = levels(results)
    assert summary["reasoning"]["level"] == 2
    assert summary["reasoning"]["pass_rates"] == {1: 1.0, 2: 1.0, 3: 0.0}
    assert summary["tools"]["level"] is None
