// The chat page and the selected code: what the button shows, what is sent, what the bubble shows.
// Requirements SEL-01 to SEL-05 of docs/vscode-extension.md. The editor and the chat are small fakes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode } = installVscode({ backendUrl: 'http://127.0.0.1:1', chatModel: '' })
const { Dashboard } = require('../dist/dashboard.js')
const { buildMessage } = require('../dist/codemsg.js')

const posted = []
const sent = []
const backend = { auth: 'token', managing: false, urlProblem: undefined, onDidChangeSession: () => ({}), status: async () => ({ email: 'a@b.c', online: true }), api: async () => ({}) }
const analyser = { onDidAnalyse: () => ({}), results: new Map(), continueFrom: undefined }
const chat = {
  current: undefined,
  list: async () => [],
  send: async (text, _sink, _signal, override, options) => void sent.push({ text, override, options }),
  setCurrent: async () => undefined,
}
const dash = new Dashboard(backend, analyser, chat, { open: async () => {} })
dash.preload = () => Promise.resolve()
dash.resolveWebviewView({
  visible: true,
  webview: { options: {}, html: '', cspSource: 'csp', postMessage: async message => void posted.push(message), onDidReceiveMessage: () => ({}) },
  onDidChangeVisibility: () => ({}),
  onDidDispose: () => ({}),
})

const lines = ['import { db } from "../db"', '', 'export function load(id) {', '  return db.get(id)', '}', '', 'export function save(id, value) {', '  db.set(id, value)', '  return value', '}']

/** An editor with these lines and a selection from (line, character) to (line, character), 0-based. */
function select(start, end) {
  const empty = start[0] === end[0] && start[1] === end[1]
  vscode.window.activeTextEditor = {
    selection: { isEmpty: empty, start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } },
    document: { languageId: 'typescript', uri: { scheme: 'file', path: '/work/src/service.ts' }, lineCount: lines.length, lineAt: index => ({ text: lines[index] }) },
  }
}
vscode.workspace.asRelativePath = () => 'src/service.ts'

test.beforeEach(() => {
  posted.length = 0
  sent.length = 0
})

test('sel_01 the page is told what would be sent: the file and the lines, or nothing', () => {
  select([6, 2], [8, 5])
  dash.postSelection()
  assert.deepEqual({ ...posted.findLast(m => m.type === 'selection') }, { type: 'selection', info: 'service.ts · 7–9' })
  select([6, 3], [6, 3])
  dash.postSelection()
  assert.equal(posted.findLast(m => m.type === 'selection').info, '')
})

test('sel_02 with the button On the message carries the file, the language, the lines and the code', async () => {
  select([6, 2], [8, 5])
  await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: true })
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.startsWith('Explain this'))
  assert.match(sent[0].text, /Selection \(src\/service\.ts, typescript, lines 7-9\)/)
  assert.ok(sent[0].text.includes('export function save(id, value) {\n  db.set(id, value)\n  return value'))
  assert.equal(sent[0].options.code, true)
})

test('sel_02 with the button Off nothing but the typed text is sent', async () => {
  select([6, 2], [8, 5])
  await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: false })
  assert.equal(sent[0].text, 'Explain this')
  assert.equal(sent[0].options?.code, undefined)
})

test('sel_04 the bubble of the user shows what was typed with a caption, not the code', async () => {
  select([6, 2], [8, 5])
  await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: true })
  const start = posted.find(m => m.type === 'chatStart')
  assert.equal(start.user, 'Explain this')
  assert.equal(start.selection.path, 'src/service.ts')
  assert.equal(start.selection.startLine, 7)
  assert.equal(start.selection.endLine, 9)
})

test('sel_03 with the button On and nothing selected nothing is sent and the box says why', async () => {
  select([6, 3], [6, 3])
  await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: true })
  assert.equal(sent.length, 0)
  assert.equal(posted.some(m => m.type === 'chatStart'), false)
  assert.match(posted.findLast(m => m.type === 'note').text, /select some code/i)
})

test('sel_05 a long selection is cut so the message fits, and the message says so', async () => {
  const big = Array.from({ length: 600 }, (_, i) => `const value${i} = compute(${i}, "some long argument text")`)
  vscode.window.activeTextEditor = {
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 599, character: 5 } },
    document: { languageId: 'typescript', uri: { scheme: 'file', path: '/work/big.ts' }, lineCount: big.length, lineAt: index => ({ text: big[index] }) },
  }
  await dash.handle({ type: 'chatSend', text: 'Summarise', withSelection: true })
  assert.ok(sent[0].text.length <= 8000)
  assert.match(sent[0].text, /Selection cut: the first \d+ of \d+ characters are shown/)
})

test('sel_08 the page is told, before sending, the exact text that will go with the message', async () => {
  select([6, 2], [8, 5])
  dash.postSelection()
  const preview = posted.findLast(m => m.type === 'selectionPreview')
  assert.equal(preview.lines, 3)
  assert.equal(preview.cut, null)
  assert.match(preview.text, /^Selection \(src\/service\.ts, typescript, lines 7-9\):\n```typescript\nexport function save/)
  await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: true })
  assert.ok(sent[0].text.endsWith(preview.text), 'the message carries exactly the previewed text')
  assert.equal(preview.characters, preview.text.length)
})

test('sel_08 nothing selected: no preview; a long selection says how much will be sent before sending', () => {
  select([6, 3], [6, 3])
  dash.postSelection()
  assert.equal(posted.findLast(m => m.type === 'selectionPreview').text, null)
  const big = Array.from({ length: 600 }, (_, i) => `const value${i} = compute(${i}, "some long argument text")`)
  vscode.window.activeTextEditor = {
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 599, character: 5 } },
    document: { languageId: 'typescript', uri: { scheme: 'file', path: '/work/big.ts' }, lineCount: big.length, lineAt: index => ({ text: big[index] }) },
  }
  dash.postSelection()
  const cut = posted.findLast(m => m.type === 'selectionPreview')
  assert.ok(cut.cut.sent > 0 && cut.cut.sent < cut.cut.total, 'the first N of M characters')
  assert.ok(cut.text.length <= 8000)
  const huge = Array.from({ length: 1 }, () => 'x'.repeat(9000))
  vscode.window.activeTextEditor = {
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 9000 } },
    document: { languageId: 'typescript', uri: { scheme: 'file', path: '/work/huge.ts' }, lineCount: 1, lineAt: () => ({ text: huge[0] }) },
  }
  dash.postSelection()
  assert.equal(posted.findLast(m => m.type === 'selectionPreview').tooLarge, true, 'one line longer than the limit cannot be cut at a line break')
})

test('sel_04 a chat opened again from the backend shows the typed text and the caption', () => {
  const content = buildMessage('ask', 'Explain this', { path: 'src/service.ts', languageId: 'typescript', startLine: 7, endLine: 9, code: 'export function save() {}' }).content
  const view = dash.conversation([], 'c1', { messages: [{ role: 'user', content, provider: null, model: null, error: null, status: 'done' }, { role: 'assistant', content: 'It saves.', provider: 'groq', model: 'x', error: null, status: 'done' }] })
  assert.equal(view.messages[0].text, 'Explain this')
  assert.equal(view.messages[0].selection.path, 'src/service.ts')
  assert.equal(view.messages[0].selection.code, 'export function save() {}')
  assert.equal(view.messages[1].text, 'It saves.')
  assert.equal(view.messages[1].selection, undefined)
})

/** The same editor, but the file is called `name`. */
function selectIn(name) {
  select([6, 2], [8, 5])
  vscode.window.activeTextEditor.document.uri = { scheme: 'file', path: `/work/${name}` }
}

test('sel_09 code in a file that holds secrets is never offered or sent (.env, keys)', async () => {
  for (const name of ['.env', '.env.local', 'server.pem', 'id_rsa', 'deploy.key']) {
    selectIn(name)
    dash.postSelection()
    assert.equal(posted.findLast(m => m.type === 'selection').info, '', `${name} was offered`)
    assert.equal(posted.findLast(m => m.type === 'selectionPreview').text, null, `${name} has a preview`)
    posted.length = 0
    sent.length = 0
    await dash.handle({ type: 'chatSend', text: 'Explain this', withSelection: true })
    assert.equal(sent.length, 0, `${name} was sent`)
    assert.match(posted.findLast(m => m.type === 'note').text, /secrets|never sent/i, `${name} gave no reason`)
  }
})

test('sel_09 an ordinary file is not affected by the rule', () => {
  selectIn('environment.ts')
  dash.postSelection()
  assert.match(posted.findLast(m => m.type === 'selection').info, /7–9/)
})
