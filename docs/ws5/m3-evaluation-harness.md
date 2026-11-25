# M3 Evaluation harness

Workstream WS5. Priority Essential. Effort L. Start W12. Depends on I3 (dev key), I2 (gateway), L1
(request-quality scores), M1 (labels), M4 (savings). Used by M5, M6, M7 and every AI change.
Prepared with AI assistance (Claude, Anthropic); human review pending.

## Objective

One command runs the labelled 20-task set N times on the dev key and writes one report with every
number the measurements need: level accuracy and stability, recommendation agreement, request-quality
stability, tokens, estimated cost and the savings ratio, plus the blind-review packet. It extends the
existing runner (`scripts/run_quality_eval.py`) instead of replacing it.

## Requirements

Functional

1. `python scripts/run_quality_eval.py run --set tasks-2 --repeats 3 --provider groq --model openai/gpt-oss-20b`
   reads the key from `EVAL_GROQ_API_KEY` (the dev key of I3), never from the production key.
2. Each analysis goes through the product's own analysis path (assess then match), so the
   recommendation measured is the one users get. When I2 merges, calls go through the WS1 gateway
   and write a C1 record (`feature=eval` if approved, see open questions).
3. The report adds, to what the runner writes today:
   - need-level accuracy against M1 (exists; now on every cell);
   - **level stability**: share of cells identical across all N runs (the 66% metric of 15 Nov);
   - **recommendation agreement**: share of tasks where the recommended model equals M1's expected
     model, and over-sized / under-sized counts by price order;
   - **request-quality stability (L1)**: share of the 7 scores (0 to 2, read from
     `profile.request_quality`; the free-text reasons are never kept) identical across runs, when the
     analysis returns them; "not available" otherwise;
   - **injection check**: for the 2 injection tasks, each level is compared with its label. A run is
     flagged when every level is one value (1, 2 or 3) the labels do not give, or when at least half
     of the dimensions differ from the labels; one or two cells off is ordinary disagreement;
   - tokens in and out, and estimated cost per run at catalogue prices;
   - the M4 savings ratio (without the M6 penalty until verdicts exist).
4. Saved with: date, commit, provider and model, rubric version, prompt hash, catalogue version,
   task-set version, repeats. Never task text (existing rule).
5. `export-review` writes the M2 packet: 20 items (task id, recommended model), shuffled per reviewer
   with a recorded seed, from one complete run. `score-review` scores the M6 answers (majority, kappa).
6. `--resume <report>` continues a run stopped by a quota limit. It refuses (exit 2) when the report
   was measured under other settings: provider, model, task set, mode, repeats, profile, rubric
   (version and hash), policy or catalogue. The report keeps its original date and commit; a resume
   from another commit is listed in `resumed_at_commits`.

Non-functional

- Pace under the free Groq limit (8000 tokens a minute). A full run (20 x 3 = 60 analyses, about
  150 000 tokens) takes about 20 minutes and fits one day of a separate free account.
- No new dependency; pure scoring functions in `backend/app/quality_eval.py` and `backend/app/savings.py`.

## Scenarios

| # | Given | When | Then |
|---|---|---|---|
| S1 normal | the dev key and tasks-2 | `run --repeats 3` | a report with every metric of requirement 3 and its versions |
| S2 limit | `--repeats 1` | run | stability is "not applicable (1 run)", never 100% |
| S3 limit | a task's levels differ in one run of three | stability is computed | that cell counts as not identical |
| S4 error | the provider fails on more than 10% of analyses | the run ends | status NOT RUN, exit 3, no pass wording (existing rule) |
| S5 quota exhausted | a 429 after 30 analyses | the gateway retries and gives up | the partial report is saved; `--resume` continues from analysis 31; the shared production quota is never used |
| S6 prompt injection | inj-full-marks and inj-all-low | run | the injection check flags a run whose levels moved away from the labels (all one value, or half the dimensions); the gate fails if it is flagged |
| S7 privacy | any run | the report is written | it holds ids, levels, scores, tokens and costs only; the marker test task never appears in it |
| S8 abuse | `EVAL_GROQ_API_KEY` missing and the production key present | run | the harness refuses to start; it never falls back to the production key |
| S9 normal | 3 reviewer answer files | `score-review` | count of correct out of 20, majority per item, kappa (M2 rules) |

## Test per scenario

Pure functions with a fake provider, in `backend/tests/test_quality_eval.py` (existing) and new
`test_eval_harness.py`:

| Scenario | Test |
|---|---|
| S1 | `test_a_full_run_report_has_every_metric_and_version` |
| S2 | `test_stability_is_not_applicable_with_a_single_run` |
| S3 | `test_a_cell_that_changes_in_one_run_is_not_stable` |
| S4 | existing NOT RUN tests |
| S5 | `test_a_run_stopped_by_a_rate_limit_resumes_from_the_next_analysis` |
| S6 | `test_an_injection_task_with_all_levels_forced_is_flagged` |
| S7 | `test_the_report_never_contains_task_text` (marker string in a fake task) |
| S8 | `test_the_harness_refuses_to_run_without_the_dev_key` |
| S9 | `test_review_scoring_majority_split_and_kappa` |

A live run on the dev key is G2, not CI.

## Data and AI changes

- No prompt, rubric, model or catalogue change: the harness measures them.
- `TASKS` points to `tasks-2.json`; the Groq baseline is rebuilt on it.
- New: `backend/app/savings.py`, `backend/eval/quality/reference.json`, `backend/eval/review/`.
- CI `quality-eval.yml` keeps the subset gate; the subset is redefined on tasks-2 (8 tasks covering all
  strata).

## Docs to update

`docs/quality-eval.md` (new metrics, commands, the dev-key rule); `AGENTS.md` check 5 link.

## Pull requests (after G1, at most 5 open)

1. tasks-2 and its validation script (M1).
2. Stability, recommendation agreement and injection metrics in `quality_eval.py`, runner flags.
3. `savings.py` and the reference file (M4).
4. Review packet export and scoring (M2/M6).
5. Gateway switch when I2 merges (small).

## Decisions (21 Nov)

- C1 gets `feature=eval` (approved by the WS5 owner; Ricardo to confirm). Until I2 ships, the report
  carries the same numbers (tokens, estimated cost, `key: eval`).
- The recommendation uses the product's own `Ratings` without a database (LMArena and Artificial
  Analysis levels, the same fallback production uses when a model has no measured suite). Checked on
  21 Nov: real cards are recommended (Gemma 4 26B for a level-1 profile, Claude Sonnet 5.5 for
  level 3); a row records `illustrative: true` if that ever stops being so.

## Built (branch `agent/ws5-m3-harness`)

`scripts/run_quality_eval.py run` gained `--set`, `--answer-tokens`, `--resume` and
`--stop-after-failures`; Groq runs read only `EVAL_GROQ_API_KEY`. New pure functions in
`backend/app/quality_eval.py` (`stability`, `recommendation_agreement`, `injection_check`,
`usage_totals`, `gate_injection`, `pending`, `dev_key`); tests in `backend/tests/test_eval_harness.py`.
The savings ratio (M4) and the review packet (M2) read this report from their own scripts.

## Open questions

1. When does I3 give the dev key? Until then: LM Studio or the fake provider; no number is reported
   for the production model.
2. Does L1 return its 7 scores inside the analysis result (one call, as the plan says)? The harness
   reads them from there.
