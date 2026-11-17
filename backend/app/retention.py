"""Optional expiry of old history (Privacy Policy: retention, product audit risk R4).

Off by default (``ADAPTAI_RETENTION_DAYS=0``): nothing is ever deleted by the clock, as before.
With a number of days, a session is deleted when nothing has happened in it for that long: its
newest analysis and, if the chat module is installed, its newest chat message are both older
than the limit.

Deleted with the session, by the existing ON DELETE CASCADE: its analyses and choices, the
feedback on them, the numeric usage metadata of each analysis, any saved conversation text, and
the chat messages. Also deleted: the saved coaching advice of every person who lost a session,
because it was written from history that no longer exists (it is written again on request).

Kept: the account, the preferences and consent switches, the model configurations with their
keys, and the project-level model evaluations. An inactive account is not deleted here: that
would need a warning to the person first (working email), and the retention period for accounts
is the Product Owner's decision.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

LOGGER = logging.getLogger(__name__)
INTERVAL_SECONDS = 24 * 3600


def cutoff(days: int, now: datetime | None = None) -> str:
    moment = (now or datetime.now(UTC)) - timedelta(days=days)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def purge(store, days: int, now: datetime | None = None) -> int:
    """Delete sessions with no activity for ``days`` days. Returns how many were deleted."""
    if days <= 0:
        return 0
    limit = cutoff(days, now)
    with store.connect() as db:
        has_chat = db.execute("SELECT to_regclass('chat_messages') IS NOT NULL").fetchone()[0]
        chat = (
            ", COALESCE((SELECT max(m.created_at) FROM chat_messages m "
            "WHERE m.session_id=s.id), '')"
            if has_chat
            else ""
        )
        rows = db.execute(
            f"""DELETE FROM sessions s WHERE GREATEST(
                    s.created_at,
                    COALESCE((SELECT max(a.created_at) FROM analyses a WHERE a.session_id=s.id), '')
                    {chat}
                ) < %s RETURNING s.user_id""",
            (limit,),
        ).fetchall()
        affected = sorted({row[0] for row in rows})
        if affected:
            db.execute("DELETE FROM coaching_reports WHERE user_id = ANY(%s)", (affected,))
    return len(rows)


def install_retention(app, store, days: int) -> None:
    """Purge at start-up and then once a day, when a retention period is set."""
    if days <= 0:
        return

    @app.on_event("startup")
    async def start_retention():
        async def loop():
            while True:
                try:
                    deleted = await asyncio.to_thread(purge, store, days)
                    if deleted:
                        LOGGER.info("Retention: %s expired sessions deleted", deleted)
                except Exception:  # noqa: BLE001 - expiry must never take the app down
                    LOGGER.exception("Retention step failed; retrying tomorrow")
                await asyncio.sleep(INTERVAL_SECONDS)

        app.state.retention_task = asyncio.create_task(loop())
