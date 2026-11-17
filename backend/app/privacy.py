"""Privacy Policy acceptance record (GDPR Art. 7(1)).

Acceptance stores only the policy version and a timestamp on the user's row; it is erased with the
account. Both routes need the browser session: an API token cannot accept a policy. Account
deletion itself lives in ``accounts.py`` (``DELETE /api/auth/account``).
"""

import re
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import SessionUser
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
