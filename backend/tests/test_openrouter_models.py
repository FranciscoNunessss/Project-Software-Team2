"""OpenRouter as a catalogue behind one key (ADR-014 A12): every model says its state, and
the analysis may suggest one rated model the user does not have yet."""

from app import main
from app.main import create_app
from app.models import Assessment, Profile
from app.openrouter import OpenRouterCatalogue
from app.providers import Settings
from app.recommendation import Option
from fastapi.testclient import TestClient
from profile_samples import profile_data
from test_assessor import Assessor


class Demanding:
    """A task that needs level 2 reasoning and domain: gpt-oss-20b (level 1) falls short."""

    async def assess(self, task):
        return Assessment(profile=Profile.model_validate(profile_data(reasoning=2, domain=2)))


PASSWORD = "correct horse battery"


def entry(identifier, prompt="0", completion="0"):
    return {
        "id": identifier,
        "name": identifier,
        "context_length": 128000,
        "pricing": {"prompt": prompt, "completion": completion},
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "supported_parameters": ["tools"],
    }


def client_for(assessor=None):
    async def fetch():
        return [
            entry("anthropic/claude-opus-5.5", "0.000005", "0.000025"),
            entry("google/gemma-4-31b-it:free"),
            entry("acme/unknown:free"),
        ]

    app = create_app(
        Settings(_env_file=None, groq_models="openai/gpt-oss-20b", groq_api_key="synthetic"),
        {"groq": assessor or Assessor()},
        openrouter_catalogue=OpenRouterCatalogue(fetch=fetch),
        evaluation_options={"worker": False},
    )
    client = TestClient(app)
    client.post("/api/auth/register", json={"email": "r@example.com", "password": PASSWORD})
    return client


def connect(client):
    response = client.post(
        "/api/llm-configs",
        json={"label": "Router", "provider": "openrouter", "api_key": "sk-or-synthetic"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def analyse(client):
    response = client.post(
        "/api/analyze",
        json={"task": "Plan a trip", "provider": "auto", "allow_external": True},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_every_catalogue_model_says_its_state():
    client = client_for()
    models = {item["id"]: item for item in client.get("/api/openrouter/models").json()["models"]}
    assert models["anthropic/claude-opus-5.5"]["levels_source"] == "arena"
    assert models["anthropic/claude-opus-5.5"]["status"] == {
        "state": "public",
        "text": "Public ranking",
    }
    assert models["acme/unknown:free"]["status"]["state"] == "none"


def test_a_better_model_on_openrouter_is_suggested_once(monkeypatch):
    client = client_for(Demanding())
    configuration = connect(client)
    # The server model (gpt-oss-20b, all levels 1 on LMArena) against a free Gemma.
    monkeypatch.setattr(
        main,
        "suggestion_pool",
        lambda configs: [
            Option("openrouter", "google/gemma-4-31b-it:free", configuration, "Router · gemma")
        ],
    )
    body = analyse(client)
    assert body["recommendation"]["model"] == "openai/gpt-oss-20b"
    suggestion = body["suggestion"]
    assert suggestion["model"] == "google/gemma-4-31b-it:free"
    assert suggestion["configuration_id"] == configuration
    assert suggestion["levels_from"].startswith("LMArena")
    assert body["suggestion_reason"].startswith("covers ")
    assert "where Groq · openai/gpt-oss-20b falls short" in body["suggestion_reason"]
    # It is not mixed into the user's own models.
    assert all(item["model"] != suggestion["model"] for item in body["alternatives"])


def test_never_a_dearer_band_than_the_users_own(monkeypatch):
    client = client_for(Demanding())
    configuration = connect(client)
    monkeypatch.setattr(
        main,
        "suggestion_pool",
        lambda configs: [
            Option("openrouter", "anthropic/claude-opus-5.5", configuration, "Router · opus")
        ],
    )
    assert analyse(client)["suggestion"] is None


def test_no_openrouter_no_suggestion():
    client = client_for()
    assert main.suggestion_pool([]) == []
    assert analyse(client)["suggestion"] is None


def test_the_pool_is_every_chat_model_of_the_snapshot():
    configs = [{"id": "c1", "provider": "openrouter", "enabled": True, "label": "Router"}]
    pool = main.suggestion_pool(configs)
    models = {option.model for option in pool}
    assert "anthropic/claude-opus-5.5" in models
    assert not any("lyria" in model for model in models)
    assert {option.configuration_id for option in pool} == {"c1"}


def test_no_suggestion_when_the_users_model_covers_the_task(monkeypatch):
    """A free project model that covers the task is never beaten "for less"."""
    client = client_for()
    configuration = connect(client)
    monkeypatch.setattr(
        main,
        "suggestion_pool",
        lambda configs: [
            Option("openrouter", "google/gemma-4-31b-it:free", configuration, "Router · gemma")
        ],
    )
    body = analyse(client)
    assert body["recommendation"]["status"] == "covers" and body["suggestion"] is None
