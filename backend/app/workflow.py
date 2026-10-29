import json
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from app.assessment import (
    assessment_advice,
    capacity_target,
    completeness,
    required_capabilities,
)
from app.models import AnalysisRequest, Assessment, Candidate, Profile
from app.providers import AssessmentProvider, ProviderFailure

CATALOGUE = json.loads((Path(__file__).parent.parent / "data/catalogue.json").read_text())


class State(TypedDict, total=False):
    request: AnalysisRequest
    profile: Profile
    candidates: list[Candidate]
    rationale: str
    usage: dict[str, int] | None
    clarification_questions: list[str]
    guidance: list[str]
    recommendation_provisional: bool
    completeness: int


def rank(profile: Profile, required: list[str]) -> list[Candidate]:
    eligible = [
        Candidate.model_validate(item)
        for item in CATALOGUE["models"]
        if set(required) <= set(item["capabilities"])
    ]
    target = capacity_target(profile)
    return sorted(
        eligible,
        key=lambda item: (
            item.capacity < target,
            abs(item.capacity - target),
            item.id,
        ),
    )


def build_workflow(provider: AssessmentProvider):
    async def assess(state: State):
        assessment = Assessment.model_validate(await provider.assess(state["request"].task))
        return {"profile": assessment.profile, "usage": assessment.usage}

    def match(state: State):
        profile = state["profile"]
        required = required_capabilities(profile, state["request"].required_capabilities)
        candidates = rank(profile, required)
        if not candidates:
            raise ProviderFailure("no_eligible_candidate")
        target = capacity_target(profile)
        questions, guidance, provisional = assessment_advice(profile)
        requirements = ", ".join(required) or "none"
        uncertainty_note = (
            "Some capacity requirements are undetermined; the middle tier is provisional. "
            if profile.reasoning.score is None or profile.context.score is None
            else ""
        )
        return {
            "candidates": candidates,
            "clarification_questions": questions,
            "guidance": guidance,
            "recommendation_provisional": provisional,
            "completeness": completeness(profile, provisional),
            "rationale": (
                f"Required capabilities: {requirements}. "
                f"Assessed reasoning/context capacity: {target}/3. "
                + uncertainty_note
                + "This is the closest sufficient eligible tier. Review domain references, "
                "consequences of error and tool access separately. "
                + (
                    "Recommendation is provisional; review uncertainty and clarification prompts."
                    if provisional
                    else "Qualitative confidence remains uncalibrated."
                )
            ),
        }

    graph = StateGraph(State)
    graph.add_node("assess", assess)
    graph.add_node("match", match)
    graph.add_edge(START, "assess")
    graph.add_edge("assess", "match")
    graph.add_edge("match", END)
    return graph.compile()  # No checkpoints: raw tasks are transient.
