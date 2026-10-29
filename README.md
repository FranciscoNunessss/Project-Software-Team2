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

## Run locally

From the repository root:

```powershell
uv sync --locked
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
It is **not semantic AI assessment**. The catalogue contains illustrative tiers,
not verified real models. It has no real prices or performance claims.

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
The original progress dashboard uses actual per-session agreement and capacity comparison counts.
My data exports the account's context and paginated session history as a local JSON file.
Groq coaching uses derived metadata, on request or automatically when enabled in Profile. Prompt-quality detection and team aggregation remain unimplemented.
Production reverse proxy and deployment are not configured.

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
| `ollama` | `ADAPTAI_OLLAMA_MODEL` | Local runtime |

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
analysis. This consent also applies to Claude. There is no automatic cross-provider
fallback or retry. Timeouts default
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
The live test and UI still use the illustrative recommendation catalogue; a successful
LLM call does not validate ranking quality. That smoke test predates the seven-dimension
profile contract; provider compatibility with `profile-2` has not been verified live.

Live verification on 21 October 2026 succeeded with Groq's `openai/gpt-oss-20b`:
the API returned a validated semantic assessment with actual token usage. The supplied
frontend was tested through its development proxy, including external-processing
consent, displaying the assessment and confirming an alternative tier. One initial
request was rejected by the provider; subsequent requests succeeded. This is a local
integration smoke test, not a reliability benchmark or an assessment-quality evaluation.

Assessment providers and recommended catalogue entries are separate concepts.
The LLM assesses the task; Python filters and ranks catalogue entries. It does not
execute the task or generate catalogue facts.

## API contract for the team frontend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Process health |
| `GET /api/progress` | Current user session, analysis, choice and match counts |
| `GET /api/progress/dashboard` | Last six sessions with choices and capacity comparison counts |
| `GET /api/context`, `PUT /api/context` | Read/save account preferences and memory settings |
| `DELETE /api/context/memory` | Clear learned metadata memory without deleting progress |
| `GET /api/providers` | Provider IDs, availability and external destination flag |
| `GET /api/catalogue` | Versioned illustrative catalogue and provenance |
| `POST /api/analyze` | Profile, recommendation, alternatives, reasons and versions |
| `POST /api/decisions` | Persist `analysis_id` and eligible `candidate_id` for the signed-in owner |
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
`backend/tests/fixtures/`). Each response carries `rubric_version`, and
`GET /api/rubric` returns the dimensions, definitions and levels (never tips or
Prompt Coach focus). To change the rubric, add a new version file, register its hash,
point `ACTIVE` at it and run the core eval; never edit a registered file.
`uv run python scripts/render_rubric.py` prints the active rubric as Markdown.

## Seven-dimension prototype

The response identifies `profile_version: profile-2`, `policy_version: prototype-3` and `rubric_version`; re-analyses that send `previous_analysis_id` also return `completeness` and `changes`.
This changes scalar profile fields into objects: read `profile.reasoning.score`,
`.confidence` and `.evidence`. Backend, frontend and test fixtures must migrate together.
The assessor instructions are generated from the active rubric version (see "Rubric").

Ranking uses reasoning/context for provisional capacity and derives hard modality
requirements before capability filtering. Risk, domain, ambiguity and tool need do
not automatically imply a larger model. They inform guidance and clarification instead.
Unknown requirements or low confidence mark the result provisional. The current
illustrative catalogue cannot satisfy audio/video requirements or verify tool support.
This policy is experimental and awaits team/AO review and independent task evaluation.
The contract tests run in CI; human quality evals and their regression gate remain outstanding.

## Architecture and limits

`backend/app/models.py` owns domain contracts; `assessment.py` owns the provisional
profile policy and prompt version; `providers.py` implements the provider
boundary; `workflow.py` assembles the explicit assess → match graph; `main.py` exposes
the API. Ranking favours sufficient capacity, then the closest tier, after hard
capability filtering. `backend/data/catalogue.json` records version and provenance.

By default, task text, task-specific context, provider evidence and free-text explanations are
transient. Explicit conversation-storage consent adds a separate owner-only text record as described below. Saved history contains derived profile values with fixed placeholder evidence,
recommended/eligible tiers, confirmed choices, versions, timing and provider metadata.
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

Next: validate real providers with agreed models/access,
replace catalogue fixtures with sourced data, and calibrate against human-reviewed
tasks. Deployment, trend analytics, streaming, automatic fallback and autonomous
agents are outside this increment.

## Database and accounts

The default database is `backend/data/adaptai.sqlite3`; it is created automatically
with schema version 7 (legacy databases with sessions require explicit privacy migration) and is ignored by Git, including WAL/SHM files. Configure an
absolute `ADAPTAI_DATABASE_PATH` when running from another directory. No additional
database server or dependency is required. SQLite enforces foreign keys, uses WAL
and short transactions, and persists independently of application workers. Use a
local persistent disk; a database on ephemeral storage will disappear on redeploy.
Avoid putting the live database on a network or cloud-synchronised filesystem;
for this OneDrive checkout, set the path to an unsynchronised local data directory.

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

To back up, stop all backend workers and copy the database file to protected storage,
then restart. To restore, stop all workers and restore the backup to the configured
path, then restart. Do not copy just the main file while writers are active in WAL mode.
Non-destructive schema migrations run on startup; legacy text removal requires
`uv run python scripts/migrate_privacy.py --remove-legacy-task-content` with backend workers stopped; newer unknown schema versions fail
explicitly. Back up before deploying future migrations. PostgreSQL and cross-host
database deployment are not configured in this increment.

Decisions: [ADR-007](https://docs.google.com/document/d/1nYv2V3qVu7JhkedKD31n-TyjsXwVnYHe5CZAvsG-JfI/edit)
and [ADR-008](https://docs.google.com/document/d/14OXD4V0bvVtcoSMAqIJptNDTzpt6bDBlLk7qlKJZ4BU/edit).

## Git workflow

Follow [GIT_WORKFLOW.md](GIT_WORKFLOW.md): feature branches target `develop`;
protected branches are changed through reviewed pull requests.

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

The Assistant offers Auto or an enabled personal/server model. Auto always selects the
project's server Groq configuration. Optional personal models are selected manually and do
not replace the project default. If project Groq is unavailable, Auto returns an explicit
configuration error; it never silently selects a personal model or demo.
The actual provider, model, configuration ID and selection mode appear in the result. Failures
never trigger silent fallback. Intelligent task routing, capability-based routing across these
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

The master encryption key is created on the first credential save at the database path with
suffix `.credentials.key`, or at `ADAPTAI_CREDENTIALS_KEY_PATH` when explicitly configured.
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
As with other SQLite data, exports/backups/OneDrive versions may retain copies; deletion does not
promise forensic erasure. The database is ignored by Git; text is not placed in browser storage.

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
