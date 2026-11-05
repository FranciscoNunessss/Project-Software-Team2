# ADR-011: Chat with in-line analysis

Status: Proposed (5 November 2026). Pending client approval (ClickUp P4) before the chat
screen (E3) is merged.
Owner: Ricardo Rodrigues. Related: ADR-005 (memory and privacy), ADR-009 (shared analysis
core and optional Prompt Coach).

## Context

AdaptAI analyses a task description, recommends a capability tier and coaches the user, but
the task is then run somewhere else. The team wants AdaptAI to work like a chat assistant
(ChatGPT, Claude) while keeping the analysis, the Prompt Coach and the Educator: the user can
improve and analyse a message before sending it, and the answer comes from the model the user
chose. This changes the product scope from "recommends" to "recommends and can run it", so it
needs the client's approval, and it needs message text to be stored, which the current
privacy rule (ADR-005, Product Spec §8) only allows with an explicit opt-in.

## Decision

| # | Decision |
|---|---|
| D1 | The chat replaces the Assistant screen. The current analysis result becomes a drawer opened from each analysed message. If the chat module is removed, the Assistant screen returns unchanged. |
| D2 | Chat messages and answers are stored while the chat exists, whatever the "Save task text" setting is. The user deletes a chat, the history or the account to delete them. This is a scoped exception to ADR-005. |
| D3 | The analysis of a message reads only that message, not the chat history (a later card may change this). |
| D4 | A per-user "Always analyse before sending" switch, off by default. Analyse and Send are otherwise separate buttons. |
| D5 | The client is asked in the same email as the Prompt Coach (P3), before E3. |

Implementation follows the ADR-009 pattern:

| Rule | How |
|---|---|
| Optional module | All backend code in `backend/app/chat.py`, imported last in `create_app` inside its own `try`. |
| Discoverable | `GET /api/features` returns `chat: true|false`; the frontend shows the chat only when it is `true`. |
| Removable | Deleting the file leaves the core working. CI's `removal-drill` deletes it with the Prompt Coach. |
| Schema | Its tables use `CREATE TABLE IF NOT EXISTS` and never change `PRAGMA user_version`. |
| A chat is a session | `chat_sessions` marks which sessions are chats, so My progress, the Educator and learning progress count chats with no change. |
| Analysis | The existing `POST /api/analyze` with the chat id as `session_id`; Send carries the `analysis_id` to link message and analysis. |
| Decision | The model chosen on Send is recorded through the existing `POST /api/decisions`, using the user's map from model configuration to catalogue tier (`chat_model_tiers`). |
| Answer model | The user's model configuration or the server provider, through the existing `configurations.resolve`; Send is the consent for an external provider. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Chat as an extra tab next to the Assistant | Two places to describe a task; the analysis would feel separate from real use. |
| Store message text only with "Save task text" | A chat without its history is not usable; users would lose answers on reload. |
| Analyse the whole chat history | More tokens per analysis on the Groq free tier (8,000 tokens per minute); unclear rubric semantics for multi-turn input. Deferred. |
| Analyse automatically before every Send | Doubles the provider calls and the waiting time; kept as an opt-in switch. |
| Chat inside the core (not a module) | The client has not approved it; the module can be removed in minutes if they decline. |

## Consequences

| Area | Consequence |
|---|---|
| Privacy | Message text is stored; Product Spec §8 and `docs/memory-privacy.md` must state the exception. The Educator reads no message text. |
| Cost and limits | An analysed message costs an analysis plus an answer (about 5,000 tokens on Groq); rate limits surface as a failed answer with a retry. |
| Product | The vision sentence changes from "without choosing for you" to "recommends, the user chooses, and can run it here". New FR-14 to FR-16. |
| Tests | Backend tests marked `chat`; e2e `chat.spec.ts`; removal drill extended. |
| Delivery | Cards E0 to E6 and Gate E in ClickUp; E3 is blocked by P4. |
