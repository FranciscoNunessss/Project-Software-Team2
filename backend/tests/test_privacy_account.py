"""Policy acceptance, account deletion, and the policy text staying in step with the code."""

import re
from pathlib import Path

import httpx
import pytest
from app.main import create_app
from app.privacy import POLICY_FILE, PRIVACY_POLICY_VERSION, policy_text_version
from app.providers import Settings
from fastapi.testclient import TestClient

PASSWORD = "test-password-123"
ORIGIN = {"Origin": "http://127.0.0.1:8443"}
POLICY = POLICY_FILE.read_text(encoding="utf-8")


def signed_in(email="alice@example.com"):
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    assert (
        client.post("/api/auth/register", json={"email": email, "password": PASSWORD}).status_code
        == 201
    )
    return app, client


def rows_for(app, user_id):
    """Every row in the schema that carries this user's id, whichever table holds it."""
    with app.state.storage.connect() as db:
        columns = db.execute(
            "SELECT table_name FROM information_schema.columns "
            "WHERE table_schema=current_schema() AND column_name='user_id'"
        ).fetchall()
        return {
            row["table_name"]: count
            for row in columns
            if (
                count := db.execute(
                    f'SELECT count(*) FROM "{row["table_name"]}" WHERE user_id=%s', (user_id,)
                ).fetchone()[0]
            )
        }


def test_a_new_account_must_accept_the_current_policy_once():
    _, client = signed_in()
    state = client.get("/api/account/privacy").json()
    assert state["needs_acceptance"] is True
    assert state["accepted_version"] is None
    assert state["current_version"] == PRIVACY_POLICY_VERSION
    assert client.post("/api/account/policy-acceptance", json={"version": "0.1"}).status_code == 409
    accepted = client.post(
        "/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION}
    ).json()
    assert accepted["needs_acceptance"] is False
    assert accepted["accepted_version"] == PRIVACY_POLICY_VERSION
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+Z", accepted["accepted_at"])
    assert client.get("/api/account/privacy").json() == accepted


def test_a_changed_policy_version_asks_again(monkeypatch):
    _, client = signed_in()
    client.post("/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION})
    monkeypatch.setattr("app.privacy.PRIVACY_POLICY_VERSION", "9.9")
    assert client.get("/api/account/privacy").json()["needs_acceptance"] is True


def test_deleting_the_account_removes_every_trace_of_the_user():
    app, client = signed_in()
    user_id = client.get("/api/auth/me").json()["id"]
    client.post("/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION})
    client.put(
        "/api/context",
        json={"content": "mine", "save_enabled": True, "use_enabled": True},
        headers=ORIGIN,
    )
    assert client.post("/api/tokens", json={"name": "ide"}).status_code == 201
    assert rows_for(app, user_id)  # there is data to delete

    wrong_password = client.request(
        "DELETE", "/api/account", json={"confirm_email": "alice@example.com", "password": "nope"}
    )
    assert wrong_password.status_code == 401
    wrong_email = client.request(
        "DELETE", "/api/account", json={"confirm_email": "bob@example.com", "password": PASSWORD}
    )
    assert wrong_email.status_code == 422
    assert client.get("/api/auth/me").status_code == 200  # nothing was deleted yet

    deleted = client.request(
        "DELETE",
        "/api/account",
        json={"confirm_email": " Alice@Example.com ", "password": PASSWORD},
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "deleted", "sign_in_record_removed": True}
    assert "adaptai_session" in deleted.headers["set-cookie"]
    assert rows_for(app, user_id) == {}
    with app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM users WHERE id=%s", (user_id,)).fetchone()[0] == 0
    assert client.get("/api/auth/me").status_code == 401
    # The address can be registered again as a brand new, empty account.
    again = client.post(
        "/api/auth/register", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert again.status_code == 201
    assert again.json()["id"] != user_id


def test_an_api_token_cannot_delete_the_account_or_accept_the_policy():
    app, client = signed_in()
    token = client.post("/api/tokens", json={"name": "ide"}).json()["token"]
    bearer = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    assert bearer.get("/api/auth/me").status_code == 200
    body = {"confirm_email": "alice@example.com", "password": PASSWORD}
    assert bearer.request("DELETE", "/api/account", json=body).status_code == 401
    assert (
        bearer.post(
            "/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION}
        ).status_code
        == 401
    )


def test_the_privacy_routes_need_a_signed_in_browser_session():
    client = TestClient(create_app(Settings(_env_file=None)))
    assert client.get("/api/account/privacy").status_code == 401
    assert (
        client.request("DELETE", "/api/account", json={"confirm_email": "a@b.co"}).status_code
        == 401
    )


PROJECT = "https://test-project.supabase.co"
ORIGIN_CLOUD = "https://adaptai-test.netlify.app"


@pytest.mark.parametrize("service_key,removed", [("", False), ("service-test-key", True)])
def test_cloud_deletion_removes_the_sign_in_record_only_when_it_can(
    monkeypatch, service_key, removed
):
    identity = {
        "id": "3f1c6a52-0c4e-4d6a-9d7e-0a3f5f9a1b11",
        "email": "cloud@example.test",
        "email_confirmed_at": "2026-11-07T00:00:00Z",
    }
    monkeypatch.setattr(
        "app.supabase_auth.httpx.get", lambda url, **kw: httpx.Response(200, json=identity)
    )
    deleted_urls = []

    def delete(url, **kwargs):
        deleted_urls.append((url, kwargs["headers"]["Authorization"]))
        return httpx.Response(200, json={})

    monkeypatch.setattr("app.privacy.httpx.delete", delete)
    app = create_app(
        Settings(
            _env_file=None,
            auth_mode="supabase",
            supabase_url=PROJECT,
            supabase_publishable_key="public-test-key",
            supabase_service_role_key=service_key,
            browser_origin=ORIGIN_CLOUD,
        )
    )
    client = TestClient(app, headers={"Authorization": "Bearer t", "Origin": ORIGIN_CLOUD})
    user_id = client.get("/api/auth/me").json()["id"]
    response = client.request("DELETE", "/api/account", json={"confirm_email": identity["email"]})
    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "sign_in_record_removed": removed}
    assert rows_for(app, user_id) == {}
    if removed:
        assert deleted_urls == [
            (f"{PROJECT}/auth/v1/admin/users/{identity['id']}", "Bearer service-test-key")
        ]
    else:
        assert deleted_urls == []


# --- The policy text must not drift away from the code it describes. ---


def test_the_policy_version_in_the_text_is_the_version_the_server_asks_users_to_accept():
    assert policy_text_version(POLICY) == PRIVACY_POLICY_VERSION


def test_no_open_questions_remain_in_a_released_policy_version():
    major = int(PRIVACY_POLICY_VERSION.split(".")[0])
    if major >= 1:
        assert "[TO CONFIRM" not in POLICY, "resolve every [TO CONFIRM] before releasing 1.x"


def test_the_policy_states_the_session_length_the_server_uses():
    days = Settings(_env_file=None).session_days
    assert f"{days} days" in POLICY


def test_the_policy_describes_the_cookie_the_server_sets():
    app, client = signed_in()
    cookie = (
        client.post("/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD})
        .headers["set-cookie"]
        .lower()
    )
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "HttpOnly" in POLICY and "SameSite=Lax" in POLICY


def test_every_data_deletion_route_the_policy_promises_exists():
    paths = set(create_app(Settings(_env_file=None)).openapi()["paths"])
    for path in (
        "/api/account",
        "/api/context/memory",
        "/api/context/conversations",
        "/api/progress/history",
    ):
        assert path in paths
    for label in ("Clear learned memory", "Delete saved conversations", "Delete my account"):
        assert label in POLICY


def test_the_frontend_offers_what_the_policy_tells_users_to_click():
    sources = "".join(
        p.read_text(encoding="utf-8") for p in Path(POLICY_FILE.parents[1]).glob("*.tsx")
    )
    for label in (
        "Clear learned memory",
        "Delete saved conversations",
        "Delete my account",
        "Export",
    ):
        assert label in sources, label


def test_a_login_that_races_an_account_deletion_is_refused_not_a_server_error(monkeypatch):
    import app.accounts as accounts

    app, client = signed_in()
    real = accounts.password_hash

    def hash_then_delete(password, salt):
        with app.state.storage.connect() as db:  # the account disappears mid-login
            db.execute("DELETE FROM users WHERE email=%s", ("alice@example.com",))
        return real(password, salt)

    monkeypatch.setattr(accounts, "password_hash", hash_then_delete)
    other = TestClient(app)
    response = other.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert response.status_code == 401
