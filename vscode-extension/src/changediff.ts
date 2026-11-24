import * as vscode from 'vscode'
import type { ReviewHost } from './codeassist'
import { fileName } from './core'

/** The right side of the diff: the file with the proposal in place of the selected lines. */
export const CHANGE_SCHEME = 'adaptai-change'

type Pending = { key: string; uri: vscode.Uri; first: number; last: number; original: string; proposed: string; right: vscode.Uri }

/**
 * Shows a proposed change in the VS Code diff and applies it in one edit when accepted
 * (docs/vscode-extension.md, APP-01 to APP-04 and APP-07). Nothing is written to the file before Accept, so
 * the file is never saved with two versions and one Ctrl+Z after Accept puts it back as it was.
 */
export class ChangeDiff implements ReviewHost, vscode.TextDocumentContentProvider {
  private readonly pending = new Map<string, Pending>()
  private readonly content = new Map<string, string>()
  private latest: string | undefined
  private counter = 0

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.path) ?? ''
  }

  private warn(text: string): void {
    void vscode.window.showWarningMessage(`AdaptAI: ${text}`)
  }

  /** A warning that nothing was changed because the code changed, with a button that opens the question again. */
  private warnStale(text: string): void {
    void Promise.resolve(vscode.window.showWarningMessage(`AdaptAI: ${text}`, 'Ask again')).then(choice => {
      if (choice === 'Ask again') void vscode.commands.executeCommand('adaptai.suggestChange')
    })
  }

  private textOf(document: vscode.TextDocument, first: number, last: number): string {
    return Array.from({ length: last - first + 1 }, (_, i) => (first + i < document.lineCount ? document.lineAt(first + i).text : '')).join('\n')
  }

  private eol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
  }

  private context(): void {
    void vscode.commands.executeCommand('setContext', 'adaptai.reviewing', this.pending.size > 0)
  }

  /** The proposal the user means: the one of the diff in front, or else the latest one. */
  private current(): Pending | undefined {
    const active = vscode.window.activeTextEditor?.document.uri
    if (active?.scheme === CHANGE_SCHEME) for (const item of this.pending.values()) if (item.right.path === active.path) return item
    return this.latest ? this.pending.get(this.latest) : undefined
  }

  /** The proposal is over (accepted, rejected, replaced or its diff closed): forget it, hide the buttons, close its diff. */
  private async settle(item: Pending, closeDiff: boolean): Promise<void> {
    this.pending.delete(item.key)
    this.content.delete(item.right.path)
    if (this.latest === item.key) this.latest = undefined
    this.context()
    if (closeDiff) await this.closeTab(item)
  }

  /** Closes the tab that shows the proposal, whether or not it is the editor in front. */
  private async closeTab(item: Pending): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const modified = (tab.input as { modified?: vscode.Uri } | undefined)?.modified
        if (modified?.scheme === CHANGE_SCHEME && modified.path === item.right.path) await vscode.window.tabGroups.close(tab)
      }
    }
  }

  /** Opens the diff of the proposal. `where` names the file and the text the lines had when the question was asked. */
  async show(first: number, last: number, proposed: string, where?: { uri?: vscode.Uri; original: string }): Promise<void> {
    const document = where?.uri ? vscode.workspace.textDocuments.find(item => item.uri.toString() === where.uri?.toString()) : vscode.window.activeTextEditor?.document
    if (!document) return this.warn('the file is not open any more, so nothing was changed.')
    const original = where ? where.original.replace(/\r\n/g, '\n') : this.textOf(document, first, last)
    if (this.textOf(document, first, last) !== original) return this.warnStale('the selected code changed while the model was answering, so nothing was changed.')
    const key = document.uri.toString()
    const previous = this.pending.get(key)
    if (previous) await this.settle(previous, true)
    const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text)
    const proposedLines = proposed.replace(/\r\n/g, '\n').split('\n')
    const name = fileName(document.uri.path)
    const right = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${++this.counter}/${name}` })
    this.content.set(right.path, [...lines.slice(0, first), ...proposedLines, ...lines.slice(last + 1)].join(this.eol(document)))
    this.pending.set(key, { key, uri: document.uri, first, last, original, proposed, right })
    this.latest = key
    this.context()
    const where2 = first === last ? `line ${first + 1}` : `lines ${first + 1}-${last + 1}`
    await vscode.commands.executeCommand('vscode.diff', document.uri, right, `AdaptAI: suggested change to ${name} (${where2})`, { preview: false })
  }

  /**
   * Where the selected code is now: where it was, or, when lines were added or removed above it while the diff was
   * open, the one place where exactly that text is. Code that was edited, or that appears twice, is not found.
   */
  private locate(document: vscode.TextDocument, item: Pending): number | undefined {
    const length = item.last - item.first + 1
    if (item.last < document.lineCount && this.textOf(document, item.first, item.last) === item.original) return item.first
    const wanted = item.original.split('\n')
    let found: number | undefined
    for (let start = 0; start + length <= document.lineCount; start++) {
      if (!wanted.every((text, i) => document.lineAt(start + i).text === text)) continue
      if (found !== undefined) return undefined
      found = start
    }
    return found
  }

  /** The command behind Accept: replaces the selected lines in one edit, unless they changed since the proposal. */
  async accept(): Promise<void> {
    const item = this.current()
    if (!item) return void vscode.window.showInformationMessage('AdaptAI: there is no proposed change waiting.')
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === item.uri.toString()) ?? (await vscode.workspace.openTextDocument(item.uri))
    const first = this.locate(document, item)
    if (first === undefined) {
      await this.settle(item, true)
      return this.warnStale('the code changed since the proposal, so nothing was done.')
    }
    const last = first + (item.last - item.first)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(item.uri, new vscode.Range(first, 0, last, document.lineAt(last).text.length), item.proposed.replace(/\r\n/g, '\n').split('\n').join(this.eol(document)))
    if (!(await vscode.workspace.applyEdit(edit))) return this.warn('the change could not be written to the file. The proposal is still open, so you can try Accept again.')
    await this.settle(item, true)
    await vscode.window.showTextDocument(document, { preview: false })
  }

  /** The command behind Reject: closes the diff and changes nothing. */
  async reject(): Promise<void> {
    const item = this.current()
    if (!item) return void vscode.window.showInformationMessage('AdaptAI: there is no proposed change waiting.')
    await this.settle(item, true)
  }

  register(): vscode.Disposable[] {
    return [
      // Closing the diff by hand is the same as Reject.
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme !== CHANGE_SCHEME) return
        for (const item of this.pending.values()) if (item.right.path === document.uri.path) void this.settle(item, false)
      }),
    ]
  }
}
