# I1 — Proposed measurement implementation for G1

Owner: Francisco Nunes. Status: G1 approved by Francisco Nunes in chat, 2026-11-20.
Original capture branch: agent/ws1-latency-diagnosis.
Isolated delivery branch: agent/i1-delivery, based on develop 39f4f73.
Live concurrent-test setup remains open.

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

## Live-run setup worksheet (prepared 2026-11-21)

This worksheet makes the remaining setup decisions explicit; it does not authorise
a deployment or live load. A preview is a deployed test version with isolated
synthetic accounts. A test window is an agreed start/end time and call budget,
so shared users and provider quota are accounted for during the run. The existing
public site is not assumed to be a separate preview.

| Item | Required before execution | Current state |
|---|---|---|
| Environment | Confirm web/API destination, deployed commit, model and configuration; establish whether the backend and provider quota are shared with production. | Existing shared production API confirmed; backend 74d6872 rechecked 24 November. Frontend source commit and upstream quota remain unverified. |
| Accounts | Use isolated synthetic accounts through existing authentication; disable optional task/response saving, recommendation memory and automatic suggestions for these accounts. Do not copy personal cookies or tokens into a runner. | Twenty confirmed Auth users provisioned on 22 November; ten sequential application logins passed with optional settings off. Twenty isolated concurrent browser sessions remain unavailable. |
| Architecture review | Record that the Architecture Owner has been informed on I1 before the external/concurrent run. | Francisco Velhinho notified by mention on the I1 card on 2026-11-22; comment 1500950000038967, verified by readback. Notification is not a claim of approval. |
| Initial live sample | Agree a sequential run, with no more than the proposed ten foreground LLM actions; record actual launch/outcome counts. Background activity or retries can consume additional quota. | Ten approved foreground actions completed on 22 November; no additional inference-capacity result follows. |
| Concurrent samples | Agree the window, repetitions, total attempt budget and provider quota available for each 1/5/20-user batch. A ten-action sequential sample cannot establish the twenty-user result. | Owner redirected the immediate load scope to HTTP health only; that 130-request burst completed. Concurrent real inference remains unavailable. |
| Idle sample | Establish at least thirty minutes without intervening backend traffic; record first-after-idle separately. If other traffic cannot be ruled out, mark the idle result inconclusive. | Attempt completed on 24 November. Application logs show intervening requests and startup before the measured request; idle condition failed. Result explicitly inconclusive. |
| IDE | Identify the actual extension/build and visible initial-load boundary; agree the client setup for each concurrency and the target, or approve measurement-only reporting. | Installed 0.3.0 verified on 24 November. Host reload evidence saved; native input geometry invalidates startup capture. Visible initial-load and 5/20-client cells remain unavailable. |

The existing `e2e/latency.spec.ts` deliberately starts a local fake-provider stack.
Running it does not measure a deployed preview. The runner's `probe` mode measures
health only; its `import` mode validates supplied metadata but does not capture
authenticated browser journeys. Live browser/IDE capture setup must therefore be
confirmed before claiming that either command fills the live matrix.

For G2, the owner checks page usability, a visible analysis result, first non-empty
chat text, Stop with retained partial text, and visible stream-error handling.
Keep deliberate disconnect/error injection in the controlled test environment.
Record pass/fail and the deployed build for each check; an unavailable check stays
pending. A prior smoke test on a different or unidentified build is not acceptance
of this branch. Once captures are available, use the existing import procedure and
retain source, concurrency, warm/idle phase and failures separately.

## Remaining run setup — 2026-11-22

The owner asked to complete all remaining measurements. The Architecture Owner
notification above was posted under that instruction. No concurrent production
load or new model actions were launched in this setup attempt.

Account provisioning: the deployed auth path requires a confirmed email and rejects
anonymous identities. The connected Supabase tools expose no Auth-user creation
operation. Twenty synthetic authenticated browser sessions are still required;
do not insert auth.users rows manually, disable confirmation, export personal
tokens or pretend twenty tabs of one account are twenty users. Use the existing
normal signup/confirmation flow or an authorised supported Auth admin workflow.
Credentials remain outside chat, timing files and repository.

Concrete next live-run proposal, pending account setup and quota agreement:

- Use twenty synthetic accounts, with the first five reused for the five-user cell.
  Keep optional text saving, memory use and automatic suggestions off for them.
- One round per live concurrency (5 and 20), each with one analysis and one chat
  per account: at most fifty additional foreground actions. This is a proposed new
  budget, not part of the ten actions already consumed by the sequential run.
- Launch each journey as a bounded batch; stop subsequent launches on observed
  quota exhaustion, preserve already-started outcomes, and retain missing cells.
  These one-round samples remain descriptive, not evidence of a production SLA.
- Confirm the test window with the owner before starting. For the separate idle
  trial, first ensure participating web/IDE clients and other users are not polling
  or issuing requests; do not poll health during the thirty-minute wait. If other
  traffic cannot be excluded, report the idle condition as unverified.

IDE setup: adaptai-dev.adaptai 0.3.0 is installed. A normal VS Code window was
opened at README.md after the owner confirmed closure of the earlier windows.
An earlier launch mistakenly used --disable-workspace-trust; that session was
closed by the owner, and subsequent launches omitted that flag. No .env contents
were inspected. Automatic review rejected force-stopping the earlier window due
to possible unsaved edits; the force-stop was not executed. Native UI capture
failed twice (expired continuation, then accessibility state unavailable), so
there is no valid visible-webview timing from this attempt. Stop automated IDE
input here; recover the UI tool or have the owner run the documented capture.
Existing API/reload host timings alone do not fill the visible IDE-load cells.

G2 requires the owner's deployed-preview result; a different human provides G3.
Neither gate is automatically satisfied by the setup work or by posting the AO notice.

## Synthetic account provisioning completed — 2026-11-22

Following the owner's explicit request, twenty dedicated test accounts were created
through the supported Supabase Dashboard Authentication / Users / Create new user
workflow in Project-Team2 (`nxqiksxjcqwmstyvdtpj`). The synthetic addresses are
`adaptai-i1-test-01@example.com` through `adaptai-i1-test-20@example.com`.
The dashboard's per-user auto-confirm option was used; no invitation was sent and
no global authentication settings or policies were changed. Each account has a
distinct password. No existing user was modified.

Verification: the filtered dashboard returned twenty users. A read-only aggregate
query over exactly these addresses returned 20 accounts, 20 with a confirmed email,
and 20 with the ordinary `authenticated` role. Passwords were not included in the
query, repository, timing evidence or Drive; the complete credential list was
placed in the owner's local clipboard for private storage.

This completes Auth account provisioning only. Application login, profile creation
or initialisation, test privacy preferences, the concurrent-run window and the
additional fifty-action budget remain to be verified/agreed before load starts.
No model actions or concurrent load were launched during provisioning.

## Narrowed technical load experiment — 2026-11-22

The owner redirected the immediate work to a hypothetical server-load check without
live concurrent inference. A five-round HTTP health burst at 1/5/20 concurrent
requests completed: 130/130 HTTP 200 responses, no errors/timeouts/429s, zero model
actions. The report and methodological limits are in I1-baseline-report.md and
I1-api-health-load-2026-11-22.json. This sub-point is complete. It does not satisfy
the original visible-journey/IDE/idle matrix or replace the required PO/G2/G3 gates.
Ten of the twenty accounts passed sequential application login/Profile/sign-out;
the four optional memory/suggestion settings were already off. The remaining ten
application logins were not exercised after the owner's change of immediate scope.

## Follow-up capture and idle window — 2026-11-24

The owner asked to continue the remaining I1 closure work. Native UI access now
allowed the installed 0.3.0 extension to be opened, local latency capture enabled,
and its backend URL changed from localhost to the existing production API. Its
existing secure session was reused without reading or entering credentials.
The production URL remains configured for manual G2. Five successful host reloads
and 33 successful API reads were saved to I1-ide-host-2026-11-24.json. Native window
geometry/targeting problems invalidated startup timings; no visible-load result
is substituted with host timing. The window was closed normally before idle.

The owner confirmed thirty minutes without use. Local web/IDE inventories were
clear at 22:31:58 UTC; the first health request is due at 23:01:58 UTC, followed
by five warm controls. No application polling occurs during the wait. Empty
Render request telemetry cannot independently prove absence of other users.
Outcome: all six health observations succeeded, but later application-log
pagination exposed ten non-health GETs and startup at 22:52:48 before the timed
request. The 387.5084 ms first observation is classified warm, not idle. The idle
trial is inconclusive and saved in I1-api-idle-2026-11-24.json; no repeat on the
same uncontrolled shared service was launched. See the baseline for details.
The report also contains current official costed options and a manual G2 checklist.
PO acceptance of any reduced scope,
developer G2 and independent peer G3 remain explicit gates.

## Delivery validation follow-up — 2026-11-24

The owner delegated the remaining executable acceptance work. The existing checks
were run on unchanged source 8313bfecf5c0304eff77e221f8a801b18e1eed1f: 691 backend
tests, 99% core coverage, 534 tests without optional modules, 257 extension tests
plus 11 separate integration tests, three browser-rendering scripts and 51
Playwright cases all passed. Ruff, the frontend build and packaged container
recreation/persistence checks passed. See I1-validation-2026-11-24.json and the
baseline for environment limits and the new 390-sample fake-provider capture.

The removal check used an isolated tracked-source copy with ten optional files
excluded, preserving original files. The container project adaptai-i1-checks uses
local test storage and explicitly disables real providers; its review URL is
http://127.0.0.1:8080. No shared-service idle repeat or new hosted preview was
launched. This delegation is not recorded as a human G2/G3 approval or PO waiver.

## Delivery branch isolation — 2026-11-24

Comparison with current develop exposed thirteen unmerged WS2 commits beneath
the original I1 commit. The approved I1 files were therefore transferred into a
separate worktree on agent/i1-delivery, based on 39f4f73. The original working
tree, its WS2 history and the owner's C1/I2 drafts remain intact. VS Code local
settings, the unrelated extension lockfile and scratch card drafts were excluded.
A cloud-documentation conflict was resolved by retaining develop's published
state and adding the later I1 verification, without restoring outdated text.

The earlier 8313bfe results describe the capture branch, not acceptance of this
new delivery. The clean branch is being checked separately. Repeated checks are
required here because the target code base changed; no new feature, prompt,
schema, hosting configuration or approval waiver was introduced by the isolation.

## Isolated delivery validation — 25 November 2026

Runtime source: agent/i1-delivery, commit 0100ae8069418233d14908cb8863a2ccb8429c1f,
based on develop 39f4f73. Documentation/evidence follow-up changes no runtime code.

| Check | Result on the isolated delivery |
|---|---|
| Ruff lint / formatting | Passed; 103 files formatted. |
| Full backend | 771 passed, zero failures/errors/skips; 534.091 s JUnit; 96% total coverage. |
| Core coverage | 99%, required minimum 80%. |
| Without chat and Prompt Coach | 613 passed, zero failures/errors/skips; 338.601 s; original files preserved. |
| Frontend | Frozen install and build passed; existing chunk-size warning remains. |
| Extension | 191 unit cases passed; 11 integrations skipped in that command then all 11 passed separately against clean local containers. Existing page-rendering script passed. |
| Containers | Build, healthy services, demo smoke, recreation and retained login/data passed. |
| Playwright | All 53 cases passed in 2.6 minutes; 390 fake-provider samples, zero failed samples. |

At 20 users, descriptive p50/p95 in ms: Profile revisit 178.64/205.43,
analysis click-to-visible 1154.58/1748.50, Send-to-first-visible-text 980.14/1231.22.
All three journeys have 100 successful samples at 20 users. IDE cells remain empty.
These are local fake-provider timings, not production inference capacity or SLA.

Evidence: [capture](I1-delivery-browser-fake-capture-2026-11-25.jsonl),
[computed report](I1-delivery-browser-fake-report-2026-11-25.json),
[validation](I1-delivery-validation-2026-11-25.json).
The approval-service usage failure on 24 November was resolved before these checks;
no restriction was bypassed. No new production model actions were launched.

The owner explicitly requested a PR on 25 November. It is prepared as a draft,
with developer G2 explicitly pending rather than inventing a manual result.
Original missing live/IDE/idle evidence or a PO scope decision and independent
G3 remain required before closure. Local preview: http://127.0.0.1:8080 (demo only).

## G2 and PR publication — 25 November 2026

After receiving the local demo checklist, Francisco Nunes reported the manual test
completed ("já está testado"); no issue was reported. This records the developer's
statement, not an agent-invented per-step result. Detailed step results/timings
were not supplied. The G2 prerequisite for opening the PR is now recorded.

[PR #96](https://github.com/FranciscoNunessss/Project-Software-Team2/pull/96) is open
as a draft from agent/i1-delivery into develop. It does not close the I1 card.
Remote checks are running; PO scope/options acceptance, original measurement gaps
and independent G3 approval/merge remain open. Earlier pending-publication/G2
statements describe their recording time and are superseded by this update.
