# M4 Savings method for KR1.2

Workstream WS5. Priority Essential. Effort M. Start W12. Depends on C1 (WS1). Used by M7, L7 (WS4).
KR1.2: "Following the recommendations costs at most half of always using the top tier."
Prepared with AI assistance (Claude, Anthropic); human review pending.

## Objective

A written, repeatable method that turns real token counts and dated prices into one number, the cost
of following AdaptAI's recommendations as a share of always using a fixed top model, with a quality
check so a cheap recommendation that fails does not count as a saving.

## The method

**1. Reference top model (assumption D4: cost by default).** `claude-sonnet-5-5`, the most expensive
concrete card in the active catalogue, at catalogue-2.1 prices observed on 6 Nov 2026 (USD 2.00 in,
10.00 out per million tokens, OpenRouter). The model, prices and date are frozen at the AI freeze
(end of W13) and printed on every result.

**2. Population.** Primary: the 20 tasks of the M1 set, one recommendation each from the M5 run.
Secondary (reported apart, never mixed): C1 records of the client preview in W14, `key_owner` and
`surface` included, `feature` in analysis/chat/ide_chat.

**3. Token counts.** Real counts reported by the provider, never estimated from text length. The
harness (M3, `--answer-tokens`) sends each task once to the production model on the dev key and keeps
the provider's counts; with the same-token estimator the model that produced them only weights the
tasks, it does not change which side is cheaper:

- Input tokens: the provider's count for the task sent to the recommended model.
- Output tokens: the provider's count for that model's answer.
- The top model is priced on **the same** input and output counts (same-token estimator). This keeps
  the method free (decision D2). It favours neither side on input; on output it assumes the top model
  writes as much as the cheap one, so a sensitivity line also prices the top model at 1.5x output.

**4. Cost per task.** `cost(m) = tokens_in x price_in(m) + tokens_out x price_out(m)`, prices per
token from the frozen catalogue. A local model (LM Studio, Ollama) costs 0 and is flagged. A free
Groq call is still priced at its catalogue price (C1 rule: "cost at dated catalog prices, even when the
call was free"), so free quota does not fake a saving.

**5. Quality check (cheap must not mean worse).** Uses the M6 blind-review verdict per task:

| Verdict | Cost counted for "following the recommendation" |
|---|---|
| Correct (A or B) | cost of the recommended model |
| Over-sized (C) | cost of the recommended model (a quality-safe but smaller saving) |
| Under-sized (D) | cost of the recommended model **plus** the top model's cost (the retry the user would need) |

A task is correct by the M2 rule for KR1.1 (a strict majority of the reviewers who answered said A
or B), so KR1.1 and KR1.2 never classify a task differently. A task that is not correct is
under-sized when at least as many reviewers said D as C (a tie keeps the costlier fault), else
over-sized. Example with 3 reviewers: A, C, D is not correct (1 of 3), and under-sized.

**6. Result.** `ratio = sum(cost following recommendations) / sum(cost of top model) x 100`.
KR1.2 passes at 50% or less. Reported with: the ratio without the quality penalty, the 1.5x
sensitivity, the number of under-sized tasks, the catalogue date, and the currency (USD; the ratio does
not depend on currency). L7 uses steps 3, 4 and 6 per user, without step 5, and says so in its label.

**7. Limits written into the report (M7).** 20 synthetic tasks, not a sample of real use; same-token
assumption; prices of one date; the top model was not run. Answers are capped at 2048 output tokens
(M3); the result lists the answers that reached the cap (`answers_at_token_limit`), whose output
tokens are a floor on both sides.

**Frozen reference.** `reference.json` repeats the top model's prices and date. The script compares
them with that model's card in the active catalogue and stops (exit 2) when they differ, so a
catalogue or reference edited alone cannot change the ratio silently. An incomplete result (a task
with no tokens or price) prints no ratio.

## Requirements

Functional: the method above as a document; a pure function `savings(rows, prices, reference,
verdicts)` in `backend/app/savings.py` (used by L7); rows from M3 reports or C1 records;
`scripts/savings.py <report> [--review score.json]`. Prices on both sides are the catalogue card
prices (OpenRouter, one date), not provider-specific alias prices, so both sides use one source.
Non-functional: no LLM call; no task text in inputs or outputs; free plans only.

## Scenarios

| # | Given | When | Then |
|---|---|---|---|
| S1 normal | 20 rows with tokens, a recommended model each, all verdicts correct | savings runs | ratio = sum of recommended costs / sum of top costs, with the catalogue date |
| S2 limit | the recommended model is the top model on every task | savings runs | ratio is exactly 100% |
| S3 limit | a row uses a local model | savings runs | that row costs 0 and is counted in a "local" line |
| S4 limit | ratio is exactly 50.0% | the KR is judged | it passes (at most half) |
| S5 error | a row has no token counts, or its model has no price in the frozen catalogue | savings runs | the row is excluded, counted as "unpriced", and the result is marked incomplete if any row is unpriced |
| S6 quality | one task is judged under-sized | savings runs | its cost is recommended + top; the report shows the ratio with and without the penalty |
| S7 abuse / injection | an injection task drove the recommendation to the top model | savings runs | it is priced like any other task; the report lists injection tasks separately so the effect is visible |
| S8 privacy | rows from C1 | savings runs | only ids, models, tokens and prices are read; a row with any text field is rejected |
| S9 quota exhausted | M5 ended NOT RUN with missing rows | savings runs | no ratio is reported; the result is NOT RUN, never a partial pass |

## Test per scenario

`backend/tests/test_savings.py`, pure functions with fixed rows: one test per scenario, named per
`docs/test-conventions.md` (for example `test_following_the_top_model_everywhere_costs_exactly_100_percent`,
`test_an_under_sized_task_is_charged_the_retry_on_the_top_model`,
`test_a_missing_price_marks_the_result_incomplete`).

## Data and AI changes

None to prompts, rubric, model or catalogue. No new C1 field. New module `backend/app/savings.py`. The reference model and date live in `backend/eval/quality/reference.json`, committed at the
freeze.

## Docs to update

This method; `docs/quality-eval.md` (link); M7 report; the in-app wording of L7 ("estimated at catalog
prices of <date>").

## Open questions

1. **D4 is the client's.** Default used (decided 21 Nov to proceed with it): cost by default, top = `claude-sonnet-5-5`. Confirm in the
   weekly update.
2. Run the top model for real on the 20 tasks, to replace the same-token assumption? It needs paid
   credits (about 20 short tasks; likely under USD 1, but it is still D2).
3. KR1.2's owner in `okrs.yml` is José Moura; this plan gives the method to WS5. Who updates the KR?
