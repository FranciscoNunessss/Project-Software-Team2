# Development Readiness Review

AdaptAI · Evidence from the current Drive documentation and local repository · Weeks 7 and 8

| Field | Value |
| --- | --- |
| Status | Draft analysis and proposed work order; not a milestone acceptance or a scope decision |
| Version | 0.1 · 24 October 2026 |
| Owner | To be designated by the team if adopted |
| Reviewed by | |
| Repository baseline | `0f1acfb`, branch `feature/extend-llm-support` |

## 1. Purpose and limits

Identify the implementation and evidence still needed for the walking skeleton and Proven Architecture milestones. Current product, architecture, construction, quality and planning documents govern this review. Superseded documents and reference-library material are not additional implementation commitments.

Repository observations are local. ClickUp acceptance criteria, current board status, GitHub branch protection and remote CI results were not independently verified. Passing local checks does not establish human acceptance, assessment accuracy or live provider connectivity.

## 2. Calendar

Plan the Release, section 7.3, records the following dates:

| Week | Milestone | Planned boundary |
| --- | --- | --- |
| 6 | Kick-off: Stakeholder Vision | By 25 October 2026 |
| 7 | Walking skeleton | By 1 November 2026 |
| 8 | Proven Architecture | By 8 November 2026 |
| 9 | Continued Viability | By 15 November 2026 |
| 10 | Sufficient Functionality | By 22 November 2026 |
| 11 | MVP | By 29 November 2026 |

According to that dated plan, the next week after 24 October is week 7. Week 8 is the following milestone. These are the document's dates; the course calendar has not been independently reconciled.

## 3. What exists

The repository implements a first Assistant slice: React submits text to FastAPI; an assessment provider produces a Pydantic-validated profile; a LangGraph workflow matches it against a JSON catalogue; the UI displays the result and lets the user select an eligible alternative.

| Area | Evidence | Assessment |
| --- | --- | --- |
| Text intake and API contracts | `backend/app/models.py`, `backend/app/main.py`, `frontend/src/api.ts` | Implemented for text; rejects blank and oversized tasks and unknown fields |
| Semantic provider boundary | `backend/app/providers.py` | OpenAI, Groq and Ollama adapters/configuration exist; credentials remain backend-side |
| Workflow | `backend/app/workflow.py` | Explicit `assess -> match` graph; no observable/semantic fusion or uncertainty-driven routing |
| Capability filtering and ranking | `rank()` in `backend/app/workflow.py` | Filters capabilities, then selects the closest sufficient scalar tier; quality remains uncalibrated |
| Catalogue | `backend/data/catalogue.json` | Versioned illustrative fixtures; no verified real-model catalogue |
| Explanation and alternatives | Workflow rationale and `frontend/src/App.tsx` | Functional first slice; reasons cover three dimensions and a generic policy explanation |
| Selection/override | `POST /api/decisions` | Transient acknowledgement only; latest 256 analysis choices retained in memory, consumed on selection |
| Privacy precautions | Consent checks, sanitised errors, tracing disabled, no workflow checkpoints | Useful protections; persistent-session privacy is not proven because session storage does not exist |
| Progress and team views | `frontend/src/App.tsx` | Explicit static design previews |
| CI configuration | `.github/workflows/ci.yml` | Backend tests/lint/format and frontend build; no quality eval or coverage gate |

The README records a successful Groq integration smoke test on 21 October. This is existing project evidence, not a new live verification in this review. Mock adapter tests do not establish a second working provider.

## 4. Requirement gaps

These statuses describe implementation, not the team's Definition of Done.

| Requirement | Status | Remaining work |
| --- | --- | --- |
| FR-01: text input | Implemented locally | Confirm the card's complete acceptance criteria and human review |
| FR-02: document input | Absent | MVP inclusion remains open under OI-1; do not assume it is required for week 8 |
| FR-03: seven-dimensional profile with confidence/evidence | Partial | Add domain specificity, risk of error, tool/integration need and modality; define the rubric and evidence/uncertainty contract |
| FR-04: catalogue-based recommendation | Partial | Validate matching/ranking against realistic labelled tasks and sourced catalogue facts |
| FR-05: readable justification | Partial | Explain the actual dimension/capability trade-offs, uncertainty and meaningful alternatives; evaluate with reviewers |
| FR-06: override | Partial | Selection works for eligible catalogue choices; confirm intended acceptance semantics with the card |
| FR-07: preserve and log overrides | Absent | Store permitted metadata while preserving the original recommendation |
| FR-08: usage session per interaction | Absent | Introduce the approved metadata-only storage boundary and timestamps |
| FR-09: pattern detection | Absent | Begin with over-provisioning for the MVP OKR; PO must reconcile this with the requirement for three patterns |
| FR-10: personalised learning suggestion | Absent | Implement after permitted history and detection exist |
| FR-11: editable catalogue without a code release | Partial | JSON is separate data, but loaded at process import; no validated maintenance/reload workflow or real-model records |
| FR-12: first recommendation without manual setup | Not validated | Local developer startup exists; the non-developer usability outcome has not been established |

`Profile` currently contains `reasoning`, `context`, `ambiguity` and one explanation. The global `confidence_basis` string acknowledges lack of calibration; it is not confidence and evidence per dimension. The frontend explicitly labels the other four scores as unimplemented.

NFR-07 is also partial: changing dimensions currently requires changes to backend schemas and frontend rendering. NFR-04 auditability is missing without timestamps and persistent usage records. Performance has a measured latency field, but no agreed target or evaluation distribution.

## 5. Proposed work order

### 5.1 Close walking-skeleton gaps for week 7

1. **Prepare the labelled task set v1 and rubric.** Cover simple, intermediate, difficult, ambiguous, specialised, high-consequence and capability-dependent tasks, plus boundary and injection cases. Obtain the human labels/reasons and client agreement required by OI-8. AI-generated examples must not be presented as independent human labels.
2. **Make the first slice reproducible for another team member.** Retain the working text-to-choice demo; confirm its acceptance criteria and non-author review. Record the actual model/configuration and limitations.
3. **Validate a second real provider or local runtime.** ADR-008 requires two real integrations. If account/runtime access is unavailable, record the dependency and obtain a PO replan; do not count the demo heuristic or mocked tests as that integration.
4. **Close engineering and decision-record gaps.** Add the root `AGENTS.md` described by the AI Working Guide; reconcile the Git workflow documents; have the AO record the actual status of ADR-007/008. Record significant AI assistance through the prescribed human-owned channels.

### 5.2 Prove the core for week 8

1. **Complete a testable profile contract.** Implement the seven dimensions and evidence/uncertainty representation after the rubric is agreed. Update provider output validation, API contracts and frontend together. Test valid output, missing dimensions, invalid scales and uncertain input.
2. **Compare assessment approaches.** Evaluate an observable/rules baseline and the proposed layered approach on the same labelled set. The current word-count demo is an explicitly unvalidated size proxy, not a demonstrated semantic baseline. Measure whether the semantic step improves results enough to justify its latency and cost.
3. **Build the evaluation runner and CI gate.** Store task-by-task results with date, commit, model/configuration and catalogue/policy versions. Record profile/recommendation agreement, disagreements, explanation review, latency and available token/cost evidence. Use the relevant subset for ordinary changes and the full set before the milestone. Distinguish offline contract tests from actual model-quality runs; cached/fake outputs alone cannot prove current model quality.
4. **Ground catalogue and recommendation policy.** Replace or supplement fixtures with a small sourced/versioned catalogue containing the necessary verified capabilities, constraints and observation dates. Include pricing only when verified. Derive explanations from the same evidence as ranking and expose uncertainty. Do not claim monetary savings from illustrative tiers.
5. **Enforce the documented quality checks.** Measure core-logic coverage and enforce the adopted minimum of 80%; add the eval regression rule, including the documented block for a drop greater than five percentage points unless the AO accepts it through an ADR. Include injection-resistance and policy/capability failure cases.
6. **Prepare the ADR-003 decision package.** Present the measured options, disagreements, limitations and recommended approach. The AO decides; the PO records the milestone outcome. Neither a green pipeline nor this review constitutes that decision.

The PO should size and order the cards against approximately 25 net team-hours per week. This list is a dependency order, not a promise that all work fits one week. Keep genuine human validation and the highest-risk assessment proof ahead of additional interface features.

### 5.3 Subsequent MVP work

Week 9 introduces the thin Educator slice: approved metadata-only usage sessions, retained original recommendation/override, timestamps, over-provisioning detection, control histories and a specific coaching suggestion. Review ADR-005 before storage; free-text explanations must not accidentally preserve task content.

Week 10 integrates the Must scope, privacy checks and the non-developer usability session. The week-11 demo must work from a clean start. The existing design previews do not satisfy these outcomes.

Document upload, organisation dashboards, an IDE extension, full offline operation, automatic task execution and autonomous agents are not week-8 priorities in the current plan. Some remain open client decisions rather than permanently excluded capabilities.

## 6. Inconsistencies requiring an owner

| Finding | Evidence | Decision/action owner |
| --- | --- | --- |
| Different Git integration rules | Local `GIT_WORKFLOW.md` prescribes feature branches into `develop` and rebase-and-merge; Drive Construction/WoW prescribe per-card branches and squash-and-merge into `main` | AO/TL reconcile the actual agreed workflow; do not silently change branches or protections |
| Architecture acceptance not recorded | ADR register and full ADR-007/008 documents still describe proposed directions/human review pending | AO records the actual decision and its evidence |
| Documentation predates implementation | Product Specification section 4 and parts of architecture/quality/release documents still say no code or environment exists | Document owners update these claims from repository evidence |
| Different dates for the 16/20 target | Construction section 1 associates the threshold with the week-8 proof; Charter KR1.1 targets MVP and Final | PO/AO clarify the milestone gate; report week-8 measurements without inventing acceptance |
| Educator scope mismatch | Product Specification FR-09 says all three patterns are Must; Charter KR2.1 requires one at MVP and three at Final | PO aligns the staged requirement and cards |
| Sensitive-data/paid-service/synthetic-history questions remain open | Charter OI-2; model availability alone does not settle these questions | TL obtains and records the external answers; use permitted synthetic tasks for evaluation |
| Board acceptance cannot be inferred | Card-specific acceptance criteria live in ClickUp | PO confirms the actual Ready cards and acceptance criteria |

## 7. Verification performed on 24 October 2026

| Check | Local result |
| --- | --- |
| `uv run --locked python -m pytest -q` | 32 passed |
| `uv run --locked python -m ruff check backend scripts` | Passed |
| `uv run --locked python -m ruff format --check backend scripts` | Passed; 8 files already formatted |
| `uv lock --check` | Passed |
| `pnpm build` in `frontend` | TypeScript and Vite build passed |

No live model call, new human recommendation review, coverage measurement, browser walkthrough, remote CI inspection or milestone acceptance was performed. No product code or Drive document was changed by this review.

## Sources

- [Start Here v1.2](https://docs.google.com/document/d/18KP-eeI-v0OErxcljlsFH1H_Q0l7UnkuroOYO38Xz1U/edit): document routing and glossary.
- [Process Charter v0.8](https://docs.google.com/document/d/1QY-hQwq8L-Lg3fxAXMhCRqfYRkXacbnX9BalfaDHqhw/edit): milestones, OKRs, open issues and decision rights.
- [Plan the Release v0.6](https://docs.google.com/document/d/1IBTIaH3a2s-G3CL93tWTKJ1Xw0U2fsMk0hIPN_bty0E/edit): sections 7.1–7.3, implementation forecast and dated milestones.
- [Product Specification v0.4](https://docs.google.com/document/d/18WfEuqK67yT28K3edEjQnLsR1v72rx7AwiixXrfHF40/edit): FR/NFR requirements and sensitive-data policy.
- [Explore Scope v0.6](https://docs.google.com/document/d/11RoA_6J1g_-q_5kpaV4iWCWOrHCSOm1ON9u-z91EQl4/edit): sections 9–10, staged MVP scope.
- [Architecture Strategy v0.5](https://docs.google.com/document/d/1874AwHyLcBYYjbqnMAuMZP-NRoirc2k1Q0FMIWnFo8M/edit): profile, layered assessment, catalogue, privacy and runtime boundaries.
- [Architecture Decision Records v0.2](https://docs.google.com/document/d/1vEvDF4GHr_diof6_cTibz4WwOo7Up5j2LTGvPhywpq0/edit): ADR-003 proof and ADR acceptance status.
- [ADR-007](https://docs.google.com/document/d/1nYv2V3qVu7JhkedKD31n-TyjsXwVnYHe5CZAvsG-JfI/edit): stack, bounded workflow and validation.
- [ADR-008](https://docs.google.com/document/d/14OXD4V0bvVtcoSMAqIJptNDTzpt6bDBlLk7qlKJZ4BU/edit): provider/model separation, two real integrations and failure policies.
- [Construction v0.2](https://docs.google.com/document/d/1oeo2VXkMuvGihm395WDgAFzwvVpwhzK-mQTg7cKl6c4/edit): milestone criteria, Git workflow, code DoD and provider controls.
- [Test and Quality Strategy v0.5](https://docs.google.com/document/d/1boAIXX4BLTr4ZOLHAORu3jbm4LK_TaJWz-68ZKV2rM4/edit): independent blind review, coverage and section 7.2 eval rules.
- [Transition v0.1](https://docs.google.com/document/d/1k11hPoneDQXF_j9IlEwju97Eqh2qCPFwo_81QloTyBs/edit): clean-start demonstration and Definition of Delivered.
- [AI Working Guide v1.0](https://docs.google.com/document/d/1d3j90AVlVQdGIOobpDox-ZT3dAL2nzAGA9BKjQaNR8I/edit): agent instructions, draft autonomy and root `AGENTS.md`.
- [AI Integration Policy v0.5](https://docs.google.com/document/d/1bgwZqb4w_kASov35ds7VgBQWmMklzBHbDDLfB4RzqDs/edit): disclosure and data restrictions.
- Local repository files cited in sections 3–4 and the commands in section 7.

## Revision history

| Version | Date | Change | Reason | Reviewed by |
| --- | --- | --- | --- | --- |
| 0.1 | 24 October 2026 | AI-assisted repository/documentation comparison and proposed work order; human decisions and reviews not filled in | Prepare the next increment and the week-8 architecture proof | |
