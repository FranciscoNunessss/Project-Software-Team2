// After Accept or Reject the marks and the buttons are gone at once and are asked to redraw again a
// moment later. Requirement APP-06 of docs/vscode-extension.md. VS Code is a stand-in.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode } = installVscode({})
vscode.ThemeColor = class { constructor(id) { this.id = id } }
vscode.EndOfLine = { LF: 1, CRLF: 2 }
vscode.TextEditorRevealType = { InCenterIfOutsideViewport: 2 }
vscode.window.createTextEditorDecorationType = () => ({ dispose() {} })
vscode.languages = { registerCodeLensProvider: () => ({ dispose() {} }) }
const { InlineReview } = require('../dist/inline.js')

function fakeDocument(lines) {
  const document = {
    lines,
    uri: { scheme: 'file', path: '/work/a.ts', toString: () => 'file:///work/a.ts' },
    eol: 1,
    get lineCount() { return document.lines.length },
    lineAt: i => ({ text: document.lines[i] }),
  }
  vscode.workspace.applyEdit = async edit => {
    {
      const { range, text } = edit.change
      const joined = document.lines.join('\n')
      const off = (l, c) => document.lines.slice(0, l).reduce((n, t) => n + t.length + 1, 0) + c
      document.lines = (joined.slice(0, off(range.a, range.b)) + text + joined.slice(off(range.c, range.d))).split('\n')
    }
    return true
  }
  return document
}

test('app_06 the buttons are redrawn at once and again a moment after Accept', async t => {
  const document = fakeDocument(['a', 'b', 'c'])
  const decorations = []
  const editor = { document, setDecorations: (_style, ranges) => decorations.push(ranges.length), revealRange: () => {} }
  vscode.window.visibleTextEditors = [editor]
  vscode.window.activeTextEditor = editor
  vscode.workspace.textDocuments = [document]
  const inline = new InlineReview()
  let redraws = 0
  inline.onDidChangeCodeLenses(() => redraws++)
  await inline.show(1, 1, 'B')
  const afterShow = redraws
  assert.equal(inline.provideCodeLenses(document).length, 2)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await inline.accept()
  assert.equal(inline.provideCodeLenses(document).length, 0, 'the buttons stay after Accept')
  const atOnce = redraws
  assert.ok(atOnce > afterShow)
  t.mock.timers.tick(500)
  assert.ok(redraws > atOnce, 'no second redraw a moment later')
})
