import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import ProviderFailure, Settings
from app.workflow import rank
from fastapi.testclient import TestClient
from profile_samples import profile_data


@pytest.fixture
def client():
    return TestClient(create_app(Settings(_env_file=None)))


def test_end_to_end_demo_and_override(client):
    response = client.post("/api/analyze", json={"task": "Compare two API designs"})
    assert response.status_code == 200
    result = response.json()
    assert result["mode"] == "demonstration"
    assert result["usage"] is None and result["observed_cost"] is None
    assert result["recommendation"]["id"] == "demo-balanced"
    alternative = result["alternatives"][0]["id"]
    decision = {"analysis_id": result["id"], "candidate_id": alternative}
    assert client.post("/api/decisions", json=decision).json()["persistence"] == "none"
    assert client.post("/api/decisions", json=decision).status_code == 404


@pytest.mark.parametrize("task", ["", "   ", "x" * 8001])
def test_bad_input_is_not_echoed(client, task):
    response = client.post("/api/analyze", json={"task": task})
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request fields"}


def test_capability_filter_precedes_ranking(client):
    result = client.post(
        "/api/analyze",
        json={
            "task": "Describe the image",
            "required_capabilities": ["vision"],
        },
    ).json()
    assert result["recommendation"]["id"] == "demo-advanced"
    assert result["alternatives"] == []
    assert rank(Profile.model_validate(profile_data(reasoning=3)), ["unsupported"]) == []


def test_unconfigured_provider(client):
    assert (
        client.post(
            "/api/analyze",
            json={
                "task": "Test",
                "provider": "openai",
            },
        ).status_code
        == 409
    )


class FakeProvider:
    def __init__(self):
        self.calls = 0

    async def assess(self, task):
        self.calls += 1
        return Assessment(profile=Profile.model_validate(profile_data(reasoning=3, context=2)))


@pytest.mark.parametrize("provider_id", ["openai", "groq"])
def test_external_consent_and_semantic_workflow(provider_id):
    provider = FakeProvider()
    client = TestClient(create_app(Settings(_env_file=None), {provider_id: provider}))
    body = {"task": "Sensitive task", "provider": provider_id}
    assert client.post("/api/analyze", json=body).status_code == 403
    assert provider.calls == 0
    response = client.post("/api/analyze", json={**body, "allow_external": True})
    assert response.json()["mode"] == "semantic"
    assert response.json()["recommendation"]["id"] == "demo-advanced"
    assert provider.calls == 1


def test_groq_configuration_is_public_but_credentials_are_not():
    client = TestClient(create_app(Settings(_env_file=None, groq_api_key="private-test-key")))
    response = client.get("/api/providers")
    assert "private-test-key" not in response.text
    groq = next(item for item in response.json() if item["id"] == "groq")
    assert groq == {
        "id": "groq",
        "label": "Groq",
        "model": "openai/gpt-oss-20b",
        "enabled": True,
        "external": True,
    }


def test_invalid_profile_is_rejected():
    class Malformed:
        async def assess(self, task):
            return {
                "profile": {
                    "reasoning": 99,
                    "context": 1,
                    "ambiguity": 1,
                    "explanation": "Untrusted provider output",
                }
            }

    client = TestClient(create_app(Settings(_env_file=None), {"groq": Malformed()}))
    response = client.post(
        "/api/analyze", json={"task": "Test", "provider": "groq", "allow_external": True}
    )
    assert response.status_code == 502
    assert response.json() == {"detail": "invalid_provider_output"}


@pytest.mark.parametrize(
    "code",
    [
        "provider_timeout",
        "invalid_provider_output",
        "provider_authentication",
        "provider_rate_limit",
    ],
)
def test_failures_do_not_silently_fallback(code):
    class Broken:
        async def assess(self, task):
            raise ProviderFailure(code)

    client = TestClient(create_app(Settings(_env_file=None), {"ollama": Broken()}))
    response = client.post("/api/analyze", json={"task": "Private", "provider": "ollama"})
    assert response.status_code == 502
    assert response.json() == {"detail": code}


def test_selection_must_be_eligible(client):
    result = client.post(
        "/api/analyze",
        json={
            "task": "Image",
            "required_capabilities": ["vision"],
        },
    ).json()
    response = client.post(
        "/api/decisions",
        json={
            "analysis_id": result["id"],
            "candidate_id": "demo-small",
        },
    )
    assert response.status_code == 422
