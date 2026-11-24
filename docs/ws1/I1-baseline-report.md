# I1 baseline — measured evidence and remaining gates

Owner: Francisco Nunes. Started: 2026-11-20. Updated: 2026-11-24.
G1 approved in chat for measurement tooling.
Status: incomplete baseline; live concurrency, idle trial, PO decision and G2/G3 pending.

## What was measured

Five rounds of visible-journey captures at 1, 5 and 20 isolated synthetic accounts
on the existing local Playwright environment with fake providers: 390 samples,
all successful. Each journey starts as a batch after the previous phase finishes.
This is requested browser concurrency, not measured simultaneous upstream LLM calls.
Durations include Playwright action/observation overhead and shared test-machine
contention. Pages are warmed before revisits; no separate assessor warm-up is done.
No production LLM speed or reliability claim follows.

| Journey | Concurrency | Successful / attempted | p50 ms | p95 ms | Limitation |
|---|---:|---:|---:|---:|---|
| Profile page revisit to usable preferences | 1 | 5 / 5 | 56.40 | 63.87 | Fake environment, small sample |
| Profile page revisit to usable preferences | 5 | 25 / 25 | 64.09 | 88.38 | Fake environment |
| Profile page revisit to usable preferences | 20 | 100 / 100 | 161.17 | 311.12 | Fake environment |
| Analysis submit to visible recommendation/table | 1 | 5 / 5 | 158.01 | 1936.53 | Fake assessor, small sample |
| Analysis submit to visible recommendation/table | 5 | 25 / 25 | 335.60 | 458.20 | Fake assessor |
| Analysis submit to visible recommendation/table | 20 | 100 / 100 | 1245.96 | 1797.19 | Fake assessor |
| Send to first visible non-empty answer | 1 | 5 / 5 | 103.35 | 117.41 | Fake chat, small sample |
| Send to first visible non-empty answer | 5 | 25 / 25 | 268.63 | 281.11 | Fake chat |
| Send to first visible non-empty answer | 20 | 100 / 100 | 1006.80 | 1219.03 | Fake chat |
| IDE webview initial load | 1, 5, 20 | 0 / 0 | unavailable | unavailable | Requires actual IDE capture |

Percentiles use nearest rank. Five rounds reuse each isolated account, so observations
are repeated measurements rather than independent random users. They cannot
establish a production SLA. Full individual matrix
cells and sample counts are in [the imported report](I1-browser-fake-report.json).
Raw metadata: [JSONL capture](I1-browser-fake-capture.jsonl). The report retains the
base commit and dirty-working-tree flag; it is not evidence of an immutable release.

The separate [130-attempt simulation](I1-simulated-report.json) exercises a bounded
operation at concurrency 1, 5 and 20. It does not invoke a provider or browser and
does not fill the missing visible-journey cells.

The earlier deployed browser smoke test displayed 2719 ms for one Groq analysis
using openai/gpt-oss-20b. That is a backend-reported value in a personal account;
it is not comparable to these local visible-journey samples. See the
[initial functional report](I1-initial-test-report.md) for context and limitations.

## Verification

- Existing extension checks: 257 passed plus 11 integration tests passed in a
  separate run against an isolated backend. Initial sandbox-only HTTP failures
  disappeared without source changes.
- Existing Playwright suite: 48 passed. Expanded I1 capture: all 3 concurrency cases
  passed in 1 minute, with five rounds at each concurrency and no recorded errors.
- New runner tests plus existing privacy marker tests: 42 passed (27 new tests,
  15 existing privacy tests). No provider calls in these checks.
- Ruff check and format check passed for backend/scripts, including the new files.
- Frontend TypeScript/Vite build passed; the existing >500 kB chunk warning remains.
- Full backend run before adding the new tests: 656 passed, 6 failed, total app
  coverage 96%; core coverage gate passed at 99% against its 80% requirement.
- Two connection-error failures (evaluation and LLM configuration) passed on an
  isolated rerun. The owner subsequently approved a limited G1 extension to fix the
  SQLite snapshot connection lifetime. Two new success/error regressions reproduced
  WinError 32 before the fix. Explicit closing now preserves the transaction context
  and releases the copy before temporary-directory cleanup. All 53 PostgreSQL,
  runner and privacy tests then passed, including the four previously failing imports.
  Full backend rerun after the fix, without concurrent browser load: **691 passed,
  0 failed in 406.35 seconds**, with 96% total application coverage. The core
  coverage gate remains 99%, exceeding its 80% requirement.

Resume check, 2026-11-21: all 390 saved browser-fake samples passed the runner's
strict field validation. Recomputed statistics matched all twelve saved report
cells exactly, including unavailable IDE percentiles. Ruff lint and format checks
passed (92 files). These checks validate the saved evidence; they are not new
performance measurements. The 691-test backend result above remains dated
2026-11-20; it was not repeated today. The local Docker engine was unavailable
during this check. I1's ClickUp description was reconciled with the completed
backend run and the existing remote branch. Live setup remains pending; see the
[setup worksheet](I1-implementation-plan.md#live-run-setup-worksheet-prepared-2026-11-21).

## Investigation priorities and options — updated 2026-11-24

These are ranked investigation priorities from the available boundaries, rather
than three proven independent production root causes. No controlled before/after
change, query-level timing or provider-only trace has been captured.

| Priority | Evidence and interpretation | Confidence and next step |
|---|---|---|
| 1. Analysis execution and delivery | Real single-user Analyse-to-visible p50/p95 was 5599.98/6011.76 ms on 22 November. One matching example reported 2786 ms inside the backend versus 4529.59 ms to the visible result. The remaining 1743.59 ms is outside that backend timing boundary, including network, rendering and observation overhead. | The end-to-end delay is observed. Neither the entire backend value nor the residual is provider-only or browser-only time. Separate these boundaries before selecting an I8 fix; do not subtract unrelated percentiles. |
| 2. IDE metadata reads and refreshes | The 24 November capture contains five successful host reloads: p50 1705.5 ms, p95 1789.7 ms. In one reload, evaluations took 1767.7 ms while options/chats took about 665 ms, and the reload ended at 1769.6 ms. Local source waits for these three reads before publishing the Assistant data. | Evidence supports a critical-path read dependency, not a database root cause. Other reloads show similar durations across all three reads, so shared transport/backend contention remains possible. Compare cached/lazy evaluation loading and reused reads in a separately approved I8 plan. |
| 3. First-after-idle hosting | The backend is still on Render Free. Current official documentation describes spin-down after fifteen minutes without inbound traffic and about one minute to wake. The extension checks health every sixty seconds while open. During the quiet-window attempt, logs show shutdown at 22:45:55 and startup at 22:52:48. | A server lifecycle transition is observed, compatible with Free spin-down; exact wake-up latency is not captured. Intervening requests invalidated the thirty-minute idle condition. A continuously open extension also prevents a clean inactivity experiment. |

### Costed decision options

Current official sources were checked on 2026-11-24. Prices below are advertised
USD compute prices, with no invented EUR conversion, taxes or LLM charges included.

| Option | Advertised compute cost | Trade-off / recommendation |
|---|---|---|
| Keep Render Free; use a deliberate warm-up before a supervised demo and investigate metadata reads | $0/month compute | Keeps D2 free plans. First unattended use can still wait for wake-up; this is not a guarantee of the five-second idle target. No continuous keep-alive was deployed. |
| Render `0.5c-512mb` (legacy Starter) | $7/month per service | Paid compute removes Free-specific limitations. 512 MB RAM remains unchanged; this does not prove improvement to provider latency, SQL or twenty-user inference capacity. PO approval and a new deployment decision required. |
| Render `1c-2g` (legacy Standard) | $25/month per service | More CPU/RAM, but there is no measured saturation case justifying this tier. Do not select it solely from a health endpoint burst. |

Sources: [Render Free](https://render.com/docs/free.md),
[compute plans](https://render.com/docs/compute-plans.md), and
[current pricing](https://render.com/pricing.md#compute). Workspace subscriptions
and service compute are separate; upgrading only a workspace does not remove
Free-instance limitations. The earlier unreadable HTML pricing response has now
been superseded by the official Markdown pricing reference.

Recommendation for Ricardo's decision: retain free plans for now, accept the
explicit limitations of the technical HTTP burst, and prioritise measurement of
analysis boundaries and metadata-read reuse before spending. No paid plan, new
prompt/model/catalogue or production performance fix has been enabled. Ricardo's
PO decision is still pending; publication is not approval.

## Hosting identity and telemetry checked on 2026-11-21

Read-only connector queries used the owner-confirmed Render workspace Project-Team2.
No deploy, configuration, environment variable or billing setting was changed.

| Component | Verified metadata | What remains unknown |
|---|---|---|
| Render backend | adaptai-team2-api, Free, Docker, Frankfurt, one instance, not suspended; auto-deploy and PR previews off; health path /api/health. Latest deploy dep-dbtqv8g8v5cc73b3hs50 is live, commit 74d68722c156218722ab6f43fe0e21448da1ef38, finished 2026-11-17 01:37:48 UTC. | The connector's live status is deployment state, not a new browser timing measurement. Runtime environment values were not inspected. |
| Netlify frontend | Current deploy 6afbb01b7f1c704d32b54bcf, ready, production context, CLI source, published 2026-11-17 01:38:36 UTC. | commit_ref and branch are null. Do not assign the backend commit to this frontend artifact. |
| Backend HTTP metrics | Queries for analysis p95 and request counts returned no data. | No traffic count, error rate or HTTP percentile can be inferred from an empty series. |
| Backend resources | Returned CPU sample: 0.00988193 CPU at 10:57:20 UTC, with a reported 0.15 CPU limit. Memory samples: 159748100 and 165343230 bytes at 10:52/10:57 UTC, against a reported 536870900-byte limit. | Sparse samples do not establish absence of saturation during the journeys or at twenty users. No bottleneck ranking follows. |

The earlier browser checks can now be associated with the current backend deploy
observed later the same morning, subject to the limitation that no immutable build
identifier was captured inside those requests. Frontend commit identity remains
unresolved. The deployed backend differs from the local I1 branch and the inspected
local origin/develop reference (39f4f73).

Official [Render Free documentation](https://render.com/docs/free), checked
2026-11-21, states a fifteen-minute inactivity spin-down, roughly one-minute
spin-up, and 750 free instance hours shared by a workspace each month. Inference:
this is a plausible contributor to initial waiting, not a measured cause in this
run. One always-running instance uses at most 744 hours in a 31-day month, leaving
six hours before other free services/overlap; actual monthly remaining hours were
not obtained. Do not enable keep-alive from that arithmetic alone.

No paid cost was established: the fetched [pricing page](https://render.com/pricing)
did not expose an applicable compute price in its readable response. Do not reuse
historical prices as current quotations. D2 remains free plans; the three measured
causes and PO-approved costed recommendation are still pending.

## Manual acceptance and remaining gates

### Sequential live sample — 2026-11-22

The owner approved up to ten foreground model actions and asked to continue the
real measurements. Five sequential analysis/chat rounds used the existing
authenticated Chrome session on the deployed site: five analyses and five chat
sends. All ten completed. Five additional warm Profile revisits were measured.
No independent synthetic accounts were available for concurrent live trials.

| Journey | Users | Successful / attempted | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| Warm Profile revisit to visible preference editor | 1 | 5 / 5 | 785.98 | 1034.65 |
| Analyse click to visible recommendation coverage table | 1 | 5 / 5 | 5599.98 | 6011.76 |
| Send click to first visible non-empty answer | 1 | 5 / 5 | 2318.37 | 2603.52 |

Durations use the orchestration process's monotonic clock and include browser
automation/observation overhead. Nearest-rank percentiles over five observations
are descriptive only; p95 is the maximum sample. This does not establish an SLA.
The page p95 slightly exceeds the provisional one-second target with this method;
client/automation contributions have not been separated. No capacity claim at
five/twenty users, verified idle trial, or IDE initial-load result follows.

The first analysis displayed backend latency 2786 ms versus 4529.59 ms measured
to the visible result. These are different boundaries, not interchangeable
percentiles. The model displayed for assessment/chat was openai/gpt-oss-20b.
Render's live backend deploy was rechecked as 74d6872; frontend build identity
remains unverified. No model quality evaluation was performed.

Memory use, optional text saving and automatic suggestions were confirmed off
before inference and restored to their original on state afterwards. Save memory
remained on; five synthetic chats/analyses therefore affect the account's saved
metadata. Existing chat retention applies. No records were deleted. Restoring
automatic suggestions may resume background provider work, which was not metered.
Ten foreground actions are not a verified count of upstream attempts/retries.

Capture: [metadata-only JSONL](I1-browser-live-2026-11-22.jsonl).
Statistics: [imported report](I1-browser-live-report-2026-11-22.json). The CLI
report process was interrupted after it remained pending without output; the
capture was then validated and processed through the same runner's make_report
function directly. Its local tooling build is explicitly not_recorded/dirty;
the hosted backend identity above comes from the separate Render readback.
Visual check: [synthetic answer and idle composer](I1-live-evidence-2026-11-22.jpg),
cropped to exclude the sidebar/account. This adds real single-user observations
to the earlier fake-provider matrix; it does not replace or relabel fake results.
Top-three cause attribution, controlled thirty-minute idle, IDE capture, PO decision
and owner G2/peer G3 remain open. Synthetic accounts and the AO notification were
completed later on 2026-11-22, as recorded below.

1. Review [the protocol and commands](I1-implementation-plan.md) and run the new
   capture locally. The output must have only the documented enum/numeric fields.
2. Provide a preview/synthetic-account setup and an agreed live concurrency window.
   Do not reuse personal history or copy browser authentication into scripts.
3. Capture 1/5/20-user visible journeys and IDE initial load with sufficient rounds;
   confirm the IDE target. Import those captures with accurate model/version tags.
4. Run the separately controlled 30-minute idle experiment. I4 owns five-of-five
   post-fix acceptance; I1 must establish the baseline first.
5. Rank three evidenced causes, cost the options with dated official sources, and
   obtain the PO decision before I8 or paid changes.
6. Complete preview G2, peer G3 and the linked board evidence. No PR has been
   created, approved or merged by this work.

Global ClickUp searches for I1, latency, latência and capacity found no matching
I1 card, including future-week tasks. With the owner's conditional authorisation,
[I1 · Latency and capacity diagnosis](https://app.clickup.com/t/1an3cktb6h8)
was created in AdaptAI Work Item Pool and assigned to Francisco Nunes, in progress.
It records G1, local paths, evidence and open gates. Francisco Velhinho was informed
on the I1 card on 2026-11-22 (verified comment 1500950000038967).

## Technical HTTP burst load — 2026-11-22

The owner requested a narrower server-load check without concurrent model calls.
This completes the HTTP health burst experiment only; the original I1 journey
acceptance criteria and human gates have not been silently removed.

Production target: `https://adaptai-team2-api.onrender.com/api/health`.
Five sequential rounds per concurrency, each round launching 1, 5 or 20 parallel
requests, with 15-second request timeouts and a 130-request test budget.
All 130 requests returned HTTP 200; zero errors, timeouts or 429s were observed.
No model action, credential, paid service or server configuration change was used.

| Concurrent HTTP requests | Samples | Successes | p50 ms | p95 ms |
|---|---:|---:|---:|---:|
| 1 | 5 | 5 | 74.70 | 156.44 |
| 5 | 25 | 25 | 76.91 | 166.01 |
| 20 | 100 | 100 | 178.20 | 200.51 |

Evidence: [complete numeric/status report](I1-api-health-load-2026-11-22.json).
Percentiles use nearest rank over successes. Client monotonic stopwatch durations
include connection setup and task-completion polling overhead. The PowerShell
HttpClient runner was used after Python invocations failed to produce output and
were interrupted; a process check found no remaining Python process. One separate
diagnostic health GET returned 200 before the 130-request measured experiment.
No result from the interrupted Python invocations is available or included.

The health handler returns a small status response. This short, warm burst supports
only the conclusion that this endpoint responded at concurrency 20 during the run.
It does not establish authenticated/database throughput, analysis/chat provider
capacity, sustained-load stability, thirty-minute idle behaviour or an SLA.
The server's current deployment was not re-identified during this experiment;
the earlier hosted commit reference above is historical verification.

Account readiness: 20 synthetic Auth users were provisioned and confirmed earlier.
Ten were subsequently tested sequentially through application login, Profile and
sign-out; all ten succeeded, and save-memory, use-memory, conversation-memory and
automatic-suggestion settings were off. The remaining ten application logins were
not tested after the owner redirected work to the HTTP burst. These checks used
no model actions and do not represent concurrent sessions.

The HTTP burst sub-point is complete. I1 remains in progress for its original
unavailable measurements and PO/G2/G3 decisions; no peer approval is inferred.

## Extension host capture — 2026-11-24

The installed AdaptAI 0.3.0 was opened in a new README-only VS Code window.
Its initial backend setting pointed to an unavailable local server. During the
test, `adaptai.backendUrl` was set to the already authorised production API.
The extension recovered its existing token from its own secure storage; no
credential was entered, read, copied or exported. The production URL remains
configured for the owner's next manual check. The original setting was
`http://127.0.0.1:8000` if the owner wishes to return to local development.

Opt-in latency capture produced 38 completed metadata-only records: 33 API reads
and five host reloads, all successful. The reload p50/p95 was 1705.5/1789.7 ms.
These configuration-triggered/automatic reloads are neither controlled repetitions
of initial webview loading nor isolated synthetic-account measurements. Paint,
composer readiness and first visible text are excluded. Source:
[sanitised host capture](I1-ide-host-2026-11-24.json).

Native UI observation confirmed the authenticated composer and backend connection,
but window activation changed geometry and later input targeting became invalid.
The observed startup durations were discarded. No valid initial-load p50/p95 or
5/20-client IDE result is claimed. The test window was closed normally and its
absence was verified before the idle interval. No editor document was changed,
and no authentication dialog was automated. No foreground model action was requested. Existing
automatic background work was not metered; a GET to the coaching endpoint can
schedule work under the account's existing preference, so zero upstream calls
must not be inferred from the absence of an Analyse/Send action.

Render metadata was rechecked in the previously authorised Project-Team2 workspace:
one Free instance, same live backend commit `74d6872` and auto-deploy off. HTTP
request-count metrics and request logs returned no data. That is insufficient to
prove zero traffic. Resource data was sparse: one memory reading of 150966270 bytes
against a 536870900-byte reported limit; no CPU usage series was returned. These
observations cannot establish saturation or twenty-user authenticated capacity.

## Idle experiment outcome — 2026-11-24: inconclusive

The owner explicitly confirmed a thirty-minute no-use window. At 22:31:58 UTC,
there were no VS Code windows or AdaptAI browser tabs in the local inventories.
The agreed interval ended at 23:01:58 UTC. The test waited without application
polling, then made one health request and five warm comparison requests. All six
returned HTTP 200 with the expected JSON health payload. No model was called by
these health requests.

The first measured request started at 23:01:58.440 UTC and took 387.5084 ms.
The five following controls had p50 122.145 ms and p95 211.1588 ms. These are
short warm observations; they cannot prove the first-after-idle target.

Although Render request logs/metrics were empty, a later application-log query
provided access/lifecycle evidence for the complete interval. Four pages were
retrieved with no further page remaining, and duplicate log IDs were removed
in memory. The retained summary contains 349 records: 325 health GETs, ten other
GET requests and no POST/PUT/PATCH/DELETE requests detected. Health GETs include
monitoring traffic whose clients are not identified. The log shows shutdown
starting at 22:45:55.168 UTC, process exit at 22:45:55.270, and startup complete
at 22:52:48.543. No raw log messages, client addresses or account identifiers
were exported.

The server had therefore restarted and received other requests before the
scheduled measurement. The observed request is classified **warm**, with the
requested idle phase retained separately, and `idle_condition_verified=false`.
The idle trial is **inconclusive due to intervening traffic**, not a passing
388 ms cold start. The source of that traffic was not determined.

Evidence: [health observations and sanitised server-log summary](I1-api-idle-2026-11-24.json).
A valid repeat requires an isolated test destination or effective control of
all clients/monitors; repeating the same shared-service wait without that change
would not resolve this limitation. No extra repeat or hosting change was launched.

## Concrete manual acceptance handoff (G2)

After the idle experiment, the developer tests the deployed web app and the
installed extension against the production backend, recording date and build:

1. Open the Assistant and Profile; the page/panel must become usable without a
   blank or silently failed screen. Record an IDE initial-load measurement
   separately from the host timings above if reliable capture is available.
2. With a synthetic task and test account, verify one visible analysis and one
   chat answer. Stop a second synthetic answer midway and verify retained partial
   text. These are model actions and require an available run budget.
3. Verify stream-error feedback only in the controlled local/preview setup;
   record any unavailable check explicitly rather than injecting failure into
   the shared service.
4. Reply with a pass/fail result for each step. Earlier agent smoke checks do not
   constitute the developer's G2, and this production build is not automatically
   acceptance of the measurement branch.

The original 5/20-user real inference and IDE initial-load cells remain unavailable
under the owner's immediate health-only scope. Ricardo must explicitly accept a
reduced diagnostic scope or request those cells before I1 can close. A colleague
other than the author supplies G3 and merges after G2, the PR report and CI.

## Fresh automated delivery checks — 24 November 2026

At the owner's request, the remaining automated checks were executed against
the unchanged application code at `8313bfecf5c0304eff77e221f8a801b18e1eed1f`.
Only documentation/evidence changed in the working tree. These are local checks;
remote CI, developer G2 and independent peer G3 are not inferred from them.

| Check | Observed result |
|---|---|
| Ruff lint / formatting | Passed; 92 files already formatted. |
| Full backend | 691 passed, zero failed, in 406.15 s; total coverage 96%. |
| Core coverage gate | 99%, exceeding the required 80%. |
| Without chat and Prompt Coach | 534 passed, 12 deselected, zero failed, in 224.11 s. Optional files were excluded from a fresh tracked-source copy; original files were not deleted. |
| Frontend | Frozen-lockfile installation and TypeScript/Vite build passed. Existing >500 kB chunk warning remains. |
| Extension unit/flow suite | 257 passed; 11 integration cases were skipped in that unit run, then all 11 passed in a separate run against the disposable container backend. |
| Extension browser rendering | All three existing page/layout/navigation scripts passed, including streaming, stale replies, error/Retry handling and small viewports. |
| Playwright | All 51 tests passed in 2.5 minutes, including the 1/5/20 isolated-user captures. |
| Packaged containers | Build, assets/proxy, cookie/CSRF checks, demo analysis, SSE, recreation, test encryption-key continuity and retained login/data passed. |
| Runner CLI | A 26-sample simulation and import of all 390 browser-fake samples completed normally outside the restricted sandbox. |

The initial restricted extension run could not complete its local HTTP fixtures;
the unchanged suite passed with local network access permitted. The CLI metadata
step also stalled inside the restricted sandbox, but its normal simulation and
import commands completed outside that restriction. No application fix was made
to mask either environment limitation.

Fresh fake-provider evidence is kept separately from the 20 November sample:
[capture](I1-browser-fake-capture-2026-11-24.jsonl),
[computed report](I1-browser-fake-report-2026-11-24.json), and
[validation summary](I1-validation-2026-11-24.json). All 390 journey samples
succeeded. At concurrency 20, descriptive p50/p95 values in milliseconds were:

| Journey | Successful samples | p50 ms | p95 ms |
|---|---:|---:|---:|
| Profile revisit | 100 | 185.84 | 268.41 |
| Analysis to visible result | 100 | 1111.80 | 1733.17 |
| Chat to first visible text | 100 | 981.18 | 1185.49 |

These measurements use fake providers and shared test-machine resources. They
are not production LLM capacity or evidence of an I8 improvement. Host Node was
24.14.0 and Python 3.12.14; container frontend used Node 22 and backend Python
3.12.16. Differences from earlier environments stay visible.

A disposable Compose project, `adaptai-i1-checks`, is running locally for review
at `http://127.0.0.1:8080`. Real provider models/keys and the evaluation worker
are explicitly disabled in its test override. It uses local PostgreSQL and demo
responses; it does not change the published service or validate Render cold starts.
Synthetic credentials/state and raw test logs remain outside the published evidence.

No isolated Render preview is currently provisioned: readback still lists only
the shared production backend, with previews off. Creating another hosted backend
and isolated stored-data setup would need a specific G1 extension/AO notification;
the current measurement plan does not authorise silently provisioning it. The
prior idle trial therefore remains inconclusive, and native visible IDE-load
measurement remains unavailable. Automated acceptance work is complete for the
existing tooling scope; task closure still requires the explicit scope/PO decision
and human G2/G3 gates above.

## Delivery scope isolation — 24 November 2026

The original capture branch included thirteen unmerged WS2 commits. The I1
delivery now lives on agent/i1-delivery, starting from develop 39f4f73 and
containing only the approved measurement tooling, SQLite connection correction,
protocol and sanitised evidence. The WS2 implementation, .vscode settings,
unrelated lockfile, C1/I2 drafts and scratch card text were not transferred.
Historical captures and the 8313bfe validation table above retain their original
source identity. Separate checks of the clean delivery are required before
claiming readiness; a result from the mixed capture branch is not substituted.

Develop's existing cloud notes also report first requests taking 38–67 seconds
on 16/17 November. This is historical team documentation, retained as such;
it is not a newly verified I1 thirty-minute-idle sample. The inconclusive
24 November trial and the missing visible IDE-load cells remain explicit.
