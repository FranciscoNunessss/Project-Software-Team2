# VS Code extension: quick acceptance run for Codex

20 November 2026. For Codex (or any agent that controls the computer: mouse, keyboard, screenshots). You will
click through the extension in a real VS Code window and write what you saw. Read the whole file first.
Total time: about 40 minutes. This is the new code assistant and a regression pass over the old features.

Prepared with AI assistance (Claude, Anthropic); human review pending.

## Rules (break none)

1. **Do not edit, delete or move anything in the repository or in any file of the person.** You may only create:
   the scratch folder in step S3, the report and the screenshots named at the end, and the throw-away account.
   No `git` command that changes anything (no commit, no checkout, no reset, no push). Do not run the test suites.
2. **The database is the team's test schema.** Start the backend exactly as in S2 (schema `ide_dev`). Never
   change the schema, never edit `.env.supabase`, never run SQL, never open the Supabase dashboard.
3. **Local backend only.** The extension must use `http://127.0.0.1:8033`. Never use the hosted backend
   (`onrender.com`). Check the setting `adaptai.backendUrl` before every part.
4. **Only LM Studio.** Use the model that is running in LM Studio. Do not add Groq, OpenAI, Claude or OpenRouter keys.
5. **Do not evaluate the model.** The backend is started with the evaluation worker off. If a screen says the model
   is "not evaluated" or "Evaluating", ignore it and go on. Never wait for an evaluation. Keep every prompt short.
6. **Time box.** A check that does not finish in 2 minutes is FAIL (write what you saw) and you go on.
7. If a dialog asks to send text outside the machine, accept a paid evaluation, or delete something that is not
   your throw-away account's data, choose Cancel and write it in the report.
8. **ASK THE PERSON** if LM Studio is not running or the backend does not start. Do not try to fix it.

## Set up

**S1. LM Studio.** The server is on and a model is loaded (the person uses
`gemma4-12b-qat-uncensored-hauhaucs-balanced`). Check: `curl http://127.0.0.1:1234/v1/models` lists it.
Write the model name in the report.

**S2. Backend (leave this terminal open).**

```bash
cd C:/Users/josem/Desktop/AdaptAI-ide
set ADAPTAI_EVALUATIONS_WORKER=false
python -m uv run --env-file .env.supabase python -m uvicorn app.main:create_app --factory --app-dir backend --host 127.0.0.1 --port 8033
```

Ready when `curl http://127.0.0.1:8033/api/health` answers `{"status":"ok"}` (it can take a minute).

**S3. A small project to select code from.** Create the folder `%TEMP%/adaptai-run/src` and the file
`%TEMP%/adaptai-run/src/service.ts` with exactly this content (12 lines; lines 2, 6 and 11 are blank):

```ts
import { db } from "../db"

export function load(id) {
  return db.get(id)
}

export function save(id, value) {
  db.set(id, value)
  return value
}

export const answer = 42
```

**S4. Install the extension in a clean profile and open the folder.**

```bash
cd C:/Users/josem/Desktop/AdaptAI-ide/vscode-extension
npx --yes pnpm@10.34.3 package
code --user-data-dir "%TEMP%/adaptai-run-ud" --extensions-dir "%TEMP%/adaptai-run-ex" --install-extension adaptai-0.3.0.vsix
code --user-data-dir "%TEMP%/adaptai-run-ud" --extensions-dir "%TEMP%/adaptai-run-ex" "%TEMP%/adaptai-run"
```

In that window: Settings, `adaptai.backendUrl` = `http://127.0.0.1:8033`. Screenshot `00-setup.png`.

**S5. Account and model.** Click the AdaptAI icon, **Create an account** with `codex-<date>@example.com` and a
password you make up (write it only in the report). Then **LLM config > Add a model > LM Studio**, name
`LM Studio`, the model from S1, **Where it runs: On the machine where the backend runs**. Then **Use for chat**.

## Checks

For each: do the steps, compare with Expected, take a screenshot `<id>.png`, write PASS, FAIL (what you saw) or SKIP (why).

### A. The new code assistant (the point of this run)

| Id | Steps | Expected |
|---|---|---|
| N1 | Open `service.ts`, select lines 7 to 10 (the `save` function). In the AdaptAI chat the button reads **Selection: Off**; click it | It reads `Selection: On · service.ts · 7–10`. It changes by itself if you select other lines |
| N2 | Write `Explain this in one sentence` and press **Send** | Your message shows only that text plus a line `src/service.ts · 7–10` (folded). The answer streams in and is about `save`. The page scrolled down to the answer by itself |
| N3 | Click the folded line in your message | It opens and shows the 4 lines of code. It closes again |
| N4 | Click once in the file so nothing is selected, keep Selection On, write `Explain this` and press **Send** | Nothing is sent. Under the box: "Select some code in the editor, or switch Selection off." |
| N5 | Switch Selection Off, select lines 7 to 10 again, write `What is 2+2? Answer with just the number` and press **Send** | The message has no code line and the answer does not talk about the code |
| N6 | Select lines 7 to 10. Right click > **AdaptAI: Suggest a change to the selection**. In the box at the top write `Throw an Error if id is empty` and press Enter | After a few seconds: the 4 old lines are shaded red, the new lines are shaded green right below them, and **AdaptAI: Accept** and **Reject** appear above. The tab shows unsaved changes |
| N7 | Press **Accept** | The red lines are gone, the green ones are normal code, the shading and buttons are gone. The blank lines above and below the function are still there. Ctrl+Z brings back both versions; a second Ctrl+Z gives the original file |
| N8 | Ask for a change again (`Rename value to data`) and press **Reject** | The green lines disappear, the file is exactly as in S3 |
| N9 | Ask for a change again, and before choosing press Ctrl+S | A message says the proposal was rejected before saving. Open the file on disk (`type %TEMP%\adaptai-run\src\service.ts`): only the original code |
| N10 | Ask for a change, then type a letter inside the green lines | A message says the review ended; shading and buttons disappear; the text stays as it is. Press Ctrl+Z until the file is as in S3 |
| N11 | Ask for a change, then add a new line at the top of the file (line 1) | The red and green blocks and the buttons move down with the code. **Accept** still works on the right lines |
| N12 | With nothing selected: right click in the file | The entry **Suggest a change** is not in the menu (or the command says to select code first) |

### B. The chat page: scrolling and size

| Id | Steps | Expected |
|---|---|---|
| U1 | Send `Count from 1 to 40, one number per line` and watch | The page follows the answer to the end by itself |
| U2 | While it writes (or after, with more messages), scroll up in the messages. Send another short message | While you read above, the page does not pull you down. After sending it goes to the newest message |
| U3 | Drag the side bar to about 300 px, then 600 px, then 900 px or more | At 300 and 600 px the menu is a bar of tabs on top and the box to write is at the bottom, not covering any message, no sideways scroll. At 900 px or more the menu is a column on the left |
| U4 | Light theme (Ctrl+K Ctrl+T), then dark | Both readable; the Selection button, the red and green lines and the buttons are visible in both |

### C. The old features (regression: nothing may be broken)

| Id | Steps | Expected |
|---|---|---|
| R1 | **Sign out**, then **Sign in** with the same account | The dialog is in the page; your email shows at the bottom; no password is stored |
| R2 | Chat: write `Reply with just the word PONG.` and press **Send** | The answer streams under `AdaptAI · lmstudio …` |
| R3 | Write `Write a long story about a lighthouse` and press **Send**, then **Stop** after 3 seconds | The answer stops; the part written stays |
| R4 | Press **Retry** (the banner or the button) | A new answer starts |
| R5 | Write `Write a SQL query for the ten customers with the highest orders in 2025` and press **Analyse** | The analysis panel opens with cards (profile, model, tips); no red error. Press **Send this message**: it is sent and answered. (If the recommendation says "Illustrative balanced model", that is expected: the model is not evaluated) |
| R6 | Write `make it better` and click the **✦** button | The Prompt Coach bubble opens with a hint; no error |
| R7 | **Chats (n)**, then **New chat**, then open the first chat again | The list shows your chats; the old chat opens with its messages (the messages with code still show the folded line, not the code text) |
| R8 | **My progress** | Numbers and charts, no error |
| R9 | **Profile**: switch on "Save task text and AI responses" | A consent dialog appears first; **Cancel** leaves it off |
| R10 | **Shortcuts**: **Change** on any shortcut | The keyboard shortcuts editor opens filtered on it |
| R11 | In `service.ts` select lines 7 to 10 and press Ctrl+Alt+A | A confirmation names the backend and the model; the analysis opens beside the editor |
| R12 | In a new file type `write about dogs`, select it and press Ctrl+K Ctrl+E | A diff with the improved prompt opens; **Apply** replaces the text; Ctrl+Z restores it |
| R13 | Stop the backend (Ctrl+C in its terminal), click any tab, start it again, press **Retry** if shown | A clear "backend not reachable" message while it is off; it works again after |
| R14 | Set `adaptai.backendUrl` to `http://example.com`, open the AdaptAI view | The extension refuses and says why; nothing is sent. Set it back to `http://127.0.0.1:8033` |

## Clean up

Close the test VS Code window. Stop the backend (Ctrl+C). Do not delete anything: the schema, the account and the
scratch folder stay.

## Report

Write `C:/Users/josem/Desktop/AdaptAI-ide/acceptance-run-report.md` (not committed) with:

* the date, the VS Code version (Help > About), the LM Studio model, and the throw-away email;
* a table `Id | PASS/FAIL/SKIP | what you saw | screenshot` for every check above, in order;
* for every FAIL: the exact steps, what you expected, what you saw, and anything red in
  Help > Toggle Developer Tools > Console;
* a separate list of anything that looked wrong even if the check passed: layout, words, slowness, flicker,
  a button too small, text cut, a delay longer than 10 seconds;
* a last line: "Regression: all old features OK" or the list of old checks (R1 to R14) that failed.

Put the screenshots in `C:/Users/josem/Desktop/AdaptAI-ide/acceptance-run-screens/` (not committed).
