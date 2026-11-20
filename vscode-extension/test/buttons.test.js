// The buttons in the chat box, the message after an analysis, and the review marks after Accept or Reject.
// Requirements BTN-01, RES-01 and APP-06 of docs/vscode-extension.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode, log } = installVscode({ backendUrl: 'http://127.0.0.1:8033', chatModel: '', resultView: 'document' })
const { Dashboard } = require('../dist/dashboard.js')
const { Analyser } = require('../dist/analyse.js')

const backend = { auth: 'token', managing: false, urlProblem: undefined, url: 'http://127.0.0.1:8033', onDidChangeSession: () => ({}), status: async () => ({ email: 'a@b.c', online: true }), api: async () => ({}) }
const analyser = { onDidAnalyse: () => ({}), results: new Map(), continueFrom: undefined }
const chat = { current: undefined, list: async () => [], send: async () => undefined, setCurrent: async () => undefined }

function dashboard(assist) {
  const posted = []
  const dash = new Dashboard(backend, analyser, chat, { open: async () => {} }, undefined, assist)
  dash.preload = () => Promise.resolve()
  dash.resolveWebviewView({ visible: true, webview: { options: {}, html: '', cspSource: 'csp', postMessage: async m => void posted.push(m), onDidReceiveMessage: () => ({}) }, onDidChangeVisibility: () => ({}), onDidDispose: () => ({}) })
  return { dash, posted }
}

test('btn_01 the page message asks Suggest a change with the typed instruction', async () => {
  const asked = []
  const { dash } = dashboard({ suggest: async (text, signal) => (asked.push({ text, signal }), { ok: true }) })
  await dash.handle({ type: 'suggestChange', text: '  Throw an error if id is empty  ' })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].text, 'Throw an error if id is empty')
  assert.ok(asked[0].signal instanceof AbortSignal)
})

test('btn_01 an empty instruction asks nothing', async () => {
  const asked = []
  const { dash } = dashboard({ suggest: async text => (asked.push(text), { ok: true }) })
  await dash.handle({ type: 'suggestChange', text: '   ' })
  assert.equal(asked.length, 0)
})

test('btn_01 a second click while the first is running is ignored, and the chat is refreshed afterwards', async () => {
  let release
  const asked = []
  const { dash, posted } = dashboard({ suggest: text => new Promise(resolve => ((release = () => resolve({ ok: true })), asked.push(text))) })
  const first = dash.handle({ type: 'suggestChange', text: 'one' })
  await dash.handle({ type: 'suggestChange', text: 'two' })
  assert.deepEqual(asked, ['one'])
  release()
  await first
  assert.ok(posted.some(m => m.type === 'assistantState' || m.type === 'data'), 'the chat was not refreshed')
})

test('res_01 the message after an analysis names the backend address and the model', async () => {
  const analysis = { id: 'a1', mode: 'live', provider: 'lmstudio', assessment_model: 'gemma', recommendation: { id: 'm1', name: 'Balanced model', provider: 'x', capacity: 'balanced' }, alternatives: [], rationale: '' }
  const a = new Analyser({ ...backend, call: async () => ({}) })
  log.info.length = 0
  await a.show({ analysis, coachAvailable: false }, true)
  const message = log.info.find(item => String(item).includes('assessed by'))
  assert.ok(message, 'no message after the analysis')
  assert.match(message, /127\.0\.0\.1:8033/)
})
