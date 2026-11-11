# AdaptAI

First backend increment: task → complexity profile → capability filtering → explained
recommendation → user selection or override. Python 3.12, uv, FastAPI, LangChain and
an explicit LangGraph workflow. The team's React mock retains its design and its
Assistant screen now calls the backend. My progress uses saved metadata; Profile manages preferences and optional memory.

## Python tooling

Use **uv** from the repository root. Python 3.12 is selected by `.python-version`.
`pyproject.toml` declares dependencies; the generated `uv.lock` pins the complete
dependency graph. Commit both files. Never commit `.venv` or credentials.

```powershell
# Reproduce the locked development environment
uv sync --locked

# Add a runtime dependency, updating pyproject.toml and uv.lock together
uv add <package>

# Add a development dependency
uv add --dev <package>

# Check the lockfile
uv lock --check

# Check Python code
uv run python -m ruff check backend scripts
uv run python -m ruff format --check backend scripts

# Run tests
uv run python -m pytest -q
```

uv manages the virtual environment automatically; manual activation and
`pip install` are not part of the project workflow. Upgrade packages deliberately
with `uv lock --upgrade-package <package>`, then run the relevant checks.

## Run the complete stack with Docker

From the repository root, with Docker Desktop's Linux engine running:

```powershell
docker compose up --build -d --wait
```

Open [AdaptAI](http://127.0.0.1:8080). The stack contains:

- `frontend`: a locked React production build served by unprivileged Nginx on port 8080
  inside the network, published only on `127.0.0.1:8080`.
- `backend`: FastAPI/Python 3.12 with runtime dependencies from `uv.lock`, running as
  a non-root user. Port 8000 is internal; the browser reaches it through `/api` on Nginx.
- `postgres`: PostgreSQL 17, published on `127.0.0.1:55432` for native development tools.

The frontend forwards API requests without changing their paths, cookies or Origin.
Response buffering and proxy caching are disabled for the API so chat SSE streams and
Stop keep working. Hashed frontend assets have long-lived caching; HTML is revalidated.
Compose waits for PostgreSQL, then the backend, then the frontend health checks.

Existing `postgres-data` is reused, including data imported from SQLite. `backend-data`
persists the credential encryption key at `/data/adaptai.credentials.key`; both volumes
survive container recreation. If existing encrypted credentials used another key, supply
that same `ADAPTAI_CREDENTIALS_KEY` in the backend environment before using them.
When deploying the backend image elsewhere, persist `/data` or provide that key as a secret.
Native and Docker backends sharing one database must use the same credential key;
their default key files live in different locations.

An optional root `.env` is passed only to the backend at runtime. Neither image contains
`.env`, local databases, backups, credential keys or host `node_modules`. No provider key
is needed to start the stack; real analysis/chat still needs a configured model. For
local Docker, Compose overrides the native database URL with `postgres:5432` and uses
a local PostgreSQL instance. A hosted database is a later deployment configuration.

```powershell
docker compose ps
docker compose logs -f backend frontend
docker compose stop
docker compose start --wait
docker compose down
```

`down` keeps both data volumes. **`down -v` deletes the database and local encryption key.**
Rebuild with `docker compose up --build -d --wait` after source or dependency changes;
these are packaged images rather than development servers with hot reload. Source files
on the host are not mounted into the running application.

Use `ADAPTAI_HTTP_PORT` and `ADAPTAI_POSTGRES_PORT` to change published ports. When changing
the HTTP port or hostname, set `ADAPTAI_CONTAINER_BROWSER_ORIGIN` to the exact browser origin too.
The expected Docker URL is `http://127.0.0.1:8080`, rather than `localhost`.
Native Vite development keeps port 8443 and its own `ADAPTAI_BROWSER_ORIGIN`.
For Docker, Ollama and LM Studio use `host.docker.internal`; their native defaults remain
localhost. Configure `ADAPTAI_CONTAINER_OLLAMA_BASE_URL` or
`ADAPTAI_CONTAINER_LMSTUDIO_BASE_URL` for another server reachable from the backend.

CI also builds and starts these images, checks static assets, authentication, CSRF,
analysis and demo SSE through Nginx, recreates the app containers and verifies stored
data plus the credential-key fingerprint. The container smoke test uses a disposable
database and synthetic credentials; it makes no real provider calls.

Cloud hosting is still being planned. See [the hosting proposal](docs/hosting-plan.md)
for the free-tier recommendation and the planned Supabase Auth integration. It is
separate from the working local Compose stack and has not been deployed.

## Run locally with native development tools

From the repository root:

```powershell
uv sync --locked
docker compose up -d --wait postgres
uv run python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Open [interactive API documentation](http://127.0.0.1:8000/docs). No credentials are
needed for demonstration mode. Create a local account in the frontend before analysing.
Example authenticated request to `POST /api/analyze`:

```json
{
  "task": "Compare two API designs and explain their trade-offs",
  "provider": "demo",
  "required_capabilities": ["text", "code"],
  "allow_external": false
}
```

The demo uses word count as a low-confidence context-size proxy. Semantic dimensions
and execution modality remain explicitly undetermined; its recommendation is provisional.
It is **not semantic AI assessment**. With no classified model available, the
recommendation uses the illustrative demo cards of the catalogue, which make no real price or
performance claims (see "Model recommendation").

In a second terminal, start the supplied frontend using its existing pnpm lockfile:

```powershell
cd frontend
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

Open [the frontend](http://127.0.0.1:8443). The Vite development server proxies `/api`
to `127.0.0.1:8000`. `pnpm build` checks TypeScript and creates the production assets.
The Assistant starts empty, fetches configured providers, displays actual API results
and confirms eligible selections. The semantic profile now covers reasoning, context,
ambiguity, domain specificity, risk and tool need, with categorical execution modality.
Every dimension includes evidence and qualitative, uncalibrated confidence; unknown
values display as “Not determined”. Clarification prompts invite editing and re-analysis
without blocking eligible selections. The rubric is versioned data in `backend/rubric/` (see "Rubric" below); the API migration is described in the "Seven-dimension prototype" section below.
Accounts, persistent session history, context and confirmed choices are implemented.
My progress shows real saved history, counts and recommendation agreement.
Visited pages stay mounted in browser memory during the authenticated session, preserving
chat drafts, unsaved preferences and loaded charts when switching screens. This state is
discarded on reload, logout or account change; task drafts are not written to browser storage.
Progress refreshes after relevant changes and when revisited after 30 seconds. Hidden pages
pause coaching polling, and model and Prompt Coach settings propagate to the open Assistant.
My progress also answers "Are you describing tasks better?": it compares the completeness of the first analysis of each session (re-analyses do not count) between your first and last sessions (up to five each, from five sessions on), gives a verdict computed in Python (improving, stable or declining; a change under 5 points is stable) and lists which dimensions you now describe more or less often (`GET /api/progress/learning`, numbers only). The Educator receives the same verdict and must not contradict it.
The original progress dashboard uses actual per-session agreement and capacity comparison counts.
My data exports the account's context and paginated session history as a local JSON file.
Groq coaching uses derived metadata, on request or automatically when enabled in Profile. The optional Prompt Coach helps describe a task better (see "Prompt Coach (optional)"). Team aggregation remains unimplemented.
The local Docker stack includes a production-build frontend and an API reverse proxy.
Cloud hosting and automatic deployments are not configured.

## Configure assessment providers

Copy `.env.example` to `.env` in the repository root. Keep credentials out of Git.
For **Groq**, set `ADAPTAI_GROQ_API_KEY` and `ADAPTAI_GROQ_MODEL` (the example uses
`openai/gpt-oss-20b`, hosted by Groq). The adapter uses LangChain's OpenAI-compatible
client against the fixed Groq endpoint `https://api.groq.com/openai/v1`, with strict
JSON schema output and backend validation. This uses a Groq key, not an OpenAI key.
See [Groq compatibility](https://console.groq.com/docs/openai) and
[structured output support](https://console.groq.com/docs/structured-outputs).
Model availability and account quotas must be verified with your account.

Alternatively, set `ADAPTAI_OPENAI_MODEL` and `ADAPTAI_OPENAI_API_KEY` to enable OpenAI, or
`ADAPTAI_OLLAMA_MODEL` to enable a model already installed in a running local
Ollama service at `127.0.0.1:11434`. Restart after changing configuration.
Choose a model that supports structured output. Arbitrary OpenAI-compatible
endpoints are not implemented in this increment.

### OpenAI and Claude

The same assessment contract supports OpenAI models, including Codex models, and
Claude models through Anthropic's Messages API. Each configured provider
appears in the existing frontend provider selector; changing provider clears the
external-processing consent. Models are configured on the backend rather than
hard-coded in the workflow.

| Provider ID | Model setting | Credential setting |
| --- | --- | --- |
| `openai` | `ADAPTAI_OPENAI_MODEL` | `ADAPTAI_OPENAI_API_KEY` |
| `claude` | `ADAPTAI_CLAUDE_MODEL` | `ADAPTAI_ANTHROPIC_API_KEY` |
| `groq` | `ADAPTAI_GROQ_MODEL` | `ADAPTAI_GROQ_API_KEY` |
| `openrouter` | Personal only: the user's own model in LLM config | The user's own key (never a project key) |
| `ollama` | `ADAPTAI_OLLAMA_MODEL` | Local runtime |
| `lmstudio` | `ADAPTAI_LMSTUDIO_MODEL` (and `ADAPTAI_LMSTUDIO_BASE_URL`, default `http://127.0.0.1:1234/v1`) | Local runtime, no key |

### OpenRouter (a catalogue behind one key, ADR-014 A12)

OpenRouter is **never a project chat model and never a default**: Auto is always the project
Groq. A user connects OpenRouter in LLM config with **only their own API key** (a default model
is optional, and "Test connection" checks the key without calling a model); the chat pickers
then list the whole OpenRouter catalogue, each model with its evaluation state. There is no
Auto router (`openrouter/free` is not offered or accepted), so the cost of a paid chat model is
always on the user's own key. The only project key is `ADAPTAI_EVALUATION_OPENROUTER_KEY`, used
to evaluate models and never for chats (ADR-014 A10, see "Automatic model evaluation").

Since ADR-014 A11 the analysis always runs on the project's assessor (Groq first, the next
server model on a limit), so OpenRouter models only answer in the chat. The problems seen on
5 November 2026 (free models truncating the JSON with `provider_output_truncated`, 404 for
`require_parameters`) therefore only matter when someone picks an OpenRouter configuration by
hand for an analysis.

`openrouter` uses LangChain's OpenAI-compatible client against `https://openrouter.ai/api/v1`
with strict JSON schema output. The user's key is stored encrypted like the other personal keys;
it is sent only to `/chat/completions`, never returned to the frontend, to
`GET /api/openrouter/models` or in an error code. The assessment (not the chat) sends
`provider.require_parameters: true`, so only endpoints that support the strict JSON schema are
used instead of the schema being silently ignored; the chat is plain text and never sends it, so
a model without structured output still answers there. When no endpoint of the chosen model
supports the schema OpenRouter answers 404 "No endpoints found"; the app maps it to
`model_not_compatible` (the analysis only).

`GET /api/openrouter/models` (signed in; `?refresh=true` bypasses the 5-minute cache) returns
the live `GET /models` catalogue of OpenRouter, normalised: free and paid models, price per
1M tokens (converted from the per-token `pricing`), context length, modalities and supported
parameters. A model is `free` only when its prompt and completion price are both zero. There is
no built-in model list and no stale fallback: if OpenRouter cannot be reached the endpoint
answers 502 `openrouter_catalogue_unavailable`. A model is `selectable` when it takes text and
returns text (the chat needs nothing more); `structured_output` says whether it could also run
an assessment. Embeddings, image, audio and music models stay listed with the reason.

`POST /api/analyze` accepts an optional `model` for OpenRouter only. It must be a selectable id of
the catalogue (422 `model_not_found` / `model_not_compatible`) and is sent to OpenRouter exactly
as given; the model of the personal configuration is checked the same way. A paid model on a key
with no credit answers 502 `provider_insufficient_credits` (HTTP 402 upstream). Selecting the
project's `server:openrouter` is refused (409 `provider_not_configured`).

### LM Studio

`lmstudio` talks to LM Studio's local OpenAI-compatible server (Developer tab, Start Server;
default `http://127.0.0.1:1234/v1`) through the same client, with JSON schema output. It is
enabled when `ADAPTAI_LMSTUDIO_MODEL` names the loaded model. It needs no key, is local (not
an external destination, so no external-processing consent) and its address is server
configuration that no request can change. A personal LM Studio model can be added in LLM
config like an Ollama one. Not run against a real LM Studio yet; the tests use a fake client.

Both providers also work in the chat (below).
Set the model IDs available to your provider account in `.env`, with the appropriate
API keys, then restart the backend. OpenAI and Claude remain disabled until both the
model and key are present. Neither integration reads Codex CLI/Claude Code login
sessions or subscription credentials. Keep all keys on the backend.

OpenAI uses Chat Completions by default. For models requiring the Responses API,
including Codex models, set `ADAPTAI_OPENAI_USE_RESPONSES_API=true` and put the model
ID in `ADAPTAI_OPENAI_MODEL`. They use the same `openai` provider and selector entry.
The Responses path uses strict JSON schema output with storage disabled (`store=false`).
Claude uses native JSON schema output, so choose a Claude model supporting that
feature. Both adapters validate the resulting profile with Pydantic and normalise
usage, invalid responses, refusals, timeouts, authentication and quota errors into
the existing API contract. There is no silent fallback or automatic retry. These
providers assess the task; they do not execute it or modify the model catalogue.

Compatibility references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses),
[Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
and [LangChain ChatAnthropic](https://docs.langchain.com/oss/python/integrations/chat/anthropic).
Availability and model quality must be checked with the selected account and evals.

The OpenAI Responses and Claude tests exercise the real SDK request/response formats through
mock HTTP transports, including malformed output, refusals, authentication errors,
timeouts and rate limits. They do not call the services or prove live connectivity.
After configuring an account, the explicit smoke-test commands are:

```powershell
uv run python scripts/check_llm.py --provider openai
uv run python scripts/check_llm.py --provider claude
```

These commands send a synthetic task and consume provider quota. No live Codex or
Claude call was performed while implementing this integration. Implementation and
tests were AI-assisted; human review and live verification remain to be recorded.

`GET /api/providers` lists configuration availability, not verified connectivity or
model compatibility. Calling OpenAI or Groq also requires `allow_external: true` for each
analysis. This consent also applies to Claude. Analyses use the project's assessor and,
if it hits a limit or fails, the next project model, said in the result (ADR-014 A11); a
manually chosen configuration is never replaced. Timeouts default
to 30 seconds. Provider errors return sanitised codes, never upstream messages.
The frontend uses project Groq in Auto mode. The Analyse action sends the task to the
displayed destination, with an adjacent disclosure; no separate Allow checkbox is needed. Results display the actual assessment model and token usage when
available. Provider failures never silently fall back to demonstration mode.

Automated tests use fakes and a mock HTTP transport; they incur no API charges and
do not establish live account connectivity. After setting a valid key, explicitly run
the live smoke test from the repository root (uses a synthetic task and provider quota):

```powershell
uv run python scripts/check_llm.py --provider groq
```

It prints model identity, latency and token counts on success, or a sanitised error
code on failure. `provider_authentication` means the provider rejected the credential:
replace it in `.env` and restart the backend. Never share keys in chat or commit `.env`.
A successful LLM call does not validate recommendation quality. That smoke test predates the seven-dimension
profile contract; provider compatibility with `profile-2` has not been verified live.

Live verification on 21 October 2026 succeeded with Groq's `openai/gpt-oss-20b`:
the API returned a validated semantic assessment with actual token usage. The supplied
frontend was tested through its development proxy, including external-processing
consent, displaying the assessment and confirming an alternative choice. One initial
request was rejected by the provider; subsequent requests succeeded. This is a local
integration smoke test, not a reliability benchmark or an assessment-quality evaluation.

Assessment providers and recommended catalogue entries are separate concepts.
The LLM assesses the task; Python turns the profile into task needs and compares them with
the catalogue's capability cards. It does not execute the task or generate catalogue facts.

## API contract for the team frontend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Process health |
| `GET /api/progress` | Current user session, analysis, choice and match counts |
| `GET /api/progress/dashboard` | Last six sessions with choices and over/under counts |
| `GET /api/progress/outcomes` | Feedback totals: solved, after refining, not solved, followed the recommendation, per model |
| `GET /api/context`, `PUT /api/context` | Read/save account preferences and memory settings |
| `DELETE /api/context/memory` | Clear learned metadata memory without deleting progress |
| `GET /api/providers` | Provider IDs, availability and external destination flag |
| `GET /api/catalogue` | The active catalogue version: capability cards, sources, cost bands |
| `POST /api/analyze` | Profile, task needs, recommended model, alternatives, notes, reasons and versions |
| `POST /api/decisions` | Persist `analysis_id` and eligible `candidate_id` for the signed-in owner |
| `PUT /api/analyses/{id}/outcome`, `GET` | Feedback for the task: `resolved`, `resolved_with_refinement`, `not_resolved` (optional `reason`) or `skipped`, once |
| `POST /api/auth/register`, `POST /api/auth/login` | Create account / sign in with email and password |
| `GET /api/auth/me`, `POST /api/auth/logout` | Current user / revoke current login |
| `GET /api/sessions`, `POST /api/sessions` | List / create the current user's sessions |
| `GET /api/sessions/{id}` | Saved assessment metadata and choices |
| `PATCH /api/sessions/{id}`, `DELETE /api/sessions/{id}` | Compatibility no-op / delete session and history |

The generated `/openapi.json` specifies request and analysis response schemas. Tasks
must be nonblank and at most 8,000 characters. Required capabilities can be `text`,
`code`, and `vision`; these describe catalogue requirements, **not uploaded inputs**.
Only text inputs are supported. Unknown fields and capabilities are rejected.

Sign in before calling analyses, decisions or sessions. Registration and login accept
`email` and `password` (12–128 characters); responses set an HttpOnly, SameSite=Lax
cookie. The browser sends it through the existing same-origin `/api` proxy.
For selection, use the analysis response's `id` as `analysis_id`. Choices persist;
repeating the same choice is idempotent, and changing a confirmed choice returns 409.
An analysis response includes `session_id`; omit it on input to create a new session,
or supply an owned session ID to append an assessment. Cross-account IDs return 404.
Session lists and history accept `limit` (1–100, default 100) and `offset` (default 0).
My progress loads sessions and analyses in pages of 20, with load-more controls.

Errors include unconfigured provider (409), external consent required (403), invalid
input (422), provider timeout/authentication/rate limit/invalid output (502), and
unknown analysis/session (404), missing or expired login (401), and conflicting choice
(409). The frontend should let the user explicitly
retry or choose another provider. The supplied frontend uses a development proxy for
`/api`; production origins and deployment remain to be agreed.

## Rubric

The assessment rubric is data (ADR-009). Each version is an immutable JSON file in
`backend/rubric/versions/`; `backend/rubric/ACTIVE` names the version in use and
`backend/rubric/versions.json` records the sha256 of every version file. The backend
refuses to start if the active version is missing, invalid, unregistered or modified.
`backend/app/prompt_builder.py` generates the assessment prompt from it; `rubric-2.0`
reproduces the former `assessment-v2.txt` prompt byte for byte (fixture in
`backend/tests/fixtures/`). `rubric-2.0` is the active version. `rubric-2.1` is registered but
**not active**: same levels, questions and tips, plus prompt anchors so that a document the task
refers to but does not supply counts as missing information (ambiguity), not as context demand,
and so that health, safety, legal, financial and personal-data consequences score 3 for risk and
professional fields score 3 for domain. It comes from manual tests with two models, not from an
eval, and switching changes every analysis (and the learning progress, which compares analyses
made with different rubrics). The Architecture Owner decides, after comparing 2.0 and 2.1 on the
same model with 10 to 20 tasks; to activate it, point `ACTIVE` at it and revert the version
assertions in the tests. Each response carries `rubric_version`, and
`GET /api/rubric` returns the dimensions, definitions and levels (never tips or
Prompt Coach focus). To change the rubric, add a new version file, register its hash,
point `ACTIVE` at it and run the core eval; never edit a registered file.
`uv run python scripts/render_rubric.py` prints the active rubric as Markdown.

## End-to-end tests

`e2e/` runs Playwright against the real backend and the Vite frontend, with deterministic
fake models from `e2e/server.py` (temporary database, no API keys, no external calls):

```bash
cd e2e
pnpm install
pnpm exec playwright install chromium
pnpm exec playwright test
```

The tests start their own servers on ports 8100 (API) and 8543 (web) and never reuse a running
app, so the app you run on 8000/8443 (real models, your data) can stay open. They need
PostgreSQL: `ADAPTAI_TEST_DATABASE_URL` (default the Docker database on 55432; with a native
PostgreSQL, for example `postgresql://adaptai:adaptai@127.0.0.1:5432/adaptai_test`). Each run
uses a temporary schema, dropped at the end.

The CI job `e2e` runs the same specs.

## Prompt Coach (optional)

**Role.** The Prompt Coach helps a user describe a task well enough for the analysis to
determine it: it points at the dimensions left uncertain and, only when asked, proposes edits,
questions or a rewrite. It does not recommend models (that is the deterministic recommendation,
ADR-014), does not judge the user over time (that is the Educator's coaching in My progress,
`backend/app/coaching.py`) and does not answer tasks (that is the chat). Its effect is
measured without storing anything of its own: "Analyse again" shows the change in
completeness, and learning progress compares the completeness of the first analysis of each
session over time, next to the task outcomes. Coach usage metrics (`prompt_coach_events`,
ADR-010) were dropped on 10 November 2026: they would store more data, with its own privacy
decision, for a measure the product already has.

The Prompt Coach is an optional module (ADR-009) that the client has not approved. There
is no server flag: each user switches it on or off in **Profile** (on by default), and the
choice is kept per account. `create_app` imports `backend/app/prompt_coach.py` late, at the
end, inside a single `try`, and carries on without it if the file is missing; no other core
file imports it, and `backend/tests/test_features.py` enforces that. `GET /api/features`
(public) returns `{"prompt_coach": true|false}`: whether the module is installed.
`GET`/`PUT /api/prompt-coach/settings` read and change the user's switch; with it off,
`POST /api/prompt-coach` answers 403 `prompt_coach_disabled` without calling a model.

In the Assistant, a bubble on the task field (`PromptCoachBubble.tsx`) is the Coach's
entry point. After an analysis it shows how many dimensions were left uncertain, using
the same priority as the backend and no model call; the count disappears when the text
changes. Selecting it opens a floating panel above the bubble that names where the task
would be sent, asks the Coach only on click (edits, questions or a rewrite shown as a
diff), changes the task only on click, and offers **Analyse again** to see what changed.
With the user's switch off the bubble runs quick local checks only (very short text,
emails, phone numbers) and sends nothing. The switch itself is `PromptCoachToggle.tsx`
in Profile.

Tests of the module carry the `prompt_coach` pytest marker. CI runs the backend suite and
a `removal-drill` job that deletes the module, runs `pytest -m "not prompt_coach"`,
migrates a real database, adds leftover `prompt_coach_events` and
`prompt_coach_settings` tables and restarts the app over them, checking that the core
`schema_migrations` rows are unchanged. The module must therefore never add a core
migration: its table (`prompt_coach_settings`) is created with
`CREATE TABLE IF NOT EXISTS`, outside the core migrations. The Coach is mounted after
every core route, so it can never shadow one. Branch protection should require the
checks "backend" and "removal-drill".

To remove the Prompt Coach:

1. Delete `backend/app/prompt_coach.py`, `backend/tests/test_prompt_coach*.py`,
   `scripts/check_prompt_coach.py`, `frontend/src/PromptCoachTips.tsx`,
   `frontend/src/PromptCoachBubble.tsx` (and its `.coach*` styles in `index.css`),
   `frontend/src/PromptCoachToggle.tsx`, `e2e/coach-bubble.spec.ts` and the Coach steps
   in `e2e/assistant.spec.ts`. The backend already runs without the file.
2. Remove the touch points: in `backend/app/main.py` the `try` block and the
   `prompt_coach_options` parameter; `prompt_coach` in `/api/features` (or keep it, it
   returns `false`); `/api/prompt-coach` in the no-store path list; the `prompt_coach`
   marker in `pyproject.toml`; the `collect_ignore_glob` line in
   `backend/tests/conftest.py`; the `removal-drill` job in `.github/workflows/ci.yml`; in
   `App.tsx` the `PromptCoachTips` line and the `<PromptCoachBubble>` wrapper around the
   task field (keep the textarea); the `PromptCoachToggle` line in `Profile.tsx`;
   `prompt_coach_options` in `e2e/server.py`.
3. Optionally run `DROP TABLE IF EXISTS prompt_coach_settings` (and
   `prompt_coach_events`, if present) in PostgreSQL; the core ignores them.
4. Run the full backend suite, `pnpm build` and the e2e tests.

## Chat

The chat is a core feature of the product (ADR-011), not an optional one. In the code it lives
in its own module so the analysis core can be tested without it, like the Prompt Coach: `create_app` imports `backend/app/chat.py` last, inside its own `try`, and carries
on without it. `GET /api/features` reports `{"chat": true|false}`. A chat is a session
marked in `chat_sessions`; analyse a draft with the usual `POST /api/analyze`, passing the
chat id as `session_id`, then send it with the `analysis_id` to link the two.

| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/api/chats` | List or create the user's chats |
| GET/PATCH/DELETE | `/api/chats/{id}` | Messages (with each analysis' completeness), rename, delete |
| POST | `/api/chats/{id}/messages` | Send `{content, provider, configuration_id?, model?, analysis_id?, allow_external}` and get `{title, message, answer}`, or a stream (below) |
| POST | `/api/chats/{id}/messages/{answer_id}/retry` | Answer the last question again (`{provider, configuration_id?, allow_external}`) |
| GET/PUT | `/api/chat/settings` | `{auto_analyse}`, off by default |

The answer comes from the chosen model (`configuration_id`, or the server provider; `auto`
means Groq) with the last 20 turns or 12,000 characters of the chat. The click on Send is
the consent for an external provider, as with Analyse. A provider failure is stored as an
answer with `status: "failed"` and the error code (for example `provider_rate_limit`) and is
left out of later history. A model that ends without any text (reasoning models sometimes do)
is stored the same way, as `failed` with `empty_answer`, so Retry is offered instead of a blank
answer marked complete. The providers `openrouter` and `lmstudio` (ADR-012) work in the chat
like the others; for `openrouter` (always the user's own configuration) the message may also carry an optional
`model`, which must be a text-in, text-out id of the live catalogue (422 `model_not_found` /
`model_not_compatible`; 422 `model_override_not_supported` for any other provider). The chat
does not need structured output, so it accepts catalogue models the assessment cannot use. The
demonstration provider answers with a fixed note.

With `Accept: text/event-stream` the send answers as Server-Sent Events: `message` (the
stored question and the `answer_id`), `delta` (text as it arrives), `error` (code, on a
provider failure) and `done` (the same `{title, message, answer}` as the JSON reply).
Closing the connection is **Stop**: the text received so far stays, with status
`stopped`. `POST /api/chats/{id}/messages/{answer_id}/retry` answers the last question
again after a failed or stopped answer, replacing that answer.

In the frontend, when `/api/features` reports `chat`, the **Assistant** tab is the chat
(`ChatScreen.tsx`): the list of chats (new, open, delete), the messages and a message box
with the model picker (and, when OpenRouter is chosen, its second picker of live catalogue
models, ADR-012; the chosen id is sent as `model` with Analyse, Send and Retry), the Prompt
Coach bubble and two buttons. **Analyse** runs the usual
analysis on the draft without sending it and opens the analysis panel on the right
(`AnalysisDrawer.tsx`: completeness, what changed, clarification questions, recommended
model with its coverage per need, tips, profile). **Use this model** in the recommendation card
(or **Use** next to "Recommended" above the text box) selects it for Send when it is one of the
user's models; otherwise the card says it is not among them, or that it is illustrative.
Changing the model after an analysis keeps the analysis. The panel slides in from the right; its tab, part of the panel's
left edge, stays visible when it is closed, widens on hover to read "Show analysis" or
"Hide analysis", and opens or closes it on click (or drag left to open, right to close). Analysing an edited draft again
shows what changed. **Send** sends the message (Enter sends, Shift+Enter adds a line) and
carries the analysis only if it was made from that exact text; the message then shows an
"Analysis NN/100" chip that reopens it. Send records the choice when the model used is one
the analysis compared. Under the answers of the open task a quiet **Task solved** asks once
whether the user needed to refine it; when the next task starts (a new analysis, another chat)
a card asks whether the previous one was solved (Solved, Solved after refining, Not solved
with an optional reason, Skip). Never per answer, never twice. Both show the model used and the
recommended one. The model actually used is always stored (provider and model id); "followed
the recommendation" is yes when it was the recommended model, no otherwise, and unknown only
when the recommendation was illustrative. While an answer streams in, Send becomes **Stop**;
a stopped or failed answer offers **Retry**. Answers are rendered as GitHub-flavoured
Markdown (`ChatMarkdown.tsx`, react-markdown with remark-gfm); raw HTML is dropped and unsafe
links removed. The chat's system prompt asks every model for the same Markdown, so answers
from different providers look alike. Without the module, or for a saved session
that is not a chat, the earlier Assistant page is shown. The result cards are shared in
`AnalysisResult.tsx`.

To try it against a real provider (uses quota; a throwaway account and database):

```powershell
uv run python scripts/check_chat.py                  # Groq from .env, in-process
uv run python scripts/check_chat.py --provider demo  # no key
uv run python scripts/check_chat.py --url http://127.0.0.1:8000  # a running backend, also checks Stop and Retry
```

Tests carry the `chat` marker; the `removal-drill` job deletes `chat.py` together with the
Prompt Coach. To remove the chat: delete `backend/app/chat.py`, `scripts/check_chat.py` and
`backend/tests/test_chat*.py`, then the `try` block and `chat_options` in `main.py`,
`chat` in `/api/features`, `/api/chat` in the no-store list, the `chat` marker,
`chat_options` in `e2e/server.py` and the chat lines of the `removal-drill` job. Optionally
drop `chat_sessions`, `chat_messages` and `chat_settings` (`chat_model_tiers` was removed by
ADR-014; the module drops it on start).

## Seven-dimension prototype

The response identifies `profile_version: profile-2`, `policy_version: needs-capabilities-1`, `catalogue_version` and `rubric_version`; re-analyses that send `previous_analysis_id` also return `completeness` and `changes`.
This changes scalar profile fields into objects: read `profile.reasoning.score`,
`.confidence` and `.evidence`. Backend, frontend and test fixtures must migrate together.
The assessor instructions are generated from the active rubric version (see "Rubric").

The recommendation is described in "Model recommendation" below. Ambiguity never raises the
model: it is missing information, handled by clarification questions and the Coach. Unknown
requirements or low confidence mark the result provisional.
This policy is accepted (ADR-014, 10 November 2026); independent task evaluation is still to come.
The contract tests run in CI; human quality evals and their regression gate remain outstanding.

## Model recommendation (ADR-014, `needs-capabilities-1`)

The analysis recommends a concrete model, not a tier: **the cheapest of the user's models whose
capabilities cover every need of the task**. Deterministic Python in
`backend/app/recommendation.py`; the step names are the ones the Product Specification uses.

**Task needs** (`task_needs`), on the rubric's 1–3 scale: reasoning, context, domain,
reliability (from risk) and tools, plus modalities and length. Each need is an interval
`[estimated, top]`: high or medium confidence `[s, s]`, low `[s, s+1]`, undetermined `[2, 3]`.

**Capability cards** (`backend/data/catalogue/`, versioned and hashed like the rubric; active
version in `ACTIVE`): one card per model with provider facts (context window, modalities, tools,
prices), five levels (each with status `provisional`, `calibrated` or `unrated`, a source and a
date) and its aliases per provider (`groq`, `openrouter`, `lmstudio`...). An alias may carry the
provider's own price. How models get their levels: "Automatic model evaluation" below
(public leaderboards, our own measurement, calibration).

| Step | Rule |
|---|---|
| `available_cards` | Rated cards behind the server models and the user's enabled configurations; unrated models are usable but never recommended |
| `hard_filter` | Modality, requested capabilities, context window, tools 3 needs tool calling |
| `coverage` | Per need: covers (level >= top), covers as described (>= estimate), short |
| `model_status` | covers / covers_as_described / short, with the shortfalls |
| `choose` | Cheapest blended price `(3 x input + output) / 4` among models that cover everything; ties: least excess, calibrated first, id |
| `fallback` | Otherwise the best covering as described, or the least short; always provisional, with a note |
| `extra_rules` | Risk 3: verify with a person. Tools 3: the chat does not run tools |
| `explain` | Text from the coverage: what it covers, where the cheaper one falls short, why not the dearer one |

Local models (Ollama, LM Studio) and `:free` OpenRouter ids cost 0. Cost bands (information
only): low up to 0.50 USD per million tokens, medium up to 5.00, high above. With no rated
model available the illustrative demo cards are used and the result says so.

Several server models per provider: `ADAPTAI_GROQ_MODELS=openai/gpt-oss-20b,openai/gpt-oss-120b`
(and `_OPENAI_`, `_CLAUDE_`, `_OLLAMA_`, `_LMSTUDIO_`). Each is a configuration
`server:<provider>:<model>`; the first keeps `server:<provider>` and runs the analysis.

**Choices and feedback.** Each candidate carries `gap` (−1 covers less than the
recommendation, 0 the recommendation, +1 more than needed); My progress scores agreement as
`max(0, 1 − |gap| / 2)`. Analyses stored with the old tier policy keep their tiers and are
still counted. Feedback per task is stored in `task_outcomes` (no text) and feeds My progress
("Your solved tasks"), the Educator and the Coach. A calibration report (`scripts/calibration_report.py`) proposes
level changes from it (at least 10 tasks, completeness >= 75); it never changes the catalogue.

## Automatic model evaluation (ADR-014 A8 to A12)

Every model someone configured, and only those, is evaluated once by a background worker with
the synthetic suite `measure-suite-1` (adaptive: level 2 first, then 3 or 1; at most 40 calls,
1,024 output tokens each). Results of official cloud endpoints are shared by every user; local
models are evaluated per user. A paid model with a user's key waits for consent that shows
what, how, the estimated cost and a guaranteed maximum. LLM config › "How your models were
evaluated" shows levels, sources, pass rates and example answers; "Disagree" is recorded but
never changes a level. Sources of levels, best first: calibrated catalogue, measured,
provisional catalogue, LMArena per category, Artificial Analysis overall index (confirmed links
only), same family; without any of them a model is never recommended. Each model in the chat
pickers shows its state (Measured, Public ranking, Provisional, Evaluating n/40, Waiting for
consent, Evaluation failed, Not evaluated), and "Evaluate" adds an OpenRouter model without
sending anything.
Details: [`docs/model-classification.md`](docs/model-classification.md); tests and manual
check: [`docs/testing-model-evaluations.md`](docs/testing-model-evaluations.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/evaluations` | The user's models with status, progress, estimate, levels and source |
| POST | `/api/evaluations/{id}/consent` | `{accept, confirm_unknown_price}` for a paid evaluation |
| POST | `/api/evaluations/models` | `{configuration_id, model}`: add a model from OpenRouter's catalogue to be evaluated and recommended (also done on its first use in the chat) |
| DELETE | `/api/evaluations/models?configuration_id=&model=` | Remove a picked model |
| POST | `/api/evaluations/reevaluate` | `{configuration_id}`: a new run (consent again when paid) |
| POST | `/api/evaluations/{id}/disagree` | `{capability}`: recorded for the calibration report |

`ADAPTAI_EVALUATIONS_WORKER=false` turns the worker off (tests and scripts).

**Levels from public sources (ADR-014 A10):** before any measurement, a model gets
provisional levels from the public LMArena leaderboards per category, else from the Artificial
Analysis index; measured levels replace them. The most used models (`most-used.json`) always
have levels; a test enforces it. Models no public source rates are measured in the background
with the project's evaluation-only key (`ADAPTAI_EVALUATION_OPENROUTER_KEY`, see `.env.example`);
`uv run python scripts/project_evaluations.py` shows its progress. Plan, mapping and decisions:
[`docs/plan-model-coverage.md`](docs/plan-model-coverage.md).

Leaderboard data: LMArena (lmarena.ai), CC BY 4.0, dataset
[`lmarena-ai/leaderboard-dataset`](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset).
Benchmark data: Artificial Analysis (https://artificialanalysis.ai/).

## Architecture and limits

`backend/app/models.py` owns domain contracts; `assessment.py` owns the provisional
profile policy and prompt version; `providers.py` implements the provider
boundary; `workflow.py` assembles the explicit assess → match graph; `main.py` exposes
the API. `recommendation.py` compares task needs with the capability cards of
`catalogue.py`, which loads the versioned catalogue in `backend/data/catalogue/`.

By default, task text, task-specific context, provider evidence and free-text explanations are
transient. Explicit conversation-storage consent adds a separate owner-only text record as described below. Saved history contains derived profile values with fixed placeholder evidence,
recommended and compared models, confirmed choices, task feedback, versions, timing and provider metadata.
Titles are generated from session IDs. Manually entered profile preferences are a separate,
explicit account setting. External processing requires consent for the task and enabled memory.
No workflow checkpoints or tracing are configured; LangSmith tracing is disabled
around graph/provider calls.
Provider-side retention follows the selected service's policy. Actual token usage
is returned when supplied, otherwise null; cost stays null until verified pricing
is implemented. Latency is measured locally per analysis.

Tests cover the demo workflow, capability gating, override validation, input privacy,
external consent, adapter structured output, usage metadata, sanitised failures and
timeouts. CI runs the checks above. These checks do not establish assessment accuracy.

Next: the independent evaluation with the labelled task set, calibration of the levels
with the calibration set and real task outcomes, and promotion of develop to main for the
cloud deployment. Autonomous agents are outside the product.

## Database and accounts

The backend uses PostgreSQL through psycopg 3; SQLite is only a source for a one-off
import (below). Start the local database with
`docker compose up -d --wait postgres`; it listens only on `127.0.0.1:55432` and keeps
its data in the `postgres-data` Docker volume. The Compose credentials are for local
development only. `docker compose down` preserves the volume; `down -v` deletes it.

`ADAPTAI_DATABASE_URL` holds the PostgreSQL URL (default
`postgresql://adaptai:adaptai@127.0.0.1:55432/adaptai`). `ADAPTAI_DATABASE_SCHEMA`
defaults to `adaptai`; the application creates and uses this dedicated schema rather
than `public`. The former `ADAPTAI_DATABASE_PATH` is no longer used by the running app.
The schema owner needs CREATE on the database and access to its own schema/tables.

Numbered SQL migrations live in `backend/migrations/`. Startup applies missing
migrations in a transaction under a PostgreSQL advisory lock. Applied files are
checksummed: add a new numbered file instead of editing a published migration.
Unknown newer versions and changed checksums block startup. Optional Prompt Coach
and chat tables remain outside the core migration version and are installed under
the same schema lock. Each operation owns a connection/transaction; source-changing
operations use per-user transaction advisory locks for the coaching freshness check.

For Supabase, put its PostgreSQL connection URL in `ADAPTAI_DATABASE_URL`, with
`sslmode=require`. Use the session pooler for IPv4-only hosts, or the direct URL
when IPv6 is available. Prepared statements are disabled for compatibility with
transaction pooling. Keep `adaptai` out of the Data API's exposed schemas; this
application accesses PostgreSQL through FastAPI, not directly from the browser.
This step does not switch authentication to Supabase Auth.

Passwords use salted scrypt hashes. Only SHA-256 hashes of random login tokens are
stored; login sessions expire after `ADAPTAI_SESSION_DAYS` (default 7). Logout revokes
the current token. Set `ADAPTAI_BROWSER_ORIGIN` to the exact frontend origin (default
`http://127.0.0.1:8443`); cookie-authenticated browser writes from other origins are
rejected. For HTTPS deployment, set `ADAPTAI_COOKIE_SECURE=true`. Add deployment-level
login rate limits before public exposure; email verification and password recovery
are not implemented. Private API responses use `Cache-Control: no-store`.

The app provides account registration and sign-in/out. Assistant focuses on the task and Auto/manual model selection; memory follows Profile settings. My progress preserves the dashboard and contains paginated
metadata history, counts, agreement, JSON export and session deletion. Historical assessment
profiles can be viewed. Original text is available only for analyses recorded after explicit conversation-storage consent; older discarded text cannot be recovered.
Profile & settings replaces the future Team view entry. It manages manually saved preferences,
independent save/use memory toggles, a preview of recent learned metadata and explicit clearing.
There is no shared global history or team aggregation in this increment.
Deleting a session deletes its analyses and decisions from the active database.
Backups retain their own copies; manage their access and retention separately.

Use PostgreSQL/provider backup and restore tools, and back up the matching credential
key separately. A container image or a copy of the old SQLite file is not a backup of
the new PostgreSQL installation.

### Import existing SQLite data

Stop the old backend and keep a consistent SQLite backup and its matching credential
key. The import tool reads a private temporary snapshot without modifying the source,
reports counts by default, and copies
all rows in one transaction only with `--apply`. The PostgreSQL destination must be
empty; any error rolls back all imported rows. IDs, timestamps, insertion order,
sessions, choices, opted-in text, optional module records and ciphertexts are preserved.
The importer verifies that the configured credential key decrypts existing keys before
copying. It never prints task text, passwords or provider credentials.

```powershell
uv run python scripts/migrate_sqlite_to_postgres.py --source backend/data/adaptai.sqlite3
uv run python scripts/migrate_sqlite_to_postgres.py --source backend/data/adaptai.sqlite3 --apply
```

Only SQLite v7 is accepted. For older versions, upgrade a **backup** first using the
legacy tool; v1/v2 content removal is irreversible and requires its explicit flag:

```powershell
uv run python scripts/migrate_privacy.py --database path/to/backup.sqlite3 --remove-legacy-task-content
```

The original SQLite installation is never a runtime fallback. Switch back deliberately
to the older application and its untouched database if needed; new PostgreSQL writes
are not automatically copied back.

### PostgreSQL tests

The backend tests require a real PostgreSQL server (`docker compose up -d --wait postgres`).
They use a unique schema per test and remove only those generated schemas. Set
`ADAPTAI_TEST_DATABASE_URL` for a separate test server; tests never inherit the
application's database URL. CI provisions PostgreSQL for backend, removal-drill and
browser tests. Smoke tools use temporary schemas, and browser tests own a separate
schema. Tests use synthetic records and fake models, not real provider accounts.

On Windows, `./scripts/test_postgres.ps1` runs the same suite in a temporary Linux
container, with the source mounted read-only and dedicated dependency-cache volumes.
This also works when local application-control policies block psycopg's native DLLs.
The local PostgreSQL volume stays running afterwards.

Decisions: [ADR-007](https://docs.google.com/document/d/1nYv2V3qVu7JhkedKD31n-TyjsXwVnYHe5CZAvsG-JfI/edit)
and [ADR-008](https://docs.google.com/document/d/14OXD4V0bvVtcoSMAqIJptNDTzpt6bDBlLk7qlKJZ4BU/edit).

## Git workflow

Follow [GIT_WORKFLOW.md](GIT_WORKFLOW.md): feature branches target `develop`;
protected branches are changed through reviewed pull requests. Code cards are planned
before they are built (cases, plan, approval), and every pull request carries the report in
`.github/pull_request_template.md`; [AGENTS.md](AGENTS.md) has the short version for people
and AI agents.

### Personal context and the progress dashboard

My progress preserves the original chart, pattern cards, learning suggestions and My data layout.
Chart values come from confirmed choices in the last six sessions with decisions.
Capacity comparisons count larger/smaller choices against the illustrative recommendation;
they do not establish model quality. Empty states replace fictional numbers. Prompt inflation
is unassessed without opted-in text. Personalised Groq advice updates automatically when enabled in Profile.

Both account memory flags default to false. `save_enabled` controls whether new analyses and
choices update learned memory; disabling it keeps existing memory. `use_enabled` allows using
preferences and the latest 20 learned metadata entries; the Assistant follows this setting automatically. API clients can explicitly opt out with
`use_personal_context=false`. Derived memory does not retain raw task text; conversation text has a separate opt-in. Metadata used as memory is labelled as
past assessments, not new task requirements. It does not train a model or automatically call Groq.
Preferences (up to 4,000 characters) are saved independently in Profile. The API accepts
`task_context` for additional instructions; it remains transient unless conversation storage is enabled.
Clearing learned memory leaves preferences and progress intact; delete sessions in My progress
to remove their assessments, choices and associated memory. Export contains the account settings,
recent memory and paginated history. Text is present only in explicitly opted-in conversation records.

Schema v3 removes raw requests, task-derived titles, session context and provider free text from
legacy v1/v2 history while preserving IDs, scores and choices. This removal is irreversible in
the active database. Old backups or synced filesystem versions may retain previous content;
they are outside the migration's scope. See [the local privacy decision draft](docs/memory-privacy.md).

## Personal LLM configuration

LLM config sits below Profile. Each authenticated user can create multiple named OpenAI,
Claude, Groq or Ollama model configurations, edit/replace credentials, enable/disable models,
remove configurations and explicitly test connectivity. Saving does
not call a provider. Test connection sends one synthetic assessment and may consume quota.
Model IDs are user-supplied; saved configuration is not evidence of provider access or schema
compatibility. OpenAI configurations expose the existing Responses API switch for compatible
models, including Codex; no subscription or CLI credentials are read.

**Two roles, two rules (ADR-014 A11).** *Analyse* always uses the project's assessor: the
server models that give a strict JSON answer (`GET /api/llm-options` returns it as
`assessment`, with `assessment_chain`), Groq first, then the next server model if the first
hits a rate limit, runs out of credit, times out or is unavailable. The analysis says which
model assessed it ("Task assessed by …", and a note when the next one answered). The JSON is
what lets the app compute completeness, needs and the recommendation, and the same assessor
keeps analyses comparable. *Send* uses the **chat model** picked in the composer: Auto or any
enabled personal or server model, any model that writes text. "Use this model" changes only
the chat model. When a chat answer fails because the model hit a limit, the answer offers
"Send with <project model>"; nothing changes without that click. A model that hit a rate limit
(one hour) or ran out of credit (one day) is not recommended meanwhile and the analysis says
so (`app/limits.py`, per process). Free OpenRouter models are evaluated with the project's
evaluation key when set, so the user's free daily calls stay for their chats. Without a project
assessor (no server Groq, OpenAI or Claude), the chat model analyses as before. If project
Groq is unavailable and nothing else is configured, Auto returns an explicit configuration
error; it never silently selects a personal model or demo. The actual provider, model,
configuration ID and selection mode appear in the result.

**OpenRouter is a catalogue behind one key (ADR-014 A12).** Connecting it needs only the key (a
default model is optional); Test connection checks the key without calling a model. Both chat
pickers show each model's state (Measured, Public ranking, Provisional, Evaluating n/40, Waiting
for consent, Evaluation failed, Not evaluated), and "Evaluate" in the OpenRouter list adds a
model to your models without sending anything. With an OpenRouter key, the analysis also
compares every rated chat model of the catalogue and may show one "Also on OpenRouter"
suggestion: only when it covers what your best model falls short on, or covers as much for
less, and never in a dearer price band than your own models. Intelligent task routing, capability-based routing across these
assessment models and custom endpoints remain future work. Assessment-provider selection is
separate from the versioned catalogue's recommended task-execution tier.

API: `GET/POST /api/llm-configs`, `PUT/DELETE /api/llm-configs/{id}`,
`POST /api/llm-configs/{id}/test`, `GET /api/llm-options`. All require authentication and
private no-store responses. `/api/analyze` accepts `provider: auto` and optional `configuration_id`.
Legacy provider IDs remain supported. External destinations still require explicit consent,
even if Auto selects the destination. Ollama refers to localhost on the backend machine;
API requests cannot specify arbitrary URLs or endpoints.

Personal API keys are encrypted with authenticated [Fernet encryption](https://cryptography.io/en/latest/fernet/)
and bound to the user and configuration IDs. They are never returned by list, edit or test
responses. API responses expose only `has_key`. Leaving a key blank on edit retains it only
when the provider is unchanged; replacing a provider requires its own credential. Ollama
needs no API key in this increment.

The master encryption key comes from the `ADAPTAI_CREDENTIALS_KEY` secret when set.
Otherwise it is created on first credential save at `backend/data/adaptai.credentials.key`,
or at `ADAPTAI_CREDENTIALS_KEY_PATH` when configured. The same key must be preserved
when moving ciphertexts from SQLite to PostgreSQL.
The key file is ignored by Git. Keep it outside cloud sync with user-restricted filesystem
access. Back up the database and matching key securely; losing the key makes stored provider
credentials unusable. A missing key is not silently regenerated when encrypted entries exist.
The database and key together allow decryption; this is local encryption at rest, not protection
from someone with full access to the backend host. Production needs managed secret storage,
access controls, rate limits and HTTPS (`ADAPTAI_COOKIE_SECURE=true`). Automated verification uses mocks; a separate live Groq coaching smoke test is recorded below.

### Provider cards and optional connection dialogs

LLM config presents Groq, Claude, OpenAI/Codex and Ollama as status cards. A native modal
dialog opens for provider details and credentials, with keyboard focus containment, Escape
and Close controls. No model form is shown on the page by default. Personal model creation
is optional. Cards report saved/enabled configuration, not verified live connectivity.
Groq's card displays only the read-only server configuration; its credential remains in
backend settings. The other dialogs show existing personal models, server models if present,
and optional add/edit forms. Ollama needs no API key in the local integration.

The legacy API field `is_default` is retained for compatibility but no longer controls Auto.
Older personal Groq records are not deleted and remain manually selectable through the
Assistant/API. The Groq card itself does not offer personal credential configuration.
My progress still computes dashboard aggregates deterministically from saved metadata.
The dashboard is deterministic; Groq guidance is generated only through its explicit action.

## Progress workflow and coaching

### Automatic suggestions in the dashboard

My progress has no generate/update/retry button for coaching. The Profile setting controls
automatic suggestions; the dashboard shows plain status text for loading, updating, up-to-date,
disabled and unavailable states. With automation disabled, saved guidance remains visible and
the UI directs the user to Profile. No manual coaching POST is issued by the frontend. The
existing consent-gated POST remains available to API clients for compatibility and testing.
Transient/provider errors do not trigger a quota-consuming poll loop: a new analysis or confirmed
choice permits a fresh automatic attempt. Settings and history stay accessible on failure.

### Optional conversation text (schema v7, 30 October 2026)

The user requested an explicit exception to metadata-only retention. Existing accounts and new
accounts keep `conversation_memory_enabled=false`. Enabling the separate Profile switch saves
new user task text, task context and full assessment responses in `conversation_content`; the
numeric analysis record stays sanitised. Consent is re-read after provider completion before
writing text. Old discarded prompts cannot be reconstructed. This is persistence/context reuse,
not model training. It extends the local implementation and does not mark the privacy ADR accepted.

Reusing text requires BOTH `conversation_memory_enabled` and `use_enabled`. The Assistant and
Groq coaching receive at most five recent opted-in excerpts: up to 3,000 characters of task,
500 of context and 1,000 of the assessment profile per excerpt. The current analysis still needs
the normal explicit external-processing action. Automatic Groq calls additionally require
`coaching_auto_enabled`; otherwise coaching is manual. Historical text is treated as untrusted
background, not instructions. Models are instructed not to quote identifying/sensitive material.

Disabling text saving stops new retention and all reuse of existing text; disabling Use memory
also prevents reuse. Both changes invalidate cached coaching so text-derived guidance is not
retained after revocation. An in-flight response is rejected if source content or permissions
change. Existing conversation records remain owner-viewable and deletable. My progress details
and JSON exports include opted-in records; pending-choice cards do not include raw text.
`DELETE /api/context/conversations` removes the owner's saved task/response text and coaching
while preserving numeric history, choices and settings. Session/all-history deletion cascades to
conversation content. Clearing learned numeric memory is separate and does not delete text.
As with other persisted data, exports and backups may retain copies; deletion does not
promise forensic erasure. Database dumps and local credential keys must stay outside Git; text is not placed in browser storage.

Every successful analysis is saved before any tier choice. My progress immediately shows
analysis counts, activity by session, and a paginated list of pending choices. Confirm an
eligible tier in Assistant or directly in My progress to update agreement, over/under-capacity
counts and learned choice metadata. Pending choices are never assumed to match a recommendation.
The chart offers Activity and Recommendation match views. Opening saved history automatically
opens a session; session cards show dates, analysis counts and confirmed-choice counts.

Progress refreshes on entry, window focus, visibility changes, same-origin tab notifications,
explicit Refresh and local confirmations/deletions. Failed analyses no longer create empty
sessions from the frontend. Existing empty legacy sessions can be reviewed/deleted normally.

Analyse itself is the explicit action to send the displayed task to the displayed provider;
the adjacent notice explains the destination and Profile-controlled memory. The checkbox is
removed. API clients still require `allow_external=true` for external destinations. Expected
configuration/provider/model fields prevent an unexpected destination change after rendering.
No change to the underlying external-processing gate is made.

`GET /api/progress/pending` is paginated; `GET /api/progress/activity` returns recent session
counts. `GET /api/progress/coaching` reads the cached report and background-job status. When automatic
coaching is enabled, it also schedules a missing or stale report (for example after a server restart).
`POST /api/progress/coaching` requires `allow_external=true` and the displayed `expected_model`.
It sends only derived score/confidence/modality and tier-choice metadata for the latest 50
analyses to project Groq. Up to five opted-in conversation excerpts are also sent only when
conversation storage and Use memory are both enabled. Saved preferences, task titles and analysis IDs
are excluded from coaching input. Advice uses validated structured output and is saved per account. Freshness is checked
against the metadata fingerprint and model; unchanged reports are reused without another call.
New analyses/choices make a report stale. Upstream failures are sanitised and do not replace
an existing report. A history change during generation rejects the result instead of saving it.

The version-3 coaching contract supplies every pattern explanation/next step and every learning
lesson (title, explanation and practice action), as well as the summary. A shared frontend hook
loads one report for all cards. There are no static coaching lessons or fallback advice; loading,
opt-in and error states are labelled. All-history counters remain computed by the backend;
AI interpretations use up to 50 recent profiles, with that scope shown beside the cards.
The input includes computed sample metrics so pending choices never become matches/overrides.
The prompt distinguishes task requirements from personal ability and does not infer price,
model quality or actual tool usage. With no opted-in text, the backend requires prompting status
`not_assessed`. With text, `possible_pattern` or `no_clear_pattern` may be returned as provisional
AI interpretation of the bounded sample, not a verified quality measure. Existing reports remain stored
but become stale when the coaching contract changes and are replaced on a successful update.

Profile has an independent, initially disabled `coaching_auto_enabled` setting. Enabling it
authorises project Groq to process existing and future derived usage metadata automatically.
Updates run after successful analyses and confirmed choices, outside the response body. Per-user
generation is serialised; fresh reports are reused. Changes during generation are coalesced with
up to three snapshots. A failed snapshot is not retried on every page load or status poll; manual
retry or a new history revision can retry it. Disabling the setting stops future automatic calls
and prevents saving an automatic response that was already in flight. Existing suggestions remain.
The UI polls only while a job is running. Automatic jobs are local-process background tasks,
not a durable queue; a later dashboard read resumes stale work after a restart.

The browser remembers the selected navigation page across refreshes. Only the page identifier
is stored in localStorage; task text, results and credentials are not stored there.

My data exports settings, metadata history and saved coaching as JSON. Delete opens a separate
confirmation before removing all usage history, learned memory and coaching. Account credentials,
personal preferences and LLM configurations remain. Individual-session deletion also invalidates
cached coaching so it cannot retain advice about deleted sessions.

Schema v5 adds the per-user coaching cache; v6 adds the disabled automatic-coaching preference.
Schema v7 adds optional conversation records, the disabled text-storage flag and report source
counts. These migrations do not remove existing data.
Prompt inflation remains unassessed without opted-in text; with text its AI assessment is explicitly provisional. No validated quality comparison exists. Neither agreement nor Groq-generated advice proves model quality.

For an explicit live, quota-consuming smoke test using synthetic metadata only:

```powershell
uv run python scripts/check_coaching.py --live
```

On 29 October 2026 this succeeded with project Groq `openai/gpt-oss-20b`, returning two validated
suggestions for three synthetic records. No real user history was sent during that test.
This establishes integration connectivity and contract compatibility, not coaching accuracy.

30 October 2026: the same synthetic smoke test passed for coaching contract version 2,
returning all three pattern objects and three learning suggestions. No real user history was
used in that smoke test.

The contract-v3 smoke test also passed with `--live --with-conversations`: one synthetic
conversation excerpt yielded all three patterns, three lessons and a provisional
`possible_pattern` prompting status. No real conversation text was used in this smoke test.
