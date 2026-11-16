# ADR-015: A relay for models that run on the user's own machine

Status: Proposed (16 November 2026). A working prototype exists on the local branch
`feature/ide-relay` (from `feature/ide`), so the team can try it before deciding. It changes the
backend core (a migration, the provider layer and two small routes), so it needs the Architecture
Owner's decision, like the token module of ADR-013, and it depends on that module for the client's
sign-in.
Owner: José Moura (author). Deciders: Architecture Owner (Francisco Velhinho) for the
architecture. Baseline: ADR-005 (privacy), ADR-008 (providers), ADR-012 (OpenRouter and LM
Studio), ADR-013 (the extension and personal tokens), ADR-014 (recommendation by task needs).
Prepared with AI assistance (Claude, Anthropic); human review pending.

## Context

A user can run a model on their own computer (LM Studio, Ollama). That works while the backend runs
on the same computer: the backend calls `http://127.0.0.1:1234`. It stops working when the backend
is hosted (Render): the server's `localhost` is the server, not the user's computer, and the
user's router does not let the internet in. Today the address of LM Studio is also a setting of the
whole server (`lmstudio_base_url`), so even a personal LM Studio configuration cannot point
anywhere else. The consequence is two backends: a local one for local models and a hosted one for
everything else, with a different database each time.

The team wants one backend (hosted, on the team's Supabase) and still to use a local model, each
person their own. What does not change: nothing of the user's machine is opened to the internet, and
nobody can use another person's model.

## Decision

**Reverse the direction.** The user's client (the VS Code extension) is already allowed to call the
backend. While the user is signed in and has a model set to run on their computer, the extension
keeps a request open on the backend (`GET /api/relay/next`, up to 10 seconds, repeated). When the
backend needs that model, the request goes down that connection; the extension sends it to LM
Studio on `localhost` and sends the answer back (`POST /api/relay/jobs/{id}/events`).

```
backend (Render) <- the extension asks: "any request for me?"      (outbound, allowed everywhere)
backend (Render) -> the extension:       "run this on your model"   (the request, as LM Studio takes it)
the extension    -> LM Studio on localhost -> the answer
the extension    -> backend (Render):     "here is the answer"       (streamed, in pieces)
```

1. **Where a model runs is a property of the configuration**, not a new provider: `llm_configs.execution`
   is `server` (the default, as before) or `client`, and only an LM Studio configuration may be
   `client`. A configuration without the field behaves exactly as today. (Migration 009.)
2. **The relay is an HTTP transport for the OpenAI client the backend already uses.** The request
   that would have gone to LM Studio is queued for the user's client instead, and the response
   (streamed or not) comes back the same way. Prompts, structured output, validation,
   recommendation and storage are unchanged, and so are the analysis, the Coach, the chat and the
   Educator. The evaluation worker and the connection test use it too, because they build the model
   in the same place.
3. **Only the owner's client can serve a request.** A request is queued for the account that made
   it and handed only to a request of that same account (its session or personal token). Another
   account's client cannot take it or answer it (an answer for a request that is not yours is a
   404). If the owner's client is not connected the request fails at once with
   `relay_unavailable`; it never goes to another user.
4. **The client only does one thing.** It sends `POST /v1/chat/completions` to the address in
   `adaptai.relay.lmStudioUrl`, which must be this computer (`127.0.0.1`, `localhost`, `[::1]`).
   The backend cannot make it call another address, path or method, and the token never reaches LM
   Studio. The backend refuses any other path too.
5. **A request is only trusted to be answered once the client confirms it.** The client confirms a
   request the moment it receives it; if there is no confirmation within 5 seconds (it hung up, or
   the request went to a dead connection) the request goes back to the queue, and after 15 seconds
   in all it fails with `relay_unavailable`.
6. **Limits.** At most 4 requests in flight per user, 1 MB per request, 256 KB per piece of answer,
   4 MB per answer, and the first byte and every piece of the answer within the provider timeout.
7. **No new rule for the levels of a local model.** A local model is already not shared between
   users (`SHARED_PROVIDERS` in `evaluations.py` lists only hosted providers), so a model evaluated
   through the relay never influences another user's recommendations.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Two backends: local for local models, hosted for the rest | Today's state | No code, but two databases and the person must switch address by model |
| A tunnel (ngrok, Cloudflare, Tailscale) to the user's LM Studio | Not adopted | The user's model becomes reachable from the internet; the server would call an address chosen by users (a server-side request forgery risk) and every user has to run the tunnel |
| "Serve on Local Network" in LM Studio | Does not solve it | The address is private (`192.168.x.x`) and the router blocks the internet; it only helps a backend on the same network |
| The extension calls LM Studio itself and sends only the answer | Not adopted | The prompt, the structured output and the validation would have to move to the client; a large change in the core workflow |
| **A relay through the client (this ADR)** | **Proposed** | Reuses the whole backend, opens nothing, works behind any router |

## Consequences

| Area | Consequence |
|---|---|
| Core | A migration (`009`), a small change in `llm_config.py` and `providers.py`, a new module (`relay.py`) and two routes. Every existing path is unchanged when `execution` is `server`. Needs the Architecture Owner's approval |
| Migration order | `009` assumes `008` (tokens). If the relay is merged first, renumber. An older backend refuses a schema that has `009` ("Database schema is newer than this application"), so never point an older build at a schema migrated by this one |
| Privacy | The text already goes to the backend; now it also goes from the backend to the user's own extension and LM Studio. Nothing is opened to the internet and no other person receives it |
| Availability | Works only while VS Code is open, signed in, with the LM Studio server running; otherwise that request fails with a clear message and every other model keeps working |
| Operations | The queue is in memory, for one backend instance (the Free plan has one). More instances need the queue in the database. The open request also keeps a sleeping Render service awake while VS Code is open |
| Cost | A few requests a minute from each connected extension |

## Evidence (16 November 2026)

Windows, VS Code, Node 24, PostgreSQL on the team's Supabase (schema `ide_dev`), LM Studio with a
Gemma model.

| Check | Result |
|---|---|
| Backend relay tests (`test_relay.py`: the setting, ownership, limits, a fake client that streams, a structured call, a client that never answers, a request nobody confirms, a hung-up poll, a connected client's grace period) | 22 passed |
| Extension relay tests (`relay.test.js`: the address rule, the paths and methods, sizes, LM Studio down, an error status, slices of a large answer, stopping LM Studio when the backend forgets the job, a refused sign-in, an old backend, the first request and stopping) and the page's tests for where a model runs | 13 and 4 passed; whole suite 146 passed, 11 skipped without a backend |
| End to end: a backend whose LM Studio address is dead (`127.0.0.1:9`), on Supabase | 14 of 14: on the server the model is unreachable; on the client without the extension it says so at once; with the extension connected the chat answers `PONG` through the real LM Studio, the conversation is kept, both answers are stored as complete, the analysis returns a full profile assessed by LM Studio, the connection test of the model passes, and after the extension stops the request fails with "not available" |
| The same in a real VS Code window, with the extension loaded from the branch | 7 of 7 (activation, status bar, a chat through the relay, stop) |
| Existing backend tests of the touched code (`test_llm_config`, `test_chat*`, `test_providers`, `test_server_models`, `test_evaluations`), run on the Supabase with temporary `test_` schemas | 153 passed |

Not tested, and why it matters: more than one backend instance; the Render Free sleep and wake
cycle with the open request; a relay request while the evaluation worker runs the 40 synthetic
tasks of a client-run model through the user's LM Studio; Ollama (the backend uses its native API,
not the OpenAI one, so only LM Studio can run on the client for now); other platforms and VS Code
versions.

## Open questions

1. Is the Architecture Owner willing to accept the relay in the core (after the token module)?
2. Should the evaluation of a client-run model be on by default? It sends 40 synthetic requests
   through the user's computer.
3. Ollama on the client (it needs the relay to speak Ollama's native API, or to use Ollama's
   OpenAI-compatible endpoint).
4. Where does the queue live when the backend has more than one instance (the database, or a
   broker)?
