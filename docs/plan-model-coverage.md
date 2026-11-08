# Levels for every model, free and at once (ADR-014 A10)

Status (8 November 2026): **layers 1, 2 and 4 implemented**; layer 3 waits for decisions 1
to 3; layer 5 is the next pull request. The AO confirms A10.

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
| 1 | LMArena, per category (public, CC BY 4.0) | 212 of 459 OpenRouter ids, and the same models at Groq, Anthropic and OpenAI | 0 | Implemented |
| 2 | Artificial Analysis overall index (A9) | Models LMArena lacks, by checked links | 0 (free key) | Implemented (links for the most used added) |
| 3 | Our measurement, `measure-suite-1` (A8) | Configured models; with a project key, free and new models no public source has | 0 for free models | Configured models: implemented. Project key: waits for decisions 1 to 3 |
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
used models LMArena lacks: `deepseek/deepseek-v4.1-flash-1017`, `tencent/hy4`,
`minimax/minimax-m3.1-flash`, `qwen/qwen3.8-max-0902`. The newest AA snapshot is used.

## Layer 3: measurement in the background (decisions pending)

Unchanged for configured models (A8): they are still measured, and measured levels replace
the public ones. With a **project OpenRouter key** on the server, used only for evaluation,
the worker would also measure without anyone configuring them: the `:free` models no public
source covers (about 10), the stealth and preview models in `no_public_source`, and, within a
monthly budget, the paid models users pick most that no public source has. Each run keeps its
guaranteed maximum (40 calls, 1,024 output tokens each).

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
| 1 | A project OpenRouter key on the server, used only for evaluation | Yes, as a server secret, never shown to users |
| 2 | Monthly budget for paid evaluations with the project key | 5 USD |
| 3 | Buy OpenRouter credit to raise the free models' daily limit | 10 USD once, if layer 3 is too slow |
| 4 | Style-controlled leaderboard rather than the raw one | Implemented as proposed; the AO confirms |

## Risks

| Risk | Mitigation |
|---|---|
| A wrong name link gives a model another model's levels | Exact normalised match; suffixes that mark other models kept; checked links by hand; `blocked` list; tests 20 and 21 |
| Human preference is not capability | Provisional, below measured; tools capped at 2; calibration by source |
| The dataset changes format or licence | The snapshot script refuses and writes nothing; the levels in force stay |
| A popular new model has no levels | `most-used.json` and its test, updated monthly |
