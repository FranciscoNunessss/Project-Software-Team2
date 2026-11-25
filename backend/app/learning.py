"""WS4 learning data (L0): the user's tasks as engine input, and the indicator API.

Reads what the product already stores per analysed task, never text: the choice against the
recommendation (``decisions``), the feedback (``task_outcomes``, ADR-014), the request-quality
scores (``request_quality``, L1) and the user's exclusions (``learning_exclusions``, L17). The
engine (``learning_engine``) turns them into patterns, levels and confidence.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, HTTPException, Query

from app.accounts import AuthenticatedUser
from app.learning_engine import DIMENSIONS, MIN_LEVEL_TASKS, TaskRecord, compute
from app.outcomes import owned_analysis
from app.recommendation import candidate_gap
from app.storage import Storage

OUTCOMES = {"resolved": "yes", "resolved_with_refinement": "partly", "not_resolved": "no"}
HISTORY_LIMIT = 500


def sizing(result: dict, candidate_id: str | None):
    """over, match or under from the recorded choice; None without a valid choice."""
    if candidate_id is None:
        return None
    eligible = [result["recommendation"], *result["alternatives"]]
    if not any(item["id"] == candidate_id for item in eligible):
        return None
    gap = candidate_gap(result, candidate_id)
    return "over" if gap > 0 else "under" if gap < 0 else "match"


def excluded_ids(store: Storage, user_id: str, analysis_ids: list[str]) -> set[str]:
    """The analyses the user left out of their learning (L17), among the ones given."""
    if not analysis_ids:
        return set()
    with store.connect() as db:
        rows = db.execute(
            "SELECT analysis_id FROM learning_exclusions "
            "WHERE user_id=%s AND kind='excluded' AND analysis_id = ANY(%s)",
            (user_id, analysis_ids),
        ).fetchall()
    return {row["analysis_id"] for row in rows}


def user_tasks(store: Storage, user_id: str) -> list[TaskRecord]:
    return [task for _, task in dated_tasks(store, user_id)]


def dated_tasks(store: Storage, user_id: str) -> list[tuple[str, TaskRecord]]:
    """The user's analysed tasks, oldest first, reduced to the engine's input."""
    columns = ",".join(f"q.{name}" for name in DIMENSIONS)
    with store.connect() as db:
        rows = db.execute(
            f"""SELECT * FROM (
                   SELECT a.id,a.result_json,a.created_at,a.sequence_id,d.candidate_id,
                          o.outcome,o.turns,o.switched_model,q.analysis_id AS assessed,{columns},
                          x.kind AS exclusion
                   FROM analyses a JOIN sessions s ON s.id=a.session_id
                   LEFT JOIN decisions d ON d.analysis_id=a.id
                   LEFT JOIN task_outcomes o ON o.analysis_id=a.id
                   LEFT JOIN request_quality q ON q.analysis_id=a.id
                   LEFT JOIN learning_exclusions x ON x.analysis_id=a.id
                   WHERE s.user_id=%s
                   ORDER BY a.created_at DESC,a.sequence_id DESC LIMIT %s) recent
                ORDER BY created_at,sequence_id""",
            (user_id, HISTORY_LIMIT),
        ).fetchall()
    tasks = []
    for row in rows:
        result = json.loads(row["result_json"])
        tasks.append(
            (
                row["created_at"],
                TaskRecord(
                    task_id=row["id"],
                    scores={name: row[name] for name in DIMENSIONS} if row["assessed"] else None,
                    sizing=sizing(result, row["candidate_id"]),
                    outcome=OUTCOMES.get(row["outcome"]),
                    turns=row["turns"],
                    switched_model=None
                    if row["switched_model"] is None
                    else bool(row["switched_model"]),
                    excluded=row["exclusion"] == "excluded",
                    paused=row["exclusion"] == "paused",
                ),
            )
        )
    return tasks


def reset_at(store: Storage, user_id: str) -> str | None:
    """When the user last started over (L17); tasks before it no longer count."""
    with store.connect() as db:
        row = db.execute(
            "SELECT reset_at FROM learning_settings WHERE user_id=%s", (user_id,)
        ).fetchone()
    return row["reset_at"] if row else None


def user_indicators(
    store: Storage, user_id: str, last: int | None = None, days: int | None = None
) -> dict:
    """Indicators for a range of the user's tasks, with the range before it for the trend.

    last: the newest N tasks against the N before them. days: the last N days against the N
    days before. Neither: all tasks, no trend. The user is only ever compared with themselves.
    """
    # Excluded and paused tasks never count, so "the last 10 tasks" means 10 counted tasks;
    # neither do tasks from before the user started over (L17).
    since = reset_at(store, user_id)
    dated = [
        (at, task)
        for at, task in dated_tasks(store, user_id)
        if not task.excluded and not task.paused and (since is None or at > since)
    ]
    if last is not None:
        current = [task for _, task in dated[-last:]]
        previous = [task for _, task in dated[-2 * last : -last]] if len(dated) > last else []
    elif days is not None:
        now = datetime.now(UTC)
        start = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
        before = (now - timedelta(days=2 * days)).strftime("%Y-%m-%dT%H:%M:%S")
        current = [task for at, task in dated if at >= start]
        previous = [task for at, task in dated if before <= at < start]
    else:
        current, previous = [task for _, task in dated], []
    result = compute(current).as_dict()
    # A trend needs an earlier range with enough tasks for a level: 2 earlier tasks against
    # 10 would show a trend that means nothing.
    earlier = compute(previous).as_dict() if len(previous) >= MIN_LEVEL_TASKS else None
    result["range"] = {"last": last, "days": days}
    # Feedback in the same range, so "tasks solved" follows the range the user picked.
    answered = [task for task in current if task.outcome is not None]
    result["feedback"] = {
        "answered": len(answered),
        "solved": sum(task.outcome in ("yes", "partly") for task in answered),
    }
    result["assessed_tasks"] = sum(task.scores is not None for task in current)
    result["previous"] = (
        {
            "tasks": earlier["tasks"],
            "overall_level": earlier["overall_level"],
            "dimensions": {name: item["level"] for name, item in earlier["dimensions"].items()},
        }
        if earlier
        else None
    )
    return result


def install_learning(app: FastAPI, store: Storage) -> None:
    @app.get("/api/progress/indicators")
    def indicators(
        user: AuthenticatedUser,
        # The trend reads 2 * last tasks, and only HISTORY_LIMIT tasks are read.
        last: int | None = Query(default=None, ge=5, le=HISTORY_LIMIT // 2),
        days: int | None = Query(default=None, ge=1, le=365),
    ):
        if last is not None and days is not None:
            raise HTTPException(422, "choose_last_or_days")
        return user_indicators(store, user["id"], last, days)

    @app.put("/api/analyses/{analysis_id}/exclusion")
    def exclude(analysis_id: str, user: AuthenticatedUser):
        with store.connect() as db:
            owned_analysis(db, user["id"], analysis_id)
            row = db.execute(
                """INSERT INTO learning_exclusions(analysis_id,user_id,kind)
                   VALUES (%s,%s,'excluded')
                   ON CONFLICT (analysis_id) DO UPDATE SET kind=learning_exclusions.kind
                   RETURNING kind""",
                (analysis_id, user["id"]),
            ).fetchone()
        if row["kind"] != "excluded":
            # Never say "excluded" when nothing changed: a paused task stays paused.
            raise HTTPException(409, "task_paused")
        return {"analysis_id": analysis_id, "excluded": True}

    @app.delete("/api/analyses/{analysis_id}/exclusion")
    def restore(analysis_id: str, user: AuthenticatedUser):
        with store.connect() as db:
            owned_analysis(db, user["id"], analysis_id)
            deleted = db.execute(
                "DELETE FROM learning_exclusions WHERE analysis_id=%s AND user_id=%s "
                "AND kind='excluded'",
                (analysis_id, user["id"]),
            ).rowcount
        if not deleted:
            raise HTTPException(404, "exclusion_not_found")
        return {"analysis_id": analysis_id, "excluded": False}
