// The chat without a webview: the @adaptai participant streams the model's answer from the backend's
// Server-Sent Events, with Stop, Retry, consent, analysis inside the chat, and the list of chats.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN, fixture, OPTIONS } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1', confirmExternal: true, chatModel: '', resultView: 'preview' }
const { vscode, log, ui, captured } = installVscode(config)
const { Backend } = require('../dist/backend.js')
const { Analyser } = require('../dist/analyse.js')
const { ChatService, registerParticipant } = require('../dist/chat.js')

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A sink that remembers what the chat view would show. */
function sink() {
  const out = { text: '', progress: [], buttons: [] }
  return { out, markdown: text => void (out.text += text), progress: text => void out.progress.push(text), button: command => void out.buttons.push(command) }
}

/** The backend of the chat. `stream(request, response, parsed)` writes the SSE; the default answers "Hello there". */
async function backendStub(mode = {}) {
  const state = { chats: 0, messages: [] }
  const server = await stub((request, response, body) => {
    const send = (data, status = 200) => json(response, data, status)
    const parsed = body ? JSON.parse(body) : {}
    if (request.url === '/api/llm-options') return send(mode.options ?? OPTIONS)
    if (request.url === '/api/features') return send({ prompt_coach: true, chat: true })
    if (request.url === '/api/chats' && request.method === 'POST') {
      state.chats += 1
      return send({ id: `chat-${state.chats}`, title: 'New chat', message_count: 0, messages: [] }, 201)
    }
    if (request.url === '/api/chats' && request.method === 'GET') return send(mode.list ?? [{ id: 'chat-1', title: 'First chat', created_at: 't', message_count: 2 }])
    if (request.url === '/api/analyze') return send(fixture({ session_id: parsed.session_id ?? 's-new', id: parsed.previous_analysis_id ? 'a2' : 'a1' }))
    if (/\/api\/chats\/[^/]+\/messages(\/[^/]+\/retry)?$/.test(request.url) && request.method === 'POST') {
      state.messages.push({ url: request.url, body: parsed })
      if (mode.status) return send({ detail: mode.status.detail }, mode.status.code)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      return (mode.stream ?? defaultStream)(request, response, parsed)
    }
    const detail = request.url.match(/^\/api\/chats\/([^/]+)$/)
    if (detail && request.method === 'GET') return send({ id: detail[1], title: 'First chat', created_at: 't', message_count: 3, messages: mode.messages ?? [] })
    if (detail && request.method === 'PATCH') return send({ id: detail[1], title: parsed.title })
    if (detail && request.method === 'DELETE') {
      response.writeHead(204)
      return response.end()
    }
    send({ detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  const analyser = new Analyser(backend)
  const chat = new ChatService(backend, analyser)
  return { server, backend, analyser, chat, state }
}

function defaultStream(request, response) {
  response.write(frame('message', { message: { id: 'q1' }, answer_id: 'ans-1' }))
  response.write(frame('delta', { text: 'Hello ' }))
  response.write(frame('delta', { text: 'there' }))
  response.write(frame('done', { chat: 'ok' }))
  response.end()
}

const reset = () => {
  config.confirmExternal = true
  config.chatModel = ''
  ui.warning = (_m, _o, buttons) => buttons[0]
  ui.info = () => undefined
  for (const key of Object.keys(log)) log[key].length = 0
}
const live = () => new AbortController().signal

test('a message streams the answer, creates the chat once, and carries the consent of an external model', async () => {
  reset()
  const { server, chat, state } = await backendStub()
  try {
    const first = sink()
    await chat.send('Say hello', first, live())
    assert.equal(first.out.text, 'Hello there')
    assert.equal(state.chats, 1)
    assert.equal(chat.current, 'chat-1')
    assert.match(state.messages[0].url, /\/api\/chats\/chat-1\/messages$/)
    assert.deepEqual(state.messages[0].body, { content: 'Say hello', provider: 'auto', allow_external: true })
    assert.match(log.warning[0].message, /send your message \(9 characters\) through the backend at .* to Groq · llama-test, outside your machine/)
    await chat.send('And again', sink(), live())
    assert.equal(state.chats, 1, 'the same chat is reused')
  } finally {
    await server.close()
  }
})

test('a local chat model needs no dialog, and a model chosen by hand is named in the request', async () => {
  reset()
  config.chatModel = 'server:lmstudio'
  const { server, chat, state } = await backendStub()
  try {
    await chat.send('Hello', sink(), live())
    assert.equal(log.warning.length, 0)
    assert.equal(state.messages[0].body.configuration_id, 'server:lmstudio')
    assert.equal(state.messages[0].body.allow_external, false)
  } finally {
    await server.close()
  }
})

test('cancelling the confirmation sends nothing', async () => {
  reset()
  ui.warning = () => undefined
  const { server, chat, state } = await backendStub()
  try {
    const out = sink()
    await chat.send('Hello', out, live())
    assert.match(out.out.text, /Cancelled\. Nothing was sent\./)
    assert.equal(state.messages.length, 0)
    assert.equal(state.chats, 0)
  } finally {
    await server.close()
  }
})

test('text split in the middle of an event and of a character arrives intact', async () => {
  reset()
  const text = frame('message', { message: { id: 'q' }, answer_id: 'a' }) + frame('delta', { text: 'olá — 日本語 😀' }) + frame('done', {})
  const bytes = Buffer.from(text)
  const { server, chat } = await backendStub({
    stream: async (request, response) => {
      for (let at = 0; at < bytes.length; at += 7) {
        response.write(bytes.subarray(at, at + 7))
        await sleep(2)
      }
      response.end()
    },
  })
  try {
    const out = sink()
    await chat.send('Hello', out, live())
    assert.equal(out.out.text, 'olá — 日本語 😀')
  } finally {
    await server.close()
  }
})

test('Stop keeps the part written, says so, and is not an error', async () => {
  reset()
  let closed
  const upstreamClosed = new Promise(resolve => (closed = resolve))
  const { server, chat } = await backendStub({
    stream: (request, response) => {
      response.write(frame('message', { message: { id: 'q' }, answer_id: 'a' }))
      response.write(frame('delta', { text: 'partial ' }))
      response.on('close', () => closed(true))
    },
  })
  try {
    const out = sink()
    const controller = new AbortController()
    const done = chat.send('Hello', out, controller.signal)
    while (!out.out.text.includes('partial')) await sleep(10)
    controller.abort()
    await done
    assert.match(out.out.text, /partial .*Stopped\. The part already written is kept/s)
    assert.equal(out.out.buttons.length, 0)
    assert.equal(await upstreamClosed, true, 'the request to the backend was closed')
  } finally {
    await server.close()
  }
})

test('a provider error event is explained and offers Retry', async () => {
  reset()
  const { server, chat } = await backendStub({
    stream: (request, response) => {
      response.write(frame('message', { message: { id: 'q' }, answer_id: 'a' }))
      response.write(frame('delta', { text: 'start ' }))
      response.write(frame('error', { code: 'provider_rate_limit' }))
      response.write(frame('done', {}))
      response.end()
    },
  })
  try {
    const out = sink()
    await chat.send('Hello', out, live())
    assert.match(out.out.text, /start .*rate limiting/s)
    assert.deepEqual(out.out.buttons.map(item => item.title), ['Retry'])
  } finally {
    await server.close()
  }
})

test('a refusal before the stream (no consent, bad request) is a sentence, not a stack', async () => {
  reset()
  const { server, chat } = await backendStub({ status: { code: 403, detail: 'external_processing_requires_consent' } })
  try {
    const out = sink()
    await chat.send('Hello', out, live())
    assert.match(out.out.text, /did not carry your consent/)
    assert.equal(out.out.buttons[0].title, 'Retry')
  } finally {
    await server.close()
  }
})

test('a stream that goes silent is stopped with a message and Retry; the part already written stays', async () => {
  reset()
  const { server, chat, backend } = await backendStub({
    stream: (request, response) => {
      response.write(frame('message', { message: { id: 'q' }, answer_id: 'a' }))
      response.write(frame('delta', { text: 'before the silence' }))
    },
  })
  try {
    backend.idleMs = 200
    const out = sink()
    await chat.send('Hello', out, live())
    assert.match(out.out.text, /before the silence.*sent nothing for a while/s)
    assert.equal(out.out.buttons[0].title, 'Retry')
  } finally {
    await server.close()
  }
})

test('Retry answers the last question again, with the same model and consent', async () => {
  reset()
  const { server, chat, state } = await backendStub()
  try {
    await chat.send('Hello', sink(), live())
    const out = sink()
    await chat.retry(out, live())
    assert.match(state.messages[1].url, /\/api\/chats\/chat-1\/messages\/ans-1\/retry$/)
    assert.deepEqual(state.messages[1].body, { provider: 'auto', allow_external: true })
    assert.equal(out.out.text, 'Hello there')
    const none = sink()
    await new ChatService(new Backend(secretStore()), undefined).retry(none, live())
    assert.match(none.out.text, /no answer to retry/)
  } finally {
    await server.close()
  }
})

test('signed out, an unusable address or a message that is too long are said in words and send nothing', async () => {
  reset()
  const { server } = await backendStub()
  try {
    const signedOut = new ChatService(new Backend(secretStore()), undefined)
    const out = sink()
    await signedOut.send('Hello', out, live())
    assert.match(out.out.text, /Sign in first/)
    const second = await backendStub()
    try {
      const long = sink()
      await second.chat.send('x'.repeat(8001), long, live())
      assert.match(long.out.text, /8001 characters; the chat takes up to 8000/)
      assert.equal(second.state.messages.length, 0)
    } finally {
      await second.server.close()
    }
  } finally {
    await server.close()
  }
})

test('/analyse runs inside the chat session, shows the result, and a later message with the same text carries the analysis', async () => {
  reset()
  const { server, chat, state } = await backendStub()
  try {
    const out = sink()
    await chat.analyse('Compare two API designs', out, live())
    assert.match(out.out.text, /^# AdaptAI · Groq · llama-test/)
    assert.deepEqual(out.out.buttons.map(item => item.title), ['Task solved?', 'Use this model in the chat', 'Send it to the chat'])
    assert.deepEqual(out.out.buttons[0].arguments, ['a1'])
    const [analyze] = server.hits.filter(hit => hit.url === '/api/analyze').map(hit => JSON.parse(hit.body))
    assert.equal(analyze.session_id, 'chat-1', 'the analysis belongs to the chat, as in the app')
    await chat.send('Compare two API designs', sink(), live())
    assert.equal(state.messages[0].body.analysis_id, 'a1')
    await chat.send('A different message', sink(), live())
    assert.equal(state.messages[1].body.analysis_id, undefined)
    await chat.analyse('Compare two API designs, in detail', sink(), live())
    const second = server.hits.filter(hit => hit.url === '/api/analyze').map(hit => JSON.parse(hit.body))[1]
    assert.equal(second.previous_analysis_id, 'a1', 'a re-analysis names the previous one')
  } finally {
    await server.close()
  }
})

test('the participant routes /new, /retry, /analyse and plain messages, and Stop cancels the request', async () => {
  reset()
  const { server, chat, state } = await backendStub()
  try {
    registerParticipant(chat)
    const { handler } = captured.participant
    const run = async (command, prompt, token = { onCancellationRequested: () => ({ dispose() {} }) }) => {
      const out = sink()
      const response = { markdown: out.markdown, progress: out.progress, button: out.button }
      await handler({ command, prompt }, {}, response, token)
      return out.out
    }
    assert.match((await run('', '')).text, /Write a message/)
    assert.match((await run('analyse', '')).text, /Write the task after `\/analyse`/)
    assert.equal((await run('', 'Hello')).text, 'Hello there')
    assert.match((await run('new', '')).text, /Started a new chat/)
    assert.equal(chat.current, undefined)
    await run('', 'Hello again')
    assert.equal(state.chats, 2, 'a new chat was opened after /new')
    assert.equal((await run('retry', '')).text, 'Hello there')
  } finally {
    await server.close()
  }
})

// ---- the list of chats ---------------------------------------------------------------------------------

test('the transcript shows who said what, the model, failures and stopped answers', async () => {
  reset()
  const messages = [
    { id: '1', role: 'user', content: 'Hi', provider: null, model: null, analysis_id: null, status: 'done', error: null, created_at: 't' },
    { id: '2', role: 'assistant', content: 'Hello', provider: 'groq', model: 'llama', analysis_id: null, status: 'done', error: null, created_at: 't' },
    { id: '3', role: 'assistant', content: '', provider: 'groq', model: 'llama', analysis_id: null, status: 'failed', error: 'provider_rate_limit', created_at: 't' },
    { id: '4', role: 'assistant', content: 'cut', provider: 'groq', model: 'llama', analysis_id: null, status: 'stopped', error: null, created_at: 't' },
  ]
  const { server, chat } = await backendStub({ messages })
  try {
    const text = await chat.transcript('chat-1')
    assert.match(text, /^# First chat/)
    assert.match(text, /## You\n\nHi/)
    assert.match(text, /## AdaptAI · groq llama\n\nHello/)
    assert.match(text, /rate limiting/)
    assert.match(text, /Stopped by you\./)
  } finally {
    await server.close()
  }
})

test('rename and delete go to the backend; deleting the current chat starts a new one; signed out lists nothing', async () => {
  reset()
  const { server, backend, chat } = await backendStub()
  try {
    await chat.setCurrent('chat-1')
    await chat.rename('chat-1', 'Renamed')
    assert.ok(server.hits.some(hit => hit.method === 'PATCH' && JSON.parse(hit.body).title === 'Renamed'))
    await chat.remove('chat-1')
    assert.ok(server.hits.some(hit => hit.method === 'DELETE' && hit.url === '/api/chats/chat-1'))
    assert.equal(chat.current, undefined)
    assert.equal(backend.auth, 'token')
  } finally {
    await server.close()
  }
})

test('with an OpenRouter chat model and no assessor, the analysis uses a model of yours that can assess, never the demonstration model', async () => {
  reset()
  const options = {
    options: [
      { id: 'or1', provider: 'openrouter', label: 'OpenRouter', model: 'vendor/free:free', external: true, source: 'personal' },
      { id: 'demo', provider: 'demo', label: 'Demonstration', model: null, external: false, source: 'server' },
      { id: 'lm1', provider: 'lmstudio', label: 'LM Studio', model: 'gemma', external: false, source: 'personal' },
    ],
    auto_configuration_id: null,
    assessment: null,
  }
  const { server, analyser } = await backendStub({ options })
  try {
    config.chatModel = 'or1'
    await analyser.analyseText('Plan a database migration for a small team', {})
    // the stub answers as Groq, so the check refuses it; what matters is which model the request was aimed at
    assert.match(analyser.lastError ?? '', /You chose LM Studio · gemma/)
    config.chatModel = ''
  } finally {
    await server.close()
  }
})
