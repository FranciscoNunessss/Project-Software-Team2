// The relay agent (ADR-015): your own LM Studio, run for a backend that cannot reach your machine.
// A stub backend hands it requests; a stub LM Studio answers them. Nothing leaves this machine.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1' }
installVscode(config)
const { Backend } = require('../dist/backend.js')
const { RelayAgent, lmStudioAddress, RELAY_PATH } = require('../dist/relay.js')

const UUID = '11111111-2222-3333-4444-555555555555'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(15)
  }
  assert.fail('timed out waiting')
}
const chatRequest = { model: 'local', stream: true, messages: [{ role: 'user', content: 'Hello' }] }
const job = (extra = {}) => ({ id: UUID, method: 'POST', path: RELAY_PATH, content_type: 'application/json', body: Buffer.from(JSON.stringify(chatRequest)).toString('base64'), ...extra })

/** A backend with the relay routes: it hands out `jobs` one by one and records what the client sends back. */
async function backendStub({ jobs = [], configs = [{ enabled: true, execution: 'client' }], next, events } = {}) {
  const state = { posted: [], acks: 0, polls: 0, queue: [...jobs] }
  const server = await stub((request, response, body) => {
    if (request.url === '/api/llm-configs') return json(response, configs)
    if (request.url.startsWith('/api/relay/next')) {
      state.polls += 1
      if (next) return next(response, state)
      const item = state.queue.shift()
      if (item) return json(response, item)
      return void setTimeout(() => (response.writeHead(204), response.end()), 40)
    }
    const match = request.url.match(/^\/api\/relay\/jobs\/([^/]+)\/events$/)
    if (match) {
      const parsed = JSON.parse(body)
      state.acks += parsed.events.filter(event => event.type === 'ack').length
      state.posted.push(...parsed.events.filter(event => event.type !== 'ack'))
      if (events) return events(response)
      return json(response, { status: 'ok' })
    }
    json(response, { detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  return { server, backend, state }
}

/** An LM Studio that answers a chat request as a stream of two pieces, or as the test says. */
async function lmStudioStub(answer) {
  const seen = []
  const server = await stub((request, response, body, hit) => {
    seen.push(hit)
    if (answer) return answer(request, response, body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n')
    setTimeout(() => {
      response.write('data: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: [DONE]\n\n')
      response.end()
    }, 30)
  })
  config['relay.lmStudioUrl'] = server.url
  return { server, seen }
}

const agentFor = backend => {
  const agent = new RelayAgent(backend)
  agent.pollSeconds = 1
  agent.retryMs = 30
  agent.minGapMs = 0
  return agent
}
const text = events => events.filter(event => event.type === 'chunk').map(event => Buffer.from(event.data, 'base64').toString()).join('')

test('the LM Studio address must be this computer, and plain', () => {
  assert.equal(lmStudioAddress('http://127.0.0.1:1234').ok, true)
  assert.equal(lmStudioAddress('http://localhost:1234').url, 'http://localhost:1234/v1/chat/completions')
  assert.equal(lmStudioAddress('http://[::1]:1234').ok, true)
  for (const bad of ['https://127.0.0.1:1234', 'http://192.168.1.50:1234', 'http://example.com', 'http://127.0.0.1.evil.com', 'http://user:pw@127.0.0.1:1234', 'http://127.0.0.1:1234/?a=1', 'not a url', '']) {
    assert.equal(lmStudioAddress(bad).ok, false, bad)
  }
})

test('a request from the backend is run on LM Studio and the answer goes back, as it streams', async () => {
  const lm = await lmStudioStub()
  const { server, backend, state } = await backendStub({ jobs: [job()] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.some(event => event.type === 'end'))
    assert.equal(lm.seen.length, 1)
    assert.ok(state.acks >= 1, 'the backend is told at once that this client has the request')
    assert.equal(lm.seen[0].url, RELAY_PATH)
    assert.deepEqual(JSON.parse(lm.seen[0].body), chatRequest)
    assert.equal(lm.seen[0].headers.authorization, undefined, 'the token never reaches LM Studio')
    assert.equal(state.posted[0].type, 'start')
    assert.equal(state.posted[0].status, 200)
    assert.match(state.posted[0].content_type, /event-stream/)
    assert.equal(text(state.posted), 'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: [DONE]\n\n')
    assert.equal(state.posted.at(-1).type, 'end')
    await until(() => agent.state.state === 'connected')
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('without a model set to run on this computer the agent does not connect to the relay at all', async () => {
  const { server, backend, state } = await backendStub({ configs: [{ enabled: true, execution: 'server' }, { enabled: false, execution: 'client' }] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await sleep(150)
    assert.equal(state.polls, 0)
    assert.equal(agent.state.state, 'off')
  } finally {
    agent.dispose()
    await server.close()
  }
})

test('only a chat completion is run: another path or method is refused and LM Studio is not called', async () => {
  const lm = await lmStudioStub()
  const { server, backend, state } = await backendStub({ jobs: [job({ path: '/v1/models' }), job({ id: '11111111-2222-3333-4444-555555555556', method: 'GET' })] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.filter(event => event.type === 'error').length === 2)
    assert.deepEqual(state.posted.map(event => event.code), ['relay_path_not_allowed', 'relay_path_not_allowed'])
    assert.equal(lm.seen.length, 0)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('a job id that is not an id is ignored, and an oversized or empty body is refused', async () => {
  const lm = await lmStudioStub()
  const big = Buffer.alloc(1_000_001, 97).toString('base64')
  const { server, backend, state } = await backendStub({ jobs: [job({ id: '../../x' }), job({ body: big }), job({ id: '11111111-2222-3333-4444-555555555557', body: '' })] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.filter(event => event.type === 'error').length === 2)
    assert.deepEqual(state.posted.map(event => event.code), ['relay_request_too_large', 'relay_request_too_large'])
    assert.equal(lm.seen.length, 0)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('an LM Studio address that is not this computer is never called', async () => {
  const lm = await lmStudioStub()
  config['relay.lmStudioUrl'] = 'http://192.168.1.50:1234'
  const { server, backend, state } = await backendStub({ jobs: [job()] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.some(event => event.type === 'error'))
    assert.equal(state.posted[0].code, 'relay_client_error')
    assert.equal(lm.seen.length, 0)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('LM Studio not running is told to the backend as such', async () => {
  const lm = await lmStudioStub()
  await lm.server.close()
  const { server, backend, state } = await backendStub({ jobs: [job()] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.some(event => event.type === 'error'))
    assert.equal(state.posted[0].code, 'relay_lm_studio_unreachable')
  } finally {
    agent.dispose()
    await server.close()
  }
})

test('an error status from LM Studio goes back as it is, with its body', async () => {
  const lm = await lmStudioStub((_request, response) => json(response, { error: { message: 'no model loaded' } }, 404))
  const { server, backend, state } = await backendStub({ jobs: [job()] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.some(event => event.type === 'end'))
    assert.equal(state.posted[0].status, 404)
    assert.match(text(state.posted), /no model loaded/)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('a large answer is sent in slices the backend accepts', async () => {
  const lm = await lmStudioStub((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('x'.repeat(500_000))
  })
  const { server, backend, state } = await backendStub({ jobs: [job()] })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => state.posted.some(event => event.type === 'end'))
    const chunks = state.posted.filter(event => event.type === 'chunk')
    assert.ok(chunks.length >= 3)
    assert.ok(chunks.every(event => Buffer.from(event.data, 'base64').length <= 192_000))
    assert.equal(text(state.posted).length, 500_000)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('when the backend no longer knows the job, LM Studio is told to stop', async () => {
  let closed = false
  const lm = await lmStudioStub((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const timer = setInterval(() => response.write('data: {"choices":[{"delta":{"content":"."}}]}\n\n'), 20)
    request.on('close', () => ((closed = true), clearInterval(timer)))
    response.on('close', () => ((closed = true), clearInterval(timer)))
  })
  const { server, backend } = await backendStub({ jobs: [job()], events: response => json(response, { detail: 'relay_job_not_found' }, 404) })
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => closed, 6000)
  } finally {
    agent.dispose()
    await server.close()
    await lm.server.close()
  }
})

test('a refused sign-in or a backend without a relay stops the agent and says why', async () => {
  const refused = await backendStub({ next: response => json(response, { detail: 'authentication_required' }, 401) })
  const agent = agentFor(refused.backend)
  try {
    await agent.refresh()
    await until(() => agent.state.state === 'error')
    assert.match(agent.state.text, /Sign in again/)
    const polls = refused.state.polls
    await sleep(120)
    assert.equal(refused.state.polls, polls, 'it stopped asking')
  } finally {
    agent.dispose()
    await refused.server.close()
  }
  const old = await backendStub({ next: response => json(response, { detail: 'not_found' }, 404) })
  const agent2 = agentFor(old.backend)
  try {
    await agent2.refresh()
    await until(() => agent2.state.state === 'error')
    assert.match(agent2.state.text, /no relay yet/)
  } finally {
    agent2.dispose()
    await old.server.close()
  }
})

test('the agent stops when the models no longer ask for it, and when it is signed out', async () => {
  const { server, backend, state } = await backendStub()
  const agent = agentFor(backend)
  try {
    await agent.refresh()
    await until(() => agent.state.state === 'connected')
    const configs = state
    assert.ok(configs.polls >= 1)
    await backend.signOut()
    await agent.refresh()
    assert.equal(agent.state.state, 'off')
  } finally {
    agent.dispose()
    await server.close()
  }
})

test('the first request returns at once, the next ones wait for work, and stopping ends the open one', async () => {
  let held
  // a backend that answers the first request at once and then holds the next ones open
  const seen = []
  let closed = false
  const holder = await stub((request, response, body) => {
    if (request.url === '/api/llm-configs') return json(response, [{ enabled: true, execution: 'client' }])
    if (request.url.startsWith('/api/relay/next')) {
      seen.push(request.url)
      if (request.url.endsWith('wait=0')) return void (response.writeHead(204), response.end())
      held = response
      request.on('close', () => (closed = true))
      return
    }
    json(response, { detail: 'not_found' }, 404)
  })
  config.backendUrl = holder.url
  const own = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: holder.url, token: TOKEN }) }))
  await own.load()
  const agent = agentFor(own)
  agent.pollSeconds = 10
  try {
    await agent.refresh()
    await until(() => held !== undefined)
    assert.match(seen[0], /wait=0$/)
    assert.match(seen[1], /wait=10$/)
    assert.equal(agent.state.state, 'connected')
    agent.stop()
    await until(() => closed)
  } finally {
    agent.dispose()
    await holder.close()
  }
})
