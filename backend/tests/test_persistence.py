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
    assert history["context"] == ""
    assert (
        history["analyses"][0]["result"]["profile"]["reasoning"]["score"]
        == result["profile"]["reasoning"]["score"]
    )
    assert history["analyses"][0]["candidate_id"] == decision["candidate_id"]
    assert history["analyses"][0]["request"] == {}
    assert "Explain an API" not in str(history) and "For students" not in str(history)
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
    assert bob.get("/api/progress").json() == {
        "sessions": 0,
        "analyses": 0,
        "choices": 0,
        "matches": 0,
    }
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


def test_clearing_history_during_analysis_does_not_resurrect_it():
    app = None

    class Provider:
        async def assess(self, task):
            with app.state.storage.connect() as db:
                db.execute("DELETE FROM sessions")
            return Assessment(profile=Profile.model_validate(profile_data()))

    app = create_app(Settings(_env_file=None), {"groq": Provider()})
    client = TestClient(app)
    account(client)
    response = client.post(
        "/api/analyze", json={"task": "Test", "provider": "groq", "allow_external": True}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "session_not_found"
    with app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0


def test_failed_analysis_leaves_no_empty_session():
    client = TestClient(create_app(Settings(_env_file=None)))
    account(client)
    response = client.post("/api/analyze", json={"task": "Test", "expected_provider": "openai"})
    assert response.status_code == 409
    assert response.json()["detail"] == "model_configuration_changed"
    assert client.get("/api/sessions").json() == []


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
    body = {
        "task": "Test",
        "task_context": "Transient context",
        "provider": "groq",
        "session_id": session["id"],
    }
    assert client.post("/api/analyze", json=body).status_code == 403
    assert tasks == []
    assert (
        client.patch(
            f"/api/sessions/{session['id']}", json={"title": "Work", "context": "Updated context"}
        ).status_code
        == 200
    )
    assert client.post("/api/analyze", json={**body, "allow_external": True}).status_code == 200
    assert tasks == ["Task context:\nTransient context\n\nTask:\nTest"]
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


def test_progress_counts_only_saved_owner_choices():
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    account(client)
    assert client.get("/api/progress").json() == {
        "sessions": 0,
        "analyses": 0,
        "choices": 0,
        "matches": 0,
    }
    empty = client.post("/api/sessions", json={"title": "Empty session"}).json()
    first = client.post("/api/analyze", json={"task": "First task"}).json()
    second = client.post(
        "/api/analyze", json={"task": "Second task", "session_id": first["session_id"]}
    ).json()
    third = client.post("/api/analyze", json={"task": "Unconfirmed task"}).json()
    assert third["id"] != first["id"]
    assert (
        client.post(
            "/api/decisions",
            json={"analysis_id": first["id"], "candidate_id": first["recommendation"]["id"]},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/decisions",
            json={"analysis_id": second["id"], "candidate_id": second["alternatives"][0]["id"]},
        ).status_code
        == 200
    )
    response = client.get("/api/progress")
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"sessions": 3, "analyses": 3, "choices": 2, "matches": 1}
    assert client.delete("/api/sessions/" + empty["id"]).status_code == 200
    assert client.get("/api/progress").json()["sessions"] == 2
    assert client.delete("/api/sessions/" + first["session_id"]).status_code == 200
    assert client.get("/api/progress").json() == {
        "sessions": 1,
        "analyses": 1,
        "choices": 0,
        "matches": 0,
    }
    client.post("/api/auth/logout")
    assert client.get("/api/progress").status_code == 401


def test_personal_context_is_private_persistent_and_opt_in():
    tasks = []

    class Provider:
        async def assess(self, task):
            tasks.append(task)
            return Assessment(profile=Profile.model_validate(profile_data()))

    settings = Settings(_env_file=None)
    app = create_app(settings, {"groq": Provider()})
    alice, bob = TestClient(app), TestClient(app)
    account(alice)
    account(bob, "bob@example.com")
    assert (
        alice.put(
            "/api/context", json={"content": "Explain in Portuguese", "use_enabled": True}
        ).status_code
        == 200
    )
    assert bob.get("/api/context").json()["content"] == ""
    assert bob.put("/api/context", json={"content": "Different preferences"}).status_code == 200
    restarted = TestClient(create_app(settings))
    restarted.cookies.update(alice.cookies)
    assert restarted.get("/api/context").json()["content"] == "Explain in Portuguese"
    body = {"task": "Test task", "provider": "groq"}
    assert (
        alice.post("/api/analyze", json={**body, "use_personal_context": True}).status_code == 403
    )
    assert tasks == []
    alice.post("/api/analyze", json={**body, "allow_external": True, "use_personal_context": False})
    result = alice.post(
        "/api/analyze", json={**body, "allow_external": True, "use_personal_context": True}
    ).json()
    assert tasks == ["Test task", "Personal context:\nExplain in Portuguese\n\nTask:\nTest task"]
    alice.put("/api/context", json={"content": "New preferences"})
    detail = alice.get("/api/sessions/" + result["session_id"]).json()
    assert detail["analyses"][0]["request"] == {}
    assert alice.get("/api/context").headers["cache-control"] == "no-store"
    assert alice.put("/api/context", json={"content": "x" * 4001}).status_code == 422
    alice.post("/api/auth/logout")
    assert alice.get("/api/context").status_code == 401


def test_dashboard_chart_and_capacity_counts_are_real():
    client = TestClient(create_app(Settings(_env_file=None)))
    account(client)
    assert client.get("/api/progress/dashboard").json() == {"over": 0, "under": 0, "series": []}
    for index in range(7):
        result = client.post("/api/analyze", json={"task": f"Task {index}"}).json()
        candidates = [result["recommendation"], *result["alternatives"]]
        capacity = 3 if index == 0 else 1 if index == 1 else 2
        chosen = next(item for item in candidates if item["capacity"] == capacity)
        client.post(
            "/api/decisions", json={"analysis_id": result["id"], "candidate_id": chosen["id"]}
        )
    dashboard = client.get("/api/progress/dashboard").json()
    assert dashboard["over"] == 1 and dashboard["under"] == 1
    assert len(dashboard["series"]) == 6
    assert dashboard["series"][0]["title"].startswith("Session ")
    assert dashboard["series"][0]["rate"] == 0
    assert dashboard["series"][-1]["rate"] == 100
    client.post("/api/auth/logout")
    account(client, "other@example.com")
    assert client.get("/api/progress/dashboard").json() == {"over": 0, "under": 0, "series": []}


def test_schema_v1_migrates_without_losing_sessions(tmp_path):
    import sqlite3

    from app.storage import Storage

    settings = Settings(_env_file=None)
    client = TestClient(create_app(settings))
    user = account(client)
    saved = client.post("/api/analyze", json={"task": "Keep this task"}).json()
    with sqlite3.connect(settings.database_path) as db:
        db.execute("DROP TABLE llm_configs")
        db.execute("DROP TABLE memory_entries")
        db.execute("DROP TABLE user_context")
        db.execute("DROP TABLE conversation_content")
        db.execute("DROP TABLE coaching_reports")
        db.execute("PRAGMA user_version=1")
    store = Storage(settings.database_path, allow_legacy_redaction=True)
    assert store.session(user["id"], saved["session_id"])["title"].startswith("Session ")
    with store.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 7
        assert db.execute("SELECT count(*) FROM user_context").fetchone()[0] == 0


def test_memory_save_use_and_clear_are_independent():
    tasks = []

    class Provider:
        async def assess(self, task):
            tasks.append(task)
            return Assessment(profile=Profile.model_validate(profile_data()))

    app = create_app(Settings(_env_file=None), {"groq": Provider()})
    client = TestClient(app)
    account(client)
    settings = client.get("/api/context").json()
    assert settings["memory"] == []
    assert settings["save_enabled"] is False and settings["use_enabled"] is False
    client.post("/api/analyze", json={"task": "Not learned"})
    assert client.get("/api/context").json()["memory"] == []
    client.put("/api/context", json={"save_enabled": True, "content": "Portuguese please"})
    result = client.post("/api/analyze", json={"task": "Private task"}).json()
    memory = client.get("/api/context").json()
    assert len(memory["memory"]) == 1
    assert "Private task" not in str(memory)
    client.post(
        "/api/decisions",
        json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
    )
    assert client.get("/api/context").json()["memory"][0]["chosen_capacity"] == 2
    client.put("/api/context", json={"save_enabled": False})
    body = {
        "task": "Another task",
        "provider": "groq",
        "use_personal_context": True,
        "allow_external": True,
    }
    client.post("/api/analyze", json=body)
    assert tasks[-1] == "Another task"
    client.put("/api/context", json={"use_enabled": True})
    client.post("/api/analyze", json=body)
    assert "Portuguese please" in tasks[-1] and "Usage metadata" in tasks[-1]
    assert "Private task" not in tasks[-1]
    assert len(client.get("/api/context").json()["memory"]) == 1
    counts = client.get("/api/progress").json()
    cleared = client.delete("/api/context/memory").json()
    assert cleared["memory"] == [] and cleared["content"] == "Portuguese please"
    assert client.get("/api/progress").json() == counts


def test_history_never_retains_provider_free_text():
    marker = "CONFIDENTIAL_PROJECT_MARKER"

    class Provider:
        async def assess(self, task):
            data = profile_data()
            data["explanation"] = marker
            for value in data.values():
                if isinstance(value, dict):
                    value["evidence"] = marker
            return Assessment(profile=Profile.model_validate(data))

    app = create_app(Settings(_env_file=None), {"ollama": Provider()})
    client = TestClient(app)
    user = account(client)
    client.put("/api/context", json={"save_enabled": True})
    result = client.post(
        "/api/analyze", json={"task": marker, "task_context": marker, "provider": "ollama"}
    ).json()
    assert marker in str(result)
    assert marker not in client.get("/api/sessions").text
    assert marker not in client.get("/api/sessions/" + result["session_id"]).text
    assert marker not in client.get("/api/context").text
    with app.state.storage.connect() as db:
        for table in ("sessions", "analyses", "memory_entries"):
            assert marker not in str([tuple(row) for row in db.execute("SELECT * FROM " + table)])
    assert app.state.storage.session(user["id"], result["session_id"])["context"] == ""


def test_v2_migration_redacts_raw_content_preserving_decisions():
    import json
    import sqlite3

    from app.storage import Storage

    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)
    user = account(client)
    result = client.post("/api/analyze", json={"task": "Original task"}).json()
    client.post(
        "/api/decisions",
        json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
    )
    marker = "LEGACY_PRIVATE_CONTENT"
    result["profile"]["explanation"] = marker
    result["profile"]["reasoning"]["evidence"] = marker
    with sqlite3.connect(settings.database_path) as db:
        db.execute(
            "UPDATE analyses SET request_json=?,result_json=?",
            (json.dumps({"task": marker}), json.dumps(result)),
        )
        db.execute("UPDATE sessions SET title=?,context=?", (marker, marker))
        db.execute("DROP TABLE llm_configs")
        db.execute("DROP TABLE memory_entries")
        db.execute("ALTER TABLE user_context DROP COLUMN save_enabled")
        db.execute("ALTER TABLE user_context DROP COLUMN use_enabled")
        db.execute("ALTER TABLE user_context DROP COLUMN coaching_auto_enabled")
        db.execute("ALTER TABLE user_context DROP COLUMN conversation_memory_enabled")
        db.execute("DROP TABLE conversation_content")
        db.execute("DROP TABLE coaching_reports")
        db.execute("PRAGMA user_version=2")
    with pytest.raises(RuntimeError, match="explicit removal"):
        Storage(settings.database_path)
    store = Storage(settings.database_path, allow_legacy_redaction=True)
    history = store.history(user["id"], result["session_id"], 100, 0)
    assert marker not in str(history)
    assert history[0]["candidate_id"] == result["recommendation"]["id"]
    assert store.session(user["id"], result["session_id"])["context"] == ""
    assert marker not in str(store.session(user["id"], result["session_id"]))
