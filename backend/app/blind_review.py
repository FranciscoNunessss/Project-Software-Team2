"""M2 and M6: the blind-review packet and the scoring of the reviewers' answers (KR1.1).

``packet`` takes one complete evaluation run (M3/M5 report) and builds the items the outside
reviewers judge: the 20 recommendations plus control items whose model was picked by a fixed rule
(always the cheapest, always the top), shuffled per reviewer with a recorded seed. ``score`` applies
the protocol in ``docs/ws5/m2-blind-review-protocol.md``: an item is correct when a strict majority
of the reviewers who answered it said A or B; a split is not correct; controls never count.

Stored answers hold only the reviewer id (R1, R2, R3), the item, the answer and the confidence:
names stay in the team's Drive and free-text reasons are not kept.
"""

from __future__ import annotations

import random

from app.agreement import cohen_kappa, fleiss_kappa, percent

ANSWERS = ("A", "B", "C", "D")
CORRECT = frozenset({"A", "B"})
CONFIDENCE = ("sure", "fairly_sure", "guessing")
ANSWER_FIELDS = frozenset({"reviewer", "item", "answer", "confidence"})
SET_SIZE = 20
TARGET = 16
CONTROLS = 6
LOW_AGREEMENT = 0.4
MIN_REVIEWERS = 2
NOT_RUN = "not_run"
MEASURED = "measured"


class ReviewError(ValueError):
    pass


def packet(
    report: dict,
    prices: dict[str, float],
    reference: str,
    reviewers: tuple[str, ...] = ("R1", "R2", "R3"),
    seed: int = 0,
    controls: int = CONTROLS,
    size: int = SET_SIZE,
) -> dict:
    """Items and per-reviewer orders from the first repeat of a complete, measured run.

    ``prices`` maps the real card ids to their blended price (the cheapest is the low control);
    ``reference`` is the top model of the savings method (the high control).
    """
    if report.get("status") == NOT_RUN:
        raise ReviewError("the run was NOT RUN: there is nothing to review")
    first = [row for row in report.get("rows", []) if row.get("repeat", 0) == 0]
    failed = [row["task"] for row in first if "recommended" not in row]
    if failed:
        raise ReviewError(f"no recommendation for: {', '.join(sorted(failed))}")
    if any(row.get("illustrative") for row in first):
        raise ReviewError("a recommendation used the illustrative demo models, not real ones")
    tasks = {row["task"]: row["recommended"] for row in first}
    if len(tasks) != size or len(first) != size:
        raise ReviewError(f"the run has {len(tasks)} recommended tasks, the review needs {size}")
    if reference not in prices:
        raise ReviewError(f"the reference model {reference!r} has no price")
    cheapest = min(prices, key=lambda card: (prices[card], card))
    rng = random.Random(seed)
    entries = [{"task": task, "model": model, "control": None} for task, model in tasks.items()]
    for number, task in enumerate(rng.sample(sorted(tasks), controls)):
        low = number < controls // 2
        entries.append(
            {
                "task": task,
                "model": cheapest if low else reference,
                "control": "cheapest" if low else "top",
            }
        )
    rng.shuffle(entries)
    items = [{"item": f"I{index + 1:02d}", **entry} for index, entry in enumerate(entries)]
    ids = [item["item"] for item in items]
    return {
        "seed": seed,
        "run": {
            key: report.get(key) for key in ("date", "commit", "provider", "model", "catalogue")
        },
        "task_set": report.get("task_set"),
        "reference": reference,
        "items": items,
        "orders": {reviewer: rng.sample(ids, len(ids)) for reviewer in reviewers},
    }


def check_answers(answers: list[dict], items: set[str]) -> None:
    problems = []
    for number, answer in enumerate(answers):
        extra = set(answer) - ANSWER_FIELDS
        if extra:
            problems.append(f"answer {number}: fields not allowed: {', '.join(sorted(extra))}")
        if answer.get("answer") not in ANSWERS:
            problems.append(f"answer {number}: answer must be A, B, C or D")
        if answer.get("confidence") not in CONFIDENCE:
            problems.append(f"answer {number}: confidence must be one of {', '.join(CONFIDENCE)}")
        if answer.get("item") not in items:
            problems.append(f"answer {number}: unknown item {answer.get('item')!r}")
        if not str(answer.get("reviewer", "")).strip():
            problems.append(f"answer {number}: no reviewer id")
    if problems:
        raise ReviewError("; ".join(problems))


def score(review_packet: dict, answers: list[dict], target: int = TARGET) -> dict:
    """KR1.1 count, verdict per item, gaps, agreement and how reviewers judged the controls."""
    items = {item["item"]: item for item in review_packet["items"]}
    check_answers(answers, set(items))
    reviewers = sorted({answer["reviewer"] for answer in answers})
    if len(reviewers) < MIN_REVIEWERS:
        return {
            "status": NOT_RUN,
            "reason": f"{len(reviewers)} reviewer(s) answered; the protocol needs at least 2",
        }
    given = {(answer["reviewer"], answer["item"]): answer["answer"] for answer in answers}
    verdicts, gaps = {}, []
    for item_id, item in items.items():
        if item["control"]:
            continue
        votes = [given[(r, item_id)] for r in reviewers if (r, item_id) in given]
        gaps += [{"reviewer": r, "item": item_id} for r in reviewers if (r, item_id) not in given]
        yes = sum(vote in CORRECT for vote in votes)
        verdicts[item_id] = {
            "task": item["task"],
            "model": item["model"],
            "votes": votes,
            "correct": bool(votes) and 2 * yes > len(votes),
            "split": bool(votes) and 2 * yes == len(votes),
        }
    complete = [
        item_id
        for item_id in verdicts
        if all((reviewer, item_id) in given for reviewer in reviewers)
    ]
    binary = [[given[(r, item_id)] in CORRECT for r in reviewers] for item_id in complete]
    if len(reviewers) == 2:
        first, second = [row[0] for row in binary], [row[1] for row in binary]
        kappa, kind = cohen_kappa(first, second), "cohen"
        agreed = percent(first, second)
    else:
        kappa, kind = fleiss_kappa(binary), "fleiss"
        agreed = (
            round(100 * sum(len(set(row)) == 1 for row in binary) / len(binary), 1)
            if binary
            else None
        )
    controls = {
        reviewer: {
            kind_: [
                given[(reviewer, item_id)] in CORRECT
                for item_id, item in items.items()
                if item["control"] == kind_ and (reviewer, item_id) in given
            ]
            for kind_ in ("cheapest", "top")
        }
        for reviewer in reviewers
    }
    count = sum(verdict["correct"] for verdict in verdicts.values())
    return {
        "status": MEASURED,
        "reviewers": reviewers,
        "correct": count,
        "out_of": len(verdicts),
        "target": target,
        "passes": count >= target,
        "splits": sorted(item_id for item_id, v in verdicts.items() if v["split"]),
        "gaps": gaps,
        "agreement": {
            "percent": agreed,
            "kappa": kappa,
            "kind": kind,
            "low": kappa is not None and kappa < LOW_AGREEMENT,
            "items": len(complete),
        },
        "controls_judged_correct": {
            reviewer: {kind_: f"{sum(v)}/{len(v)}" for kind_, v in judged.items()}
            for reviewer, judged in controls.items()
        },
        "items": verdicts,
    }
