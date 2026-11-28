"""Member view with consent (WS3 T3, ADR-016 rules 4 to 6).

A member opts in one group at a time. While they do, the managers (and organisation admins) of that
group see the member's levels, radar and patterns from the WS4 engine, and nothing else: no task,
no text, no single result. The member reads exactly the same body about themself, before and after
opting in. Levels are ``level_raw``, the window's level without hysteresis, for both of them.
Revoking deletes the row, so the next request already shows nothing.

ADR-016 is still Proposed: until the client confirms (decision D1) the whole view is behind
``ADAPTAI_TEAM_MEMBER_VIEW``, off by default. Revoking works even when it is off.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, FastAPI, HTTPException, Response
from pydantic import BaseModel, ConfigDict

from app.accounts import AuthenticatedUser, SessionUser
from app.learning_engine import compute
from app.learning_experience import counted_tasks
from app.storage import Storage
from app.teams import ADMIN, MANAGER, MEMBER, require_group


class ConsentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    consented: bool


def member_view(store: Storage, user_id: str) -> dict:
    """What a manager may see about one person, and what that person sees about themself."""
    indicators = compute([task for _, task in counted_tasks(store, user_id)])
    return {
        "tasks": indicators.tasks,
        "overall_level": indicators.overall_level_raw,
        "dimensions": {
            name: {"level": item.level_raw, "tasks": item.tasks, "confidence": item.confidence}
            for name, item in indicators.dimensions.items()
        },
        # level_from and level_to are left out: they come from the level with hysteresis.
        "patterns": [
            {
                "code": p.code,
                "kind": p.kind,
                "hits": p.hits,
                "window": p.window,
                "dimension": p.dimension,
                "caveat": p.caveat,
            }
            for p in indicators.patterns
        ],
    }


def _require_member(db, user_id: str, group_id: str) -> None:
    """The caller is *in* the group: an admin who is not has nothing to share."""
    require_group(db, user_id, group_id, {ADMIN, MANAGER, MEMBER})
    if not db.execute(
        "SELECT 1 FROM group_members WHERE group_id=%s AND user_id=%s", (group_id, user_id)
    ).fetchone():
        raise HTTPException(409, "not_a_group_member")


def _consent(db, user_id: str, group_id: str):
    return db.execute(
        "SELECT granted_at FROM group_consents WHERE group_id=%s AND user_id=%s",
        (group_id, user_id),
    ).fetchone()


def install_team_consent(app: FastAPI, store: Storage, enabled: bool) -> None:
    router = APIRouter(prefix="/api/groups/{group_id}")

    def require_enabled() -> None:
        if not enabled:
            raise HTTPException(404, "member_view_off")

    def state(db, user_id: str, group_id: str) -> dict:
        row = _consent(db, user_id, group_id)
        return {
            "enabled": enabled,
            "consented": row is not None,
            "granted_at": row["granted_at"] if row else None,
        }

    @router.get("/consent")
    def read_consent(group_id: str, response: Response, user: AuthenticatedUser):
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            _require_member(db, user["id"], group_id)
            return state(db, user["id"], group_id)

    @router.put("/consent")
    def set_consent(group_id: str, body: ConsentInput, user: SessionUser):
        with store.connect() as db:
            _require_member(db, user["id"], group_id)
            if body.consented:
                require_enabled()
                db.execute(
                    "INSERT INTO group_consents(group_id,user_id,granted_at) VALUES (%s,%s,%s) "
                    "ON CONFLICT DO NOTHING",
                    (group_id, user["id"], int(time.time())),
                )
            else:
                db.execute(
                    "DELETE FROM group_consents WHERE group_id=%s AND user_id=%s",
                    (group_id, user["id"]),
                )
            return state(db, user["id"], group_id)

    @router.get("/consent/view")
    def own_view(group_id: str, response: Response, user: AuthenticatedUser):
        """The member's mirror: the body their managers get (or would get, before consent)."""
        require_enabled()
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            _require_member(db, user["id"], group_id)
        return member_view(store, user["id"])

    @router.get("/member-views")
    def consenting_members(group_id: str, response: Response, user: SessionUser):
        """Who opted in. Members who did not are not listed, counted or hinted at."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN, MANAGER})
            rows = (
                db.execute(
                    """SELECT c.user_id, u.email FROM group_consents c
                       JOIN users u ON u.id=c.user_id WHERE c.group_id=%s ORDER BY u.email""",
                    (group_id,),
                ).fetchall()
                if enabled
                else []
            )
        return {"enabled": enabled, "members": [dict(row) for row in rows]}

    @router.get("/member-views/{member_id}")
    def view_member(group_id: str, member_id: str, response: Response, user: SessionUser):
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN, MANAGER})
            require_enabled()
            # One answer for "not in the group" and "did not consent".
            if _consent(db, member_id, group_id) is None:
                raise HTTPException(404, "member_view_not_found")
        return member_view(store, member_id)

    app.include_router(router)
