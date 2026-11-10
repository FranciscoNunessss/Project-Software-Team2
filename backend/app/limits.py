"""Models that just hit a rate limit or ran out of credit (ADR-014 A11).

A model that answered "rate limit" or "no credit" is not recommended for a while, and the
analysis says so, so the user is not sent to a model that will fail. Per process and in
memory: a restart forgets it, which only means one more failed call. Nothing is stored about
the user, only the provider and model id.
"""

import time

# How long a model is set aside after each kind of failure, in seconds.
PAUSE = {
    "provider_rate_limit": 3600,  # per-minute or per-day limits: try again in an hour
    "provider_insufficient_credits": 86400,
}
_until: dict[tuple[str, str], tuple[float, str]] = {}


def mark(provider: str | None, model: str | None, code: str | None, now: float | None = None):
    """Remember a limit failure of this model (other failures are ignored)."""
    if not provider or not model or code not in PAUSE:
        return
    now = time.time() if now is None else now
    _until[(provider, model)] = (now + PAUSE[code], code)


def limited(provider: str, model: str | None, now: float | None = None) -> str | None:
    """The failure code while the model is set aside, else None."""
    if not model:
        return None
    found = _until.get((provider, model))
    now = time.time() if now is None else now
    if found is None:
        return None
    if found[0] <= now:
        _until.pop((provider, model), None)
        return None
    return found[1]


def until(provider: str, model: str) -> str:
    """When the model comes back, as HH:MM UTC."""
    found = _until.get((provider, model))
    return time.strftime("%H:%M UTC", time.gmtime(found[0])) if found else ""


def clear() -> None:
    _until.clear()
