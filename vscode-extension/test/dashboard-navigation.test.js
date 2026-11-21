const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, OPTIONS } = require('./helpers')
const { vscode } = installVscode({})
vscode.extensions = { getExtension: () => ({ packageJSON: { contributes: { commands: [], keybindings: [] } } }) }
const { Dashboard } = require('../dist/dashboard')

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function setup() {
  const calls = [], posted = []
  const responses = {
    '/api/llm-options': OPTIONS, '/api/evaluations': { models: [] }, '/api/llm-configs': [], '/api/chats': [],
    '/api/context': { memory: [], content: 'Synthetic preferences', saved_conversations: 0 },
    '/api/sessions?limit=20': [], '/api/progress/pending?limit=10': [], '/api/progress/activity': { count: 1 },
  }
  const backend = {
    auth: 'token', url: 'https://synthetic.example', managing: false, onDidChangeSession: () => {},
    api: async route => { calls.push(route); const value = responses[route]; return typeof value === 'function' ? value() : value ?? {} },
  }
  const chat = {
    current: undefined, list: () => backend.api('/api/chats'),
    setCurrent: async id => { chat.current = id }, send: async () => {},
  }
  const dash = new Dashboard(backend, { results: new Map(), onDidAnalyse: () => {} }, chat, {})
  dash.view = { visible: true, webview: { postMessage: message => posted.push(message) } }
  return { dash, chat, backend, responses, calls, posted }
}

test('a completed message keeps Progress/Profile visible for revalidation and reuses Models', async () => {
  const f = setup()
  await f.dash.preload()
  const models = f.dash.tabData.get('models')
  await f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  assert.ok(f.dash.tabData.has('progress'), 'the last Progress snapshot must survive a message')
  assert.ok(f.dash.tabData.has('profile'))
  assert.equal(f.dash.tabData.get('models'), models)
  f.posted.length = 0
  f.responses['/api/progress/activity'] = { count: 2 }
  await f.dash.handle({ type: 'tab', tab: 'progress' })
  const data = f.posted.filter(message => message.type === 'data')
  assert.equal(data.some(message => message.loading), false)
  assert.equal(data[0].refreshing, true)
  assert.deepEqual(data[0].activity, { count: 1 })
  assert.deepEqual(data.at(-1).activity, { count: 2 })
  const before = f.calls.length
  await f.dash.handle({ type: 'tab', tab: 'models' })
  assert.equal(f.calls.length, before)
})

test('a reply finishing on Progress refreshes it without discarding the other tabs or navigating', async () => {
  const f = setup(), answer = deferred()
  await f.dash.preload()
  f.chat.send = async () => answer.promise
  const sending = f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  await f.dash.handle({ type: 'tab', tab: 'progress' })
  f.posted.length = 0
  answer.resolve()
  await sending
  assert.equal(f.dash.tab, 'progress')
  assert.equal(f.posted.some(message => message.type === 'navigate' || message.loading), false)
  assert.ok(f.dash.tabData.has('models'))
  assert.ok(f.dash.tabData.has('shortcuts'))
  assert.equal(f.posted.filter(message => message.type === 'data').at(-1).tab, 'progress')
})

test('the first reply updates the Assistant snapshot to the new chat without refetching model data', async () => {
  const f = setup()
  await f.dash.preload()
  f.responses['/api/chats'] = [{ id: 'new', title: 'Synthetic', message_count: 2 }]
  f.responses['/api/chats/new'] = { messages: [{ role: 'assistant', content: 'Saved synthetic reply', status: 'done' }] }
  f.chat.send = async () => { f.chat.current = 'new' }
  await f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  assert.equal(f.dash.tabData.get('analyse').data.current, 'new')
  const before = f.calls.length
  await f.dash.handle({ type: 'tab', tab: 'shortcuts' })
  await f.dash.handle({ type: 'tab', tab: 'analyse' })
  assert.equal(f.calls.length, before)
  assert.equal(f.posted.at(-1).messages[0].text, 'Saved synthetic reply')
})

test('New chat clears the selected conversation atomically with no network or other-tab invalidation', async () => {
  const f = setup()
  f.chat.current = 'old'
  f.responses['/api/chats'] = [{ id: 'old', title: 'Old synthetic conversation', message_count: 1 }]
  f.responses['/api/chats/old'] = { messages: [{ role: 'user', content: 'Old synthetic message' }] }
  await f.dash.preload()
  const before = f.calls.length
  await f.dash.handle({ type: 'chatNew' })
  assert.equal(f.chat.current, undefined)
  assert.equal(f.calls.length, before)
  assert.ok(f.dash.tabData.has('progress'))
  assert.equal(f.posted.some(message => message.loading), false)
  assert.deepEqual(f.posted.at(-1).messages, [])
})

test('New chat during a response leaves that conversation selected and explains how to continue', async () => {
  const f = setup(), answer = deferred()
  f.chat.current = 'old'
  f.chat.send = async () => answer.promise
  const sending = f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  await f.dash.handle({ type: 'chatNew' })
  assert.equal(f.chat.current, 'old')
  assert.match(f.posted.at(-1).text, /Stop|finish/i)
  answer.resolve()
  await sending
})

test('opening another conversation during a response cannot mix its messages with the live answer', async () => {
  const f = setup(), answer = deferred()
  f.chat.current = 'old'
  f.chat.send = async () => answer.promise
  const sending = f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  await f.dash.handle({ type: 'chatSelect', id: 'other' })
  assert.equal(f.chat.current, 'old')
  assert.match(f.posted.at(-1).text, /Stop|finish/i)
  answer.resolve()
  await sending
})

test('a Progress read started before a reply finishes cannot overwrite the refreshed figures', async () => {
  const f = setup(), old = deferred()
  await f.dash.preload()
  f.dash.tabData.get('progress').at = 0
  f.responses['/api/progress/activity'] = () => old.promise
  const previous = f.dash.handle({ type: 'tab', tab: 'progress' })
  f.responses['/api/progress/activity'] = { count: 3 }
  await f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  old.resolve({ count: 2 })
  await previous
  assert.deepEqual(f.dash.tabData.get('progress').data.activity, { count: 3 })
  assert.deepEqual(f.posted.filter(message => message.type === 'data').at(-1).activity, { count: 3 })
})

test('a failed refresh after sending preserves the last Progress figures and reports the failure', async () => {
  const f = setup()
  await f.dash.preload()
  await f.dash.handle({ type: 'chatSend', text: 'Synthetic task' })
  for (const route of ['/api/progress/activity', '/api/progress', '/api/progress/dashboard']) {
    f.responses[route] = () => { throw new Error('Synthetic offline failure') }
  }
  await f.dash.handle({ type: 'tab', tab: 'progress' })
  assert.deepEqual(f.posted.at(-1).activity, { count: 1 })
  assert.match(f.posted.at(-1).refreshError, /Synthetic offline failure/)
})
