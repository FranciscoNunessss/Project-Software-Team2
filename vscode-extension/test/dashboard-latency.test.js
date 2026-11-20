const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, OPTIONS } = require('./helpers')
installVscode({})
const { Dashboard } = require('../dist/dashboard')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function setup() {
  const calls = [], posted = []
  let onSession, onAnalysis
  const state = { active: 0, peak: 0, statusCalls: 0 }
  const responses = { '/api/llm-options': OPTIONS, '/api/llm-configs': [], '/api/evaluations': { models: [] }, '/api/chats': [], '/api/context': { memory: [], content: '', saved_conversations: 0 }, '/api/sessions?limit=20': [], '/api/progress/pending?limit=10': [] }
  const backend = {
    auth: 'token', url: 'https://example.test', managing: false,
    onDidChangeSession: fn => { onSession = fn },
    status: async () => { state.statusCalls++; return { online: true, email: null } },
    api: async route => {
      calls.push(route)
      state.active++; state.peak = Math.max(state.peak, state.active)
      try { await delay(10); const response = responses[route]; return typeof response === 'function' ? await response() : response ?? {} }
      finally { state.active-- }
    },
  }
  const analyser = { results: new Map(), onDidAnalyse: fn => { onAnalysis = fn } }
  const chat = { current: undefined, list: () => backend.api('/api/chats'), analyseForPage: async () => undefined, send: async () => {}, retry: async () => {} }
  const dashboard = new Dashboard(backend, analyser, chat, {})
  dashboard.view = { webview: { postMessage: message => posted.push(message) } }
  return { dashboard, backend, analyser, chat, calls, posted, state, responses, session: () => onSession(), analysis: () => onAnalysis() }
}

test('Analyse starts synchronously without status/catalogue reload; completion refreshes only the conversation', async () => {
  const f = setup()
  let started = false
  f.chat.analyseForPage = async () => { started = true; assert.deepEqual(f.calls, []); f.analysis() }
  const action = f.dashboard.handle({ type: 'analyse', text: 'Synthetic task' })
  assert.equal(started, true, 'no awaited panel reload before analysis starts')
  assert.equal(f.posted[0].type, 'assistantState')
  assert.equal(f.posted[0].data.analysing, true)
  await action
  assert.deepEqual(f.calls, ['/api/chats'])
  assert.equal(f.state.statusCalls, 0)
  assert.equal(f.posted.at(-1).data.analysing, false)
})

test('progress reads overlap but never exceed three, and retain independent sections after one fails', async () => {
  const f = setup()
  f.dashboard.tab = 'progress'
  f.responses['/api/progress/dashboard'] = () => { throw new Error('unavailable') }
  f.responses['/api/progress/activity'] = { count: 7 }
  await f.dashboard.reload()
  assert.equal(f.state.peak, 3)
  assert.equal(f.calls.length, 8)
  assert.deepEqual(f.posted.at(-1).activity, { count: 7 })
  assert.equal(f.posted.at(-1).dashboard, undefined)
  assert.equal(f.dashboard.reading, 0, 'all slots are released after failures')
})

test('three simultaneous reloads share the same work and publish one result', async () => {
  const f = setup()
  const first = f.dashboard.reload()
  assert.equal(f.dashboard.reload(), first)
  await Promise.all([first, f.dashboard.reload()])
  assert.equal(f.state.statusCalls, 0)
  for (const route of ['/api/llm-options', '/api/evaluations', '/api/chats']) assert.equal(f.calls.filter(c => c === route).length, 1)
  assert.equal(f.posted.filter(p => p.type === 'data' && !p.loading).length, 1)
})

test('an obsolete models response cannot overwrite another tab or its action cache', async () => {
  const f = setup(), old = deferred()
  f.dashboard.tab = 'models'
  f.responses['/api/llm-options'] = () => old.promise
  f.responses['/api/llm-configs'] = [{ id: 'obsolete', label: 'Old', provider: 'groq' }]
  const previous = f.dashboard.reload()
  await delay(15)
  const fresh = f.dashboard.handle({ type: 'tab', tab: 'profile' })
  await fresh
  old.resolve(OPTIONS)
  await previous
  assert.equal(f.posted.at(-1).tab, 'profile')
  assert.equal(f.posted.filter(p => p.tab === 'models' && !p.loading).length, 0)
  assert.deepEqual(f.dashboard.cache.configs, [])
})

test('sign-out invalidates pending data immediately; it never repopulates the page or cache', async () => {
  const f = setup(), old = deferred()
  f.responses['/api/llm-options'] = () => old.promise
  const previous = f.dashboard.reload()
  await delay(15)
  f.backend.auth = 'none'
  f.session()
  old.resolve(OPTIONS)
  await previous
  assert.equal(f.posted.at(-1).signedOut, true)
  assert.equal(f.posted.filter(p => p.type === 'data' && !p.signedOut && !p.loading).length, 0)
})

test('backend changes invalidate old results even without a session event', async () => {
  const f = setup(), old = deferred()
  f.responses['/api/llm-options'] = () => old.promise
  const previous = f.dashboard.reload()
  await delay(15)
  f.backend.url = 'https://another.example.test'
  old.resolve(OPTIONS)
  await previous
  assert.equal(f.posted.filter(p => !p.loading).length, 0)
})

test('after streaming, only list and selected transcript are fetched, including stopped/error messages', async () => {
  const f = setup()
  f.chat.current = 'current'
  f.responses['/api/chats'] = [{ id: 'current', title: 'Synthetic', message_count: 1 }]
  f.responses['/api/chats/current'] = { messages: [{ role: 'assistant', content: 'Partial answer', status: 'stopped' }] }
  f.chat.send = async (_text, sink) => sink.markdown('Partial answer')
  await f.dashboard.handle({ type: 'chatSend', text: 'Synthetic task' })
  assert.deepEqual(f.calls, ['/api/chats', '/api/chats/current'])
  assert.equal(f.state.statusCalls, 0)
  assert.equal(f.posted.find(p => p.type === 'delta').text, 'Partial answer')
  const data = f.posted.at(-1).data
  assert.equal(data.streaming, false)
  assert.equal(data.messages[0].text, 'Partial answer')
  assert.equal(data.messages[0].error, 'Stopped by you.')
})

test('transcript refresh errors are visible and do not trigger a full catalogue reload', async () => {
  const f = setup()
  f.responses['/api/chats'] = () => { throw new Error('offline') }
  await f.dashboard.handle({ type: 'chatRetry' })
  assert.deepEqual(f.calls, ['/api/chats'])
  assert.equal(f.posted.at(-1).type, 'toast')
  assert.equal(f.posted.at(-1).kind, 'err')
})

test('a new action invalidates an older conversation refresh before it can replace the live answer', async () => {
  const f = setup(), previousList = deferred(), stream = deferred()
  f.responses['/api/chats'] = () => previousList.promise
  const previous = f.dashboard.refreshAssistant()
  await delay(15)
  f.chat.send = async (_text, sink) => { sink.markdown('Live answer'); await stream.promise }
  const sending = f.dashboard.handle({ type: 'chatSend', text: 'New synthetic task' })
  previousList.resolve([])
  await previous
  assert.equal(f.posted.filter(p => p.type === 'assistantState' && Object.hasOwn(p.data, 'messages')).length, 0)
  assert.equal(f.posted.find(p => p.type === 'delta').text, 'Live answer')
  stream.resolve()
  await sending
  assert.equal(f.posted.at(-1).data.streaming, false)
})

test('forced reload after a mutation publishes fresh data instead of joining an older read', async () => {
  const f = setup(), stale = deferred()
  f.responses['/api/llm-options'] = () => stale.promise
  const old = f.dashboard.reload()
  await delay(15)
  f.responses['/api/llm-options'] = { options: [], auto_configuration_id: 'fresh' }
  await f.dashboard.reload(true)
  stale.resolve(OPTIONS)
  await old
  assert.equal(f.posted.filter(p => p.type === 'data' && !p.loading).length, 1)
  assert.equal(f.posted.at(-1).autoId, 'fresh')
})

test('a timeout on the current tab is shown as a failure instead of being silently discarded', async () => {
  const f = setup()
  const signal = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'))
  await f.dashboard.reloadData('analyse', signal, () => true)
  assert.equal(f.posted.at(-1).type, 'data')
  assert.ok(f.posted.at(-1).failed)
  assert.equal(f.posted.at(-1).tab, 'analyse')
})
