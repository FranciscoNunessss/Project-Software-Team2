"""Behavioural tests for the core logic measured by the coverage gate (Construction §3)."""

import pytest
from app.assessment import assessment_advice, capacity_target, required_capabilities
from app.models import AnalysisRequest, Assessment, Candidate, Dimension, Modality, Profile
from app.providers import ProviderFailure
from app.workflow import build_workflow, rank
from profile_samples import profile_data
from pydantic import ValidationError

OUTCOME_QUESTION = "What outcome and constraints would make the result correct?"
STEPS_QUESTION = "What steps, source material and dependencies must the task cover?"
MODALITY_QUESTION = "Does completing the task require text, images, audio or video?"


def profile(**scores) -> Profile:
    return Profile.model_validate(profile_data(**scores))


def unknown_modality_profile() -> Profile:
    data = profile_data()
    data["modality"] = {"required": None, "confidence": "undetermined", "evidence": "Unspecified"}
    return Profile.model_validate(data)


class StaticProvider:
    def __init__(self, assessed: Profile):
        self.assessed = assessed

    async def assess(self, task):
        return Assessment(profile=self.assessed, usage={"total_tokens": 7})


# capacity_target


@pytest.mark.parametrize(
    ("reasoning", "context", "expected"),
    [(1, 1, 1), (3, 1, 3), (1, 3, 3), (2, 2, 2)],
)
def test_capacity_target_is_the_larger_capacity_dimension(reasoning, context, expected):
    assert capacity_target(profile(reasoning=reasoning, context=context)) == expected


@pytest.mark.parametrize(
    ("reasoning", "context", "expected"),
    [(None, None, 2), (1, None, 2), (None, 1, 2), (3, None, 3), (None, 3, 3)],
)
def test_unknown_capacity_defaults_to_the_middle_tier(reasoning, context, expected):
    assert capacity_target(profile(reasoning=reasoning, context=context)) == expected


# required_capabilities


def test_requested_capabilities_are_returned_sorted_and_distinct():
    assert required_capabilities(profile(), ["code", "text", "code"]) == ["code", "text"]


def test_image_modality_requires_vision_and_other_modalities_pass_through():
    data = profile_data()
    data["modality"]["required"] = ["text", "image", "audio"]
    result = required_capabilities(Profile.model_validate(data), ["text"])
    assert result == ["audio", "text", "vision"]


def test_unknown_modality_adds_no_capability_requirement():
    assert required_capabilities(unknown_modality_profile(), ["text"]) == ["text"]


# rank


def ranked_ids(target: int, required=("text",)) -> list[str]:
    return [item.id for item in rank(profile(reasoning=target, context=1), list(required))]


def test_ranking_prefers_the_smallest_sufficient_tier_then_larger_then_insufficient():
    assert ranked_ids(1) == ["demo-small", "demo-balanced", "demo-advanced"]
    assert ranked_ids(2) == ["demo-balanced", "demo-advanced", "demo-small"]
    assert ranked_ids(3) == ["demo-advanced", "demo-balanced", "demo-small"]


def test_ranking_filters_by_capability_before_ordering():
    assert ranked_ids(1, ["code"]) == ["demo-balanced", "demo-advanced"]
    assert ranked_ids(1, ["vision"]) == ["demo-advanced"]
    assert ranked_ids(1, ["code", "vision"]) == ["demo-advanced"]


def test_ranking_without_any_eligible_model_is_empty():
    assert rank(profile(), ["audio"]) == []


def test_ranking_returns_validated_candidates():
    first = rank(profile(), ["text"])[0]
    assert isinstance(first, Candidate)
    assert (first.id, first.capacity) == ("demo-small", 1)


# assessment_advice


def test_clear_low_demand_profile_needs_no_advice():
    assert assessment_advice(profile()) == ([], [], False)


@pytest.mark.parametrize("ambiguity", [None, 3])
def test_unknown_or_high_ambiguity_asks_for_the_expected_outcome(ambiguity):
    questions, guidance, provisional = assessment_advice(profile(ambiguity=ambiguity))
    assert questions == [OUTCOME_QUESTION]
    assert guidance == []
    assert provisional is True


@pytest.mark.parametrize("ambiguity", [1, 2])
def test_known_moderate_ambiguity_does_not_ask(ambiguity):
    assert assessment_advice(profile(ambiguity=ambiguity))[0] == []


@pytest.mark.parametrize("unknown", ["reasoning", "context"])
def test_unknown_capacity_dimension_asks_for_steps_and_sources(unknown):
    questions, _, provisional = assessment_advice(profile(**{unknown: None}))
    assert questions == [STEPS_QUESTION]
    assert provisional is True


def test_unknown_modality_asks_which_modalities_are_needed():
    questions, _, provisional = assessment_advice(unknown_modality_profile())
    assert questions == [MODALITY_QUESTION]
    assert provisional is True


def test_all_unknowns_ask_every_question_in_a_stable_order():
    data = profile_data(ambiguity=None, reasoning=None)
    data["modality"] = {"required": None, "confidence": "undetermined", "evidence": "Unspecified"}
    questions, _, _ = assessment_advice(Profile.model_validate(data))
    assert questions == [OUTCOME_QUESTION, STEPS_QUESTION, MODALITY_QUESTION]


@pytest.mark.parametrize(("domain", "expected"), [(None, 0), (1, 0), (2, 1), (3, 1)])
def test_domain_guidance_starts_at_the_second_level(domain, expected):
    guidance = assessment_advice(profile(domain=domain))[1]
    assert len(guidance) == expected
    if expected:
        assert "authoritative domain references" in guidance[0]


@pytest.mark.parametrize(("risk", "expected"), [(None, 0), (1, 0), (2, 0), (3, 1)])
def test_risk_guidance_only_for_the_highest_level(risk, expected):
    guidance = assessment_advice(profile(risk=risk))[1]
    assert len(guidance) == expected
    if expected:
        assert "human verification" in guidance[0]


@pytest.mark.parametrize(("tools", "expected"), [(None, 0), (1, 0), (2, 1), (3, 1)])
def test_tool_guidance_starts_at_the_second_level(tools, expected):
    guidance = assessment_advice(profile(tools=tools))[1]
    assert len(guidance) == expected
    if expected:
        assert "does not execute tools" in guidance[0]


def test_guidance_accumulates_in_dimension_order():
    guidance = assessment_advice(profile(domain=3, risk=3, tools=3))[1]
    assert [text.split()[0] for text in guidance] == ["Use", "Arrange", "Verify"]


@pytest.mark.parametrize("confidence", ["low", "undetermined"])
def test_weak_confidence_alone_makes_the_result_provisional(confidence):
    data = profile_data()
    data["risk"]["confidence"] = confidence
    if confidence == "undetermined":
        data["risk"]["score"] = None
    questions, _, provisional = assessment_advice(Profile.model_validate(data))
    assert questions == []
    assert provisional is True


@pytest.mark.parametrize("confidence", ["medium", "high"])
def test_medium_and_high_confidence_are_not_provisional(confidence):
    data = profile_data()
    data["tools"]["confidence"] = confidence
    assert assessment_advice(Profile.model_validate(data))[2] is False


# workflow


async def run(assessed: Profile, **request) -> dict:
    graph = build_workflow(StaticProvider(assessed))
    return await graph.ainvoke({"request": AnalysisRequest(task="Synthetic task", **request)})


async def test_workflow_returns_ranked_candidates_and_provider_usage():
    state = await run(profile(reasoning=3, context=1))
    assert [item.id for item in state["candidates"]][0] == "demo-advanced"
    assert state["usage"] == {"total_tokens": 7}
    assert state["clarification_questions"] == []
    assert state["recommendation_provisional"] is False


async def test_workflow_rationale_states_requirements_and_capacity():
    state = await run(profile(reasoning=2, context=3), required_capabilities=["text", "code"])
    rationale = state["rationale"]
    assert "Required capabilities: code, text." in rationale
    assert "Assessed reasoning/context capacity: 3/3." in rationale
    assert "undetermined" not in rationale
    assert "Qualitative confidence remains uncalibrated." in rationale


async def test_workflow_rationale_flags_unknown_capacity_as_provisional():
    state = await run(profile(context=None))
    rationale = state["rationale"]
    assert "Assessed reasoning/context capacity: 2/3." in rationale
    assert "middle tier is provisional" in rationale
    assert "Recommendation is provisional" in rationale
    assert state["recommendation_provisional"] is True
    assert state["clarification_questions"] == [STEPS_QUESTION]


async def test_workflow_adds_vision_requirement_from_image_modality():
    data = profile_data()
    data["modality"]["required"] = ["image"]
    state = await run(Profile.model_validate(data))
    assert [item.id for item in state["candidates"]] == ["demo-advanced"]
    assert "Required capabilities: text, vision." in state["rationale"]


async def test_workflow_fails_closed_when_no_candidate_is_eligible():
    data = profile_data()
    data["modality"]["required"] = ["video"]
    with pytest.raises(ProviderFailure) as failure:
        await run(Profile.model_validate(data))
    assert failure.value.code == "no_eligible_candidate"


async def test_workflow_rejects_malformed_provider_output():
    class Malformed:
        async def assess(self, task):
            return {"profile": {"reasoning": 2}}

    with pytest.raises(ValidationError):
        await build_workflow(Malformed()).ainvoke({"request": AnalysisRequest(task="Task")})


# domain models


def test_dimension_score_and_confidence_must_agree_about_uncertainty():
    with pytest.raises(ValidationError):
        Dimension(score=2, confidence="undetermined", evidence="Contradiction")
    with pytest.raises(ValidationError):
        Dimension(score=None, confidence="medium", evidence="Contradiction")
    assert Dimension(score=None, confidence="undetermined", evidence="Unknown").score is None


def test_dimension_evidence_is_trimmed_and_length_limited():
    assert Dimension(score=1, confidence="low", evidence="  padded  ").evidence == "padded"
    with pytest.raises(ValidationError):
        Dimension(score=1, confidence="low", evidence="x" * 241)


def test_modality_requires_agreement_between_categories_and_confidence():
    with pytest.raises(ValidationError):
        Modality(required=None, confidence="high", evidence="Contradiction")
    with pytest.raises(ValidationError):
        Modality(required=["text"], confidence="undetermined", evidence="Contradiction")
    with pytest.raises(ValidationError):
        Modality(required=["audio", "audio"], confidence="high", evidence="Duplicate")
    assert Modality(required=["audio", "text"], confidence="high", evidence="Both").required == [
        "audio",
        "text",
    ]


def test_profile_rejects_unknown_fields_and_oversized_explanations():
    data = profile_data()
    with pytest.raises(ValidationError):
        Profile.model_validate({**data, "unexpected": 1})
    with pytest.raises(ValidationError):
        Profile.model_validate({**data, "explanation": "x" * 1201})
    with pytest.raises(ValidationError):
        Profile.model_validate({**data, "explanation": ""})


@pytest.mark.parametrize("capacity", [0, 4])
def test_candidate_capacity_is_bounded(capacity):
    with pytest.raises(ValidationError):
        Candidate(id="x", name="X", capacity=capacity, capabilities=["text"])


def test_assessment_usage_is_optional():
    assert Assessment(profile=profile()).usage is None
