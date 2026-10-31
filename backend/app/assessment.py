"""Provisional profile policy. Confidence is qualitative and uncalibrated."""

from math import erf, exp, sqrt
from pathlib import Path

from app.models import Profile

PROFILE_VERSION = "profile-2"
# Reconcile with PR #10, which introduces "prototype-3", whichever merges second.
POLICY_VERSION = "prototype-2-graded"
ASSESSMENT_PROMPT = (Path(__file__).parent.parent / "prompts" / "assessment-v2.txt").read_text(
    encoding="utf-8"
)


def capacity_target(profile: Profile) -> int:
    # A middle-tier placeholder is explicit when either capacity dimension is unknown.
    return max(
        profile.reasoning.score if profile.reasoning.score is not None else 2,
        profile.context.score if profile.context.score is not None else 2,
    )


# Initial, uncalibrated parameters for the graded recommendation.
GRADING = {
    "max_weight": 0.75,
    "secondary_weight": 0.0,
    "over_capacity_penalty": 0.6,
    "ambiguity_spread": 0.2,
    "unknown_score": 2,
}
SPREAD = {"high": 0.25, "medium": 0.45, "low": 0.7, "undetermined": 0.9}
TOP_CAPACITY = 3


def _normal_cdf(value: float) -> float:
    return 0.5 * (1 + erf(value / sqrt(2)))


def demand_estimate(profile: Profile) -> tuple[float, float]:
    """Estimated reasoning/context demand on the 1-3 scale and its uncertainty."""

    def score(dimension) -> int:
        return dimension.score if dimension.score is not None else GRADING["unknown_score"]

    reasoning, context = score(profile.reasoning), score(profile.context)
    demand = (
        GRADING["max_weight"] * max(reasoning, context)
        + (1 - GRADING["max_weight"]) * (reasoning + context) / 2
        + GRADING["secondary_weight"] * ((score(profile.domain) + score(profile.tools)) / 2 - 1)
    )
    demand = min(3.0, max(1.0, demand))
    spread = sqrt(
        (SPREAD[profile.reasoning.confidence] ** 2 + SPREAD[profile.context.confidence] ** 2) / 2
    )
    if profile.ambiguity.score is None or profile.ambiguity.score == 3:
        spread += GRADING["ambiguity_spread"]
    return demand, spread


def tier_fit(capacity: int, demand: float, spread: float) -> tuple[float, float]:
    """Estimated sufficiency and fit of a tier. Uncalibrated; not a probability."""
    if capacity >= TOP_CAPACITY:
        sufficiency = 1.0
    else:
        sufficiency = _normal_cdf((capacity + 0.5 - demand) / spread)
    fit = sufficiency * exp(-GRADING["over_capacity_penalty"] * max(0.0, capacity - demand))
    return sufficiency, fit


def required_capabilities(profile: Profile, requested: list[str]) -> list[str]:
    modalities = profile.modality.required or []
    return sorted(set(requested) | {"vision" if item == "image" else item for item in modalities})


def assessment_advice(profile: Profile) -> tuple[list[str], list[str], bool]:
    questions = []
    guidance = []
    if profile.ambiguity.score is None or profile.ambiguity.score == 3:
        questions.append("What outcome and constraints would make the result correct?")
    if profile.reasoning.score is None or profile.context.score is None:
        questions.append("What steps, source material and dependencies must the task cover?")
    if profile.modality.required is None:
        questions.append("Does completing the task require text, images, audio or video?")
    if profile.domain.score is not None and profile.domain.score >= 2:
        guidance.append(
            "Use authoritative domain references; model size alone does not ensure expertise."
        )
    if profile.risk.score == 3:
        guidance.append("Arrange human verification before acting on a consequential result.")
    if profile.tools.score is not None and profile.tools.score >= 2:
        guidance.append(
            "Verify access to the required data, tools and integrations. This prototype does not "
            "execute tools or verify tool support in the illustrative catalogue."
        )
    dimensions = (
        profile.reasoning,
        profile.context,
        profile.ambiguity,
        profile.domain,
        profile.risk,
        profile.tools,
        profile.modality,
    )
    provisional = bool(questions) or any(
        dimension.confidence in {"low", "undetermined"} for dimension in dimensions
    )
    return questions, guidance, provisional
