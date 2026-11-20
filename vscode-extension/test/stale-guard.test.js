// A proposal is never applied to code that changed since it was asked for, and the user can ask again.
// Requirement APP-07 of docs/vscode-extension.md (release plan task E1). VS Code is a stand-in.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode, log, ui } = installVscode({})
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
    const { range, text } = edit.change
    const joined = document.lines.join('\n')
    const off = (l, c) => document.lines.slice(0, l).reduce((n, t) => n + t.length + 1, 0) + c
    document.lines = (joined.slice(0, off(range.a, range.b)) + text + joined.slice(off(range.c, range.d))).split('\n')
    return true
  }
  const editor = { document, setDecorations: () => {}, revealRange: () => {} }
  vscode.window.visibleTextEditors = [editor]
  vscode.window.activeTextEditor = editor
  vscode.workspace.textDocuments = [document]
  return document
}

test.beforeEach(() => {
  log.warning.length = 0
  log.executed.length = 0
  ui.warning = () => undefined
})

test('app_07 code that changed while the model answered is left alone, and Ask again reopens the question', async () => {
  const document = fakeDocument(['a', 'b CHANGED', 'c'])
  ui.warning = (_message, _options, buttons) => buttons[0]
  const inline = new InlineReview()
  await inline.show(1, 1, 'B', { uri: document.uri, original: 'b' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(document.lines, ['a', 'b CHANGED', 'c'], 'the proposal was written over code that changed')
  const warning = log.warning.at(-1)
  assert.match(warning.message, /changed while the model was answering/)
  assert.deepEqual(warning.buttons, ['Ask again'])
  assert.ok(log.executed.some(call => call[0] === 'adaptai.suggestChange'), 'Ask again did not open the question')
})

test('app_07 Accept on code that changed since the proposal does nothing, and Ask again reopens the question', async () => {
  const document = fakeDocument(['a', 'b', 'c'])
  const inline = new InlineReview()
  await inline.show(1, 1, 'B', { uri: document.uri, original: 'b' })
  assert.deepEqual(document.lines, ['a', 'b', 'B', 'c'])
  document.lines[1] = 'b EDITED' // an edit the review did not see
  ui.warning = (_message, _options, buttons) => buttons[0]
  await inline.accept()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(document.lines, ['a', 'b EDITED', 'B', 'c'], 'Accept deleted lines of code that changed')
  const warning = log.warning.at(-1)
  assert.match(warning.message, /changed since the proposal/)
  assert.deepEqual(warning.buttons, ['Ask again'])
  assert.ok(log.executed.some(call => call[0] === 'adaptai.suggestChange'))
})

test('app_07 the question reopens with the instruction that was asked', async () => {
  const { CodeAssist } = require('../dist/codeassist.js')
  const asked = []
  vscode.window.showInputBox = async options => {
    asked.push(options.value)
    return undefined
  }
  const picked = { ok: true, ctx: { path: 'a.ts', languageId: 'typescript', startLine: 2, endLine: 2, code: 'b' }, first: 1, last: 1 }
  const chat = { outcome: 'ok', send: async (_text, sink) => sink.markdown('Done.\n```ts\nB\n```') }
  const host = { show: async () => undefined }
  const assist = new CodeAssist(chat, host, () => picked)
  await assist.suggest('Throw an error if id is empty')
  await assist.suggestFromEditor()
  assert.equal(asked[0], 'Throw an error if id is empty')
})
