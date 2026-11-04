"""The ranking and clarification policy must not change unless an ADR says so.

The golden file was produced by the e886924 policy (see policy_grid.py). Cards that touch
assessment.py or workflow.py keep this test green; an intended change regenerates the file
in the same PR and names the ADR in the commit message.
"""

import pytest
from policy_grid import current, load_golden
from profile_samples import profile_data
from test_profiles import analyse


def test_policy_outcomes_match_the_recorded_baseline():
    golden = load_golden()
    actual = current()
    assert set(actual) == set(golden)
    changed = [key for key in sorted(golden) if actual[key] != golden[key]]
    assert not changed, f"{len(changed)} profiles changed, first {changed[0]}: " + (
        f"{golden[changed[0]]} -> {actual[changed[0]]}"
    )


@pytest.mark.parametrize(
    ("scores", "expected"),
    [
        ({}, "demo-small"),
        ({"reasoning": 3}, "demo-advanced"),
        ({"context": 2}, "demo-balanced"),
        ({"reasoning": None}, "demo-balanced"),
    ],
)
def test_sample_profiles_keep_their_recommendation(scores, expected):
    response = analyse(profile_data(**scores))
    assert response.status_code == 200
    assert response.json()["recommendation"]["id"] == expected
