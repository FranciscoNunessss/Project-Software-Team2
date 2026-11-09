# Testing how models get levels and are recommended (ADR-014 A8, A9, A10)

Three layers. The first two run in CI on every pull request and cost nothing; the third is
a manual check with real keys (about 40 minutes, under 1 USD). Section 1b covers the levels
from public sources (A10); section 4 is the routine that keeps them current.

## 1. Backend tests (`backend/tests/test_evaluations.py`, fake models)

| # | Case | Test |
|---|---|---|
| 1 | Free (server) model: evaluated without asking | `test_server_model_is_evaluated_without_consent_and_then_recommended` |
| 2 | Already evaluated: reused by every user, no new calls | `test_an_evaluated_model_is_reused_by_every_user_without_new_calls` |
| 3 | Paid model with the user's key: waits for consent, estimate < maximum, no call before consent | `test_a_paid_model_waits_for_consent_with_an_estimate_and_a_maximum` |
| 4 | Declined, and no public source has it: still usable in the chat, never recommended | `test_a_declined_model_stays_usable_but_is_not_recommended` |
| 5 | Unknown price: second confirmation required | `test_an_unknown_price_needs_a_second_confirmation` |
| 6 | Spending reaches the maximum: the run stops | `test_the_run_stops_at_the_guaranteed_maximum` |
| 7 | More than 10% failed calls: discarded (a model no public source has stays without levels) | `test_too_many_failed_calls_discard_the_run` |
| 8 | Rate limits: retried, the run finishes | `test_rate_limits_are_retried_and_the_run_finishes` |
| 9 | Two requests at the same time: one run | `test_concurrent_requests_open_a_single_run` |
| 10 | Local models: per user, never shared | `test_local_models_are_evaluated_per_user` |
| 11 | New suite version: new run | `test_a_new_suite_version_needs_a_new_run` |
| 12 | Configuration deleted: gone from the user's list, shared result kept | `test_deleting_a_configuration_removes_it_from_the_users_list` |
| 13 | Artificial Analysis as fallback for a model LMArena does not have, with its source | `test_artificial_analysis_is_the_fallback_for_unmeasured_models` |
| 14 | Family inheritance: lowest level, provisional; families do not mix | `test_family_inheritance_takes_the_lowest_measured_levels` |
| 15 | Calibrated levels win over measured ones | `test_calibrated_levels_win` |
| 16 | A finished evaluation enters the next recommendation | case 1 |
| 17 | Restart during a run: free runs retried, paid ones failed (no charge without consent) | `test_a_restart_retries_free_runs_and_fails_paid_ones` |
| 18 | A model picked in the chat (OpenRouter) is evaluated on first use and then compared with how to use it | `test_a_model_picked_in_the_chat_is_evaluated_and_then_recommended` |
| 19 | OpenRouter models added and removed in LLM config; unknown ids refused; disabling the configuration removes them | `test_openrouter_models_can_be_added_and_removed_from_the_evaluations` |
| + | Adaptive levels and cost bounds; inventory only of enabled configurations; "Disagree" changes nothing; a weak capability gets a low level | remaining tests |

Run them with PostgreSQL up: `uv run pytest backend/tests/test_evaluations.py -q`.

## 1b. Levels from public sources (`backend/tests/test_arena.py`, A10)

No network: the tests use the committed snapshot or a small fixture.

| # | Case | Test |
|---|---|---|
| 20 | Names of the same model link (`Claude Haiku 4.5 (20251001)` = `anthropic/claude-haiku-4.5`, `Gemma 4 31B` = `google/gemma-4-31b-it:free`, dates and `(High)` removed) | `test_names_of_the_same_model_normalise_to_the_same_key` |
| 21 | Different models never link (`-1017` against the 0910 version, `-exp`, `-chat`, `-pro`) | `test_different_models_never_share_a_key` |
| 22 | Variants (`High`, `Low`, `Max`) count as one model with the lowest rating | `test_variants_count_as_one_model_with_the_lowest_rating` |
| 23 | Too few votes or too wide an interval: the next category is used | `test_an_uncertain_category_falls_to_the_next_one` |
| 24 | Reasoning is the lower of math and hard prompts | `test_reasoning_takes_the_lower_of_math_and_hard_prompts` |
| 25 | Tools: from agent data when present, else at most level 2 | `test_tools_are_capped_at_2_without_agent_data_and_use_it_when_present` |
| 26 | Reliability from factuality when present | `test_factuality_decides_reliability_when_present` |
| 27 | Confirmed links are used; blocked ids never link | `test_confirmed_links_are_used_and_blocked_ids_never_link` |
| 28 | Every level names LMArena, the date and CC BY 4.0, status provisional | `test_the_source_names_lmarena_the_date_and_the_licence` |
| 29 | Thresholds come from the frozen `arena-mapping-1`, never recomputed | `test_thresholds_come_from_the_frozen_mapping` |
| 30 | Order of sources: measured beats LMArena; LMArena beats Artificial Analysis | `test_measured_levels_beat_lmarena_and_lmarena_beats_artificial_analysis` |
| 31 | A model rated only by LMArena gets price and context from the OpenRouter snapshot | `test_a_model_rated_only_by_lmarena_gets_a_card_with_openrouter_facts` |
| 32 | **Every model in `most-used.json` has levels** (the most used models in the world) | `test_most_used_models_have_levels` |
| 33 | The committed mapping reads a committed snapshot with the licence | `test_the_committed_mapping_reads_a_committed_snapshot` |
| 34 | A model that left the leaderboard keeps its levels for 180 days, then loses them | `test_a_model_that_left_the_leaderboard_keeps_its_last_entries` |
| 35 | An outcome records where the levels came from (`levels_source`), also for a model without a catalogue card | `test_an_outcome_records_where_the_levels_came_from` (`test_task_outcomes.py`) |
| 36 | The calibration report groups outcomes by source | `test_outcomes_are_grouped_by_the_source_of_the_levels` (`test_calibration.py`) |

Run: `uv run pytest backend/tests/test_arena.py -q`.

## 1c. The project's evaluation key (`backend/tests/test_evaluations.py`, A10 layer 3)

| # | Case | Test |
|---|---|---|
| 37 | Without the key nothing happens | `test_without_the_project_key_layer_3_does_nothing` |
| 38 | Order: most used without a public source first, then free models; paid ones only with `ADAPTAI_EVALUATION_PAID` | `test_project_targets_are_models_without_public_levels_free_first` |
| 39 | A project run uses the project key and the model, costs 0 for a free model, and every user gets the measured levels | `test_a_project_run_uses_the_project_key_and_its_result_is_shared` |
| 40 | The daily call limit holds | `test_project_runs_stay_within_the_daily_calls` |
| 41 | A paid run needs the budget for its guaranteed maximum; an unknown price never runs | `test_paid_project_runs_need_the_budget_for_their_maximum` |
| 42 | No credit or a daily limit: the run stops after 5 refused calls, that model waits a day, the next one is tried | `test_a_refused_run_stops_early_and_waits_a_day` |
| 43 | A restart puts a project run back in the queue | `test_a_restart_requeues_project_runs` |

## 1d. Two roles: the assessor and the chat model (`backend/tests/test_assessor.py`, A11)

| # | Case | Test |
|---|---|---|
| 44 | `llm-options` names the assessor and its chain | `test_the_options_name_the_assessor_and_its_chain` |
| 45 | With an OpenRouter chat model, the analysis still uses the project assessor | `test_the_analysis_uses_the_assessor_whatever_the_chat_model_is` |
| 46 | The assessor hits a limit: the next one answers, the analysis says so, the limited one is skipped next time | `test_a_limited_assessor_hands_over_to_the_next_one_and_says_so` |
| 47 | A wrong answer (invalid JSON) is not handed over | `test_a_wrong_answer_is_not_handed_over` |
| 48 | Every assessor fails: the error is shown | `test_when_every_assessor_fails_the_error_is_shown` |
| 49 | A configuration chosen by hand is never replaced | `test_a_manual_configuration_is_never_replaced` |
| 50 | A model that hit a limit is not recommended for a while, with a note; other failures do not count; the pause ends | `test_a_model_that_hit_a_limit_is_not_recommended_for_a_while` |
| 51 | A chat answer that hits a limit sets the model aside | `test_a_chat_answer_that_hits_a_limit_sets_the_model_aside` |
| 52 | A free model of the user is evaluated with the project key; a paid one with the user's key | `test_a_free_model_of_the_user_is_measured_with_the_project_key` |

## 1e. OpenRouter as a catalogue (`backend/tests/test_openrouter_models.py`, `test_llm_config.py`, A12)

| # | Case | Test |
|---|---|---|
| 53 | OpenRouter needs only the key; the test checks the key without calling a model; other providers still need a model | `test_openrouter_needs_only_the_key` |
| 54 | A personal model's test is one short chat answer (no structured output needed) | `test_connection_test_is_explicit_and_does_not_save_tasks` |
| 55 | Every catalogue model says its state (Public ranking, Not evaluated…) | `test_every_catalogue_model_says_its_state` |
| 56 | A better rated OpenRouter model is suggested once, with the reason, outside the user's own models | `test_a_better_model_on_openrouter_is_suggested_once` |
| 57 | Never a dearer price band than the user's own models | `test_never_a_dearer_band_than_the_users_own` |
| 58 | No OpenRouter configuration, no suggestion | `test_no_openrouter_no_suggestion` |
| 59 | No suggestion when the user's model covers the task (a free project model is never beaten "for less") | `test_no_suggestion_when_the_users_model_covers_the_task` |
| 60 | The pool is every chat model of the snapshot (no music or image generators) | `test_the_pool_is_every_chat_model_of_the_snapshot` |
| 61 | Models without structured output can be chosen for the chat | `test_non_conversation_models_are_not_selectable_and_say_why` (`test_openrouter.py`) |

## 2. Browser tests (`e2e/evaluations.spec.ts`, fake evaluator in `e2e/server.py`)

| Test | Checks |
|---|---|
| Paid model | The consent shows what, how, the cost with "never more than", what declining means; after "Evaluate" the model shows "Measured by AdaptAI" and its levels |
| Unknown price | "price unknown", the second confirmation, then the evaluation |
| OpenRouter model | "Add an OpenRouter model": a paid catalogue model shows the consent with its cost; "Remove from my models" removes it |
| Assessor (`e2e/openrouter.spec.ts`) | With an OpenRouter chat model, Analyse sends no configuration (the project assessor); the notice says where Analyse and Send go; the drawer says "Task assessed by openai/gpt-oss-20b" |
| Model at its limit (`e2e/openrouter.spec.ts`) | The answer fails with "rate limit"; "Send with openai/gpt-oss-20b" answers; the chat model becomes Auto; the next analysis says "Not recommended now" |
| In a public ranking (`e2e/coverage.spec.ts`) | Adding `anthropic/claude-opus-5.5` shows LMArena levels at once; after "Not now" it says "Not measured · Provisional (LMArena…)" and the analysis compares it |
| Free, no public source (`e2e/coverage.spec.ts`) | `acme/gratis` is evaluated without asking ("Measured by AdaptAI") and then compared |
| Paid, no public source (`e2e/coverage.spec.ts`) | `vendor/premium` after "Not now": no levels, not compared, but the chat answers with it at once; after "Evaluate" it is measured and compared |
| Provider refuses (`e2e/coverage.spec.ts`) | `acme/limited:free` fails with "The provider refused the calls" and offers "Re-evaluate" |
| Key only (`e2e/openrouter-models.spec.ts`) | Connect OpenRouter with no model; Test connection says "the key is valid (no model was called)"; Send stays disabled until a model is chosen |
| States and Evaluate (`e2e/openrouter-models.spec.ts`) | Claude Opus 5.5 shows "Public ranking", `acme/novel` "Not evaluated"; "Evaluate" adds it, LLM config shows it measured |
| Suggestion (`e2e/openrouter-models.spec.ts`) | With a key-only OpenRouter and a task the server model falls short on, "Also on OpenRouter" names a rated model with the reason; "Use this model" selects it |
| Recommendation (`e2e/feedback.spec.ts`) | The Groq server model is recommended with "Levels from: LMArena public ranking … (CC BY 4.0), provisional"; "Use this model" works |

## 3. Manual check with real keys

Start the app (PostgreSQL, backend, frontend) with the Groq key in `.env`. Each step lists
what you should see in LLM config › "How your models were evaluated".

| # | Step | Expected |
|---|---|---|
| 1 | Open LLM config | `openai/gpt-oss-20b` (Groq, project) shows "Evaluating… n/40", then "Measured by AdaptAI" with five levels. No question asked |
| 2 | Add OpenRouter with `google/gemma-4-31b-it:free` | Evaluated at once (free), no question |
| 2b | In the chat, pick another OpenRouter model (for example `google/gemma-4-26b-a4b-it:free`) and send a message | It appears in LLM config as evaluating; when done it can be recommended, and "Use this model" selects the configuration and that model |
| 3 | Sign in with another account and add the same Gemma | Already "Measured by AdaptAI", no new run |
| 4 | Add OpenRouter or OpenAI with GPT-5.4 mini (paid) | The consent with the cost in cents and the maximum. Choose "Not now": status "Not evaluated", but its levels show "Provisional (LMArena public ranking, CC BY 4.0)" and it can be recommended. A paid model no public source has (step 13) is not recommended until evaluated |
| 5 | Same model: "Evaluate" | Runs in the background; you can use the chat meanwhile |
| 6 | Compare with your provider's usage page | The real cost is between zero and the maximum shown, close to the estimate |
| 7 | "Show examples" and "Disagree" on one level | Examples of answers; "Noted…" and the level does not change |
| 8 | Analyse a task in the chat | The recommendation names one of the evaluated models; "Use this model" selects it |
| 9 | Stop the backend during an evaluation and start it again | A free run starts again by itself; a paid run shows "Evaluation failed" (interrupted) and waits for you to press "Re-evaluate", so nothing is charged twice without your consent |

| 10 | Before Groq finishes measuring (or with the worker off: `ADAPTAI_EVALUATIONS_WORKER=false`), analyse a task | The recommendation already names `GPT-OSS 20B` with "Levels from: LMArena public ranking of 2026-11-06 (CC BY 4.0), provisional"; no "Not in this recommendation yet" note for it |
| 11 | When Groq's measurement finishes, analyse again | "Levels from: Measured by AdaptAI": measured beats the public ranking |
| 12 | In the chat, pick a popular OpenRouter model never configured (for example `openai/gpt-6-luna`), send, then analyse | It is compared at once with LMArena levels, without waiting for an evaluation |
| 13 | Pick `deepseek/deepseek-v4.1-flash-1017` | Levels "Provisional (Artificial Analysis overall index)": LMArena does not have this version |
| 14 | Mark a task solved after using that model, then run `uv run python scripts/calibration_report.py` | The report has "Outcomes by source of the levels" with a row `arena` |

Report each step as OK or with the screenshot of what differed.

## 4. Keeping the public levels current (team routine, weekly)

| Step | Command or place | Check |
|---|---|---|
| 1 | GitHub › Actions › "Catalogue sources" › Run workflow on a new branch `data/sources-<date>` (or push that branch) | The run is green; the branch gets `sources/lmarena-<date>.json`, `aa-<date>.json`, `openrouter-<date>.json` |
| 2 | Locally on that branch: `uv run python scripts/build_arena_mapping.py --snapshot sources/lmarena-<date>.json` | "thresholds unchanged"; `arena-mapping-1.json` now points to the new file |
| 3 | Update `backend/data/catalogue/most-used.json` from https://openrouter.ai/rankings (monthly) | New top models listed |
| 4 | `uv run pytest backend/tests/test_arena.py -q` | Green. If `test_most_used_models_have_levels` fails, it names the models: add a checked link to `arena-aliases.json` or `aa-aliases.json`, or move them to `no_public_source` with the reason (layer 3 measures them) |
| 5 | Pull request to `develop` | The diff shows which ratings changed; a reviewer checks every new link |

If the workflow fails with "Refused", the dataset became gated, changed licence or columns:
nothing is written and the levels in force stay as they are.

## 5. Levels for every model, on your computer (step by step)

What you get: public levels at once for 227 OpenRouter models and the most used ones; measured
levels for every model you configure or pick; measured levels, about one a day, for the free
models and the most used ones no public source rates. The other 223 paid models get levels when
someone uses them, or with bought credit (section "Layer 3" of
[`plan-model-coverage.md`](plan-model-coverage.md)).

| # | Do | Expected |
|---|---|---|
| 1 | `git fetch && git checkout agent/model-coverage-plan && git pull` | Up to date |
| 2 | `uv sync --locked`, then `cd frontend && pnpm install --frozen-lockfile && cd ..` (pnpm, not npm) | No errors |
| 3 | PostgreSQL running (as before) | `pg_isready` answers |
| 4 | `grep -c '^ADAPTAI_EVALUATION_OPENROUTER_KEY=.' .env` | `1` (the key is set; it is never printed) |
| 5 | `uv run pytest backend -q` | All pass |
| 6 | Backend: `uv run python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000`; second terminal: `cd frontend && pnpm dev --host 127.0.0.1` | The app opens |
| 7 | After a few minutes (your own models go first): `uv run python scripts/project_evaluations.py` | "Project key set: yes"; a run for `stealth/crouton-alpha`, `running` with n/40 calls; spend 0 |
| 8 | In LLM config, add or check your configurations (Groq server models are already there; add OpenRouter with your own key and pick the models you use) | Each model shows "Evaluating…" then "Measured by AdaptAI"; a paid one asks for consent first with the cost |
| 9 | Leave the backend running (the computer awake) | The project key measures one model a day; run step 7 each day to follow it |
| 10 | Analyse a task in the chat | The drawer shows the recommended model and "Levels from: …" (Measured by AdaptAI, LMArena or Artificial Analysis) |
| 11 | "Use this model", then Send | The answer shows that model's name |
| 12 | "✓ Task solved", answer Yes or No | Saved; `uv run python scripts/calibration_report.py` lists it by source |
| 13 | openrouter.ai › Activity, filtered by the evaluation key | Requests for free models only, cost 0.00 |
| 13b | With your OpenRouter Gemma as chat model, select Analyse | It works: "Task assessed by openai/gpt-oss-20b"; the notice says Analyse goes to groq and Send to openrouter |
| 13c | Send with Gemma when its daily limit is reached | The answer shows the limit and a "Send with openai/gpt-oss-20b" button; it answers; the next analysis says "Not recommended now: … Gemma" |
| 14 | Once `stealth/crouton-alpha` is `done`: analyse a task with an OpenRouter configuration and pick that model | Its levels say "Measured by AdaptAI" |

If step 7 shows `provider_refused`: OpenRouter refused the calls (daily limit reached, or the
model needs credit). Nothing to do; that model waits a day and the next one is tried.

## 6. OpenRouter as a catalogue (A12), on your computer

| # | Do | Expected |
|---|---|---|
| 1 | LLM config › OpenRouter › Edit (or Remove and connect again) with only the key, the default model empty | Saved; the card says "No default model · any model of the catalogue in the chat" |
| 2 | Test connection | "the key is valid (no model was called)"; nothing appears in OpenRouter's activity |
| 3 | Assistant › Chat model › your OpenRouter configuration | The OpenRouter list says "Choose a model"; Send is disabled until you pick one |
| 4 | Open the OpenRouter list | Each model shows its state: Claude Opus 5.5 "Public ranking", your Gemma "Measured" or "Evaluating", a new model "Not evaluated" with "Evaluate" |
| 5 | "Evaluate" on a free model with no state | "Added: see LLM config"; LLM config shows it "Evaluating…" then "Measured by AdaptAI" (it uses the project key, so not your chat quota) |
| 6 | The Chat model list | Your models show their state next to the name |
| 7 | Analyse a demanding task (for example a legal or financial analysis with constraints) | If one of the catalogue's rated models covers what your models fall short on, "Also on OpenRouter" names it with the reason, the price band and where its levels come from |
| 8 | "Use this model" on the suggestion, then Send | The OpenRouter list shows that model; the answer comes from it; it then appears among your models |
| 9 | Analyse a simple task | No suggestion: your model already covers it |
