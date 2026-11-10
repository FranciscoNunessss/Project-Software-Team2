// Models and evaluations (LLM config, the consent to a paid evaluation, the OpenRouter catalogue) with a stub backend.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN, OPTIONS } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1' }
const { vscode, log, ui } = installVscode(config)
const { Backend } = require('../dist/backend.js')
const { ModelsView, describeEvaluation, consentText } = require('../dist/models.js')

const PERSONAL = [
  { id: 'c1', label: 'My Groq', provider: 'groq', model: 'openai/gpt-oss-20b', has_key: true, enabled: true, is_default: false, external: true, responses_api: false, source: 'personal' },
  { id: 'c2', label: 'Router', provider: 'openrouter', model: '', has_key: true, enabled: true, is_default: false, external: true, responses_api: false, source: 'personal' },
]
const waiting = (id, estimate) => ({ provider: 'openai', model: 'gpt-5.4-mini', configuration_id: 'c1', shared: false, paid_by_you: true, picked: false, levels_source: 'LMArena public ranking', levels: { reasoning: 3, context: 3, domain: 2, reliability: 2, tools: 3 }, evaluation: { id, status: 'awaiting_consent', progress: 0, total: 40, errors: 0, failure: null, estimate, spent_usd: null, finished_at: null, levels: null } })
const done = { provider: 'groq', model: 'openai/gpt-oss-20b', configuration_id: null, shared: true, paid_by_you: false, picked: true, levels_source: 'measured', levels: { reasoning: 2, context: 2, domain: 2, reliability: 2, tools: 2 }, evaluation: { id: 'e-done', status: 'done', progress: 40, total: 40, errors: 0, failure: null, estimate: null, spent_usd: 0, finished_at: 't', levels: { reasoning: 2, context: 2, domain: 2, reliability: 2, tools: 2 } } }
const PAID = { calls_max: 40, input_tokens_max: 20000, output_tokens_max: 40960, price_known: true, free: false, estimated_usd: 0.1234, max_usd: 0.3 }
const UNKNOWN = { ...PAID, price_known: false, estimated_usd: null, max_usd: null }

async function backendStub(mode = {}) {
  const state = { calls: [], evaluations: mode.evaluations ?? [done, waiting('e-1', PAID)], configs: mode.configs ?? PERSONAL }
  const server = await stub((request, response, body) => {
    const send = (data, status = 200) => json(response, data, status)
    const parsed = body ? JSON.parse(body) : {}
    state.calls.push({ method: request.method, url: request.url, body: parsed })
    if (request.url === '/api/llm-options') return send(OPTIONS)
    if (request.url === '/api/llm-configs' && request.method === 'GET') return send(state.configs)
    if (request.url === '/api/llm-configs' && request.method === 'POST') return mode.create ? mode.create(parsed, send) : send({ id: 'new', ...parsed }, 201)
    if (/^\/api\/llm-configs\/[^/]+\/test$/.test(request.url)) return mode.test ? mode.test(send) : send({ status: 'ok', model: 'm', usage: null })
    if (/^\/api\/llm-configs\/[^/]+$/.test(request.url)) return send({ status: request.method === 'DELETE' ? 'deleted' : 'saved' })
    if (request.url === '/api/evaluations') return send({ suite: 'measure-suite-1', models: state.evaluations })
    if (request.url === '/api/openrouter/models') return send({ fetched_at: 't', models: mode.catalogue ?? [] })
    if (request.url.startsWith('/api/evaluations')) return send({ status: 'ok' })
    send({ detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  const connections = new Map()
  const view = new ModelsView(backend, connections)
  await view.refresh()
  return { server, view, state, connections }
}

const reset = () => {
  ui.warning = (_m, _o, buttons) => buttons[0]
  ui.info = () => undefined
  ui.error = () => undefined
  ui.quickPick = items => items[0]
  vscode.window.showInputBox = async () => undefined
  for (const key of Object.keys(log)) log[key].length = 0
}
const inputs = (...values) => {
  const queue = [...values]
  vscode.window.showInputBox = async () => queue.shift()
}
const posts = (state, url) => state.calls.filter(call => call.url === url || call.url.startsWith(url + '?')).filter(call => call.method !== 'GET')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('each evaluation state is said in words the user can act on', () => {
  const base = { provider: 'p', model: 'm', configuration_id: 'c', shared: true, paid_by_you: false, levels_source: null, levels: null }
  const ev = (status, extra = {}) => ({ ...base, evaluation: { id: 'e', status, progress: 12, total: 40, errors: 0, failure: null, estimate: null, spent_usd: null, finished_at: null, levels: null, ...extra } })
  assert.equal(describeEvaluation({ ...base, evaluation: null }).text, 'Not evaluated')
  assert.match(describeEvaluation({ ...base, levels_source: 'LMArena', levels: { reasoning: 2 }, evaluation: null }).text, /Not measured · LMArena/)
  assert.deepEqual(describeEvaluation(ev('awaiting_consent')), { text: 'Waiting for your consent', icon: 'bell', consent: true })
  assert.equal(describeEvaluation(ev('running')).text, 'Evaluating 12/40')
  assert.equal(describeEvaluation(ev('queued')).text, 'Queued')
  assert.match(describeEvaluation(ev('done', { levels: { reasoning: 3, tools: 1 } })).text, /Measured by AdaptAI · R3 T1/)
  assert.match(describeEvaluation(ev('failed', { failure: 'provider_refused' })).text, /Evaluation failed \(provider refused\)/)
  assert.match(describeEvaluation(ev('declined')).text, /Declined/)
})

test('the consent says what is sent, the cost and its ceiling, and what declining means', () => {
  const text = consentText(waiting('e', PAID))
  assert.match(text, /Evaluate openai · gpt-5\.4-mini\?/)
  assert.match(text, /up to 40 synthetic tasks \(none of your text\) to openai with your key/)
  assert.match(text, /Estimated cost 0\.1234 USD, never more than 0\.3000 USD/)
  assert.match(text, /If you decline, you can still use the model in the chat/)
  assert.match(consentText(waiting('e', UNKNOWN)), /price of this model is not known/)
  assert.match(consentText(waiting('e', { ...PAID, free: true })), /It is free\./)
})

test('the tree has the project models (the assessor marked), yours, and the evaluations with their state', async () => {
  reset()
  const { server, view, connections } = await backendStub()
  try {
    connections.set('server:groq', { state: 'tested', at: Date.now(), ms: 900 })
    const groups = view.getChildren()
    assert.deepEqual(groups.map(row => row.label), ['Project models', 'Your models', 'How models were evaluated'])
    const [groq, lm] = view.getChildren(groups[0])
    assert.match(view.getTreeItem(groq).description, /llama-test · external · assesses tasks · connection tested OK/)
    assert.match(view.getTreeItem(lm).description, /local · configured, not tested/)
    const mine = view.getChildren(groups[1]).map(row => view.getTreeItem(row))
    assert.match(mine[0].description, /groq · openai\/gpt-oss-20b/)
    assert.match(mine[1].description, /openrouter · any catalogue model/)
    assert.equal(mine[0].contextValue, 'adaptai.personalModel')
    const evaluations = view.getChildren(groups[2]).map(row => view.getTreeItem(row))
    assert.match(evaluations[0].description, /Measured by AdaptAI · R2 C2 D2 R2 T2 · shared/)
    assert.equal(evaluations[0].contextValue, 'adaptai.evaluation')
    assert.match(evaluations[1].description, /Waiting for your consent · yours only/)
    assert.equal(evaluations[1].contextValue, 'adaptai.evaluationAsk')
  } finally {
    await server.close()
  }
})

test('signed out or failing is said in the tree', async () => {
  reset()
  const out = new ModelsView(new Backend(secretStore()), new Map())
  await out.refresh()
  assert.match(out.getChildren()[0].label, /Sign in to see your models/)
})

test('adding a hosted model sends the name, provider, model and the key, and the key is asked as a password', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    let passwordAsked = false
    const queue = ['My OpenAI', 'gpt-5.4-mini', 'sk-test-key-123456789']
    vscode.window.showInputBox = async options => {
      if (options.password) passwordAsked = true
      return queue.shift()
    }
    ui.quickPick = items => items.find(item => item.provider === 'openai')
    await view.add()
    assert.equal(passwordAsked, true)
    assert.deepEqual(posts(state, '/api/llm-configs')[0].body, { label: 'My OpenAI', provider: 'openai', model: 'gpt-5.4-mini', api_key: 'sk-test-key-123456789', enabled: true, is_default: false })
    assert.match(log.info.at(-1), /My OpenAI added/)
  } finally {
    await server.close()
  }
})

test('a local model needs no key, and OpenRouter needs no model', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    inputs('Local', 'gemma')
    ui.quickPick = items => items.find(item => item.provider === 'lmstudio')
    await view.add()
    const body = posts(state, '/api/llm-configs')[0].body
    assert.equal(body.api_key, undefined)
    assert.equal(body.provider, 'lmstudio')
    inputs('Router', '', 'sk-or-key-1234567890')
    ui.quickPick = items => items.find(item => item.provider === 'openrouter')
    await view.add()
    assert.equal(posts(state, '/api/llm-configs')[1].body.model, '')
  } finally {
    await server.close()
  }
})

test('cancelling any step of "Add a model" sends nothing; a backend refusal is explained', async () => {
  reset()
  const { server, view, state } = await backendStub({ create: (body, send) => send({ detail: 'api_key_required' }, 422) })
  try {
    inputs('Name', 'model', undefined)
    ui.quickPick = items => items.find(item => item.provider === 'groq')
    await view.add()
    assert.equal(posts(state, '/api/llm-configs').length, 0)
    inputs('Name', 'model', 'sk-test-key-123456789')
    await view.add()
    assert.match(log.error.at(-1), /422|invalid|api_key_required/)
  } finally {
    await server.close()
  }
})

test('editing keeps the other fields; replacing the key sends only the new key', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    ui.quickPick = items => items.find(item => item.field === 'enabled')
    await view.edit(PERSONAL[0])
    const put = state.calls.find(call => call.method === 'PUT')
    assert.deepEqual(put.body, { label: 'My Groq', provider: 'groq', model: 'openai/gpt-oss-20b', responses_api: false, enabled: false, is_default: false })
    ui.quickPick = items => items.find(item => item.field === 'key')
    inputs('sk-new-key-123456789')
    await view.edit(PERSONAL[0])
    assert.equal(state.calls.filter(call => call.method === 'PUT')[1].body.api_key, 'sk-new-key-123456789')
  } finally {
    await server.close()
  }
})

test('deleting asks first and says the key goes too; declining deletes nothing', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    ui.warning = () => undefined
    await view.remove(PERSONAL[0])
    assert.equal(state.calls.filter(call => call.method === 'DELETE').length, 0)
    assert.match(log.warning[0].message, /encrypted key is deleted too/)
    ui.warning = (_m, _o, buttons) => buttons[0]
    await view.remove(PERSONAL[0])
    assert.equal(state.calls.filter(call => call.method === 'DELETE')[0].url, '/api/llm-configs/c1')
  } finally {
    await server.close()
  }
})

test('the test of a model records the result and explains a failure', async () => {
  reset()
  const { server, view, connections } = await backendStub()
  try {
    await view.test(PERSONAL[0])
    assert.equal(connections.get('c1').state, 'tested')
    assert.match(log.info.at(-1), /My Groq answered/)
  } finally {
    await server.close()
  }
  const failing = await backendStub({ test: send => send({ detail: 'provider_authentication' }, 502) })
  try {
    await failing.view.test(PERSONAL[0])
    assert.equal(failing.connections.get('c1').state, 'failed')
    assert.match(log.error.at(-1), /refused the credentials/)
  } finally {
    await failing.server.close()
  }
})

test('a paid evaluation sends nothing before consent; accepting queues it; "Not now" declines it', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    const entry = state.evaluations[1]
    ui.warning = () => undefined
    await view.consent(entry)
    assert.equal(posts(state, '/api/evaluations/e-1/consent').length, 0, 'closing the dialog is not a yes')
    assert.match(log.warning[0].message, /never more than 0\.3000 USD/)
    ui.warning = (_m, _o, buttons) => buttons[0]
    await view.consent(entry)
    assert.deepEqual(posts(state, '/api/evaluations/e-1/consent')[0].body, { accept: true, confirm_unknown_price: false })
    ui.warning = (_m, _o, buttons) => buttons[1]
    await view.consent(entry)
    assert.deepEqual(posts(state, '/api/evaluations/e-1/consent')[1].body, { accept: false, confirm_unknown_price: false })
  } finally {
    await server.close()
  }
})

test('an unknown price needs a second confirmation, and refusing it sends nothing', async () => {
  reset()
  const { server, view, state } = await backendStub({ evaluations: [waiting('e-2', UNKNOWN)] })
  try {
    const entry = state.evaluations[0]
    let asked = 0
    ui.warning = (_m, _o, buttons) => (++asked === 1 ? buttons[0] : undefined)
    await view.consent(entry)
    assert.equal(asked, 2)
    assert.equal(posts(state, '/api/evaluations/e-2/consent').length, 0)
    ui.warning = (_m, _o, buttons) => buttons[0]
    await view.consent(entry)
    assert.deepEqual(posts(state, '/api/evaluations/e-2/consent')[0].body, { accept: true, confirm_unknown_price: true })
  } finally {
    await server.close()
  }
})

test('re-evaluate names the configuration and the model; disagree names the capability and says nothing changes', async () => {
  reset()
  const { server, view, state } = await backendStub()
  try {
    await view.reevaluate({ ...state.evaluations[1], configuration_id: 'c1' })
    assert.deepEqual(posts(state, '/api/evaluations/reevaluate')[0].body, { configuration_id: 'c1', model: 'gpt-5.4-mini' })
    ui.quickPick = items => items.find(item => item.label === 'tools')
    await view.disagree(state.evaluations[0])
    assert.deepEqual(posts(state, '/api/evaluations/e-done/disagree')[0].body, { capability: 'tools' })
    assert.match(log.info.at(-1), /The level does not change/)
    await view.reevaluate({ ...state.evaluations[0], configuration_id: null })
    assert.match(log.warning.at(-1).message, /only a model of one of your configurations/)
  } finally {
    await server.close()
  }
})

test('the OpenRouter catalogue is searchable, shows free or price, refuses models that cannot be chosen, and sends nothing to a model', async () => {
  reset()
  const catalogue = [
    { id: 'google/gemma-free', name: 'Gemma', organisation: 'google', context_length: 32000, price_input_per_million: 0, price_output_per_million: 0, free: true, selectable: true },
    { id: 'acme/paid', name: 'Paid', organisation: 'acme', context_length: 128000, price_input_per_million: 1.5, price_output_per_million: 6, free: false, selectable: true },
    { id: 'acme/image-only', name: 'Img', organisation: 'acme', selectable: false, reason: 'it returns images' },
  ]
  const { server, view, state } = await backendStub({ catalogue })
  try {
    let shown
    ui.quickPick = items => ((shown = items), items.find(item => item.label === 'acme/paid'))
    await view.addOpenRouterModel()
    assert.equal(shown.find(item => item.label === 'google/gemma-free').description, 'free')
    assert.equal(shown.find(item => item.label === 'acme/paid').description, '1.50 / 6.00 USD per million tokens')
    assert.match(shown.find(item => item.label === 'acme/image-only').detail, /Cannot be chosen: it returns images/)
    assert.deepEqual(posts(state, '/api/evaluations/models')[0].body, { configuration_id: 'c2', model: 'acme/paid' })
    assert.match(log.info.at(-1), /Nothing was sent to it; a paid model asks for your consent/)
    ui.quickPick = items => items.find(item => item.label === 'acme/image-only')
    await view.addOpenRouterModel()
    assert.equal(posts(state, '/api/evaluations/models').length, 1)
    assert.match(log.warning.at(-1).message, /cannot be chosen: it returns images/)
  } finally {
    await server.close()
  }
})

test('without an OpenRouter configuration the catalogue says to connect it first, and a picked model can be removed', async () => {
  reset()
  const { server, view, state } = await backendStub({ configs: [PERSONAL[0]] })
  try {
    await view.addOpenRouterModel()
    assert.match(log.warning.at(-1).message, /connect OpenRouter first/)
    await view.removeOpenRouterModel({ ...state.evaluations[0], configuration_id: 'c2', model: 'x/y', picked: true })
    await sleep(10)
    assert.ok(state.calls.some(call => call.method === 'DELETE' && call.url === '/api/evaluations/models?configuration_id=c2&model=x%2Fy'))
  } finally {
    await server.close()
  }
})
