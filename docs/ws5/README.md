# WS5 Evidence and files: week 12 pack

Owner: Francisco Velhinho. Source of truth: "AdaptAI Release Plan: Weeks 12 to 15" (20 Nov 2026).
Prepared with AI assistance (Claude, Anthropic); human review pending. Nothing here is approved: every
spec below goes to G1 before any code is written.

## Calendar

From `okrs.yml` (week 1 starts Monday 14 Sep 2026), so week 12 is **Mon 30 Nov to Sun 6 Dec**, week 13
is 7 to 13 Dec, week 14 is 14 to 20 Dec, week 15 is 21 to 27 Dec. If the course calendar has a break,
these dates move; the order does not.

## Step 1: inputs per task (W12 tasks)

| Order | Task | Depends on | Ready? | What to do until it is ready |
|---|---|---|---|---|
| 1 | M2 Reviewers and protocol | Nothing | Yes | Start now: longest lead time (people's dates) |
| 2 | M1 Labelled 20-task set | Nothing (two team labellers) | Yes | Start now; the draft set `backend/eval/quality/tasks-1.json` is reused |
| 3 | M4 Savings method | C1 (WS1) for the field part; catalogue prices | Partly | Write the method on the 20-task set now; the C1 part is read from mock records until I2 ships |
| 4 | M3 Evaluation harness | I3 dev key (WS1), I2 gateway (WS1), L1 output (WS4), M1 labels | No | Extend `scripts/run_quality_eval.py`; run on LM Studio or the fake provider; read L1 scores when present; switch to the gateway when I2 merges |

Existing work this builds on (not rebuilt):

- `backend/app/quality_eval.py` and `scripts/run_quality_eval.py`: level agreement, the 5-point gate,
  NOT RUN handling, reports without task text (`docs/quality-eval.md`).
- `docs/analysis-accuracy/`: the 15 Nov study (24 tasks, 288 analyses, stability 66% for gpt-oss-20b).
- `backend/data/catalogue/versions/catalogue-2.1.json`: dated prices (OpenRouter, 6 Nov 2026).

## Specs (G1)

| Task | Spec |
|---|---|
| M2 | [m2-blind-review-protocol.md](m2-blind-review-protocol.md) (includes the review form) |
| M1 | [m1-labelled-set.md](m1-labelled-set.md) and the blank sheet [m1-labelling-sheet.csv](m1-labelling-sheet.csv) |
| M4 | [m4-savings-method.md](m4-savings-method.md) |
| M3 | [m3-evaluation-harness.md](m3-evaluation-harness.md) |

## Assumptions (defaults from the plan's decision table)

- **D4** (client): cost by default; the reference top model is fixed and dated (M4 proposes
  `claude-sonnet-5-5` at catalogue-2.1 prices).
- **D2** (team): free plans only. Running the top model for real is not in the default method.
- **D3** (team): 25 h a week, so M1 to M6 is the WS5 core (41 h); F-tasks only if hours grow.

## Decisions taken on 21 Nov 2026 (owner: "go with the assumptions")

1. **Catalogue levels: not a blocker.** The cards in `catalogue-2.1` carry no levels, but the product
   rates real models at run time (`app.evaluations.Ratings`): measured suites first, then LMArena,
   then the Artificial Analysis index. The harness uses the same `Ratings` (without a database it uses
   the public sources only) and records `illustrative: true` on any row where no real model was rated.
2. **C1 contract change: `feature=eval`.** Approved by the WS5 owner on 21 Nov; **Ricardo confirms**,
   since the plan says contract changes are his. Evaluation calls are metered with `feature=eval`,
   `key_owner=platform`, and are excluded from T2 dashboards and L7. Until I2 ships, the harness
   records the same fields in its report.
3. **Second M1 labeller:** a team member who did not write rubric-2.x, named on the card.
4. **Request-quality labels (L1):** not labelled in this set; L1 is measured for stability only.
5. **M2 control items:** added (6, not counted in KR1.1), as the protocol's option.
