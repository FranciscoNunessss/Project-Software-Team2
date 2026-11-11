# VS Code extension: developer guide

10 November 2026. How the extension in `vscode-extension/` is built, how to run and test it, and
the rules to follow when adding to it. The decision is in
[ADR-013](adr/ADR-013-vscode-extension.md) (proposed, waiting for the Architecture Owner). What is
still missing is in the [backlog](vscode-extension-backlog.md). Nothing here is committed or
published yet: the work is on the branch `feature/jose-ide-extension`, from `origin/develop`
(`c249595`).

Prepared with AI assistance (Claude, Anthropic); human review pending.

## Goal

The extension replaces the web app for people who work in VS Code: every function of the app runs
inside the editor, and the web app does not have to be open. The **backend stays the only
authority** for analysis, recommendation, chat, evaluations and retention. The extension has no
model and no rules of its own: it sends the same requests as the app and shows what comes back.

It still needs a running backend (`adaptai.backendUrl`, default `http://127.0.0.1:8000`). The
extension neither bundles nor starts it. The plan is a hosted backend later
([hosting plan](hosting-plan.md)); the extension needs no change for that, only the setting.

## Architecture

| Layer | Files in `vscode-extension/src/` | Responsibility |
| --- | --- | --- |
| Entry point | `extension.ts` | Creates the services, registers the view, the commands, the status bar and the chat participant |
| Page (the UI) | `dashboard.ts` | The AdaptAI side-bar page: layout, dialogs, every screen, and the handler for each message the page can send |
| Services | `analyse.ts`, `chat.ts`, `models.ts`, `profile.ts`, `progress.ts` | One class per area of the app. They call the backend and own the rules of the flow (consent, secrets, retry, cancel) |
| Backend client | `backend.ts` | The only code that talks to the network: credentials, token and cookie bound to an origin, SSE stream, password session for tokens |
| Pure logic | `core.ts`, `format.ts`, `sse.ts`, `api.ts`, `progress.ts` (renderer) | Address policy, request building, error texts, Markdown rendering, SSE parser, API types. No `vscode` import, so they are tested without VS Code |
| Editor surfaces | `analyse.ts`, `statusbar.ts` | Commands on a selection, CodeLens, diff editor for the Coach, the status bar item |
| Leftovers of the first build | `models.ts`, `profile.ts` | `ModelsView` and `ProfileView` are no longer registered or constructed; they stay only because their tests use them. The page uses the helpers in the same files (`PROVIDERS`, `CAPABILITIES`, `describeEvaluation`, `consentText`, `CONSENT`). Remove the two classes when their tests are ported to the page's flows (backlog IDE-12) |

### How a click becomes a backend call

```
page (dashboard.ts, HTML in a template literal)
  └─ postMessage({type, ...})          only types listed in Dashboard.handle() are accepted
       └─ Dashboard.handle()           opens a dialog in the page when a form or consent is needed
            └─ service or backend.api  /api/... through backend.call(), which applies the address policy
                 └─ answer → toast in the page, then Dashboard.reload() redraws the current screen
```

* **One view.** The page is a `WebviewViewProvider` registered as `adaptai.home` in the AdaptAI
  side bar. It keeps its state when hidden (`retainContextWhenHidden`).
* **Screens.** Assistant (the web app's layout: the chat and the composer on one screen, with the model picker, the Prompt Coach bubble, Analyse and Send, and the analysis panel docked beside the chat on wide screens or as a bottom sheet in a narrow bar), My progress (charts in inline SVG, outcomes, learning, patterns, pending choices, sessions, export), Profile, LLM config, Shortcuts. Each has a
  `load()` branch in `dashboard.ts` that fetches plain data and a `...Tab(d)` function in the page
  script that draws it.
* **Dialogs.** `Dashboard.ask(spec)` shows a modal in the page and returns the values (or
  `undefined` when cancelled). Field types: `text`, `password`, `textarea`, `select`, `checkbox`,
  `cards`; also a searchable `list`, `reveal` (show a secret once, with Copy) and `extra`
  buttons. `confirm()` is the yes/no form; `toast()` is the message in the corner. With no page
  (tests) `ask` returns `undefined`, so a flow that needs consent does nothing.
* **Streaming chat.** `ChatService.send` writes to a `Sink`; the page's sink posts `delta`
  messages that grow a bubble. When the stream ends the page reloads the saved messages.
* **Password session.** A token cannot manage tokens (backend rule). `Backend.startManaging`
  confirms the password for 10 minutes, in memory only, and `tokenApi` is limited to `/api/tokens`.

## Same words and layout as the web app

The Assistant is the web app's chat screen (`ChatScreen.tsx`): messages above, the composer below (text box with the Prompt Coach bubble, the model picker, the counter, the recommended model, **Analyse** and **Send**), and `AnalysisDrawer.tsx` as the analysis panel with **Send this message** in its footer. **Analyse** runs inside the chat's own session, so the next message carries the analysis. The model picker sets the chat model like the web picker does (Auto, your models, the project's models, each with its evaluation status); for an OpenRouter model a second button opens the live catalogue.

The analysis cards of the page use the web app's words, in the web app's order (`AnalysisDrawer.tsx`,
`AnalysisResult.tsx`, `TipsCard.tsx`, `AnalysisChanges.tsx`), and the error texts are the web app's
(`errorMessages` in `frontend/src/api.ts`). `richResult()` in `dashboard.ts` turns an analysis into plain
data for the cards; `test/rich.test.js` checks it against a real answer of develop
(`test/fixtures/develop-lmstudio-analysis.json`). To check it again after a change of the web app: run
develop and the branch on the same backend, analyse the same task in both, and compare the text. A
recommendation that names "Illustrative balanced model" is the backend's rule, not a bug of the page:
it appears only while none of the user's models is classified (`recommendation.py`, `recommend`). A model
is classified after its evaluation (a local LM Studio model takes about 8 minutes) or when it has public
levels, so the backend that serves the extension must run with the evaluation worker on.

## Security rules (do not weaken)

These are tested in `test/security.test.js` and `test/dashboard.test.js`.

| # | Rule |
| --- | --- |
| 1 | `http://` only for `localhost`, `127.0.0.1`, `::1`; otherwise `https://`. No user name, password, query or fragment in the address |
| 2 | URLs are built only from an `/api/` path on the configured backend (`buildApiUrl`). Never concatenate a URL from page data |
| 3 | Redirects are never followed. Only content headers are forwarded |
| 4 | The token is stored in `SecretStorage` with the origin that issued it and is sent to no other origin |
| 5 | The page may only send the message types in `Dashboard.handle()`. Every id from the page is looked up in data the extension already holds (`cache`, `results`); an unknown id does nothing. Commands from the page come from a fixed list (`RESULT_ACTIONS`, `RUNNABLE`) |
| 6 | The page draws backend text with `textContent` only, never `innerHTML`. The Content-Security-Policy allows scripts and styles with a nonce and nothing remote |
| 7 | Text leaves the editor only when the user runs an action. A model outside the machine needs the confirmation that names the host, the model and the size. A whole file always asks. Secret-looking text and files such as `.env` are never sent without the warning |
| 8 | Every switch that sends or stores more text, and every paid evaluation, has its own dialog (what is sent, cost, ceiling; an unknown price asks twice) |
| 9 | No telemetry. No password or token is written to a file or a log |

## Run, test, package

Windows notes: use `python -m uv run ...` for Python and `npx --yes pnpm@10.34.3 ...` for pnpm.
Docker Desktop must be open for PostgreSQL.

```bash
# the extension
cd vscode-extension
pnpm install
pnpm test        # type check, then every test; tests that need a backend skip themselves
pnpm package     # makes adaptai-<version>.vsix (does not install or publish)
```

```bash
# a disposable backend for the integration test (from the repository root)
docker compose up -d --wait postgres
ADAPTAI_DATABASE_URL=postgresql://adaptai:adaptai@127.0.0.1:55432/adaptai ADAPTAI_DATABASE_SCHEMA=ide_dev \
ADAPTAI_EVALUATIONS_WORKER=false python -m uv run python -m uvicorn app.main:create_app --factory --app-dir backend --port 8031
ADAPTAI_TEST_BACKEND=http://127.0.0.1:8031 pnpm test      # in vscode-extension
```

```bash
# the backend token tests and the token screen of the app
python -m uv run pytest backend/tests/test_tokens.py
cd e2e && pnpm exec playwright test tokens.spec.ts
```

| Test file | Covers | Needs |
| --- | --- | --- |
| `core*.test.js`, `format.test.js`, `sse.test.js` | Address policy, URL building, secrets, errors, the analysis document, the request, the SSE parser at every split point | nothing |
| `security.test.js` | Remote http refused, header filtering, credentials bound to origin, redirects, stream idle timeout, Stop | local stub servers |
| `flows.test.js` | Analyse, consent, secrets, failure and Retry, cancel and timeouts, Coach, diff, Apply, outcome, Use this model | nothing |
| `chat.test.js`, `profile.test.js`, `models.test.js` | The chat service, profile switches and deletions, models CRUD and evaluations | nothing |
| `dashboard.test.js`, `dashboard-flows.test.js` | The page's handler with a fake view that answers its dialogs: unknown messages and ids ignored, consent needed, token routes only, sessions (open, continue, delete), a model for one message, the Coach in the page, the export | nothing |
| `integration.test.js` | Register, sign in, tokens (create, list, revoke), analysis, Coach, outcome, chat, profile, models, all against a real backend | `ADAPTAI_TEST_BACKEND` |

The self-test in a real VS Code window (`ADAPTAI_SELFTEST=1`, see the extension README) checks that
every command and keybinding is registered, signs in with a token and runs one analysis.

## How to add a feature

1. **Find the route.** Read the FastAPI route and its tests; copy the request and answer shapes into `api.ts`. If the web app does it, read its component in `frontend/src` for the wording and the rules.
2. **Put the rule in a service**, not in the page: a method on the matching class (or a new one), using `backend.api()` or `backend.events()`. Keep the consent, secret check and error text next to it.
3. **Add a `load()` branch** in `dashboard.ts` only if a screen needs new data. Return plain data: strings, numbers, arrays, booleans.
4. **Draw it** in the page script with the helpers `el`, `card`, `row`, `btn`, `intro`. Use the existing CSS classes (`card`, `row`, `btns`, `muted`, `eyebrow`, `grid2`, `grid3`).
5. **Handle the message** with a new `case` in `Dashboard.handle()`. Validate every field the page sent; use `ask()` for any form or consent and `act()` to run the call (it shows a failure, refreshes and redraws).
6. **Test it:** a stub test for the flow, an assertion in `integration.test.js` against the real backend, and, if it can be misused, a case in `dashboard.test.js`.
7. **Update the docs:** the function map in ADR-013, the README table, and move the backlog item to done with the date.

### Rules for the page script (it is inside a TypeScript template literal)

* No backticks in the page script. Write a backtick as `\\x60` (two backslashes) in the source.
* A backslash in the page script is written twice in the source (`\\n`, `\\.`), once it is compiled.
* No `innerHTML`, no `eval`, no inline event attributes, no remote fonts or scripts.
* Check the script after a change: extract it and run `node --check`, then open it with mock data (a local static server and the Browser pane) to look for errors. Never ship a page you have not at least parsed.

## Definition of done for a screen

* Works signed in, signed out, with the backend unreachable, and with a failing request (a clear message, never a silent blank).
* Works in a narrow side bar (about 300 px) and in a wide one, in the light and dark themes.
* Every form is a dialog with required fields marked, a clear cancel, and no data sent before the final button.
* The text is the app's text where the app has one.
* Tests as in "How to add a feature", and the manual check in the [backlog](vscode-extension-backlog.md#manual-acceptance-checklist) done in a real VS Code window.

## Known limits today

* No part of the page has been clicked through by a person in a real window yet (see the manual checklist).
* The 4 `test_postgres.py` SQLite-import tests fail on Windows (`WinError 32`); they are in code this change does not touch and were not run on a clean develop.
* Supabase mode is only tested with a stubbed Supabase.
