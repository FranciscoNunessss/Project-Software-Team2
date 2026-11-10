// Where credentials may go: the backend address policy, URL building, what a webview may send,
// credentials bound to their origin, redirects, cookies, and the streaming idle timeout.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1' }
installVscode(config)
const core = require('../dist/core.js')
const { Backend, ApiError } = require('../dist/backend.js')

const realFetch = globalThis.fetch
const noNetwork = async run => {
  let calls = 0
  globalThis.fetch = () => {
    calls += 1
    throw new Error('NETWORK USED')
  }
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
  return calls
}

// ---- the address policy --------------------------------------------------------------------

test('http is accepted only for this machine; everything else needs https', () => {
  for (const ok of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://LOCALHOST:8000/', 'http://[::1]:8000', 'https://adaptai.example.org', 'https://203.0.113.5:8443/base']) {
    assert.equal(core.checkBackendUrl(ok).ok, true, ok)
  }
  for (const bad of ['http://adaptai.example.org', 'http://203.0.113.5:8000', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example:8000', 'http://0.0.0.0:8000', 'ftp://127.0.0.1', 'file:///etc/passwd', 'javascript:alert(1)', 'nope', '']) {
    assert.equal(core.checkBackendUrl(bad).ok, false, bad)
  }
})

test('an address with a user name, a password, a query or a fragment is refused', () => {
  for (const bad of ['http://user:pw@127.0.0.1:8000', 'https://user@adaptai.example.org', 'http://127.0.0.1:8000/?a=1', 'http://127.0.0.1:8000/#x']) {
    const checked = core.checkBackendUrl(bad)
    assert.equal(checked.ok, false, bad)
  }
})

test('the reason names the host and says why https is needed', () => {
  const checked = core.checkBackendUrl('http://adaptai.example.org')
  assert.match(checked.reason, /adaptai\.example\.org/)
  assert.match(checked.reason, /https/)
})

// ---- building a request URL ----------------------------------------------------------------

test('a request URL is built only from an /api/ path on the same origin', () => {
  assert.equal(core.buildApiUrl('http://127.0.0.1:8000', '/api/health').url, 'http://127.0.0.1:8000/api/health')
  assert.equal(core.buildApiUrl('http://127.0.0.1:8000', '/api/chats?limit=3').url, 'http://127.0.0.1:8000/api/chats?limit=3')
  assert.equal(core.buildApiUrl('https://h.example/base', '/api/x').url, 'https://h.example/base/api/x')
  for (const bad of ['@evil.example/x', '/api@evil.example/x', '//evil.example/api/x', 'http://evil.example/api/x', 'api/x', '/apix', '/api/../admin', '/api//x', '/api/x\\y', '/api/x\r\nHost: evil', '/api/x y', '', '/']) {
    assert.equal(core.buildApiUrl('http://127.0.0.1:8000', bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(core.buildApiUrl('http://adaptai.example.org', '/api/health').ok, false, 'a remote http backend is refused here too')
})

test('a webview may send content headers and plain methods, never credentials, origin or host', () => {
  const safe = core.safeRequest('post', { 'Content-Type': 'application/json', Cookie: 'a=b', Authorization: 'Bearer x', Origin: 'https://evil', Host: 'evil', 'X-Forwarded-For': '1', Referer: 'https://evil', Accept: 'text/event-stream' })
  assert.deepEqual(safe, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' } })
  assert.equal(core.safeRequest('TRACE', {}), undefined)
  assert.equal(core.safeRequest('CONNECT', {}), undefined)
})

// ---- nothing goes to a remote http address -------------------------------------------------

test('email and password are never sent to a remote http backend', async () => {
  config.backendUrl = 'http://adaptai.example.org'
  const backend = new Backend(secretStore())
  let error
  const calls = await noNetwork(async () => {
    error = await backend.signInWithPassword('a@b.c', 'a-long-password-1').catch(e => e)
  })
  assert.equal(calls, 0, 'no request was made')
  assert.ok(error instanceof ApiError && error.status === 0)
  assert.match(error.friendly, /https/)
})

test('a token, a cookie, the status check, a command call and a stream all refuse a remote http backend', async () => {
  config.backendUrl = 'http://adaptai.example.org'
  const secrets = secretStore({ 'adaptai.token': JSON.stringify({ origin: 'http://adaptai.example.org', token: TOKEN }), 'adaptai.session': JSON.stringify({ origin: 'http://adaptai.example.org', cookies: { adaptai_session: 'abc' } }) })
  const backend = new Backend(secrets)
  await backend.load()
  const calls = await noNetwork(async () => {
    assert.match((await backend.signInWithToken(TOKEN).catch(e => e)).friendly, /https/)
    const status = await backend.status()
    assert.equal(status.online, false)
    assert.match(status.problem, /https/)
    assert.match((await backend.api('/api/auth/me').catch(e => e)).friendly, /https/)
    const stream = await (async () => {
      for await (const event of backend.events('/api/chats/x/messages', 'POST', { content: 'secret text' }, AbortSignal.timeout(2000))) return event
    })().catch(e => e)
    assert.match(stream.friendly, /https/)
  })
  assert.equal(calls, 0, 'nothing left the machine')
})

test('a remote https backend is allowed', async () => {
  config.backendUrl = 'https://adaptai.example.org'
  const backend = new Backend(secretStore())
  let url
  globalThis.fetch = async target => {
    url = String(target)
    return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await backend.api('/api/health')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(url, 'https://adaptai.example.org/api/health')
})

// ---- the webview cannot steer a request -------------------------------------------------------

test('a request cannot be steered to another host, and credentials of the caller are never forwarded', async () => {
  const server = await stub((request, response) => json(response, { ok: true }))
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  try {
    for (const path of ['@evil.example/api/x', '/api@evil.example/x', '//evil.example/api/x', '/api/../admin']) {
      const error = await backend.api(path).catch(e => e)
      assert.ok(error instanceof ApiError && error.status === 0, path)
    }
    assert.equal(server.hits.length, 0)
    await backend.call({ path: '/api/llm-options', method: 'GET', headers: { cookie: 'stolen=1', authorization: 'Bearer attacker', origin: 'https://evil.example', host: 'evil.example', 'x-extra': '1' }, body: null }, AbortSignal.timeout(3000))
    const hit = server.hits.at(-1)
    assert.equal(hit.headers.authorization, `Bearer ${TOKEN}`, 'only the stored token is used')
    assert.equal(hit.headers.cookie, undefined)
    assert.equal(hit.headers.origin, undefined)
    assert.equal(hit.headers['x-extra'], undefined)
    assert.notEqual(hit.headers.host, 'evil.example')
  } finally {
    await server.close()
  }
})

// ---- credentials belong to the backend that issued them -----------------------------------------

test('stored credentials are never sent to a different backend address', async () => {
  const a = await stub((request, response) => json(response, { email: 'a@example.com' }))
  const b = await stub((request, response) => json(response, { email: 'b@example.com' }))
  try {
    config.backendUrl = a.url
    const secrets = secretStore({ 'adaptai.token': JSON.stringify({ origin: a.url, token: TOKEN }) })
    const backend = new Backend(secrets)
    await backend.load()
    assert.equal(backend.auth, 'token')
    await backend.api('/api/auth/me')
    assert.equal(a.hits.at(-1).headers.authorization, `Bearer ${TOKEN}`)

    config.backendUrl = b.url // the user changed the setting
    assert.equal(backend.auth, 'none')
    assert.equal(backend.foreignOrigin, a.url)
    await backend.api('/api/auth/me')
    assert.equal(b.hits.at(-1).headers.authorization, undefined, 'the token of A did not go to B')
    const status = await backend.status()
    assert.equal(status.foreign, a.url)
    assert.equal(status.email, null)
  } finally {
    await a.close()
    await b.close()
  }
})

test('a token saved by version 0.2.0 (no origin) is bound to the address in use', async () => {
  const a = await stub((request, response) => json(response, { email: 'a@example.com' }))
  try {
    config.backendUrl = a.url
    const secrets = secretStore({ 'adaptai.token': TOKEN })
    const backend = new Backend(secrets)
    await backend.load()
    assert.equal(backend.auth, 'token')
    assert.deepEqual(JSON.parse(secrets.data.get('adaptai.token')), { origin: a.url, token: TOKEN })
  } finally {
    await a.close()
  }
})

test('signing in to a new backend drops the credentials of the old one', async () => {
  const a = await stub((request, response) => json(response, { email: 'a@example.com' }))
  const b = await stub((request, response) => {
    if (request.url === '/api/auth/login') return json(response, { id: '1', email: 'b@example.com' })
    if (request.url === '/api/tokens') return json(response, { token: 'adaptai_pat_' + 'n'.repeat(43), id: 't' }, 201)
    json(response, {}, 404)
  })
  try {
    config.backendUrl = a.url
    const secrets = secretStore({ 'adaptai.token': JSON.stringify({ origin: a.url, token: TOKEN }) })
    const backend = new Backend(secrets)
    await backend.load()
    config.backendUrl = b.url
    const result = await backend.signInWithPassword('b@example.com', 'a-long-password-1')
    assert.equal(result.auth, 'token')
    const stored = JSON.parse(secrets.data.get('adaptai.token'))
    assert.equal(stored.origin, b.url)
    assert.notEqual(stored.token, TOKEN)
    assert.equal(b.hits.every(hit => hit.headers.authorization !== `Bearer ${TOKEN}`), true)
  } finally {
    await a.close()
    await b.close()
  }
})

// ---- tokens: refused, revoked ------------------------------------------------------------------

test('a refused token is not stored, and a stored token that stops working is reported as rejected', async () => {
  let accept = false
  const server = await stub((request, response) => {
    if (request.url === '/api/health') return json(response, { status: 'ok' })
    if (request.headers.authorization === `Bearer ${TOKEN}` && accept) return json(response, { email: 'a@example.com' })
    json(response, { detail: 'authentication_required' }, 401)
  })
  try {
    config.backendUrl = server.url
    const secrets = secretStore()
    const backend = new Backend(secrets)
    await backend.load()
    const refused = await backend.signInWithToken(TOKEN).catch(e => e)
    assert.ok(refused instanceof ApiError && refused.status === 401)
    assert.equal(secrets.data.has('adaptai.token'), false, 'nothing stored')
    assert.equal(backend.auth, 'none')

    accept = true
    assert.equal(await backend.signInWithToken(TOKEN), 'a@example.com')
    accept = false // revoked meanwhile
    const status = await backend.status()
    assert.equal(status.online, true)
    assert.equal(status.rejected, true)
    assert.equal(status.email, null)
    assert.match((await backend.api('/api/auth/me').catch(e => e)).friendly, /signed out|revoked|expired/)
  } finally {
    await server.close()
  }
})

// ---- cookies ------------------------------------------------------------------------------------

test('a cookie fallback is kept per origin and sent only there', async () => {
  const a = await stub((request, response) => {
    if (request.url === '/api/auth/login') return json(response, { id: '1', email: 'a@example.com' }, 200, { 'set-cookie': 'adaptai_session=abc123; HttpOnly; Path=/api' })
    if (request.url === '/api/tokens') return json(response, { detail: 'not_found' }, 404) // a backend without API tokens
    json(response, { email: 'a@example.com' })
  })
  const b = await stub((request, response) => json(response, { email: 'b@example.com' }))
  try {
    config.backendUrl = a.url
    const secrets = secretStore()
    const backend = new Backend(secrets)
    await backend.load()
    const result = await backend.signInWithPassword('a@example.com', 'a-long-password-1')
    assert.equal(result.auth, 'cookie')
    assert.equal(JSON.parse(secrets.data.get('adaptai.session')).origin, a.url)
    await backend.api('/api/auth/me')
    assert.equal(a.hits.at(-1).headers.cookie, 'adaptai_session=abc123')
    config.backendUrl = b.url
    await backend.api('/api/auth/me')
    assert.equal(b.hits.at(-1).headers.cookie, undefined, 'the cookie of A did not go to B')
  } finally {
    await a.close()
    await b.close()
  }
})

// ---- redirects ----------------------------------------------------------------------------------

test('a redirect is never followed, so credentials cannot be forwarded to another host', async () => {
  const elsewhere = await stub((request, response) => json(response, { reached: true }))
  const server = await stub((request, response) => {
    response.writeHead(302, { location: `${elsewhere.url}/api/steal` })
    response.end()
  })
  try {
    config.backendUrl = server.url
    const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
    await backend.load()
    const error = await backend.api('/api/auth/me').catch(e => e)
    assert.ok(error instanceof ApiError && error.status === 0)
    assert.match(error.friendly, /redirect/)
    const stream = await (async () => {
      for await (const event of backend.events('/api/chats/x/messages', 'POST', {}, AbortSignal.timeout(3000))) return event
    })().catch(e => e)
    assert.match(stream.friendly, /redirect/)
    const login = await backend.signInWithPassword('a@example.com', 'a-long-password-1').catch(e => e)
    assert.match(login.friendly, /redirect/)
    assert.equal(elsewhere.hits.length, 0, 'the other host was never contacted')
  } finally {
    await server.close()
    await elsewhere.close()
  }
})

// ---- streaming ----------------------------------------------------------------------------------

test('a stream that goes silent fails with a TimeoutError, and its connection is closed', async () => {
  let closed
  const upstreamClosed = new Promise(resolve => (closed = resolve))
  const server = await stub((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: delta\ndata: {"text":"hello"}\n\n')
    response.on('close', () => closed(true))
  })
  try {
    config.backendUrl = server.url
    const backend = new Backend(secretStore())
    backend.idleMs = 250
    const seen = []
    const error = await (async () => {
      for await (const event of backend.events('/api/chats/x/messages', 'POST', {}, AbortSignal.timeout(5000))) seen.push(event)
    })().catch(e => e)
    assert.equal(seen.length, 1)
    assert.equal(error.name, 'TimeoutError')
    assert.equal(await upstreamClosed, true)
  } finally {
    await server.close()
  }
})

test('the user pressing Stop ends the stream with an AbortError and closes the request', async () => {
  let closed
  const upstreamClosed = new Promise(resolve => (closed = resolve))
  const server = await stub((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: delta\ndata: {"text":"one"}\n\n')
    response.on('close', () => closed(true))
  })
  try {
    config.backendUrl = server.url
    const backend = new Backend(secretStore())
    const controller = new AbortController()
    const seen = []
    const error = await (async () => {
      for await (const event of backend.events('/api/chats/x/messages', 'POST', {}, controller.signal)) {
        seen.push(event)
        controller.abort()
      }
    })().catch(e => e)
    assert.equal(seen.length, 1)
    assert.equal(error.name, 'AbortError')
    assert.equal(await upstreamClosed, true)
  } finally {
    await server.close()
  }
})
