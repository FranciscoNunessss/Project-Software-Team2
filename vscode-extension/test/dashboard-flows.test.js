// The page's flows with a fake view that answers its dialogs: sessions, the chat model of one message,
// the Coach in the page, and the export.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1', chatModel: '' }
const { vscode } = installVscode(config)
const { Dashboard } = require('../dist/dashboard.js')

const answers = []
const posted = []
const calls = []
let responses = {}
const backend = {
  auth: 'token',
  managing: false,
  urlProblem: undefined,
  onDidChangeSession: () => ({}),
  status: async () => ({ email: 'a@b.c', online: true }),
  api: async (path, method = 'GET', body) => {
    calls.push([method, path, body])
    const key = `${method} ${path.split('?')[0]}`
    if (!(key in responses)) return {}
    const value = responses[key]
    return typeof value === 'function' ? value(path, body) : value
  },
}
const shown = []
const analyser = {
  onDidAnalyse: () => ({}),
  results: new Map(),
  continueFrom: undefined,
  lastError: undefined,
  show: async result => void shown.push(result),
}
const sent = []
const chat = {
  current: undefined,
  list: async () => [{ id: 'c1', title: 'One', message_count: 2 }, { id: 'c2', title: 'Two', message_count: 0 }],
  send: async (text, _sink, _signal, override) => void sent.push({ text, override }),
  setCurrent: async () => undefined,
  analyseForPage: async () => undefined,
  coachForPage: async (text, mode) => void (analyser.coached = { text, mode }),
}
const dash = new Dashboard(backend, analyser, chat, { open: async () => {} })
const view = {
  visible: true,
  webview: {
    options: {},
    html: '',
    cspSource: 'csp',
    postMessage: async message => {
      posted.push(message)
      if (message.type === 'dialog') setTimeout(() => void dash.handle({ type: 'dialogResult', id: message.id, values: answers.shift() }), 0)
    },
    onDidReceiveMessage: () => ({}),
  },
  onDidChangeVisibility: () => ({}),
  onDidDispose: () => ({}),
}
dash.resolveWebviewView(view)

const session = {
  id: 's1',
  title: 'Migration',
  created_at: '2026-11-01',
  analyses: [
    { result: { id: 'a1', provider: 'groq', recommendation: { id: 'm1', name: 'Small', label: 'Small' }, alternatives: [{ id: 'm2', name: 'Big', label: 'Big' }] }, candidate_id: 'm2', created_at: '2026-11-01T10:00:00Z' },
    { result: { id: 'a2', provider: 'groq', recommendation: { id: 'm1', name: 'Small', label: 'Small' }, alternatives: [] }, candidate_id: null, created_at: '2026-11-01T11:00:00Z' },
  ],
}

test('a session opens as a list; picking an analysis opens its full report', async () => {
  responses = { 'GET /api/sessions/s1': session }
  answers.push({ pick: 'a1' })
  await dash.handle({ type: 'sessionOpen', id: 's1' })
  const dialog = posted.findLast(m => m.type === 'dialog')
  assert.equal(dialog.title, 'Migration')
  assert.equal(dialog.list.items.length, 2)
  assert.match(dialog.list.items[0].sub, /you chose Big/)
  assert.match(dialog.list.items[1].sub, /choice pending/)
  assert.equal(shown.at(-1).analysis.id, 'a1')
  assert.equal(analyser.results.get('a1').source, 'history')
})

test('Continue this session remembers the session and its newest analysis; Stop continuing clears it', async () => {
  responses = { 'GET /api/sessions/s1': session }
  answers.push({ __extra: 'continue' })
  await dash.handle({ type: 'sessionOpen', id: 's1' })
  assert.deepEqual({ ...analyser.continueFrom }, { sessionId: 's1', previousId: 'a2', title: 'Migration' })
  await dash.handle({ type: 'continueClear' })
  assert.equal(analyser.continueFrom, undefined)
})

test('deleting a session asks first, and cancelling deletes nothing', async () => {
  responses = { 'GET /api/sessions/s1': session }
  calls.length = 0
  answers.push({ __extra: 'delete' }, undefined)
  await dash.handle({ type: 'sessionOpen', id: 's1' })
  assert.equal(calls.some(c => c[0] === 'DELETE'), false)
  answers.push({ __extra: 'delete' }, {})
  await dash.handle({ type: 'sessionOpen', id: 's1' })
  assert.ok(calls.some(c => c[0] === 'DELETE' && c[1] === '/api/sessions/s1'))
})

test('an OpenRouter catalogue model is chosen once and stays for the messages after it, until another model is picked', async () => {
  responses = {
    'GET /api/llm-options': { options: [{ id: 'g', provider: 'groq', label: 'Groq', model: 'x', external: true }, { id: 'or', provider: 'openrouter', label: 'OpenRouter', model: null, external: true }] },
    'GET /api/openrouter/models': { models: [{ id: 'vendor/free-model', free: true, selectable: true }, { id: 'vendor/audio', selectable: false, reason: 'no text' }] },
  }
  answers.push({ pick: 'vendor/free-model' })
  await dash.handle({ type: 'chatOverride', value: '__openrouter' })
  const dialog = posted.findLast(m => m.type === 'dialog')
  assert.equal(dialog.list.items.find(i => i.key === 'vendor/audio').disabled, true)
  sent.length = 0
  await dash.handle({ type: 'chatSend', text: 'hello' })
  assert.deepEqual({ ...sent[0].override }, { optionId: 'or', model: 'vendor/free-model', label: 'OpenRouter · vendor/free-model' })
  await dash.handle({ type: 'chatSend', text: 'again' })
  assert.equal(sent[1].override.model, 'vendor/free-model', 'the choice stays, as in the web app')
  await dash.handle({ type: 'chatModel', id: 'g' })
  assert.equal(config.chatModel, 'g')
  await dash.handle({ type: 'chatSend', text: 'third' })
  assert.equal(sent[2].override, undefined, 'picking another model clears the OpenRouter choice')
})

test('the model picker rows carry the evaluation status the web picker shows', async () => {
  responses = {
    'GET /api/llm-options': { options: [{ id: 'l', provider: 'lmstudio', label: 'LM Studio', model: 'gemma', external: false, source: 'personal' }, { id: 'd', provider: 'demo', label: 'Demonstration', model: null, external: false, source: 'server' }], auto_configuration_id: null, assessment: null },
    'GET /api/evaluations': { models: [{ provider: 'lmstudio', model: 'gemma', levels_source: 'measured', evaluation: { status: 'done', progress: 40, total: 40 } }] },
    'GET /api/chats': [],
    'GET /api/prompt-coach/settings': {},
  }
  analyser.results.clear()
  posted.length = 0
  await dash.handle({ type: 'ready' })
  const data = posted.findLast(m => m.type === 'data' && m.tab === 'analyse')
  assert.deepEqual(data.options.map(o => [o.id, o.source, o.status.text]), [['l', 'personal', 'Measured'], ['d', 'server', 'Not evaluated']])
  assert.equal(data.auto, null, 'without a project model, Auto is unavailable')
})

test('the Coach runs in the mode asked for, and an unknown mode means rewrite', async () => {
  await dash.handle({ type: 'coach', text: 'write about dogs', mode: 'tips' })
  assert.deepEqual({ ...analyser.coached }, { text: 'write about dogs', mode: 'tips' })
  await dash.handle({ type: 'coach', text: 'write about dogs', mode: 'delete everything' })
  assert.equal(analyser.coached.mode, 'rewrite')
  analyser.coached = undefined
  await dash.handle({ type: 'coach', text: '   ', mode: 'tips' })
  assert.equal(analyser.coached, undefined, 'empty text is not sent')
})

test('the export holds preferences, sessions and the saved chats', async () => {
  let written
  vscode.window.showSaveDialog = async () => ({ fsPath: 'out.json' })
  vscode.workspace.fs = { writeFile: async (_uri, data) => void (written = JSON.parse(Buffer.from(data).toString('utf8'))) }
  responses = {
    'GET /api/sessions': [{ id: 's1' }],
    'GET /api/sessions/s1': session,
    'GET /api/context': { content: 'prefs' },
    'GET /api/progress/coaching': { saved: null },
    'GET /api/chats': [{ id: 'c1' }],
    'GET /api/chats/c1': { id: 'c1', messages: [{ role: 'user', content: 'hi' }] },
  }
  await dash.handle({ type: 'export' })
  assert.equal(written.preferences.content, 'prefs')
  assert.equal(written.sessions[0].id, 's1')
  assert.equal(written.chats[0].messages[0].content, 'hi')
})

test('the Coach after every analysis is off by default, asks before it is switched on, and then rides on the same analysis', async () => {
  const seen = []
  chat.analyseForPage = async (text, opts) => (seen.push({ text, thenCoach: Boolean(opts?.thenCoach) }), { coachAvailable: true, analysis: { id: 'x' } })
  analyser.coach = async (result, mode, consented) => void (analyser.coachedAfter = { mode, consented })
  await dash.handle({ type: 'analyse', text: 'Plan a database migration for a small team' })
  assert.deepEqual(seen.at(-1), { text: 'Plan a database migration for a small team', thenCoach: false })
  assert.equal(analyser.coachedAfter, undefined, 'off by default')

  answers.push(undefined)
  await dash.handle({ type: 'coachAuto', on: true })
  assert.notEqual(config.coachAfterAnalysis, true, 'cancelling the dialog leaves it off')

  answers.push({})
  await dash.handle({ type: 'coachAuto', on: true })
  assert.equal(config.coachAfterAnalysis, true)
  assert.match(posted.findLast(m => m.type === 'dialog').text, /second request/)

  config.coachMode = 'edits'
  await dash.handle({ type: 'analyse', text: 'Plan a database migration for a small team' })
  assert.equal(seen.at(-1).thenCoach, true)
  assert.deepEqual({ ...analyser.coachedAfter }, { mode: 'edits', consented: true })

  await dash.handle({ type: 'coachAuto', on: false })
  assert.equal(config.coachAfterAnalysis, false)
})

test('a failed analysis is told in the analysis panel with its reason, and a cancelled one is not an error', async () => {
  config.coachAfterAnalysis = false
  chat.analyseForPage = async () => {
    analyser.lastError = 'The provider took too long to respond. Please try again.'
    return undefined
  }
  responses = { 'GET /api/llm-options': { options: [], auto_configuration_id: null, assessment: null }, 'GET /api/evaluations': { models: [] }, 'GET /api/chats': [] }
  analyser.results.clear()
  posted.length = 0
  await dash.handle({ type: 'analyse', text: 'Plan a database migration for a small team' })
  assert.equal(posted.findLast(m => m.type === 'data' && m.tab === 'analyse').analysisError, 'The provider took too long to respond. Please try again.')
  chat.analyseForPage = async () => {
    analyser.lastError = undefined
    return undefined
  }
  await dash.handle({ type: 'analyse', text: 'Plan a database migration for a small team' })
  assert.equal(posted.findLast(m => m.type === 'data' && m.tab === 'analyse').analysisError, undefined)
})

test('an answer cut off by the length limit is flagged in the page with its explanation, so it can be continued', async () => {
  chat.current = 'c1'
  responses = {
    'GET /api/llm-options': { options: [], auto_configuration_id: null, assessment: null },
    'GET /api/evaluations': { models: [] },
    'GET /api/chats/c1': { messages: [{ role: 'assistant', content: 'A long answer that was cut', provider: 'lmstudio', model: 'gemma', status: 'complete', error: 'answer_truncated' }, { role: 'assistant', content: 'Fine', provider: 'lmstudio', model: 'gemma', status: 'complete', error: null }] },
  }
  posted.length = 0
  await dash.handle({ type: 'ready' })
  const data = posted.findLast(m => m.type === 'data' && m.tab === 'analyse')
  assert.equal(data.messages[0].cut, true)
  assert.match(data.messages[0].error, /cut off/)
  assert.equal(data.messages[1].cut, false)
  assert.equal(data.messages[1].error, '')
  chat.current = undefined
})
