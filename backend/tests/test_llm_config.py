import json
from pathlib import Path

import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

SECRET = "synthetic-key-for-test-only-12345"
BODY = {"label": "My Groq", "provider": "groq", "model": "test-model", "api_key": SECRET}


def signed_in(app, email="alice@example.com"):
    client = TestClient(app)
    assert (
        client.post(
            "/api/auth/register", json={"email": email, "password": "test-password-123"}
        ).status_code
        == 201
    )
    return client


def test_keys_encrypted_scoped_and_persistent():
    settings = Settings(_env_file=None)
    app = create_app(settings)
    alice = signed_in(app)
    bob = signed_in(app, "bob@example.com")
    response = alice.post("/api/llm-configs", json=BODY)
    assert response.status_code == 201
    item = response.json()
    assert SECRET not in response.text and "api_key" not in item
    assert item["has_key"] is True
    assert response.headers["cache-control"] == "no-store"
    with app.state.storage.connect() as db:
        ciphertext = db.execute("SELECT key_ciphertext FROM llm_configs").fetchone()[0]
        assert SECRET not in ciphertext
    restarted = TestClient(create_app(settings))
    restarted.cookies.update(alice.cookies)
    assert restarted.get("/api/llm-configs").json()[0]["id"] == item["id"]
    assert bob.get("/api/llm-configs").json() == []
    for method in ("put", "delete", "post"):
        path = f"/api/llm-configs/{item['id']}" + ("/test" if method == "post" else "")
        result = getattr(bob, method)(path, **({"json": BODY} if method == "put" else {}))
        assert result.status_code == 404
    assert (
        bob.post(
            "/api/analyze",
            json={"task": "Test", "configuration_id": item["id"], "allow_external": True},
        ).status_code
        == 404
    )
    assert SECRET not in alice.get("/api/llm-options").text


def test_key_replacement_and_configuration_validation():
    app = create_app(Settings(_env_file=None))
    client = signed_in(app)
    assert client.post("/api/llm-configs", json={**BODY, "api_key": None}).status_code == 422
    assert (
        client.post(
            "/api/llm-configs", json={**BODY, "endpoint": "http://localhost/private"}
        ).status_code
        == 422
    )
    assert client.post("/api/llm-configs", json={**BODY, "api_key": "bad key"}).status_code == 422
    item = client.post("/api/llm-configs", json=BODY).json()
    assert (
        client.put(f"/api/llm-configs/{item['id']}", json={**BODY, "api_key": ""}).json()["has_key"]
        is True
    )
    assert (
        client.put(
            f"/api/llm-configs/{item['id']}", json={**BODY, "provider": "claude", "api_key": ""}
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/llm-configs/{item['id']}", json={**BODY, "enabled": False, "is_default": True}
        ).status_code
        == 422
    )
    local = client.post(
        "/api/llm-configs",
        json={"label": "Local", "provider": "ollama", "model": "installed-model"},
    ).json()
    assert local["has_key"] is False and local["external"] is False
    assert client.delete(f"/api/llm-configs/{item['id']}").status_code == 200
    with app.state.storage.connect() as db:
        assert not db.execute("SELECT 1 FROM llm_configs WHERE id=?", (item["id"],)).fetchone()


def test_legacy_default_flags_do_not_override_project_auto():
    app = create_app(Settings(_env_file=None, groq_api_key="project-test-key"))
    client = signed_in(app)
    client.post("/api/llm-configs", json={**BODY, "is_default": True})
    second = client.post(
        "/api/llm-configs", json={**BODY, "label": "Second", "is_default": True}
    ).json()
    options = client.get("/api/llm-options").json()
    assert options["auto_configuration_id"] == "server:groq"
    assert sum(item["is_default"] for item in client.get("/api/llm-configs").json()) == 1
    client.put(f"/api/llm-configs/{second['id']}", json={**BODY, "enabled": False})
    assert client.get("/api/llm-options").json()["auto_configuration_id"] == "server:groq"
    assert (
        client.post(
            "/api/analyze",
            json={"task": "Test", "configuration_id": second["id"], "allow_external": True},
        ).status_code
        == 409
    )


def test_auto_and_manual_use_user_settings_and_never_silently_fallback(monkeypatch):
    calls = []

    class Provider:
        def __init__(self, provider, settings):
            self.settings = settings
            self.provider = provider

        async def assess(self, task):
            calls.append(
                (
                    self.provider,
                    self.settings.groq_model,
                    self.settings.groq_api_key.get_secret_value(),
                )
            )
            if self.settings.groq_model == "broken-model":
                raise ProviderFailure("provider_authentication")
            return Assessment(profile=Profile.model_validate(profile_data()))

    monkeypatch.setattr("app.main.LangChainProvider", Provider)
    app = create_app(
        Settings(_env_file=None, groq_model="project-model", groq_api_key="project-test-key")
    )
    client = signed_in(app)
    item = client.post("/api/llm-configs", json={**BODY, "is_default": True}).json()
    request = {"task": "Private task", "provider": "auto"}
    assert client.post("/api/analyze", json=request).status_code == 403
    assert calls == []
    response = client.post("/api/analyze", json={**request, "allow_external": True})
    assert response.status_code == 200
    result = response.json()
    assert result["configuration_id"] == "server:groq" and result["selection_mode"] == "auto"
    assert result["assessment_model"] == "project-model" and result["provider"] == "groq"
    assert calls == [("groq", "project-model", "project-test-key")]
    assert SECRET not in response.text
    manual = client.post(
        "/api/analyze", json={**request, "configuration_id": item["id"], "allow_external": True}
    ).json()
    assert manual["selection_mode"] == "manual"
    client.put(
        f"/api/llm-configs/{item['id']}", json={**BODY, "model": "broken-model", "is_default": True}
    )
    response = client.post(
        "/api/analyze", json={**request, "configuration_id": item["id"], "allow_external": True}
    )
    assert response.status_code == 502 and response.json()["detail"] == "provider_authentication"
    assert len(calls) == 3
    assert client.post("/api/analyze", json={**request, "allow_external": True}).status_code == 200
    assert calls[-1] == ("groq", "project-model", "project-test-key")
    assert all(provider == "groq" for provider, _, _ in calls)


def test_missing_or_swapped_credentials_fail_closed():
    settings = Settings(_env_file=None)
    app = create_app(settings)
    alice = signed_in(app)
    bob = signed_in(app, "bob@example.com")
    a = alice.post("/api/llm-configs", json=BODY).json()
    b = bob.post("/api/llm-configs", json={**BODY, "api_key": "other-synthetic-key"}).json()
    with app.state.storage.connect() as db:
        ciphertext = db.execute(
            "SELECT key_ciphertext FROM llm_configs WHERE id=?", (b["id"],)
        ).fetchone()[0]
        db.execute("UPDATE llm_configs SET key_ciphertext=? WHERE id=?", (ciphertext, a["id"]))
    response = alice.post(
        "/api/analyze", json={"task": "Test", "configuration_id": a["id"], "allow_external": True}
    )
    assert response.status_code == 503
    assert "other-synthetic-key" not in response.text
    Path(settings.credentials_key_path).unlink()
    assert alice.post("/api/llm-configs", json=BODY).status_code == 503
    assert not Path(settings.credentials_key_path).exists()


def test_memory_uses_profile_setting_without_assistant_field():
    tasks = []

    class Provider:
        async def assess(self, task):
            tasks.append(task)
            return Assessment(profile=Profile.model_validate(profile_data()))

    app = create_app(Settings(_env_file=None), {"ollama": Provider()})
    client = signed_in(app)
    client.put("/api/context", json={"content": "Portuguese", "use_enabled": True})
    client.post("/api/analyze", json={"task": "Test", "provider": "ollama"})
    assert tasks == ["Personal context:\nPortuguese\n\nTask:\nTest"]
    client.put("/api/context", json={"use_enabled": False})
    client.post("/api/analyze", json={"task": "Test", "provider": "ollama"})
    assert tasks[-1] == "Test"


def test_connection_test_is_explicit_and_does_not_save_tasks(monkeypatch):
    calls = []

    class Provider:
        def __init__(self, provider, settings):
            calls.append(provider)

        async def assess(self, task):
            assert "synthetic" in task
            return Assessment(profile=Profile.model_validate(profile_data()))

    monkeypatch.setattr("app.llm_config.LangChainProvider", Provider)
    app = create_app(Settings(_env_file=None))
    client = signed_in(app)
    item = client.post("/api/llm-configs", json=BODY).json()
    assert calls == []
    response = client.post(f"/api/llm-configs/{item['id']}/test", json={})
    assert response.status_code == 200 and calls == ["groq"]
    assert client.get("/api/progress").json()["analyses"] == 0
    assert SECRET not in json.dumps(response.json())


@pytest.mark.parametrize("path", ["/api/llm-configs", "/api/llm-options"])
def test_llm_routes_require_authentication(path):
    client = TestClient(create_app(Settings(_env_file=None)))
    assert client.get(path).status_code == 401


def test_auto_destination_changes_require_new_confirmation():
    settings = Settings(_env_file=None, groq_model="project-model", groq_api_key="project-test-key")
    app = create_app(settings)
    client = signed_in(app)
    original = client.get("/api/llm-options").json()
    settings.groq_model = "changed-project-model"
    response = client.post(
        "/api/analyze",
        json={
            "task": "Private task",
            "provider": "auto",
            "allow_external": True,
            "expected_configuration_id": original["auto_configuration_id"],
            "expected_provider": "groq",
            "expected_model": "project-model",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "model_configuration_changed"
    assert client.get("/api/progress").json()["analyses"] == 0


def test_auto_requires_project_groq_even_with_personal_models():
    client = signed_in(create_app(Settings(_env_file=None)))
    client.post("/api/llm-configs", json={**BODY, "is_default": True})
    assert client.get("/api/llm-options").json()["auto_configuration_id"] is None
    response = client.post(
        "/api/analyze", json={"task": "Test", "provider": "auto", "allow_external": True}
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "project_default_not_configured"
    assert (
        client.post(
            "/api/analyze",
            json={"task": "Test", "provider": "auto", "configuration_id": "server:demo"},
        ).status_code
        == 200
    )


def test_project_groq_failure_never_falls_back_to_personal_models(monkeypatch):
    calls = []

    class Provider:
        def __init__(self, provider, settings):
            calls.append((provider, settings.groq_model))

        async def assess(self, task):
            raise ProviderFailure("provider_timeout")

    monkeypatch.setattr("app.main.LangChainProvider", Provider)
    client = signed_in(
        create_app(
            Settings(_env_file=None, groq_model="project-model", groq_api_key="project-test-key")
        )
    )
    client.post("/api/llm-configs", json={**BODY, "is_default": True})
    response = client.post(
        "/api/analyze", json={"task": "Test", "provider": "auto", "allow_external": True}
    )
    assert response.status_code == 502 and response.json()["detail"] == "provider_timeout"
    assert calls == [("groq", "project-model")]
