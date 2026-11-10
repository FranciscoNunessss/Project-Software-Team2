# ADR-013: AdaptAI as a VS Code extension

Status: Proposed (10 November 2026, rewritten from the 5 November draft). A working version exists
on the branch `feature/jose-ide-extension`, so the team can try it before deciding. Waiting for the
Architecture Owner's decision (the token module is a change in the backend core) and the Product
Owner's decision on scope. The first draft assumed the whole SPA inside a webview; the team chose a
native extension instead (see "What changed from the first draft").
Owner: José Moura (author). Deciders: Architecture Owner (Francisco Velhinho) for the architecture,
Product Owner for the scope. Baseline: ADR-005 (privacy), ADR-008 (providers), ADR-009 and ADR-011
(optional modules), ADR-012 (OpenRouter and LM Studio), ADR-014 (recommendation by task needs).
Prepared with AI assistance (Claude, Anthropic); human review pending.

## Context

AdaptAI is a React app and a FastAPI backend (PostgreSQL, Supabase Auth in the cloud setup). The people
who write prompts do it in an IDE. The goal is to bring every function of the app into VS Code, with
the analysis of a prompt as the first use, without a second set of rules: the backend stays the only
authority for analysis, recommendation, chat, evaluations and retention.

What the code on develop (`c249595`) shows:

| Fact | Consequence |
|---|---|
| Analyse always uses the project's assessor; the picker is the chat model only (ADR-014 A11). The result names a concrete model with its levels' source (A9, A10) | The extension sends the same request and shows the same fields; it never re-derives a recommendation |
| Auth is the local cookie, or a Supabase access token (cloud). Writes without an `Origin` pass the CSRF check by accident | A client that is not a browser needs its own credential instead of relying on that gap |
| The chat streams Server-Sent Events (`message`, `delta`, `error`, `done`) and keeps chats on the backend (ADR-011) | VS Code's chat view can show the stream; the chats stay the app's |
| The app has about 55 routes: analysis, outcomes, Coach, chat, progress, profile, LLM config, evaluations, OpenRouter catalogue | Each has a native surface (the map below) |

## Decision

| # | Decision |
|---|---|
| a | **Scope: every function of the app**, as a client of the same backend. No logic of the app is copied into TypeScript. |
| b | **A self-contained AdaptAI page, plus native surfaces where they fit (updated 10 November, after the team tried the first build).** The extension replaces the web app: one editor tab with the app's own layout (Assistant, Chat, My progress, Profile, LLM config), built by hand as a webview that draws only what the backend returns, with its own dialogs for forms and confirmations, so nothing needs the web app or the Palette. It is not the SPA inside a webview: no frontend code, no fetch bridge, and the page may only send a fixed list of messages. The chat is in that page and uses the project's models, not the VS Code chat view (which can need a GitHub sign-in). Native surfaces stay for the editor: commands and CodeLens on a selection, the diff editor for the Coach, and the side-bar trees. Earlier wording: The VS Code surfaces fit each function: commands and CodeLens for analysis and the Coach (with the diff editor and Undo), the chat view with a participant `@adaptai` for the chat, tree views for chats, history, models, evaluations and the profile (with checkboxes for the switches), Markdown documents for the analysis and My progress, quick picks and input boxes for forms, modal dialogs for every consent. A webview is only for what these cannot do; none was needed so far (the progress charts are text and sparklines). |
| c | **Authentication: personal API tokens in the backend (a change in the core).** `Authorization: Bearer adaptai_pat_…`, shown once, stored as a SHA-256 hash, with an expiry (90 days by default, at most 365), revocable, at most 10 active, created and revoked **only with the browser session** (a token cannot manage tokens, so a stolen one cannot mint more). It points at the same `users` row, so it works with the local cookie login **and** with Supabase Auth. A wrong token-shaped credential is a 401 and never falls back to the cookie; any other `Authorization` header keeps its old meaning. The table is migration `008_api_tokens.sql`. The extension signs in with email and password once (local mode) or takes a pasted token (cloud mode), and keeps only the token in `SecretStorage`. |
| d | **Where credentials may go.** One rule for every request: `http://` only for `localhost`, `127.0.0.1` and `::1`, otherwise `https://`; no user name, password, query or fragment in the address; URLs are built only from an `/api/` path on the configured backend; only content headers are forwarded; redirects are never followed; the token is stored with the origin that issued it and is never sent to another. |
| e | **Privacy.** Text leaves the editor only when a command runs. One confirmation names what is sent, the characters, the backend and the model, and says when it leaves the machine; a whole file always asks; "do not ask again" is an explicit button. Secret-looking text is explained first; `.env`, `*.pem`, `*.key`, `id_rsa` and similar files are never read or sent. Switches that send more text (saving task text, automatic suggestions) and every paid evaluation have their own dialog (what is sent, the cost and its ceiling; an unknown price asks twice). No telemetry. |
| f | **Chat.** The participant `@adaptai` streams the answer of the model chosen for the chat (`adaptai.chatModel`, set by "Use this model"); Stop keeps the part written; a stream silent for 120 s is stopped with a message; `/analyse` runs inside the chat's session and a later message with the same text carries the analysis, as the app does. |
| g | **Backend location.** `adaptai.backendUrl`; the extension neither bundles nor starts the backend. A hosted backend is a separate decision (docs/hosting-plan.md). |
| h | **Not decided here:** the Marketplace, inline completions, the VS Code Language Model API as a provider, other IDEs (the token would serve them). |
| i | **Compatibility.** `engines.vscode ^1.90.0`: needs the chat participant API (1.90), Node 20.3 or later (`AbortSignal.any`, `getSetCookie`). Run on 1.145, on Windows. |

### The function map

| In the app | In VS Code |
|---|---|
| Analyse, "Use this model", "Task solved?" | Commands on the selection, file, clipboard or a typed task; the result as a Markdown preview; actions after it (notification or CodeLens) |
| Prompt Coach | Improve the prompt (diff, Apply, Undo), Coach the clipboard, Coach on an analysis |
| Chat | `@adaptai` in the chat view; Chats tree (open, rename, delete) |
| History | Recent analyses |
| My progress | A Markdown report: activity, over and under, solved tasks by model, learning, the Educator's suggestions |
| Profile | Tree with the switches, preferences and the three deletions |
| LLM config and evaluations | Tree: project models (assessor marked), your models (add, edit, key, test, delete), evaluations (consent, re-evaluate, disagree), the OpenRouter catalogue |
| API tokens | Created and revoked in the app only (decision c) |

How it is built and how to continue: [developer guide](../vscode-extension.md). What is missing, item by
item: [backlog](../vscode-extension-backlog.md).

## What changed from the first draft

| First draft (5 Nov) | Now | Why |
|---|---|---|
| The whole SPA in a webview, behind a fetch bridge | Native surfaces, no webview | The app in an editor tab is the web app next to the browser; the value of an IDE client is the editor (selection, diff, Undo) and it avoids a bridge, a CSP, fonts, themes and Supabase inside a webview |
| Tokens: an option | Tokens: part of the design, for both auth modes | The only way a native client signs in without a cookie, and it avoids OAuth inside VS Code |
| A model picker for the analysis | No picker: the assessor analyses; the picker is the chat model | ADR-014 A11 |
| A tier in the result | A concrete model, with the levels' source | ADR-014 |

## Alternatives considered

| Alternative | Why not |
|---|---|
| The SPA in a webview | See above: low value, high cost, and it ties the extension to a frontend that changes weekly |
| Supabase Auth inside the extension (PKCE, refresh) | Heavy, and only for the cloud mode; a token covers both |
| Reuse the cookie and send no `Origin` from Node | It works only through a gap in the CSRF check; any later hardening breaks it |
| A rewrite of the app's rules in TypeScript | Two sources of truth for the recommendation |
| Commands only | Cannot reach "every function" |

## Consequences

| Area | Consequence |
|---|---|
| Core | A migration and a dependency next to `AuthenticatedUser`; it needs the Architecture Owner's approval before it is merged |
| Coupling | The extension reads the API contract of develop. It went stale once when ADR-014 changed it, so it shows the backend's own fields and has tests on the shapes it reads |
| Effort | No frontend change. The extension is a separate folder; removing it leaves the app and the backend unchanged |
| Operations | A backend must be reachable; the local one needs Docker and PostgreSQL |
| Privacy | A token is a new credential on the user's machine (SecretStorage, expiry, revocation); no new text is stored |

## Evidence (10 November 2026)

Windows, VS Code 1.145, Node 24, PostgreSQL 17 from the compose file.

| Check | Result |
|---|---|
| Backend token tests (`test_tokens.py`: hash only, one user, a token cannot manage tokens, revoke, expiry, limit of 10 including 16 parallel requests, cascade with the user, local mode and Supabase mode) | 26 passed |
| Whole backend suite | 614 passed, 4 failed: the SQLite import tests in `test_postgres.py` fail on Windows deleting a temporary file that is still open (`WinError 32`); they are in code this change does not touch and were not run on a clean develop to confirm they fail there too |
| Backend lint and format | clean |
| Extension unit and stub tests (address policy, URL building, secrets, errors, the analysis document, the request, the SSE parser at every split point, security, analysis flows, chat, profile and progress, models and evaluations) | 115 passed |
| Extension against a real backend on PostgreSQL in demonstration mode (sign in with a password keeps only a token, analysis, Coach, outcome once, chat stream and retry and delete, `/analyse` in a chat, profile switches and the report, models CRUD, a revoked token is reported as rejected) | 10 passed |
| Extension Development Host self-test (a real VS Code window, throw-away profile): 41 commands registered and every keybinding has one, sign in with a pasted token, status, analysis through the real API, the analysis opens as a preview | passed |

Not tested, and why it matters: the chat participant inside the real VS Code chat view (it was run through
its handler and the real backend, not by a person typing in the view, and the view may need GitHub sign-in
that was not tried); the modal dialogs, quick picks, the diff editor and Apply in a real window; Supabase
mode with a real project (only with a stubbed Supabase); Groq and LM Studio with the new base (the
earlier live runs were on the previous develop); the paid-evaluation consent against a real provider;
other platforms and VS Code versions; the Educator's text with real data.

## Open questions

1. Will there be a hosted backend, or does everyone run their own (it changes the first-run experience)?
2. Is the extension part of the MVP or an extra? (Explore Scope lists the IDE as out of the first MVP baseline; Process Charter OI-1 asks the client.)
3. `.vsix` only, or the Marketplace later?
4. Is the Architecture Owner willing to accept personal API tokens in the core (decision c)?
