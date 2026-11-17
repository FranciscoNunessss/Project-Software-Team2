# Decision pack for the Architecture Owner and the Product Owner

17 November 2026. Prepared with AI assistance (Claude, Anthropic); human review pending.

These are the decisions that have been waiting longest and that block the most. For each one: who
decides, the options, the author's recommendation, and the evidence in the code. **Every
recommendation is a proposal. Nothing here is approved, and nothing in the code changes because of
this file.** Where a decision is "record it as Accepted", the person who decides edits the ADR; this
file only saves them the reading.

How to use it: read one row, answer yes, no or change, and write the answer next to it in the pull
request that carries this file. Answers to the Privacy Policy go into
`frontend/src/content/privacy-policy.md` in a separate change, by the Product Owner.

## A. Architecture Owner

| # | Decision | Recommendation | Evidence | If not decided |
|---|---|---|---|---|
| A1 | **Opt-in conversation text (ADR-005 vs schema v7).** Text of tasks and answers is stored when a person switches on "Save task text and AI responses". The ADR still says no text is stored | Accept as an exception: stored only with the switch (off by default), with its own consent dialog, deletable at any time ("Delete saved conversations"), never shared | `docs/memory-privacy.md` ("30 October 2026: explicitly opted-in conversation storage"); `conversation_content` table; the Profile switch; `test_history_never_retains_provider_free_text` for the switch-off case | Production keeps storing opt-in text under an ADR that says it does not. Audit risk R6, marked urgent |
| A2 | **ADR-011 (chat) and ADR-012 (OpenRouter and LM Studio) are Proposed but in production** | Accept ADR-011 including its privacy exception (chat messages are stored, as the chat needs). Accept ADR-012 with OpenRouter labelled experimental until the card "OpenRouter: confirm a free model in the chat" is closed | Chat is in the published site and API; `/api/providers` shows OpenRouter off in production, so the experimental label costs nothing | 12 of 13 ADRs stay Proposed with their code live |
| A3 | **ADR-007 and ADR-008 (walking skeleton, providers)** | Accept: ADR-008 asked for two real provider integrations, and the Groq adapter is live in production while the OpenAI and Claude adapters are implemented and tested (cards "Groq provider adapter" and "second real provider live" are Done) | ClickUp cards; `providers.py`; `test_providers.py` | The register says "accepted" in one place and Proposed in another (audit contradiction 8) |
| A4 | **ADR-013 (VS Code extension, personal API tokens in the core)** | Accept the tokens (hashed, expiring, revocable, capped, cannot mint tokens). The recommended answers to its five open questions are in the ADR itself | The extension and `/api/tokens` are in `main` and answer 401 in production. `test_tokens.py`, 23 of 23 in a real extension host | Code in production without a decision of the person who owns the core |
| A5 | **ADR-015 (relay for models on the user's own machine)** | Accept after A4. Not on by default: a configuration must be set to "client" and the extension must be connected | 22 backend tests, 14 of 14 end to end. Nothing is opened to the internet; a request only goes to its owner's extension | Same as A4. The relay is in `main` |
| A6 | **Adopt the evaluation protocol (05 section 7.4)** with the runner of the quality-eval pull request | Adopt with these rules: the 5-point rule of the runner, reports without task text, a baseline per model committed in a pull request, and a full run before each milestone. The labelled set (OI-8) replaces the draft task set when two reviewers agree on it | `docs/quality-eval.md`; `backend/eval/quality/` | There is no definition of "correct recommendation" and no gate, so KR1.1 (16 of 20) cannot be measured |
| A7 | **Second server model in production** | Add a second free model (another Groq model has its own quota, or OpenRouter with the project key) so the assessor can fall back when the first is rate limited. Per-person limits share the quota, they do not enlarge it | Audit capacity section: 8000 tokens a minute and about 83 analyses a day for everyone; FR-21 already falls back | A single rate limit stops every analysis |

## B. Product Owner (with the client where noted)

| # | Decision | Recommendation | Evidence | If not decided |
|---|---|---|---|---|
| B1 | **Choose the 2 or 3 external reviewers for the labelled task set (Spec question 6)** | People who are not on the team and do not know the rubric: one professor or tutor, one person who uses AI at work but does not write code, one from the client's side if the client agrees. Each labels the same 20 tasks alone; disagreements are discussed, not averaged | Card "PO: choose the 2 to 3 external reviewers"; the draft set in `backend/eval/quality/tasks-1.json` is one reader's labels | KR1.1 stays unmeasured, which the audit calls the biggest gap for the client |
| B2 | **Approve the Prompt Coach (P3)** and answer OI-1 (first surface, upload, team view, offline) | Ask the client in one meeting with a short demo; upload and team view stay out of the MVP unless the client asks for them | Cards P3 and OI-1; the Coach is built, tested and optional per user | Gate C stays open, and AA-008 and US-23 stay blocked |
| B3 | **The extension as a requirement** | Accept F-IDE-01 and F-IDE-02 as "Could"; leave F-IDE-03 (relay) for after the Architecture Owner decides A5 | `docs/vscode-extension-requirement.md` (in `main`) | The extension is shipped without a requirement to accept or reject it |
| B4 | **Limits of the Educator verdict** (more than half of the confirmed choices, at least 5) | Accept: it is the rule in the Educator pull request, taken from the wording of AA-012 | The Educator pull request; 31 tests | The numbers are the team's proposal, not the Spec's |
| B5 | **Default per-person limits** (30 analyses and 150 chat answers a day, 4 and 10 a minute) | Accept as a start; lower the daily number if more than a few people will use the shared model, because the free plan is about 83 analyses a day in total | The per-person limits pull request; `docs/user-limits.md` | The defaults stay the author's guess |

## C. Privacy Policy: the nine `[TO CONFIRM]` markers (Product Owner, with the professors)

The policy is published and says it is a draft. These are proposed answers. **The wording of a legal
text is not for an AI to settle**: check each one with the professors or a person who knows the
rules before it replaces the marker. This is not legal advice.

| # | Marker (line of `privacy-policy.md`) | Proposed answer | Note |
|---|---|---|---|
| C1 | Controller: legal entity or institution (15) | "The AdaptAI Team 2 project team, [the institution of the course], under the supervision of [the professors]" | Needs the real name of the institution. It must be someone who can answer a data-subject request |
| C2 | Privacy contact (16) | A shared mailbox that more than one team member reads, not a personal address | The address does not exist yet. Creating it is the action |
| C3 | Data protection officer (17) | "None appointed" | A student project that is not a public body is not obliged to appoint one; confirm with the professors |
| C4 | Hosting choices (54) | Supabase, Render and Netlify as listed, **after someone reads the region of each project in its dashboard** and writes it in the policy | Nobody has verified the regions from the code. "We prefer EU regions" should become a fact or be removed |
| C5 | Retention for inactive accounts (67) | Keep a person's history until they delete it or the account has been inactive for **12 months**, then delete the history; the account follows after 24 months of inactivity | Needs the expiry change (an optional setting, off by default) and, to warn people first, working email (SMTP). Without them, keep the sentence "no automatic expiry" and say so honestly |
| C6 | Supervisory authority (93) | CNPD, as written | Confirm only that the service is operated from Portugal |
| C7 | Minimum age (105) | Keep 16 | The safest wording for a service with no age check and no parental flow. Portuguese law (Lei 58/2019, to be confirmed) lets a service rely on a person's own consent from the age of 13; do not lower it without a way to check age |
| C8 | The policy's "Delete my account" sentence | Keep it, **only after the account-deletion pull request is merged and deployed** | Until then the sentence describes a button that does not exist in production |
| C9 | The policy's status line ("draft", not approved) | Remove it only when the Architecture Owner and the Product Owner have both approved the text | |

## D. Team Lead

| # | Action | Why |
|---|---|---|
| D1 | Turn on "Require approvals" in the protection of `develop` (and `main`) | Pull requests #53 and #56 were merged without any approval; the gate G3 of the process is not enforced by anything. It is two clicks, and an administrator can see the setting, which the audit could not |
| D2 | Configure SMTP in the Supabase project (Authentication, Emails, SMTP Settings) and test a registration with an email from outside the team | Supabase's built-in sender only reaches team members, and the backend refuses unconfirmed email. A client may not be able to create an account. Never switch confirmation off to get around it |
| D3 | Add the secret `GROQ_API_KEY` to the repository when the team wants the quality-eval job to measure | Without it the job reports NOT RUN, honestly, and never a pass |
| D4 | Decide whether `ADAPTAI_SUPABASE_SERVICE_ROLE_KEY` goes into Render (account deletion) | It lets the backend delete a person's sign-in in Supabase; it also gives administrator rights over every Supabase user. Without it, deleting an account erases the data and tells the person the sign-in remains |
| D5 | Work-in-progress reset (card P0) and archive the cards the audit marked obsolete | 10 cards in progress against a limit of 4 |

## What to do first

1. **D1 and D2** (minutes, no code, and they protect the process and the client).
2. **B1 and B2** (they unblock the quality measure and the client gates).
3. **A1, then the rest of A** (read in one sitting; most are "record as Accepted").
4. **C**, with the professors.
