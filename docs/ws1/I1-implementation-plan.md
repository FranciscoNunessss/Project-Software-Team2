# I1 — Proposed measurement implementation for G1

Owner: Francisco Nunes. Status: G1 approved by Francisco Nunes in chat, 2026-11-20.
Branch: agent/ws1-latency-diagnosis. Live concurrent-test setup remains open.

Approved scope extension in chat on 2026-11-20: explicitly close the SQLite snapshot
connection in `backend/migration_tools/sqlite_import.py`, add success/error lifetime
regressions in `backend/tests/test_postgres.py`, and re-run the four failing imports.
No import schema, stored values or migration SQL changes are authorised or introduced.
Spec: [I1](I1-spec.md). Initial evidence: [report](I1-initial-test-report.md).

## Scope and cases

Implement only the repeatable I1 measurement tooling and report. Do not implement
the gateway, add application storage, change model/prompt/rubric/catalogue inputs,
switch hosting or change quota behaviour. All I1-S1 through I1-S11 in the spec must
have the automated or manual evidence named there before I1 is closed.

## Proposed files and responsibilities

| File | Proposed change |
|---|---|
| scripts/measure_latency.py | New bounded runner and statistics/report generation for application API timings and imports of browser/IDE captures. No direct provider SDK calls, credential output, prompt persistence or automatic production targeting. |
| backend/tests/test_latency_measurement.py | New deterministic tests for percentile calculations, outcome accounting, concurrency/budget/deadline limits, quota stopping, sanitisation and incompatible comparison metadata. |
| e2e/latency.spec.ts | New visible-journey capture for page navigation, analysis result and first non-empty rendered chat answer in the existing isolated fake-model test environment. Fake results stay labelled. |
| vscode-extension/src/diagnostics.ts | Reuse its existing allowlisted timings and existing local capture. No change planned until a documented measurement gap is demonstrated. |
| docs/ws1/I1-baseline-report.md | New report containing all 12 journey/concurrency cells, samples/outcomes, warm/cold and fake/live labels, top-three cause evidence, costed options and PO decision. |
| docs/ws1/I1-spec.md | Record agreed run settings and G1. |
| docs/cloud-setup.md, docs/hosting-plan.md | Reconcile verified hosting facts and link the protocol. Do not repeat stale prices as current facts. |
| docs/vscode-extension.md, README.md | Document the runner/capture procedure, timing boundaries and known limitations. |

Final filenames and module boundaries remain reviewable proposals. Changes outside
these files or discovery of a required ADR return to the owner before implementation.
No PR split is committed before G1; after approval, scope PRs so the owner never
has more than five open.

## Measurement protocol proposed for approval

1. Validate the runner against deterministic fakes first, including 20 overlapping
   requests. Use the disposable local PostgreSQL database and isolated test schemas.
2. Record immutable build/configuration identifiers and synthetic account history.
   Never import personal session cookies/tokens from a browser, read .env files or
   ask the owner to paste credentials. If a live runner cannot authenticate securely,
   keep live measurements in the user's authenticated UI and label the missing cells.
3. Keep concurrency levels 1, 5 and 20. For local simulated runs, propose five rounds
   at each level (130 attempts per applicable workload). These numbers are proposed
   test settings, not a claim of sufficient statistical precision for an SLA.
4. Begin live-provider sampling sequentially, with a proposed ceiling of ten
   foreground LLM actions for a run. Stop new launches on quota exhaustion. Request
   additional agreed quota windows only when necessary for missing matrix cells.
   A live concurrency trial requires isolated synthetic accounts and an agreed
   production/preview window; do not substitute 20 tabs of one personal account.
5. Use UI-visible boundaries for page usability, analysis results and first chat
   text. Keep API latency, extension-host reload and actual webview rendering apart.
   Existing UI displays of latency are backend timings, not end-to-end samples.
6. Do not force an outage in production. Exercise 429s, deadlines, disconnections
   and cancellation with deterministic local failures; report separately which
   conditions have subsequently been observed live.
7. Run first-after-30-minute-idle experiments separately. Confirm idle conditions;
   do not combine requests warmed by other users with an asserted cold-start trial.
8. Preserve missing measurements and failures in the report. No claim of meeting
   p95 or multi-user targets from the single successful production analysis.

## Data, AI and integration impact

No migrations, new C1/C2 fields or AI changes. The runner exercises existing
application paths. Local artifacts use allowlisted timing metadata, status enums,
counts and non-personal configuration identifiers. Do not retain raw request or
response content, account identifiers, headers, query strings or exception bodies.

Production measurements touch an external integration; under AGENTS.md the
Architecture Owner must be informed on the card after G1. Do not send a notification
without the owner's authorised communication step. Ricardo approves any target
adjustments; D2 remains free plans unless the team decides otherwise.

## Validation and manual acceptance

- New deterministic tests cover the spec cases and the actual runner output.
- Run Ruff, backend pytest with coverage, the required 80% core coverage gate,
  frontend build and Playwright tests. Run extension checks when captures change.
- Re-run privacy marker tests after instrumentation, including failure/cancel paths.
- G2: owner runs the deployed preview protocol and checks visible waiting, first
  text, Stop/partial text, error presentation and artifact sanitisation.
- Attach report, G1, PO decision, CI and G2 evidence to I1; a colleague provides G3.

## Local commands and G2 checklist

From the repository root, with the existing development dependencies available:

```powershell
uv run python scripts/measure_latency.py --output docs/ws1/I1-simulated-report.json
uv run python -m pytest -q backend/tests/test_latency_measurement.py backend/tests/test_privacy_marker.py
```

For fresh visible-journey captures, run `pnpm exec playwright test latency.spec.ts`
from `e2e/`. It starts the existing isolated fake-provider stack and executes five
rounds at each concurrency (1, 5 and 20), with isolated browser contexts/accounts.
The three resulting `I1-timings.jsonl` files are saved in their test directories
under `e2e/test-results/`. Their records contain no account identifiers or task text.
Import the exact capture path returned by that run, for example:

```powershell
uv run python scripts/measure_latency.py --mode import --capture docs/ws1/I1-browser-fake-capture.jsonl --model FakeAssessor-FakeChat --versions working-tree --rounds 5 --output docs/ws1/I1-browser-fake-report.json
```

`--mode probe --base-url http://127.0.0.1:8100` measures only `/api/health`,
requires that application to be running, never logs its response text, and does
not substitute for any visible-journey cell. Remote origins require HTTPS; no
authentication header, cookies, credentials, query or path may be supplied.
Defaults: concurrency 1/5/20, five rounds, 130 attempts maximum and a 30-second
deadline per concurrency cell. `--budget`, `--rounds` and `--timeout` reduce the run.

For local G2, verify the reports contain only timing metadata, simulated labels
remain visible, failed outcomes never count as successes, and unmeasured matrix
cells have null percentiles. These local checks do not replace deployed-preview
G2: that still requires the agreed accounts, test window and capture setup.

One proposed PR after G2 covers I1 measurement tooling and evidence only; I1 remains
open until the production/preview baseline and PO decision are complete. Do not
include inherited unrelated IDE commits when preparing the eventual PR into develop.

## Decisions still required

- G1 approved in chat by Francisco Nunes on 2026-11-20; no further G1 request for this scope.
- Identify the preview/test account setup and approved concurrent-test window.
- Set the IDE initial-load target or explicitly accept measurement-only reporting.

I1's result determines I8 fixes. No top-three cause or paid-host recommendation is
selected before the measured evidence exists.
