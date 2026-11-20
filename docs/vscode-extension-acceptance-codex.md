# VS Code extension: acceptance run for an agent that controls the computer

14 November 2026. Written for Codex (or any agent with mouse, keyboard and screenshots) to do the part of
IDE-11 that tests cannot: click through the extension in a real VS Code window and say what a person
would see. Read the whole file before you start. Stop and ask the person whenever a step says
**ASK THE PERSON**.

Prepared with AI assistance (Claude, Anthropic); human review pending.

## What was already checked by code (do not repeat it, it passed)

* 141 extension tests against a backend on the team's Supabase (schema `ide_dev`).
* A test inside a real VS Code extension host, against the same backend, with LM Studio: activation,
  30 commands, register, LM Studio test x3, chat and memory, analysis by LM Studio, Send with the analysis,
  Prompt Coach, Stop, every tab's data, rename, delete, sign out (23 of 23).
* The token card of the web app (Playwright `tokens.spec.ts`), on Supabase in a temporary schema.

What nobody has checked: **how the page looks and behaves when a person clicks it.** That is your job.

## Safety rules (break none of them)

1. **The database is the real one.** The backend must run with `ADAPTAI_DATABASE_SCHEMA=ide_dev`, which
   is already set in `.env.supabase`. Never change the schema to `adaptai`, never edit `.env.supabase`,
   never run SQL, never open the Supabase dashboard.
2. **No real accounts.** Create a throw-away account in the extension (local mode), for example
   `codex-<date>@example.com` with a password you make up and write only in your report. Never type the
   password of a person's account anywhere. The Supabase-mode login (check 20) is **ASK THE PERSON**.
3. **No paid or shared quota.** Use only LM Studio (local) and the Demonstration model. Do not add Groq,
   OpenAI, Claude or OpenRouter keys. Skip checks that need them and write SKIP.
4. **Do not touch the person's work.** Use the clean VS Code profile below, port 8033 for the backend
   (the person's own app may be on 8000 and 8443), and do not commit, push, delete branches or change
   files in the repository. Your report goes to the file named at the end.
5. If anything asks to send text outside the machine, to accept a paid evaluation, or to delete
   something that is not your throw-away account's data, choose Cancel and write it in the report.

## Set up (Windows, Git Bash or PowerShell)

1. LM Studio is open with the server started and `gemma4-12b-qat-uncensored-hauhaucs-balanced` loaded.
   Check: `curl http://127.0.0.1:1234/v1/models` lists it. If not, **ASK THE PERSON**.
2. Start the backend on Supabase (leave this terminal open):

   ```bash
   cd C:/Users/josem/Desktop/AdaptAI-ide
   python -m uv run --env-file .env.supabase python -m uvicorn app.main:create_app --factory --app-dir backend --host 127.0.0.1 --port 8033
   ```

   Ready when `curl http://127.0.0.1:8033/api/health` answers `{"status":"ok"}` (it can take a minute).
3. Build and install the extension in a clean profile:

   ```bash
   cd C:/Users/josem/Desktop/AdaptAI-ide/vscode-extension
   npx --yes pnpm@10.34.3 package
   code --user-data-dir "%TEMP%/adaptai-codex-ud" --extensions-dir "%TEMP%/adaptai-codex-ex" --install-extension adaptai-0.3.0.vsix
   code --user-data-dir "%TEMP%/adaptai-codex-ud" --extensions-dir "%TEMP%/adaptai-codex-ex" C:/Users/josem/Desktop/AdaptAI-ide-demo
   ```

4. In that window: File > Preferences > Settings, search `adaptai.backendUrl`, set it to
   `http://127.0.0.1:8033`. Take a screenshot of the window as `00-setup.png`.

## Checks

For each check: do the steps, compare with "Expected", take a screenshot named `<number>-<short>.png`,
and write PASS, FAIL (with what you saw instead) or SKIP (with why). Do not fix code.

| # | Steps | Expected |
|---|---|---|
| 1 | Click the AdaptAI icon in the activity bar (left edge) | The side bar shows "Sign in to use AdaptAI" with **Sign in** and **Create an account** |
| 2 | **Create an account** with your throw-away email and password | A dialog inside the page (not at the top of the window); after it, your email shows at the bottom of the page with "Connected" |
| 3 | **Sign out**, then **Sign in** with the same account | The sign-in dialog says the password is used once and that a forgotten password is handled in the web app; you are signed in again |
| 4 | Open **LLM config** > **Add a model** > LM Studio, name "LM Studio", model `gemma4-12b-qat-uncensored-hauhaucs-balanced` | No key is asked; the model appears under "Your models" |
| 5 | On that model: **Test**, then **Edit** (rename it "LM Studio local") and save | Test says it answered and that this only proves one short request worked; the new name shows |
| 6 | Go to **Assistant**, press **Model** in the box and choose it | The composer's model button shows the model, with its evaluation state next to it if it has one |
| 7 | In the text box write `Reply with just the word PONG.` and press **Send** | Your message appears on the right, the answer streams in on the left, under "AdaptAI · lmstudio …" |
| 8 | Write `Write a long story about a lighthouse, at least 400 words.`, **Send**, and press **Stop** after a few seconds | The answer stops; the part already written stays; the message says it was stopped; a **Retry** button is offered. Press Retry: a new answer streams |
| 9 | Write `Write a SQL query that returns the ten customers with the highest total orders in 2025, and explain it for a beginner.` and press **Analyse** | The analysis panel opens (beside the chat if the window is wide, as a sheet at the bottom if narrow) with "Analysing…", then cards: completeness, guidance, recommended model, tips, profile. Takes up to a minute with LM Studio |
| 10 | In the panel press **Send this message** | The message is sent; the answer streams; the panel closes |
| 11 | Write `make it better` and click the **✦** button at the right of the text box | The Prompt Coach bubble opens with the hint "Very short description" **once** (not also under the text box); choose Rewrite and **Improve with Prompt Coach** | 
| 12 | After 11 finishes | A Coach card with an improved text or questions; **Use this text** puts it in the box |
| 13 | Write `Summarise the attached Q3 sales report for the board.` (do not send) | A warning "It mentions an attachment, but only text is sent" appears under the box |
| 14 | Click **Chats (n)** at the top right, then **New chat**, then open the first chat again | The list shows your chats with their message counts; the old chat opens with its messages |
| 15 | Write `Count from 1 to 3000, one number per line, and do not stop early.` and **Send**. Wait (it can take several minutes) | When it ends, a banner says the answer reached the length limit and was cut off, with a **Continue** button (not Retry). Press it: the model goes on. If after 10 minutes it is still writing, press Stop and write SKIP |
| 16 | **My progress** | Numbers and charts (activity, recommendation match), no error; **Export** writes a JSON file (save it to `%TEMP%`) |
| 17 | **Profile**: switch on "Save task text and AI responses" | A consent dialog appears first; **Cancel** leaves it off |
| 18 | **Profile** > API tokens: create a token (it asks for your password, once for 10 minutes), copy it, then **Revoke** | The token is shown once; after Revoke it is no longer listed |
| 19 | **Shortcuts**: **Change** on any shortcut | The keyboard shortcuts editor opens filtered on that command |
| 20 | Supabase-mode login | **ASK THE PERSON** to do it: in the web app, sign in with their own account, create a token in Profile, and in the extension use **Sign in** > **Use a token**. You only write down what they say |
| 21 | Drag the side bar to about 300 px wide, then to about 800 px, and run 9 again at each width | At 300 px the menu is a bar of tabs on top and the analysis opens as a bottom sheet; at 800 px the panel sits beside the chat; nothing is cut off; the chat shows the newest message and the box to write stays at the bottom |
| 22 | Switch VS Code to a light theme, then back to dark (Ctrl+K Ctrl+T) | Text and buttons readable in both |
| 23 | Stop the backend terminal (Ctrl+C), click any tab, then start the backend again and click **Retry** if shown | A clear message that the backend is not reachable; it works again when the backend is back |
| 24 | Set `adaptai.backendUrl` to `http://example.com`, open the side bar | The extension refuses the address and says why; nothing is sent. Set it back to `http://127.0.0.1:8033` |
| 25 | Select a few lines of text in any file and press Ctrl+Alt+A | A confirmation names the backend and the model; the analysis opens beside the editor |
| 26 | Select a prompt in a file and press Ctrl+K Ctrl+E | A diff with the improved prompt opens; **Apply** replaces the text; Undo (Ctrl+Z) restores it |

## The relay: a model on this computer through a backend that cannot reach it (checks 27 to 30)

Do these only if the person asks for the relay run. Start the backend like this instead of step 2 of the
set-up (note the dead LM Studio address, which makes the backend unable to reach LM Studio itself, and
the evaluation worker off so it does not use LM Studio on its own):

```bash
cd C:/Users/josem/Desktop/AdaptAI-ide
set ADAPTAI_LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1
set ADAPTAI_EVALUATIONS_WORKER=false
python -m uv run --env-file .env.supabase python -m uvicorn app.main:create_app --factory --app-dir backend --host 127.0.0.1 --port 8033
```

| # | Steps | Expected |
|---|---|---|
| 27 | **LLM config** > **Add a model** > LM Studio, name "LM Studio server", model `gemma4-12b-qat-uncensored-hauhaucs-balanced`, **Where it runs: On the machine where the backend runs**. Make it the chat model and send `Reply with just the word PONG.` | The answer is an error: "LM Studio could not be reached…" (the backend cannot reach it itself) |
| 28 | Add a second model the same way, name "LM Studio my computer", **Where it runs: On this computer, through this extension**. Look at the status bar and at LLM config | The status bar shows **LM Studio relay**; LLM config says "Connected: your LM Studio answers requests from the backend" |
| 29 | Make "LM Studio my computer" the chat model, send `Reply with just the word PONG.`, then run **Analyse** on a task | The answer streams in like any other (it comes from your LM Studio through the extension); the analysis opens with a full profile; the status bar shows it working while it runs |
| 30 | Close LM Studio's server (or run the command **Developer: Reload Window**), wait 10 seconds, and send a message to "LM Studio my computer" | A clear message ("The extension could not reach LM Studio…" or "Your model on this computer is not available…"), and a message to any other model still works |

## The code assistant (checks 31 to 36)

Same set-up as above (backend on port 8033, LM Studio model, throw-away account, a clean profile). Open a folder with a small code file of 10 or more lines. Use **only LM Studio**; do not use the hosted backend. These six checks take about ten minutes.

| # | Steps | Expected |
|---|---|---|
| 31 | Select three lines of code. In the chat press **Selection: Off** once, write `Explain this` and press **Send** | The button reads `Selection: On · file · lines`. Your message shows only `Explain this` with a line `path · lines` that opens to show the code. The answer is about that code |
| 32 | Click in the file so nothing is selected, keep **Selection: On**, write `Explain this` and press **Send** | Nothing is sent; under the box it says to select some code or switch Selection off |
| 33 | Select a whole function. Right click > **AdaptAI: Suggest a change to the selection**. In the box at the top write `Throw an error if the first argument is empty` | After a few seconds the function lines are shaded red, the new lines are shaded green right below them, and **AdaptAI: Accept** and **Reject** appear above. The tab shows the file as changed but not saved |
| 34 | Click **Accept** | The red lines are gone, the green ones stay as normal code, the shading and the buttons are gone. Ctrl+Z brings back both versions, a second Ctrl+Z the original |
| 35 | Ask for a change again and click **Reject** | The green lines disappear and the file is exactly as before |
| 36 | Ask for a change again and press Ctrl+S before choosing | A message says the proposal was rejected before saving; the file on disk has only the original code |

## Navigation and background updates (checks 37 to 42)

Use the same disposable account and local model as above. A first visit with no loaded data may
show Loading; an already visited page should retain its content while it updates.

| # | Steps | Expected |
|---|---|---|
| 37 | Visit My progress, Profile and LLM config. Return to Assistant, send a short message, then revisit My progress | The previous figures appear immediately. Updating may appear; fresh figures replace them without a blank loading page |
| 38 | Scroll down in My progress, visit Assistant, then return. Repeat while a refresh finishes | The page retains its scroll position and saved report. A failed refresh leaves the figures visible with an error and Retry |
| 39 | In Assistant click New chat, including from the command palette, and repeat after another response | The empty composer appears using the already loaded models. The old messages and draft are cleared. Other pages remain available |
| 40 | Send a response long enough to stream, visit My progress, and return before it finishes; then repeat and stay in My progress until it finishes | Partial text continues when returning to Assistant. Finishing on My progress updates the figures in place and keeps that tab selected. New chat/opening another conversation during a task explains that it must finish or be stopped first |
| 41 | Type a short prompt and press Send | The counter resets to 0/8000 and the local prompt hints disappear immediately |
| 42 | If a model already has a completed evaluation, inspect its existing result in LLM config; do not start a paid evaluation | Its numeric levels, below-level-1 marker or unknown marker appear without `[object Object]` |

## Clean up

1. Close the test VS Code window. Stop the backend (Ctrl+C in its terminal).
2. Do not delete anything in the database: the schema `ide_dev` is for tests and the person decides
   when to clear it.

## Report

Write `C:/Users/josem/Desktop/AdaptAI-ide/acceptance-codex-report.md` (not committed) with:

* the date, the VS Code version (Help > About), the LM Studio model, and the throw-away email you used;
* a table `# | PASS/FAIL/SKIP | what you saw | screenshot`;
* for every FAIL: the exact steps, what you expected, what you saw, and anything in
  Help > Toggle Developer Tools > Console that is red;
* anything that looked wrong even if the check passed (layout, words, slowness), as a separate list.

Put the screenshots in `C:/Users/josem/Desktop/AdaptAI-ide/acceptance-codex-screens/` (not committed).
