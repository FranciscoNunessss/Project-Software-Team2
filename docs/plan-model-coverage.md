# Plan: levels for every OpenRouter model, free and at once (ADR-014 A10, PROPOSED)

Status: **proposed, not implemented**. Needs the AO's confirmation of A10 and the three
decisions in "Decisions needed". Written 8 November 2026.

## The problem

Today a model gets levels only when someone configures it and the worker measures it
(A8): 40 calls per model, and with a user's key that is the user's money. The OpenRouter
catalogue has about 460 models; a user with an OpenRouter key can pick any of them in the
chat, but a model nobody evaluated is never recommended. Measuring all of them ourselves
would cost hundreds of thousands of calls.

## What was checked, and how (8 November 2026)

The sandbox cannot reach Hugging Face, so the check ran in GitHub Actions: workflow
"LMArena probe" (`.github/workflows/lmarena-probe.yml`, script `scripts/probe_lmarena.py`,
report `backend/data/catalogue/sources/lmarena-probe.json` on branch `data/lmarena-probe`).

| Question | Answer from the probe |
|---|---|
| Free? | Yes. Public dataset `lmarena-ai/leaderboard-dataset` on Hugging Face, downloaded with no account and no key |
| Gated or private? | `gated: false`, `private: false` |
| Licence | CC BY 4.0: free use, including commercial, **with attribution** |
| Immediate? | Yes. The `text` leaderboard is one parquet file of 0.6 MB (11,139 rows); the download and parse take seconds |
| How fresh? | Dataset modified 7 Nov 2026; text leaderboard published 6 Nov 2026; agent leaderboard 4 Nov 2026 |
| Models | 419 in `text` and `text_style_control`, 188 in `text_factuality`, 58 in `agent` and `agent_tool_hallucination` |
| Categories in `text` | `overall`, `hard_prompts`, `expert` (369 models), `math` (404), `coding`, `instruction_following`, `longer_query` (397), `multi_turn`, `creative_writing`, 9 `industry_*`, 10 languages, `exclude_ties` |
| Columns | `model_name, organization, license, rating, rating_lower, rating_upper, variance, vote_count, rank, category, leaderboard_publish_date` (agent subsets use `score`, `score_ci_lower/upper`, `session_count`) |
| Our models | `gpt-oss-20b`, `gpt-oss-120b`, `Gemma 4 31B`, `Gemma 4 26B A4B`, Claude Sonnet and Opus versions are there |
| Coverage of OpenRouter | Automatic name matching links **220 of the 459 OpenRouter ids** (48%), but only **2 of the 12 `:free` ids** |

So "free and immediate" holds, with three caveats that shape the plan:

1. **Half, not all.** About half of OpenRouter is covered; small, old, niche and most free
   models are not. The other layers exist for those.
2. **It is a public ranking, not our measurement.** Arena ratings are people's preferences
   between two answers in a chat. They say little about tool calls and nothing about our
   own tasks. So they are `provisional`, below our measured levels.
3. **Attribution is a licence condition**, not a courtesy: every level from it shows the
   source, and the README credits it.

## The layers

Each layer covers the models the layers above it miss. A model takes its levels from the
best source that has it (order in A10 below). Layers 1, 2 and 4 cost nothing.

| Layer | Source | Covers | Cost | When it updates |
|---|---|---|---|---|
| 1 | LMArena, per category | ~220 OpenRouter ids, and the same models at other providers | 0 | Weekly snapshot, reviewed in a PR |
| 2 | Artificial Analysis, overall index (exists, A9) | Models AA rates that LMArena does not | 0 (free key, 100 requests a day) | With the catalogue sources |
| 3 | Our measurement, `measure-suite-1` (exists, A8) | Models no public source has: `:free` models, local models, new releases | 0 for free models; paid only with a budget or consent | Background worker |
| 4 | Feedback and calibration (exists, D9 to D11) | Corrects all of the above where users disagree or tasks fail | 0 | Calibration report, new catalogue version |
| 5 | Use: recommend among all rated OpenRouter models | Users with an OpenRouter key | 0 | At each analysis |

### Layer 1: LMArena per category (new)

| Step | What | Where |
|---|---|---|
| 1.1 Snapshot | Weekly workflow "Catalogue sources" also downloads `text_style_control/latest`, `text_factuality/latest` and `agent/latest`, keeps only the columns above and the categories we map, and writes `sources/lmarena-<publish date>.json` with the licence and publish date. On a `data/**` branch it commits the file for review | `scripts/snapshot_lmarena.py`, `.github/workflows/catalogue-sources.yml` |
| 1.2 Name links | The normaliser of the probe (no vendor prefix, no `:variant`, no bracketed variant such as `(High)` or `(20250514)`, `.` `_` and spaces as `-`, no date or `-it`/`-instruct` suffix) proposes links from arena names to OpenRouter ids and to the providers' ids in our catalogue aliases. Exact matches are written with `method: normalised`; an arena name that matches two different OpenRouter models (`deepseek-v3.2` and `deepseek-v3.2-exp`) is a **collision** and is not used until a person resolves it in the PR | `scripts/link_lmarena.py`, `backend/data/catalogue/arena-aliases.json` |
| 1.3 Variants | Several arena entries for one model (`(High)`, `(Max)`, `(Thinking)`) count as one model with the **lowest** rating: OpenRouter calls the default effort, and a lower level is the safe error | `classification.arena_levels` |
| 1.4 Mapping `arena-mapping-1` | One category (or two, averaged as percentiles) per capability, see the table below | `backend/data/catalogue/arena-mapping-1.json` |
| 1.5 Thresholds | Per category, the 34th and 67th percentile of the ratings of the **models available on OpenRouter** in the first snapshot (not of all 419, which include 2023 models that would inflate every level), frozen as absolute ratings in `arena-mapping-1`, like A3 | same file |
| 1.6 Confidence | A rating counts only with at least 300 votes and an interval (`rating_upper - rating_lower`) of at most 60 points; otherwise that capability falls to the next category in the table, and then to the next source | `classification.arena_levels` |
| 1.7 Source in `Ratings` | `Ratings.source` gets an `arena` step after the catalogue's provisional levels and before Artificial Analysis. Each rating: `status: provisional`, `source: "LMArena text (style control) 2026-11-06: math 1412, hard prompts 1398 (CC BY 4.0)"`, `observed_on` = the publish date | `backend/app/evaluations.py` |
| 1.8 A model leaves the leaderboard | It keeps the levels of the last snapshot that had it, with that date; after 180 days they are dropped | `snapshot_lmarena.py` keeps the previous file |

**Mapping `arena-mapping-1`** (subset `text_style_control`, which discounts answer length
and formatting, so a verbose model does not look stronger):

| Capability | Category, in order | Why |
|---|---|---|
| reasoning | average percentile of `math` and `hard_prompts` | Hard prompts are the top fifth by difficulty; math is the purest reasoning signal |
| context | `longer_query` | Long prompts; the context window itself stays a fact and a hard filter |
| domain | `expert`, then `hard_prompts` | Expert is the hardest, specialist prompts |
| reliability | `text_factuality` subset `overall`, then `instruction_following` | Factuality is the closest to "does not invent"; following instructions is the next best |
| tools | `agent` subset `overall`, then: level 1 if OpenRouter says the model has no `tools` parameter, else the `overall` level capped at 2 | Only 58 models have agent data; without it we do not claim level 3 for tools |

### Layer 2: Artificial Analysis for the gaps (exists, small change)

Kept as it is (A9). The only change: `scripts/link_lmarena.py` also proposes AA name links
with the same normaliser into `aa-aliases.json`, still confirmed by a person.

### Layer 3: our measurement in the background (exists, needs decisions)

The worker (A8) today measures only configured models. With a **project OpenRouter key**
on the server, used only for evaluation, it also measures, without anyone configuring them:

1. every `:free` OpenRouter model no public source covers (10 of 12 today), at no cost;
2. the server models (already);
3. with the budget, the paid models users pick most that no public source covers.

A run stops at its guaranteed maximum (40 calls, 1,024 output tokens each). The project's
monthly spend stops at the budget. The free models have daily request limits on OpenRouter;
how many free models a day we can measure depends on them (to confirm on openrouter.ai
before implementing).

### Layer 4: feedback and calibration (exists, small change)

`scripts/calibration_report.py` groups outcomes and disagreements by **source** as well
(`calibrated`, `measured`, `provisional`, `arena`, `benchmark`, `family`). If arena levels
predict outcomes worse than measured ones, the report shows it and the team can change the
mapping (a new `arena-mapping-2`) or measure those models.

### Layer 5: recommend among all rated OpenRouter models (new)

Today the recommendation compares only the models the user has (configured or picked). For a
user with an enabled OpenRouter configuration, `send_options` also adds every OpenRouter
model with levels from any source, marked `suggested`. The rules:

| Rule | Why |
|---|---|
| The recommendation stays among the user's own models; a suggested model appears as "Also on OpenRouter: X covers this task better" only if it covers a need the best own model falls short on, or costs less for the same coverage | The user's choice of models is respected; the suggestion has to earn its place |
| At most one suggestion per analysis | Not a catalogue to browse |
| "Use" selects it in the chat, like a pick (and adds it to `user_models`, A8) | One click, and it then counts as one of their models |
| Paid suggestions show the price band; a model above the user's highest current band is not suggested | No surprise costs |

## A10, the order of sources (replaces A9's list)

Best first: the team's calibrated levels; our measured levels; the catalogue's provisional
levels; **LMArena per category** (confirmed or exact-normalised links, no collisions);
Artificial Analysis overall index (confirmed links); the lowest measured level of the same
family; else the model is never recommended. Every level shows its source and date.

## Tests

| Layer | Test |
|---|---|
| 1 | `snapshot_lmarena` on a small fixture parquet: keeps the columns, licence and date; rejects a gated or empty dataset |
| 1 | Normaliser: the probe's examples (`Claude Haiku 4.5 (20251001)` = `anthropic/claude-haiku-4.5`, `Gemma 4 31B` = `google/gemma-4-31b-it:free`, `gpt-oss-20b` = `openai/gpt-oss-20b`); collisions are reported and not used |
| 1 | Variants take the lowest rating; a row under 300 votes or wider than 60 points falls to the next category |
| 1 | Thresholds are read from `arena-mapping-1`, never recomputed at run time |
| 1 | `Ratings.source`: measured beats arena; arena beats AA; source text carries "CC BY 4.0" and the date |
| 1 | A model missing from the new snapshot keeps the previous levels and date |
| 3 | The worker with a project key queues free models without consent and paid ones only under the budget; the budget stops it |
| 4 | Calibration report groups by source |
| 5 | Suggested models only for users with an OpenRouter configuration; at most one; never above the user's highest band; "Use" adds it to `user_models` |
| E2E | An analysis with only an OpenRouter key recommends among the user's models and shows one suggestion with its source |

## Order of work

| Pull request | Content | Depends on |
|---|---|---|
| A | Layer 1 (steps 1.1 to 1.8), A10 in `Ratings`, Layer 4 grouping, docs | AO confirms A10 |
| B | Layer 5 | A |
| C | Layer 3 with the project key and budget | Decisions 1 to 3 below |
| D | Layer 2 link suggestions | A |

## Decisions needed

| # | Decision | Proposal |
|---|---|---|
| 1 | A project OpenRouter key on the server, used only for evaluation | Yes, as a GitHub and server secret, never shown to users |
| 2 | Monthly budget for paid evaluations with the project key | 5 USD |
| 3 | Buying OpenRouter credit to raise the free models' daily limit | 10 USD once, if the limits make Layer 3 too slow |
| 4 | Subset `text_style_control` rather than `text` | Yes (discounts length and formatting) |

## Risks

| Risk | Mitigation |
|---|---|
| A wrong name link gives a model another model's levels | Exact normalised match only; collisions excluded; the PR shows every new link |
| Human preference is not capability (tools especially) | Provisional status, below measured; tools capped at 2 without agent data; calibration by source |
| The dataset's format or licence changes | The snapshot script checks columns and licence and fails the workflow instead of writing |
| Many models change level each week | Thresholds are frozen; weekly changes come only from ratings and are reviewed in the PR |
