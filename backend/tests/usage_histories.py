"""Synthetic usage histories for the Educator (card "Synthetic usage histories with control
cases", AA-012, KR2.1).

Each history is the sequence of choices one simulated user made, oldest first:

- ``over``: confirmed a model that is more than the task needs (choice gap +1);
- ``under``: confirmed a model that covers less than the recommendation (choice gap -1);
- ``match``: confirmed the recommended model (choice gap 0);
- ``pending``: analysed the task and never confirmed a choice.

``expected`` is what the Educator must say about over- and under-provisioning. The pattern
histories show one behaviour clearly; the control histories show none, or too little to tell,
and must never be reported as a pattern. No history holds task text: the simulated tasks are
the same placeholder and only the choices differ.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class History:
    name: str
    choices: tuple[str, ...]
    over: str
    under: str
    why: str


def _choices(**counts):
    return tuple(kind for kind, count in counts.items() for _ in range(count))


HISTORIES = (
    # Patterns: the behaviour the client named.
    History(
        "over_provisioning",
        _choices(over=7, match=2, pending=1),
        "detected",
        "not_detected",
        "7 of 9 confirmed choices are larger than needed; the pending one does not count.",
    ),
    History(
        "under_provisioning",
        _choices(under=6, match=2),
        "not_detected",
        "detected",
        "6 of 8 confirmed choices cover less than the recommendation.",
    ),
    History(
        "over_provisioning_just_above_half",
        _choices(over=3, match=2),
        "detected",
        "not_detected",
        "Boundary: 3 of 5 is the smallest history that is both large enough and a majority.",
    ),
    # Controls: no pattern may be reported.
    History(
        "control_follows_recommendation",
        _choices(match=10),
        "not_detected",
        "not_detected",
        "Every choice is the recommendation.",
    ),
    History(
        "control_occasional_deviation",
        _choices(over=2, under=2, match=6),
        "not_detected",
        "not_detected",
        "A few choices each way are ordinary judgement, not a habit.",
    ),
    History(
        "control_exactly_half",
        _choices(over=3, match=3),
        "not_detected",
        "not_detected",
        "Boundary: half is not most.",
    ),
    History(
        "control_split_both_ways",
        _choices(over=4, under=4),
        "not_detected",
        "not_detected",
        "Never following the recommendation, but in neither direction most of the time.",
    ),
    History(
        "control_too_few_choices",
        _choices(over=4),
        "insufficient_history",
        "insufficient_history",
        "All four choices are larger, but four choices are too few to call a habit.",
    ),
    History(
        "control_only_pending",
        _choices(pending=8),
        "insufficient_history",
        "insufficient_history",
        "Eight analyses and no confirmed choice: nothing is known about the choices.",
    ),
    History(
        "control_empty",
        (),
        "insufficient_history",
        "insufficient_history",
        "A new account.",
    ),
)

GAP = {"over": 1, "under": -1, "match": 0}
