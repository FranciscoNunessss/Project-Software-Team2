import json
from pathlib import Path
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from app.models import AnalysisRequest, Assessment, Candidate, Profile
from app.providers import AssessmentProvider, ProviderFailure

CATALOGUE = json.loads((Path(__file__).parent.parent / "data/catalogue.json").read_text())


class State(TypedDict, total=False):
    request: AnalysisRequest
    profile: Profile
    candidates: list[Candidate]
    rationale: str
    usage: dict[str, int] | None


def rank(profile: Profile, required: list[str]) -> list[Candidate]:
    eligible = [
        Candidate.model_validate(item)
        for item in CATALOGUE["models"]
        if set(required) <= set(item["capabilities"])
    ]
    target = max(profile.reasoning, profile.context, profile.ambiguity)
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
        candidates = rank(state["profile"], state["request"].required_capabilities)
        if not candidates:
            raise ProviderFailure("no_eligible_candidate")
        target = max(
            state["profile"].reasoning, state["profile"].context, state["profile"].ambiguity
        )
        required = ", ".join(state["request"].required_capabilities) or "none"
        return {
            "candidates": candidates,
            "rationale": (
                f"Required capabilities: {required}. "
                f"Maximum assessed dimension: {target}/3. Prototype policy selects the closest "
                "sufficient catalogue tier, then lists other eligible options."
            ),
        }

    graph = StateGraph(State)
    graph.add_node("assess", assess)
    graph.add_node("match", match)
    graph.add_edge(START, "assess")
    graph.add_edge("assess", "match")
    graph.add_edge("match", END)
    return graph.compile()  # No checkpoints: raw tasks are transient.
