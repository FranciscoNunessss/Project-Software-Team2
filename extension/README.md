# AdaptAI Prompt Coach extension (AA-030)

Optional module (ADR-009). A bubble on the AdaptAI task field helps you describe the task so
the analysis can determine it. The extension only works on the AdaptAI page
(`http://127.0.0.1/*`, the app's browser origin) and talks to the AdaptAI backend you are
signed in to; it has no other permissions and stores nothing.

## Install (Chrome or Edge)

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Choose **Load unpacked** and select this `extension/` folder.
3. Open the app at `http://127.0.0.1:8443` and sign in.

The server must run with `ADAPTAI_PROMPT_COACH_ENABLED=true` for suggestions; with the flag
off the bubble shows only local checks (empty or very short text, emails, phone numbers) and
sends nothing.

## Use

| Step | What happens |
|---|---|
| Write the task and select **Analyse** | The app analyses it as usual |
| Select the bubble | The panel names where the task would be sent (the model of that analysis) |
| **Get suggestions** | Sends the task once to that model; suggestions name the dimension they improve |
| **Apply** on an edit | Replaces the quoted words in the task field |
| Answer a question, **Add to task** | Adds your answer; the Coach never invents facts |
| **Suggest a rewrite** | Shows a diff; yellow placeholders are for you to fill in; **Apply rewrite** replaces the text |
| **Analyse again** | The app re-analyses and shows what changed and the new completeness |

Nothing is applied without a click, and the Prompt Coach never stores the task it receives or
its suggestions. If you analyse again, the new task follows the app's normal storage rules.

## How it connects to the app

The extension reads only stable attributes the app renders for it: `data-task-input` (task
field), `data-analyse-button`, and `data-analysis-id` / `data-session-id` on the composer
section. It calls `GET /api/features`, `GET /api/sessions/{id}` (to name the destination) and
`POST /api/prompt-coach` with the page's session cookie.

## Remove

Remove the extension in `chrome://extensions` and delete this folder; see the README section
"Prompt Coach (optional)" for removing the module from the app.
