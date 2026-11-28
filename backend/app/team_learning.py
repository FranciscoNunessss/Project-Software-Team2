"""Group learning aggregates (TL1 to TL4) and stored events for the dashboard (T2).

**Interim.** The release plan gives these aggregates to WS4 (TL0, and TL0b for the dashboard
source). Until they are merged, this module computes them from what is already stored so the WS3
screens can be built; replace ``group_learning`` and ``stored_events`` with WS4's functions then.

ADR-016 rules: aggregates only, at least ``k`` members behind every number, never task text, levels
without hysteresis (``level_raw``). The learning aggregates read closed weeks only, and a member
counts only if they joined before the last of them started. Not done here: frozen weekly snapshots
(rule 7), so a membership change still recomputes closed weeks.

E0b (``analyses.surface``, ``coach_uses``) is not merged either: both are read only if they exist.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

from app.learning import dated_tasks, reset_at, sizing
from app.learning_engine import DIMENSIONS, TaskRecord, compute, lower_median
from app.storage import Storage

OUTCOMES = {"resolved": "yes", "resolved_with_refinement": "partly", "not_resolved": "no"}


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _epoch(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


def _seconds(stamp: str) -> int:
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())


def _share(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def has_column(db, schema: str, table: str, column: str) -> bool:
    return bool(
        db.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name=%s AND column_name=%s",
            (schema, table, column),
        ).fetchone()
    )


# --- T2: choices, feedback, request quality and surface from the stored data -------------------


def stored_events(store: Storage, user_ids: list[str], start: date, end: date) -> list[dict]:
    """C2-shaped events of these users from ``start`` to ``end`` inclusive. No text."""
    with store.connect() as db:
        surface = (
            "a.surface" if has_column(db, store.schema, "analyses", "surface") else "NULL::text"
        )
        quality = ",".join(f"q.{name}" for name in DIMENSIONS)
        rows = db.execute(
            f"""SELECT s.user_id, a.created_at, a.result_json, d.candidate_id, o.outcome,
                       q.analysis_id AS assessed, {quality}, {surface} AS surface
                FROM analyses a JOIN sessions s ON s.id=a.session_id
                LEFT JOIN decisions d ON d.analysis_id=a.id
                LEFT JOIN task_outcomes o ON o.analysis_id=a.id
                LEFT JOIN request_quality q ON q.analysis_id=a.id
                WHERE s.user_id = ANY(%s) AND a.created_at >= %s AND a.created_at < %s""",
            (user_ids, start.isoformat(), (end + timedelta(days=1)).isoformat()),
        ).fetchall()
    events = []
    for row in rows:
        base = {"user_id": row["user_id"], "created_at": _seconds(row["created_at"])}
        events.append({**base, "event": "task_analysed", "surface": row["surface"]})
        choice = sizing(json.loads(row["result_json"]), row["candidate_id"])
        if choice:
            events.append({**base, "event": "recommendation_decided", "sizing": choice})
        if row["outcome"] in OUTCOMES:
            events.append(
                {**base, "event": "outcome_reported", "resolved": OUTCOMES[row["outcome"]]}
            )
        scores = [row[name] for name in DIMENSIONS if row["assessed"] and row[name] is not None]
        if scores:
            events.append(
                {**base, "event": "request_assessed", "clear": scores.count(2), "of": len(scores)}
            )
    return events


# --- TL1 to TL4 --------------------------------------------------------------------------------


def _tasks_before(store: Storage, user_id: str, before: date) -> list[TaskRecord]:
    since = reset_at(store, user_id)
    return [
        task
        for at, task in dated_tasks(store, user_id)
        if at < before.isoformat()
        and (since is None or at > since)
        and not task.excluded
        and not task.paused
    ]


def _dimensions(levels: dict[str, list[int]], before: dict[str, list[int]], k: int) -> dict:
    result = {}
    for name in DIMENSIONS:
        now = levels[name]
        if len(now) < k:
            result[name] = {"enough": False}
            continue
        earlier = before[name]
        result[name] = {
            "enough": True,
            "median": lower_median(now),
            "previous": lower_median(earlier) if len(earlier) >= k else None,
            "distribution": [now.count(level) for level in (1, 2, 3, 4)],
        }
    return result


def _levels(tasks_by_member: list[list[TaskRecord]]) -> dict[str, list[int]]:
    computed = [compute(tasks) for tasks in tasks_by_member]
    return {
        name: [
            item.dimensions[name].level_raw
            for item in computed
            if item.dimensions[name].level_raw is not None
        ]
        for name in DIMENSIONS
    }


def _patterns(tasks_by_member: list[list[TaskRecord]], k: int) -> list[dict]:
    """Share of members with each 'to improve' pattern, among those with enough tasks."""
    eligible = [tasks for tasks in tasks_by_member if len(tasks) >= 5]
    if len(eligible) < k:
        return []
    counts: dict[tuple[str, str | None], int] = {}
    for tasks in eligible:
        found = {(p.code, p.dimension) for p in compute(tasks).patterns if p.kind == "improve"}
        for key in found:
            counts[key] = counts.get(key, 0) + 1
    return [
        {"code": code, "dimension": dimension, "share": _share(count, len(eligible))}
        for (code, dimension), count in sorted(counts.items(), key=lambda item: -item[1])
    ]


def _feedback(tasks_by_member: list[list[TaskRecord]], k: int) -> dict:
    contributors = [tasks for tasks in tasks_by_member if tasks]
    if len(contributors) < k:
        return {"enough": False}
    tasks = [task for member in contributors for task in member]
    return {
        "enough": True,
        "response_rate": _share(sum(t.outcome is not None for t in tasks), len(tasks)),
    }


def _coach(store: Storage, user_ids: list[str], before: date, k: int) -> dict:
    """TL4, once E0b's ``coach_uses`` exists."""
    with store.connect() as db:
        if not has_column(db, store.schema, "coach_uses", "accepted"):
            return {"available": False}
        rows = db.execute(
            """SELECT s.user_id, c.accepted, o.outcome FROM coach_uses c
               JOIN analyses a ON a.id=c.analysis_id JOIN sessions s ON s.id=a.session_id
               LEFT JOIN task_outcomes o ON o.analysis_id=a.id
               WHERE s.user_id = ANY(%s) AND a.created_at < %s AND c.accepted IS NOT NULL""",
            (user_ids, before.isoformat()),
        ).fetchall()
    if len({row["user_id"] for row in rows}) < k:
        return {"available": True, "enough": False}

    def solved(accepted: bool) -> float | None:
        answered = [r for r in rows if bool(r["accepted"]) is accepted and r["outcome"] in OUTCOMES]
        if len({r["user_id"] for r in answered}) < k:
            return None
        return _share(sum(r["outcome"] != "not_resolved" for r in answered), len(answered))

    return {
        "available": True,
        "enough": True,
        "accepted_rate": _share(sum(bool(r["accepted"]) for r in rows), len(rows)),
        "solved_when_accepted": solved(True),
        "solved_when_not": solved(False),
    }


def group_learning(store: Storage, members: list[dict], today: date, weeks: int, k: int) -> dict:
    """The aggregates as of the end of the last closed week, against ``weeks`` weeks earlier."""
    until = _monday(today)  # the open week is left out
    earlier = until - timedelta(weeks=weeks)

    def tasks_at(end: date) -> list[list[TaskRecord]]:
        start = _epoch(end - timedelta(weeks=1))
        return [_tasks_before(store, m["user_id"], end) for m in members if m["joined_at"] < start]

    now, before = tasks_at(until), tasks_at(earlier)
    eligible = [
        m["user_id"] for m in members if m["joined_at"] < _epoch(until - timedelta(weeks=1))
    ]
    return {
        "min_group_size": k,
        "until": until.isoformat(),
        "enough_members": len(eligible) >= k,
        "dimensions": _dimensions(_levels(now), _levels(before), k),
        "patterns": _patterns(now, k),
        "feedback": _feedback(now, k),
        "coach": _coach(store, eligible, until, k) if len(eligible) >= k else {"available": False},
    }
