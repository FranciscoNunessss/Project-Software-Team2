import * as vscode from 'vscode'
import type { ReviewHost } from './codeassist'
import { Reviews, type TextDoc } from './review'

const keyOf = (document: vscode.TextDocument): string => document.uri.toString()

/**
 * Shows a proposed change in the editor, in place (docs/vscode-extension.md, APP-01 to APP-05): the original
 * lines marked as removed, the proposal marked as added right below, and Accept / Reject above them. The
 * rules (what accept and reject do, how the review follows edits) live in `review.ts`; this file only
 * connects them to VS Code: the edits, the marks, the buttons and the save.
 */
export class InlineReview implements ReviewHost, vscode.CodeLensProvider {
  private readonly reviews = new Reviews()
  private readonly lenses = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.lenses.event
  /** Greater than zero while this class writes to a document, so its own edits are not read as the user's. */
  private busy = 0
  private readonly removedStyle = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground') })
  private readonly addedStyle = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground') })

  private adapt(document: vscode.TextDocument): TextDoc {
    return {
      get lineCount() {
        return document.lineCount
      },
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      line: index => document.lineAt(index).text,
      replace: async (startLine, startChar, endLine, endChar, text) => {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(document.uri, new vscode.Range(startLine, startChar, endLine, endChar), text)
        this.busy++
        try {
          return await vscode.workspace.applyEdit(edit)
        } finally {
          this.busy--
        }
      },
    }
  }

  private warn(text: string): void {
    void vscode.window.showWarningMessage(`AdaptAI: ${text}`)
  }

  /** Writes the proposal below the lines and marks both. `where` names the file and the text the lines had when the question was asked. */
  async show(first: number, last: number, proposed: string, where?: { uri?: vscode.Uri; original: string }): Promise<void> {
    const document = where?.uri ? vscode.workspace.textDocuments.find(item => item.uri.toString() === where.uri?.toString()) : vscode.window.activeTextEditor?.document
    if (!document) return this.warn('the file is not open any more, so nothing was changed.')
    const now = Array.from({ length: last - first + 1 }, (_, i) => (first + i < document.lineCount ? document.lineAt(first + i).text : '')).join('\n')
    if (where && now !== where.original.replace(/\r\n/g, '\n')) return this.warn('the selected code changed while the model was answering, so nothing was changed. Ask again.')
    const review = await this.reviews.show(keyOf(document), this.adapt(document), first, last, proposed)
    if (!review) return this.warn('the change could not be written to the file.')
    this.refresh(document)
    const editor = vscode.window.visibleTextEditors.find(item => item.document === document)
    editor?.revealRange(new vscode.Range(review.removed.first, 0, review.added.last, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  /** The command behind the Accept button. */
  accept(): Promise<void> {
    return this.finish('accept')
  }

  /** The command behind the Reject button. */
  reject(): Promise<void> {
    return this.finish('reject')
  }

  private async finish(how: 'accept' | 'reject'): Promise<void> {
    const document = vscode.window.activeTextEditor?.document
    const review = document ? this.reviews.get(keyOf(document)) : undefined
    if (!document || !review) return void vscode.window.showInformationMessage('AdaptAI: there is no proposed change in this file.')
    const done = how === 'accept' ? await review.accept() : await review.reject()
    this.reviews.forget(keyOf(document))
    this.refresh(document)
    // VS Code can draw the buttons late: ask once more a moment later so none is left behind.
    setTimeout(() => this.refresh(document), 150)
    if (!done) this.warn('the code changed since the proposal, so nothing was done.')
  }

  /** The marks, the buttons and the context key follow the state of the file. */
  private refresh(document: vscode.TextDocument): void {
    const review = this.reviews.get(keyOf(document))
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== document) continue
      editor.setDecorations(this.removedStyle, review ? [new vscode.Range(review.removed.first, 0, review.removed.last, 0)] : [])
      editor.setDecorations(this.addedStyle, review ? [new vscode.Range(review.added.first, 0, review.added.last, 0)] : [])
    }
    this.lenses.fire()
    this.context()
  }

  private context(): void {
    const document = vscode.window.activeTextEditor?.document
    void vscode.commands.executeCommand('setContext', 'adaptai.reviewing', Boolean(document && this.reviews.get(keyOf(document))))
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const review = this.reviews.get(keyOf(document))
    if (!review) return []
    const range = new vscode.Range(review.removed.first, 0, review.removed.first, 0)
    return [new vscode.CodeLens(range, { title: 'AdaptAI: Accept', command: 'adaptai.acceptChange' }), new vscode.CodeLens(range, { title: 'Reject', command: 'adaptai.rejectChange' })]
  }

  /** Listens to the editor: the review follows edits above it, ends on an edit inside it, and never goes into a saved file. */
  register(): vscode.Disposable[] {
    return [
      this.lenses,
      this.removedStyle,
      this.addedStyle,
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.busy) return
        const key = keyOf(event.document)
        let broken = false
        for (const change of event.contentChanges) if (this.reviews.change(key, change.range.start.line, change.range.end.line, change.text) === 'broken') broken = true
        if (broken && event.reason !== vscode.TextDocumentChangeReason.Undo) void vscode.window.showInformationMessage('AdaptAI: you edited the proposal, so the review ended. The text stays as it is now.')
        this.refresh(event.document)
      }),
      vscode.workspace.onWillSaveTextDocument(event => {
        const review = this.reviews.get(keyOf(event.document))
        if (!review) return
        const range = review.rejectRange()
        review.open = false
        this.reviews.forget(keyOf(event.document))
        event.waitUntil(Promise.resolve([vscode.TextEdit.delete(new vscode.Range(range.startLine, range.startChar, range.endLine, range.endChar))]))
        void vscode.window.showInformationMessage('AdaptAI: the proposed change was rejected before saving, so the file is saved as it was.')
        for (const delay of [0, 150, 700]) setTimeout(() => this.refresh(event.document), delay)
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.reviews.forget(keyOf(document))),
      vscode.window.onDidChangeActiveTextEditor(() => this.context()),
    ]
  }
}
