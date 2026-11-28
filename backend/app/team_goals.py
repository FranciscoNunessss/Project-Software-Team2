"""Team goal (WS3 TL5): a manager picks one goal for the week, suggested from the group's patterns.

The group's progress is how many of this week's counted tasks met the goal, shown only when at
least ``k`` members have counted tasks this week. Members of the group read the same body.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, FastAPI, Response
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import AuthenticatedUser, SessionUser
from app.learning_experience import GOALS, counted_tasks, goal_met_by, week_of
from app.storage import Storage
from app.team_dashboard import MIN_GROUP_SIZE
from app.team_learning import group_learning
from app.teams import ADMIN, MANAGER, MEMBER, members_of, require_group

PATTERN_GOALS = {
    "over_sizing": "follow_recommendation",
    "under_sizing": "follow_recommendation",
    "model_switching": "one_model_per_chat",
}


class TeamGoal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern="^(" + "|".join(GOALS) + ")$")


def suggestions(patterns: list[dict]) -> list[str]:
    """At most 3 goals, the most widespread group pattern first."""
    picks: list[str] = []
    for pattern in patterns:
        code = (
            f"state_{pattern['dimension']}"
            if pattern["code"] == "missing_dimension"
            else PATTERN_GOALS.get(pattern["code"])
        )
        if code and code not in picks:
            picks.append(code)
    for code in ("follow_recommendation", "one_model_per_chat"):
        if code not in picks:
            picks.append(code)
    return picks[:3]


def install_team_goals(app: FastAPI, store: Storage, clock=None) -> None:
    clock = clock or (lambda: datetime.now(UTC))
    router = APIRouter(prefix="/api")

    def body(group: dict, members: list[dict], now: datetime) -> dict:
        week = week_of(now)
        with store.connect() as db:
            row = db.execute(
                "SELECT code FROM group_goals WHERE group_id=%s AND week=%s", (group["id"], week)
            ).fetchone()
        result = {"group": group["name"], "week": week, "goal": None}
        if row:
            monday = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%dT00:00:00")
            tasks = [
                [task for at, task in counted_tasks(store, m["user_id"]) if at >= monday]
                for m in members
            ]
            active = [member for member in tasks if member]
            enough = len(active) >= MIN_GROUP_SIZE
            every = [task for member in active for task in member]
            result["goal"] = {
                "code": row["code"],
                "enough_members": enough,
                "met": sum(goal_met_by(row["code"], t) for t in every) if enough else None,
                "tasks": len(every) if enough else None,
            }
        return result

    @router.get("/groups/{group_id}/goal")
    def read_goal(group_id: str, response: Response, user: AuthenticatedUser):
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            group = require_group(db, user["id"], group_id, {ADMIN, MANAGER, MEMBER})
            members = [dict(row) for row in members_of(db, group_id)]
        now = clock()
        result = body(group, members, now)
        if group["my_role"] in (ADMIN, MANAGER):
            learning = group_learning(store, members, now.date(), 4, MIN_GROUP_SIZE)
            result["suggestions"] = suggestions(learning["patterns"])
        return result

    @router.put("/groups/{group_id}/goal")
    def set_goal(group_id: str, choice: TeamGoal, user: SessionUser):
        now = clock()
        with store.connect() as db:
            group = require_group(db, user["id"], group_id, {ADMIN, MANAGER})
            members = [dict(row) for row in members_of(db, group_id)]
            db.execute(
                "INSERT INTO group_goals(group_id,week,code) VALUES (%s,%s,%s) "
                "ON CONFLICT (group_id,week) DO UPDATE SET code=EXCLUDED.code",
                (group_id, week_of(now), choice.code),
            )
        return body(group, members, now)

    @router.get("/progress/team-goals")
    def own_team_goals(response: Response, user: AuthenticatedUser):
        """This week's goals of the groups the caller is in, to show next to their own."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            groups = db.execute(
                "SELECT g.id,g.name FROM team_groups g JOIN group_members m ON m.group_id=g.id "
                "WHERE m.user_id=%s ORDER BY g.sequence_id",
                (user["id"],),
            ).fetchall()
            loaded = [(dict(g), [dict(r) for r in members_of(db, g["id"])]) for g in groups]
        now = clock()
        results = [body(group, members, now) for group, members in loaded]
        return {"goals": [item for item in results if item["goal"]]}

    app.include_router(router)
