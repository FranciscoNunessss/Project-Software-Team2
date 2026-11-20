# I1 baseline — partial local evidence

Owner: Francisco Nunes. Date: 2026-11-20. G1 approved in chat for measurement tooling.
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

## Top-three causes and options

Not established yet. The three measured local journeys are not a ranking of
production bottlenecks. No database/provider attribution or paid-host price is
invented from this sample. Next evidence must distinguish client orchestration,
backend/database work, provider time, quota waiting and first-after-idle latency.

Free/paid option comparison and current official pricing sources remain pending
those measurements. D2 stays free plans. No hosting, model, prompt or catalogue
change has been made. Ricardo's PO decision has not been received.

## Manual acceptance and remaining gates

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
It records G1, local paths, evidence and open gates. Architecture Owner notification
remains pending; no unrelated card was edited and no message was sent to another person.
