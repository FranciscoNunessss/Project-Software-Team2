"""Several server models per provider and a recommendation that points at one (ADR-014)."""

from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings, server_models
from fastapi.testclient import TestClient
from profile_samples import profile_data
from test_recommendation import card, catalogue

MODELS = "openai/gpt-oss-20b,openai/gpt-oss-120b"


def client_for(settings, profile=None, monkeypatch=None, cards=None):
    class Provider:
        async def assess(self, task):
            return Assessment(profile=Profile.model_validate(profile or profile_data()))

    if cards is not None:
        monkeypatch.setattr("app.workflow.active_catalogue", lambda: catalogue(*cards))
    client = TestClient(create_app(settings, {"groq": Provider()}))
    client.post(
        "/api/auth/register",
        json={"email": "alice@example.com", "password": "correct horse battery"},
    )
    return client


def test_server_models_list_and_single_fallback():
    assert server_models(Settings(_env_file=None, groq_models=MODELS), "groq") == MODELS.split(",")
    assert server_models(Settings(_env_file=None), "groq") == ["openai/gpt-oss-20b"]
    assert server_models(Settings(_env_file=None, groq_model=""), "groq") == []
    assert server_models(Settings(_env_file=None), "openrouter") == []


def test_every_server_model_is_an_option_and_the_first_keeps_server_groq(tmp_path):
    settings = Settings(
        _env_file=None,
        database_path=str(tmp_path / "db.sqlite3"),
        groq_models="openai/gpt-oss-120b,openai/gpt-oss-20b",
        groq_api_key="synthetic",
    )
    client = client_for(settings)
    options = client.get("/api/llm-options").json()["options"]
    groq = [item for item in options if item["provider"] == "groq"]
    assert [(item["id"], item["model"]) for item in groq] == [
        ("server:groq", "openai/gpt-oss-120b"),
        ("server:groq:openai/gpt-oss-20b", "openai/gpt-oss-20b"),
    ]
    # The analysis uses the first listed model.
    result = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    assert result["assessment_model"] == "openai/gpt-oss-120b"
    second = client.post(
        "/api/analyze",
        json={
            "task": "Plan a trip",
            "configuration_id": "server:groq:openai/gpt-oss-20b",
            "allow_external": True,
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["assessment_model"] == "openai/gpt-oss-20b"
    unknown = client.post(
        "/api/analyze",
        json={"task": "x", "configuration_id": "server:groq:other", "allow_external": True},
    )
    assert unknown.status_code == 404


def test_recommendation_points_at_a_server_model_the_user_can_send_to(tmp_path, monkeypatch):
    small = card("small", 1, 0.1)
    small["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-20b"}]
    large = card("large", 3, 1.0)
    large["aliases"] = [{"provider": "groq", "model": "openai/gpt-oss-120b"}]
    settings = Settings(
        _env_file=None,
        database_path=str(tmp_path / "db.sqlite3"),
        groq_models=MODELS,
        groq_api_key="synthetic",
    )
    client = client_for(
        settings, profile_data(reasoning=3), monkeypatch=monkeypatch, cards=[small, large]
    )
    result = client.post(
        "/api/analyze", json={"task": "Prove it", "provider": "auto", "allow_external": True}
    ).json()
    best = result["recommendation"]
    assert best["id"] == "large"
    assert best["configuration_id"] == "server:groq:openai/gpt-oss-120b"
    assert result["alternatives"][0]["id"] == "small"
    assert result["alternatives"][0]["shortfalls"]
    assert result["needs"]["needs"]["reasoning"] == {"estimated": 3, "top": 3, "determined": True}
    assert result["policy_version"] == "needs-capabilities-1"
