# I1 — Latency and capacity diagnosis

Owner: Francisco Nunes. Workstream: WS1. Priority: Essential.
Status: G1 approved by Francisco Nunes in chat on 2026-11-20 for the linked measurement
implementation plan. Live concurrent-test setup and IDE target remain open.
Plan: [I1 implementation](I1-implementation-plan.md).
Dependencies: none. Findings feed I2, I3, I4, I8 and decision D2.

## Objective

Establish a reproducible latency and capacity baseline for the existing AdaptAI
product by the end of W12. Measure page changes, analysis, chat first visible text
and IDE webview load at 1, 5 and 20 concurrent users. Identify the causes of slow
steps and present costed options for PO approval before implementing fixes.

This task measures and reports. Gateway implementation, quota policy changes,
keep-alive deployment, latency fixes and new streaming behaviour belong to their
respective WS1 tasks. Changes to WS2 features are outside this task.

## Requirements (functional and non-functional)

1. Cover all four journeys at concurrency 1, 5 and 20. Each virtual user uses an
   isolated synthetic test account/session. Identify whether a measurement is
   browser-visible, extension-host timing or backend timing.
2. Record p50 and p95 in milliseconds, sample size, attempted and successful counts,
   failure/cancellation/429 counts, environment, commit, model, versions, capture
   date and concurrency. Use monotonic clocks for durations. Percentiles use the
   nearest-rank method over successful completed samples. Empty cells are explicitly
   unavailable; low sample sizes are disclosed, never presented as a reliable SLA.
3. Keep client journey duration separate from individual API/provider durations.
   Measure page changes from navigation action to usable target content; analysis
   from submission to visible result; chat from send to first visible non-empty
   answer text; IDE initial load from opening the panel to usable content. Record
   warm view switching separately from initial webview load.
4. Separate warm, first-after-idle, real-provider and simulated-provider results.
   A response header, empty SSE event or loading placeholder is not an answer.
   Do not add independent step percentiles to estimate an end-to-end percentile.
5. Decompose slow journeys using existing diagnostics first. Attribute causes only
   where timings or controlled comparisons support them. Label unobservable
   components and hypotheses explicitly; do not invent database or provider timings.
6. Use the release plan's provisional targets: unqueued analysis p95 <15 s;
   chat first text <3 s; warm page change p95 <1 s; first request after 30 minutes
   idle <5 s; zero silent failures at concurrency 20. No numerical IDE initial-load
   target is specified in the release plan; agree one or report measurements only.
   I1 may recommend adjusted targets; the PO must approve them.
7. Record the current handling of concurrency, quota exhaustion and errors even if
   targets fail. The baseline does not claim that I2 queue acceptance criteria
   already pass. Never count an error response as a successful fast analysis.
8. Use deterministic synthetic input and comparable account history, configuration,
   client location and test-client resources for before/after runs. Record material
   differences. The same runner/protocol must be reusable by I8.
9. Bound runs by an explicit attempt budget, deadline and concurrency ceiling of 20.
   Stop launching live calls when the budget is reached or a quota exhaustion signal
   is received. Record skipped cells and resume only within an agreed quota window.
   Simulated runs prove orchestration, not production LLM capacity.
10. Do not read, print or export secrets or .env files. Authentication is supplied
    through the existing secure mechanisms. Do not log headers, bodies, transcripts,
    account identifiers, query strings, provider exception text or credential values.
    Diagnostic artifacts contain timing metadata and sanitised status codes only.
11. Preserve the existing privacy marker test. No new task text persistence, tracing,
    analytics, production schema change or C1/C2 field is introduced by I1. Existing
    optional conversation-memory behaviour is not expanded; synthetic test accounts
    must have it disabled. Existing chat retention is not broadened.
12. Produce a report ranking the top three evidenced latency causes, with baseline
    measurements, free options, paid alternatives where relevant, dated pricing
    sources, trade-offs, confidence and recommended actions. Verify current provider
    terms/prices when preparing that report. Do not purchase or enable paid services.
13. Obtain and record PO approval of recommendations and any target changes.
    Unavailable measurements, quota limits or target failures remain visible.

## Scenarios as Given/When/Then

| ID | Given | When | Then |
|---|---|---|---|
| I1-S1 | A warm test environment and synthetic accounts | Each of the four journeys runs at 1, 5 and 20 users | The report contains the complete matrix, or an explicit reason for each unavailable cell, with sample counts and separate client/backend timings. |
| I1-S2 | Known durations, including a one-sample and empty dataset | Statistics are generated | Nearest-rank p50/p95 are correct; the one-sample result is labelled; the empty dataset has no invented percentile. |
| I1-S3 | Mixed successes, 429s, errors and cancellations at concurrency 20 | A run finishes or reaches its deadline | Every attempt has a terminal outcome, failures are counted separately, and timeouts cannot silently disappear or improve successful latency figures. |
| I1-S4 | A streaming response with empty/control events before answer text | The answer arrives, stops or fails | First-text time starts at send and ends at the first visible non-empty answer text; no-text responses remain failures, and partial/error states are recorded separately. |
| I1-S5 | A backend idle for at least 30 minutes | The first request is measured and then warm journeys run | The first-after-idle result is separated from warm samples; idle conditions and any intervening traffic are documented. |
| I1-S6 | A provider returns quota exhaustion or the attempt budget is reached | More calls would otherwise launch | No further live calls are launched; already-started calls are accounted for; the report names incomplete cells and the quota limitation. |
| I1-S7 | An invalid concurrency, missing test setup or unreachable target | The runner validates or executes the request | Invalid settings fail before load starts; runtime errors produce sanitised outcomes and an incomplete-run indicator, with bounded completion. |
| I1-S8 | Synthetic input contains a unique marker and an instruction to reveal credentials or alter diagnostics | Normal, failure and interrupted paths execute | The instruction cannot change runner settings; timing artifacts/logs contain no marker, credentials or raw input; no new persistence is introduced. |
| I1-S9 | A simulated provider or extension-host-only timing is used | Results are reported | They are labelled as simulated or host-only and cannot satisfy a claim about production inference or visible webview rendering. |
| I1-S10 | The baseline identifies slow steps | Options and recommendations are reviewed | Three causes are ranked with evidence or explicit evidence gaps, free/paid costs are sourced and dated, and PO approval is recorded rather than assumed. |
| I1-S11 | The same protocol is run again after I8 | Baseline and new results are compared | Environment, commit, model, configuration, sample size and protocol differences are visible; incomparable cells are flagged. |

## Test per scenario

These are proposed checks, not tests already written or executed.

| Scenario | Test and relevant assertion |
|---|---|
| I1-S1 | Journey smoke tests and report validation assert all 12 matrix cells exist, timing boundaries are distinguishable and missing results carry reasons. Run live acceptance separately from automated mocks. |
| I1-S2 | Unit tests against hand-calculated nearest-rank datasets assert exact p50/p95 values and explicit empty/small-sample output. |
| I1-S3 | A deterministic fake service injects success, timeout, cancellation and 429 outcomes; assert attempted equals terminal outcomes and failed attempts never enter success percentiles. |
| I1-S4 | A controlled SSE stream emits control events, empty chunks, text, truncation and disconnects; assert first-text boundaries and no successful answer when text is absent. Browser/IDE G2 verifies actual rendering. |
| I1-S5 | Clock/phase classification tests assert cold samples cannot enter warm percentiles. Manual preview capture establishes actual 30-minute idle behaviour; I4 owns its five-of-five acceptance trial. |
| I1-S6 | Fake quota failures and a small attempt budget assert the launch count stays within budget and stops after observed quota exhaustion. |
| I1-S7 | Parameterised runner validation and bounded failure tests assert no requests for invalid setup and sanitised terminal outcomes for unavailable targets. |
| I1-S8 | Artifact/log marker tests exercise success, provider failure and cancellation. Re-run backend/tests/test_privacy_marker.py; retain coverage from existing extension diagnostic sanitisation tests. |
| I1-S9 | Report tests assert simulated and host-only captures retain their labels and cannot be merged into the live visible-journey dataset. |
| I1-S10 | Manual evidence review checks each cause against captures and each price against a current official source; attach the PO's explicit decision to the card. |
| I1-S11 | Comparison validation rejects or labels incompatible metadata and uses the unchanged timing definitions and percentile calculation. |

## Data and AI changes

No production migration, AI prompt, rubric, model, catalogue or learning-event
contract change is proposed. Temporary diagnostic captures are local timing metadata,
not new application usage-event fields. Real calls retain the existing model and
consent rules. The harness must not create an unmetered provider bypass once I2 is
available; baseline calls use existing application paths and explicitly document
pre-gateway limitations. I1 does not depend on I2 being complete.

Repository inspection found existing streaming in backend/app/chat.py, provider
adapters in backend/app/providers.py, request/stream handling in frontend/src/api.ts,
and opt-in timing capture in vscode-extension/src/diagnostics.ts. Reuse these before
proposing additional instrumentation. Existing dashboard-latency tests demonstrate
client orchestration, not production load performance.

Decisions required before live runs: preview/test environment and synthetic accounts;
per-run live-call budget, repetitions and quota windows; IDE initial-load target;
and the PO identity for recording approval. Proposed default environment is a
deployed preview; shared production-load testing requires an agreed test window.
Use free plans under D2. Do not assume that the default provider model configured
in source proves which model is currently deployed.

## Docs to update

- This spec: record agreed measurement settings and G1 decision.
- A proposed docs/ws1/I1-baseline-report.md: matrix, method, limitations, top-three
  causes, options with dated costs, recommended changes and PO decision.
- docs/cloud-setup.md and docs/hosting-plan.md: reconcile only hosting/measurement
  statements verified by I1; retain unverified historical details as such.
- docs/vscode-extension.md: document capture boundaries and the agreed IDE protocol.
- README.md: link the diagnostic command/protocol once implemented.
- ClickUp I1 card: link spec, G1, measurements, PO decision, G2 preview evidence and PR.
  Name implications for I2/I3/I4/I8 and D2 without changing other owners' scope.

Completion requires the release plan's global Definition of Done, including preview
G2 and peer G3. This spec is not completed measurement evidence.
