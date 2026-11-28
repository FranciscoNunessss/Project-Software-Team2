"""Organisation policy for pause and start over (WS3 T1b, WS4 L17).

A person is under the policy of every organisation in whose groups they are; the strictest wins.
Someone removed from (or leaving) every group of an organisation is no longer under its policy.
"""

from __future__ import annotations


def learning_policy(db, user_id: str) -> tuple[bool, bool]:
    """(may pause, may start over) for this user."""
    row = db.execute(
        """SELECT coalesce(bool_and(o.allow_pause), TRUE) AS pause,
                  coalesce(bool_and(o.allow_reset), TRUE) AS reset
           FROM group_members gm
           JOIN team_groups g ON g.id=gm.group_id
           JOIN organisations o ON o.id=g.organisation_id
           WHERE gm.user_id=%s""",
        (user_id,),
    ).fetchone()
    return row["pause"], row["reset"]


def is_paused(db, user_id: str) -> bool:
    """Whether learning is paused now: the user paused it and no policy forbids pausing."""
    row = db.execute("SELECT paused FROM learning_settings WHERE user_id=%s", (user_id,)).fetchone()
    return bool(row and row["paused"]) and learning_policy(db, user_id)[0]
