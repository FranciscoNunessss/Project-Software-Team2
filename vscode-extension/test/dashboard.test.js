// The AdaptAI editor tab: actions need the page's own dialogs, and the page may only send known messages.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore } = require('./helpers')

const { log } = installVscode({ backendUrl: 'http://127.0.0.1:1' })
const { Dashboard } = require('../dist/dashboard.js')
const { Backend } = require('../dist/backend.js')

const calls = []
const backend = {
  auth: 'token',
  managing: false,
  urlProblem: undefined,
  onDidChangeSession: () => ({}),
  api: async (path, method = 'GET', body) => (calls.push([method, path, body]), {}),
  status: async () => ({ email: 'a@b.c', online: true }),
}
const analyser = { onDidAnalyse: () => ({}), results: new Map() }
const models = { refresh: async () => {} }
const profile = { refresh: async () => {} }
const dash = new Dashboard(backend, analyser, { list: async () => [], remove: async () => {} }, { open: async () => {} })

test('only known switches and deletions are handled; deletions need the dialog, which has no page here', async () => {
  calls.length = 0
  await dash.handle({ type: 'toggle', key: 'coach', on: true })
  await dash.handle({ type: 'toggle', key: 'is_admin', on: true })
  await dash.handle({ type: 'delete', what: 'history' })
  await dash.handle({ type: 'delete', what: 'everything' })
  await dash.handle({ type: 'nonsense' })
  await dash.handle(null)
  assert.deepEqual(calls.map(c => c.slice(0, 2).join(' ')), ['PUT /api/prompt-coach/settings'])
})

test('an unknown model id does nothing, a switch that sends more text waits for consent, and result actions only run on known analyses', async () => {
  calls.length = 0
  log.executed.length = 0
  await dash.handle({ type: 'modelRemove', id: 'nope' })
  await dash.handle({ type: 'toggle', key: 'conversation_memory_enabled', on: true })
  await dash.handle({ type: 'result', command: 'adaptai.useModel', id: 'unknown' })
  await dash.handle({ type: 'result', command: 'workbench.action.quitEditor', id: 'x' })
  assert.deepEqual(calls, [], 'no consent dialog could be answered, so nothing was changed')
  assert.deepEqual(log.executed, [])
})

test('token routes are the only ones the password session may call', async () => {
  const b = new Backend(secretStore())
  await assert.rejects(() => b.tokenApi('/api/chats'), error => error.status === 0)
  await assert.rejects(() => b.tokenApi('/api/tokens'), error => error.status === 401)
})
