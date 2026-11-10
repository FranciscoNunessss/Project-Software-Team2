# Levels for every model, free and at once (ADR-014 A10)

Status (8 November 2026): **layers 1 to 4 implemented**; layer 5 is the next pull request.
The project's evaluation key exists (no bought credit). The AO confirms A10.

## The problem

Before A10 a model got levels only after someone configured it and the worker measured it
(A8): 40 calls per model, paid by the user for paid models. The OpenRouter catalogue has
about 460 models; one nobody evaluated was never recommended. Measuring all of them would
cost hundreds of thousands of calls.

## The answer in one table

Each layer covers the models the layers above miss. A model takes its levels from the best
source that has it; every level shows its source and date.

| Layer | Source | Covers | Cost | State |
|---|---|---|---|---|
| 1 | LMArena, per category (public, CC BY 4.0) | 213 of 459 OpenRouter ids, and the same models at Groq, Anthropic and OpenAI | 0 | Implemented |
| 2 | Artificial Analysis overall index (A9) | Models LMArena lacks, by checked links | 0 (free key) | Implemented: 14 more OpenRouter ids |
| 3 | Our measurement, `measure-suite-1` (A8) | Every model someone configures or picks (their key, consent for paid ones); with the project key, the most used and the free models no public source has | 0 for free models | Implemented |
| 4 | Feedback and calibration | Corrects any source; the report shows outcomes per source | 0 | Implemented |
| 5 | One suggestion among all rated OpenRouter models | Users with an OpenRouter key | 0 | Next pull request |

**Order of sources (A10):** the team's calibrated levels; our measured levels; the
catalogue's provisional levels; **LMArena per category**; Artificial Analysis overall index;
the lowest measured level of the same family; else never recommended.

## Guarantee: the most used models are always rated

`backend/data/catalogue/most-used.json` lists the most used models in the world: OpenRouter's
top 15 by tokens (rankings of the week from 24 October and of 6 November 2026), the flagship
of each main developer (OpenAI, Anthropic, Google, xAI, Meta, DeepSeek, Mistral, Alibaba,
Moonshot, Z.ai) and AdaptAI's server models. The test `test_most_used_models_have_levels`
fails if any of them has no levels, so CI blocks a change that would drop one.

Result on 8 November 2026: **26 of 26 rated** (22 by LMArena, 4 by Artificial Analysis).
Two models in OpenRouter's top 10 have no public source and are listed under
`no_public_source` with the reason: `stealth/crouton-alpha` (an anonymous preview model) and
`tencent/hy4-preview` (Hy4 itself is rated). Layer 3 is the way to rate them.

## What was checked before building (8 November 2026)

The sandbox cannot reach Hugging Face; the check ran in GitHub Actions (workflow "LMArena
probe", `scripts/probe_lmarena.py`, report `backend/data/catalogue/sources/lmarena-probe.json`).

| Question | Answer |
|---|---|
| Free? | Yes: public dataset `lmarena-ai/leaderboard-dataset`, downloaded with no account and no key (`gated: false`, `private: false`) |
| Licence | CC BY 4.0: free use, including commercial, **with attribution**. Every level names LMArena and the licence; the README credits it |
| Immediate? | Yes: the text leaderboard is one 0.6 MB file; the download takes seconds and users see the levels as soon as the snapshot is merged, with no calls to any model |
| Fresh? | Text leaderboard published 6 Nov 2026, agent leaderboard 4 Nov 2026; updated several times a week |
| Models | 419 in `text_style_control`, 188 in `text_factuality`, 58 in `agent` |
| Limits | A public ranking from people's votes between two answers, not our measurement: `provisional`, below measured levels. Little signal on tools (58 models), so tools stay at most 2 without agent data |

## Layer 1 in detail

| Step | What | Where |
|---|---|---|
| Snapshot | The "Catalogue sources" workflow downloads the latest `text_style_control`, `text_factuality` and `agent` leaderboards and keeps, per model name and mapped category, the rating, its interval and the votes. It refuses (writes nothing) if the dataset is gated, the licence is not CC BY 4.0 or a column is missing | `scripts/snapshot_lmarena.py`, `sources/lmarena-<date>.json` |
| Models that leave | A model missing from a new leaderboard keeps its last entries, with their date, for 180 days | `carry_over` in the same script |
| Name links | Exact match after `normalise`: no vendor prefix, no `:free`/`:batch`, no bracketed variant (`(High)`, `(20250514)`), `.` `_` and spaces as `-`, no 8-digit or ISO date, no `-preview`, `-latest`, `-instruct`, `-it`. **Kept**, because they are different models: `-exp`, `-chat`, `-pro` and 4-digit versions such as `-1017` | `backend/app/arena.py` |
| Checked links | Names that do not normalise alike but are the same model (`nvidia/nemotron-3.5-super-vl` = `NVIDIA-Nemotron-3.5-Super-VL-120B-A12B`, Llama 4, `mistral-large-4-0`) are listed by hand; `blocked` lists ids that must never link | `backend/data/catalogue/arena-aliases.json` |
| Variants | Arena entries of one model (`(High)`, `(Low)`, `(Max)`, `(Thinking)`) count as one model with the **lowest** rating of each category: OpenRouter calls the default effort and a lower level is the safe error | `merge_variants` |
| Confidence | A category counts with at least 300 votes and an interval of at most 60 points (agent: 100 sessions); otherwise the next category of the chain is used | `arena-mapping-1.json` `rules` |
| Thresholds | Per category, the 34th and 67th percentile of the arena models **available on OpenRouter** (135 models; all 419 would include 2023 models and inflate every level), frozen as absolute ratings. New thresholds need `arena-mapping-2`; a new weekly snapshot keeps them | `scripts/build_arena_mapping.py`, `backend/data/catalogue/arena-mapping-1.json` |
| Facts | A model rated only by a public source takes price, context and tool support from the committed OpenRouter snapshot, so its cost band is known | `router_snapshot_facts` |
| In the app | `Ratings.source` returns `arena` after the catalogue's provisional levels and before Artificial Analysis. The analysis shows "Levels from: LMArena public ranking of 2026-11-06 (CC BY 4.0), provisional"; LLM config shows "Provisional (LMArena public ranking, CC BY 4.0)" with the categories and ratings of each level | `backend/app/evaluations.py`, `frontend/src/AnalysisResult.tsx`, `frontend/src/ModelEvaluations.tsx` |

**Mapping `arena-mapping-1`** (style-controlled leaderboard, which discounts answer length and
formatting so a verbose model does not look stronger):

| Capability | Categories, first usable wins | Why |
|---|---|---|
| reasoning | the **lower** of `math` and `hard_prompts`; then `hard_prompts`; then `overall` | Hard prompts are the top fifth by difficulty; math is the purest reasoning signal |
| context | `longer_query`; then `overall` | Long prompts; the context window itself stays a fact and a hard filter |
| domain | `expert`; then `hard_prompts`; then `overall` | Expert holds the hardest specialist prompts |
| reliability | factuality leaderboard; then `instruction_following`; then `overall` | Factuality is the closest to "does not invent" |
| tools | agent leaderboard; then `overall` **capped at 2** | Only 58 models have agent data; without it we never claim level 3 |

A model is rated only if its `overall` rating is usable; otherwise LMArena gives nothing and
the next source is tried.

## Layer 2: Artificial Analysis for the gaps

Unchanged rule (A9): only checked links in `aa-aliases.json`. Added the links for the most
used models LMArena lacks (`deepseek/deepseek-v4.1-flash-1017`, `tencent/hy4`,
`minimax/minimax-m3.1-flash`, `qwen/qwen3.8-max-0902`) and every other OpenRouter id whose
name matches one Artificial Analysis model exactly after normalising (10 more, among them
`openai/gpt-6.1-terra`, `moonshotai/kimi-k3.1-pro`, Nemotron 3 Ultra and 3.5 Lightning).
Only 109 of AA's 726 models have the index in the free tier. The newest AA snapshot is used.

## Layer 3: measurement in the background with the project key

Configured and picked models are measured as before (A8), with the user's key and consent for
paid ones; measured levels replace public ones. On top of that, the worker measures with the
**project's own OpenRouter key** (`ADAPTAI_EVALUATION_OPENROUTER_KEY`), used only for this and
never for chats, the models no user configured:

| Rule | Value |
|---|---|
| Order | The most used models without a public source (`most-used.json` `no_public_source`); then every free OpenRouter model; then, only with `ADAPTAI_EVALUATION_PAID=true`, paid models without levels, cheapest first |
| Free models | Measured even when a public source rates them: they cost nothing and measured levels are better |
| One at a time | A project run starts only when no user run is queued; users come first |
| Daily calls | `ADAPTAI_EVALUATION_DAILY_CALLS` (default 50, OpenRouter's limit for free models without bought credit). A run is 40 calls, so about one model a day |
| Budget | `ADAPTAI_EVALUATION_BUDGET_USD` (default 5, the key's own limit too): a paid run starts only if the total spent plus its guaranteed maximum fits |
| Refusals | 5 failed calls in a row (no credit, daily limit, model withdrawn) end the run as `provider_refused`; that model waits a day |
| Shared | Results are shared: every user gets the measured levels |
| Status | `uv run python scripts/project_evaluations.py`: key set or not (never the key), calls today, spend, models in line, every run |

What "every model" costs, from the 8 November snapshot of 459 OpenRouter models:

| Group | Models | How they get levels | Cost |
|---|---|---|---|
| Rated by a public source | 227 | LMArena or Artificial Analysis, at once | 0 |
| Free, no public source | 9 (plus the free ones with public levels, measured anyway) | Project key, about one a day | 0 |
| Most used, no public source | 2 (`stealth/crouton-alpha` free; `tencent/hy4-preview` paid) | Project key | 0 and about 0.06 USD at most |
| Paid, no public source | 223 | Measured when a user configures or picks one (their key, with consent), or by the project key with credit | About 33 USD estimated, 90 USD at most, for all of them |

So without bought credit every model a user actually uses gets measured levels (with their
consent when paid), and the paid niche models nobody uses stay without levels until someone
uses them or the team buys credit and turns `ADAPTAI_EVALUATION_PAID` on.

## Layer 4: feedback by source

`task_outcomes.levels_source` (migration 007) records where the levels of the model used
came from. Models without a catalogue card (measured or public) now feed calibration too.
`scripts/calibration_report.py` starts with "Outcomes by source of the levels" and every
proposal names its source: if LMArena levels predict outcomes worse than measured ones, the
team sees it and changes the mapping (`arena-mapping-2`) or measures those models.

## Layer 5: one suggestion among all rated OpenRouter models (next)

For a user with an enabled OpenRouter configuration, the analysis would also compare every
rated OpenRouter model and show at most one: "Also on OpenRouter: X covers this task better",
only if it covers a need the best own model falls short on, or costs less for the same
coverage, and never above the user's highest current price band. "Use" selects it like a
pick.

## Decisions needed

| # | Decision | Proposal |
|---|---|---|
| 1 | A project OpenRouter key on the server, used only for evaluation | **Done** (8 Nov 2026): key limit 5 USD, 90 days, local `.env` and GitHub secret `OPENROUTER_EVALUATION_KEY` |
| 2 | Budget for paid evaluations with the project key | 5 USD (`ADAPTAI_EVALUATION_BUDGET_USD`), only used with credit |
| 3 | Buy OpenRouter credit | **Not now** (a billing address is required). Without it: free models only, about one a day. With 10 USD: more free calls a day and paid models within the budget |
| 4 | Style-controlled leaderboard rather than the raw one | Implemented as proposed; the AO confirms |

## Risks

| Risk | Mitigation |
|---|---|
| A wrong name link gives a model another model's levels | Exact normalised match; suffixes that mark other models kept; checked links by hand; `blocked` list; tests 20 and 21 |
| Human preference is not capability | Provisional, below measured; tools capped at 2; calibration by source |
| The dataset changes format or licence | The snapshot script refuses and writes nothing; the levels in force stay |
| A popular new model has no levels | `most-used.json` and its test, updated monthly |
