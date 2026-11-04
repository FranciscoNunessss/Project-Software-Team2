"""Graded recommendation and partial-credit agreement. Expected values pin the initial,
uncalibrated parameters; they are regression fixtures, not validated labels."""

import pytest
from app.assessment import POLICY_VERSION, demand_estimate, tier_fit
from app.main import agreement_percent, create_app
from app.models import Candidate, Profile
from app.providers import Settings
from app.workflow import rank
from fastapi.testclient import TestClient
from profile_samples import profile_data


def profile(confidence="medium", modality=None, **scores):
    data = profile_data(**scores)
    for key in ("reasoning", "context"):
        if data[key]["score"] is not None:
            data[key]["confidence"] = confidence
    if modality:
        data["modality"]["required"] = modality
    return Profile.model_validate(data)


@pytest.mark.parametrize(
    ("task_profile", "tier", "fit"),
    [
        (profile("high", reasoning=1, context=1), "demo-small", 0.98),
        (profile("medium", reasoning=2, context=1), "demo-balanced", 0.85),
        (profile("high", reasoning=3, context=2), "demo-advanced", 0.93),
        (profile("medium", reasoning=2, context=None, ambiguity=2), "demo-balanced", 0.76),
        (profile(reasoning=None, context=None, ambiguity=None), "demo-balanced", 0.68),
    ],
)
def test_fixed_cases_recommend_highest_estimated_fit(task_profile, tier, fit):
    best = rank(task_profile, ["text"])[0]
    assert best.id == tier
    assert best.fit == pytest.approx(fit, abs=0.01)


def test_fit_never_exceeds_sufficiency():
    for reasoning in (1, 2, 3, None):
        for context in (1, 2, 3, None):
            for candidate in rank(profile(reasoning=reasoning, context=context), ["text"]):
                assert 0 <= candidate.fit <= candidate.sufficiency <= 1


def test_results_recorded_before_grading_still_validate():
    candidate = Candidate.model_validate(
        {"id": "demo-small", "name": "Small", "capacity": 1, "capabilities": ["text"]}
    )
    assert candidate.sufficiency is None and candidate.fit is None


def test_large_tier_is_always_sufficient_but_poor_fit_for_simple_task():
    large = next(
        item
        for item in rank(profile("high", reasoning=1, context=1), ["text"])
        if item.id == "demo-advanced"
    )
    assert large.sufficiency == 1
    assert large.fit < 0.35


def test_vision_only_task_is_limited_to_the_large_tier():
    candidates = rank(profile("high", modality=["image"], reasoning=1, context=1), ["vision"])
    assert [item.id for item in candidates] == ["demo-advanced"]


def test_domain_risk_and_tools_do_not_raise_the_tier():
    plain = rank(profile(reasoning=1, context=1), ["text"])
    demanding = rank(profile(reasoning=1, context=1, domain=3, risk=3, tools=3), ["text"])
    assert demanding[0].id == plain[0].id == "demo-small"
    assert demand_estimate(profile(reasoning=1, context=1, domain=3, tools=3))[0] == 1


def test_tier_fit_penalises_capacity_above_demand():
    sufficiency, fit = tier_fit(3, 1.0, 0.25)
    assert sufficiency == 1
    assert fit < tier_fit(2, 1.0, 0.25)[1]


def test_agreement_gives_partial_credit_by_tier_distance():
    assert agreement_percent([]) is None
    assert agreement_percent([0]) == 100
    assert agreement_percent([1]) == agreement_percent([-1]) == 50
    assert agreement_percent([2]) == 0
    assert agreement_percent([0, 2]) == 50


def test_choice_one_tier_away_earns_half_credit_end_to_end():
    client = TestClient(create_app(Settings(_env_file=None)))
    response = client.post(
        "/api/auth/register",
        json={"email": "alice@example.com", "password": "test-password-123"},
    )
    assert response.status_code == 201
    result = client.post("/api/analyze", json={"task": "Summarise a short note"}).json()
    assert result["policy_version"] == POLICY_VERSION
    assert result["grading"]["basis"] == "Uncalibrated estimate; not a probability"
    recommended = result["recommendation"]
    assert recommended["fit"] == max(item["fit"] for item in [recommended, *result["alternatives"]])
    neighbour = next(
        item
        for item in result["alternatives"]
        if abs(item["capacity"] - recommended["capacity"]) == 1
    )
    assert (
        client.post(
            "/api/decisions", json={"analysis_id": result["id"], "candidate_id": neighbour["id"]}
        ).status_code
        == 200
    )
    progress = client.get("/api/progress").json()
    assert progress["agreement"] == 50
    assert abs(progress["mean_gap"]) == 1
    point = client.get("/api/progress/dashboard").json()["series"][0]
    assert point["rate"] == 0
    assert point["score"] == 50
