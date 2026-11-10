"""Personal API tokens (ADR-013).

A token lets a client that is not a browser, such as the VS Code extension, call the API as the
user: ``Authorization: Bearer adaptai_pat_...``. It is shown once, stored only as a SHA-256 hash,
has an expiry, can be revoked and is managed only with the browser session (never with another
token, so a leaked token cannot mint more). It works with the local cookie login and with
Supabase Auth, because it points at the same ``users`` row. The table is in migration 008.
"""

import secrets
import time
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import TOKEN_PREFIX, SessionUser, token_hash
from app.storage import Storage

MAX_ACTIVE_TOKENS = 10
DEFAULT_DAYS = 90
MAX_DAYS = 365


class TokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=60)
    expires_in_days: int = Field(default=DEFAULT_DAYS, ge=1, le=MAX_DAYS)


def public(row) -> dict:
    now = int(time.time())
    return {
        "id": row["id"],
        "name": row["name"],
        "prefix": row["prefix"],
        "created_at": row["created_at"],
        "expires_at": row["expires_at"],
        "last_used_at": row["last_used_at"],
        "revoked": row["revoked_at"] is not None,
        "expired": row["expires_at"] <= now,
    }


def install_tokens(app: FastAPI, store: Storage) -> None:
    router = APIRouter(prefix="/api/tokens")

    @router.get("")
    def list_tokens(response: Response, user: SessionUser):
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            rows = db.execute(
                "SELECT * FROM api_tokens WHERE user_id=%s ORDER BY sequence_id DESC",
                (user["id"],),
            ).fetchall()
        return [public(row) for row in rows]

    @router.post("", status_code=201)
    def create_token(body: TokenRequest, response: Response, user: SessionUser):
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "token_name_required")
        now = int(time.time())
        secret = TOKEN_PREFIX + secrets.token_urlsafe(32)
        identifier = str(uuid4())
        # The per-user lock makes the limit hold when two requests arrive together.
        with store.connect(user_id=user["id"]) as db:
            active = db.execute(
                "SELECT count(*) FROM api_tokens "
                "WHERE user_id=%s AND revoked_at IS NULL AND expires_at>%s",
                (user["id"], now),
            ).fetchone()[0]
            if active >= MAX_ACTIVE_TOKENS:
                raise HTTPException(409, "token_limit_reached")
            db.execute(
                "INSERT INTO api_tokens(id,user_id,name,token_hash,prefix,created_at,expires_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    user["id"],
                    name,
                    token_hash(secret),
                    secret[: len(TOKEN_PREFIX) + 4],
                    now,
                    now + body.expires_in_days * 86400,
                ),
            )
            row = db.execute("SELECT * FROM api_tokens WHERE id=%s", (identifier,)).fetchone()
        response.headers["Cache-Control"] = "no-store"
        return {**public(row), "token": secret}  # the only time the secret is ever returned

    @router.delete("/{token_id}")
    def revoke_token(token_id: str, user: SessionUser):
        with store.connect() as db:
            row = db.execute(
                "SELECT revoked_at FROM api_tokens WHERE id=%s AND user_id=%s",
                (token_id, user["id"]),
            ).fetchone()
            if not row:
                raise HTTPException(404, "token_not_found")
            if row["revoked_at"] is None:
                db.execute(
                    "UPDATE api_tokens SET revoked_at=%s WHERE id=%s", (int(time.time()), token_id)
                )
        return {"status": "revoked"}  # a JSON body, like DELETE /api/llm-configs

    app.include_router(router)
