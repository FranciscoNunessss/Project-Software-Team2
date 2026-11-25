# Proposal for E0: usage and learning events from the IDE (for WS4, WS3 and the Architecture Owner)

Status: **proposal, nothing implemented.** Author: WS2 (IDE). Date: 24 Nov 2026.

## What the plan asks

Release plan, WS2 task E0: every IDE action emits the records C1 and C2 with `surface=ide`, checkable in the WS3 and WS4 views.

## What I found in PR #91 to #95 (WS4) and #90 (WS3)

* There is **no C1/C2 contract and no endpoint that receives events.** The WS4 engine (`learning_engine.py`) is computed from data the backend already stores (analyses, `request_quality`, outcomes, decisions).
* `TaskRecord` has `surface: "web" | "ide"` and `coach: CoachUse(gaps, accepted)`, but `learning.dated_tasks()` never fills them. Today every task counts as `web`, and the `coach_pays_off` pattern never has data.
* `CoachResponse.event_id` exists in `prompt_coach.py` and is never set.
* WS3 (`team_data.py`) invents `surface` on mock data only.
* The extension already authenticates with a personal API token (ADR-013, `adaptai_pat_`), and `accounts.token_user()` knows when a request came with one.

So the IDE does not need a new event stream. It needs the two inputs the engine already expects.

## Proposal (smallest change)

1. **Surface.** Add a column `surface TEXT NOT NULL DEFAULT 'web' CHECK (surface IN ('web','ide'))` to `analyses` (migration 014). The backend sets it from how the caller authenticated: a personal API token means `ide`, a browser session means `web`. The client sends nothing, so it cannot be forged by a field and `AnalysisRequest` (`extra="forbid"`) does not change.
2. **Coach use.** Add a table `coach_uses(analysis_id PK, user_id, mode, gaps INTEGER, accepted BOOLEAN NULL, surface, created_at)`: written by `POST /api/prompt-coach` (mode, number of suggestions, `accepted` empty until known). No text, as everywhere in the learning tables.
3. **Accepted.** `PUT /api/prompt-coach/{analysis_id}/accepted` with `{accepted: bool}`. The extension calls it when the user presses Apply or Dismiss on the Coach diff (IMP-01). The web app can call it when the user applies a suggestion.
4. **Engine.** `learning.dated_tasks()` reads `surface` and `coach_uses` into `TaskRecord`. WS3 reads `surface` for the group view instead of mock data.

What the extension does after this (WS2, small): nothing for surface; one call for `accepted`. Tests: Apply sends `accepted=true`, Dismiss sends `false`, an old backend answering 404 is ignored.

## What this does not do

* It does not add a general event log. Events other than "analysed", "coach used" and "coach accepted" are not defined by the plan's cards and are not proposed.
* It does not send any text.

## Decisions needed

| Who | Decision |
|---|---|
| WS4 (Ricardo) | Accept 1 to 4, or give the C1/C2 format you prefer. The G1 plan is yours: this touches `learning.py`, `prompt_coach.py` and one migration. |
| Architecture Owner | Stored data: one column and one table, no text. Surface derived from the auth method, not from a client field. |
| WS3 (Fishcake99) | Use `analyses.surface` for the group view. |

## Open questions

* Should a task analysed from the IDE with a browser session (no token) count as `ide`? The proposal says no: `surface` is how the caller authenticated.
* Is `mode` worth storing (tips, edits, rewrite)? It costs nothing and helps `coach_pays_off`; drop it if WS4 does not need it.
