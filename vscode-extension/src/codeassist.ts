import * as vscode from 'vscode'
import type { Sink } from './chat'
import { buildMessage, extractProposal, fitProposal } from './codemsg'
import { readSelection, type Picked } from './selection'

/** What shows the proposal in place (the editor, or a fake in tests). */
export interface ReviewHost {
  /** `where` names the file and the text the lines had when the question was asked, so a changed file is not overwritten. */
  show(first: number, last: number, proposed: string, where?: { uri?: vscode.Uri; original: string }): Promise<void>
}
/** The part of the chat that Suggest a change uses. */
export interface Asker {
  readonly outcome: 'ok' | 'stopped' | 'failed' | 'refused'
  send(prompt: string, sink: Sink, signal: AbortSignal, override?: undefined, options?: { code?: boolean }): Promise<void>
}
export type SuggestResult = { ok: true } | { ok: false; reason: 'no_editor' | 'no_selection' | 'too_large' | 'cancelled' | 'failed' | 'none' | 'several' | 'empty' }

const WHY = {
  none: 'the answer has no code block',
  several: 'the answer has more than one code block, so it is not clear which one replaces the selection',
  empty: 'the code block in the answer is empty',
}

/**
 * Suggest a change (docs/vscode-extension.md, CHG-01 to CHG-05): the selected lines and the instruction go to
 * the chat model; the answer is used only if it has exactly one code block; then the editor shows it in place.
 * Nothing is written to the file here.
 */
export class CodeAssist {
  constructor(
    private readonly chat: Asker,
    private readonly host: ReviewHost,
    private readonly read: () => Picked = readSelection,
  ) {}

  /** The last instruction, offered again when the question is reopened (APP-07). */
  private last = ''

  private warn(text: string): void {
    void vscode.window.showWarningMessage(`AdaptAI: ${text}`)
  }

  private pick(): Extract<Picked, { ok: true }> | undefined {
    const picked = this.read()
    if (picked.ok) return picked
    this.warn(picked.reason === 'no_editor' ? 'open a file and select the code to change first.' : 'select the code to change first.')
    return undefined
  }

  /** Asks the model for a change to the selection of the active editor. */
  async suggest(instruction: string, signal: AbortSignal = new AbortController().signal): Promise<SuggestResult> {
    const picked = this.read()
    if (!picked.ok) {
      this.pick()
      return { ok: false, reason: picked.reason }
    }
    return this.run(picked, instruction, signal)
  }

  private async run(picked: Extract<Picked, { ok: true }>, instruction: string, signal: AbortSignal): Promise<SuggestResult> {
    this.last = instruction
    const built = buildMessage('change', instruction, picked.ctx)
    if (!built.ok) {
      this.warn('that selection does not fit in one message. Select less code, then try again.')
      return { ok: false, reason: 'too_large' }
    }
    let answer = ''
    const sink: Sink = { markdown: text => void (answer += text), progress: () => undefined, button: () => undefined }
    await this.chat.send(built.content, sink, signal, undefined, { code: true })
    if (this.chat.outcome === 'refused' || this.chat.outcome === 'stopped') return { ok: false, reason: 'cancelled' }
    if (this.chat.outcome !== 'ok') {
      this.warn(`no change was proposed. ${answer.replace(/[*_]/g, '').trim().split('\n').pop() ?? ''}`.trim())
      return { ok: false, reason: 'failed' }
    }
    const proposal = extractProposal(answer)
    if (!proposal.ok) {
      this.warn(`nothing was changed, ${WHY[proposal.reason]}.`)
      return { ok: false, reason: proposal.reason }
    }
    await this.host.show(picked.first, picked.last, fitProposal(picked.ctx.code, proposal.code), { uri: picked.uri, original: picked.ctx.code })
    return { ok: true }
  }

  /** The command: asks what should change in the box at the top, then shows the proposal in the editor. */
  async suggestFromEditor(): Promise<void> {
    const picked = this.pick()
    if (!picked) return
    const instruction = await vscode.window.showInputBox({ title: 'AdaptAI: suggest a change', prompt: 'What should change in the selected code?', placeHolder: 'Throw an error if id is empty', value: this.last || undefined, ignoreFocusOut: true })
    if (!instruction?.trim()) return
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AdaptAI: asking for a change', cancellable: true }, (_progress, token) => {
      const abort = new AbortController()
      token.onCancellationRequested(() => abort.abort())
      return this.run(picked, instruction.trim(), abort.signal)
    })
  }
}
