// A proposed change opens in the VS Code diff and is applied in one edit only when accepted.
// Requirements APP-01 to APP-04 and APP-07 of docs/vscode-extension.md (release plan task E1). VS Code is a stand-in.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode, log, ui } = installVscode({})
vscode.EndOfLine = { LF: 1, CRLF: 2 }
vscode.TextEditorRevealType = { InCenterIfOutsideViewport: 2 }
const { ChangeDiff, CHANGE_SCHEME } = require('../dist/changediff.js')

let edits
function fakeDocument(lines, eol = 1) {
  const document = {
    lines,
    eol,
    uri: { scheme: 'file', path: '/work/src/a.ts', toString: () => 'file:///work/src/a.ts' },
    get lineCount() { return document.lines.length },
    lineAt: i => ({ text: document.lines[i] }),
    getText: () => document.lines.join(eol === 2 ? '\r\n' : '\n'),
  }
  vscode.workspace.applyEdit = async edit => {
    edits.push(edit.change)
    const { range, text } = edit.change
    const newline = eol === 2 ? '\r\n' : '\n'
    const joined = document.lines.join(newline)
    const off = (l, c) => document.lines.slice(0, l).reduce((n, t) => n + t.length + newline.length, 0) + c
    document.lines = (joined.slice(0, off(range.a, range.b)) + text + joined.slice(off(range.c, range.d))).split(newline)
    return true
  }
  vscode.workspace.textDocuments = [document]
  vscode.workspace.openTextDocument = async () => document
  vscode.window.activeTextEditor = { document }
  return document
}

const reviewing = () => log.executed.filter(call => call[0] === 'setContext' && call[1] === 'adaptai.reviewing').at(-1)?.[2]

test.beforeEach(() => {
  edits = []
  log.executed.length = 0
  log.info.length = 0
  log.warning.length = 0
  ui.warning = () => undefined
})

test('app_01 the proposal opens in the VS Code diff and the file is not touched', async () => {
  const document = fakeDocument(['one', 'two', 'three', 'four'])
  const diff = new ChangeDiff()
  await diff.show(1, 2, 'TWO\nTHREE', { uri: document.uri, original: 'two\nthree' })
  const open = log.executed.find(call => call[0] === 'vscode.diff')
  assert.ok(open, 'no diff was opened')
  assert.equal(open[1], document.uri, 'the left side is the file itself')
  assert.equal(open[2].scheme, CHANGE_SCHEME)
  assert.match(open[2].path, /a\.ts$/, 'the right side has the file name, so it gets the language of the file')
  assert.match(open[3], /a\.ts/)
  assert.match(open[3], /lines 2-3/)
  assert.equal(diff.provideTextDocumentContent(open[2]), 'one\nTWO\nTHREE\nfour', 'the right side is the file with the proposal in place of the selected lines')
  assert.deepEqual(document.lines, ['one', 'two', 'three', 'four'])
  assert.equal(edits.length, 0, 'the file was written before Accept')
  assert.equal(reviewing(), true)
})

test('app_02 Accept replaces the selected lines in ONE edit, closes the diff and leaves the buttons off', async () => {
  const document = fakeDocument(['one', 'two', 'three', 'four'])
  const diff = new ChangeDiff()
  await diff.show(1, 2, 'X\nY\nZ', { uri: document.uri, original: 'two\nthree' })
  const right = log.executed.find(call => call[0] === 'vscode.diff')[2]
  vscode.window.activeTextEditor = { document: { uri: right } }
  await diff.accept()
  assert.equal(edits.length, 1, 'Accept must be one edit so one Ctrl+Z undoes it')
  assert.deepEqual(document.lines, ['one', 'X', 'Y', 'Z', 'four'])
  assert.equal(reviewing(), false)
  assert.ok(log.executed.some(call => call[0] === 'workbench.action.closeActiveEditor'), 'the diff stays open')
  await diff.accept()
  assert.equal(edits.length, 1)
  assert.match(log.info.at(-1), /nothing|no proposed change/i)
})

test('app_02 Accept keeps the line ends of the file', async () => {
  const document = fakeDocument(['one', 'two', 'three'], 2)
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'A\nB', { uri: document.uri, original: 'two' })
  await diff.accept()
  assert.equal(document.lines.join('\r\n'), 'one\r\nA\r\nB\r\nthree')
})

test('app_02 Reject closes the diff and changes nothing', async () => {
  const document = fakeDocument(['one', 'two'])
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'TWO', { uri: document.uri, original: 'two' })
  await diff.reject()
  assert.equal(edits.length, 0)
  assert.deepEqual(document.lines, ['one', 'two'])
  assert.equal(reviewing(), false)
  await diff.accept()
  assert.equal(edits.length, 0, 'a rejected proposal was accepted later')
})

test('app_03 only the selected lines are replaced, also when lines outside them changed while the diff was open', async () => {
  const document = fakeDocument(['one', 'two', 'three'])
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'TWO', { uri: document.uri, original: 'two' })
  document.lines[0] = 'one EDITED'
  document.lines[2] = 'three EDITED'
  await diff.accept()
  assert.deepEqual(document.lines, ['one EDITED', 'TWO', 'three EDITED'])
})

test('app_07 selected lines that changed while the model answered: nothing is shown, Ask again reopens the question', async () => {
  const document = fakeDocument(['one', 'two CHANGED', 'three'])
  ui.warning = (_message, _options, buttons) => buttons[0]
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'TWO', { uri: document.uri, original: 'two' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(log.executed.some(call => call[0] === 'vscode.diff'), false, 'a diff was opened for stale code')
  assert.match(log.warning.at(-1).message, /changed while the model was answering/)
  assert.deepEqual(log.warning.at(-1).buttons, ['Ask again'])
  assert.ok(log.executed.some(call => call[0] === 'adaptai.suggestChange'))
})

test('app_07 selected lines that changed after the proposal: Accept does nothing and Ask again reopens the question', async () => {
  const document = fakeDocument(['one', 'two', 'three'])
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'TWO', { uri: document.uri, original: 'two' })
  document.lines[1] = 'two EDITED'
  ui.warning = (_message, _options, buttons) => buttons[0]
  await diff.accept()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(edits.length, 0, 'Accept replaced code that changed')
  assert.deepEqual(document.lines, ['one', 'two EDITED', 'three'])
  assert.match(log.warning.at(-1).message, /changed since the proposal/)
  assert.deepEqual(log.warning.at(-1).buttons, ['Ask again'])
  assert.ok(log.executed.some(call => call[0] === 'adaptai.suggestChange'))
  assert.equal(reviewing(), false)
})

test('app_04 a second proposal in the same file replaces the first', async () => {
  const document = fakeDocument(['one', 'two', 'three'])
  const diff = new ChangeDiff()
  await diff.show(0, 0, 'FIRST', { uri: document.uri, original: 'one' })
  await diff.show(2, 2, 'SECOND', { uri: document.uri, original: 'three' })
  await diff.accept()
  assert.deepEqual(document.lines, ['one', 'two', 'SECOND'])
  await diff.accept()
  assert.equal(edits.length, 1)
})

test('app_04 Accept and Reject with nothing waiting say so and change nothing', async () => {
  fakeDocument(['one'])
  const diff = new ChangeDiff()
  await diff.accept()
  assert.match(log.info.at(-1), /no proposed change|nothing/i)
  await diff.reject()
  assert.equal(edits.length, 0)
})

test('app_03 a line added above while the diff is open: Accept replaces the same code, one line lower', async () => {
  const document = fakeDocument(['one', 'two', 'three', 'four'])
  const diff = new ChangeDiff()
  await diff.show(1, 2, 'X\nY', { uri: document.uri, original: 'two\nthree' })
  document.lines.unshift('zero')
  await diff.accept()
  assert.deepEqual(document.lines, ['zero', 'one', 'X', 'Y', 'four'])
  assert.equal(edits.length, 1)
})

test('app_03 lines removed above while the diff is open: Accept replaces the same code, one line higher', async () => {
  const document = fakeDocument(['zero', 'one', 'two', 'three', 'four'])
  const diff = new ChangeDiff()
  await diff.show(2, 3, 'X', { uri: document.uri, original: 'two\nthree' })
  document.lines.shift()
  await diff.accept()
  assert.deepEqual(document.lines, ['one', 'X', 'four'])
})

test('app_07 the same code twice and the lines moved: it is not clear which one, so nothing is changed', async () => {
  const document = fakeDocument(['a', 'dup', 'b', 'dup', 'c'])
  ui.warning = () => undefined
  const diff = new ChangeDiff()
  await diff.show(1, 1, 'NEW', { uri: document.uri, original: 'dup' })
  document.lines.unshift('top')
  await diff.accept()
  assert.equal(edits.length, 0)
  assert.deepEqual(document.lines, ['top', 'a', 'dup', 'b', 'dup', 'c'])
})
