# Testing the automatic model evaluation (ADR-014 A8, A9)

Three layers. The first two run in CI on every pull request and cost nothing; the third is
a manual check with real keys (about 30 minutes, under 1 USD).

## 1. Backend tests (`backend/tests/test_evaluations.py`, fake models)

| # | Case | Test |
|---|---|---|
| 1 | Free (server) model: evaluated without asking | `test_server_model_is_evaluated_without_consent_and_then_recommended` |
| 2 | Already evaluated: reused by every user, no new calls | `test_an_evaluated_model_is_reused_by_every_user_without_new_calls` |
| 3 | Paid model with the user's key: waits for consent, estimate < maximum, no call before consent | `test_a_paid_model_waits_for_consent_with_an_estimate_and_a_maximum` |
| 4 | Declined: still usable in the chat, never recommended | `test_a_declined_model_stays_usable_but_is_not_recommended` |
| 5 | Unknown price: second confirmation required | `test_an_unknown_price_needs_a_second_confirmation` |
| 6 | Spending reaches the maximum: the run stops | `test_the_run_stops_at_the_guaranteed_maximum` |
| 7 | More than 10% failed calls: discarded | `test_too_many_failed_calls_discard_the_run` |
| 8 | Rate limits: retried, the run finishes | `test_rate_limits_are_retried_and_the_run_finishes` |
| 9 | Two requests at the same time: one run | `test_concurrent_requests_open_a_single_run` |
| 10 | Local models: per user, never shared | `test_local_models_are_evaluated_per_user` |
| 11 | New suite version: new run | `test_a_new_suite_version_needs_a_new_run` |
| 12 | Configuration deleted: gone from the user's list, shared result kept | `test_deleting_a_configuration_removes_it_from_the_users_list` |
| 13 | Artificial Analysis as fallback, with its source | `test_artificial_analysis_is_the_fallback_for_unmeasured_models` |
| 14 | Family inheritance: lowest level, provisional; families do not mix | `test_family_inheritance_takes_the_lowest_measured_levels` |
| 15 | Calibrated levels win over measured ones | `test_calibrated_levels_win` |
| 16 | A finished evaluation enters the next recommendation | case 1 |
| 17 | Restart during a run: free runs retried, paid ones failed (no charge without consent) | `test_a_restart_retries_free_runs_and_fails_paid_ones` |
| 18 | A model picked in the chat (OpenRouter) is evaluated on first use and then compared with how to use it | `test_a_model_picked_in_the_chat_is_evaluated_and_then_recommended` |
| 19 | OpenRouter models added and removed in LLM config; unknown ids refused; disabling the configuration removes them | `test_openrouter_models_can_be_added_and_removed_from_the_evaluations` |
| + | Adaptive levels and cost bounds; inventory only of enabled configurations; "Disagree" changes nothing; a weak capability gets a low level | remaining tests |

Run them with PostgreSQL up: `uv run pytest backend/tests/test_evaluations.py -q`.

## 2. Browser tests (`e2e/evaluations.spec.ts`, fake evaluator in `e2e/server.py`)

| Test | Checks |
|---|---|
| Paid model | The consent shows what, how, the cost with "never more than", what declining means; after "Evaluate" the model shows "Measured by AdaptAI" and its levels |
| Unknown price | "price unknown", the second confirmation, then the evaluation |
| OpenRouter model | "Add an OpenRouter model": a paid catalogue model shows the consent with its cost; "Remove from my models" removes it |

## 3. Manual check with real keys

Start the app (PostgreSQL, backend, frontend) with the Groq key in `.env`. Each step lists
what you should see in LLM config › "How your models were evaluated".

| # | Step | Expected |
|---|---|---|
| 1 | Open LLM config | `openai/gpt-oss-20b` (Groq, project) shows "Evaluating… n/40", then "Measured by AdaptAI" with five levels. No question asked |
| 2 | Add OpenRouter with `google/gemma-4-31b-it:free` | Evaluated at once (free), no question |
| 2b | In the chat, pick another OpenRouter model (for example `google/gemma-4-26b-a4b-it:free`) and send a message | It appears in LLM config as evaluating; when done it can be recommended, and "Use this model" selects the configuration and that model |
| 3 | Sign in with another account and add the same Gemma | Already "Measured by AdaptAI", no new run |
| 4 | Add OpenRouter or OpenAI with GPT-5.4 mini (paid) | The consent with the cost in cents and the maximum. Choose "Not now": status "Not evaluated"; the model works in the chat but is not recommended |
| 5 | Same model: "Evaluate" | Runs in the background; you can use the chat meanwhile |
| 6 | Compare with your provider's usage page | The real cost is between zero and the maximum shown, close to the estimate |
| 7 | "Show examples" and "Disagree" on one level | Examples of answers; "Noted…" and the level does not change |
| 8 | Analyse a task in the chat | The recommendation names one of the evaluated models; "Use this model" selects it |
| 9 | Stop the backend during an evaluation and start it again | A free run starts again by itself; a paid run shows "Evaluation failed" (interrupted) and waits for you to press "Re-evaluate", so nothing is charged twice without your consent |

Report each step as OK or with the screenshot of what differed.
