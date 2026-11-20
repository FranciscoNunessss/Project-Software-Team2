# Evaluation of the Educator's pattern sentence (05 section 7.6)

17 November 2026. Prepared with AI assistance (Claude, Anthropic); human review pending. Card:
"Evaluate the Educator pattern sentence (PR #60) before the next release". Runner:
`scripts/run_educator_eval.py`. Report: `backend/eval/educator/reports/`.

## What was asked

PR #60 adds `PATTERN_SENTENCE` to the Educator prompt (policy `progress-5` with #66). A prompt change
needs an evaluation (05 section 7.6) and none had been run. The check: the model's text never
contradicts the verdict that Python decided (`detected`, `not_detected`, `insufficient_history`).

## What was run

- The ten synthetic usage histories of #60 (`backend/tests/usage_histories.py`): three patterns, seven
  controls. Each is turned into what the Educator receives (counts, the Python verdict, no task text).
- **Model: `gemma4-12b-qat-uncensored-hauhaucs-balanced` on a local LM Studio, 2 repeats = 20 runs, all
  measured, 0 failed.** This is **not the production model** (Groq `gpt-oss-20b`): no Groq key was
  available. Repeat this run with the production model before relying on the result.
- The model sees the full prompt of `educator_prompt()`. `apply_verdicts` (#66) is not applied in the
  runner, so the raw text is judged, including the text Python would have replaced.

## How the text is checked

`summary` and the lessons (`suggestions`) are never replaced by `apply_verdicts`, so they are the text
that can contradict a verdict. A sentence is flagged when it mentions over- or under-provisioning
without a negation or a condition while the rule did not detect that pattern. A detected pattern is
also checked for the opposite claim. The flags are a filter for a person to read, not a verdict, and
the filter cannot see a hedge that avoids the key words ("patterns are still emerging").

## Result

| | |
|---|---|
| Runs measured | 20 of 20 |
| Flagged by the filter | 4 runs (6 flagged sentences) |
| Read by hand: false positives | 3 runs. General advice ("understanding the task helps prevent choosing a model that is too large or too small"), and one definition ("a choice gap of 1 means larger than recommended") |
| Read by hand: a mild contradiction | 1 run (`control_split_both_ways`, repeat 0): "these patterns are in the early stages of detection", where the rule says no pattern |
| Pattern histories (3, 6 runs) | No flag. The model described the detected pattern and did not claim the other |
| **Not caught by the filter** | In **4 of the 8** runs on `not_detected` histories the summary says patterns are "still emerging" or "have not yet fully emerged" (for example 10 of 10 choices following the recommendation, called "small"). The rule says "no pattern shows in this sample"; the model hedges that one might be forming. Not a false claim of a pattern, but not the sentence the prompt asks for |

## What this means

- **No hard contradiction was found**: the model never said a person over-provisions when the rule said
  it does not, in 20 runs on a 12B local model.
- **A soft one is common** (hedging in half the `not_detected` runs), and it sits in the `summary`,
  which #66 does not replace. The impact is limited, as the card said, but it is not zero.
- **A way to close it, not done here** (a prompt change needs its own evaluation, so it is the author
  of #60's call): add to `PATTERN_SENTENCE` that for a `not_detected` pattern the summary must not say a
  pattern is emerging, forming or in an early stage; or let Python write the summary line about the two
  choice patterns, as it already does for their explanations.

## Limits

One model, not the production one; 2 repeats; histories without a task text, so the model's text
cannot refer to a task; the prompt of the extensions (Prompt Coach and others) is not included; the
judgement of the 4 flags is one reader's (the author's), and a second reader should check them. The
rubric for "contradiction" is not defined in 05, this evaluation proposes the one above.

## Re-run

```bash
python scripts/run_educator_eval.py --provider groq --model openai/gpt-oss-20b --repeats 3
```

Exit code 1 when anything is flagged (read the flags), 3 when nothing could be measured.
