"""The analysis always uses the project's assessor; the chat uses the model the user picks
(ADR-014 A11). Models that hit a limit are set aside for a while."""

import asyncio
import json

from app import evaluations, limits
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

MODELS = "openai/gpt-oss-20b,openai/gpt-oss-120b"
PASSWORD = "correct horse battery"


class Assessor:
    """Fails with ``code`` for the first ``failures`` calls, then answers."""

    def __init__(self, failures=0, code="provider_rate_limit"):
        self.failures, self.code, self.calls = failures, code, 0

    async def assess(self, task):
        self.calls += 1
        if self.calls <= self.failures:
            raise ProviderFailure(self.code)
        return Assessment(profile=Profile.model_validate(profile_data()))


def client_for(assessor, **settings):
    app = create_app(
        Settings(_env_file=None, groq_models=MODELS, groq_api_key="synthetic", **settings),
        {"groq": assessor},
    )
    client = TestClient(app)
    client.post("/api/auth/register", json={"email": "a@example.com", "password": PASSWORD})
    return client


def analyse(client, **extra):
    return client.post(
        "/api/analyze",
        json={"task": "Plan a trip", "provider": "auto", "allow_external": True, **extra},
    )


def test_the_options_name_the_assessor_and_its_chain():
    body = client_for(Assessor()).get("/api/llm-options").json()
    assert body["assessment"]["id"] == "server:groq"
    assert body["assessment"]["external"] is True
    assert body["assessment_chain"] == ["server:groq", "server:groq:openai/gpt-oss-120b"]


def test_the_analysis_uses_the_assessor_whatever_the_chat_model_is():
    client = client_for(Assessor())
    client.post(
        "/api/llm-configs",
        json={
            "label": "Mine",
            "provider": "openrouter",
            "model": "google/gemma-4-31b-it:free",
            "api_key": "sk-or-synthetic",
        },
    )
    result = analyse(client).json()
    assert result["provider"] == "groq" and result["configuration_id"] == "server:groq"
    assert result["selection_mode"] == "auto"


def test_a_limited_assessor_hands_over_to_the_next_one_and_says_so():
    assessor = Assessor(failures=1)
    client = client_for(assessor)
    result = analyse(client)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["configuration_id"] == "server:groq:openai/gpt-oss-120b"
    assert body["notes"][0].startswith("Assessed by openai/gpt-oss-120b")
    assert "rate limit" in body["notes"][0]
    # The limited one is set aside: the next analysis starts with the second model.
    assert limits.limited("groq", "openai/gpt-oss-20b") == "provider_rate_limit"
    again = analyse(client).json()
    assert again["configuration_id"] == "server:groq:openai/gpt-oss-120b"
    assert assessor.calls == 3


def test_a_wrong_answer_is_not_handed_over():
    client = client_for(Assessor(failures=1, code="invalid_provider_output"))
    response = analyse(client)
    assert response.status_code == 502 and response.json()["detail"] == "invalid_provider_output"


def test_when_every_assessor_fails_the_error_is_shown():
    client = client_for(Assessor(failures=5))
    response = analyse(client)
    assert response.status_code == 502 and response.json()["detail"] == "provider_rate_limit"


def test_a_manual_configuration_is_never_replaced():
    client = client_for(Assessor(failures=1))
    response = analyse(client, configuration_id="server:groq")
    assert response.status_code == 502


def test_a_model_that_hit_a_limit_is_not_recommended_for_a_while():
    client = client_for(Assessor())
    limits.mark("groq", "openai/gpt-oss-120b", "provider_rate_limit")
    body = analyse(client).json()
    ids = [body["recommendation"]["configuration_id"]] + [
        item["configuration_id"] for item in body["alternatives"]
    ]
    assert "server:groq:openai/gpt-oss-120b" not in ids
    assert any(note.startswith("Not recommended now:") for note in body["notes"])
    # Other failures do not set a model aside, and the pause ends.
    limits.mark("groq", "openai/gpt-oss-20b", "provider_timeout")
    assert limits.limited("groq", "openai/gpt-oss-20b") is None
    assert limits.limited("groq", "openai/gpt-oss-120b", now=10**12) is None


def test_a_chat_answer_that_hits_a_limit_sets_the_model_aside():
    from app.chat import answer_events

    class Store:
        def connect(self):
            class Db:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def execute(self, *args):
                    return None

            return Db()

    class Limited:
        async def stream(self, messages):
            error = RuntimeError("rate limited")
            error.status_code = 429
            raise error
            yield ""

    async def go():
        return [
            event
            async for event in answer_events(
                Store(), Limited(), "a1", "openrouter", "google/gemma-4-31b-it:free", []
            )
        ]

    events = asyncio.run(go())
    assert events == [{"event": "error", "code": "provider_rate_limit"}]
    assert limits.limited("openrouter", "google/gemma-4-31b-it:free") == "provider_rate_limit"


def test_a_free_model_of_the_user_is_measured_with_the_project_key():
    client = client_for(Assessor(), evaluation_openrouter_key="sk-project")
    config = client.post(
        "/api/llm-configs",
        json={
            "label": "Mine",
            "provider": "openrouter",
            "model": "google/gemma-4-31b-it:free",
            "api_key": "sk-or-user",
        },
    ).json()
    app = client.app
    row = {
        "provider": "openrouter",
        "model": "google/gemma-4-31b-it:free",
        "configuration_id": config["id"],
        "estimate_json": json.dumps({"free": True}),
    }
    settings = evaluations._settings_for(row, app.state.evaluation_configurations)
    assert settings.openrouter_api_key.get_secret_value() == "sk-project"
    paid = {**row, "estimate_json": json.dumps({"free": False})}
    settings = evaluations._settings_for(paid, app.state.evaluation_configurations)
    assert settings.openrouter_api_key.get_secret_value() == "sk-or-user"
