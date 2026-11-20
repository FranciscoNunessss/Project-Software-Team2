# VS Code extension: quick acceptance run for Codex (run 3)

20 November 2026 (third run; the first two found bugs that are now fixed). For Codex (or any agent that controls the computer: mouse, keyboard, screenshots). You will
click through the extension in a real VS Code window and write what you saw. Read the whole file first.
Total time: about 30 minutes. This is the new code assistant and a regression pass over the old features.

## Which checks to do in this run

**Do these first, in this order** (they failed or did not run before, or the code under them changed): **B4, B1, B2, B3, N6, N7, N8, N9, U2, U3, U5, R4, R5, R8, R11, R12, R14**.
Then, if there is time, the quick pass of what passed before but whose layout changed: **N1, N2, N3, N4, N5, N10, N11, N12, U1, U4, R1, R2, R3, R6, R7, R9, R10**.
**R13 is the same as U5**: do it once and write the same result for both.
A check you did not do is SKIP with the reason "not in this run".

Prepared with AI assistance (Claude, Anthropic); human review pending.

## What you are testing, and where everything is

**The extension** is the VS Code extension of AdaptAI, version 0.3.0. Everything is in the repository
`C:/Users/josem/Desktop/AdaptAI-ide`, on the branch `feature/ide-code-assistant` (already checked out; do not change branch).

| What | Where |
|---|---|
| The extension | `C:/Users/josem/Desktop/AdaptAI-ide/vscode-extension` (`src/` code, `test/` tests, `package.json`, `README.md`) |
| The backend it talks to | `C:/Users/josem/Desktop/AdaptAI-ide/backend` (FastAPI; you only start it, as in S2) |
| Developer guide, with the requirements of the new features | `docs/vscode-extension.md`, section "The code assistant" |
| Requirement for the Product Owner | `docs/vscode-extension-requirement.md` (F-IDE-04, F-IDE-05) |
| Older, longer acceptance guide (checks 1 to 36) | `docs/vscode-extension-acceptance-codex.md` (use this file instead; it is the short version) |
| Backlog | `docs/vscode-extension-backlog.md` |

**The documents in Google Drive** (folder PS2627). Open them to understand the features before testing. If Drive does
not open for you (it needs the person's login), the same content is in the repository files above; do not ask for access.

| Document | Link |
|---|---|
| The folder | https://drive.google.com/drive/folders/1Kkm0tn17KS1AEsWkZJT-Y-gM31b5H5Up |
| EXT-09 Requirements and acceptance criteria of the code assistant | https://docs.google.com/document/d/1GIxcLAYVbp8vF7AGNvI1gjjwCEf8YfoMTsN5Goc68TU/edit |
| EXT-10 Architecture and technical implementation | https://docs.google.com/document/d/1k5YRL75T-m-R8nQ69NHfiw-5aFAjpceGA5swWg7dRR4/edit |
| EXT-11 Test plan and results | https://docs.google.com/document/d/1EPu9jNk5wC_DJx-DsNbQNfOG9etZwtyIIXC-b9IBI9Y/edit |
| EXT-12 User manual | https://docs.google.com/document/d/1mSJzF8KC8sU7v72DV0GCgh3-Ftlmx7CV5T5VG61TU-k/edit |
| EXT-01 Developer guide of the extension | https://docs.google.com/document/d/1Fr403QHxW0AkJtDZTtAXynqEdVW7dxeUkeCpDNkk_Ug/edit |
| EXT-02 Backlog | https://docs.google.com/document/d/19NkoJ4EJWer1k0Xz73Hy-1F5h8Aznr7-afjZKN1em-I/edit |
| EXT-06 Requirement for the Product Owner | https://docs.google.com/document/d/1gVpkMKt4tuO4jgHJ4dCfw6jYdG8xwz5q8Cii4GkFIe4/edit |

**The new features in a few lines** (the details are in EXT-09 and EXT-12):

* **Selection in the chat.** A button **Selection: Off / On** in the chat box. With On, the code selected in the editor goes
  with the message, with its file and lines. Your message shows only what you typed, with a folded line `file · lines`.
* **Buttons in the chat box.** **Suggest a change** and **Improve prompt** are buttons next to **Analyse** and **Send**. Suggest a change
  uses the text in the box as the instruction and the code selected in the editor (it also works from the right click
  menu). Improve prompt opens the Prompt Coach on the text in the box. The model is chosen with the **Model** button in the
  box; LLM config only lists and manages models (it has no "Use for chat").
* **Suggest a change.** Select code, right click > **AdaptAI: Suggest a change to the selection**, say what to change. The
  model proposes new code. It appears in the file under the old lines: old lines red, new lines green, with **Accept**
  and **Reject** above. Nothing is saved until you choose; saving first rejects a pending proposal.
* **The chat page.** It follows the newest message, the box to write stays at the bottom, and it fits from about 300 px
  (a bar of tabs under 900 px).
* **Not in this version, do not look for it:** the VS Code chat or Copilot, `/` commands, a side by side comparison,
  a keyboard shortcut for Suggest a change.
* **The old features** (analysis, Prompt Coach, chat, My progress, profile, shortcuts, LM Studio) must work as before.

Read EXT-12 (the user manual) and the section "The code assistant" of `docs/vscode-extension.md` first. Then do S1 to S5 and the checks.

## Rules (break none)

1. **Do not edit, delete or move anything in the repository or in any file of the person.** You may only create:
   the scratch folder in step S3, the report and the screenshots folder named at the end, and the throw-away account.
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

**S4. Install the extension in a clean profile and open the folder.** The file `adaptai-0.3.0.vsix` was built on 20 November 2026
(latest build after the last code change); do not build it again. Install it over any older copy with `--force`.

```bash
cd C:/Users/josem/Desktop/AdaptAI-ide/vscode-extension
code --user-data-dir "%TEMP%/adaptai-run-ud" --extensions-dir "%TEMP%/adaptai-run-ex" --install-extension adaptai-0.3.0.vsix --force
code --user-data-dir "%TEMP%/adaptai-run-ud" --extensions-dir "%TEMP%/adaptai-run-ex" "%TEMP%/adaptai-run"
```

In that window: Settings, `adaptai.backendUrl` = `http://127.0.0.1:8033`. Then **Help > Toggle Developer Tools > Console** and keep it
open for the whole run: at the end, write down every red error that appeared (with the check you were doing).

**S5. Account and model.** Click the AdaptAI icon, **Create an account** with `codex-<date>@example.com` and a
password you make up (write it only in the report). Then **LLM config > Add a model > LM Studio**, name
`LM Studio`, the model from S1, **Where it runs: On the machine where the backend runs**. Then go to **Assistant**, press **Model** in the box and choose it (LLM config only lists models; the choice is made in the box).
**Check before going on:** the **Model** button in the box shows the LM Studio model. If it says Auto, choose it again: R5, R11 and R12 fail without a chosen model.

## Checks

For each: do the steps, compare with Expected, write PASS, FAIL (what you saw) or SKIP (why).

**Screenshots: only for a FAIL.** When a check fails, take one screenshot of what you see and save it in the new folder
`C:/Users/josem/Desktop/AdaptAI-ide/acceptance-run-3-screens/` as `<check id>.png` (for example `N7.png`). No screenshot for a PASS.

### A. The new code assistant (the point of this run)

| Id | Steps | Expected |
|---|---|---|
| N1 | Open `service.ts`, select lines 7 to 10 (the `save` function). In the AdaptAI chat the button reads **Selection: Off**; click it | It reads `Selection: On · service.ts · 7–10`. It changes by itself if you select other lines |
| N2 | Write `Explain this in one sentence` and press **Send** | Your message shows only that text plus a line `src/service.ts · 7–10` (folded). The answer streams in and is about `save`. The page scrolled down to the answer by itself |
| N3 | Click the folded line in your message | It opens and shows the 4 lines of code. It closes again |
| N4 | Click once in the file so nothing is selected, keep Selection On, write `Explain this` and press **Send** | Nothing is sent. Under the box: "Select some code in the editor, or switch Selection off." |
| N5 | Switch Selection Off, select lines 7 to 10 again, write `What is 2+2? Answer with just the number` and press **Send** | The message has no code line and the answer does not talk about the code |
| N6 | Select lines 7 to 10. Right click > **AdaptAI: Suggest a change to the selection**. In the box at the top write `Throw an Error if id is empty` and press Enter | After a few seconds: the 4 old lines are shaded red, the new lines are shaded green right below them, and **AdaptAI: Accept** and **Reject** appear above. The tab shows unsaved changes |
| N7 | Press **Accept** (a light bulb on a blank line is VS Code's own, not ours). Then click once inside the file text so the cursor is in the editor, not in the chat, and press Ctrl+Z, look, and press Ctrl+Z again | After Accept: the red lines are gone, the green ones are normal code, the shading and buttons are gone, the blank lines above and below the function are still there. First Ctrl+Z: both versions are back (without red and green). Second Ctrl+Z: the original file as in S3. Write what you see after each Ctrl+Z |
| N8 | Ask for a change again (`Rename value to data`) and press **Reject** | The green lines disappear, the file is exactly as in S3 |
| N9 | Ask for a change again. Wait until the green lines and the buttons are on screen (not before), then press Ctrl+S and take the screenshot at once (the message stays about 10 seconds) | A message says the proposal was rejected before saving; the Accept and Reject buttons are gone within one second. Open the file on disk (`type %TEMP%\adaptai-run\src\service.ts`): only the original code |
| N10 | Ask for a change, then type a letter inside the green lines | A message says the review ended; shading and buttons disappear; the text stays as it is. Press Ctrl+Z until the file is as in S3 |
| N11 | Ask for a change, then add a new line at the top of the file (line 1) | The red and green blocks and the buttons move down with the code. **Accept** still works on the right lines |
| N12 | With nothing selected: right click in the file | The entry **Suggest a change** is not in the menu (or the command says to select code first) |

### B. The chat page: scrolling and size

| Id | Steps | Expected |
|---|---|---|
| U1 | Send `Count from 1 to 40, one number per line` and watch | The page follows the answer to the end by itself |
| U2 | While it writes (or after, with more messages), scroll up in the messages. Send another short message | While you read above, the page does not pull you down. After sending it goes to the newest message |
| U3 | Drag the side bar to about 300 px, then 600 px (900 px or more cannot be reached in a side bar: the automated page test covers it, write SKIP for that part) | At 300 and 600 px the menu is a bar of tabs on top, wrapped onto two rows with ALL five tabs visible (Assistant, My progress, Profile, LLM config, Shortcuts) and the box to write is at the bottom, not covering any message, no sideways scroll. At 900 px or more the menu is a column on the left |
| U5 | Stop the backend (Ctrl+C), wait 70 seconds (the connection check runs every 60 s), click **My progress** and then **Assistant**; start the backend again | While it is off every tab shows "The backend is not reachable" or "Could not reach the backend" with **Try again** (My progress must not show an empty page without saying why); after it is on again the tab loads by itself |
| B1 | (a) With the box empty press **Suggest a change**. (b) Write `Throw an Error if id is empty`, click once in the file so nothing is selected, press **Suggest a change**. (c) Select lines 7 to 10 and press it again | (a) and (b): the button is not grey; next to the box it says what is missing, and nothing is sent. (c) The box is cleared, within 60 seconds the red and green lines and Accept / Reject appear in the editor |
| B2 | Write `make it better` in the box and press **Improve prompt** | The Prompt Coach opens above the box, on that text, like the ✦ button; press the button again to close it |
| B4 | Click **Model**, then **Improve prompt**, then **Chats** (at about 340 px and at a wide size) | Each list opens fully inside the window; the model list lets you pick the LM Studio model and the button then shows it |
| B3 | At about 300 px wide | **Suggest a change** and **Improve prompt** are visible, wrapped onto a second line if needed, nothing cut off |
| U4 | Light theme (Ctrl+K Ctrl+T), then dark | Both readable; the Selection button, the red and green lines and the buttons are visible in both |

### C. The old features (regression: nothing may be broken)

| Id | Steps | Expected |
|---|---|---|
| R1 | **Sign out**, then **Sign in** with the same account | The dialog is in the page; your email shows at the bottom; no password is stored |
| R2 | Chat: write `Reply with just the word PONG.` and press **Send** | The answer streams under `AdaptAI · lmstudio …` |
| R3 | Write `Write a long story about a lighthouse` and press **Send**, then **Stop** after 3 seconds | The answer stops; the part written stays |
| R4 | Press **Retry** (the banner or the button) | A new answer starts |
| R5 | Before this check, in the chat box press **Model** and make sure the LM Studio model is the chosen one (R5, R11 and R12 need a model chosen). Write `Write a SQL query for the ten customers with the highest orders in 2025` and press **Analyse** | The analysis panel opens with cards (profile, model, tips); no red error. Press **Send this message**: it is sent and answered. (If the recommendation says "Illustrative balanced model", that is expected: the model is not evaluated) |
| R6 | Write `make it better` and click the **✦** button | The Prompt Coach bubble opens with a hint; no error |
| R7 | **Chats (n)**, then **New chat**, then open the first chat again | The list shows your chats; the old chat opens with its messages (the messages with code still show the folded line, not the code text) |
| R8 | **My progress** | Numbers and charts, no error |
| R9 | **Profile**: switch on "Save task text and AI responses" | A consent dialog appears first; **Cancel** leaves it off |
| R10 | **Shortcuts**: **Change** on any shortcut | The keyboard shortcuts editor opens filtered on it |
| R11 | In `service.ts` select lines 7 to 10 and press Ctrl+Alt+A | The analysis opens beside the editor; the message after it names the backend address and the model. A question before sending appears only for an external model or a whole file |
| R12 | In a new file type `write about dogs`, select it and press Ctrl+K Ctrl+E | A diff with the improved prompt opens; **Apply** replaces the text; Ctrl+Z restores it |
| R13 | Stop the backend (Ctrl+C in its terminal), click any tab, start it again, press **Retry** if shown | A clear "backend not reachable" message while it is off; it works again after |
| R14 | Set `adaptai.backendUrl` to `http://example.com`, open the AdaptAI view | A red message appears with the reason (with **Open settings**) and the AdaptAI view shows the same reason above Sign in; nothing is sent. Set it back to `http://127.0.0.1:8033` |

## Clean up

Close the test VS Code window. Stop the backend (Ctrl+C). Do not delete anything: the schema, the account and the
scratch folder stay.

## Report

Write `C:/Users/josem/Desktop/AdaptAI-ide/acceptance-run-report-3.md` (not committed) with:

* the date, the VS Code version (Help > About), the LM Studio model, and the throw-away email;
* a table `Id | PASS/FAIL/SKIP | what you saw` for every check above, in order (the screenshot file name next to every FAIL);
* for every FAIL: the exact steps, what you expected, what you saw, and anything red in
  the Console (you kept it open, see S4);
* the list of red errors from the Console with the check you were on;
* a separate list of anything that looked wrong even if the check passed: layout, words, slowness, flicker,
  a button too small, text cut, a delay longer than 10 seconds;
* a last line: "Regression: all old features OK" or the list of old checks (R1 to R14) that failed.

