"""The Prompt Coach is installed whenever its module exists; each user switches it on or off."""

import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

pytestmark = pytest.mark.prompt_coach

ORIGIN = {"Origin": "http://127.0.0.1:8443"}


def signed_in(app, email="coach-toggle@example.com"):
    client = TestClient(app)
    response = client.post(
        "/api/auth/register", json={"email": email, "password": "test-password-123"}, headers=ORIGIN
    )
    assert response.status_code == 201
    return client


def test_features_report_the_installed_module():
    app = create_app(Settings(_env_file=None))
    assert TestClient(app).get("/api/features").json()["prompt_coach"] is True
    assert app.state.prompt_coach is not None


def test_prompt_coach_options_reach_the_module():
    def factory():
        return None

    app = create_app(Settings(_env_file=None), prompt_coach_options={"model_factory": factory})
    assert app.state.prompt_coach["model_factory"] is factory
    assert isinstance(app.state.prompt_coach["enabled"], dict)
    assert "demo" in app.state.prompt_coach["enabled"]


def test_prompt_coach_is_mounted_after_the_core_routes(monkeypatch):
    import sys

    import app.prompt_coach as module

    seen = []
    original = module.install_prompt_coach

    def recording(app, *args, **kwargs):
        seen.append(len(app.routes))
        return original(app, *args, **kwargs)

    monkeypatch.setattr(module, "install_prompt_coach", recording)
    installed = create_app(Settings(_env_file=None))
    monkeypatch.setitem(sys.modules, "app.prompt_coach", None)  # As if the file were deleted.
    monkeypatch.setitem(sys.modules, "app.chat", None)  # The core alone, without any module.
    core = create_app(Settings(_env_file=None))
    assert seen == [len(core.routes)]  # Every core route already exists when it is mounted.
    assert len(installed.routes) > len(core.routes)
    assert TestClient(core).get("/api/features").json()["prompt_coach"] is False


def test_the_switch_is_on_by_default_and_per_user():
    app = create_app(Settings(_env_file=None))
    first = signed_in(app, "first@example.com")
    second = signed_in(app, "second@example.com")
    assert first.get("/api/prompt-coach/settings").json() == {"enabled": True}

    off = first.put("/api/prompt-coach/settings", json={"enabled": False}, headers=ORIGIN)
    assert off.status_code == 200 and off.json() == {"enabled": False}
    assert first.get("/api/prompt-coach/settings").json() == {"enabled": False}
    assert second.get("/api/prompt-coach/settings").json() == {"enabled": True}

    on = first.put("/api/prompt-coach/settings", json={"enabled": True}, headers=ORIGIN)
    assert on.json() == {"enabled": True}


def test_the_switch_needs_an_account_and_a_same_origin_write():
    app = create_app(Settings(_env_file=None))
    assert TestClient(app).get("/api/prompt-coach/settings").status_code == 401
    client = signed_in(app)
    other = {"Origin": "https://other.example"}
    assert (
        client.put("/api/prompt-coach/settings", json={"enabled": False}, headers=other).status_code
        == 403
    )
    assert (
        client.put("/api/prompt-coach/settings", json={"on": False}, headers=ORIGIN).status_code
        == 422
    )
