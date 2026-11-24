"""WS4 L1 and L10: deterministic guards on request-quality scores, and their stored codes.

The assessor (rubric-2.2 and later) scores how a request is framed. This module never trusts
those scores blindly: guards in code cap what the request cannot support, and the only things
stored are the scores and a reason code from a closed list. The assessor's free-text reasons
are shown once with the analysis and never stored (``storage.history_result``).
"""

from __future__ import annotations

import re
from typing import Literal

from app.models import QualityScore, RequestQuality

DIMENSIONS = (
    "objective",
    "context",
    "constraints",
    "risks",
    "ambiguity",
    "success_criteria",
    "audience_format",
)
LEVEL_NAMES = {0: "missing", 1: "partial", 2: "clear", None: "na"}
# The closed list of reason codes, e.g. objective_missing, risks_na (L10 templates use them).
REASON_CODES = frozenset(f"{dim}_{name}" for dim in DIMENSIONS for name in LEVEL_NAMES.values())

SHORT_REQUEST_WORDS = 15
# Requests that ask for marks are content, never instructions (prompt-injection guard).
_ASKS_FOR_MARKS = re.compile(
    # Only explicit requests about the assessment itself: "give me 2 options", "grade 2
    # students" or "rate 2 suppliers" are ordinary tasks and must never match.
    r"full marks|maximum (?:score|marks)|top marks|perfect score|"
    r"\bgive (?:it|this|the request|my request) (?:a )?(?:2|two)\b|"
    r"\b(?:score|mark|rate|grade)\s+(?:this|it|me|the request|my request)\s+"
    r"(?:as\s+)?(?:a\s+)?(?:2|two|clear)\b|"
    r"\b2\s+(?:in|on|for)\s+(?:every|all|each)\s+(?:dimension|criteri(?:on|a)|categor(?:y|ies))|"
    r"ignore (?:the |all |any |previous |these )*(?:rubric|instructions|rules|scoring)|"
    r"nota m[áa]xima|pontua[çc][ãa]o m[áa]xima|"
    r"\b2\s+em\s+(?:todas|tudo|cada)",
    re.IGNORECASE,
)

Guard = Literal["short_request", "asks_for_marks", "objective_always_applies"]


def reason_code(dimension: str, score: int | None) -> str:
    code = f"{dimension}_{LEVEL_NAMES[score]}"
    if code not in REASON_CODES:  # unreachable with validated scores; keeps the list closed
        raise ValueError(code)
    return code


def _capped(item: QualityScore, ceiling: int) -> QualityScore:
    if item.score is None or item.score <= ceiling:
        return item
    return QualityScore(score=ceiling, reason=item.reason)


def apply_guards(quality: RequestQuality, task: str) -> tuple[RequestQuality, list[Guard]]:
    """Scores the request cannot support are lowered; returns the guards that fired."""
    scores = {name: getattr(quality, name) for name in DIMENSIONS}
    fired: list[Guard] = []
    if scores["objective"].score is None:
        scores["objective"] = QualityScore(score=0, reason=scores["objective"].reason)
        fired.append("objective_always_applies")
    if len(task.split()) < SHORT_REQUEST_WORDS:
        for name in ("context", "constraints"):
            capped = _capped(scores[name], 1)
            if capped is not scores[name]:
                scores[name] = capped
                if "short_request" not in fired:
                    fired.append("short_request")
    if _ASKS_FOR_MARKS.search(task):
        changed = False
        for name in DIMENSIONS:
            capped = _capped(scores[name], 1)
            changed |= capped is not scores[name]
            scores[name] = capped
        if changed:
            fired.append("asks_for_marks")
    return RequestQuality(**scores), fired


def stored_row(quality: RequestQuality) -> dict:
    """Scores and reason codes for the request_quality table: never the reasons."""
    row: dict = {name: getattr(quality, name).score for name in DIMENSIONS}
    row["reason_codes"] = {name: reason_code(name, row[name]) for name in DIMENSIONS}
    return row


def summary(quality: RequestQuality) -> dict:
    """The compact indicator next to the analysis: clear dimensions out of applicable ones."""
    applicable = [getattr(quality, name).score for name in DIMENSIONS]
    applicable = [score for score in applicable if score is not None]
    return {
        "clear": sum(score == 2 for score in applicable),
        "applicable": len(applicable),
        "codes": {name: reason_code(name, getattr(quality, name).score) for name in DIMENSIONS},
    }


def demonstration_quality(task: str) -> RequestQuality:
    """Keyword heuristics for the demonstration provider: no language model, not semantic."""
    text = task.lower()
    words = len(task.split())
    note = "Demonstration keyword check, not a semantic assessment."

    def has(*terms):
        return any(term in text for term in terms)

    def item(score):
        return QualityScore(score=score, reason=note)

    return RequestQuality(
        objective=item(2 if words >= 8 else 1),
        context=item(0 if words < 15 else 1 if words < 60 else 2),
        constraints=item(
            2 if has("must", "only", "without", "no more than", "deve", "sem ") else 0
        ),
        risks=item(
            1 if has("risk", "sensitive", "private", "legal", "risco", "sensível") else None
        ),
        ambiguity=item(1),
        success_criteria=item(
            2 if has("so that", "success", "criteria", "acceptance", "critério", "sucesso") else 0
        ),
        audience_format=item(
            2 if has("table", "list", "json", "bullet", "email", "tabela", "lista") else 0
        ),
    )
