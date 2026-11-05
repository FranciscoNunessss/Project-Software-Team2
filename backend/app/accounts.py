import hashlib
import secrets
import sqlite3
import time
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

COOKIE = "adaptai_session"


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str):
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Invalid email")
        local, domain = value.split("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Invalid email")
        return value


def password_hash(password: str, salt: str) -> str:
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(request: Request):
    token = request.cookies.get(COOKIE, "")
    with request.app.state.storage.connect() as db:
        row = db.execute(
            """SELECT u.id,u.email FROM users u JOIN auth_sessions a ON a.user_id=u.id
               WHERE a.token_hash=? AND a.expires_at>?""",
            (token_hash(token), int(time.time())),
        ).fetchone()
    if not row:
        raise HTTPException(401, "authentication_required")
    return dict(row)


AuthenticatedUser = Annotated[dict, Depends(current_user)]


def check_origin(request: Request):
    """Cookie writes accept only same-origin browser requests (CSRF protection)."""
    origin = request.headers.get("origin")
    allowed = request.app.state.settings.browser_origin.rstrip("/")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and (
        (origin is not None and origin != allowed)
        or request.headers.get("sec-fetch-site") == "cross-site"
    ):
        raise HTTPException(403, "invalid_origin")


router = APIRouter(prefix="/api/auth")


def issue_session(request: Request, response: Response, user: dict):
    settings = request.app.state.settings
    token = secrets.token_urlsafe(32)
    duration = settings.session_days * 86400
    with request.app.state.storage.connect() as db:
        db.execute("DELETE FROM auth_sessions WHERE expires_at<=?", (int(time.time()),))
        db.execute(
            "INSERT INTO auth_sessions VALUES (?,?,?)",
            (token_hash(token), user["id"], int(time.time()) + duration),
        )
    response.set_cookie(
        COOKIE,
        token,
        max_age=duration,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/api",
    )
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/register", status_code=201)
def register(body: Credentials, request: Request, response: Response):
    user = {"id": str(uuid4()), "email": body.email}
    salt = secrets.token_hex(16)
    hashed = salt + ":" + password_hash(body.password, salt)
    try:
        with request.app.state.storage.connect() as db:
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (?,?,?)",
                (user["id"], user["email"], hashed),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "email_already_registered") from None
    return issue_session(request, response, user)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    with request.app.state.storage.connect() as db:
        row = db.execute("SELECT * FROM users WHERE email=?", (body.email,)).fetchone()
    # Perform the same expensive derivation even for unknown accounts.
    salt, expected = row["password_hash"].split(":") if row else ("00" * 16, "00" * 64)
    valid = secrets.compare_digest(password_hash(body.password, salt), expected)
    if not row or not valid:
        raise HTTPException(401, "invalid_credentials")
    return issue_session(request, response, {"id": row["id"], "email": row["email"]})


@router.get("/me")
def me(response: Response, user: AuthenticatedUser):
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/logout")
def logout(request: Request, response: Response):
    with request.app.state.storage.connect() as db:
        db.execute(
            "DELETE FROM auth_sessions WHERE token_hash=?",
            (token_hash(request.cookies.get(COOKIE, "")),),
        )
    response.delete_cookie(
        COOKIE,
        path="/api",
        secure=request.app.state.settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"status": "logged_out"}
