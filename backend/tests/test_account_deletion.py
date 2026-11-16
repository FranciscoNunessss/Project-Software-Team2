"""Self-service account deletion (card "Self-service account deletion", GDPR erasure)."""

from uuid import uuid4

import httpx
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient
from psycopg import sql

PASSWORD = "test-password-123"
TASK = "ERASURE_MARKER_91b2 summarise the memo"


def account(app, email="erase@example.com"):
    client = TestClient(app)
    registered = client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    assert registered.status_code == 201
    return client, registered.json()


def use_everything(client):
    """Leave a row in every kind of table a user can fill."""
    assert (
        client.put(
            "/api/context",
            json={"save_enabled": True, "use_enabled": True, "conversation_memory_enabled": True},
        ).status_code
        == 200
    )
    result = client.post("/api/analyze", json={"task": TASK, "task_context": TASK}).json()
    choice = {"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]}
    assert client.post("/api/decisions", json=choice).status_code == 200
    outcome = client.put(f"/api/analyses/{result['id']}/outcome", json={"outcome": "resolved"})
    assert outcome.status_code == 200
    if client.get("/api/features").json().get("chat"):
        assert client.put("/api/chat/settings", json={"auto_analyse": True}).status_code == 200
        assert client.post("/api/chats", json={}).status_code in (200, 201)
    return result


def stored_text(app):
    store = app.state.storage
    with store.connect() as db:
        tables = [
            row[0]
            for row in db.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema=%s",
                (store.schema,),
            )
        ]
        return "".join(
            str([tuple(row) for row in db.execute(sql.SQL("SELECT * FROM {}").format(table))])
            for table in map(sql.Identifier, tables)
        )


def delete(client, **body):
    return client.request("DELETE", "/api/auth/account", json=body)


def test_deleting_the_account_erases_everything_stored_for_it_and_nothing_else():
    app = create_app(Settings(_env_file=None))
    client, user = account(app)
    other, other_user = account(app, "stays@example.com")
    use_everything(client)
    kept = use_everything(other)
    before = stored_text(app)
    assert user["id"] in before and "erase@example.com" in before and "ERASURE_MARKER" in before

    deleted = delete(client, email="erase@example.com", password=PASSWORD)
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "account_deleted", "sign_in_kept": False}
    assert deleted.headers["cache-control"] == "no-store"

    after = stored_text(app)
    assert user["id"] not in after and "erase@example.com" not in after
    # The other account's rows, including its opted-in text, are untouched.
    assert other_user["id"] in after and "ERASURE_MARKER" in after
    assert other.get("/api/sessions/" + kept["session_id"]).status_code == 200
    assert other.get("/api/progress").json()["choices"] == 1

    # The sign-in is gone on this device and everywhere else.
    assert client.get("/api/auth/me").status_code == 401
    login = client.post(
        "/api/auth/login", json={"email": "erase@example.com", "password": PASSWORD}
    )
    assert login.status_code == 401


def test_the_same_email_can_register_again_and_starts_empty():
    app = create_app(Settings(_env_file=None))
    client, user = account(app)
    use_everything(client)
    assert delete(client, email="erase@example.com", password=PASSWORD).status_code == 200
    again, new_user = account(app)
    assert new_user["id"] != user["id"]
    assert again.get("/api/sessions").json() == []
    assert again.get("/api/progress").json()["analyses"] == 0


def test_deletion_needs_the_accounts_own_email_and_password():
    app = create_app(Settings(_env_file=None))
    client, user = account(app)
    use_everything(client)
    wrong_email = delete(client, email="someone@example.com", password=PASSWORD)
    assert wrong_email.status_code == 403
    assert wrong_email.json() == {"detail": "account_email_mismatch"}
    wrong_password = delete(client, email="erase@example.com", password="not-the-password")
    assert wrong_password.status_code == 401
    assert wrong_password.json() == {"detail": "invalid_credentials"}
    assert delete(client, email="erase@example.com").status_code == 401  # No password.
    assert delete(client).status_code == 422
    # Nothing was deleted by the refused requests.
    assert client.get("/api/auth/me").json()["id"] == user["id"]
    assert client.get("/api/progress").json()["analyses"] == 1
    # The email is compared without case or surrounding spaces, like at sign-in.
    assert delete(client, email="  Erase@Example.com ", password=PASSWORD).status_code == 200


def test_deletion_requires_a_signed_in_user_and_the_apps_own_origin():
    app = create_app(Settings(_env_file=None))
    anonymous = TestClient(app)
    assert delete(anonymous, email="erase@example.com", password=PASSWORD).status_code == 401
    client, _ = account(app)
    forged = client.request(
        "DELETE",
        "/api/auth/account",
        json={"email": "erase@example.com", "password": PASSWORD},
        headers={"Origin": "https://attacker.example"},
    )
    assert forged.status_code == 403
    assert client.get("/api/auth/me").status_code == 200


def test_one_user_cannot_delete_another_account():
    app = create_app(Settings(_env_file=None))
    client, _ = account(app)
    victim, victim_user = account(app, "victim@example.com")
    attempt = delete(client, email="victim@example.com", password=PASSWORD)
    assert attempt.status_code == 403
    assert victim.get("/api/auth/me").json()["id"] == victim_user["id"]


def test_with_supabase_auth_the_data_is_erased_and_the_sign_in_is_reported_as_kept(monkeypatch):
    origin, project = "https://adaptai-test.netlify.app", "https://test-project.supabase.co"
    identity = {
        "id": str(uuid4()),
        "email": "cloud@example.test",
        "email_confirmed_at": "2026-11-07T00:00:00Z",
        "is_anonymous": False,
    }
    monkeypatch.setattr(
        "app.supabase_auth.httpx.get", lambda url, **kwargs: httpx.Response(200, json=identity)
    )
    app = create_app(
        Settings(
            _env_file=None,
            auth_mode="supabase",
            supabase_url=project,
            supabase_publishable_key="public-test-key",
            browser_origin=origin,
        )
    )
    client = TestClient(app, headers={"Authorization": "Bearer valid-token", "Origin": origin})
    first = client.get("/api/auth/me").json()
    assert client.post("/api/analyze", json={"task": TASK}).status_code == 200
    assert delete(client, email="other@example.test").status_code == 403

    deleted = delete(client, email="cloud@example.test")  # No password in cloud mode.
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "account_deleted", "sign_in_kept": True}
    assert not deleted.headers.get("set-cookie")
    after = stored_text(app)
    assert first["id"] not in after and identity["id"] not in after
    # Supabase still knows the sign-in: using it again starts a new, empty account.
    again = client.get("/api/auth/me").json()
    assert again["id"] != first["id"] and again["email"] == "cloud@example.test"
    assert client.get("/api/sessions").json() == []
