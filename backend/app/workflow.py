from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.assessment import assessment_advice, completeness, required_capabilities, tips
from app.catalogue import active_catalogue
from app.models import AnalysisRequest, Assessment, Candidate, Profile, Tip
from app.providers import AssessmentProvider, ProviderFailure
from app.recommendation import NoEligibleModel, Option, recommend, task_needs


class State(TypedDict, total=False):
    request: AnalysisRequest
    # The models the user can send to (server and personal), for available_cards.
    options: list[Option]
    # Gives each option its card and levels (app.evaluations.Ratings).
    ratings: Any
    # Length of the user's own task text, without personal or session context.
    task_chars: int
    profile: Profile
    candidates: list[dict]
    rationale: str
    usage: dict[str, int] | None
    clarification_questions: list[str]
    guidance: list[str]
    tips: list[Tip]
    recommendation_provisional: bool
    completeness: int
    needs: dict
    notes: list[str]


def rank(
    profile: Profile, required: list[str], options: list[Option] | None = None, task_chars=0
) -> list[Candidate]:
    """The recommendation first, then the alternatives; empty when no model is eligible."""
    needs = task_needs(profile, task_chars, required)
    try:
        result = recommend(needs, options or [], active_catalogue())
    except NoEligibleModel:
        return []
    return [Candidate.model_validate(item) for item in result.candidates]


def build_workflow(provider: AssessmentProvider):
    async def assess(state: State):
        assessment = Assessment.model_validate(await provider.assess(state["request"].task))
        return {"profile": assessment.profile, "usage": assessment.usage}

    def match(state: State):
        profile = state["profile"]
        required = required_capabilities(profile, state["request"].required_capabilities)
        needs = task_needs(profile, state.get("task_chars", len(state["request"].task)), required)
        try:
            catalogue = active_catalogue()
            ratings = state.get("ratings")
            if ratings is not None:
                ratings.catalogue = catalogue
            result = recommend(
                needs, state.get("options", []), catalogue, ratings.card if ratings else None
            )
        except NoEligibleModel:
            raise ProviderFailure("no_eligible_candidate") from None
        questions, guidance, described_provisional = assessment_advice(profile)
        provisional = described_provisional or result.provisional
        return {
            "candidates": result.candidates,
            "clarification_questions": questions,
            "guidance": guidance,
            "tips": tips(profile, questions),
            "recommendation_provisional": provisional,
            # Completeness measures the description only, not the catalogue's uncertainty.
            "completeness": completeness(profile, described_provisional),
            "needs": needs.public(),
            "notes": result.notes,
            "rationale": result.rationale
            + (
                " The recommendation is provisional: review the uncertain dimensions and the "
                "clarification prompts."
                if provisional
                else ""
            ),
        }

    graph = StateGraph(State)
    graph.add_node("assess", assess)
    graph.add_node("match", match)
    graph.add_edge(START, "assess")
    graph.add_edge("assess", "match")
    graph.add_edge("match", END)
    return graph.compile()  # No checkpoints: raw tasks are transient.
