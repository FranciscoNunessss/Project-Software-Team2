# AdaptAI for VS Code

The AdaptAI app inside the editor, with no web app needed (only the backend): an AdaptAI page (Assistant, Chat, My progress, Profile, LLM config) with its own dialogs, plus commands, CodeLens and the diff editor in your files. See which model covers a task, improve a prompt with the Prompt Coach (diff and apply), chat with the model you chose, and manage your profile, models and their evaluations. It needs an AdaptAI backend (`adaptai.backendUrl`, default `http://127.0.0.1:8000`). Design and decisions: `docs/adr/ADR-013-vscode-extension.md`. To continue the work: `docs/vscode-extension.md` (guide) and `docs/vscode-extension-backlog.md` (what is missing).

The extension has no model and no rules of its own. Every result is what the backend returns: the recommendation (a concrete model, with the levels' source and whether they are calibrated), the assessor that analysed the task, the costs. It shows them; it does not reinterpret them.

## What each part of the app became

| In the app | In VS Code |
| --- | --- |
| Analyse a task | **Analyse selection / file / clipboard / a typed task**. The result opens as a Markdown preview beside the editor: recommended model and price, coverage per need, alternatives, notes, tips, profile and completeness. |
| "Use this model", "Task solved?" | Actions after each analysis (notification, or CodeLens above the source view): **Use this model in the chat**, **Task solved?**, **Copy summary**. |
| Prompt Coach (also in the page) | **Improve the prompt** (diff, then Apply; Undo restores), **Coach the clipboard**, and **Prompt Coach: improve** on an analysis. Tips, Edits or Rewrite. |
| Chat and Assistant | The AdaptAI page: one screen with the conversation and a composer (model picker, Prompt Coach bubble, **Analyse**, **Send**), and the analysis panel beside it or as a sheet. The participant **`@adaptai`** in VS Code's chat view: streaming, Stop, `/retry`, `/new`, `/analyse <task>` (inside the chat's session). A **Chats** view lists, opens, renames and deletes your chats. |
| Assistant history | **Recent analyses**. |
| My progress | Charts (activity and recommendation match), numbers, solved tasks by model, whether you describe tasks better, patterns, the Educator's suggestions, choices to confirm, your sessions (open an analysis, **Continue**, delete) and **Export my data** (preferences, coaching, sessions and chats). |
| Profile and settings | **Profile and settings** view: memory switches, saving task text, automatic suggestions, Prompt Coach, "always analyse", preferences, and the three deletions. |
| LLM config | **Models and evaluations** view: the project's models (the assessor marked), your models (add, edit, replace the key, test, delete) and how each was evaluated, with the consent dialog for a paid evaluation, re-evaluate, "I disagree", and adding a model of OpenRouter's live catalogue. |
| Sign in | **Sign in** (email and password once, then only a token is kept) or **Sign in with a token**. |

Not in VS Code: creating or revoking API tokens (a token cannot manage tokens, so a stolen one cannot mint more: do it in the app, Profile > API tokens) and the app's charts (the progress report uses text and sparklines).

### Shortcuts

| Shortcut | Command |
| --- | --- |
| `Ctrl+Alt+A` (editor) | Analyse selection (or the whole file) |
| `Ctrl+K Ctrl+E` (editor) | Improve the prompt |
| `Ctrl+K Ctrl+A` | Coach the clipboard |
| `Ctrl+K Ctrl+Y` | Analyse clipboard |

Mac: `Cmd` for the chords. The extension cannot add buttons inside another extension's panel (the Claude Code box), so for those prompts copy the text and use the clipboard commands. Rebind anything in *Keyboard Shortcuts*; every command is in the Command Palette.

## Signing in

* **Sign in** asks for your email and password once, signs in, asks the backend for a personal API token for this machine and keeps **only the token** in SecretStorage. The password is not stored.
* **Sign in with a token** takes a token created in the app (Profile > API tokens). It is the way in when the backend uses **Supabase Auth** (the password is then checked by Supabase in the app, never here).
* The token works with the local cookie login and with Supabase Auth, because it points at the same account. It expires (90 days by default) and can be revoked in the app; a revoked or expired token shows as "rejected".

## While you write

Under the text box the page shows **local hints** as you type: a very short description, an email address or phone number, a key or password, more than 8000 characters, and how many dimensions the last analysis was unsure about. They are computed in the page; nothing is sent. The **Prompt Coach** (Rewrite, Edits or Tips) runs when you press **Improve this prompt**. In Profile, **Run the Coach after every analysis** (off by default, with its own confirmation) makes **Analyse** ask for it too: that is a second request with the same text.

## Security and privacy

* **Where credentials may go.** One rule covers every request: plain `http://` only for `localhost`, `127.0.0.1` and `::1`; anything else needs `https://`. Nothing is sent, and nothing is even asked, for an address that fails it. An address with a user name, password, query or fragment is refused.
* **Credentials belong to the backend that issued them.** The token is stored with its origin; if you change `adaptai.backendUrl` it is not sent to the new address.
* **Requests cannot be steered.** URLs are built only from an `/api/...` path on the configured backend; only content headers are forwarded; redirects are never followed.
* **Text leaves the editor only when you run a command.** A confirmation names what is sent (selection, whole file, clipboard, chat message), the number of characters, the backend and the model, and says when it goes outside your machine. A whole file always asks. "Send and do not ask again" is an explicit button, never done silently. Improve and clipboard-coach say the text is sent twice.
* **Secrets.** Text that looks like a key, token, private key or `password=` is explained first. `.env`, `*.pem`, `*.key`, `id_rsa` and similar files are never read or sent.
* **Switches that send more text ask first** (saving task text and AI responses; automatic suggestions), and say where it goes.
* A paid evaluation never starts without its own dialog: what is sent (synthetic tasks, none of your text), the estimated cost and its ceiling; an unknown price asks twice.

## Models and errors

* Analyse uses the project's **assessor** (ADR-014 A11); the model you pick is for the chat (`adaptai.chatModel`, set by **Use this model**). Without an assessor on the backend, the chat model analyses.
* Backend error codes are explained in plain words, specific to Groq and LM Studio where it helps. A failure is an error with the reason and **Retry**; it never looks like an answer.
* **Test a model connection** sends one synthetic sentence through the real path. For LM Studio it first asks LM Studio itself (`adaptai.lmStudioUrl`) what is loaded, because LM Studio answers with whichever model is loaded even when asked for one that is not.
* Cancel and timeouts are the same everywhere: a notification you can cancel (quiet), a stop after 150 s, and for the chat a stop when the backend sends nothing for 120 s (the part already written is kept).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `adaptai.backendUrl` | `http://127.0.0.1:8000` | The AdaptAI backend. `https://` unless it is this machine. |
| `adaptai.confirmExternal` | `true` | Ask before sending a selection, clipboard text or chat message to an external model. |
| `adaptai.chatModel` | empty | The chat model by option id; empty is the backend's Auto. |
| `adaptai.coachMode` | `rewrite` | What the clipboard and Improve commands ask the Coach for. |
| `adaptai.improveApply` | `diff` | Improve: show the diff and ask, or apply at once. |
| `adaptai.resultView` | `preview` | An analysis opens as a rendered preview, or as a source document with actions above it. |
| `adaptai.lmStudioUrl` | `http://127.0.0.1:1234` | LM Studio's address, used only by the connection test. |

## Known limits

* No webview: the analysis and the progress report are Markdown documents; the app's charts are not reproduced.
* The chat uses VS Code's chat view, which must be enabled; it was run through code and the real backend, not with a person typing in the view.
* OpenRouter models are added from the live catalogue in the Models view; the chat model is not chosen per message.
* Text over 8000 characters is cut (the API limit) and the result says so.
* The Groq free tier allows about two analyses a minute; the error says "rate limiting" and Retry works later.
* Not published to the Marketplace. Install the `.vsix`.

## Develop and test

```bash
pnpm install
pnpm test    # type check, then every test; the ones that need a backend skip themselves
```

| File | Covers | Needs |
| --- | --- | --- |
| `test/core*.test.js`, `format.test.js`, `sse.test.js` | Address policy, URL building, secrets, errors, the analysis document, the request the app sends, the SSE parser at every split point | nothing |
| `test/security.test.js` | Remote http refused everywhere, header filtering, credentials bound to origin, cookies, redirects, stream idle timeout and Stop | nothing (local stub servers) |
| `test/flows.test.js` | Analyse, consent, secrets, failure and Retry, cancel and timeouts, the Coach, diff, Apply, outcome, Use this model | nothing |
| `test/chat.test.js` | The participant, streaming, split characters, Stop, errors, Retry, `/analyse`, the list of chats | nothing |
| `test/profile.test.js`, `models.test.js` | Switches and their consents, deletions, preferences, My progress, models CRUD, evaluations and the consent to a paid one, the OpenRouter catalogue | nothing |
| `test/integration.test.js` | All of it against a real backend on PostgreSQL in demonstration mode | `ADAPTAI_TEST_BACKEND` |

A disposable backend for the integration test (from the repository root, with PostgreSQL from `docker compose up -d --wait postgres`):

```bash
ADAPTAI_DATABASE_URL=postgresql://adaptai:adaptai@127.0.0.1:55432/adaptai ADAPTAI_DATABASE_SCHEMA=ide_dev \
ADAPTAI_EVALUATIONS_WORKER=false python -m uv run python -m uvicorn app.main:create_app --factory --app-dir backend --port 8031
```

Extension Development Host self-test (a throw-away VS Code profile, quits when done; `ADAPTAI_SELFTEST_TOKEN` is a token made in the app):

```bash
ADAPTAI_SELFTEST=1 ADAPTAI_SELFTEST_REPORT=/tmp/report.jsonl ADAPTAI_SELFTEST_TOKEN=<token> \
  Code.exe --user-data-dir /tmp/ud --extensions-dir /tmp/ex --extensionDevelopmentPath <this folder>
```

Run it: open this folder in VS Code and press F5. Package: `pnpm package` makes `adaptai-<version>.vsix`; install with `code --install-extension`.
