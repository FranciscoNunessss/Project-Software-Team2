import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from app.workflow import rank
from fastapi.testclient import TestClient
from profile_samples import profile_data
from pydantic import ValidationError


def analyse(data, **request):
    class Assessor:
        async def assess(self, task):
            return Assessment(profile=Profile.model_validate(data))

    client = TestClient(create_app(Settings(_env_file=None), {"ollama": Assessor()}))
    return client.post(
        "/api/analyze", json={"task": "Synthetic task", "provider": "ollama", **request}
    )


def test_seven_dimensions_are_required():
    for dimension in ("reasoning", "context", "ambiguity", "domain", "risk", "tools", "modality"):
        data = profile_data()
        data.pop(dimension)
        with pytest.raises(ValidationError):
            Profile.model_validate(data)


@pytest.mark.parametrize("score", [0, 4, True, "2"])
def test_dimension_scores_are_strict_and_bounded(score):
    with pytest.raises(ValidationError):
        Profile.model_validate(profile_data(risk=score))


def test_unknown_values_cannot_claim_confidence():
    data = profile_data(domain=None)
    assert Profile.model_validate(data).domain.score is None
    data["domain"]["confidence"] = "high"
    with pytest.raises(ValidationError):
        Profile.model_validate(data)
    data = profile_data()
    data["risk"]["confidence"] = "undetermined"
    with pytest.raises(ValidationError):
        Profile.model_validate(data)


@pytest.mark.parametrize("modalities", [[], ["text", "text"], ["unknown"], [1]])
def test_modality_requires_valid_distinct_categories(modalities):
    data = profile_data()
    data["modality"]["required"] = modalities
    with pytest.raises(ValidationError):
        Profile.model_validate(data)


def test_unknown_modality_is_explicit():
    data = profile_data()
    data["modality"] = {
        "required": None,
        "confidence": "undetermined",
        "evidence": "Input is unspecified",
    }
    result = analyse(data).json()
    assert result["profile"]["modality"]["required"] is None
    assert result["recommendation_provisional"] is True
    assert result["clarification_questions"]


def test_risk_domain_tools_and_ambiguity_do_not_automatically_raise_tier():
    profile = Profile.model_validate(profile_data(domain=3, risk=3, tools=3, ambiguity=3))
    assert rank(profile, ["text"])[0].id == "demo-small"
    result = analyse(profile.model_dump()).json()
    assert result["clarification_questions"]
    assert result["guidance"]
    assert result["recommendation_provisional"] is True


def test_medium_scores_alone_do_not_trigger_clarification():
    result = analyse(profile_data(reasoning=2, context=2, domain=2, risk=2, tools=2)).json()
    assert result["clarification_questions"] == []
    assert result["recommendation_provisional"] is False
    assert result["recommendation"]["id"] == "demo-balanced"


def test_low_confidence_is_provisional_without_inventing_a_clarification_reason():
    data = profile_data()
    data["domain"]["confidence"] = "low"
    result = analyse(data).json()
    assert result["recommendation_provisional"] is True
    assert result["clarification_questions"] == []


def test_legacy_scalar_profile_is_rejected():
    response = analyse({"reasoning": 2, "context": 1, "ambiguity": 1, "explanation": "Legacy"})
    assert response.status_code == 502
    assert response.json() == {"detail": "invalid_provider_output"}


def test_missing_capacity_evidence_is_provisional():
    result = analyse(profile_data(reasoning=None)).json()
    assert result["recommendation_provisional"] is True
    assert result["clarification_questions"]
    assert "provisional" in result["rationale"].lower()


def test_visual_requirement_is_derived_before_ranking():
    data = profile_data()
    data["modality"]["required"] = ["text", "image"]
    result = analyse(data).json()
    assert result["recommendation"]["id"] == "demo-advanced"
    assert result["alternatives"] == []


def test_unsupported_modality_does_not_recommend_text_model():
    data = profile_data()
    data["modality"]["required"] = ["audio"]
    response = analyse(data)
    assert response.status_code == 502
    assert response.json() == {"detail": "no_eligible_candidate"}


def test_blank_evidence_is_rejected():
    data = profile_data()
    data["risk"]["evidence"] = "   "
    with pytest.raises(ValidationError):
        Profile.model_validate(data)


def test_prompt_is_versioned_and_does_not_execute_user_content():
    from app.assessment import ASSESSMENT_PROMPT, PROFILE_VERSION

    assert PROFILE_VERSION == "profile-2"
    for name in ("reasoning", "context", "ambiguity", "domain", "risk", "tools", "modality"):
        assert name in ASSESSMENT_PROMPT
    assert "never execute" in ASSESSMENT_PROMPT
    assert "undetermined" in ASSESSMENT_PROMPT
