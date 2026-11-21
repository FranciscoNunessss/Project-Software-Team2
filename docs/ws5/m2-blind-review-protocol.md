# M2 Recruit external reviewers and write the blind-review protocol

Workstream WS5. Priority Essential. Effort S. Start W12 day 1 (Mon 30 Nov). Feeds M6 (KR1.1).
Prepared with AI assistance (Claude, Anthropic); human review pending.

## Objective

Have 2 to 3 people from outside the team, with confirmed dates in W14 to W15, and a written protocol
and form, so that M6 can judge 20 AdaptAI recommendations blind and report the result against KR1.1
(at least 16 of 20 correct) with agreement between reviewers.

## Requirements

Functional

1. 2 to 3 reviewers, none on the team, none who has read the rubric or the catalogue rules. Profile
   (decision pack B1): one professor or tutor, one person who uses AI at work but does not write
   code, one from the client's side if the client agrees.
2. Each reviewer confirms a 60-minute slot between Mon 14 and Fri 25 Dec, in writing (email or chat).
3. The protocol defines "correct" before anyone sees a result (below), and the team cannot change it
   after M5 runs.
4. Each reviewer judges alone. Disagreements are reported, never averaged away.
5. The form shows, per item: the task text, the recommended model, and the same short card for every
   catalogue model (name, price per million tokens, one-line strengths). It does **not** show the
   need levels, the explanation, the team's expected model, or which items the team thinks are hard.

Non-functional

- Free tools only (Google Forms or a shared sheet, one copy per reviewer).
- The reviewer's name is kept only in the team's Drive, not in the repository. The repository holds
  reviewer ids (R1, R2, R3) and their answers.
- English, or Portuguese for a reviewer who prefers it, with the same wording reviewed by two members.

## Definition of a correct recommendation

A recommendation is **correct** when both hold:

- **Sufficient:** the recommended model can be expected to complete the task to a standard the
  person asking would accept, without a second attempt on a stronger model.
- **Not wasteful:** no listed model that is clearly cheaper would also be sufficient.

Each item gets one of four answers:

| Answer | Meaning | Counts as correct |
|---|---|---|
| A. Right choice | Sufficient and not wasteful | Yes |
| B. Acceptable, slightly over | Sufficient; a cheaper one might also work, but I am not sure | Yes |
| C. Over-sized | Sufficient, but a clearly cheaper listed model would do | No |
| D. Under-sized | Likely to fail or need a retry on a stronger model | No |

Plus a confidence (sure, fairly sure, guessing) and an optional one-line reason. The reason stays in
the form in Drive; the repository keeps only reviewer id, item, answer and confidence.

**Final verdict per item:** correct when the majority says A or B (2 of 2, or 2 of 3). With 2
reviewers who split, the item counts as **not correct** (conservative) and is listed.

**Agreement:** percent agreement on correct versus not correct, plus Cohen's kappa (2 reviewers) or
Fleiss' kappa (3). A kappa under 0.4 is reported as "low agreement" next to the KR1.1 result.

## Blindness

- Reviewers do not know which items the team expects to pass.
- The order of the 20 items is shuffled per reviewer (seed recorded).
- **Controls (decided 21 Nov):** 6 control items whose model was chosen by a fixed rule
  (3 always-cheapest, 3 always-top). Controls are not counted in KR1.1; they show whether a reviewer
  approves everything. Cost: about 15 more minutes per reviewer.

## Scenarios

| # | Given | When | Then |
|---|---|---|---|
| S1 normal | 3 confirmed reviewers and 20 recommendations from M5 | each fills the form alone | 20 verdicts per reviewer, a majority verdict per item, a count out of 20 and a kappa |
| S2 limit | only 2 reviewers confirm | M6 runs | the result is still reported; a split counts as not correct and the report says "2 reviewers" |
| S3 limit | a reviewer answers 18 of 20 | the deadline passes | the 2 missing items use the other reviewers' majority; the report names the gap |
| S4 error | a reviewer cancels in W14 | fewer than 2 remain | the backup reviewer (recruited now) is called; with none, M6 is reported as NOT RUN, never as a pass |
| S5 abuse | a reviewer knows the team well or saw the rubric | recruitment | they are not used; the eligibility check is a written question in the invitation |
| S6 prompt injection | one of the 20 tasks contains text addressed to the assessor | it is shown on the form | it is shown as plain task text; the reviewer judges the model choice for the real task, as for any item |
| S7 privacy | reviewer names and emails | the result is committed | only R1 to R3 appear in the repository; names stay in Drive |
| S8 quota exhausted | M5 could not produce all 20 recommendations | the form is built | the form is not sent; M6 waits for a complete M5 run (no partial review) |

## Test per scenario

M2 is a protocol, not code, so most tests are checks done by a person and recorded on the card.

| Scenario | Test |
|---|---|
| S1, S2, S3 | The M6 scoring script (built in M3) has unit tests for the majority rule, the 2-reviewer split, a missing answer and both kappas, with fixed answers |
| S4 | Card checklist: one backup reviewer confirmed before W13 |
| S5 | Each invitation reply answers the eligibility question; the card links the replies (names redacted) |
| S6 | The form is reviewed by a second member before sending; the injection items look like any other |
| S7 | Unit test: the M6 report writer rejects any field other than reviewer id, item id, answer, confidence |
| S8 | Unit test: the packet builder refuses to export fewer than 20 items |

## Data and AI changes

No prompt, rubric, model or catalogue change. No database change. New files later (M3/M6):
`backend/eval/review/packet-<date>.json` (items, shuffle seeds) and `review/answers-<date>.json`
(reviewer ids only).

## Docs to update

- This protocol, linked from `docs/quality-eval.md`.
- `okrs.yml` KR1.1 `note` once reviewers are confirmed (by Ricardo, the KR owner).

## Invitation (draft to send)

> Subject: 1 hour of your judgement on AI model choices (university project, December)
>
> We are a student team building AdaptAI, which recommends the cheapest AI model that can do a given
> task. We need 2 to 3 people outside the team to judge 20 of its recommendations, alone, in about
> one hour, any time between 14 and 25 December, online. No technical knowledge needed.
> One question so we keep the review fair: have you seen our scoring rules or worked with the team on
> the product? If yes, we will thank you and ask someone else.
> Would you be available? Which day suits you?

## Open questions

1. Does the client agree to one reviewer from their side? (Goes in the weekly update with D1, D4 to D6.)
2. Who sends the invitations: the owner, or Ricardo as PO? The plan says WS5 owns M2.

## How to run it (built)

```bash
# After M5: one complete run of tasks-2 on the production model
python scripts/blind_review.py export backend/eval/quality/reports/<run>.json --seed <date as number>
# Send form-R1.csv, form-R2.csv, form-R3.csv and models.csv; collect one CSV per reviewer
python scripts/blind_review.py score backend/eval/review/<date>/packet.json R1=r1.csv R2=r2.csv R3=r3.csv
```

Code: `backend/app/blind_review.py`, tests `backend/tests/test_blind_review.py`.
