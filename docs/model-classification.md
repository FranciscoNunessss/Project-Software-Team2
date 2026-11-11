# How a model gets its levels

Procedure from ADR-014 (decisions A7 to A10). Public leaderboards give provisional levels to
most models at once (A10); the app also measures **every model someone has configured**,
automatically, and measured levels replace the public ones. The steps further down (public sources, the
team's measurement scripts, calibration) feed the same levels.

## Automatic evaluation of configured models

| Step | What happens | Where |
|---|---|---|
| Inventory | The server models (`ADAPTAI_<PROVIDER>_MODELS`), every enabled personal configuration with a model, and the models a user picked from OpenRouter's catalogue (in the chat on first use, or with "Add an OpenRouter model" in LLM config; table `user_models`). Nothing else is evaluated | `evaluations.inventory` |
| New model | When a configuration is saved, or on the hourly inventory, a model without a current evaluation gets a run | `evaluations.ensure` |
| Consent | Free, local and server models start at once. A paid model with a user's key waits: the user sees what is evaluated, how, the estimated cost and a guaranteed maximum, the time, and what declining means. Unknown price: confirm twice | LLM config › "How your models were evaluated" |
| Run | A background worker sends the synthetic tasks of `measure-suite-1` adaptively: level 2 first, then 3 if passed (75%) or 1 if not; at most 40 calls with at most 1,024 output tokens each, so the maximum cost is a guarantee. Rate limits are retried; more than 10% failed calls discard the run; reaching the maximum stops it | `evaluations.run` |
| Sharing | Results of official cloud endpoints (Groq, OpenAI, Anthropic, OpenRouter) serve every user; local models (Ollama, LM Studio) are evaluated per user and never shared | `Target.scope` |
| Freshness | A new suite version, 90 days, or "Re-evaluate" opens a new run; the old levels stay until it finishes | `evaluations.ensure` |
| Visible, not editable | Users see the five levels, their source, the pass rates and examples of answers. "Disagree" is recorded for the calibration report; levels change only through a new evaluation or the team's calibration | `/api/evaluations`, `evaluation_disagreements` |

**Order of sources** for a model's levels (A9, A10), best first: the team's calibrated
catalogue levels; our measured levels; the catalogue's provisional levels; **the LMArena
public leaderboards per category** (A10, below); the Artificial Analysis overall index, only
for name links confirmed in `backend/data/catalogue/aa-aliases.json`, one level for all five
capabilities; the lowest measured level of the same family (`gpt-oss`, `gemma`,
`claude-sonnet`…). Without any of them a model works in the chat but is never recommended.

**Cost of one paid evaluation** (worst case 40 calls, about 20,000 input tokens): GPT-5.4 mini
about 0.10 to 0.30 USD, Claude Sonnet 5.5 about 0.25 to 0.65 USD; the exact estimate and
maximum come from the model's price and are shown before consent.

How to test it: [`docs/testing-model-evaluations.md`](testing-model-evaluations.md).

## Levels from public sources, for every model at once (A10)

So that a model is rated before anyone measures it, and without spending tokens, the app
reads the public LMArena leaderboards (dataset `lmarena-ai/leaderboard-dataset`, CC BY 4.0,
free, no account). Each capability takes the category closest to it (reasoning: the lower of
math and hard prompts; context: longer queries; domain: expert; reliability: factuality;
tools: the agent leaderboard, else at most 2), with thresholds frozen in `arena-mapping-1`.
On 8 November 2026 this rates 213 of the 459 OpenRouter models (227 with Artificial Analysis) and
all 26 of the most used models in `most-used.json`; a test keeps it that way. Models no
public source rates are measured in the background with the project's evaluation key
(layer 3), free models first. Every level
says "LMArena", the date and the licence, and is provisional: our measurement replaces it.

How names are linked, the mapping, the weekly refresh and the decisions still open:
[`docs/plan-model-coverage.md`](plan-model-coverage.md). Tests and the weekly routine:
[`docs/testing-model-evaluations.md`](testing-model-evaluations.md) sections 1b and 4.

# Team procedures

Procedure from ADR-014. Anyone in the team can follow it; the Architecture Owner (AO) approves
each new catalogue version. The docs refer to versions (`catalogue-2.x`, `benchmark-mapping-1`,
`needs-capabilities-1`), never copy levels or thresholds: the files in the repository are the
only source (NFR-07).

## The capability card

One card per model, in a catalogue version under `backend/data/catalogue/versions/`. The active
version is named in `backend/data/catalogue/ACTIVE`; `versions.json` holds the sha256 of every
version, which never changes once registered.

| Part | Content |
|---|---|
| `id`, `family`, `name` | Stable id, family (for inheritance), display name |
| `aliases` | The provider ids it is served under: `{provider, model}`, optionally the provider's own price with its source |
| `facts` | Context window, modalities, request capabilities, tool calling, structured output, input and output price per million tokens, free, local, source URL, `observed_on` |
| `capabilities` | Reasoning, context, domain, reliability, tools: each `{level 1-3, status, source, observed_on}`; status `provisional`, `calibrated` or `unrated` |

A card with an unrated capability can be used in the chat but is never recommended. Order of
trust: `calibrated` (reviewed by people) > `measured` (our automatic suite) > `provisional`
(public benchmarks).

Why the automatic measurement: on 6 November 2026 the free Artificial Analysis API published
Intelligence Index v5 values for only 108 of 726 models; of our batch only Claude Sonnet 5.5
and Gemma 4 31B had one, and the server models (gpt-oss) had none. Measuring the models
ourselves covers every model we can call, with the same tasks and the same grader.

## The four steps

| Step | What | Who | Result |
|---|---|---|---|
| 1. Facts | `scripts/import_openrouter_facts.py` saves OpenRouter's public catalogue (no key) to `backend/data/catalogue/sources/openrouter-<date>.json`. `--search gemma` lists ids | Anyone; the "Catalogue sources" workflow does it on a `data/**` branch | Facts with date and source URL |
| 2. Provisional levels | `scripts/snapshot_benchmarks.py` saves the Artificial Analysis results (needs `ADAPTAI_AA_API_KEY`, or the `ARTIFICIAL_ANALYSES_ADAPTAI` repository secret for the workflow) to `sources/aa-<date>.json`. `scripts/build_catalogue.py` creates `benchmark-mapping-1` from that snapshot the first time and rates every model of the batch | Anyone; AO approves the version | A new catalogue version with `provisional` levels |
| 2b. Automatic measurement (main source for the models we serve) | `scripts/measure_models.py` puts every catalogue model a key can reach through `measure-suite-1` (60 tasks, 4 per capability and level, generated from a seed, graded by a program: numbers, exact text, JSON calls, format rules, "I don't know" on unanswerable questions). Level L needs at least 75% at L and every level below. `scripts/apply_measurements.py runs/*.json --version catalogue-2.x` writes the levels with status `measured`. On GitHub, the "Measure models" workflow does it on a `data/measure-*` branch with the `GROQ_API_KEY` and `OPENROUTER_API_KEY` secrets (paid models only with `[allow-paid]` in the commit message) | Anyone; AO approves the version | `measured` levels from our own test, the same for every model |
| 3. Calibration | `scripts/run_calibration.py run --provider ... --model ...` answers the 30 tasks of `backend/eval/calibration/calibration-set-1.json`; two reviewers mark pass or fail; `run_calibration.py score <sheet>` gives the levels | Team | `calibrated` levels in a new version |
| 4. Continuous review | `scripts/calibration_report.py` reads the task feedback and proposes raising or lowering levels (at least 10 tasks per model, capability and level, completeness >= 75) | AO and team | A new version when the team agrees |

Commands for steps 1 and 2:

```bash
uv run python scripts/import_openrouter_facts.py
uv run python scripts/snapshot_benchmarks.py
uv run python scripts/build_catalogue.py --batch backend/data/catalogue/batch-1.json \
  --facts backend/data/catalogue/sources/openrouter-<date>.json \
  --snapshot backend/data/catalogue/sources/aa-<date>.json \
  --mapping benchmark-mapping-1 --version catalogue-2.2
# review the printed levels, then rerun with --activate in a new version, open a PR
```

## The benchmark mapping (`benchmark-mapping-1`)

One source, Artificial Analysis (https://artificialanalysis.ai/), because it runs the same
evaluations with the same prompts and hardware for hundreds of models. Only evaluations of the
Intelligence Index in force are used, because they are run for every new model. Methodology:
https://artificialanalysis.ai/methodology/intelligence-benchmarking.

| Capability | Preferred metric (Pro API) | Fallbacks (free API) |
|---|---|---|
| Reasoning | `gpqa_diamond` (GPQA Diamond, Rein et al. 2023, arXiv 2311.12022) | overall Intelligence Index |
| Context | `aa_lcr` (AA Long Context Reasoning) | overall Intelligence Index |
| Domain | `aa_omniscience_accuracy` | mean of the industry indices, overall Intelligence Index |
| Reliability | `aa_omniscience_non_hallucination_rate` | overall Intelligence Index |
| Tools | `tau_banking` (τ³-Banking) | agentic index, overall Intelligence Index |

The level comes from the first metric the model has a value for; the card's `source` names it
and says "fallback" when the preferred one was missing. A model without tool calling in its
facts gets tools 1.

**Thresholds.** For each metric, the values at the 34th and 67th percentile of every model in
the snapshot, computed once and frozen as absolute numbers in
`backend/data/catalogue/mappings/benchmark-mapping-1.json`: below the first is 1, from the
second on is 3, in between 2. A model never "gets worse" because better ones appear. New
thresholds need `benchmark-mapping-2`, approved by the AO.

**Known limits.** AA-LCR and AA-Omniscience are defined by Artificial Analysis and lack broad
academic validation (GPQA has it). With a free key, most levels come from the overall index,
which is coarse. The team's calibration (step 3) replaces provisional levels for the models
users actually configure. Use of the data requires attribution to Artificial Analysis.

## Prices and cost bands

Blended price `(3 x input + output) / 4` per million tokens, because analysis and chat send more
input than they receive. Local models (Ollama, LM Studio) and `:free` OpenRouter ids cost 0. An
alias may carry the provider's own price (for example Groq) with its source. Cost bands, shown
to the user only as information: low up to 0.50 USD, medium up to 5.00, high above.

## The first batch (`backend/data/catalogue/batch-1.json`)

gpt-oss-20b and gpt-oss-120b (server, Groq), Gemma 4 26B A4B and Gemma 4 31B (OpenRouter,
including the `:free` ids), Claude Sonnet 5.5 and GPT-5.4 mini (personal keys or OpenRouter).
LM Studio and Ollama aliases are added once the team confirms the local model names. The facts
come from the OpenRouter catalogue of 6 November 2026; the Groq prices of the gpt-oss aliases
are Groq's launch prices and must be confirmed on https://groq.com/pricing.

## Scaling to more models

| Mechanism | Effect |
|---|---|
| Facts imported from OpenRouter | Hundreds of models with facts and no manual work |
| One card per model with aliases | Classified once for every provider |
| Fixed mapping | A new model with public benchmarks gets provisional levels repeatably |
| Family inheritance | A new version of a classified model may start from the family's levels, marked provisional |
| Calibration only for the most used | Human effort goes to the 10 to 15 models users configure |
| The recommendation does not depend on the number of cards | It compares the task with each card |
