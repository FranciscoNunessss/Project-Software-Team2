"""Feedback per task and the choice recorded on Send (ADR-014)."""

import json

import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data
from test_recommendation import card, catalogue

PASSWORD = "correct horse battery"


def account(client, email="alice@example.com"):
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    return client


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(_env_file=None))


def analyse(client, task="Summarise the private report"):
    return client.post("/api/analyze", json={"task": task}).json()


def test_outcome_once_per_task_owner_only_and_without_text(app, tmp_path):
    alice, bob = account(TestClient(app)), account(TestClient(app), "bob@example.com")
    result = analyse(alice)
    path = f"/api/analyses/{result['id']}/outcome"
    assert alice.get(path).status_code == 404
    assert bob.put(path, json={"outcome": "resolved"}).status_code == 404
    saved = alice.put(
        path, json={"outcome": "resolved_with_refinement", "turns": 3, "switched_model": True}
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["outcome"] == "resolved_with_refinement"
    assert body["recommended_card_id"] == result["recommendation"]["id"]
    assert body["turns"] == 3 and body["switched_model"] is True
    assert alice.put(path, json={"outcome": "resolved"}).status_code == 409
    assert alice.get(path).json()["outcome"] == "resolved_with_refinement"
    with app.state.storage.connect() as db:
        stored = json.dumps(db.execute("SELECT * FROM task_outcomes").fetchall())
    assert "private report" not in stored


def test_skip_is_final_and_reason_only_for_not_resolved(app):
    client = account(TestClient(app))
    first, second = analyse(client), analyse(client)
    bad = client.put(
        f"/api/analyses/{first['id']}/outcome", json={"outcome": "resolved", "reason": "quality"}
    )
    assert bad.status_code == 422
    path = f"/api/analyses/{first['id']}/outcome"
    assert client.put(path, json={"outcome": "skipped"}).status_code == 200
    assert client.put(path, json={"outcome": "resolved"}).status_code == 409
    failed = client.put(
        f"/api/analyses/{second['id']}/outcome",
        json={"outcome": "not_resolved", "reason": "description"},
    )
    assert failed.json()["reason"] == "description"
    summary = client.get("/api/progress/outcomes").json()
    assert summary["tasks"] == 1 and summary["skipped"] == 1
    assert summary["not_resolved"] == 1 and summary["described_poorly"] == 1


def test_outcomes_are_deleted_with_the_session_and_the_history(app, tmp_path):
    client = account(TestClient(app))
    result = analyse(client)
    client.put(f"/api/analyses/{result['id']}/outcome", json={"outcome": "resolved"})
    assert client.delete(f"/api/sessions/{result['session_id']}").status_code == 200
    other = analyse(client)
    client.put(f"/api/analyses/{other['id']}/outcome", json={"outcome": "resolved"})
    assert client.delete("/api/progress/history").status_code == 200
    with app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM task_outcomes").fetchone()[0] == 0


def test_an_illustrative_recommendation_cannot_be_followed(app):
    # Phase 1.1: the demo cards are not real models, so "followed" stays unknown (None),
    # but the model used is always stored.
    client = account(TestClient(app))
    result = analyse(client)
    other = result["alternatives"][0]["id"]
    client.post("/api/decisions", json={"analysis_id": result["id"], "candidate_id": other})
    body = client.put(
        f"/api/analyses/{result['id']}/outcome",
        json={"outcome": "resolved", "provider": "groq", "model": "openai/gpt-oss-20b"},
    ).json()
    assert body["followed_recommendation"] is None
    assert (body["used_provider"], body["used_model"]) == ("groq", "openai/gpt-oss-20b")
    summary = client.get("/api/progress/outcomes").json()
    assert summary["solved_rate_following"] is None and summary["followed"] == 0
    assert summary["by_model"] == [{"model": "groq · openai/gpt-oss-20b", "tasks": 1, "solved": 1}]


def real_models(monkeypatch):
    small = card("small", 1, 0.1)
    small["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-20b"}]
    large = card("large", 3, 1.0)
    large["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-120b"}]
    test_catalogue = catalogue(small, large)
    for target in ("app.workflow", "app.chat", "app.outcomes"):
        monkeypatch.setattr(f"{target}.active_catalogue", lambda: test_catalogue)

    class Assessor:
        async def assess(self, task):
            return Assessment(profile=Profile.model_validate(profile_data(reasoning=3)))

    settings = Settings(
        _env_file=None,
        groq_models="openai/gpt-oss-20b,openai/gpt-oss-120b",
        groq_api_key="synthetic",
    )
    return account(TestClient(create_app(settings, {"groq": Assessor()})))


def analyse_real(client):
    return client.post(
        "/api/analyze", json={"task": "Prove it", "provider": "auto", "allow_external": True}
    ).json()


def test_followed_is_yes_or_no_from_the_model_actually_used(monkeypatch):
    client = real_models(monkeypatch)
    first = analyse_real(client)
    assert first["recommendation"]["model"] == "openai/gpt-oss-120b"
    same = client.put(
        f"/api/analyses/{first['id']}/outcome",
        json={"outcome": "resolved", "provider": "groq", "model": "openai/gpt-oss-120b"},
    ).json()
    assert same["followed_recommendation"] is True and same["model_card_id"] == "large"
    second = analyse_real(client)
    other = client.put(
        f"/api/analyses/{second['id']}/outcome",
        json={"outcome": "not_resolved", "provider": "groq", "model": "openai/gpt-oss-20b"},
    ).json()
    assert other["followed_recommendation"] is False and other["model_card_id"] == "small"
    # A model without a catalogue card: stored as used, and not the recommendation.
    third = analyse_real(client)
    unknown = client.put(
        f"/api/analyses/{third['id']}/outcome",
        json={"outcome": "resolved", "provider": "openrouter", "model": "some/other-model"},
    ).json()
    assert unknown["model_card_id"] is None and unknown["followed_recommendation"] is False
    assert unknown["used_model"] == "some/other-model"
    summary = client.get("/api/progress/outcomes").json()
    assert summary["followed"] == 1
    assert summary["solved_rate_following"] == 100 and summary["solved_rate_not_following"] == 50
    names = {item["model"] for item in summary["by_model"]}
    assert names == {"large", "small", "openrouter · some/other-model"}


def test_without_the_model_used_the_recorded_choice_decides(monkeypatch):
    client = real_models(monkeypatch)
    result = analyse_real(client)
    client.post(
        "/api/decisions",
        json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
    )
    body = client.put(f"/api/analyses/{result['id']}/outcome", json={"outcome": "resolved"}).json()
    assert body["followed_recommendation"] is True
    assert body["used_model"] == "openai/gpt-oss-120b"


@pytest.mark.chat
def test_send_records_the_choice_and_chat_shows_the_outcome(tmp_path, monkeypatch):
    small = card("small", 1, 0.1)
    small["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-20b"}]
    large = card("large", 3, 1.0)
    large["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-120b"}]
    test_catalogue = catalogue(small, large)
    for target in ("app.workflow", "app.chat", "app.outcomes"):
        monkeypatch.setattr(f"{target}.active_catalogue", lambda: test_catalogue)

    class Assessor:
        async def assess(self, task):
            return Assessment(profile=Profile.model_validate(profile_data(reasoning=3)))

    class Echo:
        def __init__(self, *_args):
            pass

        async def stream(self, _messages):
            yield "answer"

    settings = Settings(
        _env_file=None,
        groq_models="openai/gpt-oss-20b,openai/gpt-oss-120b",
        groq_api_key="synthetic",
    )
    app = create_app(settings, {"groq": Assessor()}, chat_options={"model_factory": Echo})
    client = account(TestClient(app))
    chat = client.post("/api/chats").json()
    result = client.post(
        "/api/analyze",
        json={
            "task": "Prove it",
            "provider": "auto",
            "allow_external": True,
            "session_id": chat["id"],
        },
    ).json()
    assert result["recommendation"]["configuration_id"] == "server:groq:openai/gpt-oss-120b"
    sent = client.post(
        f"/api/chats/{chat['id']}/messages",
        json={
            "content": "Prove it",
            "configuration_id": "server:groq:openai/gpt-oss-120b",
            "analysis_id": result["id"],
            "allow_external": True,
        },
    )
    assert sent.status_code == 200, sent.text
    assert sent.json()["message"]["outcome"] is None
    progress = client.get("/api/progress").json()
    assert progress["choices"] == 1 and progress["matches"] == 1
    feedback = client.put(
        f"/api/analyses/{result['id']}/outcome",
        json={"outcome": "resolved", "provider": "groq", "model": "openai/gpt-oss-120b"},
    ).json()
    assert feedback["model_card_id"] == "large" and feedback["followed_recommendation"] is True
    messages = client.get(f"/api/chats/{chat['id']}").json()["messages"]
    assert messages[0]["outcome"] == "resolved"


def test_a_task_described_poorly_points_the_next_one_to_the_description(app):
    client = account(TestClient(app))
    first = analyse(client)
    assert not any("described" in note or "description first" in note for note in first["notes"])
    client.put(
        f"/api/analyses/{first['id']}/outcome",
        json={"outcome": "not_resolved", "reason": "description"},
    )
    second = analyse(client)
    assert "improve this description first" in second["notes"][0]
    client.put(f"/api/analyses/{second['id']}/outcome", json={"outcome": "resolved"})
    assert not any("description first" in note for note in analyse(client)["notes"])


def test_the_educator_receives_outcome_counts_without_text(app):
    from app.coaching import snapshot

    client = account(TestClient(app))
    result = analyse(client)
    client.put(f"/api/analyses/{result['id']}/outcome", json={"outcome": "resolved"})
    owner = client.get("/api/auth/me").json()["id"]
    _, metadata = snapshot(app.state.storage, owner)
    assert metadata["task_outcomes"]["tasks"] == 1
    assert "private report" not in json.dumps(metadata)
