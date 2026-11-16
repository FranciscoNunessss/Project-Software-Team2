"""The Educator on synthetic usage histories with control cases (AA-012, AA-013, KR2.1)."""

import json

import pytest
from app.coaching import (
    MIN_PATTERN_CHOICES,
    PATTERN_SENTENCE,
    CoachingReport,
    educator_prompt,
    snapshot,
    usage_patterns,
)
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient
from test_progress import REPORT
from usage_histories import GAP, HISTORIES

TASK = "SYNTHETIC_TASK_SENTINEL"
BY_NAME = {history.name: history for history in HISTORIES}


def account(app, email="synthetic@example.com"):
    client = TestClient(app)
    registered = client.post(
        "/api/auth/register", json={"email": email, "password": "test-password-123"}
    )
    assert registered.status_code == 201
    return client


def user_of(client):
    return client.get("/api/auth/me").json()["id"]


def choose(app, client, kind):
    """One simulated task: analyse it and, unless pending, confirm a choice of that kind.

    The demonstration assessor always recommends its largest model, so a larger choice
    cannot be made through the interface; the stored analysis is rewritten so its first
    alternative has the gap the history asks for (one is added when the analysis offers
    none). The choice itself goes through the API.
    """
    result = client.post("/api/analyze", json={"task": TASK})
    assert result.status_code == 200
    result = result.json()
    if kind == "pending":
        return
    candidate = result["recommendation"]["id"]
    if kind != "match":
        with app.state.storage.connect() as db:
            stored = json.loads(
                db.execute(
                    "SELECT result_json FROM analyses WHERE id=%s", (result["id"],)
                ).fetchone()[0]
            )
            if not stored["alternatives"]:
                stored["alternatives"].append(
                    stored["recommendation"] | {"id": "synthetic-alternative"}
                )
            stored["alternatives"][0]["gap"] = GAP[kind]
            candidate = stored["alternatives"][0]["id"]
            db.execute(
                "UPDATE analyses SET result_json=%s WHERE id=%s",
                (json.dumps(stored), result["id"]),
            )
    confirmed = client.post(
        "/api/decisions", json={"analysis_id": result["id"], "candidate_id": candidate}
    )
    assert confirmed.status_code == 200


def play(app, client, history):
    for kind in history.choices:
        choose(app, client, kind)


def counts(history):
    confirmed = [kind for kind in history.choices if kind != "pending"]
    return len(confirmed), confirmed.count("over"), confirmed.count("under")


def test_the_histories_cover_each_pattern_and_several_controls():
    names = [history.name for history in HISTORIES]
    assert len(names) == len(set(names))
    assert sum(history.over == "detected" for history in HISTORIES) >= 1
    assert sum(history.under == "detected" for history in HISTORIES) >= 1
    controls = [history for history in HISTORIES if history.name.startswith("control_")]
    assert len(controls) >= 3
    assert all("detected" != verdict for c in controls for verdict in (c.over, c.under))


@pytest.mark.parametrize("history", HISTORIES, ids=lambda history: history.name)
def test_the_rule_gives_the_expected_verdict_for_each_history(history):
    confirmed, over, under = counts(history)
    verdict = usage_patterns([GAP[kind] for kind in history.choices if kind != "pending"])
    assert verdict["confirmed_choices"] == confirmed
    assert verdict["min_choices"] == MIN_PATTERN_CHOICES
    assert verdict["over_provisioning"]["status"] == history.over, history.why
    assert verdict["under_provisioning"]["status"] == history.under, history.why
    assert verdict["over_provisioning"]["count"] == over
    assert verdict["under_provisioning"]["count"] == under


def test_the_rule_reports_shares_and_never_both_patterns_at_once():
    verdict = usage_patterns([1, 1, 1, -1, 0, 0, 0, 0])
    assert verdict["over_provisioning"] == {"status": "not_detected", "count": 3, "share": 0.38}
    assert verdict["under_provisioning"] == {"status": "not_detected", "count": 1, "share": 0.12}
    assert usage_patterns([])["over_provisioning"]["share"] is None
    for larger in range(0, 9):
        for smaller in range(0, 9 - larger):
            both = usage_patterns([1] * larger + [-1] * smaller + [0] * (8 - larger - smaller))
            detected = [
                name
                for name in ("over_provisioning", "under_provisioning")
                if both[name]["status"] == "detected"
            ]
            assert len(detected) <= 1


def test_tier_era_gaps_larger_than_one_count_like_any_other():
    # Analyses stored with the tier policy have gaps of two tiers; only the sign matters.
    verdict = usage_patterns([2, 2, 1, 0, -2])
    assert verdict["over_provisioning"]["status"] == "detected"
    assert verdict["under_provisioning"]["status"] == "not_detected"


@pytest.mark.parametrize("history", HISTORIES, ids=lambda history: history.name)
def test_my_progress_and_the_educator_see_the_same_verdict(history):
    app = create_app(Settings(_env_file=None))
    client = account(app)
    play(app, client, history)
    confirmed, over, under = counts(history)

    dashboard = client.get("/api/progress/dashboard").json()
    assert (dashboard["over"], dashboard["under"]) == (over, under)
    assert dashboard["patterns"]["over_provisioning"]["status"] == history.over, history.why
    assert dashboard["patterns"]["under_provisioning"]["status"] == history.under, history.why
    assert dashboard["patterns"]["confirmed_choices"] == confirmed

    _, metadata = snapshot(app.state.storage, user_of(client))
    assert metadata["usage_patterns"] == dashboard["patterns"]
    assert metadata["metrics"]["confirmed_choices"] == confirmed
    assert metadata["metrics"]["pending_choices"] == len(history.choices) - confirmed
    assert metadata["metrics"]["larger_than_recommended"] == over
    assert metadata["metrics"]["smaller_than_recommended"] == under
    assert TASK not in json.dumps(metadata)
    assert TASK not in json.dumps(dashboard)


def test_a_history_belongs_to_one_user_only():
    app = create_app(Settings(_env_file=None))
    habit, control = account(app), account(app, "control@example.com")
    play(app, habit, BY_NAME["over_provisioning"])
    play(app, control, BY_NAME["control_follows_recommendation"])
    seen = control.get("/api/progress/dashboard").json()["patterns"]
    assert seen["over_provisioning"] == {"status": "not_detected", "count": 0, "share": 0.0}
    _, metadata = snapshot(app.state.storage, user_of(habit))
    assert metadata["usage_patterns"]["over_provisioning"]["status"] == "detected"


def test_a_detected_pattern_disappears_when_later_choices_follow_the_recommendation():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    play(app, client, BY_NAME["over_provisioning_just_above_half"])
    before, metadata = snapshot(app.state.storage, user_of(client))
    assert metadata["usage_patterns"]["over_provisioning"]["status"] == "detected"
    choose(app, client, "match")
    after, metadata = snapshot(app.state.storage, user_of(client))
    assert metadata["usage_patterns"]["over_provisioning"] == {
        "status": "not_detected",
        "count": 3,
        "share": 0.5,
    }
    assert before != after  # A saved coaching report goes stale with the verdict.


def test_clearing_the_history_clears_the_verdict():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    play(app, client, BY_NAME["under_provisioning"])
    assert client.delete("/api/progress/history").status_code == 200
    patterns = client.get("/api/progress/dashboard").json()["patterns"]
    assert patterns["confirmed_choices"] == 0
    assert patterns["under_provisioning"]["status"] == "insufficient_history"


def test_the_educator_is_told_to_follow_the_verdict():
    assert PATTERN_SENTENCE in educator_prompt()
    for word in ("detected", "not_detected", "insufficient_history", "never contradict"):
        assert word in PATTERN_SENTENCE


@pytest.mark.parametrize(
    "name",
    ["over_provisioning", "under_provisioning", "control_occasional_deviation"],
)
def test_the_coaching_model_receives_the_verdict_and_the_users_own_counts(monkeypatch, name):
    """AA-013: the suggestion is written from this user's history, not generic advice."""
    received = []

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            received.append(metadata)
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    history = BY_NAME[name]
    play(app, client, history)
    generated = client.post(
        "/api/progress/coaching",
        json={"allow_external": True, "expected_model": app.state.settings.groq_model},
    )
    assert generated.status_code == 200
    confirmed, over, under = counts(history)
    (metadata,) = received
    assert metadata["usage_patterns"]["over_provisioning"]["status"] == history.over
    assert metadata["usage_patterns"]["under_provisioning"]["status"] == history.under
    assert metadata["usage_patterns"]["over_provisioning"]["count"] == over
    assert metadata["usage_patterns"]["under_provisioning"]["count"] == under
    assert len(metadata["assessments"]) == len(history.choices)
    assert TASK not in json.dumps(metadata)
