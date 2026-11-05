# ADR-012: OpenRouter and LM Studio providers

Status: Proposed (5 November 2026). Waiting for the Architecture Owner's decision after team
review. Owner: José Moura (author). Decider: Architecture Owner (Francisco Velhinho).
Baseline: ADR-004 (model knowledge as data), ADR-005 (metadata only), ADR-007, ADR-008
(multiple LLM providers), ADR-009 (shared analysis core). Related, not decided here: ADR-011
(chat with in-line analysis). The full document, with the evidence and the risks, is
"ADR-012 OpenRouter and LM Studio providers" in Drive, 03-Work / 01-Inception; the documents
that must change because of it are listed in "ADR-012 Proposed document changes". Prepared
with AI assistance (Claude, Anthropic); human review pending.

## Context

The assessment of a task is done by a model reached through a provider adapter (ADR-008).
The project supported OpenAI, Claude, Groq and Ollama; the project default (Auto) is Groq,
whose free tier is limited. The team wants to try many more models, preferably free ones,
and to run a model locally without Ollama. OpenRouter is one OpenAI-compatible API in front
of several hundred free and paid models whose list changes often; LM Studio serves a model
loaded on the user's machine through an OpenAI-compatible local server. A fixed model list
would be out of date at once (same driver as ADR-004).

## Decision

| # | Decision |
|---|---|
| a | `openrouter` and `lmstudio` are added next to the existing providers and reuse the OpenAI-compatible adapter (`ChatOpenAI`) with another base URL. No parallel implementation; existing providers and the Groq Auto default are unchanged. |
| b | The OpenRouter model list is data fetched live from `GET /models` (cache of 5 minutes, `?refresh=true` bypasses it) and normalised. No built-in list, no filter on `:free`. If the call fails the answer is `502 openrouter_catalogue_unavailable`; an old list is never served and no model is substituted. The catalogue is public and is requested without the API key. |
| c | A model is free only when `pricing.prompt` and `pricing.completion` are both zero (and `pricing.request`, if present, is zero). Prices are shown per 1M tokens (per-token price x 1,000,000). A negative or unreadable price is "variable", never free. Paid models stay listed. |
| d | A model is selectable when it takes text, returns text only and supports structured output (`response_format` or `structured_outputs`), because the assessment needs a validated profile. Other models stay listed with the reason and cannot be selected. |
| e | There is no OpenRouter Auto and no project default: Auto in the Assistant is always the project Groq. `openrouter/free` (Free Models Router) is not offered, not accepted and is kept out of the catalogue; the model is always an exact catalogue id the user chose. |
| f | `POST /api/analyze` accepts an optional `model`, for OpenRouter only (`422 model_override_not_supported` otherwise). It must be a selectable catalogue id (`422 model_not_found` / `model_not_compatible`) and is sent unchanged; the model of a personal configuration is checked the same way. A different `expected_model` gives `409 model_configuration_changed`. |
| g | Provider HTTP 402 becomes `provider_insufficient_credits`; 401/403, 404, 429 and timeouts keep their codes. No upstream message or key is returned. |
| h | OpenRouter is configured only by the user: a personal configuration with their own key and model (encrypted as in ADR-008), never a project model, never offered before that, and with no `ADAPTAI_OPENROUTER_*` setting. The key is sent only to `/chat/completions`. The cost of a paid model is therefore always on the user's own key (PD-29, OI-2). LM Studio needs no key; its address `ADAPTAI_LMSTUDIO_BASE_URL` is server configuration and cannot be set by a request. LM Studio is local: not an external destination, no external-processing consent. |
| h3 | OpenRouter **assessment** requests (not the chat) send `provider.require_parameters: true` so that only endpoints that support the strict JSON schema are used; a 404 "No endpoints found" becomes `model_not_compatible`. Live results (5 November 2026, free-tier key): valid JSON for small schemas; with the full profile schema the free router completed about half of the assessments because the models it picks can spend the whole output budget reasoning (`provider_output_truncated`), and explicit free models mostly failed (404 no endpoint, 429, truncation). OpenRouter is **experimental**. |
| i | OpenRouter appears in the model picker only after the user configures it, with a second picker of live catalogue models (search, Free/Paid label, price per 1M tokens, context, loading, error and retry). LM Studio is a tile in LLM config like Ollama. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| A fixed list of free models in the code | Out of date within days; a release for every change. |
| Only ids ending in `:free` | Misses free models without the suffix and hides paid models. |
| OpenRouter as the only provider | One outage or limit stops the product; fails the portability goal of ADR-008. |
| Reuse the Ollama adapter for LM Studio | LM Studio serves the OpenAI-compatible protocol, not Ollama's. |
| Automatic jump to another free model on a rate limit | ADR-008 requires fallback to be explicit and allowed by the data policy, and the README states that no provider is selected silently after a failure. |

## Consequences

| Area | Consequence |
|---|---|
| Privacy | Nothing new is stored (ADR-005 and Product Spec section 8 unchanged). The task text goes to OpenRouter only on Analyse, under the same per-request consent as other external providers; provider terms must be checked before client material is used (OI-2). |
| Free-tier limits | Free models are rate-limited (HTTP 429 expected) and many reasoning models spend the whole output budget before the JSON ends (`provider_output_truncated`), so OpenRouter is never the default: Auto stays the project Groq and OpenRouter is experimental and personal. |
| Cost | Paid models need an explicit decision (PD-29, OI-2). The application never changes a spending limit or buys credit. |
| Chat | The optional chat (ADR-011, merged into `develop`) accepts both providers. For OpenRouter a message may carry the same optional `model`, checked against the catalogue for text chat only, because a chat does not need structured output. ADR-011 stays with its own decision; the chat screen (E3+E4, stacked PRs #32 and #33) reuses the catalogue endpoint and the OpenRouter picker, and sends the chosen id as `model` with Analyse, Send and Retry. |

## Evidence and what is not established (5 November 2026)

Backend 438 tests (chat integration included), browser tests 23 (chat screen included, fake
catalogue), ruff, lock check and build pass; the automated ones use mocks. Live checks with a
free-tier key: the public catalogue loads (452 models, 15 free that day); assessments through the
free router completed about half of the time and the rest were cut off by the output limit;
explicit free models mostly failed (404 no endpoint, 429, truncation). LM Studio (gemma4-12b)
and Groq (gpt-oss-20b) were run live for chat, streaming, Stop, Retry and analyses. Not
established: a reliable assessment through any OpenRouter model, recommendation quality, and
non-author review.
