"""M2/M6 blind-review packet and scoring (docs/ws5/m2-blind-review-protocol.md).

Logic tests with made-up runs and answers. Cases: S1 count, majority and kappa; S2 two reviewers who
split; S3 a missing answer; S4 fewer than 2 reviewers is NOT RUN; S7 only allowed answer fields;
S8 the packet refuses an incomplete run; plus controls and blindness of the item ids.
"""

import pytest
from app import blind_review as br

PRICES = {"cheap": 0.1, "mid": 1.0, "top": 4.0}


def run(size=20, **override):
    rows = [{"task": f"t{n:02d}", "repeat": 0, "recommended": "mid"} for n in range(size)]
    rows += [{"task": "t00", "repeat": 1, "recommended": "top"}]  # later repeats are ignored
    report = {"status": "pass", "date": "2026-12-14", "model": "m", "task_set": 2, "mode": "full"}
    return {**report, "rows": rows, **override}


def answers_for(review, reviewer, verdict_of):
    return [
        {
            "reviewer": reviewer,
            "item": item["item"],
            "answer": verdict_of(item),
            "confidence": "sure",
        }
        for item in review["items"]
    ]


def test_the_packet_has_twenty_items_plus_six_controls_shuffled_per_reviewer():
    review = br.packet(run(), PRICES, "top", seed=7)

    assert len(review["items"]) == 26
    controls = [item for item in review["items"] if item["control"]]
    assert sorted(item["control"] for item in controls) == ["cheapest"] * 3 + ["top"] * 3
    assert {item["model"] for item in controls if item["control"] == "cheapest"} == {"cheap"}
    assert review["orders"]["R1"] != review["orders"]["R2"]
    assert sorted(review["orders"]["R1"]) == sorted(item["item"] for item in review["items"])


def test_the_same_seed_gives_the_same_packet():
    assert br.packet(run(), PRICES, "top", seed=3) == br.packet(run(), PRICES, "top", seed=3)


def test_item_ids_do_not_reveal_which_items_are_controls():
    review = br.packet(run(), PRICES, "top", seed=11)

    positions = [n for n, item in enumerate(review["items"]) if item["control"]]

    assert positions != list(range(20, 26))


def test_the_packet_builder_refuses_fewer_than_twenty_recommendations():
    with pytest.raises(br.ReviewError, match="needs 20"):
        br.packet(run(size=19), PRICES, "top")


def test_the_packet_builder_refuses_a_run_with_a_failed_analysis():
    report = run()
    del report["rows"][4]["recommended"]

    with pytest.raises(br.ReviewError, match="no recommendation for: t04"):
        br.packet(report, PRICES, "top")


def test_the_packet_builder_refuses_a_not_run_or_illustrative_run():
    with pytest.raises(br.ReviewError, match="NOT RUN"):
        br.packet(run(status="not_run"), PRICES, "top")
    report = run()
    report["rows"][0]["illustrative"] = True
    with pytest.raises(br.ReviewError, match="illustrative"):
        br.packet(report, PRICES, "top")


def test_review_scoring_counts_majority_and_passes_at_sixteen():
    review = br.packet(run(), PRICES, "top", seed=1)
    real = [item["item"] for item in review["items"] if not item["control"]]
    wrong = set(real[:4])  # 16 of 20 judged correct by everyone

    answers = []
    for reviewer in ("R1", "R2", "R3"):
        answers += answers_for(review, reviewer, lambda item: "D" if item["item"] in wrong else "A")
    result = br.score(review, answers)

    assert result["correct"] == 16 and result["out_of"] == 20 and result["passes"]
    assert result["agreement"]["kind"] == "fleiss" and result["agreement"]["kappa"] == 1.0


def test_two_reviewers_who_split_make_the_item_not_correct():
    review = br.packet(run(), PRICES, "top", seed=1)
    split = next(item["item"] for item in review["items"] if not item["control"])

    answers = answers_for(review, "R1", lambda item: "A")
    answers += answers_for(review, "R2", lambda item: "C" if item["item"] == split else "B")
    result = br.score(review, answers)

    assert result["splits"] == [split]
    assert result["items"][split]["correct"] is False
    assert result["correct"] == 19
    assert result["agreement"]["kind"] == "cohen"


def test_a_missing_answer_uses_the_other_reviewers_and_is_listed_as_a_gap():
    review = br.packet(run(), PRICES, "top", seed=1)
    missing = next(item["item"] for item in review["items"] if not item["control"])

    answers = [a for a in answers_for(review, "R1", lambda item: "A") if a["item"] != missing]
    answers += answers_for(review, "R2", lambda item: "A")
    answers += answers_for(review, "R3", lambda item: "A")
    result = br.score(review, answers)

    assert result["gaps"] == [{"reviewer": "R1", "item": missing}]
    assert result["items"][missing]["correct"] is True
    assert result["agreement"]["items"] == 19


def test_fewer_than_two_reviewers_is_not_run_never_a_pass():
    review = br.packet(run(), PRICES, "top", seed=1)

    result = br.score(review, answers_for(review, "R1", lambda item: "A"))

    assert result["status"] == br.NOT_RUN and "passes" not in result


def test_answers_with_a_field_beyond_reviewer_item_answer_confidence_are_rejected():
    review = br.packet(run(), PRICES, "top", seed=1)
    answers = answers_for(review, "R1", lambda item: "A")
    answers[0]["name"] = "Somebody"

    with pytest.raises(br.ReviewError, match="fields not allowed: name"):
        br.score(review, answers)


def test_controls_do_not_count_and_are_reported_per_reviewer():
    review = br.packet(run(), PRICES, "top", seed=1)

    answers = answers_for(review, "R1", lambda item: "A")
    answers += answers_for(review, "R2", lambda item: "D" if item["control"] else "A")
    result = br.score(review, answers)

    assert result["correct"] == 20
    assert result["controls_judged_correct"]["R1"] == {"cheapest": "3/3", "top": "3/3"}
    assert result["controls_judged_correct"]["R2"] == {"cheapest": "0/3", "top": "0/3"}


def test_a_control_never_repeats_the_recommended_model_of_its_task():
    report = run()
    for row in report["rows"][:10]:
        row["recommended"] = "cheap"
    for row in report["rows"][10:17]:
        row["recommended"] = "top"

    for seed in range(20):
        review = br.packet(report, PRICES, "top", seed=seed)
        real = {(item["task"], item["model"]) for item in review["items"] if not item["control"]}
        controls = [(item["task"], item["model"]) for item in review["items"] if item["control"]]
        assert len(controls) == 6 and not real & set(controls)


def test_the_packet_refuses_when_too_few_tasks_can_hold_a_control():
    report = run()
    for row in report["rows"]:
        row["recommended"] = "cheap"
    report["rows"][0]["recommended"] = "mid"

    with pytest.raises(br.ReviewError, match="cheapest controls need 3"):
        br.packet(report, PRICES, "top")


def test_the_packet_needs_a_full_run_of_task_set_two():
    with pytest.raises(br.ReviewError, match="task set 2"):
        br.packet(run(task_set=1), PRICES, "top")
    with pytest.raises(br.ReviewError, match="mode 'subset'"):
        br.packet(run(mode="subset"), PRICES, "top")


def test_a_duplicate_answer_or_an_unknown_reviewer_is_rejected():
    review = br.packet(run(), PRICES, "top", seed=1)
    answers = answers_for(review, "R1", lambda item: "A")
    answers += answers_for(review, "R2", lambda item: "A")

    with pytest.raises(br.ReviewError, match="R1 answered I01 twice"):
        br.score(review, [*answers, {**answers[0], "item": "I01"}, {**answers[0], "item": "I01"}])
    with pytest.raises(br.ReviewError, match="reviewer 'R4' is not in the packet"):
        br.score(review, [*answers, *answers_for(review, "R4", lambda item: "A")])


def test_the_score_reports_how_many_items_had_a_missing_answer():
    review = br.packet(run(), PRICES, "top", seed=1)
    real = [item["item"] for item in review["items"] if not item["control"]]
    answers = [a for a in answers_for(review, "R1", lambda item: "A") if a["item"] not in real[:2]]
    answers += answers_for(review, "R2", lambda item: "A")

    assert br.score(review, answers)["items_with_gaps"] == 2
