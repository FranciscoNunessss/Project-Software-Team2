// Code sent to the chat: the secret check before it leaves, on top of the confirmation that already exists.
// Requirement SEL-06 of docs/vscode-extension.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1', confirmExternal: true, chatModel: 'server:lmstudio', resultView: 'preview' }
const { log, ui } = installVscode(config)
const { Backend } = require('../dist/backend.js')
const { Analyser } = require('../dist/analyse.js')
const { ChatService } = require('../dist/chat.js')

const OPTIONS = {
  options: [
    { id: 'server:groq', provider: 'groq', label: 'Groq', model: 'llama-test', external: true, source: 'server' },
    { id: 'server:lmstudio', provider: 'lmstudio', label: 'LM Studio', model: 'local-model', external: false, source: 'server' },
  ],
  auto_configuration_id: 'server:groq',
}
const sink = () => ({ text: '', markdown(part) { this.text += part }, progress() {}, button() {} })

async function setup() {
  const messages = []
  const server = await stub((request, response, body) => {
    if (request.url === '/api/llm-options') return json(response, OPTIONS)
    if (request.url === '/api/chats' && request.method === 'POST') return json(response, { id: 'chat-1', title: 'New chat', message_count: 0, messages: [] }, 201)
    if (/\/api\/chats\/[^/]+\/messages$/.test(request.url)) {
      messages.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: delta\ndata: {"text":"ok"}\n\n')
      response.write('event: done\ndata: {}\n\n')
      return response.end()
    }
    json(response, { detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  return { server, messages, chat: new ChatService(backend, new Analyser(backend)) }
}

const secretCode = 'const config = {\n  password = "hunter2hunter2"\n}'

test.beforeEach(() => {
  log.warning.length = 0
  config.chatModel = 'server:lmstudio'
  ui.warning = (_message, _options, buttons) => buttons[0]
})

test('sel_06 code that looks like a secret asks first, and Send anyway sends it', async t => {
  const { server, messages, chat } = await setup()
  t.after(() => server.close())
  await chat.send(secretCode, sink(), new AbortController().signal, undefined, { code: true })
  assert.match(log.warning[0].message, /looks like it contains a password or secret assignment/)
  assert.deepEqual(log.warning[0].buttons, ['Send anyway'])
  assert.equal(messages.length, 1)
})

test('sel_06 cancelling the secret question sends nothing', async t => {
  const { server, messages, chat } = await setup()
  t.after(() => server.close())
  ui.warning = () => undefined
  const out = sink()
  await chat.send(secretCode, out, new AbortController().signal, undefined, { code: true })
  assert.equal(messages.length, 0)
  assert.match(out.text, /Nothing was sent/)
})

test('sel_06 code without a secret is not questioned', async t => {
  const { server, messages, chat } = await setup()
  t.after(() => server.close())
  await chat.send('Explain this\n\nconst a = 1', sink(), new AbortController().signal, undefined, { code: true })
  assert.equal(log.warning.length, 0)
  assert.equal(messages.length, 1)
})

test('sel_06 an external model still asks its own confirmation, after the secret question', async t => {
  const { server, messages, chat } = await setup()
  t.after(() => server.close())
  config.chatModel = 'server:groq'
  await chat.send(secretCode, sink(), new AbortController().signal, undefined, { code: true })
  assert.equal(log.warning.length, 2)
  assert.match(log.warning[0].message, /looks like it contains/)
  assert.match(log.warning[1].message, /outside your machine/)
  assert.equal(messages.length, 1)
})
