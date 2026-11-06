# How to classify a model

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

A card with an unrated capability can be used in the chat but is never recommended.

## The four steps

| Step | What | Who | Result |
|---|---|---|---|
| 1. Facts | `scripts/import_openrouter_facts.py` saves OpenRouter's public catalogue (no key) to `backend/data/catalogue/sources/openrouter-<date>.json`. `--search gemma` lists ids | Anyone; the "Catalogue sources" workflow does it on a `data/**` branch | Facts with date and source URL |
| 2. Provisional levels | `scripts/snapshot_benchmarks.py` saves the Artificial Analysis results (needs `ADAPTAI_AA_API_KEY`, or the `AA_API_KEY` secret for the workflow) to `sources/aa-<date>.json`. `scripts/build_catalogue.py` creates `benchmark-mapping-1` from that snapshot the first time and rates every model of the batch | Anyone; AO approves the version | A new catalogue version with `provisional` levels |
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
