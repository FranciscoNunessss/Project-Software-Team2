# Test conventions

Card "Test conventions: Given/When/Then to pytest naming, ATDD and evals". Prepared with AI assistance
(Claude, Anthropic); human review pending. It writes down what the repository already does, so a new
test and a new card follow one rule. It changes no test: existing tests keep their names.

## 1. From a card's Given/When/Then to a test

1. **One test per criterion, including its boundary case.** A card with three criteria and one boundary
   has four tests at least. A criterion without a test is not done (AGENTS.md, "each case has a test").
2. **The name says the outcome, in plain words**, as a sentence: `test_<who or what>_<does what>_<when>`.
   Good: `test_a_refused_analysis_leaves_no_session_behind`,
   `test_always_analyse_is_off_by_default_and_per_user`. Not: `test_case_3`, `test_fr16`.
   The name is what a failing CI line shows; it must be understandable without opening the file.
3. **The card is cited where the name cannot carry it**: the module docstring or the pull request's
   "Cases" table names the card (AA-012, FR-16) and lists criterion, then test. A card id is not a
   test name, because ids change and sentences do not.
4. **Given, When, Then are the three paragraphs of the test**, in that order, separated by a blank line
   when the test is longer than a few lines. The assertion is the Then; do not assert something the
   criterion does not say.
5. **Layers.** A criterion that is about logic goes in `backend/tests/` (pytest). One that is about what
   a person sees or clicks goes in `e2e/` (Playwright). A criterion may need both: the example below.
6. **Markers.** A test of an optional module carries its marker (`@pytest.mark.chat`,
   `@pytest.mark.prompt_coach`), so the removal drill can delete the module and still pass.

## 2. Contract tests, regression tests and quality evaluations

They answer different questions and are kept apart (Product Specification 11.7, `docs/quality-eval.md`).

| Kind | Question | Where | Model | Runs |
|---|---|---|---|---|
| Contract / regression test | Does the code keep its promise (shape, rules, privacy, errors)? | `backend/tests/`, `e2e/` | A fake model | Every pull request, free |
| Quality evaluation | Is what a real model produces good enough? | `scripts/run_quality_eval.py`, `backend/eval/` | A real model | By hand or by a gated job; never a unit test |

**The rule for a criterion that needs human judgement.** If the criterion can only be decided by
reading the output ("the recommendation is correct", "the explanation is clear", "the text does not
contradict the verdict"), it is **not** a unit test. Map it to an evaluation or a blind review, and say
which. A test with a fake model that returns the expected answer proves the code passes the answer on,
not that the answer is good, and a green run of it must never be read as the second.

**What "validated" means before a card is Done** (decision proposed here, for the Product Owner):

- A code criterion: its named test exists, runs in CI and passes.
- An AI-behaviour criterion: an evaluation was run with a real model, its report is linked in the
  pull request, and the report says which model, how many runs and what it did **not** cover.
  "No evaluation run" is written down, not left out (Process 05 section 7.6: a prompt change needs one).
- Both: the card names which is which.

## 3. Example: "Always analyse before sending" (FR-16, card E5)

| Criterion (Given / When / Then) | Test | Kind |
|---|---|---|
| Given a new person, when they open the setting, then it is off | `test_always_analyse_is_off_by_default_and_per_user` (`backend/tests/test_chat.py`) | contract |
| Boundary: given two people, when one switches it on, then the other still has it off | the same test (its last assertion) | contract |
| Given the setting is off, when the person sends, then no analysis is requested | `"Always analyse before sending" is off by default; on, Send analyses first and carries the analysis` (`e2e/chat.spec.ts`, first half) | e2e |
| Given the setting is on, when the person sends, then the analysis runs first and the message carries it | the same e2e test, second half | e2e |
| "The analysis the person sees is a good one" | **no test**: it depends on the assessor, which is measured by the quality evaluation (`docs/quality-eval.md`), not here | evaluation |

How to read it: three criteria are code (a test each), and the last one is judgement, so it points to
the evaluation. That is the boundary case of the card.

## 4. What is not decided here

- The framework (pytest and Playwright, already in use) and the folder layout (`backend/tests`, `e2e`)
  are as they are; the card's checklist items for them are closed by this description of the status quo.
- Renaming old tests to the new rule: not done, because a rename loses `git blame` for no gain.
  New tests follow the rule; touched tests may be renamed in the same change.
- The wording of "validated" in section 2 is a proposal; 05 (Drive) is not edited from here, so its owner
  should copy the three lines when the Product Owner agrees.
