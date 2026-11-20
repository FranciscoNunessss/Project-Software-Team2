## Objective
WS1 / Francisco Nunes / W12 Essential. Establish p50/p95 for page change, analysis, chat first text and IDE webview load at 1, 5 and 20 users; identify the top three evidenced causes and obtain PO approval of costed options. Feeds I2, I3, I4, I8 and D2.

## G1
Francisco Nunes explicitly approved the I1 measurement implementation plan in Codex chat on 2026-11-20. Branch: `agent/ws1-latency-diagnosis` (local; not pushed). Architecture Owner informed: pending; review is required before live concurrent/external-integration changes. No notification has been sent by the agent.

## Specification and plan
Repository paths (remote links pending G2/PR): `docs/ws1/I1-spec.md`, `docs/ws1/I1-implementation-plan.md`. Cases I1-S1 through I1-S11 map to automated or manual evidence: complete/missing matrix; nearest-rank statistics; failure accounting; first visible non-empty text; idle separation; quotas/budget; invalid setup; privacy/injection; simulated versus real labels; evidenced causes/PO decision; comparable before/after runs.

## Implementation
`scripts/measure_latency.py`: bounded simulation, explicit health-only probe and strict timing-metadata import. No provider bypass, production migration, C1/C2 extension, AI input, model or hosting change. New deterministic tests: `backend/tests/test_latency_measurement.py`. Visible local browser capture: `e2e/latency.spec.ts`.

## Evidence so far
`docs/ws1/I1-baseline-report.md` and `docs/ws1/I1-initial-test-report.md`; metadata-only JSON reports under `docs/ws1/`. Extension: 257 unit/flow tests plus 11 integration tests passed. Existing Playwright suite: 48 passed; expanded I1 captures: all 3 cases (1/5/20 isolated users, five rounds each) passed, with 390 successful web-journey samples and no recorded errors. Runner plus privacy-marker checks: 42 passed. Ruff and frontend build passed. Core coverage: 99% (80% gate). Full backend baseline: 656 passed / 6 failed; two connection failures passed separately, the owner approved a limited G1 extension to close the SQLite snapshot connection explicitly. Two new regressions failed before the fix; all 53 PostgreSQL, measurement and privacy tests passed afterwards. The full suite rerun is pending.

## Still required
Preview and isolated synthetic accounts, concurrent-test window, 1/5/20-user visible measurements, IDE initial-load target/capture, 30-minute idle baseline, top-three cause attribution, dated free/paid options, Ricardo's PO decision, deployed-preview G2, CI/PR and peer G3. Current fake-provider timings do not prove production p95 or capacity. D2 stays free plans.

## G2
Pending. Follow the local commands and preview checklist in the approved plan. Do not close this card until the complete I1 acceptance criteria and global Definition of Done hold.

## Approved SQLite correction
Francisco Nunes approved the limited scope extension in chat on 2026-11-20: `backend/migration_tools/sqlite_import.py` closes its read-only snapshot connection explicitly; `backend/tests/test_postgres.py` verifies success/error closure and source-file preservation. No schema, migration SQL, stored values or import logic changed.
