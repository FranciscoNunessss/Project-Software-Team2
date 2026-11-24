"""WS4 learning data (L0, L17): indicators from stored tasks, exclusions, privacy and ownership."""

import json

import psycopg
import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery"


def account(client, email="alice@example.com"):
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    return client


@pytest.fixture
def app():
    return create_app(Settings(_env_file=None))


def analyse(client, task="Summarise the private report"):
    return client.post("/api/analyze", json={"task": task}).json()


def feedback(client, analysis, outcome="resolved", **extra):
    path = f"/api/analyses/{analysis['id']}/outcome"
    response = client.put(path, json={"outcome": outcome, **extra})
    assert response.status_code == 200, response.text


def test_new_user_has_no_levels_and_no_patterns(app):
    client = account(TestClient(app))
    body = client.get("/api/progress/indicators").json()
    assert body["tasks"] == 0 and body["overall_level"] is None and body["patterns"] == []
    assert set(body["dimensions"]) == {
        "objective",
        "context",
        "constraints",
        "risks",
        "ambiguity",
        "success_criteria",
        "audience_format",
    }


def test_model_switching_pattern_from_stored_feedback(app):
    client = account(TestClient(app))
    for index in range(5):
        feedback(client, analyse(client), switched_model=index != 1, turns=2)
    body = client.get("/api/progress/indicators").json()
    assert body["tasks"] == 5
    assert "model_switching" in [p["code"] for p in body["patterns"]]


def test_request_quality_scores_feed_the_levels(app):
    client = account(TestClient(app))
    ids = [analyse(client)["id"] for _ in range(6)]
    with app.state.storage.connect() as db:
        user = db.execute("SELECT id FROM users").fetchone()["id"]
        for analysis_id in ids:
            db.execute(
                "INSERT INTO request_quality(analysis_id,user_id,objective,success_criteria,"
                "prompt_version) VALUES (%s,%s,2,0,'test')",
                (analysis_id, user),
            )
    body = client.get("/api/progress/indicators").json()
    assert body["dimensions"]["objective"]["level"] == 4
    assert body["dimensions"]["risks"]["tasks"] == 0
    missing = [p for p in body["patterns"] if p["code"] == "missing_dimension"]
    assert [p["dimension"] for p in missing] == ["success_criteria"]


def test_excluded_task_leaves_the_indicators_and_can_be_restored(app):
    client = account(TestClient(app))
    analyses = [analyse(client) for _ in range(5)]
    for item in analyses:
        feedback(client, item, switched_model=True)
    path = f"/api/analyses/{analyses[0]['id']}/exclusion"
    assert client.put(path).status_code == 200
    body = client.get("/api/progress/indicators").json()
    assert body["tasks"] == 4 and body["patterns"] == []
    assert client.delete(path).status_code == 200
    assert client.delete(path).status_code == 404
    assert client.get("/api/progress/indicators").json()["tasks"] == 5


def test_only_the_owner_can_exclude(app):
    alice, bob = account(TestClient(app)), account(TestClient(app), "bob@example.com")
    item = analyse(alice)
    assert bob.put(f"/api/analyses/{item['id']}/exclusion").status_code == 404


def test_learning_tables_hold_no_text(app):
    client = account(TestClient(app))
    item = analyse(client, "MARKER-ws4-learning private words")
    client.put(f"/api/analyses/{item['id']}/exclusion")
    with app.state.storage.connect() as db:
        stored = json.dumps(
            [
                db.execute("SELECT * FROM learning_exclusions").fetchall(),
                db.execute("SELECT * FROM request_quality").fetchall(),
            ]
        )
    assert "MARKER" not in stored
    assert "MARKER" not in json.dumps(client.get("/api/progress/indicators").json())


def test_request_quality_rejects_scores_out_of_range(app):
    client = account(TestClient(app))
    item = analyse(client)
    with app.state.storage.connect() as db:
        user = db.execute("SELECT id FROM users").fetchone()["id"]
        with pytest.raises(psycopg.errors.CheckViolation):
            db.execute(
                "INSERT INTO request_quality(analysis_id,user_id,objective,prompt_version) "
                "VALUES (%s,%s,3,'test')",
                (item["id"], user),
            )


def test_exclusion_does_not_turn_a_paused_task_into_an_excluded_one(app):
    client = account(TestClient(app))
    item = analyse(client)
    with app.state.storage.connect() as db:
        user = db.execute("SELECT id FROM users").fetchone()["id"]
        db.execute(
            "INSERT INTO learning_exclusions(analysis_id,user_id,kind) VALUES (%s,%s,'paused')",
            (item["id"], user),
        )
    path = f"/api/analyses/{item['id']}/exclusion"
    assert client.put(path).status_code == 200
    assert client.delete(path).status_code == 404
    with app.state.storage.connect() as db:
        kind = db.execute("SELECT kind FROM learning_exclusions").fetchone()["kind"]
    assert kind == "paused"
    assert client.get("/api/progress/indicators").json()["tasks"] == 0
