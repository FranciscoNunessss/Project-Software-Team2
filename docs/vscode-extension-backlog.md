# VS Code extension: backlog

10 November 2026. What is left for the extension to do everything the web app does, written so
that each item can be picked up without asking. Read the [developer guide](vscode-extension.md)
first, and [ADR-013](adr/ADR-013-vscode-extension.md) for the decisions.

Prepared with AI assistance (Claude, Anthropic); human review pending.

**Update 11 November 2026.** Built on the branch `feature/ide`: IDE-01, IDE-02, IDE-03, IDE-05, IDE-07 and IDE-08 are done; IDE-10 was audited and closed; IDE-12 is partly done. IDE-04 (choose a file) was dropped by the team: it adds little in an editor, where the text is already in a file or a selection. Sessions and the export read from the same backend routes the web app uses; the team expects these to move to Supabase on develop, in which case the extension only needs its address and credentials (the routes and shapes do not change). The same day: the Coach can run after every analysis (an opt-in setting, `adaptai.coachAfterAnalysis`, switched on in Profile with its own consent dialog), the text box shows local hints while you type (nothing is sent), the analysis cards were made to say what the web app says, and 21 error codes the web app explains were added. The Assistant screen was rebuilt after the web app's chat screen (messages, composer with model picker and Prompt Coach bubble, analysis panel docked or as a bottom sheet) and the separate Chat tab was removed; the chat is the Assistant. What is open now: IDE-11 (a person in a real window) and the formal sign-off of IDE-14 at review.

**Update 11 November 2026, later.** IDE-12 is done. IDE-06, IDE-09, IDE-13, IDE-14 and IDE-15 were decided (see [ADR-013, Decisions of 11 November 2026](adr/ADR-013-vscode-extension.md)). Also fixed that day: the chat answer limit (a cut-off answer is flagged and offers Continue), an OpenRouter chat model no longer makes the analysis fall back to the demonstration model, a mention of an attachment is flagged, and the connection test of a reasoning model has room to answer. The accuracy study is in [analysis-accuracy](analysis-accuracy/report.md).

## Status of the parity

| Area of the app | In the extension | Gap |
| --- | --- | --- |
| Account: register, sign in, sign out | Done | Supabase mode (IDE-06), password recovery and legacy-history link (IDE-09) |
| API tokens | Done (needs the password, 10 minutes) | None |
| Analyse, result cards, Use this model, Task solved? | Done | None (file upload dropped, IDE-04) |
| Prompt Coach | Native diff, Apply, Undo, and in the page (Rewrite, Edits, Tips, Use this text) | None known |
| Chat | Done (streaming, Stop, Retry, `/analyse`, list, rename, delete, a model for one message including the OpenRouter catalogue) | None known |
| History and sessions | Done: list, open an analysis, Continue, delete | None known |
| My progress | Done: numbers, charts (activity and recommendation match), outcomes, learning, patterns, Educator, pending choices, export with chats | None known |
| Profile | Switches, preferences, learned memory, deletions, conversations, tokens | None known |
| LLM config and evaluations | Done (CRUD, test, consent, disagree, OpenRouter catalogue) | None: the web does not use `/api/catalogue`, `/api/providers` or `/api/rubric` either (IDE-10) |
| Shortcuts | Keys of origin, Change opens the keyboard editor | Show keys the user changed (not possible through the API) |

## Items

Each item: why it matters, what the web app does, the work, what is done when it is finished.
Size is a rough guess for one person who knows the code: **S** under half a day, **M** one to two
days, **L** more.

### IDE-01 · Conversations in the export (S) · DONE 11 Nov 2026

* **Why.** The export is the user's right to their data; it must match the app's.
* **The app.** `Progress.tsx` `exportData` collects `context`, `progress/coaching` and every session with its analyses. The saved conversation text is part of the sessions.
* **Work.** `Dashboard.exportData()` already writes preferences, coaching and sessions. Add `GET /api/chats` and `GET /api/chats/{id}` for each chat. Only chats that exist are exported; nothing is requested when saving is off.
* **Done when.** The JSON has a `chats` array; a test with a stub backend checks the calls and the file content; the integration test exports after a chat.

### IDE-02 · Session detail and Continue in Assistant (M) · DONE 11 Nov 2026 (delete yes, rename no: the backend has no rename)

* **Why.** Without it a past analysis cannot be reopened or continued.
* **The app.** `Progress.tsx` shows a session (`GET /api/sessions/{id}?limit=&offset=`), its analyses (`HistoryAnalysis.tsx`) with the choice, and **Continue in Assistant** (`onResume`) which reopens the analysis and sends the next one with the same session id and `previous_analysis_id`.
* **Work.** New dialog or screen section in the page: list of sessions → open one → its analyses with the recommended and chosen model. **Continue** stores the session id and the analysis id on the `Analyser` (a new field, `continueFrom`, to add) and passes them to `analysisPlan(..., { sessionId, previousId })`, which already accepts both. Add rename and delete of a session (`PATCH`, `DELETE /api/sessions/{id}`).
* **Done when.** A session opens, an analysis can be reopened as the result cards, Continue produces an analysis with `changes` against the previous one, rename and delete ask first. Stub test plus an integration test.

### IDE-03 · Charts and patterns in My progress (M) · DONE 11 Nov 2026

* **Why.** The web shows "Your judgement over time", the match chart and "What your choices reveal"; the extension has numbers only.
* **The app.** `ProgressDashboard.tsx`, `LearningProgress.tsx`; data from `GET /api/progress/dashboard` (series), `/learning` (points), `/activity`.
* **Work.** Draw with inline SVG in the page (a small `chart()` helper: bars and a line, theme colours, a text alternative). **No chart library**: the Content-Security-Policy allows no remote script and the page must stay small. Provide a table below each chart for accessibility.
* **Done when.** Activity and recommendation-match charts, the completeness line, readable in light and dark and at 300 px; data tables present; a test of the helper with fixed input.

### IDE-04 · Choose a file to analyse (S) · DROPPED by the team (11 Nov 2026)

* **Why.** The web composer accepts a file (`upload-link`).
* **Work.** A **Choose a file** button in the Assistant: `showOpenDialog`, then `Analyser.fromUri(uri)` (it already refuses `.env`, keys, binary files and files over 200 KB). Show the file name and size in the composer before sending.
* **Done when.** A text file is analysed with the same consent as a selection; a secret file is refused with the message; tests in `flows.test.js`.

### IDE-05 · Model choice per message (M) · DONE 11 Nov 2026

* **Why.** The web has a model picker in the chat (`ModelPicker.tsx`, `OpenRouterModelPicker.tsx`); the extension has one chat model for everything.
* **Rules.** ADR-014 A11: analysis always uses the project assessor; the picker is for the chat. Keep that.
* **Work.** A model menu in the chat composer that applies to the next message only (including OpenRouter catalogue models, `GET /api/openrouter/models`, shown with their evaluation state, with "Evaluate" that opens the consent dialog). `ChatService.send` takes an optional model; the setting `adaptai.chatModel` stays the default.
* **Done when.** A message goes to the picked model and the next one back to the default; an external model asks the usual confirmation; stub and integration tests.

### IDE-06 · Supabase (cloud) mode (L, needs a Supabase project) · DECIDED 11 Nov 2026: keep "paste a token", build the browser sign-in later

* **Why.** In cloud mode the password is checked by Supabase, so the extension cannot register, sign in or open a password session.
* **Today.** The extension answers `use_supabase_auth` with "paste a token". Tokens are created in the web app.
* **Options.** (a) keep it, and document it; (b) sign in through the browser with Supabase and receive the access token by a URI handler (`vscode://adaptai-dev.adaptai/auth`), then create the token with it; (c) refresh the Supabase token inside the extension. (b) is the recommended path; (c) is heavy.
* **Work.** Decide with the Architecture Owner, then implement (b): a `UriHandler`, a PKCE-less flow that returns a short-lived access token, `POST /api/tokens` with it (the backend's `SessionUser` must then accept a Supabase JWT for token creation; it is a backend change and needs review).
* **Done when.** Registration and sign-in work against a real Supabase project, a token is issued and used, and the cloud acceptance checks in [cloud-setup](cloud-setup.md) pass.

### IDE-07 · The Coach inside the page (M) · DONE 11 Nov 2026

* **Why.** The web shows tips and a rewrite next to the composer (`PromptCoachBubble.tsx`, `PromptCoachTips.tsx`, `CoachingPanel.tsx`); the extension uses the native diff, which is better for a prompt in a file but not for text written in the page.
* **Work.** In the Assistant, a **Improve this prompt** button under the text that calls `POST /api/prompt-coach` (it needs an `analysis_id`, so it runs on the analysis of that text) through `Analyser.coach()` and shows tips, edits or the rewrite as cards with **Use this text** (replaces the page text). Keep the diff and Apply for prompts in a file.
* **Done when.** Tips, edits and rewrite are shown; the "nothing to improve" and the Coach-off states are clear; Coach off in Profile hides the button.

### IDE-08 · Solved-tasks list (S) · DONE 11 Nov 2026 (the app shows counts only, so the extension shows the same counts)

* **The app.** `TaskOutcomes.tsx` ("Your solved tasks").
* **Work.** Show the per-model table already loaded and the answers per task if `GET /api/progress/outcomes` returns them; otherwise leave the table and close the item.

### IDE-09 · Password recovery and the legacy-history link (M) · DECIDED 11 Nov 2026: not in the extension

* **The app.** `Account.tsx` has recovery and "Keep your existing history" (`POST /api/auth/link-legacy`).
* **Work.** Decide if both belong in the extension (they are account flows, mostly cloud mode). If yes: dialogs for them in the sign-in flow. If no: record the decision in ADR-013 and link to the web app for them.

### IDE-10 · Providers, catalogue and rubric routes (S, audit) · CLOSED 11 Nov 2026

* **Why.** A route comparison found these `/api/` routes unused by the extension: `/api/catalogue`, `/api/providers`, `/api/rubric`. The comparison was by route prefix, so it is only a hint.
* **Work.** Read what the web app does with each. Add a read-only "About the models" card in LLM config if the web shows them; otherwise note in this item that the web does not either and close it.

### IDE-11 · Real-window verification (M, needs a person)

* **Why.** Nothing in the page was clicked through in a real VS Code window by a person; tests ran through code, a real backend and a mock page.
* **Work.** Do the [manual checklist](#manual-acceptance-checklist), fix what breaks, and record the date and VS Code version in ADR-013 "Evidence".

### IDE-12 · Clean-up of the first build (S) · DONE 11 Nov 2026

* **Work.** The side-bar trees (`ChatsView`, `ModelsView`, `ProfileView`, `HistoryView`) are no longer registered. Move what the page still uses (data loading, `describeEvaluation`, `consentText`, `PROVIDERS`) into plain modules, delete the tree code and the commands that only served the trees (`adaptai.modelEdit`, `adaptai.evaluationConsent`, …) from `package.json`, and keep the tests that cover the rules.
* **Done on 11 Nov.** The tree of chats, the history tree and the commands that served the trees were removed (the page does all of it). Then `ModelsView` and `ProfileView` were deleted too: their flows (add, edit, delete and test a model, the consent of an evaluation, the OpenRouter catalogue, the switches, the preferences and the deletions) are tested through the page in `test/dashboard-models.test.js`, and the helpers the page uses (`describeEvaluation`, `consentText`, `PROVIDERS`, `CAPABILITIES`, `CONSENT`) stay in `models.ts` and `profile.ts`.
* **Done when.** `pnpm test` passes, no class exists only for a test, and the guide's table row about the first build is replaced by the one about the page's helpers. Done.

### IDE-13 · Hosted backend and distribution (M, a decision) · DECIDED 11 Nov 2026: `.vsix` only, CI added

* **Questions.** Where does the hosted backend live ([hosting plan](hosting-plan.md))? `.vsix` only, or the Marketplace? The extension needs no code change for a hosted backend (the address is a setting, `https://` is required), but the first-run flow should offer the hosted address.
* **Work after the decision.** Default `adaptai.backendUrl`, a welcome message on first run, the publisher and icon for the Marketplace, a CI job that runs `pnpm test` and packages the `.vsix`.

### IDE-14 · Approval of the token module in the core (S, a decision) · DECIDED 11 Nov 2026: go to review

* **Why.** API tokens change the core (a migration and the authentication dependency). ADR-013 is "Proposed" until the Architecture Owner decides.
* **Work.** Review of `backend/app/accounts.py`, `tokens.py`, `migrations/008_api_tokens.sql`, `tests/test_tokens.py`, `frontend/src/ApiTokens.tsx`, `e2e/tokens.spec.ts`; confirm the four `test_postgres.py` failures also happen on a clean develop; then open the pull request in the order backend → app screen → extension.

### IDE-15 · Live tips from a local model while typing (M, a decision) · DECIDED 11 Nov 2026: not built

* **Why.** The team asked for tips in real time. The local hints already in the page need no model. Tips from a model on every pause would send the text without a click (ADR-005), spend the provider's rate limit and be noisy, so they were not built.
* **Option.** An opt-in switch that works only when the chat model is local (LM Studio or Ollama): the text then stays on the machine. It needs the Architecture Owner and the Product Owner, because the Prompt Coach is not yet approved by the client (task P3).
* **Done when.** The decision is recorded in ADR-013; if yes: a debounce of at least 1.5 s, one request in flight, a visible "Thinking locally" state, nothing sent to an external model.

### IDE-16 · Stability of the task profile (M, backend, for the team)

* **Why.** The accuracy study ([report](analysis-accuracy/report.md)) found that the same task analysed three times by the same assessor gives the same level in only 62 to 77 percent of the cells, and a level differs by 2 in a few cells; "high" confidence covers 78 to 91 percent of the cells.
* **Options.** Analyse twice and keep the level both agree on (or the median of three); ask the assessor for a short reason before the score; show the spread to the user.
* **Done when.** The same study (`docs/analysis-accuracy/run.py`) shows at least 85 percent identical cells for the gpt-oss models.

### IDE-17 · A missing attachment or source is not "clear" (S, backend, for the team)

* **Why.** For "Summarise the attached Q3 report" (nothing attached) only two of four assessors give ambiguity 3. The extension already warns about it before sending (`localChecks`); the assessor should too.
* **Work.** A line in the rubric prompt (a new rubric version) that a referred document that is not in the text means essential information is missing.
* **Done when.** The study's tasks `summarise-missing` and `literature` get ambiguity 3 from at least three of four assessors.

## Order we recommend

1. IDE-11: a person clicks through the 18 checks below in a real window.
2. IDE-14: open the pull requests (backend, app screen, extension) for review.
3. IDE-16 and IDE-17 with the team.
4. When there is a Supabase project, the browser sign-in of IDE-06; when sessions and the export move to Supabase on develop, check IDE-02 and IDE-01 against the new routes.

## Manual acceptance checklist

Run in a real VS Code window with a backend on PostgreSQL, a throw-away account, and the packaged `.vsix`
installed in a clean profile (`code --user-data-dir /tmp/ud --extensions-dir /tmp/ex`). Tick each line and
write what you saw.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Open the AdaptAI icon in the activity bar | The page shows "Sign in to use AdaptAI" |
| 2 | Create an account, then sign out and sign in | Dialogs appear in the page; the email shows in the page; no password is stored |
| 3 | Analyse a task in the Assistant | Three cards (profile, model, tips); coverage table; no console error |
| 4 | "Task solved?" twice on the same analysis | First saves; the second says it was already answered |
| 5 | Select text in a file, Ctrl+Alt+A | The confirmation names the host and the model; the result opens |
| 6 | Ctrl+K Ctrl+E on a selected prompt | A diff opens; Apply replaces; Undo restores |
| 7 | Chat: send a message, press Stop, then Retry | The answer streams; Stop keeps the part written; Retry answers again |
| 8 | `/analyse <task>` in the chat | The analysis appears in the chat and the chat list |
| 9 | LLM config: add a model, Test, Edit, Delete | Dialogs; the key is never shown again; Delete asks first |
| 10 | Add a model from the OpenRouter catalogue (needs a key) | Search works; a paid model asks for consent before it is evaluated |
| 11 | Profile: switch on "Save task text and AI responses" | A consent dialog appears first; Cancel leaves it off |
| 12 | Profile: create a token, copy it, revoke it | The token is shown once; after Revoke it is rejected (`curl` with `Authorization: Bearer`) |
| 13 | My progress: confirm a pending choice, Export | The choice moves out of the list; a JSON file is written |
| 14 | Shortcuts: Change on a shortcut | The keyboard editor opens filtered on that command |
| 15 | Drag the side bar to about 300 px and to 800 px | Navigation becomes tabs when narrow; nothing is cut off |
| 16 | Light and dark theme | Both are readable |
| 17 | Stop the backend while the page is open | A clear message; Retry works when it is back |
| 18 | Change `adaptai.backendUrl` to `http://example.com` | The extension refuses and says why; nothing is sent |
