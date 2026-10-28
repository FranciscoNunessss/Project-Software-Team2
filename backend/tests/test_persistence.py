import hashlib
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

PASSWORD = "test-password-123"


def account(client, email="alice@example.com"):
    response = client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    assert response.status_code == 201
    return response.json()


def test_accounts_and_password_storage():
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/analyze", json={"task": "Test"}).status_code == 401
    user = account(client, "Alice@Example.com")
    assert user["email"] == "alice@example.com"
    cookie = client.cookies.get("adaptai_session")
    with app.state.storage.connect() as db:
        saved = db.execute("SELECT password_hash FROM users").fetchone()[0]
        assert saved != PASSWORD and PASSWORD not in saved
        assert db.execute("SELECT token_hash FROM auth_sessions").fetchone()[0] == (
            hashlib.sha256(cookie.encode()).hexdigest()
        )
    assert client.get("/api/auth/me").json() == user
    assert (
        client.post(
            "/api/auth/register", json={"email": user["email"], "password": PASSWORD}
        ).status_code
        == 409
    )
    assert client.post("/api/auth/logout").status_code == 200
    client.cookies.set("adaptai_session", cookie)
    assert client.get("/api/auth/me").status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"email": user["email"], "password": "wrong-password-123"}
        ).status_code
        == 401
    )
    login = client.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD})
    assert login.status_code == 200
    assert "HttpOnly" in login.headers["set-cookie"]
    assert "SameSite=lax" in login.headers["set-cookie"]
    with app.state.storage.connect() as db:
        db.execute("UPDATE auth_sessions SET expires_at=?", (int(time.time()) - 1,))
    assert client.get("/api/auth/me").status_code == 401


def test_restart_preserves_login_history_and_decisions():
    settings = Settings(_env_file=None)
    first = TestClient(create_app(settings))
    account(first)
    session = first.post(
        "/api/sessions", json={"title": "Project", "context": "For students"}
    ).json()
    result = first.post(
        "/api/analyze", json={"task": "Explain an API", "session_id": session["id"]}
    ).json()
    second = TestClient(create_app(settings))
    second.cookies.update(first.cookies)
    assert second.get("/api/auth/me").status_code == 200
    decision = {"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]}
    assert second.post("/api/decisions", json=decision).json()["persistence"] == "database"
    assert second.post("/api/decisions", json=decision).status_code == 200
    different = {**decision, "candidate_id": result["alternatives"][0]["id"]}
    assert second.post("/api/decisions", json=different).status_code == 409
    history = second.get(f"/api/sessions/{session['id']}").json()
    assert history["context"] == "For students"
    assert history["analyses"][0]["result"] == result
    assert history["analyses"][0]["candidate_id"] == decision["candidate_id"]
    assert history["analyses"][0]["request"]["task"] == "Explain an API"
    assert history["analyses"][0]["request"]["session_context"] == "For students"
    assert second.get("/api/sessions?limit=1&offset=1").json() == []
    assert second.get(f"/api/sessions/{session['id']}?offset=1").json()["analyses"] == []
    assert second.delete(f"/api/sessions/{session['id']}").status_code == 200
    with second.app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM decisions").fetchone()[0] == 0


def test_user_isolation():
    app = create_app(Settings(_env_file=None))
    alice, bob = TestClient(app), TestClient(app)
    account(alice)
    account(bob, "bob@example.com")
    result = alice.post("/api/analyze", json={"task": "Alice private task"}).json()
    identifier = result["session_id"]
    assert bob.get("/api/sessions").json() == []
    assert bob.get(f"/api/sessions/{identifier}").status_code == 404
    assert bob.patch(f"/api/sessions/{identifier}", json={"title": "Stolen"}).status_code == 404
    assert bob.delete(f"/api/sessions/{identifier}").status_code == 404
    assert (
        bob.post("/api/analyze", json={"task": "Test", "session_id": identifier}).status_code == 404
    )
    assert (
        bob.post(
            "/api/decisions",
            json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
        ).status_code
        == 404
    )


def test_context_consent_and_updates():
    tasks = []

    class Provider:
        async def assess(self, task):
            tasks.append(task)
            return Assessment(profile=Profile.model_validate(profile_data()))

    app = create_app(Settings(_env_file=None), {"groq": Provider()})
    client = TestClient(app)
    account(client)
    session = client.post(
        "/api/sessions", json={"title": "Work", "context": "Private context"}
    ).json()
    body = {"task": "Test", "provider": "groq", "session_id": session["id"]}
    assert client.post("/api/analyze", json=body).status_code == 403
    assert tasks == []
    assert (
        client.patch(
            f"/api/sessions/{session['id']}", json={"title": "Work", "context": "Updated context"}
        ).status_code
        == 200
    )
    assert client.post("/api/analyze", json={**body, "allow_external": True}).status_code == 200
    assert tasks == ["Session context:\nUpdated context\n\nTask:\nTest"]
    assert client.get("/api/sessions").headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "path", ["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/sessions"]
)
def test_cross_origin_writes_are_rejected(path):
    client = TestClient(create_app(Settings(_env_file=None)))
    assert (
        client.post(path, json={}, headers={"Origin": "https://other.example"}).status_code == 403
    )


def test_concurrent_decisions_are_atomic():
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    account(client)
    result = client.post("/api/analyze", json={"task": "Test"}).json()

    def decide(candidate):
        with TestClient(app) as worker:
            worker.cookies.update(client.cookies)
            return worker.post(
                "/api/decisions",
                json={"analysis_id": result["id"], "candidate_id": candidate["id"]},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        statuses = list(workers.map(decide, [result["recommendation"], result["alternatives"][0]]))
    assert sorted(statuses) == [200, 409]
