"""Privacy Policy acceptance and self-service account deletion (GDPR Arts. 7, 17).

Acceptance stores only the policy version and a timestamp on the user's row. Deletion removes the
``users`` row, and every table that holds user data references it with ON DELETE CASCADE, so the
data goes with it. Both routes need the browser session: an API token cannot accept a policy or
delete the account it belongs to. In cloud mode the Supabase sign-in record is removed too when
``ADAPTAI_SUPABASE_SERVICE_ROLE_KEY`` is configured; the answer says whether it was.
"""

import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import COOKIE, SessionUser, password_hash
from app.storage import Storage

# Bump this, and the "Version" line of frontend/src/content/privacy-policy.md, together when a
# change needs the user's renewed acceptance. A test keeps the two in step.
PRIVACY_POLICY_VERSION = "1.0"
POLICY_FILE = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "content" / "privacy-policy.md"
)


def policy_text_version(text: str) -> str | None:
    found = re.search(r"\bVersion (\d+(?:\.\d+)*)\b", text)
    return found.group(1) if found else None


class Acceptance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(min_length=1, max_length=20)


class Deletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_email: str = Field(min_length=3, max_length=254)
    # Local accounts re-enter the password; Supabase accounts are confirmed by the typed email.
    password: str = Field(default="", max_length=128)


def install_privacy(app: FastAPI, store: Storage):
    def state(user_id: str) -> dict:
        with store.connect() as db:
            row = db.execute(
                "SELECT policy_version,policy_accepted_at FROM users WHERE id=%s", (user_id,)
            ).fetchone()
        accepted = row["policy_version"] if row else None
        return {
            "current_version": PRIVACY_POLICY_VERSION,
            "accepted_version": accepted,
            "accepted_at": row["policy_accepted_at"] if row else None,
            "needs_acceptance": accepted != PRIVACY_POLICY_VERSION,
        }

    @app.get("/api/account/privacy")
    def privacy_state(user: SessionUser, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return state(user["id"])

    @app.post("/api/account/policy-acceptance")
    def accept_policy(body: Acceptance, user: SessionUser, response: Response):
        if body.version != PRIVACY_POLICY_VERSION:
            raise HTTPException(409, "policy_version_outdated")
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + "000Z"
        with store.connect(user_id=user["id"]) as db:
            db.execute(
                "UPDATE users SET policy_version=%s, policy_accepted_at=%s WHERE id=%s",
                (PRIVACY_POLICY_VERSION, stamp, user["id"]),
            )
        response.headers["Cache-Control"] = "no-store"
        return state(user["id"])

    @app.delete("/api/account")
    def delete_account(body: Deletion, request: Request, user: SessionUser, response: Response):
        settings = request.app.state.settings
        if body.confirm_email.strip().lower() != user["email"]:
            raise HTTPException(422, "confirmation_does_not_match")
        with store.connect(user_id=user["id"]) as db:
            row = db.execute(
                "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
            ).fetchone()
            if settings.auth_mode == "local":
                salt, expected = (
                    row["password_hash"].split(":")
                    if row and ":" in row["password_hash"]
                    else ("00" * 16, "00" * 64)
                )
                if not secrets.compare_digest(password_hash(body.password, salt), expected):
                    raise HTTPException(401, "invalid_credentials")
            subject = db.execute(
                "SELECT issuer,subject FROM auth_identities WHERE user_id=%s", (user["id"],)
            ).fetchone()
            db.execute("DELETE FROM users WHERE id=%s", (user["id"],))
        identity_removed = settings.auth_mode == "local"
        key = settings.supabase_service_role_key.get_secret_value()
        if settings.auth_mode == "supabase" and subject and key:
            url = f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users/{subject['subject']}"
            try:
                result = httpx.delete(
                    url, headers={"apikey": key, "Authorization": "Bearer " + key}, timeout=10
                )
                identity_removed = result.status_code in {200, 204, 404}
            except httpx.HTTPError:
                identity_removed = False
        if settings.auth_mode == "local":
            response.delete_cookie(
                COOKIE,
                path="/api",
                secure=settings.cookie_secure,
                httponly=True,
                samesite="lax",
            )
        response.headers["Cache-Control"] = "no-store"
        return {"status": "deleted", "sign_in_record_removed": identity_removed}
