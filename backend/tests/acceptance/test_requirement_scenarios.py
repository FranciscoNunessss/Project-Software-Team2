"""ATDD scenarios mapped to observable AdaptAI requirements, not code coverage."""

import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient

from backend.tests.profile_samples import profile_data


@pytest.fixture
def client():
    return TestClient(create_app(Settings(_env_file=None)))


@pytest.mark.acceptance
def test_fr01_and_fr03_text_task_returns_a_versioned_profile_with_evidence(client):
    """Given a text task, when analysed, then return all seven scored dimensions and modality."""
    response = client.post(
        "/api/analyze",
        json={"task": "Compare two public API designs and explain their trade-offs."},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["profile_version"] == "profile-2"
    assert set(result["profile"]) == {
        "reasoning",
        "context",
        "ambiguity",
        "domain",
        "risk",
        "tools",
        "modality",
        "explanation",
    }
    for dimension in ("reasoning", "context", "ambiguity", "domain", "risk", "tools"):
        assert set(result["profile"][dimension]) == {"score", "confidence", "evidence"}
        assert result["profile"][dimension]["evidence"]
    assert result["profile"]["modality"]["required"] is None
    assert result["profile"]["modality"]["confidence"] == "undetermined"
    assert "task" not in result  # Privacy boundary: raw input is not returned in analysis output.


@pytest.mark.acceptance
@pytest.mark.parametrize("task", ["", "  ", "x" * 8001])
def test_fr01_invalid_text_is_rejected_without_echoing_it(client, task):
    """Given blank or over-limit text, when submitted, then return a sanitised validation error."""
    response = client.post("/api/analyze", json={"task": task})

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request fields"}
    if task:
        assert task not in response.text


@pytest.mark.acceptance
def test_fr04_capability_needs_filter_the_catalogue_before_recommending(client):
    """Given a vision requirement, when recommendations are made, then only vision tiers remain."""
    response = client.post(
        "/api/analyze",
        json={"task": "Describe a chart", "required_capabilities": ["vision"]},
    )

    assert response.status_code == 200
    result = response.json()
    candidates = [result["recommendation"], *result["alternatives"]]
    assert candidates
    assert all("vision" in item["capabilities"] for item in candidates)


@pytest.mark.acceptance
def test_fr05_explanation_names_the_requirements_and_capacity_basis(client):
    """Given an eligible text task, when recommended, then explain capability and capacity basis."""
    response = client.post(
        "/api/analyze",
        json={
            "task": "Compare two public API designs",
            "required_capabilities": ["text", "code"],
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert "Required capabilities: code, text." in result["rationale"]
    assert "Assessed reasoning/context capacity:" in result["rationale"]
    assert result["recommendation"]["capabilities"]


@pytest.mark.acceptance
def test_fr06_override_must_be_eligible_and_is_acknowledged_once(client):
    """Given an analysis, when an eligible alternative is chosen, then acknowledge it once."""
    analysis = client.post("/api/analyze", json={"task": "Compare two public API designs"}).json()
    alternative = analysis["alternatives"][0]
    decision = {"analysis_id": analysis["id"], "candidate_id": alternative["id"]}

    accepted = client.post("/api/decisions", json=decision)

    assert accepted.status_code == 200
    assert accepted.json() == {
        "status": "acknowledged",
        "candidate_id": alternative["id"],
        "persistence": "none",
    }
    assert client.post("/api/decisions", json=decision).status_code == 404


@pytest.mark.acceptance
def test_privacy_external_assessment_requires_consent_before_provider_use():
    """Given an external provider, when consent is absent, then reject before invoking it."""

    class SpyProvider:
        calls = 0

        async def assess(self, task: str) -> Assessment:
            self.calls += 1
            return Assessment(profile=Profile.model_validate(profile_data()))

    provider = SpyProvider()
    client = TestClient(create_app(Settings(_env_file=None), {"groq": provider}))
    task = "Synthetic confidential-looking task text"

    response = client.post(
        "/api/analyze", json={"task": task, "provider": "groq", "allow_external": False}
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "external_processing_requires_consent"}
    assert task not in response.text
    assert provider.calls == 0


@pytest.mark.acceptance
def test_provider_failure_is_sanitised_and_does_not_fall_back_to_demo():
    """Given an external provider failure, when analysed, then return a sanitised error."""

    class FailingProvider:
        async def assess(self, _task: str) -> Assessment:
            raise ProviderFailure("provider_unavailable")

    client = TestClient(create_app(Settings(_env_file=None), {"groq": FailingProvider()}))
    task = "Synthetic task that must not be echoed"

    response = client.post(
        "/api/analyze",
        json={"task": task, "provider": "groq", "allow_external": True},
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "provider_unavailable"}
    assert task not in response.text
