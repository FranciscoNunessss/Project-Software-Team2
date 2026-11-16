"""Validate bearer tokens against Supabase Auth; no service-role key is needed for that.

The optional service-role key is used only by ``delete_identity``, when a user deletes the
account.
"""

from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, Request


def identity(request: Request) -> dict:
    settings = request.app.state.settings
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip() or len(token) > 16384:
        raise HTTPException(401, "authentication_required")
    url = settings.supabase_url.rstrip("/") + "/auth/v1/user"
    headers = {
        "apikey": settings.supabase_publishable_key.get_secret_value(),
        "Authorization": "Bearer " + token.strip(),
    }
    try:
        # Auth verifies the signature, expiry and project, and returns the current user.
        # Never trust a decoded, unverified JWT or browser-supplied user/email.
        client = request.app.state.supabase_http
        if client is None:
            response = httpx.get(url, headers=headers, timeout=10, follow_redirects=False)
        else:
            # A prebuilt request keeps the shared client's cookies out of user requests.
            response = client.send(
                httpx.Request("GET", url, headers=headers), follow_redirects=False
            )
    except httpx.HTTPError:
        raise HTTPException(503, "authentication_unavailable") from None
    if response.status_code in {401, 403}:
        raise HTTPException(401, "authentication_required")
    if response.status_code != 200:
        raise HTTPException(503, "authentication_unavailable")
    try:
        user = response.json()
        subject = str(UUID(user["id"]))
        email = user["email"].strip().lower()
        if not email or not user.get("email_confirmed_at") or user.get("is_anonymous"):
            raise ValueError
    except (ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(401, "verified_email_required") from None
    return {
        "issuer": settings.supabase_url.rstrip("/") + "/auth/v1",
        "subject": subject,
        "email": email,
    }


def delete_identity(request: Request, subject: str) -> bool:
    """Remove a user's sign-in from Supabase Auth. False when no service-role key is set.

    Raises 503 when Supabase cannot be reached or refuses, so the caller can keep the
    account as it was. A sign-in that is already gone counts as removed.
    """
    settings = request.app.state.settings
    key = settings.supabase_service_role_key.get_secret_value()
    if not key:
        return False
    url = settings.supabase_url.rstrip("/") + "/auth/v1/admin/users/" + str(UUID(subject))
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    try:
        response = httpx.delete(url, headers=headers, timeout=10, follow_redirects=False)
    except httpx.HTTPError:
        raise HTTPException(503, "authentication_unavailable") from None
    if response.status_code not in {200, 204, 404}:
        raise HTTPException(503, "authentication_unavailable")
    return True


def resolve_user(request: Request) -> dict:
    principal = identity(request)
    store = request.app.state.storage
    lookup = (
        "SELECT u.id,u.email FROM users u JOIN auth_identities i ON i.user_id=u.id "
        "WHERE i.issuer=%s AND i.subject=%s"
    )
    identity_key = (principal["issuer"], principal["subject"])
    with store.connect() as db:
        row = db.execute(lookup, identity_key).fetchone()
        if row:
            return dict(row)
        # Serialise first login and linking, including concurrent tabs/requests.
        store.lock_user(db, "identity:" + principal["issuer"] + ":" + principal["subject"])
        row = db.execute(lookup, identity_key).fetchone()
        if row:
            return dict(row)
        store.lock_user(db, "email:" + principal["email"])
        if db.execute("SELECT id FROM users WHERE email=%s", (principal["email"],)).fetchone():
            raise HTTPException(409, "account_link_required")
        user = {"id": str(uuid4()), "email": principal["email"]}
        db.execute(
            "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,'')",
            (user["id"], user["email"]),
        )
        db.execute(
            "INSERT INTO auth_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
            (principal["issuer"], principal["subject"], user["id"]),
        )
        return user
