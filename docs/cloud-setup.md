# Cloud setup: Netlify + Render + Supabase

**State on 18 November 2026.** The product is deployed. The `deploy` job of CI published `main`
to Render and Netlify on 7 November 2026 (`e207fd9`) and again with each release to `main`
(11 November, `8d0c92b`; 17 November, `74d6872`), each time after every check passed and the
`/api/health` check answered. Published addresses: frontend `https://adaptai-team2.netlify.app`,
API `https://adaptai-team2-api.onrender.com`. `render.yaml` does not declare
`ADAPTAI_EVALUATION_OPENROUTER_KEY`: without it, the evaluation with the project key
(ADR-014 A10) does not run in production. Owner of the hosting: Francisco Nunes (cloud and
infrastructure).

The free plans have two effects users notice: the Render server sleeps after 15 idle minutes
(the first request then took 38 to 67 seconds on 16 and 17 November), and the Supabase project
pauses after a quiet week. A keep-awake job is in review (#73).

## Services

- Render: [adaptai-team2-api](https://dashboard.render.com/web/srv-dbnm3mmc6qcc73e93vc0),
  ID `srv-dbnm3mmc6qcc73e93vc0`, Free/Frankfurt/Docker, branch `main`, auto-deploy Off
  (CI deploys). Runtime variables for Supabase, Groq, Auth, the frontend origin and Fernet are
  set in the Render dashboard.
- Netlify: [adaptai-team2](https://app.netlify.com/projects/adaptai-team2),
  ID `aebecfdb-e729-4c0c-b3b0-319051d2a181`. Published by the CLI from GitHub Actions; Git
  builds are not used, and the build variables live in GitHub, not in the Netlify dashboard.
- GitHub: the variables and secrets of section 5 are set in the `production` environment.

Do not create another Blueprint on top of the existing service: `render.yaml` keeps the
definition for reproduction, while GitHub Actions points to the IDs above and does no
Blueprint sync.

## 1. Use the existing projects

Use the projects that exist; do not create duplicates. Confirm the Free plan on the three
services. Public URLs may be shared; passwords and tokens stay in the dashboards or in local
files ignored by Git.

## 2. Supabase

1. In Connect, copy the PostgreSQL **Session pooler** connection. Replace the password,
   encoding reserved characters, and add `sslmode=require`. The pooler allows IPv4 without
   buying the IPv4 add-on.
2. Get the Project URL (`https://<ref>.supabase.co`) and the **publishable key** from API
   Keys/Connect. Never use the secret or service_role key in the frontend.
3. In Authentication, keep the Email provider and email confirmation on. In URL
   Configuration, set the Site URL and Redirect URLs to the exact Netlify URL. Add the local
   URL only to test cloud Auth locally.
4. For users outside the Supabase team, configure your own SMTP. The built-in sender only
   serves team members' addresses; sign-up confirmation and password recovery depend on it.
   Do not turn confirmation off to work around email.
5. Do not add `adaptai` to the schemas exposed by the Data API. The frontend only uses
   Supabase Auth; application data is reached by the backend through PostgreSQL.
   As a second barrier, the backend turns on Row Level Security on every table in the schema at
   start-up (`Storage._secure_tables`, after the migrations and each optional module), with no
   policies: the backend connects as the tables' owner and still filters by user in every
   query; any other role that reaches the schema (`anon`, `authenticated`) sees no rows. Do not
   create policies or `FORCE ROW LEVEL SECURITY` without first reviewing the role the backend
   connects as.
   **Check after the first deploy (RLS fails silently):** in the Supabase SQL Editor, run
   `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='adaptai' AND c.relkind IN ('r','p') ORDER BY 1;` — every row must have
   `relrowsecurity = true`. If the backend role does not own the tables, start-up logs an
   error (`Row Level Security is OFF on ...`) and carries on. Once confirmed, set
   `ADAPTAI_REQUIRE_RLS=true` on Render: the backend then refuses to start if any table is
   left without RLS.

The backend applies `backend/migrations/*.sql` at start-up. Do not copy SQL into the dashboard
by hand. Local history is not transferred automatically: agree a controlled import before
creating cloud data. Linking accounts keeps the history already in the target database and
requires the Supabase session and the previous AdaptAI password.

## 3. Render

Web Service / Docker, Free plan, Frankfurt. Repository: Project-Software-Team2. Branch:
`main`. Dockerfile: `backend/Dockerfile`; build context: repository root; health check:
`/api/health`. Do not set Root Directory to `backend`: the Dockerfile also needs the
manifests at the root. Auto-deploy: **Off**.

| Runtime variable | Value |
| --- | --- |
| `ADAPTAI_AUTH_MODE` | `supabase` |
| `ADAPTAI_DATABASE_URL` | Session pooler URL with password and SSL; secret |
| `ADAPTAI_DATABASE_SCHEMA` | `adaptai` |
| `ADAPTAI_REQUIRE_RLS` | `true` only after confirming RLS (see step 5); default `false` |
| `ADAPTAI_SUPABASE_URL` | Project URL |
| `ADAPTAI_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
| `ADAPTAI_SUPABASE_SERVICE_ROLE_KEY` | Optional; secret/service_role key; secret, backend only. Lets "Delete my account" also remove the user from Supabase Auth. Without it, the application data is erased and the user is told their sign-in remains |
| `ADAPTAI_BROWSER_ORIGIN` | Exact HTTPS origin of the frontend, no trailing slash |
| `ADAPTAI_CREDENTIALS_KEY` | Stable Fernet key; secret |
| `ADAPTAI_GROQ_MODEL` | `openai/gpt-oss-20b`, to use the project model |
| `ADAPTAI_GROQ_API_KEY` | Project key, if any; secret |

Without a reachable key and model, demo mode still works, but it is not a semantic AI
assessment. Ollama on a laptop is not reachable from Render; the relay (ADR-015) is the way
to use a model on the user's own computer.

For a new cloud database with no encrypted credentials, generate the Fernet key locally:

```powershell
uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Keep it only in the Render secret. When importing existing encrypted credentials, keep their
key instead of generating a new one.

## 4. Netlify

Build: base `frontend`, command `pnpm build`, publish `dist`, Node 22. `netlify.toml` at the
root holds these values, the SPA fallback and the headers. Never publish the source code or
the root folder.

| Public build variable | Value |
| --- | --- |
| `VITE_AUTH_MODE` | `supabase` |
| `VITE_API_ORIGIN` | Exact HTTPS origin of the Render backend, without `/api` |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key |

Every `VITE_*` variable is public in the JavaScript. Never put a PostgreSQL URL, passwords,
deploy tokens or AI provider keys in them.

With GitHub Actions the build runs on the runner, so these variables must be in GitHub;
setting them in the Netlify dashboard is not enough. Avoid automatic Git builds in parallel
with Actions. The Actions deploy uses the existing site, identified by `NETLIFY_SITE_ID`.

## 5. GitHub Actions

In the `production` environment (or in Settings -> Secrets and variables -> Actions):

| Type | Name | Value |
| --- | --- | --- |
| Variable | `API_ORIGIN` | Backend HTTPS URL |
| Variable | `SUPABASE_URL` | Project URL |
| Variable | `SUPABASE_PUBLISHABLE_KEY` | Public publishable key |
| Variable | `RENDER_SERVICE_ID` | `srv-...` ID of the service |
| Variable | `NETLIFY_SITE_ID` | Netlify project/site ID |
| Secret | `RENDER_API_KEY` | Render API token |
| Secret | `NETLIFY_AUTH_TOKEN` | Netlify deploy token |

The repository variable `CLOUD_DEPLOY_ENABLED=true` turns the deploy job on (it must exist at
repository level, because it gates the job before the environment loads).

`.github/workflows/ci.yml` checks every branch. The deploy job runs only on a **push to
main**, with that variable, after every check passes. It builds the frontend for the cloud,
publishes the tested commit to Render, waits until it is live, checks health, and only then
publishes to Netlify.

## 6. Checks after a deploy

1. The backend `/api/health` answers `{"status":"ok"}`.
2. The frontend opens, confirms an email, signs in, refreshes and signs out.
3. Sessions and history stay per user and survive a new sign-in.
4. Analysis, decision and chat streaming work with the configured model.
5. Frontend requests pass CORS; requests from other origins are refused.
6. Free-plan usage and the start-up time after the Render server sleeps are within limits.

## Connections and latency

FastAPI reuses up to four PostgreSQL connections per process. The pool opens connections as
needed and works with the Supabase Session pooler. Set `ADAPTAI_DATABASE_POOL_SIZE=0` to turn
connection reuse off temporarily during a diagnosis.

With the API awake, compare the response time of the chat list and of **My Progress** in the
browser's Network tab, with the same test account and five repetitions. For **Analyse** and
the chat, use the same synthetic text and the same model each time, and record the time to
the first chat text.

## Official references

- [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase email/SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render Free limits](https://render.com/docs/free)
- [Netlify file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)
- [Netlify deploy CLI](https://cli.netlify.com/commands/deploy/)

Revision: 18 Nov 2026, translated into English and brought to the deployed state; prepared with
AI assistance (Claude, Anthropic) for Ricardo Rodrigues.
