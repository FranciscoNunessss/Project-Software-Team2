"""Provisional profile policy. Confidence is qualitative and uncalibrated."""

from app.models import Change, Profile
from app.prompt_builder import active_rubric, build_assessment_prompt

PROFILE_VERSION = "profile-2"
POLICY_VERSION = "prototype-3"
# Generated from the active rubric version (ADR-009); the backend refuses to start if the
# rubric files are invalid or do not match backend/rubric/versions.json.
RUBRIC_VERSION = active_rubric().version
ASSESSMENT_PROMPT = build_assessment_prompt(active_rubric())


def capacity_target(profile: Profile) -> int:
    # A middle-tier placeholder is explicit when either capacity dimension is unknown.
    return max(
        profile.reasoning.score if profile.reasoning.score is not None else 2,
        profile.context.score if profile.context.score is not None else 2,
    )


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


SCORED_DIMENSIONS = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")
AMBIGUITY_WEIGHT = {1: 1.0, 2: 0.6, 3: 0.2, None: 0.0}


def completeness(profile: Profile, provisional: bool) -> int:
    """How much of the profile is determined and confident, 0-100. Not a calibrated measure."""
    dimensions = [getattr(profile, name) for name in SCORED_DIMENSIONS] + [profile.modality]
    determined = sum(item.score is not None for item in dimensions[:-1]) + (
        profile.modality.required is not None
    )
    confident = sum(dimension.confidence in {"medium", "high"} for dimension in dimensions)
    return round(
        100
        * (
            0.4 * determined / 7
            + 0.3 * confident / 7
            + 0.2 * AMBIGUITY_WEIGHT[profile.ambiguity.score]
            + 0.1 * (not provisional)
        )
    )


def _value(dimension: dict | None, name: str):
    dimension = dimension or {}
    return dimension.get("required") if name == "modality" else dimension.get("score")


def explain_changes(previous: dict, current: Profile) -> list[Change]:
    """Changed dimension values against a stored profile; the evidence is the new evidence."""
    changes = []
    for name in (*SCORED_DIMENSIONS, "modality"):
        new = getattr(current, name)
        before = _value(previous.get(name), name)
        after = new.required if name == "modality" else new.score
        if name == "modality" and before is not None and after is not None:
            unchanged = sorted(before) == sorted(after)
        else:
            unchanged = before == after
        if not unchanged:
            changes.append(
                Change(
                    dimension=name,
                    before=list(before) if isinstance(before, list) else before,
                    after=list(after) if isinstance(after, list) else after,
                    evidence=new.evidence,
                )
            )
    return changes
