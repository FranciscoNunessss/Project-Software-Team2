# Proposed requirement: the VS Code extension

16 November 2026. For the Product Owner (and the client, Process Charter OI-1). Not part of the Product
Specification v1.1, which has only NFR-09 ("do not depend on one IDE"). Prepared with AI assistance
(Claude, Anthropic); human review pending.

## Why a requirement is needed

The extension exists and passes its tests, but nothing in the specification says it is wanted, so it
cannot be accepted or rejected. A short requirement closes that, as an **extra** outside the MVP baseline.

## Proposed text

| Id | Requirement | Priority | Acceptance |
|---|---|---|---|
| F-IDE-01 | A user can analyse a selection, a file or the clipboard, chat with an assistant and improve a prompt with the Prompt Coach from VS Code, against the same backend and the same rules as the web app (consent, privacy, levels). | Could | The checks of [the acceptance run](vscode-extension-acceptance-codex.md) pass in a real window |
| F-IDE-02 | The extension signs in with a personal API token that is stored hashed on the backend, expires, can be revoked and never reaches a model provider. | Could (required by F-IDE-01) | ADR-013 decision (c) accepted; `test_tokens.py` passes |
| F-IDE-03 | A user may run a model on their own computer through a hosted backend, without opening that computer to the internet. | Won't (this release) | ADR-015 accepted; checks 27 to 30 |
| F-IDE-04 | From VS Code a developer can send selected code to the chat with its file and lines, ask for a change to the selection, review the proposed change in the VS Code diff and accept or reject it. Only the selected lines are ever replaced. | Could | Requirements SEL, CHG and APP of [the developer guide](vscode-extension.md#the-code-assistant): their tests pass, and checks 31 to 36 of [the acceptance run](vscode-extension-acceptance-codex.md) pass in a real window |
| F-IDE-05 | The extension's chat follows the newest message and fits any width of the side bar or editor tab, from about 300 px up, without covering text or scrolling sideways. | Could | Requirements UI of [the developer guide](vscode-extension.md#the-code-assistant); `pnpm run test:page`; check 21 |

## Decisions asked of the Product Owner

1. Accept F-IDE-01 and F-IDE-02 as *Could* (the author recommends yes: the work is done and tested), or drop the extension from the release.
2. Say whether F-IDE-03 is wanted; it is a prototype on a separate branch and needs the Architecture Owner.
