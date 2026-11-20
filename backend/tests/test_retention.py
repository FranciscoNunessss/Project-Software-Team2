"""Optional expiry of old history (app/retention.py): off by default, keeps what it should."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.main import create_app
from app.providers import Settings
from app.retention import cutoff, purge
from fastapi.testclient import TestClient

ORIGIN = {"Origin": "http://127.0.0.1:8443"}
OLD = "2020-01-01T00:00:00.000Z"


def person(app):
    client = TestClient(app, headers=ORIGIN)
    email = f"{uuid4()}@example.com"
    response = client.post(
        "/api/auth/register", json={"email": email, "password": "test-password-123"}
    )
    assert response.status_code == 201
    return client


def analyse(client):
    response = client.post("/api/analyze", json={"task": "Plan a trip", "provider": "demo"})
    assert response.status_code == 200, response.text
    return response.json()


def age(app, session_id, when=OLD):
    with app.state.storage.connect() as db:
        db.execute("UPDATE sessions SET created_at=%s WHERE id=%s", (when, session_id))
        db.execute("UPDATE analyses SET created_at=%s WHERE session_id=%s", (when, session_id))


def build():
    return create_app(Settings(_env_file=None))


def test_it_is_off_by_default_and_a_zero_never_deletes():
    assert Settings(_env_file=None).retention_days == 0
    app = build()
    client = person(app)
    session = analyse(client)["session_id"]
    age(app, session)
    assert purge(app.state.storage, 0) == 0
    assert len(client.get("/api/sessions").json()) == 1


def test_an_old_session_is_deleted_with_its_analyses_and_a_recent_one_stays():
    app = build()
    client = person(app)
    old = analyse(client)["session_id"]
    recent = analyse(client)["session_id"]
    age(app, old)
    assert purge(app.state.storage, 365) == 1
    ids = [item["id"] for item in client.get("/api/sessions").json()]
    assert ids == [recent]
    with app.state.storage.connect() as db:
        assert (
            db.execute("SELECT count(*) FROM analyses WHERE session_id=%s", (old,)).fetchone()[0]
            == 0
        )


def test_the_account_the_preferences_and_other_people_are_untouched():
    app = build()
    alice, bob = person(app), person(app)
    alice_old = analyse(alice)["session_id"]
    analyse(bob)
    age(app, alice_old)
    assert alice.put("/api/context", json={"content": "I prefer short answers."}).status_code == 200
    assert purge(app.state.storage, 30) == 1
    assert alice.get("/api/auth/me").status_code == 200
    assert alice.get("/api/context").json()["content"] == "I prefer short answers."
    assert len(bob.get("/api/sessions").json()) == 1


def test_the_saved_coaching_advice_of_a_person_who_lost_history_is_deleted_too():
    app = build()
    client = person(app)
    session = analyse(client)["session_id"]
    user_id = client.get("/api/auth/me").json()["id"]
    with app.state.storage.connect() as db:
        db.execute(
            "INSERT INTO coaching_reports(user_id, fingerprint, model, report_json) "
            "VALUES (%s, 'f', 'm', '{}')",
            (user_id,),
        )
    age(app, session)
    purge(app.state.storage, 30)
    with app.state.storage.connect() as db:
        count = db.execute(
            "SELECT count(*) FROM coaching_reports WHERE user_id=%s", (user_id,)
        ).fetchone()[0]
    assert count == 0


@pytest.mark.chat
def test_a_session_with_a_recent_chat_message_is_not_expired():
    app = build()
    client = person(app)
    chat = client.post("/api/chats").json()["id"]
    with app.state.storage.connect() as db:
        db.execute(
            "INSERT INTO chat_messages(id, session_id, role, content) "
            "VALUES (%s, %s, 'user', 'hi')",
            (str(uuid4()), chat),
        )
        db.execute("UPDATE sessions SET created_at=%s WHERE id=%s", (OLD, chat))
    assert purge(app.state.storage, 30) == 0
    assert client.get(f"/api/chats/{chat}").status_code == 200


def test_the_cutoff_is_the_given_days_before_now():
    now = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)
    assert cutoff(30, now) == "2026-10-18T12:00:00.000Z"
    assert cutoff(1, now - timedelta(days=0)) == "2026-11-16T12:00:00.000Z"


def test_the_startup_job_is_only_installed_when_a_period_is_set():
    app = create_app(Settings(_env_file=None, retention_days=30, evaluations_worker=False))
    with TestClient(app):
        assert hasattr(app.state, "retention_task")
    off = create_app(Settings(_env_file=None, evaluations_worker=False))
    with TestClient(off):
        assert not hasattr(off.state, "retention_task")
