"""Cloud trust boundary, account migration and cross-origin requests (no real Auth calls)."""

from uuid import uuid4

import httpx
import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

ORIGIN = "https://adaptai-test.netlify.app"
PROJECT = "https://test-project.supabase.co"
PASSWORD = "previous-password-123"


@pytest.fixture
def cloud(monkeypatch):
    identity = {
        "id": str(uuid4()),
        "email": "cloud@example.test",
        "email_confirmed_at": "2026-11-07T00:00:00Z",
        "is_anonymous": False,
    }
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        assert url == PROJECT + "/auth/v1/user"
        assert kwargs["headers"]["apikey"] == "public-test-key"
        token = kwargs["headers"]["Authorization"]
        if token != "Bearer valid-token":
            return httpx.Response(401, json={"message": "invalid token"})
        return httpx.Response(200, json=identity)

    monkeypatch.setattr("app.supabase_auth.httpx.get", get)
    settings = Settings(
        _env_file=None,
        auth_mode="supabase",
        supabase_url=PROJECT,
        supabase_publishable_key="public-test-key",
        browser_origin=ORIGIN,
    )
    app = create_app(settings)
    client = TestClient(app, headers={"Authorization": "Bearer valid-token", "Origin": ORIGIN})
    return client, identity, calls


def test_cloud_provisions_once_and_ignores_browser_identity(cloud):
    client, identity, calls = cloud
    first = client.get("/api/auth/me")
    assert first.status_code == 200
    assert first.json()["email"] == identity["email"]
    assert client.get("/api/auth/me").json() == first.json()
    with client.app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM auth_identities").fetchone()[0] == 1
    assert len(calls) == 2
    assert not first.cookies
    assert first.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("authorization", ["", "Basic valid-token", "Bearer bad-token", "Bearer "])
def test_missing_or_invalid_bearer_cannot_use_cookie_fallback(cloud, authorization):
    client, _, _ = cloud
    client.cookies.set("adaptai_session", "old-cookie")
    response = client.get("/api/sessions", headers={"Authorization": authorization})
    assert response.status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"email_confirmed_at": None},
        {"is_anonymous": True},
        {"id": "invalid"},
        {"email": None},
    ],
)
def test_unconfirmed_anonymous_or_malformed_identity_is_rejected(cloud, change):
    client, identity, _ = cloud
    identity.update(change)
    assert client.get("/api/auth/me").status_code == 401


def test_auth_outage_is_not_reported_as_bad_password(cloud, monkeypatch):
    client, _, _ = cloud

    def fail(*args, **kwargs):
        raise httpx.ConnectTimeout("offline")

    monkeypatch.setattr("app.supabase_auth.httpx.get", fail)
    response = client.get("/api/auth/me")
    assert response.status_code == 503
    assert response.json()["detail"] == "authentication_unavailable"


def test_cloud_disables_legacy_password_endpoints(cloud):
    client, _, _ = cloud
    for action in ("login", "register"):
        assert (
            client.post(
                "/api/auth/" + action,
                json={
                    "email": "cloud@example.test",
                    "password": PASSWORD,
                },
            ).status_code
            == 404
        )
    assert client.post("/api/auth/logout").status_code == 404


def test_exact_frontend_origin_and_bearer_preflight(cloud):
    client, _, _ = cloud
    headers = {
        "Origin": ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    }
    response = client.options("/api/sessions", headers=headers)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "access-control-allow-credentials" not in response.headers
    assert (
        client.post(
            "/api/sessions",
            json={},
            headers={
                "Origin": ORIGIN,
                "Sec-Fetch-Site": "cross-site",
            },
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/sessions",
            json={},
            headers={
                "Origin": "https://attacker.example",
            },
        ).status_code
        == 403
    )
    headers["Origin"] = "https://attacker.example"
    assert client.options("/api/sessions", headers=headers).status_code == 400


def test_cloud_accounts_cannot_access_another_users_session(cloud):
    client, identity, _ = cloud
    session = client.post("/api/sessions", json={}).json()
    identity.update(id=str(uuid4()), email="other@example.test")
    assert client.get("/api/sessions").json() == []
    assert client.get(f"/api/sessions/{session['id']}/history").status_code == 404


def test_linking_requires_both_identities_and_keeps_existing_history(cloud):
    client, identity, _ = cloud
    settings = client.app.state.settings.model_copy(update={"auth_mode": "local"})
    legacy = TestClient(create_app(settings))
    old_user = legacy.post(
        "/api/auth/register",
        json={
            "email": identity["email"],
            "password": PASSWORD,
        },
    ).json()
    session = legacy.post("/api/sessions", json={}).json()
    assert client.get("/api/auth/me").json()["detail"] == "account_link_required"
    assert (
        client.post(
            "/api/auth/link-legacy",
            json={
                "email": identity["email"],
                "password": "wrong-password-123",
            },
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/link-legacy",
            json={
                "email": "someone-else@example.test",
                "password": PASSWORD,
            },
        ).status_code
        == 403
    )
    linked = client.post(
        "/api/auth/link-legacy",
        json={
            "email": identity["email"],
            "password": PASSWORD,
        },
    )
    assert linked.status_code == 200
    assert linked.json() == old_user
    assert client.get("/api/auth/me").json() == old_user
    assert client.get("/api/sessions").json()[0]["id"] == session["id"]
    assert legacy.get("/api/auth/me").status_code == 401
    assert (
        legacy.post(
            "/api/auth/login",
            json={
                "email": identity["email"],
                "password": PASSWORD,
            },
        ).status_code
        == 401
    )


def test_email_match_cannot_take_over_an_already_linked_account(cloud):
    client, identity, _ = cloud
    user = client.get("/api/auth/me").json()
    identity["id"] = str(uuid4())
    assert client.get("/api/auth/me").status_code == 409
    assert (
        client.post(
            "/api/auth/link-legacy",
            json={
                "email": user["email"],
                "password": PASSWORD,
            },
        ).status_code
        == 401
    )


def test_cloud_configuration_fails_closed():
    with pytest.raises(ValueError, match="Supabase Auth requires"):
        create_app(Settings(_env_file=None, auth_mode="supabase"))
