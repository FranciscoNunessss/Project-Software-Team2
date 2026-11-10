# ADR-014: Recommendation by task needs and model capabilities, and feedback per task

Status: Proposed (6 November 2026). The Architecture Owner decisions below (benchmarks,
thresholds, cost bands, first batch, several server models) were taken by Ricardo Rodrigues
in the AO's place so the work could go on; Francisco Velhinho confirms or changes each one.
Owner: Ricardo Rodrigues. Related: ADR-003 (layered assessment), ADR-004 (catalogue and
provider register), ADR-005 (privacy), ADR-009 (rubric as data), ADR-011 (chat), ADR-012
(OpenRouter and LM Studio). Supersedes the graded tier recommendation (prototype-3-graded).
ADR-013 is José Moura's VS Code extension proposal.

## Context

The analysis recommended an abstract tier (Small, Medium, Large) from one "demand" value that
mixed reasoning and context. A tier is vague for users and for the team, matches no real
model and can never be checked: the catalogue had three illustrative entries. Risk, domain
and tools did not count. Users had no way to say whether the recommended model solved the
task, so nothing could improve the recommendation.

## Decision

| # | Decision | Why |
|---|---|---|
| D1 | Recommend a concrete model, not a tier | Users act on models; the promise is "the right model without paying more" |
| D2 | One 1-3 scale for task needs and model capabilities, the rubric's | Direct comparison; one source for levels (NFR-07, ADR-009) |
| D3 | Five capabilities: reasoning, context, domain, reliability, tools | They match the analysis; risk maps to reliability. Ambiguity is missing information, handled by the Coach, never a model capability |
| D4 | The cheapest model that covers every need | Avoids paying more; easy to explain and test |
| D5 | One capability card per model, with aliases per provider | The same model on Groq, OpenRouter and Ollama is classified once |
| D6 | Levels are provisional (public benchmarks) or calibrated (the team's set) | Start now without pretending precision; the UI shows "not calibrated" |
| D7 | Models without levels can be used but are never recommended | What was not measured cannot be recommended |
| D8 | Deterministic Python, no language model, in the recommendation | Repeatable, testable, explainable (the ADR-009 principle for derived values) |
| D9 | Feedback per task, at most once, never per answer | A good model may need iterations; rating each answer would penalise it and tire the user |
| D10 | Three answers: Solved, Solved after refining, Not solved (optional reason) | Separates "needed iterating" from "failed", and "described it poorly" from "the model fell short" |
| D11 | The system only proposes catalogue changes; the team publishes a new version | Traceability and human control; user feedback is subjective and may be scarce |
| D12 | No new text is stored with the feedback | Keeps Product Spec section 8: choices, counts and identifiers only |
| D13 | Build catalogue and recommendation first, feedback right after | Feedback needs the recommended model and the needs to be useful for calibration |

### AO decisions taken in the AO's place (to confirm)

| # | Decision | Why |
|---|---|---|
| A1 | One benchmark source: Artificial Analysis, only evaluations of the Intelligence Index in force | Same hardware and prompts for hundreds of models; evaluations in the index are run for every new model |
| A2 | Metrics per capability, in order of preference: reasoning `gpqa_diamond`; context `aa_lcr`; domain `aa_omniscience_accuracy`; reliability `aa_omniscience_non_hallucination_rate`; tools `tau_banking`. Fallbacks: the industry indices (domain), the agentic index (tools), the overall Intelligence Index (all) | The per-benchmark values are on the Pro API only; the free API publishes the indices. The source of each level says which metric was used |
| A3 | Thresholds: the 34th and 67th percentile of all models in the snapshot, frozen as absolute values in `benchmark-mapping-1` | No invented numbers; balanced levels; a model never "gets worse" because better ones appeared. New thresholds need `benchmark-mapping-2` |
| A4 | Cost bands on the blended price `(3 x input + output) / 4` per million tokens: low up to 0.50 USD, medium up to 5.00, high above; local and free models cost 0 | Three bands show the order of magnitude; the choice uses the exact price |
| A5 | First batch: gpt-oss-20b, gpt-oss-120b, the Gemma models the team uses, one Claude Sonnet and one GPT mini | The default model, a second level on the server, the references users configure |
| A6 | Several server models per provider (`ADAPTAI_<PROVIDER>_MODELS`) | Without two levels on the server, users without their own models have no choice |
| A7 | Automatic measurement suite `measure-suite-1` as the main source for the models we can call; status `measured` between `provisional` and `calibrated` | The free benchmark API had no values for our server models (108 of 726 models on index v5). Our own suite measures every model the same way, repeatably and without reviewers |
| A8 | **Automatic evaluation of every configured model** (decided 7 Nov 2026): only models someone configured are evaluated, once, by a background worker with the adaptive suite (level 2 first, then 3 or 1; at most 40 tasks). Results of official cloud endpoints are shared; local models are per user. Paid models with a user's key wait for consent showing what, how, the estimated cost and a guaranteed maximum (unknown price: confirm twice). Levels, source and examples are visible; users can report disagreement but not edit levels | Every model that can be recommended has levels; users almost never pay because results are shared and the team evaluates common models first; the user decides before spending |
| A9 | Order of sources for a model's levels: team-calibrated catalogue levels, then our measured levels, then the catalogue's provisional levels, then the Artificial Analysis overall index (confirmed name links only, one level for all five capabilities), then the lowest measured level of the same family, else never recommended | The best evidence wins; the cheap fallbacks are labelled provisional and replaced as soon as we measure |
| A10 | **Levels for every model without spending tokens (8 Nov 2026; layers 1 to 4 implemented, to confirm).** Public LMArena leaderboards per category (CC BY 4.0, style-controlled, mapping `arena-mapping-1` with thresholds frozen at the 34th and 67th percentile of the arena models on OpenRouter); Artificial Analysis for the gaps; our measurement in the background, also with the project's evaluation-only OpenRouter key for models no public source rates (free models first, daily calls and budget capped); feedback recorded with the source of the levels. Order of sources: calibrated, measured, catalogue provisional, **LMArena**, Artificial Analysis, family, none. The models in `most-used.json` must always have levels (a test enforces it) | Free, no account, 0.6 MB, published 6 Nov 2026; rates 227 of 459 OpenRouter ids and 26 of 26 of the most used models with Artificial Analysis. Details: [`docs/plan-model-coverage.md`](../plan-model-coverage.md) |
| A11 | **Two roles (8 Nov 2026, implemented, to confirm).** The task assessment always uses the project's assessor: server models with strict JSON output, Groq first, the next one if it hits a limit, runs out of credit, times out or is unavailable (said in the result); a manually chosen configuration is never replaced. The chat uses the model the user picks; "Use this model" changes only that. A chat answer that hit a limit offers "Send with <project model>", one click. A model that hit a rate limit (1 h) or ran out of credit (1 day) is not recommended meanwhile, with a note. Free OpenRouter models are evaluated with the project's evaluation key | The assessment needs JSON that many chat models cannot give (free Gemma on OpenRouter), and one assessor keeps analyses comparable; a recommendation must not break the analysis, and the user must always get an answer. Files: `app/limits.py`, `app/main.py`, `app/llm_config.py` `assessment_chain`, `frontend/src/ChatScreen.tsx`; tests `test_assessor.py`, `e2e/openrouter.spec.ts` |
| A12 | **OpenRouter is a catalogue behind one key (9 Nov 2026, implemented, to confirm).** Connecting OpenRouter needs only the key; a default model is optional, and the test connection checks the key without calling a model. Every model in both chat pickers shows its state (Measured, Public ranking, Provisional, Evaluating n/40, Waiting for consent, Evaluation failed, Not evaluated); "Evaluate" in the OpenRouter list adds a model to the user's models without sending anything. Models without structured output can be chosen for the chat (only the assessor needs it, A11). For a user with OpenRouter, the analysis compares every rated chat model of the catalogue and shows at most one suggestion, "Also on OpenRouter", only if it covers needs the user's best falls short on or covers as much for less (never against a model that is free to the user), and never in a dearer price band than the user's own models | The model asked for at setup meant nothing for OpenRouter (the chat lists the whole catalogue) and confused users; a model's state was invisible where it is chosen; most rated catalogue models never reached the recommendation. Files: `app/llm_config.py`, `app/workflow.py` `suggest`, `app/main.py` `suggestion_pool`, `app/evaluations.py` `label`, `frontend/src/modelStatus.tsx`, `OpenRouterModelPicker.tsx`, `ModelPicker.tsx`, `AnalysisResult.tsx`; tests `test_openrouter_models.py`, `e2e/openrouter-models.spec.ts` |

## How it works

The work is in two phases. **Phase 1** (feedback and the way of recommending) is the table
below minus the rows marked phase 2. **Phase 2** (how models get their levels: classification,
automatic measurement, calibration) comes in its own pull request.

| Part | Where |
|---|---|
| Catalogue v2: cards with facts, five ratings (level, status, source, date), aliases, versioned and hashed like the rubric | `backend/data/catalogue/`, `backend/app/catalogue.py` |
| Classification: facts import, benchmark snapshot, mapping, provisional ratings | `docs/model-classification.md`, `backend/app/classification.py`, `scripts/import_openrouter_facts.py`, `scripts/snapshot_benchmarks.py`, `scripts/build_catalogue.py`, workflow "Catalogue sources" (phase 2) |
| Task needs: an interval `[estimated, top]` per need: high or medium confidence `[s, s]`, low `[s, s+1]`, undetermined `[2, 3]` | `task_needs` in `backend/app/recommendation.py` |
| The 8 steps: `available_cards`, `hard_filter`, `coverage`, `model_status`, `choose`, `fallback`, `extra_rules`, `explain` | `recommend` in `backend/app/recommendation.py`, policy `needs-capabilities-1` |
| API: `recommendation` and `alternatives` carry the card, how to use it (`configuration_id`), coverage per need, shortfalls, cost band, `gap`; the result adds `needs` and `notes` | `AnalysisResult` in `backend/app/models.py` |
| Old analyses keep their tier and are still shown and counted | `candidate_gap`, `TierCard` |
| Feedback: `task_outcomes` (schema v8), `PUT /api/analyses/{id}/outcome`, totals in `GET /api/progress/outcomes`; Send records the choice | `backend/app/outcomes.py`, `backend/app/chat.py` |
| Educator, Coach and My progress use the outcome totals | `backend/app/coaching.py`, `backend/app/main.py`, `frontend/src/TaskOutcomes.tsx` |
| Automatic measurement: 60 generated tasks graded by a program, runner, apply script, "Measure models" workflow | `backend/app/measurement.py`, `scripts/measure_models.py`, `scripts/apply_measurements.py` (phase 2) |
| Calibration report (proposes level changes, changes nothing) | `scripts/calibration_report.py` (phase 2) |
| Automatic evaluation of configured models: inventory, queue with consent and cost, adaptive runner, shared results, order of sources, API and the LLM config section (phase 2, A8 and A9) | `backend/app/evaluations.py`, migration `005_model_evaluations.sql`, `frontend/src/ModelEvaluations.tsx`, `docs/testing-model-evaluations.md` |
| Levels from public sources (A10): LMArena snapshot, name links, frozen mapping, `arena` source in `Ratings`, most-used guarantee, outcomes by source | `backend/app/arena.py`, `scripts/snapshot_lmarena.py`, `scripts/build_arena_mapping.py`, `backend/data/catalogue/arena-*.json`, `most-used.json`, migration `007_task_outcome_levels_source.sql`, `docs/plan-model-coverage.md` |

Removed: `demand_estimate`, `tier_fit`, `capacity_target`, the graded parameters, the chat's
`chat_model_tiers` table and routes (cards are linked by their aliases).

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep tiers and add real models under them | Still one number for five different needs; the tier stays unverifiable |
| One overall score per model | Hides where a model falls short; a strong reasoner may be weak on tools |
| Let a language model recommend | Not repeatable or testable; costs a call per analysis |
| Feedback per answer (thumbs) | Penalises models that need iterating, tires users, measures replies, not tasks |
| Percentiles computed live | A model's level would change when others are released; not reproducible |

## Consequences

| Positive | Negative or open |
|---|---|
| Recommendations name a model the user can use in one click | Levels are provisional until the team calibrates them; the UI says so |
| Every level has a source and a date; the docs refer to versions, not values | Per-benchmark data needs the AA Pro API; with the free API most levels come from the overall index |
| Feedback measures whether the recommendation worked, per task | Few users may answer; conclusions only from 10 cases per model, capability and level |
| The catalogue improves through reviewed versions | Prices and facts change; each version records `observed_on` |
| The chat counts again in My progress (Send is the choice) | Analyses stored before this policy keep the tier wording |

## Evidence (6 November 2026)

Backend tests (including `test_recommendation.py`, one test per step; `test_catalogue.py`;
`test_classification.py`; `test_task_outcomes.py`; `test_server_models.py`), the policy grid
regenerated for the intended change, the removal drill and the browser tests
(`e2e/feedback.spec.ts`) pass. Not established yet: real levels (the benchmark snapshot), the
calibration set, recommendation quality and non-author review.
