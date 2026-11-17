"""Per-user limits on the project's shared hosted models (product audit, risk R2).

The free Groq plan allows 8000 tokens a minute and 200 000 a day for the whole project. One
person could use all of it, so each person gets a share. The limits apply only when a request is
answered by a *server* model of a hosted provider (``server:`` configurations); a person who
brings their own key, or uses a local model or the demonstration model, spends nothing shared and
is never limited here.

* Per minute: a sliding window in memory (one backend instance, like the rate-limit memory in
  ``limits.py``); a restart forgets it, which only gives one extra burst.
* Per day: counted from what is already stored, so it survives restarts and needs no new table.
  Analyses are counted from the analyses made with a server model of a hosted provider in the
  last 24 hours. Chat answers are counted by provider, so a person who uses both a server model and
  their own key of the same provider is counted for both (a small over-count, never an under-count).

A value of 0 switches that limit off. Nothing is stored about a refusal.
"""

import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

HOSTED = ("groq", "openai", "claude", "openrouter")
WINDOW = 60.0
_calls: dict[tuple[str, str], deque] = defaultdict(deque)


def clear() -> None:
    _calls.clear()


def _cutoff() -> str:
    moment = datetime.now(UTC) - timedelta(days=1)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def used_today(store, user_id: str, kind: str) -> int:
    """How many shared-model analyses (``analysis``) or chat answers (``message``) in 24 hours."""
    with store.connect() as db:
        if kind == "analysis":
            row = db.execute(
                """SELECT count(*) FROM analyses a JOIN sessions s ON s.id=a.session_id
                   WHERE s.user_id=%s AND a.created_at>=%s
                     AND (a.result_json::jsonb->>'configuration_id') LIKE 'server:%%'
                     AND (a.result_json::jsonb->>'provider') = ANY(%s)""",
                (user_id, _cutoff(), list(HOSTED)),
            ).fetchone()
        else:
            row = db.execute(
                """SELECT count(*) FROM chat_messages m JOIN sessions s ON s.id=m.session_id
                   WHERE s.user_id=%s AND m.role='assistant' AND m.created_at>=%s
                     AND m.provider = ANY(%s)""",
                (user_id, _cutoff(), list(HOSTED)),
            ).fetchone()
    return int(row[0])


def refuse(code: str, retry_after: int):
    raise HTTPException(429, code, headers={"Retry-After": str(max(1, retry_after))})


def enforce(store, settings, user_id: str, kind: str, now: float | None = None) -> None:
    """Raise 429 when the person has used their share of the shared models. Else count this call."""
    per_minute = (
        settings.user_analyses_per_minute
        if kind == "analysis"
        else settings.user_messages_per_minute
    )
    per_day = (
        settings.user_analyses_per_day if kind == "analysis" else settings.user_messages_per_day
    )
    now = time.time() if now is None else now
    window = _calls[(user_id, kind)]
    while window and window[0] <= now - WINDOW:
        window.popleft()
    if per_minute and len(window) >= per_minute:
        refuse("user_rate_limit", int(window[0] + WINDOW - now) + 1)
    if per_day and used_today(store, user_id, kind) >= per_day:
        refuse(f"{kind}_daily_limit", 3600)
    window.append(now)
