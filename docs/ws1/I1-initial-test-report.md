# WS1 — Initial functional checks

Date: 2026-11-20. Owner: Francisco Nunes.
Status: Partial evidence only. I1 is not complete; no performance gate is approved.

## Environment and authorisation

Browser: existing authenticated Chrome tab at https://adaptai-team2.netlify.app/.
The user authorised browser tests and consumption of Groq quota. The deployed
commit was not established; these observations must not be attributed to the
current local branch as though both builds were identical.

The user separately authorised temporarily disabling Use memory in recommendations,
Save task text and AI responses, and Automatically update suggestions with Groq.
All three were observed off before live calls and restored to their original on
state afterwards. No historical conversation was selected as test input. No
credentials were requested, copied or exported. Restoring automatic suggestions
can resume normal background processing; total provider calls were not metered here.

Local branch: feature/ide-newfeatures. Existing untracked .vscode/ and extension
package-lock.json were left unchanged. No product source code was edited.

## Browser checks

| Check | Observed result | Limit |
|---|---|---|
| Existing session | Authenticated application displayed API online. | UI status, not independent service health telemetry. |
| Draft preservation | A synthetic Assistant draft survived navigation to Profile and back. | One observed round trip; no p50/p95 claim. |
| Analysis | Synthetic Python explanation task produced a recommendation and completeness profile. The displayed assessor was openai/gpt-oss-20b via Groq; displayed backend latency was 2719 ms. | One backend-reported sample, not click-to-visible timing or p95. |
| Recommendation versus chat model | Recommendation named Gemma 4 26B A4B; chat remained Auto and answered using openai/gpt-oss-20b without selecting Use. | Observes separation of recommendation and execution; no model-quality evaluation. |
| Chat completion | Synthetic task received a visible answer; Writing/Stop returned to the idle composer. | First-token latency was not measured. |
| Stop during generation | A longer synthetic reply was stopped; partial numbered text remained, with Stopped. and Retry visible. | No forced network disconnect or retry invocation was performed. |
| Empty and whitespace-only input | Analyse and Send were disabled. | Client-side check only. |
| My Progress refresh | The newly created synthetic analysis appeared after refresh; counters changed from 10 to 11 analyses and 7 to 8 confirmed choices after sending the answer request. | Test data now affects this account's aggregates. No records were deleted. |
| Automatic suggestions paused | My Progress showed Automatic updates are off during testing. | Does not prove absence of an already-running upstream call. |
| Preference restoration | The three authorised switches were observed checked and enabled again. | Original configuration restored. |
| Character boundary | Automated fill accepted 8001 characters despite a DOM maxLength of 8000; a subsequent normal-input experiment timed out before reaching the limit. The draft was cleared afterwards. | Inconclusive: fill can bypass normal browser input constraints. No oversized request was sent; do not report a confirmed product defect. |

Three foreground actions requested provider work: one analysis, one completed chat
answer and one stopped chat answer. This is not an audited count of upstream LLM
attempts, retries or resumed automatic guidance.

Visual evidence: [Stopped answer and partial text](browser-stop-evidence.jpg).
The capture excludes the account/sidebar area.

## Local automated checks

| Command/check | Result |
|---|---|
| Extension TypeScript build | Passed. |
| node --test test/diagnostics.test.js test/dashboard-latency.test.js | 17 passed, 0 failed. Covers diagnostic sanitisation, first non-empty text timing, stream errors, cancellation, partial refresh, stale responses and bounded client reads. |
| Initial pnpm test in vscode-extension, sandboxed | Interrupted after four chat-code failures and no further output. Superseded by the successful unrestricted runs below. |
| Initial targeted chat-code check, sandboxed | Four failures, including backend fetch failures. Re-running the same four cases with permission to reach local test HTTP servers passed all four without source changes. No product defect is established by the sandboxed failures. |
| node --test --test-timeout=20000 test/*.test.js, unrestricted | 257 passed, 0 failed, 11 integration tests skipped because no disposable backend was configured for that command. |
| Integration file with ADAPTAI_TEST_BACKEND set to isolated localhost:8031 | All 11 passed. Backend used a fresh ws1_ide_test_ schema, local auth, no provider keys, no .env input and no evaluation worker. The temporary API process was stopped afterwards. Combined extension coverage: 268 passed across these two runs. |
| Frontend pnpm build | Passed TypeScript and Vite. Non-blocking warning: main JavaScript chunk exceeds 500 kB. |
| pnpm exec playwright test in e2e, unrestricted | All 48 passed in 2.1 minutes. Existing isolated local backend, PostgreSQL schema and fake models; no live provider quota. |
| Ruff check and format check | Passed; 90 files already formatted. |
| Initial selected backend tests | Initially blocked by uv sandbox-cache permissions and unavailable disposable PostgreSQL. Docker Desktop was subsequently started with authorisation and the PostgreSQL service became healthy. Full backend suite with coverage is being validated separately. |

The four initial SEL-06 failures in vscode-extension/test/chat-code.test.js were
resolved by running outside the sandbox; all four passed without code changes.
No WS2 behaviour was modified. Never infer a production bug from the initial
sandbox-only result when later evidence contradicts it.

## Remaining evidence required

- Complete the backend suite and core coverage gate; local PostgreSQL is now healthy.
- Agree reproducible measurement settings and deployed build identification.
- Full four-journey matrix at concurrency 1, 5 and 20 with sample sizes and p50/p95.
- Isolated synthetic accounts for concurrent runs; one personal session cannot
  establish independent multi-user isolation or capacity.
- First request after at least 30 minutes idle; I4's five-of-five trial.
- Real/injected quota exhaustion, queue position/ETA, retry/backoff and C1 metering
  checks once I2/I3 exist; no quota-exhaustion result is claimed here.
- Controlled mid-stream network failure, separate from user-requested Stop.
- Privacy marker tests on all new storage/logging paths; UI observations do not
  establish that database/log retention rules pass.
- Before/after attribution of the three largest latency causes, dated free/paid
  options, PO decision, preview G2 and peer G3.

After these initial checks, Francisco Nunes approved G1 for the
[I1 implementation plan](I1-implementation-plan.md). The bounded runner and a local
browser capture were implemented; see the [partial baseline](I1-baseline-report.md)
for the subsequent results and remaining gates. No product instrumentation or
provider path was changed.

This report supplies initial evidence for I1 and a subset of I7 behaviour. It does
not close I1, I2, I3, I4, I5, I6, I7 or I8, and it does not constitute G1 approval
for product implementation.

## Deployed browser follow-up — 2026-11-21

The owner asked the agent to test the already-running project in their browser.
The existing Chrome tab used https://adaptai-team2.netlify.app/. The deployed
commit remains unidentified; these observations do not establish acceptance of
the local I1 branch. This was a sequential functional check in the owner's
existing account, not the isolated-account concurrency protocol.

The three previously authorised settings (Use memory in recommendations, Save task
text and AI responses, Automatically update suggestions with Groq) were observed
on, temporarily turned off, confirmed off before inference, and restored to on.
All five displayed switches, including the unchanged Save memory and Prompt Coach
switches, were confirmed on and enabled after restoration. Synthetic test metadata
and chat messages remain in the account. No records were deleted. Restoring automatic
suggestions can resume background provider work; this was not metered.

| Check | Observed result | Limit |
|---|---|---|
| Account/API startup | Loading your account eventually gave way to the authenticated app; API online appeared. | No timed startup measurement or verified thirty-minute idle condition. |
| Public privacy page | Privacy opened and Back to sign in returned to the loading/account view. | Display/navigation check only. |
| Empty and whitespace input | Analyse and Send were both disabled for empty input and three spaces. | Client-side check; no invalid request submitted. |
| Draft across navigation | The synthetic draft was preserved exactly after Assistant → Profile → Assistant. | One observed round trip. |
| Real analysis | The Python list-versus-tuple task produced a provisional recommendation, coverage table and seven-dimension profile; completeness 73/100. The UI reported groq, openai/gpt-oss-20b, 2525 ms. | One backend-reported value, not end-to-end latency or p95. Model quality was not evaluated. |
| Recommendation/execution separation | The recommendation named dots-3-note-preview:free; Auto remained selected and the chat displayed openai/gpt-oss-20b. | Use was not selected; no BYOK provider was invoked intentionally. |
| Chat completion | The initial task received a visible formatted answer and returned to the idle composer. | First-text time was not measured. |
| First Stop attempt | The eighty-tip answer completed before the next observation. | Inconclusive for Stop; no cancellation claim from this attempt. |
| Streaming and Stop | A further synthetic request rendered STREAMCHECK21 lines. Stop was clicked after the first line became visible; four complete lines and a partial next prefix remained, with Stopped and Retry. | Demonstrates partial rendering/cancellation in one run, not transport-level token timing. Retry was not invoked. |
| My progress | Loaded with 12 analyses, 9 confirmed choices and 3 pending choices; the new synthetic session appeared in the activity chart. Automatic updates are off was visible during testing. | No before/after counter delta was measured in this run; synthetic activity affects aggregates. |
| Reload persistence | After reloading, reopening the synthetic chat and waiting for it to load, the partial STREAMCHECK21 answer and Retry were present. Profile also retained the three temporary off settings until restoration. | Immediate checks during loading were inconclusive and were superseded by the loaded-state observation. |
| Preference restoration | All three changed switches were confirmed back on and enabled. | Background suggestions may resume under the owner's existing permissions. |

Four foreground actions requested model work: one analysis and three chat sends
(two completed, one stopped). This is not an audited upstream-attempt count and
does not include retries, background evaluation or suggestions. No credentials,
account identifiers or pre-existing conversation content were copied into the
saved evidence. The screenshot intentionally contains the synthetic test prompt,
partial answer and composer; account and sidebar details are excluded. It is
manual visual evidence, not a metadata-only timing capture.

Visual evidence: [Partial answer retained after Stop](I1-browser-stop-2026-11-21.jpg).

No confirmed functional defect was established by these checks. Not exercised:
concurrency 1/5/20, a controlled thirty-minute idle trial, quota exhaustion, forced
mid-stream network failure, IDE loading, Prompt Coach inference, BYOK execution,
account creation/sign-out, deletion/export, or backend storage/log marker inspection.
These observations supplement I1/I7 evidence; they do not close either card or
replace the owner's G2 result and peer G3.
## Follow-up observation — 24 November 2026

Installed AdaptAI 0.3.0 was opened in a new README-only VS Code window. Its
localhost backend was unavailable; selecting the existing production URL allowed
the stored secure session to reconnect and the authenticated composer to appear.
No credential was entered/read/exported, no inference action was requested and
no project source was edited. Existing optional background work was not metered.

The local opt-in capture yielded 33 successful API reads and five successful host
reloads (p50 1705.5 ms; p95 1789.7 ms). The capture passed allowlisted-field and
numeric/outcome validation. It excludes paint/composer readiness. Native input
geometry changed during startup observation, so those visible-load timings were
discarded. The test window was closed normally, and absence of VS Code windows
and AdaptAI browser tabs was verified before the owner's quiet window.

Evidence and remaining G2 checks are in [the baseline](I1-baseline-report.md).
This is agent-observed functional evidence, not the developer's manual G2 and
not acceptance of a future PR or a twenty-user IDE load.

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
