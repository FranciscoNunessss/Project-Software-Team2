# Cloud hosting plan

7 November 2026. Deployment recommendation for review; no cloud resources have been
created and no paid plan has been authorised. The user selected Supabase Auth plus
PostgreSQL. Authentication integration is implemented and backend tests pass;
cloud deployment and real-provider acceptance checks remain pending.
See [Cloud setup](cloud-setup.md) for the current deployment instructions.

## Recommended initial topology

| Component | Service | Responsibility |
| --- | --- | --- |
| React | Netlify Free | Serve the compiled frontend over HTTPS. |
| FastAPI | One Render Web Service, Free, using the backend Dockerfile | Run analysis, recommendation, chat streaming, coaching and application authorisation. |
| Identity | Supabase Auth, Free | Registration, sign-in and identity/session management, after integration. |
| Persistence | Supabase PostgreSQL, Free | Store application data in the dedicated `adaptai` schema. |

Prefer Frankfurt for the backend and a nearby EU region for Supabase, subject to
availability when creating the projects. The frontend is served through a CDN.
Use provider subdomains initially; a purchased domain is not needed for this design.

The frontend and backend have separate HTTPS origins. The planned Supabase Auth
integration must send an access token to FastAPI, which verifies it and resolves the
account before accessing its data. Configure CORS for the exact frontend origin.
The database URL, provider API keys and credential-encryption key remain backend secrets.

Local mode retains cookie-based login and relative `/api` URLs through Nginx.
Cloud mode now uses Supabase Auth bearer tokens, configurable API origin and exact
origin CORS. Backend token validation and history linkage have automated coverage;
real-project refresh/sign-out, account/history linkage and browser SSE still need acceptance checks. Supabase
Auth does not automatically create organisation memberships or application permissions.

## Why this recommendation

The budget constraint is free hosting within provider quotas. A static frontend does
not consume an additional running web-service instance. Render Free services share
750 instance-hours per workspace/month and cannot receive private-network traffic.
Consequently the two Docker containers linked by private DNS in local Compose are
not a directly transferable Render Free topology.

The local Compose stack remains useful and unchanged: Nginx frontend, FastAPI and
local PostgreSQL. A static cloud frontend uses the same React build without running
the frontend Nginx container in the cloud. The backend remains containerised.

## Railway alternative

Railway supports Dockerfiles and frontend/backend services in one project, including
private networking. It is a viable option if the budget or available credits change.
The Free plan currently includes $1 of credit per month. Trial accounts receive a
one-time $5 grant; the Hobby plan is $5/month with $5 usage included. Neither the
trial nor that small free allowance establishes a sustainable budget for two running
services. No paid subscription should be assumed from this proposal.

## Limits and deployment requirements

- Render Free sleeps after 15 minutes without incoming traffic and may take about a
  minute to wake. Its filesystem is ephemeral. Use `ADAPTAI_CREDENTIALS_KEY` as a
  persistent platform secret rather than generating a key on that filesystem.
- Supabase Free currently includes a 500 MB database and pauses inactive projects
  after a week. Define backup/export arrangements before relying on cloud data.
- Free quotas also cover bandwidth/build usage; this is an academic deployment, not
  evidence of capacity for 100+ concurrent users or an availability guarantee.
- Local Ollama/LM Studio on a developer laptop are not automatically reachable from
  the hosted backend. Configure only model destinations actually accessible there.
- Keep hosted auto-deploy disabled while services are prepared. The eventual deploy
  must be gated by successful checks on `main`; pushes to feature/develop validate only.
- Decide and test migration/linking of existing accounts before switching identity.
  Do not silently recreate users or transfer ownership by an unverified email claim.

## Next implementation steps

1. Identify/configure the existing Supabase, Netlify and Render projects.
2. Configure cloud secrets, Auth email delivery and exact frontend/API origins.
3. Publish the feature through develop to main and validate the cloud services.
4. Enable the prepared gated deployment job after the cloud settings are complete.
5. Reconcile the architecture/privacy documentation and ADRs with the final design.

## Official sources checked

- [Render Free limits](https://render.com/docs/free)
- [Render Static Sites](https://render.com/docs/static-sites)
- [Render Docker web services](https://render.com/docs/web-services)
- [Render regions](https://render.com/docs/regions)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Railway plans](https://docs.railway.com/pricing/plans)
- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
