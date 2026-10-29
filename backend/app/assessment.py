"""Provisional profile policy. Confidence is qualitative and uncalibrated."""

from app.models import Change, Profile, Tip
from app.prompt_builder import ClarifyWhen, active_rubric, build_assessment_prompt

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


def _asks(when: ClarifyWhen | None, *, score: int | None = None, required=()) -> bool:
    if when is None:
        return False
    if when.score_in is not None and score in when.score_in:
        return True
    return bool(when.required_unknown) and required is None


def clarification_questions(profile: Profile) -> list[str]:
    """Rubric clarification questions, ordered by clarify_order and de-duplicated by text."""
    rubric = active_rubric()
    asked = [
        (item.clarify_order, item.clarify_question)
        for item in rubric.dimensions
        if _asks(item.clarify_when, score=getattr(profile, item.name).score)
    ]
    if _asks(rubric.modality.clarify_when, required=profile.modality.required):
        asked.append((rubric.modality.clarify_order, rubric.modality.clarify_question))
    asked.sort(key=lambda pair: (pair[0] is None, pair[0] or 0))
    return list(dict.fromkeys(question for _, question in asked if question))


def tips(profile: Profile, questions: list[str]) -> list[Tip]:
    """Up to three rubric tips; none while clarification questions are outstanding."""
    if questions:
        return []
    rubric = active_rubric()
    names = [item.name for item in rubric.dimensions]
    scores = {name: getattr(profile, name).score for name in names}
    if (
        None not in scores.values()
        and profile.modality.required is not None
        and scores["reasoning"] <= 1
        and scores["context"] <= 1
        and scores["ambiguity"] == 1
    ):
        return [Tip(dimension=None, text=rubric.general_tips.simple_task)]
    ordered = sorted(
        names,
        key=lambda name: (
            name != "ambiguity",
            scores[name] is not None,
            -(scores[name] or 0),
            names.index(name),
        ),
    )
    result = []
    for name in ordered:
        text = rubric.dimension(name).tips.for_score(scores[name])
        if text:
            result.append(Tip(dimension=name, text=text))
    return result[:3]


def assessment_advice(profile: Profile) -> tuple[list[str], list[str], bool]:
    questions = clarification_questions(profile)
    guidance = []
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
