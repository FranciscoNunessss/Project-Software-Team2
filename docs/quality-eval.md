# Quality evaluation: runner and regression gate

Card: "Evaluation runner + quality-eval regression gate in CI". Prepared with AI assistance (Claude,
Anthropic); human review pending.

## What it is, and what it is not

A **quality eval** gives a real model the tasks of a labelled set and scores its answers against the
expected levels. A **contract test** (everything in `backend/tests` that uses a fake model) checks
that the code keeps its promises. They are kept apart on purpose: a green test suite says nothing
about whether the profile is right.

| Part | File |
|---|---|
| Labelled task set (24 tasks, 85 labelled cells, rubric-2.0) | `backend/eval/quality/tasks-1.json` |
| Scoring and the gate (pure functions) | `backend/app/quality_eval.py` |
| Runner and comparison | `scripts/run_quality_eval.py` |
| Baseline per model | `backend/eval/quality/baselines/<provider>_<model>.json` |
| ADR acceptances of a drop | `backend/eval/quality/accepted.json` |
| CI | `.github/workflows/quality-eval.yml` |
| Tests of the arithmetic and the gate (logic only) | `backend/tests/test_quality_eval.py` |

**The task set is a draft.** Its expected levels are one reader's application of rubric-2.0 and only
clear-cut dimensions are labelled. The labelled set of 20 tasks (card OI-8) replaces it when two
reviewers agree on it; the runner takes the file name from one constant (`TASKS`). Until then the
numbers measure agreement with that reading, not truth.

## What a run records

Date, commit, provider and model, version of the task set, mode (subset or full), repeats, and the
profile, rubric, policy and catalogue versions. Per analysis: task id, the levels, the confidence,
seconds and tokens when the provider reports them. Overall and per dimension: agreement (exact),
within one level, mean absolute error, undetermined, failed analyses. **A report never holds the
text of a task**; reports are not committed (`backend/eval/quality/reports/`), CI keeps them as an
artifact for 30 days.

An undetermined level counts as a disagreement: the gate must not reward a model that declines to
answer.

## The gate

* A pull request that touches the assessment, the prompt builder, the recommendation, the workflow,
  the rubric, the catalogue or the eval files runs the **subset** (8 tasks, 1 repeat). The full set
  (3 repeats) runs by hand (`workflow_dispatch`, "full") before a milestone.
* The overall agreement is compared with the baseline of the same model. **A drop of more than 5
  percentage points fails the job**, unless `accepted.json` has an entry for that model and rubric
  that names the ADR where the Architecture Owner accepted it.
* The comparison needs the same task set, rubric and model. Otherwise the verdict is "not
  comparable" and the baseline must be rebuilt.
* **Provider outage or no key: NOT RUN.** More than 10% of analyses failing, or no analysis at all,
  is reported as NOT RUN with a warning and in the job summary; it is never worded as a pass.
  Without the `GROQ_API_KEY` secret the job always says NOT RUN.

Exit codes of the script: 0 passed, accepted or no baseline yet; 1 regression; 3 NOT RUN.

## Use

```bash
python scripts/run_quality_eval.py run --provider groq --model openai/gpt-oss-120b --subset
python scripts/run_quality_eval.py run --provider groq --model openai/gpt-oss-120b --repeats 3 --update-baseline
python scripts/run_quality_eval.py compare backend/eval/quality/reports/<file>.json
```

`--update-baseline` only writes a baseline from a full, measured run. Commit the baseline in the
pull request that makes it, so the team reviews the number it will be held to.

## State on 17 November 2026

| Check | Result |
|---|---|
| Logic tests | 11 pass (`test_quality_eval.py`) |
| Live run on LM Studio (Gemma 12B, subset) | 8 of 8 analyses, 81.5% agreement over 27 cells, no baseline yet |
| For comparison, the study of 15 November (full set, 3 repeats) | 83% for the same model |
| **No baseline is committed for Groq** | It needs a full run with the team's key; nobody has run it |
| The `GROQ_API_KEY` secret | Not added by this change: until it is, CI says NOT RUN |

## Decisions that belong to the team

1. Add the `GROQ_API_KEY` secret to the repository (the free quota is 8000 tokens per minute: a
   subset run uses about 8 analyses, 20 000 tokens, over several minutes).
2. Run the full set once with the team's key and commit the baseline.
3. Make the job a required check only after step 2, otherwise every such pull request is blocked or
   shows NOT RUN.
4. Replace the draft task set with the labelled set (OI-8) and rebuild the baseline.
5. The recommendation is Python and deterministic; this eval measures the profile (the assessor).
   A second eval of the recommendation against labelled "right model" answers needs the same
   labelled set and is not built here.
