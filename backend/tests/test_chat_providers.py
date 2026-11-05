"""Chat (ADR-011) with the OpenRouter and LM Studio providers (ADR-012)."""

from uuid import uuid4

import pytest
from app.main import create_app
from app.openrouter import CatalogueUnavailable, OpenRouterCatalogue
from app.providers import Settings
from fastapi.testclient import TestClient

pytestmark = pytest.mark.chat

ORIGIN = {"Origin": "http://127.0.0.1:8443"}


def entry(identifier, **extra):
    base = {
        "id": identifier,
        "name": identifier,
        "pricing": {"prompt": "0", "completion": "0"},
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "supported_parameters": ["temperature"],  # text chat, NO structured output
    }
    return base | extra


RAW = [
    entry("acme/chat-only"),
    entry(
        "acme/embedder",
        architecture={"input_modalities": ["text"], "output_modalities": ["embeddings"]},
    ),
]


class Recorder:
    """Stands in for the chat model: records the provider, settings and model it was given."""

    calls: list[tuple[str, str | None]] = []

    def __init__(self, provider, settings, model):
        Recorder.calls.append((provider, model))
        self.provider, self.model = provider, model

    async def stream(self, messages):
        yield f"{self.provider}:{self.model}"


@pytest.fixture(autouse=True)
def reset():
    Recorder.calls = []


def build(fetch=None, **settings):
    async def default():
        return RAW

    app = create_app(
        Settings(_env_file=None, groq_api_key="test-key", **settings),
        chat_options={"model_factory": Recorder},
        openrouter_catalogue=OpenRouterCatalogue(fetch or default),
    )
    client = TestClient(app, headers=ORIGIN)
    client.post(
        "/api/auth/register",
        json={"email": f"{uuid4()}@example.com", "password": "test-password-123"},
    )
    chat = client.post("/api/chats").json()["id"]
    return client, chat


def send(client, chat, **extra):
    body = {"content": "Hello", "allow_external": True, **extra}
    return client.post(f"/api/chats/{chat}/messages", json=body)


def test_server_openrouter_answers_with_the_configured_model():
    client, chat = build(openrouter_api_key="sk-or-test")
    response = send(client, chat, provider="openrouter")
    assert response.status_code == 200
    assert response.json()["answer"]["content"] == "openrouter:openrouter/free"
    assert response.json()["answer"]["provider"] == "openrouter"


def test_openrouter_without_a_key_is_not_configured():
    client, chat = build()
    assert send(client, chat, provider="openrouter").status_code == 409


def test_chat_model_override_must_be_a_text_model_in_the_catalogue():
    client, chat = build(openrouter_api_key="sk-or-test")
    ok = send(client, chat, provider="openrouter", model="acme/chat-only")
    assert ok.status_code == 200  # no structured output needed for a chat
    assert ok.json()["answer"]["model"] == "acme/chat-only"
    assert send(client, chat, provider="openrouter", model="nobody/none").json()["detail"] == (
        "model_not_found"
    )
    assert send(client, chat, provider="openrouter", model="acme/embedder").json()["detail"] == (
        "model_not_compatible"
    )
    assert [call[1] for call in Recorder.calls] == ["acme/chat-only"]  # nothing else was sent


def test_model_override_is_refused_for_other_providers():
    client, chat = build(openrouter_api_key="sk-or-test")
    response = send(client, chat, provider="groq", model="acme/chat-only")
    assert (response.status_code, response.json()["detail"]) == (
        422,
        "model_override_not_supported",
    )
    assert Recorder.calls == []


def test_openrouter_requires_consent_and_reports_catalogue_failure():
    client, chat = build(openrouter_api_key="sk-or-test")
    assert send(client, chat, provider="openrouter", allow_external=False).status_code == 403

    async def down():
        raise CatalogueUnavailable("openrouter_catalogue_unavailable")

    client, chat = build(down, openrouter_api_key="sk-or-test")
    response = send(client, chat, provider="openrouter", model="acme/chat-only")
    assert (response.status_code, response.json()["detail"]) == (
        502,
        "openrouter_catalogue_unavailable",
    )
    assert Recorder.calls == []


def test_lmstudio_is_local_so_it_needs_no_consent_and_a_model():
    client, chat = build(lmstudio_model="local-model")
    response = send(client, chat, provider="lmstudio", allow_external=False)
    assert response.status_code == 200
    assert response.json()["answer"]["content"] == "lmstudio:local-model"
    client, chat = build()
    assert send(client, chat, provider="lmstudio").status_code == 409


def test_personal_openrouter_and_lmstudio_configurations_work_in_chat():
    client, chat = build()
    for provider, model, key in (
        ("openrouter", "acme/chat-only", "sk-or-personal"),
        ("lmstudio", "my-local", None),
    ):
        created = client.post(
            "/api/llm-configs",
            json={"label": provider, "provider": provider, "model": model, "api_key": key},
        )
        assert created.status_code == 201, created.text
        response = send(client, chat, configuration_id=created.json()["id"])
        assert response.status_code == 200, response.text
        assert response.json()["answer"]["content"] == f"{provider}:{model}"


def test_model_tiers_accept_the_new_server_providers():
    client, _ = build(openrouter_api_key="sk-or-test", lmstudio_model="local-model")
    from app.workflow import CATALOGUE

    tier = CATALOGUE["models"][0]["id"]
    for provider in ("openrouter", "lmstudio"):
        response = client.put(
            "/api/chat/model-tiers", json={"configuration_id": f"server:{provider}", "tier": tier}
        )
        assert response.status_code == 200, response.text
