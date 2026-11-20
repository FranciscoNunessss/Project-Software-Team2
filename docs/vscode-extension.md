# VS Code extension: developer guide

10 November 2026. How the extension in `vscode-extension/` is built, how to run and test it, and
the rules to follow when adding to it. The decision is in
[ADR-013](adr/ADR-013-vscode-extension.md) (proposed, waiting for the Architecture Owner). What is
still missing is in the [backlog](vscode-extension-backlog.md). Nothing here is committed or
published yet: the work is committed on the local branch `feature/ide`, from `origin/develop`
(`c249595`), and has not been pushed.

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
| Helpers of the page | `models.ts`, `profile.ts` | Plain helpers the page uses (`PROVIDERS`, `CAPABILITIES`, `describeEvaluation`, `consentText`, `CONSENT`) and the progress report. The side-bar tree classes were deleted (IDE-12); the flows they had are tested through the page in `test/dashboard-models.test.js` |

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

## Using the Supabase database

Decided on 13 November 2026, when the team's Supabase project became the database to use. Local
Docker PostgreSQL still works and is the fallback when there is no network.

| Use | Database | Schema | Auth mode | Backend address in the extension |
|---|---|---|---|---|
| Development and the automated tests | Supabase PostgreSQL, Session pooler | `ide_dev` | `local` | `http://127.0.0.1:8000` |
| Acceptance of the cloud login | Supabase PostgreSQL, Session pooler | `ide_dev` | `supabase` | `http://127.0.0.1:8000` |
| The deployed app | Supabase PostgreSQL (Render) | `adaptai` | `supabase` | `https://adaptai-team2-api.onrender.com` |

**Why a schema of its own.** The backend applies the migrations to the schema it is pointed at when
it starts. Pointing a development backend at `adaptai` would create `api_tokens` (migration 008) in
the deployed app's data before the token module is reviewed, and the tests would leave accounts,
tokens, chats and model evaluations there. A schema of its own in the same project uses the real
Supabase PostgreSQL (the same server, pooler, TLS and limits as production) and keeps the deployed
data untouched; it can be dropped at any time. The Free plan's 500 MB and connection limit are
shared, so the evaluation worker (40 requests per model) is the main thing to keep an eye on.

**Why `local` auth for the tests.** The tests register a fresh account each run. In `supabase` mode
that would create real Supabase Auth users and send confirmation emails (email confirmation is on
in the project). `local` mode keeps the accounts in `ide_dev` only. The `supabase` mode is checked
separately by a person with their own account: sign in to the web app, create a token in Profile and
paste it in the extension. No account password goes into a file or a script, because the same Auth
serves the public site.

**How the extension signs in.** In `local` mode the extension registers and signs in with the
password, as before. In `supabase` mode the password is checked by Supabase, so the extension asks
for a token (IDE-06): sign in to the web app (local in Supabase mode, or
`https://adaptai-team2.netlify.app` once the deployed backend has the token module), create a token
in Profile, and paste it in the extension.

**Set up.** The settings are in `.env.supabase` at the repository root (ignored by git, like every
`.env.*`). Fill in `ADAPTAI_DATABASE_URL` (Supabase > Connect > Session pooler, with the password and
`?sslmode=require`), then:

```bash
python -m uv run --env-file .env.supabase python -m uvicorn app.main:create_app --factory --app-dir backend --host 127.0.0.1 --port 8000
```

```bash
cd vscode-extension && ADAPTAI_TEST_BACKEND=http://127.0.0.1:8000 pnpm test
```

**Evidence, 14 November 2026.** A backend from this branch (rebased on `main` `8d0c92b`) ran against the team's Supabase through the Session pooler (eu-west-1) with `ADAPTAI_DATABASE_SCHEMA=ide_dev`: the migrations created `ide_dev` (21 tables, including `api_tokens`) and the extension's 141 tests passed against it, the 11 integration tests included. A read-only comparison of `adaptai` before and after showed the same 20 tables, the same row counts in every table and no `api_tokens`: the deployed app's data was not touched.

**What the deploy needs** (not done here): the token pull requests merged into `main`, the CI
deploy to Render and Netlify, and then `adaptai.backendUrl` set to the Render address. The Netlify
address is the web app, not the API.

## Using your own LM Studio with a hosted backend (the relay)

A hosted backend (Render) cannot call the LM Studio on your computer: its `localhost` is the server.
The relay turns the connection around ([ADR-015](adr/ADR-015-relay-for-models-on-the-users-machine.md)).
While you are signed in and have a model set to run on your computer, the extension keeps a request
open on the backend; when the backend needs that model it sends the request down that connection, the
extension runs it on your LM Studio and sends the answer back. Nothing of your computer is opened to the
internet, and a request is only ever given to the extension of the account that made it.

**Use it**

1. Start the LM Studio server (Developer tab) with a model loaded.
2. In the extension: **LLM config > Add a model > LM Studio**, and in **Where it runs** choose **On this
   computer, through this extension** (it is the default when the backend address is not this machine).
3. The status bar shows **LM Studio relay** while it is connected; the LLM config screen says
   "Connected: your LM Studio answers requests from the backend". Pick that model in the Assistant.

The address of LM Studio is the setting `adaptai.relay.lmStudioUrl` (default `http://127.0.0.1:1234`);
it must be this computer. Every other model (Groq, OpenRouter, OpenAI, Claude) keeps working without the
extension. If the extension is closed, a request to the model on your computer fails with "Your model on
this computer is not available" and nothing else is affected.

**What a backend needs:** migration `009_llm_config_execution` (a column on `llm_configs`), the module
`backend/app/relay.py`, and the extension's personal token or session to ask for requests. A backend
without it answers 404 on `/api/relay/next` and the extension says "This backend has no relay yet".

**Check it without a hosted backend.** Start the backend with a dead LM Studio address, so it cannot reach
the model itself, and use the model through the extension:

```bash
ADAPTAI_LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1 ADAPTAI_EVALUATIONS_WORKER=false \
  python -m uv run --env-file .env.supabase python -m uvicorn app.main:create_app --factory --app-dir backend --host 127.0.0.1 --port 8033
```

A model set to run on the server fails ("LM Studio could not be reached"); the same model set to run on
this computer answers. An older backend refuses a schema that has migration 009, so use a schema of its
own (`ide_dev`) and never `adaptai` until the migration is approved.

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

### Local latency capture

Run **AdaptAI: Start local latency capture** in the Command Palette. Capture is off by default
and resets on every start. It keeps the most recent 1,000 completed timings in memory and
writes timing metadata to the local **AdaptAI Latency** log output channel. Nothing is uploaded.
Run **Show latency report** to open a JSON document, and **Stop latency capture** when finished.
VS Code retains the local output log according to its normal log lifecycle; stopping capture
does not remove records already written. Capture also stops when the extension is disposed.

The only recorded fields are sequence, milliseconds since capture started, phase, endpoint
template, HTTP method/status when available, duration and success/error/cancellation. Query
strings and resource identifiers are removed; unknown endpoints become `other`. Bodies,
headers, credentials, model answers, email addresses and exception messages are never recorded.
The capture does not change consent, model selection, caching or request ordering.

Measure five repetitions after warming the API, using the same account, model and synthetic
prompt, as in `cloud-setup.md`. Record rate limits and failures separately from successful runs.
Do not include the first wake-up request in warm latency statistics.

* `api`: request through complete JSON response consumption, including network time. Authentication
  and status probes that call `Backend.call` directly are not individual `api` samples.
* `firstText`: from starting the chat stream request to its first non-empty text delta. Metadata
  and empty deltas do not count. No sample is emitted if there is no text. This excludes model
  discovery, consent and chat creation before the request, and the webview's paint time.
* `stream`: stream lifetime through completion, failure, Stop or consumer cancellation. An SSE
  error counts as a failure even with HTTP 200. This overlaps `firstText`; do not add them.
* `reload`: time to check status, load the active tab and enqueue its update to the webview.
  This includes the health/auth probes, but excludes painting. It overlaps its child API requests.

Use `sequence` and `startedMs` to recognise concurrent reloads and repeated endpoints. Compare
panel loading, the `/api/analyze` request, `firstText` and stream completion separately; the
analysis result's `latency_ms` is a backend measurement and is not click-to-visible latency.

### Panel latency improvements (18 November 2026)

Panel reads run in parallel with a shared limit of three operations. Connection checks now
run separately through the status bar, outside the navigation path. Other extension activity,
such as the relay or model calls, is separate. Concurrent reloads of the same view share one promise;
tab/session changes cancel queued reads and obsolete responses cannot update the page or
the models action cache. A refresh after a mutation explicitly replaces an older reload.

Analyse and Coach publish local busy state immediately, without first loading the panel.
Analysis events during these actions publish the local result instead of reloading models.
After analysis/chat completion, only the chat list and selected transcript are refreshed.
The webview merges these partial updates and preserves live text while streaming. A partial
refresh failure shows a message and keeps the existing reply. Typing updates the Analyse/Send
buttons immediately; a background refresh is no longer needed to enable them.

Controlled before/after comparison, five repetitions per case with each synthetic request
delayed by 100 ms, against the previously installed instrumented build:

| Case | Before median | After median |
| --- | --- | --- |
| Assistant, no selected chat | 527 ms | 213 ms |
| Assistant, selected chat | 644 ms | 322 ms |
| My Progress | 1066 ms | 418 ms |
| Models | 532 ms | 215 ms |
| Profile | 650 ms | 211 ms |
| Panel work around analysis, excluding model time | 1079 ms | 106 ms |
| Panel work after chat, no selected chat | 529 ms | 103 ms |

Analysis starts in under 1 ms in this controlled test, instead of waiting about 534 ms for
the panel. Three overlapping Assistant reloads make five requests instead of fifteen. These
figures isolate client orchestration, not production latency or model inference. Real warm
authenticated measurements and the developer's G2 acceptance are still required.

Regression cases are in `test/dashboard-latency.test.js`: immediate analysis, bounded parallel
reads, partial failures, shared reloads, obsolete tabs/models/session/backend responses,
targeted chat refresh and errors, new actions overtaking an older conversation refresh, and
forced refresh after a mutation. Existing consent and model-selection tests still apply.
Run `pnpm test:page` after installing the existing `e2e` Playwright dependencies and Chromium
to verify the generated webview script, input/busy state, draft preservation, uninterrupted
streaming, final transcript replacement and ignored signed-out patches in a real browser.

### Immediate tab navigation and a 15-second memory cache

Selecting a tab replaces the previous screen immediately with the target's loading state.
The host then supplies a cached snapshot without API calls if it is under 15 seconds old.
An expired snapshot remains visible with “Updating…” while it is revalidated. The first visit
still waits for its data, but the user sees the destination immediately. If revalidation fails,
the old content remains with a visible error and Retry; its age is not renewed.

Snapshots live only in the extension's memory, at most one per tab. They are cleared on session
or backend changes, disposal, explicit refresh and backend mutations. The Assistant's selected
conversation and chat model form part of the cache key. Analysis/chat completion invalidates
dependent progress, profile and model snapshots. A 401/rejected token clears cached pages and
shows sign-in. Token-management pages while unlocked bypass the cache. No migrations, prompts,
provider settings or persistent cache files were added.

Tab changes no longer request health/auth status or inspect relay configurations. The status
bar updates only the connection header; its periodic check may revalidate the active tab if
its snapshot has expired. Relay checks still run after session/model changes and on the existing
timer, and their live state is merged into cached model pages. Shortcuts uses no backend calls.
Out-of-order status checks and page responses cannot take over a newer account/tab.

Controlled Chromium comparison against the previously installed build, five revisits per tab
after visiting all tabs, 100 ms per synthetic backend request, with no browser errors:

| Cached revisit | Before content | After content | Before API calls | After API calls |
| --- | --- | --- | --- | --- |
| Assistant | 226 ms | 14 ms | 5 | 0 |
| My Progress | 438 ms | 13 ms | 10 | 0 |
| Profile | 226 ms | 12 ms | 6 | 0 |
| LLM config | 224 ms | 13 ms | 5 | 0 |
| Shortcuts | 225 ms | 13 ms | 2 | 0 |

The loading screen appeared in 0.1–0.3 ms in this test. With health/auth each delayed by
1.2 seconds, Shortcuts previously took 2428 ms; now it took 11 ms and made no API calls.
These numbers measure local client orchestration and browser rendering with synthetic data,
not production latency, GPU paint time or model inference. Warm authenticated G2 remains manual.

`test/dashboard-cache.test.js` covers reuse, expiry, background refresh/failure, loading state,
mutation and scope invalidation, 401, selected conversations, uncached unlocked token management,
zero-network Shortcuts, independent status updates, obsolete status responses and relay behaviour.
`pnpm test:page` also checks immediate navigation, ignored old-tab messages, refresh/error feedback,
preserved drafts, account-header-only updates and scope reset in Chromium.

My Progress reads the Educator content from `coaching.saved.report`, matching the backend's
saved-report envelope. `test/fixtures/progress-with-coaching.json` is synthetic populated data
following this API shape. Browser regression checks cover saved summaries, patterns, suggestions,
charts, outcomes and history, missing coaching, and recovery after an unexpected rendering failure.
The host test also checks the same report envelope on fresh load and cached revisits. An unexpected
rendering failure shows a generic error and Retry instead of leaving the page blank.

### Preload at extension startup

#### Approved implementation plan

The scope below was approved incrementally by the responsible developer in the development
conversation on 18 November 2026. It is limited to the extension, its tests and this guide;
the backend API, database schema, model catalogue and AI prompts are unchanged.

| Change | Cases and regression evidence |
| --- | --- |
| Opt-in local latency capture | Disabled/enabled/reset/stop, sanitised metadata, API/stream timing, cancellation and errors: `test/diagnostics.test.js` |
| Faster analysis and panel reads | Immediate analysis, bounded parallelism, joined reloads, obsolete responses, partial chat refresh, failures: `test/dashboard-latency.test.js` |
| Immediate navigation and 15-second memory snapshots | Fresh/expired snapshots, retry, mutations, session/backend/401 invalidation, local Shortcuts and relay/status handling: `test/dashboard-cache.test.js` |
| Populated My Progress rendering | Synthetic saved Educator report, summary/patterns/suggestions, charts/history, missing data and rendering-error recovery: `test/fixtures/progress-with-coaching.json`, `test/page.browser.cjs` |
| All-tab startup warm-up | Assistant first, no-view startup, priority/three-read limit, sharing, failures, authentication, cancellation and disposal: `test/dashboard-preload.test.js` |

Manual acceptance of the final startup build and production latency measurements remain
separate from the automated evidence. No board card was supplied in this conversation;
linking the owning card is an open item for the responsible developer before merge.

After the backend credentials have been loaded, activation starts an asynchronous warm-up
without opening the AdaptAI view. The Assistant loads first; Progress, Profile, Models and
Shortcuts then load in the background into the same 15-second memory cache. Startup is also
triggered after sign-in, backend changes and when the view is recreated. Signed-out sessions,
rejected credentials and invalid backend addresses do not issue warm-up requests.

Opening a tab during warm-up joins its existing fetch. The initial webview `ready` message
preserves preloaded data; explicit Retry still forces fresh data. All panel reads share the
three-operation limit, and queued reads for the visible tab take priority over background
reads. The Assistant can appear before the remaining tabs finish. Background tabs never
navigate or redraw the active screen; cached Models restores its validated action data only
when it is displayed.

Failures are contained per tab; opening a tab whose warm-up failed retries it normally.
Session/backend changes, rejected credentials, mutations and disposal abort obsolete warm-up
jobs so late results cannot repopulate the cache. The existing consent and automatic Educator
settings still apply to the same GET endpoints; warm-up does not submit user tasks or chat
messages. No new stored data, migrations, AI prompts or provider settings are introduced.

`test/dashboard-preload.test.js` covers all-tab startup without a view, Assistant-first ordering,
the concurrency limit, immediate cached first visits, shared in-flight reads and `ready`,
foreground priority, Assistant availability while another tab is pending, failure and retry,
signed-out/invalid-address startup, 401, sign-out/backend-change cancellation, disposal and
automatic warm-up after sign-in.

`test/diagnostics.test.js` checks opt-in/reset/stop/bounds, metadata sanitisation, body consumption,
HTTP failures, cancellation, first text versus SSE metadata, SSE failures, and panel-load errors.

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

## The code assistant

Requirements F-IDE-04 and F-IDE-05 ([requirement](vscode-extension-requirement.md)). It uses the AdaptAI chat model through the backend, never the VS Code chat or Copilot, and has no `/` commands. Each id below is the start of a test name (`sel_`, `chg_`, `app_`, `ui_`); the tests were written before the code.

**Selection in the chat (SEL).** A button in the chat box, **Selection: Off / On**, decides whether the selected code goes with the message.

| Id | Requirement |
|---|---|
| SEL-01 | The button is Off at first. While it is On and code is selected, it shows what will be sent (`service.ts · 7–9`). |
| SEL-02 | With the button On and code selected, Send adds to the message the file path, the language, the line range and the code. The answer streams in the chat as usual. |
| SEL-03 | With the button On and nothing selected, nothing is sent and the box says to select code or switch the button off. |
| SEL-04 | The message of the user shows what they typed, with a caption `file · lines` and the code folded. The same after the chat is opened again from the backend. |
| SEL-05 | A message is at most 8000 characters. A longer selection is cut at a line break and the message says how much was sent. The text the user typed is never cut. |
| SEL-06 | The confirmation for an external model and the secret check that already exist apply to the code too. No new question is added. |
| SEL-07 | The title of a chat that starts with a code question or a change request is only what the user typed, never the rule text or the code. |
| SEL-08 | Before sending (release plan task E2). With Selection On and code selected, a line above the box says what will be sent (file and lines, number of lines and characters) with **Show** to open the exact text that goes with the message, the same text the message will carry. If the selection is too long for one message, the line says before sending how much will be sent (the first N of M characters), or that it is too long and to select less. With Selection Off, or nothing selected, there is no line. |

**Suggest a change (CHG).** The command **AdaptAI: Suggest a change** (palette and right click on a selection) and the button **Suggest a change** in the chat box (BTN-01) start it. The proposal always appears in the editor, not in the chat.

| Id | Requirement |
|---|---|
| CHG-01 | The command asks one thing in the box at the top: what should change. With nothing selected it says so and stops. |
| CHG-02 | The selection is widened to whole lines. The model gets the instruction, the lines and the rule: one short sentence and exactly one code block that replaces them. |
| CHG-03 | An answer is usable only with exactly one closed, non-empty code block. Otherwise the file is not touched and the message says which of the three it was (none, several, empty). |
| CHG-04 | Blank lines at the start and the end of the selection are kept in the proposal. Nothing outside the selected lines changes. |
| CHG-05 | A request that does not fit in 8000 characters is refused, never cut. |

**Accept or reject in place (APP).** Like the inline suggestion of other editors, with our own model.

| Id | Requirement |
|---|---|
| APP-01 | The proposal appears where the selection is: the original lines marked as removed, the proposed lines right below marked as added, and **Accept** and **Reject** above them. |
| APP-02 | Accept keeps the proposed lines and removes the original ones. Reject removes the proposed lines. In both the marks and the buttons go away. |
| APP-03 | Only the selected lines are replaced. A change above the proposal moves it along; a change inside it ends the review, keeps the text as it is and says so. |
| APP-04 | Saving the file with a proposal pending rejects it first, so a file is never saved with both versions. A second proposal in the same file rejects the first. |
| APP-05 | Ctrl+Z after Accept undoes the Accept; another Ctrl+Z removes the proposal. |

**The chat page (UI).**

| Id | Requirement |
|---|---|
| UI-01 | The chat follows the newest message: when you send, for every part of the answer, and when a chat opens. If you scrolled up to read, it does not pull you down until you send again or go back to the end. |
| UI-02 | The list of messages is what scrolls. The box to write stays at the bottom and never covers a message. |
| UI-03 | From 300 to 1200 px wide nothing is cut off and the page never scrolls sideways. Under 900 px the menu is a bar of tabs at the top instead of a column. |
| UI-04 | At 300 px the bar of tabs has no scroll bar of its own: its tabs wrap onto more lines instead (two or three, depending on the width). |
| UI-05 | When the backend is not reachable, every tab shows a clear message, "The backend is not reachable", with **Try again**, on top of what it already shows. When it is reachable again the tab loads by itself. |

**Buttons in the chat box (BTN).** The same actions as the commands and key bindings, one click away. The commands, the right click menu and the key bindings stay.

| Id | Requirement |
|---|---|
| BTN-01 | **Suggest a change** uses what is written in the box as the instruction and the code selected in the editor. It is never greyed out: with an empty box or nothing selected, a click says what is missing next to the box. It sits with Analyse and Send as a button of the same weight. It does not need the Selection button. The proposal then appears in the editor as in APP-01. |
| BTN-02 | **Improve prompt**, next to Analyse and Send, opens the Prompt Coach on the text in the box, the same as the ✦ button, which stays. |
| BTN-03 | With Selection On, Send analyses the selected code (SEL-02). There is no separate Analyse-the-selection button in the chat. |
| BTN-04 | Both buttons fit at every width of UI-03, wrapping onto a second line when they must. |
| BTN-05 | The lists that open from the box (model, Prompt Coach, chats) open inside the window at every width, and the box never has a scroll bar of its own, also with a long model name. |

**Improve the prompt in the editor (IMP).** `Ctrl+K Ctrl+E` on a selection or a file.

| Id | Requirement |
|---|---|
| IMP-01 | When the improvement is shown as a diff (`adaptai.improveApply` = `diff`), the diff's tab bar has **Apply** and **Dismiss** buttons, and the same two commands are in the Command Palette while a diff waits. Apply replaces the text (Undo brings it back); Dismiss leaves it. Both hide the buttons. The notice "apply the improved prompt?" stays, but a missed or hidden notice does not lose the improvement. With nothing waiting, Apply says so and changes nothing. |

**Project context (PRJ, release plan task E4).** The analysis also gets the language, framework and test runner of the project, so a recommendation fits the kind of work.

| Id | Requirement |
|---|---|
| PRJ-01 | Language, framework and test runner are detected from the manifest files at the top of the workspace folder (`package.json`, `tsconfig.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`). Only names from a fixed list can come out. Package names, file text and paths never do, however the files are written. |
| PRJ-02 | The values go with an analysis as one short line in its task context (`Project: TypeScript, React, Vitest`), never in a chat message. The message after the analysis says what was sent. Nothing is added when nothing is detected. No file content leaves the machine for this. |
| PRJ-03 | The setting `adaptai.projectContext` (on by default) turns it off; when off nothing is added and the message says nothing. The setting's text lists what is sent. |

**Analysis result (RES).**

| Id | Requirement |
|---|---|
| RES-01 | The message that follows an analysis names the backend (its address) and the model, so the user sees where the text went. A question before sending still appears only for an external model or a whole file. |

**Refused backend address (CFG-02).** When `adaptai.backendUrl` is refused (plain http to another machine), an error message says why with **Open settings**, and the signed-out view of the page shows the same reason.

**LLM config (CFG-01).** The page only lists, adds, tests, edits and deletes models. It has no "Use for chat" button and no "chat model" label; the model is chosen in the box of the chat (Model), and later a model suggested by the app can be offered there too.

**Decisions.** The backend takes only text in `content`, so the code travels inside the message, written by the extension; the page and the loaded history hide it behind the caption. The change request is a message in the current chat, so it also appears in the chat list. The default backend address is unchanged. Left out on purpose: the VS Code chat, `/` commands, a side by side comparison, a key binding and a refusal of files by name.

**Review in place after Accept or Reject (APP-06).** After Accept or Reject the marks and the Accept and Reject buttons are gone at once, and a moment later again if VS Code redraws them late.

**Code that changed (APP-07, release plan task E1).** A proposal is never applied to code that changed after it was asked for: if the selected lines changed while the model was answering, nothing is written; if they changed after the proposal was shown, Accept does nothing. Both say so with an **Ask again** button that opens the question again with the same instruction filled in. Lines outside the selection may change freely: only the selected lines are ever replaced.

**Known limits.** The proposal is written into the file until it is accepted or rejected (APP-04 keeps it out of a save); with automatic saving after a delay it can be rejected while you read it. The tests use a stand-in for VS Code; checks 31 to 36 of the [acceptance run](vscode-extension-acceptance-codex.md) are the only proof in a real window. The change prompt has not been measured with a real model.

## Known limits today

* No part of the page has been clicked through by a person in a real window yet (see the manual checklist).
* The 4 `test_postgres.py` SQLite-import tests fail on Windows (`WinError 32`); they are in code this change does not touch and were not run on a clean develop.
* Supabase mode is only tested with a stubbed Supabase.
