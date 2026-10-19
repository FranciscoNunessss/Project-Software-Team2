# AdaptAI

First backend increment: task → complexity profile → capability filtering → explained
recommendation → user selection or override. Python 3.12, uv, FastAPI, LangChain and
an explicit LangGraph workflow. The team's React mock retains its design and its
Assistant screen now calls the backend. Progress and team screens remain labelled design previews.

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
uv run python -m ruff check backend
uv run python -m ruff format --check backend

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
needed for demonstration mode. Example request to `POST /api/analyze`:

```json
{
  "task": "Compare two API designs and explain their trade-offs",
  "provider": "demo",
  "required_capabilities": ["text", "code"],
  "allow_external": false
}
```

The demo uses word count as an unvalidated size proxy, with provisional ambiguity.
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
and confirms eligible selections. Scores use the backend's 1–3 scale, not the mock's
invented percentages; the four remaining dimensions are explicitly unimplemented.
Document uploads, persistent progress, privacy controls and team aggregation remain
design previews. Production reverse proxy and deployment are not configured.

## Configure assessment providers

Copy `.env.example` to `.env` in the repository root. Keep credentials out of Git.
Set `ADAPTAI_OPENAI_MODEL` and `ADAPTAI_OPENAI_API_KEY` to enable OpenAI, or
`ADAPTAI_OLLAMA_MODEL` to enable a model already installed in a running local
Ollama service at `127.0.0.1:11434`. Restart after changing configuration.
Choose a model that supports structured output. Arbitrary OpenAI-compatible
endpoints are not implemented in this increment.

`GET /api/providers` lists configuration availability, not verified connectivity or
model compatibility. Calling OpenAI also requires `allow_external: true` for each
analysis. There is no automatic cross-provider fallback or retry. Timeouts default
to 30 seconds. Provider errors return sanitised codes, never upstream messages.
The adapters have **not yet been verified against real services**; tests use fakes
and incur no API charges.

Assessment providers and recommended catalogue entries are separate concepts.
The LLM assesses the task; Python filters and ranks catalogue entries. It does not
execute the task or generate catalogue facts.

## API contract for the team frontend

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Process health |
| `GET /api/providers` | Provider IDs, availability and external destination flag |
| `GET /api/catalogue` | Versioned illustrative catalogue and provenance |
| `POST /api/analyze` | Profile, recommendation, alternatives, reasons and versions |
| `POST /api/decisions` | Acknowledge `analysis_id` and eligible `candidate_id` |

The generated `/openapi.json` specifies request and analysis response schemas. Tasks
must be nonblank and at most 8,000 characters. Required capabilities can be `text`,
`code`, and `vision`; these describe catalogue requirements, **not uploaded inputs**.
Only text inputs are supported. Unknown fields and capabilities are rejected.

For selection, use the analysis response's `id` as `analysis_id`. Acknowledgement is
transient and consumes the analysis ID. Only candidate IDs for the latest 256 analyses
are retained in process memory. No decisions or raw tasks are persisted. Restarting
clears this state; run one local worker for this prototype.

Errors include unconfigured provider (409), external consent required (403), invalid
input (422), provider timeout/authentication/rate limit/invalid output (502), and
unknown or consumed analysis (404). The frontend should let the user explicitly
retry or choose another provider. The supplied frontend uses a development proxy for
`/api`; production origins and deployment remain to be agreed.

## Architecture and limits

`backend/app/models.py` owns domain contracts; `providers.py` implements the provider
boundary; `workflow.py` assembles the explicit assess → match graph; `main.py` exposes
the API. Ranking favours sufficient capacity, then the closest tier, after hard
capability filtering. `backend/data/catalogue.json` records version and provenance.

Raw tasks exist transiently during a request. No checkpoints, prompt logs or tracing
are configured; LangSmith tracing is disabled around graph/provider calls.
Provider-side retention follows the selected service's policy. Actual token usage
is returned when supplied, otherwise null; cost stays null until verified pricing
is implemented. Latency is measured locally per analysis.

Tests cover the demo workflow, capability gating, override validation, input privacy,
external consent, adapter structured output, usage metadata, sanitised failures and
timeouts. CI runs the checks above. These checks do not establish assessment accuracy.

Next: validate real providers with agreed models/access,
replace catalogue fixtures with sourced data, and calibrate against human-reviewed
tasks. Authentication, persistent feedback, deployment, streaming, automatic fallback
and autonomous agents are outside this increment.

Decisions: [ADR-007](https://docs.google.com/document/d/1nYv2V3qVu7JhkedKD31n-TyjsXwVnYHe5CZAvsG-JfI/edit)
and [ADR-008](https://docs.google.com/document/d/14OXD4V0bvVtcoSMAqIJptNDTzpt6bDBlLk7qlKJZ4BU/edit).

## Git workflow

Follow [GIT_WORKFLOW.md](GIT_WORKFLOW.md): feature branches target `develop`;
protected branches are changed through reviewed pull requests.
