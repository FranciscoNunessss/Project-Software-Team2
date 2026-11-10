import hashlib
import secrets
import time
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from psycopg.errors import UniqueViolation
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


TOKEN_PREFIX = "adaptai_pat_"
TOKEN_TOUCH_SECONDS = 60


def session_user(request: Request):
    """The browser session: the local cookie, or a Supabase access token in cloud mode."""
    if request.app.state.settings.auth_mode == "supabase":
        from app.supabase_auth import resolve_user

        return resolve_user(request)
    token = request.cookies.get(COOKIE, "")
    with request.app.state.storage.connect() as db:
        row = db.execute(
            """SELECT u.id,u.email FROM users u JOIN auth_sessions a ON a.user_id=u.id
               WHERE a.token_hash=%s AND a.expires_at>%s""",
            (token_hash(token), int(time.time())),
        ).fetchone()
    if not row:
        raise HTTPException(401, "authentication_required")
    return dict(row)


def token_user(request: Request, token: str):
    """A personal API token (ADR-013): revocable, with an expiry, stored only as a hash."""
    now = int(time.time())
    with request.app.state.storage.connect() as db:
        row = db.execute(
            """SELECT u.id,u.email,t.id AS token_id,t.last_used_at FROM api_tokens t
               JOIN users u ON u.id=t.user_id
               WHERE t.token_hash=%s AND t.revoked_at IS NULL AND t.expires_at>%s""",
            (token_hash(token), now),
        ).fetchone()
        if not row:
            raise HTTPException(401, "authentication_required")
        if row["last_used_at"] is None or now - row["last_used_at"] >= TOKEN_TOUCH_SECONDS:
            db.execute("UPDATE api_tokens SET last_used_at=%s WHERE id=%s", (now, row["token_id"]))
    return {"id": row["id"], "email": row["email"]}


def current_user(request: Request):
    """Who is calling: a personal API token when the request carries one, else the session.

    A token-shaped credential that is wrong is a 401 on its own: it never falls back to a cookie.
    Any other Authorization header (the Supabase access token in cloud mode) keeps its old meaning.
    """
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer" and value.strip().startswith(TOKEN_PREFIX):
        request.state.auth = "token"
        return token_user(request, value.strip())
    request.state.auth = "session"
    return session_user(request)


AuthenticatedUser = Annotated[dict, Depends(current_user)]
# Token management needs the browser session: a token cannot create or revoke tokens.
SessionUser = Annotated[dict, Depends(session_user)]


def check_origin(request: Request):
    """Cookie writes accept only same-origin browser requests (CSRF protection)."""
    origin = request.headers.get("origin")
    allowed = request.app.state.settings.browser_origin.rstrip("/")
    if request.app.state.settings.auth_mode == "supabase":
        # Bearer authentication does not use ambient browser cookies. Cross-site
        # fetches are expected for Netlify -> Render; only the configured origin is allowed.
        if origin is not None and origin != allowed:
            raise HTTPException(403, "invalid_origin")
        return
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
        db.execute("DELETE FROM auth_sessions WHERE expires_at<=%s", (int(time.time()),))
        db.execute(
            "INSERT INTO auth_sessions VALUES (%s,%s,%s)",
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
    require_local_auth(request)
    user = {"id": str(uuid4()), "email": body.email}
    salt = secrets.token_hex(16)
    hashed = salt + ":" + password_hash(body.password, salt)
    try:
        with request.app.state.storage.connect() as db:
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,%s)",
                (user["id"], user["email"], hashed),
            )
    except UniqueViolation:
        raise HTTPException(409, "email_already_registered") from None
    return issue_session(request, response, user)


@router.post("/login")
def login(body: Credentials, request: Request, response: Response):
    require_local_auth(request)
    with request.app.state.storage.connect() as db:
        row = db.execute("SELECT * FROM users WHERE email=%s", (body.email,)).fetchone()
    # Perform the same expensive derivation even for unknown accounts.
    salt, expected = (
        row["password_hash"].split(":")
        if row and ":" in row["password_hash"]
        else ("00" * 16, "00" * 64)
    )
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
    require_local_auth(request)
    with request.app.state.storage.connect() as db:
        db.execute(
            "DELETE FROM auth_sessions WHERE token_hash=%s",
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


def require_local_auth(request: Request):
    if request.app.state.settings.auth_mode != "local":
        raise HTTPException(404, "use_supabase_auth")


@router.post("/link-legacy")
def link_legacy(body: Credentials, request: Request):
    if request.app.state.settings.auth_mode != "supabase":
        raise HTTPException(404, "not_found")
    from app.supabase_auth import identity

    principal = identity(request)
    if body.email != principal["email"]:
        raise HTTPException(403, "account_link_email_mismatch")
    store = request.app.state.storage
    with store.connect() as db:
        store.lock_user(db, "identity:" + principal["issuer"] + ":" + principal["subject"])
        store.lock_user(db, "email:" + principal["email"])
        row = db.execute("SELECT * FROM users WHERE email=%s FOR UPDATE", (body.email,)).fetchone()
        salt, expected = (
            row["password_hash"].split(":")
            if row and ":" in row["password_hash"]
            else ("00" * 16, "00" * 64)
        )
        valid = secrets.compare_digest(password_hash(body.password, salt), expected)
        if not row or not valid:
            raise HTTPException(401, "invalid_credentials")
        exists = db.execute(
            "SELECT user_id FROM auth_identities WHERE user_id=%s OR (issuer=%s AND subject=%s)",
            (row["id"], principal["issuer"], principal["subject"]),
        ).fetchone()
        if exists:
            raise HTTPException(409, "account_already_linked")
        db.execute(
            "INSERT INTO auth_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
            (principal["issuer"], principal["subject"], row["id"]),
        )
        db.execute("UPDATE users SET password_hash='' WHERE id=%s", (row["id"],))
        db.execute("DELETE FROM auth_sessions WHERE user_id=%s", (row["id"],))
        return {"id": row["id"], "email": row["email"]}
