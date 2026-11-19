const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json } = require('./helpers')
const config = { backendUrl: 'http://127.0.0.1:1' }
installVscode(config)
const { startDiagnostics, stopDiagnostics, diagnosticSamples, beginTiming } = require('../dist/diagnostics')
const { Backend } = require('../dist/backend')
const { Dashboard } = require('../dist/dashboard')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('capture is opt-in, bounded, resets between sessions and cannot affect a request when the logger fails', () => {
  stopDiagnostics()
  const before = diagnosticSamples().length
  beginTiming('api', '/api/health')()
  assert.equal(diagnosticSamples().length, before)
  startDiagnostics(() => { throw new Error('logging failed') })
  const old = beginTiming('api', '/api/health')
  startDiagnostics()
  old()
  assert.deepEqual(diagnosticSamples(), [])
  for (let i = 0; i < 1005; i++) beginTiming('api', '/api/health')()
  assert.equal(diagnosticSamples().length, 1000)
  const copy = diagnosticSamples()
  copy[0].route = 'changed'
  assert.equal(diagnosticSamples()[0].route, '/api/health')
  startDiagnostics(() => { throw new Error('logging failed') })
  assert.doesNotThrow(() => beginTiming('api', '/api/health')())
  const pending = beginTiming('api', '/api/health')
  stopDiagnostics()
  pending()
  assert.equal(diagnosticSamples().length, 1)
})

test('routes drop identifiers and queries; no request data or error contents enter the report', async () => {
  startDiagnostics()
  const routes = ['/api/chats/private-account/messages/private-answer/retry?secret=private-query', '/api/sessions/private-session', '/unrecognised-private-value', '/api/progress?limit=20']
  for (const route of routes) beginTiming('api', route)('error', 401)
  assert.deepEqual(diagnosticSamples().map(s => s.route), ['/api/chats/:id/messages', '/api/sessions/:id', 'other', '/api/progress'])
  assert.doesNotMatch(JSON.stringify(diagnosticSamples()), /private-/)
})

test('API timing includes response body, preserves values and HTTP failures, and marks aborts', async () => {
  const server = await stub((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"ok":')
    setTimeout(() => response.end('true}'), 30)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore())
  startDiagnostics()
  try {
    assert.deepEqual(await backend.api('/api/features'), { ok: true })
    assert.equal(diagnosticSamples()[0].status, 200)
    assert.ok(diagnosticSamples()[0].ms >= 25, 'timing includes delayed body consumption')
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(() => backend.api('/api/features', 'GET', undefined, abort.signal))
    assert.equal(diagnosticSamples().at(-1).outcome, 'cancelled')
  } finally { await server.close() }
  const failed = await stub((_req, response) => json(response, { detail: 'private-error' }, 503))
  config.backendUrl = failed.url
  try {
    await assert.rejects(() => backend.api('/api/features'), e => e.status === 503)
    assert.equal(diagnosticSamples().at(-1).status, 503)
    assert.equal(diagnosticSamples().at(-1).outcome, 'error')
    assert.doesNotMatch(JSON.stringify(diagnosticSamples()), /private-error/)
  } finally { await failed.close(); stopDiagnostics() }
})

test('firstText measures the first non-empty delta, not SSE metadata; stream completion remains separate', async () => {
  const server = await stub((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: message\ndata: {"answer_id":"private-id"}\n\n')
    response.write('event: delta\ndata: {"text":""}\n\n')
    setTimeout(() => response.write('event: delta\ndata: {"text":"private-content"}\n\n'), 25)
    setTimeout(() => response.end('event: done\ndata: {}\n\n'), 65)
  })
  config.backendUrl = server.url
  startDiagnostics()
  try {
    const events = []
    for await (const item of new Backend(secretStore()).events('/api/chats/private-id/messages', 'POST', {}, new AbortController().signal)) events.push(item)
    assert.equal(events.length, 4)
    const samples = diagnosticSamples()
    assert.deepEqual(samples.map(s => s.phase), ['firstText', 'stream'])
    assert.ok(samples[0].ms >= 20)
    assert.ok(samples[1].ms > samples[0].ms)
    assert.equal(samples[1].status, 200)
    assert.doesNotMatch(JSON.stringify(samples), /private-/)
  } finally { await server.close(); stopDiagnostics() }
})

test('an SSE error is recorded as a failure without inventing a first text', async () => {
  const server = await stub((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('event: error\ndata: {"code":"private-error"}\n\n')
  })
  config.backendUrl = server.url
  startDiagnostics()
  try {
    for await (const _item of new Backend(secretStore()).events('/api/chats/private-id/messages', 'POST', {}, new AbortController().signal)) { /* drain */ }
    assert.equal(diagnosticSamples().length, 1)
    assert.equal(diagnosticSamples()[0].phase, 'stream')
    assert.equal(diagnosticSamples()[0].outcome, 'error')
  } finally { await server.close(); stopDiagnostics() }
})

test('reload timing covers all data loading and preserves the page failure message', async () => {
  const posted = []
  const backend = { auth: 'token', onDidChangeSession: () => ({}), status: async () => ({ email: null }), api: async () => { await delay(20); throw new Error('backend unavailable') } }
  const dashboard = new Dashboard(backend, { onDidAnalyse: () => ({}), results: new Map() }, {}, {})
  dashboard.view = { webview: { postMessage: message => posted.push(message) } }
  startDiagnostics()
  await dashboard.reload()
  assert.ok(posted.at(-1).failed)
  assert.equal(diagnosticSamples()[0].phase, 'reload')
  assert.equal(diagnosticSamples()[0].outcome, 'error')
  assert.ok(diagnosticSamples()[0].ms >= 15)
  stopDiagnostics()
})
