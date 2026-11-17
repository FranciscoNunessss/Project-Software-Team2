# Optional expiry of old history

Product audit, risk R4 and the policy "Retention" (not implemented before this change). Prepared with AI
assistance (Claude, Anthropic); human review pending.

## What it does

`ADAPTAI_RETENTION_DAYS` (default **0 = off**, the behaviour so far: nothing is deleted by the clock). With a
number of days, a daily job (and one at start-up) deletes every session in which nothing has happened for that
long: its newest analysis and, if the chat module is installed, its newest chat message are both older than the limit.

| Deleted | Kept |
|---|---|
| The session, its analyses and choices, the feedback on them, the numeric usage metadata of each analysis, saved conversation text (if the person had switched it on), chats and their messages | The account and the sign-in |
| The saved coaching advice of every person who lost a session (it was written from history that no longer exists) | Preferences, consent switches and the personal context text |
| | Model configurations with their encrypted keys |
| | Project-level model evaluations |

A session that is still in use is never touched: opening it again, analysing or sending a message makes it recent.

## What it does not do

* **It does not delete accounts.** An account inactive for a long time would need a warning to the person first
  (working email, see the SMTP item in `docs/decision-pack.md`) and a retention period for accounts, which is the
  Product Owner's decision. The proposal in the decision pack is 12 months for history and 24 months for accounts.
* It does not touch backups, the logs of Render or Supabase, or the Supabase sign-in.
* It counts activity by the time a session was created, its analyses and its chat messages. Renaming a session or
  reading it does not count as activity.

## Turning it on

1. The Product Owner decides the period (the proposal: 365 days) and the Privacy Policy sentence "There is currently
   no automatic expiry" is changed in the same release (marker C5 in `docs/decision-pack.md`).
2. Set `ADAPTAI_RETENTION_DAYS=365` in the backend's environment (Render). The first run at start-up deletes
   everything older at once: take a backup first if there is anything worth keeping.
3. Deleted sessions cannot be restored.

Roll back by setting it to 0; deleted data does not come back.

## Tests

`backend/tests/test_retention.py`: off by default and 0 never deletes; an old session goes with its analyses and a
recent one stays; the account, the preferences and other people are untouched; the saved coaching advice goes with
the history; a session with a recent chat message stays; the cutoff arithmetic; the job is installed only when a
period is set.
