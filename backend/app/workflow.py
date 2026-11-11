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
    # ADR-014 A12: rated catalogue models the user could pick (OpenRouter), for one suggestion.
    suggestion_pool: list[Option]
    suggestion: dict | None
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


BANDS = {"low": 0, "medium": 1, "high": 2}


def user_cost(item: dict) -> float:
    """What the user pays per million tokens: nothing for project, local or free models."""
    if (item["configuration_id"] or "").startswith("server:") or item["local"] or item["free"]:
        return 0.0
    return item["blended_price"] or 0.0


def suggest(needs, options, pool, result, ratings) -> dict | None:
    """At most one catalogue model that does this task better than the user's own (A12).

    Better = it covers needs the user's best falls short on, or covers as much for less.
    Never above the user's highest cost band; never when the recommendation is illustrative.
    """
    if not pool or result.illustrative or ratings is None:
        return None
    own = [item for item in result.candidates if not item["illustrative"]]
    bands = [BANDS[item["cost_band"]] for item in own if item["cost_band"] in BANDS]
    ceiling = max(bands) if bands else BANDS["low"]
    best = result.candidates[0]
    known = {(option.provider, option.model) for option in options}
    fresh = [option for option in pool if (option.provider, option.model) not in known]
    if not fresh:
        return None
    try:
        wider = recommend(needs, [*options, *fresh], ratings.catalogue, ratings.card)
    except NoEligibleModel:
        return None
    pick = wider.candidates[0]
    if (pick["provider"], pick["model"]) in known or pick["illustrative"]:
        return None
    if BANDS.get(pick["cost_band"] or "high", 2) > ceiling:
        return None
    if best["status"] != "covers" and pick["status"] == "covers":
        reason = (
            f"covers {', '.join(best['shortfalls'])}, where {best['label']} falls short"
            if best["shortfalls"]
            else f"covers the task, which {best['label']} does not fully cover"
        )
    elif pick["status"] == best["status"] and (pick["blended_price"] or 0) < user_cost(best):
        reason = f"covers the task as well as {best['label']} for less"
    else:
        return None
    return pick | {"reason": reason}


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
        suggestion = suggest(
            needs, state.get("options", []), state.get("suggestion_pool") or [], result, ratings
        )
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
            "suggestion": suggestion,
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
