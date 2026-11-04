import json
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from app.assessment import (
    GRADING,
    SPREAD,
    assessment_advice,
    completeness,
    demand_estimate,
    required_capabilities,
    tier_fit,
    tips,
)
from app.models import AnalysisRequest, Assessment, Candidate, Profile, Tip
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
    tips: list[Tip]
    recommendation_provisional: bool
    grading: dict
    completeness: int


def rank(profile: Profile, required: list[str]) -> list[Candidate]:
    demand, spread = demand_estimate(profile)
    eligible = []
    for item in CATALOGUE["models"]:
        if not set(required) <= set(item["capabilities"]):
            continue
        sufficiency, fit = tier_fit(item["capacity"], demand, spread)
        eligible.append(
            Candidate.model_validate(
                {**item, "sufficiency": round(sufficiency, 3), "fit": round(fit, 3)}
            )
        )
    return sorted(eligible, key=lambda item: (-item.fit, item.capacity, item.id))


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
        demand, spread = demand_estimate(profile)
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
            "tips": tips(profile, questions),
            "recommendation_provisional": provisional,
            "grading": {
                "demand": round(demand, 3),
                "spread": round(spread, 3),
                "parameters": {**GRADING, "spread_by_confidence": SPREAD},
                "basis": "Uncalibrated estimate; not a probability",
            },
            "completeness": completeness(profile, provisional),
            "rationale": (
                f"Required capabilities: {requirements}. "
                f"Estimated reasoning/context demand: {demand:.1f}/3 "
                f"(uncertainty ±{spread:.1f}). "
                + uncertainty_note
                + "This eligible tier has the highest estimated fit "
                f"({round(candidates[0].fit * 100)}%). Review domain references, "
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
