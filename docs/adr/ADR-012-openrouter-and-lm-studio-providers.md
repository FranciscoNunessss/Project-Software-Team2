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
| e | Auto is the identifier `openrouter/free` (Free Models Router) and is not repeated in the list; manual choice is any selectable catalogue model. |
| f | `POST /api/analyze` accepts an optional `model`, for OpenRouter only (`422 model_override_not_supported` otherwise). It must be `openrouter/free` or a selectable catalogue id (`422 model_not_found` / `model_not_compatible`) and is sent unchanged. A different `expected_model` gives `409 model_configuration_changed`. |
| g | Provider HTTP 402 becomes `provider_insufficient_credits`; 401/403, 404, 429 and timeouts keep their codes. No upstream message or key is returned. |
| h | The key is `ADAPTAI_OPENROUTER_API_KEY` (or a personal configuration encrypted as in ADR-008) and is sent only to `/chat/completions`. LM Studio needs no key; its address `ADAPTAI_LMSTUDIO_BASE_URL` is server configuration and cannot be set by a request. LM Studio is local: not an external destination, no external-processing consent. |
| i | OpenRouter appears in the model picker and in LLM config, with a second picker (Auto, search, Free/Paid label, price per 1M tokens, context, loading, error and retry). LM Studio is a tile in LLM config like Ollama. |

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
| Free-tier limits | Free models are rate-limited (HTTP 429 expected) and the router may pick a model that breaks the JSON schema; `openrouter/free` is not a safe default for the assessment, so Groq stays the default. |
| Cost | Paid models need an explicit decision (PD-29, OI-2). The application never changes a spending limit or buys credit. |
| Chat | ADR-011 decides whether the chat reuses the catalogue endpoint and picker. |

## Evidence and what is not established (5 November 2026)

Backend 404 tests, browser tests 15 (fake catalogue), ruff, lock check and build pass; all with
mocks. The live public catalogue held 452 models, 16 with zero price, 8 of them usable for the
assessment besides the router. Not established: a successful live assessment with any
OpenRouter model (two attempts with `openrouter/free` failed, cause not diagnosed), strict
JSON-schema output against real OpenRouter models, any LM Studio run, recommendation quality,
and non-author review.
