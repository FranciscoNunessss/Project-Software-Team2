import pytest

from scripts.evaluate_m1 import evaluate


def labelled_tasks(correct_count=16):
    tasks = []
    for index in range(20):
        expected = "Medium" if index < correct_count else "Small"
        tasks.append(
            {
                "task_id": f"synthetic-{index + 1:02}",
                "recommended_tier": expected,
                "reviewers": [
                    {"reviewer_id": "R1", "acceptable_tiers": ["Medium"]},
                    {"reviewer_id": "R2", "acceptable_tiers": ["Medium"]},
                ],
            }
        )
    return {"task_set_version": "synthetic-test-only", "tasks": tasks}


def test_m1_uses_majority_human_labels_and_wilson_interval():
    result = evaluate(labelled_tasks())

    assert result["correct"] == 16
    assert result["total"] == 20
    assert result["target_16_of_20_met"] is True
    assert result["wilson_95_ci"][0] == pytest.approx(0.584, abs=0.002)
    assert result["wilson_95_ci"][1] == pytest.approx(0.919, abs=0.002)


def test_m1_does_not_claim_target_result_for_a_non_20_task_set():
    data = labelled_tasks()
    data["tasks"] = data["tasks"][:2]

    result = evaluate(data)

    assert result["target_16_of_20_met"] is None
    assert result["target_status"] == "requires exactly 20 tasks"


def test_m1_requires_the_same_two_or_three_reviewers_for_every_task():
    data = labelled_tasks()
    data["tasks"][1]["reviewers"][1]["reviewer_id"] = "R3"

    with pytest.raises(ValueError, match="same reviewers"):
        evaluate(data)


def test_m1_rejects_a_single_reviewer():
    data = labelled_tasks()
    data["tasks"][0]["reviewers"] = data["tasks"][0]["reviewers"][:1]

    with pytest.raises(ValueError, match="two or three human reviewers"):
        evaluate(data)


def test_m1_rejects_malformed_input_with_a_value_error():
    with pytest.raises(ValueError, match="JSON object"):
        evaluate([])

    data = labelled_tasks()
    data["tasks"][0]["reviewers"] = ["R1", "R2"]
    with pytest.raises(ValueError, match="must be an object"):
        evaluate(data)


def test_m1_rejects_duplicate_task_ids():
    data = labelled_tasks()
    data["tasks"][1]["task_id"] = data["tasks"][0]["task_id"]

    with pytest.raises(ValueError, match="duplicate task_id"):
        evaluate(data)
