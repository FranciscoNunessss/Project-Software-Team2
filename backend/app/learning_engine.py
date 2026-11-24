"""WS4 indicator engine (L2, L3, L12): patterns, maturity and confidence from derived data only.

Pure functions: no database, no language model, no task text. The input is a user's tasks in
time order, each reduced to scores, enums and counts (``TaskRecord``); the output is the
indicators My progress, the Educator and the Team Scope read. Every rule lives in the release
plan (WS4, "Pattern catalogue" and "Maturity calculation") and is unit-tested at its
boundaries in ``tests/test_learning_engine.py``.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Literal

ENGINE_VERSION = "learning-engine-1"

# Request-quality dimensions (L1): how the user frames a task, scored 0, 1, 2 or None (NA).
DIMENSIONS = (
    "objective",
    "context",
    "constraints",
    "risks",
    "ambiguity",
    "success_criteria",
    "audience_format",
)

Sizing = Literal["over", "match", "under"]
Outcome = Literal["yes", "partly", "no"]

PATTERN_WINDOW = 5  # tasks a pattern looks at
PATTERN_HITS = 3  # 3 of 5 is a pattern; fewer (exactly half or less) is not
GOOD_CHOICE_HITS = 4
MATURITY_WINDOW = 10
MIN_LEVEL_TASKS = 5
DROP_SHARE = 0.2  # the weakest 20% of a window are dropped (2 of 10, 1 of 5 to 9)
HYSTERESIS_TASKS = 3
COACH_MIN_GAPS = 2
COACH_MIN_EACH = 5

# Stability of each dimension across runs, measured by the M3 harness for the active prompt
# version (1.0 = identical in every run). Until M3 measures L1, every dimension counts as stable.
DEFAULT_STABILITY = {name: 1.0 for name in DIMENSIONS}
STABLE_ENOUGH = 0.8
VARIED_SPREAD = 0.8


@dataclass(frozen=True)
class CoachUse:
    gaps: int
    accepted: bool


@dataclass(frozen=True)
class TaskRecord:
    """One analysed task, reduced to what the rules need. Never any text."""

    task_id: str
    scores: dict[str, int | None] | None = None  # L1 per dimension; None = not assessed
    sizing: Sizing | None = None  # chosen model against the recommendation
    outcome: Outcome | None = None  # "Did it solve it?"
    coach: CoachUse | None = None
    turns: int | None = None
    switched_model: bool | None = None
    surface: Literal["web", "ide"] = "web"
    excluded: bool = False
    paused: bool = False


@dataclass
class DimensionLevel:
    level: int | None
    tasks: int
    confidence: Literal["high", "medium", "low"] | None
    confidence_reasons: list[str] = field(default_factory=list)


@dataclass
class Pattern:
    code: str
    kind: Literal["improve", "positive"]
    hits: int
    window: int
    dimension: str | None = None
    level_from: int | None = None
    level_to: int | None = None


@dataclass
class Indicators:
    version: str
    tasks: int
    dimensions: dict[str, DimensionLevel]
    overall_level: int | None
    patterns: list[Pattern]

    def as_dict(self) -> dict:
        return {
            "version": self.version,
            "tasks": self.tasks,
            "overall_level": self.overall_level,
            "dimensions": {
                name: {
                    "level": item.level,
                    "tasks": item.tasks,
                    "confidence": item.confidence,
                    "confidence_reasons": item.confidence_reasons,
                }
                for name, item in self.dimensions.items()
            },
            "patterns": [
                {
                    "code": p.code,
                    "kind": p.kind,
                    "hits": p.hits,
                    "window": p.window,
                    "dimension": p.dimension,
                    "level_from": p.level_from,
                    "level_to": p.level_to,
                }
                for p in self.patterns
            ],
        }


# ---- maturity (L3) -------------------------------------------------------------------------


def raw_level(window: Sequence[int]) -> int | None:
    """Level 1 to 4 from the scores of one window, after dropping its weakest share.

    Level 4: at least 70% score 2. Level 3: at least 70% score 1 or more and at least 40%
    score 2. Level 2: at least 40% score 1 or more. Level 1 otherwise. None below 5 scores.
    """
    if len(window) < MIN_LEVEL_TASKS:
        return None
    drop = int(len(window) * DROP_SHARE)
    kept = sorted(window)[drop:]
    n = len(kept)
    at_two = sum(score == 2 for score in kept) / n
    at_one = sum(score >= 1 for score in kept) / n
    if at_two >= 0.7:
        return 4
    if at_one >= 0.7 and at_two >= 0.4:
        return 3
    if at_one >= 0.4:
        return 2
    return 1


def level_history(scores: Sequence[int]) -> list[int | None]:
    """The level after each applicable score, with hysteresis.

    A level goes up as soon as the window meets a higher threshold. It goes down only after
    HYSTERESIS_TASKS consecutive tasks below the current level, and then to the window's level.
    """
    history: list[int | None] = []
    current: int | None = None
    below = 0
    for index in range(len(scores)):
        window = scores[max(0, index + 1 - MATURITY_WINDOW) : index + 1]
        raw = raw_level(window)
        if raw is None:
            history.append(None)
            continue
        if current is None or raw > current:
            current, below = raw, 0
        elif raw < current:
            below += 1
            if below >= HYSTERESIS_TASKS:
                current, below = raw, 0
        else:
            below = 0
        history.append(current)
    return history


def lower_median(values: Sequence[int]) -> int | None:
    if not values:
        return None
    return statistics.median_low(values)


def confidence(
    window: Sequence[int], stability: float
) -> tuple[Literal["high", "medium", "low"] | None, list[str]]:
    """High, medium or low from sample size, spread and the dimension's measured stability."""
    if len(window) < MIN_LEVEL_TASKS:
        return None, ["few_tasks"]
    points = 2 if len(window) >= MATURITY_WINDOW else 1 if len(window) >= 7 else 0
    reasons = [] if points == 2 else ["few_tasks"]
    if statistics.pstdev(window) > VARIED_SPREAD:
        points -= 1
        reasons.append("varied_scores")
    if stability < STABLE_ENOUGH:
        points -= 1
        reasons.append("less_stable_dimension")
    label = "high" if points >= 2 else "medium" if points == 1 else "low"
    return label, reasons


# ---- patterns (L2) -------------------------------------------------------------------------


def _counted(tasks: Iterable[TaskRecord]) -> list[TaskRecord]:
    return [task for task in tasks if not task.excluded and not task.paused]


def applicable_scores(tasks: Sequence[TaskRecord], dimension: str) -> list[int]:
    return [
        task.scores[dimension]
        for task in tasks
        if task.scores is not None and task.scores.get(dimension) is not None
    ]


def _last(items: Sequence, n: int = PATTERN_WINDOW) -> Sequence:
    return items[-n:]


def dimension_patterns(dimension: str, scores: Sequence[int]) -> list[Pattern]:
    found = []
    if len(scores) >= PATTERN_WINDOW:
        window = _last(scores)
        zeros = sum(score == 0 for score in window)
        if zeros >= PATTERN_HITS:
            found.append(Pattern("missing_dimension", "improve", zeros, len(window), dimension))
    history = level_history(scores)
    if len(history) > PATTERN_WINDOW:
        now, before = history[-1], history[-1 - PATTERN_WINDOW]
        if now is not None and before is not None and now > before:
            found.append(
                Pattern(
                    "improving_dimension",
                    "positive",
                    PATTERN_WINDOW,
                    PATTERN_WINDOW,
                    dimension,
                    level_from=before,
                    level_to=now,
                )
            )
    return found


def sizing_patterns(tasks: Sequence[TaskRecord]) -> list[Pattern]:
    decided = [task for task in tasks if task.sizing is not None and task.outcome is not None]
    if len(decided) < PATTERN_WINDOW:
        return []
    window = _last(decided)
    found = []
    over = sum(t.sizing == "over" and t.outcome in ("yes", "partly") for t in window)
    under = sum(t.sizing == "under" and t.outcome == "no" for t in window)
    good = sum(t.sizing == "match" and t.outcome == "yes" for t in window)
    if over >= PATTERN_HITS:
        found.append(Pattern("over_sizing", "improve", over, len(window)))
    if under >= PATTERN_HITS:
        found.append(Pattern("under_sizing", "improve", under, len(window)))
    if good >= GOOD_CHOICE_HITS:
        found.append(Pattern("good_model_choice", "positive", good, len(window)))
    return found


def coach_patterns(tasks: Sequence[TaskRecord]) -> list[Pattern]:
    found = []
    gapped = [t for t in tasks if t.coach is not None and t.coach.gaps >= COACH_MIN_GAPS]
    if len(gapped) >= PATTERN_WINDOW:
        window = _last(gapped)
        rejected = sum(not t.coach.accepted for t in window)
        if rejected >= PATTERN_HITS:
            found.append(Pattern("coach_ignored", "improve", rejected, len(window)))
    rated = [t for t in tasks if t.coach is not None and t.outcome is not None]
    accepted = [t for t in rated if t.coach.accepted]
    rejected_all = [t for t in rated if not t.coach.accepted]
    if len(accepted) >= COACH_MIN_EACH and len(rejected_all) >= COACH_MIN_EACH:

        def solved(items):
            return sum(t.outcome == "yes" for t in items) / len(items)

        if solved(accepted) > solved(rejected_all):
            found.append(
                Pattern(
                    "coach_pays_off", "positive", len(accepted), len(accepted) + len(rejected_all)
                )
            )
    return found


def interaction_patterns(tasks: Sequence[TaskRecord]) -> list[Pattern]:
    found = []
    resolved = [t for t in tasks if t.turns is not None and t.outcome in ("yes", "partly")]
    if len(resolved) >= PATTERN_WINDOW:
        median = statistics.median(t.turns for t in resolved)
        window = _last(resolved)
        long = sum(t.turns > median for t in window)
        if long >= PATTERN_HITS:
            found.append(Pattern("long_chats", "improve", long, len(window)))
    chats = [t for t in tasks if t.switched_model is not None]
    if len(chats) >= PATTERN_WINDOW:
        window = _last(chats)
        switched = sum(bool(t.switched_model) for t in window)
        if switched >= PATTERN_HITS:
            found.append(Pattern("model_switching", "improve", switched, len(window)))
    return found


# ---- entry point ---------------------------------------------------------------------------


def compute(tasks: Sequence[TaskRecord], stability: dict[str, float] | None = None) -> Indicators:
    """Indicators for one user from their tasks in time order (oldest first)."""
    stability = {**DEFAULT_STABILITY, **(stability or {})}
    counted = _counted(tasks)
    dimensions: dict[str, DimensionLevel] = {}
    patterns: list[Pattern] = []
    for name in DIMENSIONS:
        scores = applicable_scores(counted, name)
        history = level_history(scores)
        window = list(_last(scores, MATURITY_WINDOW))
        label, reasons = confidence(window, stability[name])
        dimensions[name] = DimensionLevel(
            level=history[-1] if history else None,
            tasks=len(scores),
            confidence=label,
            confidence_reasons=reasons,
        )
        patterns.extend(dimension_patterns(name, scores))
    patterns.extend(sizing_patterns(counted))
    patterns.extend(coach_patterns(counted))
    patterns.extend(interaction_patterns(counted))
    levels = [item.level for item in dimensions.values() if item.level is not None]
    return Indicators(
        version=ENGINE_VERSION,
        tasks=len(counted),
        dimensions=dimensions,
        overall_level=lower_median(levels),
        patterns=patterns,
    )
