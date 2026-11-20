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
