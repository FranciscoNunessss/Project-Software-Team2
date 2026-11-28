"""Team Scope (WS3 T1, ADR-016): organisations, groups, roles and membership.

Roles: an organisation has admins; a group has managers and members. Only admins create groups,
invite and remove people. A manager can manage several groups. Every query checks the caller's role
here, in the application (ADR-016 rule 8): the database is reached only by this application, and Row
Level Security with no policy keeps the Supabase Data API roles out.

Writes need the browser session (``SessionUser``), so a leaked IDE token cannot change a team. An
invite is a link whose token is shown once and stored only as a SHA-256 hash; an email, when given,
restricts who can accept it. Tables: migration 010. Nothing here stores task text or usage numbers.
"""

from __future__ import annotations

import secrets
import time
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException, Response
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.accounts import AuthenticatedUser, SessionUser, token_hash
from app.storage import Storage

INVITE_PREFIX = "adaptai_inv_"
DEFAULT_INVITE_DAYS = 7
MAX_INVITE_DAYS = 30
MAX_GROUPS_PER_ORGANISATION = 50
MAX_ORGANISATIONS_PER_USER = 10
ADMIN, MANAGER, MEMBER = "admin", "manager", "member"


def _name(value: str) -> str:
    value = " ".join(value.split())
    if not value:
        raise ValueError("A name is required")
    return value


class NameBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=60)

    _clean = field_validator("name")(classmethod(lambda cls, value: _name(value)))


class InviteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = Field(default=MEMBER, pattern="^(manager|member)$")
    email: str | None = Field(default=None, min_length=3, max_length=254)
    expires_in_days: int = Field(default=DEFAULT_INVITE_DAYS, ge=1, le=MAX_INVITE_DAYS)

    @field_validator("email")
    @classmethod
    def normalise(cls, value: str | None):
        if value is None:
            return None
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Invalid email")
        return value


class PolicyBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    allow_pause: bool
    allow_reset: bool


class AcceptBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=len(INVITE_PREFIX) + 10, max_length=200)


# --- access ------------------------------------------------------------------------------------


def organisation_role(db, user_id: str, organisation_id: str) -> str | None:
    row = db.execute(
        "SELECT role FROM organisation_members WHERE organisation_id=%s AND user_id=%s",
        (organisation_id, user_id),
    ).fetchone()
    return row["role"] if row else None


def group_access(db, user_id: str, group_id: str) -> tuple[dict, str | None] | None:
    """(group row, the caller's role there: admin, manager, member or None); None: no such group.

    An admin of the organisation is ``admin`` in every group of it, whatever their group role.
    """
    group = db.execute("SELECT * FROM team_groups WHERE id=%s", (group_id,)).fetchone()
    if group is None:
        return None
    if organisation_role(db, user_id, group["organisation_id"]) == ADMIN:
        return group, ADMIN
    row = db.execute(
        "SELECT role FROM group_members WHERE group_id=%s AND user_id=%s", (group_id, user_id)
    ).fetchone()
    return group, (row["role"] if row else None)


def require_group(db, user_id: str, group_id: str, allowed: set[str]) -> dict:
    """The group when the caller's role is allowed; 404 otherwise (an outsider learns nothing)."""
    found = group_access(db, user_id, group_id)
    if found is None or found[1] is None:
        raise HTTPException(404, "group_not_found")
    group, role = found
    if role not in allowed:
        raise HTTPException(403, "team_role_required")
    return dict(group) | {"my_role": role}


def require_admin(db, user_id: str, organisation_id: str) -> None:
    role = organisation_role(db, user_id, organisation_id)
    if role is None:
        raise HTTPException(404, "organisation_not_found")
    if role != ADMIN:
        raise HTTPException(403, "team_role_required")


def managed_groups(db, user_id: str) -> list[dict]:
    """Groups whose dashboard the caller may open: admin of the organisation or manager."""
    return db.execute(
        """SELECT g.id, g.name, g.organisation_id FROM team_groups g
           WHERE g.organisation_id IN (SELECT organisation_id FROM organisation_members
                                       WHERE user_id=%s AND role='admin')
              OR g.id IN (SELECT group_id FROM group_members WHERE user_id=%s AND role='manager')
           ORDER BY g.sequence_id""",
        (user_id, user_id),
    ).fetchall()


def members_of(db, group_id: str) -> list[dict]:
    return db.execute(
        "SELECT user_id, role, joined_at FROM group_members WHERE group_id=%s ORDER BY joined_at",
        (group_id,),
    ).fetchall()


# --- routes ------------------------------------------------------------------------------------


def install_teams(app: FastAPI, store: Storage) -> None:
    router = APIRouter(prefix="/api")

    @router.get("/organisations")
    def list_organisations(response: Response, user: AuthenticatedUser):
        """Every organisation the caller belongs to, with the groups they can see in it."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            organisations = db.execute(
                """SELECT o.id, o.name, o.demo, o.allow_pause, o.allow_reset, m.role
                   FROM organisations o
                   JOIN organisation_members m ON m.organisation_id=o.id AND m.user_id=%s
                   ORDER BY o.sequence_id""",
                (user["id"],),
            ).fetchall()
            result = []
            for organisation in organisations:
                admin = organisation["role"] == ADMIN
                groups = db.execute(
                    """SELECT g.id, g.name, gm.role AS my_role,
                              (SELECT count(*) FROM group_members x WHERE x.group_id=g.id) AS size
                       FROM team_groups g
                       LEFT JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=%s
                       WHERE g.organisation_id=%s AND (%s OR gm.user_id IS NOT NULL)
                       ORDER BY g.sequence_id""",
                    (user["id"], organisation["id"], admin),
                ).fetchall()
                result.append(
                    {
                        "id": organisation["id"],
                        "name": organisation["name"],
                        "demo": organisation["demo"],
                        "role": organisation["role"],
                        "allow_pause": organisation["allow_pause"],
                        "allow_reset": organisation["allow_reset"],
                        "groups": [
                            {
                                "id": group["id"],
                                "name": group["name"],
                                "role": ADMIN if admin else group["my_role"],
                                # An admin may also be in the group: they can then share.
                                **({"member": group["my_role"] is not None} if admin else {}),
                                # Size is shown to those who run the group, never to members.
                                "size": group["size"]
                                if admin or group["my_role"] == MANAGER
                                else None,
                            }
                            for group in groups
                        ],
                    }
                )
        return result

    @router.post("/organisations", status_code=201)
    def create_organisation(body: NameBody, user: SessionUser):
        now = int(time.time())
        identifier = str(uuid4())
        with store.connect(user_id=user["id"]) as db:
            count = db.execute(
                "SELECT count(*) FROM organisation_members WHERE user_id=%s AND role='admin'",
                (user["id"],),
            ).fetchone()[0]
            if count >= MAX_ORGANISATIONS_PER_USER:
                raise HTTPException(409, "organisation_limit_reached")
            db.execute(
                "INSERT INTO organisations(id,name,created_at) VALUES (%s,%s,%s)",
                (identifier, body.name, now),
            )
            db.execute(
                "INSERT INTO organisation_members(organisation_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'admin',%s)",
                (identifier, user["id"], now),
            )
        return {"id": identifier, "name": body.name, "role": ADMIN, "demo": False, "groups": []}

    @router.put("/organisations/{organisation_id}/learning-policy")
    def set_learning_policy(organisation_id: str, body: PolicyBody, user: SessionUser):
        """T1b: whether people in this organisation's groups may pause learning or start over."""
        with store.connect() as db:
            require_admin(db, user["id"], organisation_id)
            db.execute(
                "UPDATE organisations SET allow_pause=%s, allow_reset=%s WHERE id=%s",
                (body.allow_pause, body.allow_reset, organisation_id),
            )
        return {"allow_pause": body.allow_pause, "allow_reset": body.allow_reset}

    @router.post("/organisations/{organisation_id}/groups", status_code=201)
    def create_group(organisation_id: str, body: NameBody, user: SessionUser):
        identifier = str(uuid4())
        with store.connect() as db:
            require_admin(db, user["id"], organisation_id)
            count = db.execute(
                "SELECT count(*) FROM team_groups WHERE organisation_id=%s", (organisation_id,)
            ).fetchone()[0]
            if count >= MAX_GROUPS_PER_ORGANISATION:
                raise HTTPException(409, "group_limit_reached")
            try:
                with db.transaction():
                    db.execute(
                        "INSERT INTO team_groups(id,organisation_id,name,created_at) "
                        "VALUES (%s,%s,%s,%s)",
                        (identifier, organisation_id, body.name, int(time.time())),
                    )
            except UniqueViolation as error:
                raise HTTPException(409, "group_name_taken") from error
        return {"id": identifier, "name": body.name, "role": ADMIN, "size": 0}

    @router.delete("/groups/{group_id}")
    def delete_group(group_id: str, user: SessionUser):
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN})
            db.execute("DELETE FROM team_groups WHERE id=%s", (group_id,))
        return {"status": "deleted"}

    @router.get("/groups/{group_id}/members")
    def list_members(group_id: str, response: Response, user: SessionUser):
        """Admins only: who is in the group. Managers see aggregates, never a member list."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN})
            rows = db.execute(
                """SELECT gm.user_id, u.email, gm.role, gm.joined_at FROM group_members gm
                   JOIN users u ON u.id=gm.user_id WHERE gm.group_id=%s ORDER BY gm.joined_at""",
                (group_id,),
            ).fetchall()
            invites = db.execute(
                """SELECT id, email, role, expires_at FROM group_invites
                   WHERE group_id=%s AND used_at IS NULL AND revoked_at IS NULL AND expires_at>%s
                   ORDER BY sequence_id""",
                (group_id, int(time.time())),
            ).fetchall()
        return {"members": [dict(row) for row in rows], "invites": [dict(row) for row in invites]}

    @router.post("/groups/{group_id}/invites", status_code=201)
    def create_invite(group_id: str, body: InviteBody, response: Response, user: SessionUser):
        now = int(time.time())
        secret = INVITE_PREFIX + secrets.token_urlsafe(24)
        identifier = str(uuid4())
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN})
            db.execute(
                "INSERT INTO group_invites(id,group_id,token_hash,email,role,created_by,"
                "created_at,expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    group_id,
                    token_hash(secret),
                    body.email,
                    body.role,
                    user["id"],
                    now,
                    now + body.expires_in_days * 86400,
                ),
            )
        response.headers["Cache-Control"] = "no-store"
        # The only time the token is returned; the admin shares the link (no email is sent).
        return {
            "id": identifier,
            "role": body.role,
            "email": body.email,
            "expires_at": now + body.expires_in_days * 86400,
            "token": secret,
        }

    @router.delete("/groups/{group_id}/invites/{invite_id}")
    def revoke_invite(group_id: str, invite_id: str, user: SessionUser):
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN})
            updated = db.execute(
                "UPDATE group_invites SET revoked_at=%s WHERE id=%s AND group_id=%s "
                "AND used_at IS NULL AND revoked_at IS NULL",
                (int(time.time()), invite_id, group_id),
            ).rowcount
        if not updated:
            raise HTTPException(404, "invite_not_found")
        return {"status": "revoked"}

    @router.post("/invites/accept")
    def accept_invite(body: AcceptBody, user: SessionUser):
        now = int(time.time())
        with store.connect(user_id=user["id"]) as db:
            invite = db.execute(
                "SELECT * FROM group_invites WHERE token_hash=%s FOR UPDATE",
                (token_hash(body.token.strip()),),
            ).fetchone()
            # One answer for unknown, used, revoked and expired: the link cannot be probed.
            if (
                invite is None
                or invite["used_at"] is not None
                or invite["revoked_at"] is not None
                or invite["expires_at"] <= now
            ):
                raise HTTPException(404, "invite_not_valid")
            if invite["email"] and invite["email"] != user["email"].strip().lower():
                raise HTTPException(403, "invite_for_another_email")
            group = db.execute(
                "SELECT id, name, organisation_id FROM team_groups WHERE id=%s",
                (invite["group_id"],),
            ).fetchone()
            db.execute(
                "INSERT INTO organisation_members(organisation_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'member',%s) ON CONFLICT DO NOTHING",
                (group["organisation_id"], user["id"], now),
            )
            existing = db.execute(
                "SELECT role FROM group_members WHERE group_id=%s AND user_id=%s",
                (group["id"], user["id"]),
            ).fetchone()
            if existing is None:
                db.execute(
                    "INSERT INTO group_members(group_id,user_id,role,joined_at) "
                    "VALUES (%s,%s,%s,%s)",
                    (group["id"], user["id"], invite["role"], now),
                )
            elif existing["role"] == MEMBER and invite["role"] == MANAGER:
                db.execute(
                    "UPDATE group_members SET role='manager' WHERE group_id=%s AND user_id=%s",
                    (group["id"], user["id"]),
                )
            db.execute(
                "UPDATE group_invites SET used_at=%s, used_by=%s WHERE id=%s",
                (now, user["id"], invite["id"]),
            )
        return {"group_id": group["id"], "group": group["name"], "role": invite["role"]}

    @router.delete("/groups/{group_id}/members/{member_id}")
    def remove_member(group_id: str, member_id: str, user: SessionUser):
        """An admin removes anyone; a member or manager can remove themself (leave)."""
        with store.connect() as db:
            found = group_access(db, user["id"], group_id)
            if found is None or found[1] is None:
                raise HTTPException(404, "group_not_found")
            if found[1] != ADMIN and member_id != user["id"]:
                raise HTTPException(403, "team_role_required")
            removed = db.execute(
                "DELETE FROM group_members WHERE group_id=%s AND user_id=%s",
                (group_id, member_id),
            ).rowcount
        if not removed:
            raise HTTPException(404, "member_not_found")
        return {"status": "removed"}

    app.include_router(router)
