"""Personal API tokens (ADR-013): Bearer authentication next to the cookie and Supabase logins."""

import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

PASSWORD = "test-password-123"
ORIGIN = {"Origin": "http://127.0.0.1:8443"}


def make_app():
    return create_app(Settings(_env_file=None))


def signed_in(app, email="alice@example.com"):
    client = TestClient(app)
    assert (
        client.post("/api/auth/register", json={"email": email, "password": PASSWORD}).status_code
        == 201
    )
    return client


def new_token(client, name="VS Code", **extra):
    response = client.post("/api/tokens", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def bearer(app, token):
    """A client that has no cookie, like the VS Code extension host."""
    return TestClient(app, headers={"Authorization": f"Bearer {token}"})


def test_a_token_is_created_with_the_session_and_shown_once():
    app = make_app()
    client = signed_in(app)
    created = new_token(client)
    assert created["token"].startswith("adaptai_pat_") and len(created["token"]) > 40
    assert created["prefix"] == created["token"][:16]
    assert created["name"] == "VS Code" and created["revoked"] is False
    listed = client.get("/api/tokens").json()
    assert [item["id"] for item in listed] == [created["id"]]
    assert created["token"] not in client.get("/api/tokens").text
    assert "token_hash" not in client.get("/api/tokens").text
    assert client.get("/api/tokens").headers["cache-control"] == "no-store"


def test_only_the_hash_is_stored():
    app = make_app()
    created = new_token(signed_in(app))
    with app.state.storage.connect() as db:
        stored = db.execute("SELECT token_hash, prefix FROM api_tokens").fetchone()
    assert created["token"] not in (stored["token_hash"], stored["prefix"])
    assert len(stored["token_hash"]) == 64  # SHA-256 hex


def test_a_token_authenticates_without_a_cookie():
    app = make_app()
    created = new_token(signed_in(app))
    client = bearer(app, created["token"])
    me = client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["email"] == "alice@example.com"
    assert client.get("/api/llm-options").status_code == 200
    analysed = client.post(
        "/api/analyze", json={"task": "Compare two API designs", "provider": "demo"}
    )
    assert analysed.status_code == 200


def test_a_token_belongs_to_one_user():
    app = make_app()
    alice = new_token(signed_in(app, "alice@example.com"))
    bob = new_token(signed_in(app, "bob@example.com"))
    assert bearer(app, alice["token"]).get("/api/auth/me").json()["email"] == "alice@example.com"
    assert bearer(app, bob["token"]).get("/api/auth/me").json()["email"] == "bob@example.com"


def test_a_token_cannot_manage_tokens():
    app = make_app()
    created = new_token(signed_in(app))
    client = bearer(app, created["token"])
    assert client.get("/api/tokens").status_code == 401
    assert client.post("/api/tokens", json={"name": "more"}).status_code == 401
    assert client.delete(f"/api/tokens/{created['id']}").status_code == 401


@pytest.mark.parametrize("header", ["Bearer adaptai_pat_x", "Bearer adaptai_pat_unknown"])
def test_a_wrong_token_is_a_401_and_never_falls_back_to_the_cookie(header):
    app = make_app()
    client = signed_in(app)  # a valid session cookie is present
    response = client.get("/api/auth/me", headers={"Authorization": header})
    assert response.status_code == 401


def test_an_authorization_header_that_is_not_a_token_keeps_its_old_meaning():
    # Cloud mode sends the Supabase access token as a Bearer; a local request with some other
    # header is judged by the cookie as before (this change does not tighten or loosen that).
    app = make_app()
    client = signed_in(app)
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 200


def test_a_revoked_token_stops_working_and_revoking_twice_is_fine():
    app = make_app()
    client = signed_in(app)
    created = new_token(client)
    token = bearer(app, created["token"])
    assert token.get("/api/auth/me").status_code == 200
    assert client.delete(f"/api/tokens/{created['id']}").status_code == 200
    assert client.delete(f"/api/tokens/{created['id']}").status_code == 200
    assert token.get("/api/auth/me").status_code == 401
    assert client.get("/api/tokens").json()[0]["revoked"] is True


def test_an_expired_token_stops_working():
    app = make_app()
    client = signed_in(app)
    created = new_token(client, expires_in_days=1)
    with app.state.storage.connect() as db:
        db.execute("UPDATE api_tokens SET expires_at=%s", (int(time.time()) - 1,))
    assert bearer(app, created["token"]).get("/api/auth/me").status_code == 401
    assert client.get("/api/tokens").json()[0]["expired"] is True


def test_someone_else_cannot_revoke_a_token():
    app = make_app()
    created = new_token(signed_in(app, "alice@example.com"))
    bob = signed_in(app, "bob@example.com")
    assert bob.delete(f"/api/tokens/{created['id']}").status_code == 404
    assert bearer(app, created["token"]).get("/api/auth/me").status_code == 200
    assert bob.get("/api/tokens").json() == []


def test_management_needs_a_session():
    app = make_app()
    anonymous = TestClient(app)
    assert anonymous.get("/api/tokens").status_code == 401
    assert anonymous.post("/api/tokens", json={"name": "x"}).status_code == 401


def test_at_most_ten_active_tokens_and_revoking_frees_a_place():
    app = make_app()
    client = signed_in(app)
    created = [new_token(client, f"t{i}") for i in range(10)]
    over = client.post("/api/tokens", json={"name": "eleventh"})
    assert over.status_code == 409 and over.json()["detail"] == "token_limit_reached"
    client.delete(f"/api/tokens/{created[0]['id']}")
    assert client.post("/api/tokens", json={"name": "eleventh"}).status_code == 201


def test_the_limit_holds_when_requests_arrive_together():
    app = make_app()
    client = signed_in(app)
    cookies = dict(client.cookies)

    def attempt(index):
        other = TestClient(app, cookies=cookies)
        return other.post("/api/tokens", json={"name": f"parallel-{index}"}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(attempt, range(16)))
    assert codes.count(201) == 10 and codes.count(409) == 6
    active = [item for item in client.get("/api/tokens").json() if not item["revoked"]]
    assert len(active) == 10


@pytest.mark.parametrize(
    "body",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 61},
        {"name": "ok", "expires_in_days": 0},
        {"name": "ok", "expires_in_days": 366},
        {"name": "ok", "extra": 1},
    ],
)
def test_token_requests_are_validated(body):
    client = signed_in(make_app())
    assert client.post("/api/tokens", json=body).status_code == 422


def test_last_use_is_recorded():
    app = make_app()
    created = new_token(signed_in(app))
    assert created["last_used_at"] is None
    bearer(app, created["token"]).get("/api/auth/me")
    with app.state.storage.connect() as db:
        assert db.execute("SELECT last_used_at FROM api_tokens").fetchone()[0] is not None


def test_the_cookie_flow_and_its_origin_check_are_unchanged():
    app = make_app()
    client = signed_in(app)
    assert client.get("/api/auth/me").status_code == 200
    bad = client.post("/api/tokens", json={"name": "x"}, headers={"Origin": "https://evil.example"})
    assert bad.status_code == 403 and bad.json()["detail"] == "invalid_origin"
    good = client.post("/api/tokens", json={"name": "x"}, headers=ORIGIN)
    assert good.status_code == 201


def test_a_token_write_needs_no_origin_and_is_not_a_cross_site_cookie_request():
    app = make_app()
    created = new_token(signed_in(app))
    client = bearer(app, created["token"])
    assert client.post("/api/sessions", json={"title": "x", "context": ""}).status_code == 201


def test_the_table_cascades_with_the_user():
    app = make_app()
    created = new_token(signed_in(app))
    with app.state.storage.connect() as db:
        assert db.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] >= 8
        db.execute("DELETE FROM users")
        assert db.execute("SELECT count(*) FROM api_tokens").fetchone()[0] == 0
    assert bearer(app, created["token"]).get("/api/auth/me").status_code == 401


# ---- cloud mode: a token works next to Supabase Auth; the Supabase session manages tokens ----

PROJECT = "https://test-project.supabase.co"
CLOUD_ORIGIN = "https://adaptai-test.netlify.app"


@pytest.fixture
def cloud(monkeypatch):
    identity = {
        "id": "7f1c9f3e-0d3a-4a58-9f3b-2f7f0b2a4c11",
        "email": "cloud@example.test",
        "email_confirmed_at": "2026-11-07T00:00:00Z",
        "is_anonymous": False,
    }
    calls = []

    def get(url, **kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        if kwargs["headers"]["Authorization"] != "Bearer valid-token":
            return httpx.Response(401, json={"message": "invalid token"})
        return httpx.Response(200, json=identity)

    monkeypatch.setattr("app.supabase_auth.httpx.get", get)
    app = create_app(
        Settings(
            _env_file=None,
            auth_mode="supabase",
            supabase_url=PROJECT,
            supabase_publishable_key="public-test-key",
            browser_origin=CLOUD_ORIGIN,
        )
    )
    session = TestClient(
        app, headers={"Authorization": "Bearer valid-token", "Origin": CLOUD_ORIGIN}
    )
    return app, session, calls


def test_in_cloud_mode_a_token_is_created_with_the_supabase_session_and_needs_no_supabase_call(
    cloud,
):
    app, session, calls = cloud
    created = new_token(session)
    calls.clear()
    extension = TestClient(app, headers={"Authorization": f"Bearer {created['token']}"})
    me = extension.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["email"] == "cloud@example.test"
    assert calls == [], "a personal token is checked locally, not against Supabase"
    assert extension.get("/api/llm-options").status_code == 200


def test_in_cloud_mode_a_token_cannot_manage_tokens_and_a_bad_token_is_refused(cloud):
    app, session, calls = cloud
    created = new_token(session)
    extension = TestClient(app, headers={"Authorization": f"Bearer {created['token']}"})
    assert extension.get("/api/tokens").status_code == 401
    wrong = TestClient(app, headers={"Authorization": "Bearer adaptai_pat_nope"})
    assert wrong.get("/api/auth/me").status_code == 401
    assert "Bearer adaptai_pat_nope" not in calls, (
        "a token-shaped credential never goes to Supabase"
    )
