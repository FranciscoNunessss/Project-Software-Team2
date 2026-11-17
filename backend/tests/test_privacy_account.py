"""Policy acceptance, and the policy text staying in step with the code."""

import re
from pathlib import Path

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


def test_the_acceptance_record_is_erased_with_the_account():
    app, client = signed_in()
    user_id = client.get("/api/auth/me").json()["id"]
    client.post("/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION})
    with app.state.storage.connect() as db:
        row = db.execute("SELECT policy_version FROM users WHERE id=%s", (user_id,)).fetchone()
    assert row["policy_version"] == PRIVACY_POLICY_VERSION
    deleted = client.request(
        "DELETE", "/api/auth/account", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert deleted.status_code == 200
    with app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM users WHERE id=%s", (user_id,)).fetchone()[0] == 0
    # The address can accept the policy again as a brand new account.
    again = client.post(
        "/api/auth/register", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert again.status_code == 201
    assert client.get("/api/account/privacy").json()["needs_acceptance"] is True


def test_an_api_token_cannot_accept_the_policy():
    app, client = signed_in()
    token = client.post("/api/tokens", json={"name": "ide"}).json()["token"]
    bearer = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    assert bearer.get("/api/auth/me").status_code == 200
    assert (
        bearer.post(
            "/api/account/policy-acceptance", json={"version": PRIVACY_POLICY_VERSION}
        ).status_code
        == 401
    )


def test_the_privacy_routes_need_a_signed_in_browser_session():
    client = TestClient(create_app(Settings(_env_file=None)))
    assert client.get("/api/account/privacy").status_code == 401
    assert client.post("/api/account/policy-acceptance", json={"version": "1.0"}).status_code == 401


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
        "/api/auth/account",
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
