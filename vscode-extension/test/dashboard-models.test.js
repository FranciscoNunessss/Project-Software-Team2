// The models and the profile as the page does them (they used to be tests of the side-bar trees): add, edit,
// delete and test a model, the consent of an evaluation, the OpenRouter catalogue, the switches, the preferences
// and the deletions. A fake view answers the page's dialogs.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1', chatModel: '' }
installVscode(config)
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
    calls.push([method, path.split('?')[0], body, path])
    const key = `${method} ${path.split('?')[0]}`
    if (!(key in responses)) return {}
    const value = responses[key]
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value(path, body) : value
  },
}
const analyser = { onDidAnalyse: () => ({}), results: new Map(), continueFrom: undefined, lastError: undefined, show: async () => undefined }
const chat = { current: undefined, list: async () => [], send: async () => undefined, setCurrent: async () => undefined }
const dash = new Dashboard(backend, analyser, chat, { open: async () => {} })
const dialogs = []
const view = {
  visible: true,
  webview: {
    options: {},
    html: '',
    cspSource: 'csp',
    postMessage: async message => {
      posted.push(message)
      if (message.type === 'dialog') {
        dialogs.push(message)
        setTimeout(() => void dash.handle({ type: 'dialogResult', id: message.id, values: answers.shift() }), 0)
      }
    },
    onDidReceiveMessage: () => ({}),
  },
  onDidChangeVisibility: () => ({}),
  onDidDispose: () => ({}),
}
dash.resolveWebviewView(view)

const reset = () => {
  answers.length = 0
  posted.length = 0
  dialogs.length = 0
  calls.length = 0
}
const writes = () => calls.filter(([method]) => method !== 'GET')
const toasts = () => posted.filter(m => m.type === 'toast')
const mine = { id: 'c1', label: 'My Groq', provider: 'groq', model: 'x', enabled: true, is_default: false, has_key: true, external: true, responses_api: false }
const entry = (extra = {}) => ({ provider: 'groq', model: 'big', configuration_id: 'c1', levels: { reasoning: 2 }, picked: true, evaluation: { id: 'e1', status: 'awaiting_consent', calls_max: 40, estimate: { price_known: true, max_cost_usd: 0.5 } }, ...extra })

async function openModels(configs = [mine], evaluations = [entry()]) {
  responses = {
    'GET /api/llm-options': { options: [], auto_configuration_id: null, assessment: null },
    'GET /api/llm-configs': configs,
    'GET /api/evaluations': { models: evaluations },
    'GET /api/chats': [],
  }
  await dash.handle({ type: 'tab', tab: 'models' })
}

test('the models tab lists the project models, yours and how each was evaluated', async () => {
  reset()
  responses = {
    'GET /api/llm-options': { options: [{ id: 'server:groq', provider: 'groq', label: 'Groq', model: 'llama', external: true, source: 'server' }], auto_configuration_id: 'server:groq', assessment: { id: 'server:groq', provider: 'groq', label: 'Groq', model: 'llama', external: true, source: 'server' } },
    'GET /api/llm-configs': [mine],
    'GET /api/evaluations': { models: [entry()] },
    'GET /api/chats': [],
  }
  await dash.handle({ type: 'tab', tab: 'models' })
  const data = posted.findLast(m => m.type === 'data' && m.tab === 'models')
  assert.equal(data.project[0].assessor, true, 'the assessor is marked')
  assert.deepEqual(data.configs.map(c => [c.label, c.hasKey, c.external]), [['My Groq', true, true]])
  assert.equal(data.evaluations.length, 1)
  assert.ok(data.evaluations[0].text, 'the state is said in words')
})

test('adding a hosted model sends the name, provider, model and key, and the key is asked as a password', async () => {
  reset()
  await openModels([])
  answers.push({ provider: 'groq' }, { label: ' Mine ', model: ' openai/gpt-oss-20b ', key: 'secret-key' })
  await dash.handle({ type: 'modelAdd' })
  const form = dialogs[1]
  assert.equal(form.fields.find(f => f.name === 'key').type, 'password')
  assert.equal(form.fields.find(f => f.name === 'model').required, true)
  assert.deepEqual(writes()[0].slice(0, 3), ['POST', '/api/llm-configs', { label: 'Mine', provider: 'groq', model: 'openai/gpt-oss-20b', api_key: 'secret-key', enabled: true, is_default: false }])
})

test('a local model needs no key, and OpenRouter needs no model', async () => {
  reset()
  await openModels([])
  answers.push({ provider: 'lmstudio' }, { label: 'Local', model: 'gemma' })
  await dash.handle({ type: 'modelAdd' })
  assert.equal(dialogs[1].fields.some(f => f.name === 'key'), false)
  assert.equal(writes()[0][2].api_key, undefined)
  reset()
  answers.push({ provider: 'openrouter' }, { label: 'OR', model: '', key: 'k' })
  await dash.handle({ type: 'modelAdd' })
  assert.equal(dialogs[1].fields.find(f => f.name === 'model').required, false)
  assert.match(dialogs[1].fields.find(f => f.name === 'key').hint, /50 requests a day/, 'the free quota is explained')
  assert.equal(writes()[0][2].model, '')
})

test('cancelling a step of "Add a model" sends nothing; a backend refusal is explained in the page', async () => {
  reset()
  await openModels([])
  answers.push(undefined)
  await dash.handle({ type: 'modelAdd' })
  answers.push({ provider: 'groq' }, undefined)
  await dash.handle({ type: 'modelAdd' })
  assert.equal(writes().length, 0)
  answers.push({ provider: 'groq' }, { label: 'G', model: 'm', key: 'k' })
  responses['POST /api/llm-configs'] = Object.assign(new Error('x'), { status: 422, code: 'model_not_found' })
  const { ApiError } = require('../dist/backend.js')
  responses['POST /api/llm-configs'] = new ApiError(422, 'model_not_found')
  await dash.handle({ type: 'modelAdd' })
  assert.ok(toasts().some(t => t.kind === 'err' && t.text.length > 10), 'the reason is shown')
})

test('editing keeps the other fields, and the key is sent only when a new one is typed', async () => {
  reset()
  await openModels()
  answers.push({ label: 'Renamed', model: 'x', key: '', enabled: true, is_default: false })
  await dash.handle({ type: 'modelEdit', id: 'c1' })
  assert.equal(writes()[0][0], 'PUT')
  assert.equal(writes()[0][2].label, 'Renamed')
  assert.equal(writes()[0][2].provider, 'groq')
  assert.equal('api_key' in writes()[0][2], false)
  reset()
  answers.push({ label: 'Renamed', model: 'x', key: 'new-key', enabled: false, is_default: true })
  await dash.handle({ type: 'modelEdit', id: 'c1' })
  assert.equal(writes()[0][2].api_key, 'new-key')
  assert.equal(writes()[0][2].enabled, false)
  assert.equal(writes()[0][2].is_default, true)
})

test('deleting asks first and says the key goes too; declining deletes nothing', async () => {
  reset()
  await openModels()
  answers.push(undefined)
  await dash.handle({ type: 'modelRemove', id: 'c1' })
  assert.equal(writes().length, 0)
  assert.match(dialogs[0].text, /key is deleted too/)
  answers.push({})
  await dash.handle({ type: 'modelRemove', id: 'c1' })
  assert.deepEqual(writes()[0].slice(0, 2), ['DELETE', '/api/llm-configs/c1'])
})

test('the test of a model asks the backend and says what it proves, or explains a failure', async () => {
  reset()
  await openModels()
  responses['POST /api/llm-configs/c1/test'] = { status: 'ok' }
  await dash.handle({ type: 'modelTest', id: 'c1' })
  assert.ok(toasts().some(t => t.kind === 'ok' && /only proves one short request/.test(t.text)))
  const { ApiError } = require('../dist/backend.js')
  responses['POST /api/llm-configs/c1/test'] = new ApiError(502, 'provider_authentication')
  posted.length = 0
  await dash.handle({ type: 'modelTest', id: 'c1' })
  assert.ok(toasts().some(t => t.kind === 'err'))
})

test('a paid evaluation sends nothing before consent; accepting queues it; "Not now" asks to confirm the decline', async () => {
  reset()
  await openModels()
  assert.equal(writes().length, 0, 'nothing is sent by opening the tab')
  answers.push({})
  await dash.handle({ type: 'evalConsent', id: 'groq/big' })
  assert.match(dialogs[0].text, /synthetic tasks/)
  assert.deepEqual(writes()[0].slice(0, 3), ['POST', '/api/evaluations/e1/consent', { accept: true, confirm_unknown_price: false }])
  reset()
  answers.push(undefined, {})
  await dash.handle({ type: 'evalConsent', id: 'groq/big' })
  assert.deepEqual(writes()[0][2], { accept: false, confirm_unknown_price: false })
  reset()
  answers.push(undefined, undefined)
  await dash.handle({ type: 'evalConsent', id: 'groq/big' })
  assert.equal(writes().length, 0, 'not declining either sends nothing')
})

test('an unknown price needs a second confirmation, and refusing it sends nothing', async () => {
  reset()
  await openModels([mine], [entry({ evaluation: { id: 'e1', status: 'awaiting_consent', calls_max: 40, estimate: { price_known: false } } })])
  answers.push({}, undefined)
  await dash.handle({ type: 'evalConsent', id: 'groq/big' })
  assert.equal(writes().length, 0)
  answers.push({}, {})
  await dash.handle({ type: 'evalConsent', id: 'groq/big' })
  assert.equal(writes()[0][2].confirm_unknown_price, true)
})

test('re-evaluate names the configuration and the model; disagree names the capability and says nothing changes', async () => {
  reset()
  await openModels()
  await dash.handle({ type: 'evalRedo', id: 'groq/big' })
  assert.deepEqual(writes()[0].slice(0, 3), ['POST', '/api/evaluations/reevaluate', { configuration_id: 'c1', model: 'big' }])
  reset()
  answers.push({ capability: 'tools' })
  await dash.handle({ type: 'evalDisagree', id: 'groq/big' })
  assert.deepEqual(writes()[0].slice(0, 3), ['POST', '/api/evaluations/e1/disagree', { capability: 'tools' }])
  assert.match(dialogs[0].text, /never changes a level/)
})

test('the OpenRouter catalogue lists free and priced models, refuses those that cannot be chosen, and sends nothing to a model', async () => {
  reset()
  const orConfig = { ...mine, id: 'or1', label: 'OR', provider: 'openrouter', model: null }
  await openModels([orConfig], [])
  responses['GET /api/openrouter/models'] = { models: [{ id: 'a/free:free', free: true, selectable: true }, { id: 'b/paid', price_input_per_million: 1.5, price_output_per_million: 3, selectable: true, context_length: 8000 }, { id: 'c/audio', selectable: false, reason: 'no text' }] }
  answers.push({ pick: 'b/paid' })
  await dash.handle({ type: 'openrouter' })
  const items = dialogs[0].list.items
  assert.equal(items.find(i => i.key === 'a/free:free').sub, 'free')
  assert.match(items.find(i => i.key === 'b/paid').sub, /1\.50 \/ 3\.00 USD/)
  assert.equal(items.find(i => i.key === 'c/audio').disabled, true)
  assert.deepEqual(writes()[0].slice(0, 3), ['POST', '/api/evaluations/models', { configuration_id: 'or1', model: 'b/paid' }])
  assert.equal(calls.some(([, path]) => /chats\/.*messages|analyze/.test(path)), false, 'no model was called')
})

test('without an OpenRouter configuration the catalogue says to connect it first, and a picked model can be removed', async () => {
  reset()
  await openModels([mine], [])
  await dash.handle({ type: 'openrouter' })
  assert.ok(toasts().some(t => /Connect OpenRouter first/.test(t.text)))
  reset()
  await openModels([mine], [entry()])
  answers.push(undefined)
  await dash.handle({ type: 'evalRemove', id: 'groq/big' })
  assert.equal(writes().length, 0)
  answers.push({})
  await dash.handle({ type: 'evalRemove', id: 'groq/big' })
  assert.equal(writes()[0][0], 'DELETE')
  assert.match(writes()[0][3], /configuration_id=c1&model=big/)
})

// ---- the profile ------------------------------------------------------------------------------------

const settings = { content: 'Portuguese please', save_enabled: false, use_enabled: false, coaching_auto_enabled: false, conversation_memory_enabled: false, saved_conversations: 2, memory: [1, 2, 3] }
async function openProfile() {
  responses = {
    'GET /api/context': settings,
    'GET /api/prompt-coach/settings': { enabled: true },
    'GET /api/chat/settings': { auto_analyse: false },
    'GET /api/chats': [],
    'GET /api/tokens': { tokens: [] },
  }
  await dash.handle({ type: 'tab', tab: 'profile' })
}

test('the profile tab carries each switch with its state, the preferences and the counts the deletions name', async () => {
  reset()
  await openProfile()
  const data = posted.findLast(m => m.type === 'data' && m.tab === 'profile')
  assert.equal(data.values.save_enabled, false)
  assert.equal(data.values.coach, true)
  assert.equal(data.preferences, 'Portuguese please')
  assert.equal(data.counts.memory, 3)
  assert.equal(data.counts.conversations, 2)
})

test('a plain switch changes on the backend without a question; Prompt Coach and Always analyse use their own routes', async () => {
  reset()
  await openProfile()
  await dash.handle({ type: 'toggle', key: 'save_enabled', on: true })
  assert.deepEqual(writes()[0].slice(0, 3), ['PUT', '/api/context', { save_enabled: true }])
  assert.equal(dialogs.length, 0)
  reset()
  await dash.handle({ type: 'toggle', key: 'coach', on: false })
  assert.deepEqual(writes()[0].slice(0, 3), ['PUT', '/api/prompt-coach/settings', { enabled: false }])
  reset()
  await dash.handle({ type: 'toggle', key: 'auto_analyse', on: true })
  assert.deepEqual(writes()[0].slice(0, 3), ['PUT', '/api/chat/settings', { auto_analyse: true }])
})

test('saving task text and automatic suggestions ask first, explain what is sent, and do nothing if declined', async () => {
  reset()
  await openProfile()
  for (const key of ['conversation_memory_enabled', 'coaching_auto_enabled']) {
    answers.push(undefined)
    await dash.handle({ type: 'toggle', key, on: true })
  }
  assert.equal(writes().length, 0)
  assert.match(dialogs[0].text, /stored on the backend/)
  assert.match(dialogs[1].text, /project model/)
  answers.push({})
  await dash.handle({ type: 'toggle', key: 'conversation_memory_enabled', on: true })
  assert.deepEqual(writes()[0].slice(0, 3), ['PUT', '/api/context', { conversation_memory_enabled: true }])
  reset()
  await dash.handle({ type: 'toggle', key: 'conversation_memory_enabled', on: false })
  assert.equal(dialogs.length, 0, 'switching off needs no question')
})

test('preferences are saved as typed, an empty value clears them, and an unknown switch is ignored', async () => {
  reset()
  await openProfile()
  answers.push({ content: 'Short answers' })
  await dash.handle({ type: 'preferences', current: 'old' })
  assert.deepEqual(writes()[0].slice(0, 3), ['PUT', '/api/context', { content: 'Short answers' }])
  reset()
  answers.push({ content: '' })
  await dash.handle({ type: 'preferences', current: 'old' })
  assert.deepEqual(writes()[0][2], { content: '' })
  reset()
  await dash.handle({ type: 'toggle', key: 'not_a_switch', on: true })
  assert.equal(writes().length, 0)
})

test('each deletion asks, names what stays, and is sent only after the confirmation', async () => {
  reset()
  await openProfile()
  for (const [what, path, stays] of [['memory', '/api/context/memory', /progress history and saved preferences stay/], ['conversations', '/api/context/conversations', /cannot be undone/], ['history', '/api/progress/history', /cannot be undone/]]) {
    reset()
    answers.push(undefined)
    await dash.handle({ type: 'delete', what })
    assert.equal(writes().length, 0, `${what}: declined`)
    assert.match(dialogs[0].text, stays)
    answers.push({})
    await dash.handle({ type: 'delete', what })
    assert.deepEqual(writes()[0].slice(0, 2), ['DELETE', path])
  }
})
