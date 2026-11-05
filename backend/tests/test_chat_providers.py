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
    entry("acme/paid-chat", pricing={"prompt": "0.000003", "completion": "0.000015"}),
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


def connect(client, model="acme/chat-only", key="sk-or-personal"):
    """OpenRouter is always a personal configuration: the user's own key and model."""
    created = client.post(
        "/api/llm-configs",
        json={"label": "My OpenRouter", "provider": "openrouter", "model": model, "api_key": key},
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def test_openrouter_is_not_a_project_model_in_the_chat():
    client, chat = build(openrouter_api_key="sk-or-env-must-be-ignored")
    response = send(client, chat, provider="openrouter")
    assert (response.status_code, response.json()["detail"]) == (409, "provider_not_configured")
    assert Recorder.calls == []


def test_personal_openrouter_answers_with_its_own_key_and_model():
    client, chat = build()
    response = send(client, chat, configuration_id=connect(client))
    assert response.status_code == 200, response.text
    answer = response.json()["answer"]
    assert (answer["provider"], answer["model"]) == ("openrouter", "acme/chat-only")
    assert answer["content"] == "openrouter:acme/chat-only"


def test_chat_model_override_must_be_a_text_model_in_the_catalogue():
    client, chat = build()
    cfg = connect(client)
    ok = send(client, chat, configuration_id=cfg, model="acme/paid-chat")  # the user's own key
    assert ok.status_code == 200  # no structured output needed for a chat
    assert ok.json()["answer"]["model"] == "acme/paid-chat"
    missing = send(client, chat, configuration_id=cfg, model="nobody/none")
    assert missing.json()["detail"] == "model_not_found"
    embedder = send(client, chat, configuration_id=cfg, model="acme/embedder")
    assert embedder.json()["detail"] == "model_not_compatible"
    assert [call[1] for call in Recorder.calls] == ["acme/paid-chat"]  # nothing else was sent


def test_model_override_is_refused_for_other_providers():
    client, chat = build()
    response = send(client, chat, provider="groq", model="acme/chat-only")
    assert (response.status_code, response.json()["detail"]) == (
        422,
        "model_override_not_supported",
    )
    assert Recorder.calls == []


def test_openrouter_requires_consent_and_reports_catalogue_failure():
    client, chat = build()
    cfg = connect(client)
    assert send(client, chat, configuration_id=cfg, allow_external=False).status_code == 403

    async def down():
        raise CatalogueUnavailable("openrouter_catalogue_unavailable")

    client, chat = build(down)
    response = send(client, chat, configuration_id=connect(client))
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


def test_personal_lmstudio_configuration_works_in_chat():
    client, chat = build()
    created = client.post(
        "/api/llm-configs",
        json={"label": "lmstudio", "provider": "lmstudio", "model": "my-local"},
    )
    assert created.status_code == 201, created.text
    response = send(client, chat, configuration_id=created.json()["id"])
    assert response.status_code == 200, response.text
    assert response.json()["answer"]["content"] == "lmstudio:my-local"


def test_model_tiers_accept_lmstudio_and_a_personal_openrouter():
    client, _ = build(lmstudio_model="local-model")
    from app.workflow import CATALOGUE

    tier = CATALOGUE["models"][0]["id"]
    cfg = connect(client)
    for identifier in ("server:lmstudio", cfg):
        response = client.put(
            "/api/chat/model-tiers", json={"configuration_id": identifier, "tier": tier}
        )
        assert response.status_code == 200, response.text
