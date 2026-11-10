// The extension's real code against a real AdaptAI backend (develop plus the token module) on PostgreSQL,
// in demonstration mode. Skipped unless ADAPTAI_TEST_BACKEND names a disposable backend.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore } = require('./helpers')

const URL_ = process.env.ADAPTAI_TEST_BACKEND
const skip = URL_ ? false : 'set ADAPTAI_TEST_BACKEND to a disposable backend'
const config = { backendUrl: URL_ || 'http://127.0.0.1:1', confirmExternal: true, chatModel: '', coachMode: 'rewrite', improveApply: 'replace', resultView: 'preview' }
const { vscode, log, ui } = installVscode(config)
const { Backend, ApiError } = require('../dist/backend.js')
const { Analyser } = require('../dist/analyse.js')
const { ChatService } = require('../dist/chat.js')
const { ProfileView, ProgressReport } = require('../dist/profile.js')
const { ModelsView } = require('../dist/models.js')

const email = `ide-${Date.now()}@example.com`
const password = 'test-password-123'
const store = secretStore()
let backend
let analyser

const sink = () => {
  const out = { text: '', buttons: [] }
  return { out, markdown: text => void (out.text += text), progress: () => {}, button: command => void out.buttons.push(command) }
}

test('a user registers and signs in with the password: the extension keeps only a token bound to its backend', { skip }, async () => {
  backend = new Backend(store)
  await backend.load()
  const register = await backend.call({ path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }, AbortSignal.timeout(10_000))
  assert.equal(register.status, 201)
  await backend.signOut()
  const result = await backend.signInWithPassword(email, password)
  assert.equal(result.auth, 'token')
  const stored = JSON.parse(store.data.get('adaptai.token'))
  assert.match(stored.token, /^adaptai_pat_/)
  assert.equal(stored.origin, URL_)
  assert.equal(store.data.has('adaptai.session'), false, 'no cookie is kept')
  const status = await backend.status()
  assert.equal(status.email, email)
  assert.equal(status.rejected, false)
  analyser = new Analyser(backend)
})

test('a wrong password and a bad token are refused with a reason, and nothing is stored', { skip }, async () => {
  const fresh = new Backend(secretStore())
  await assert.rejects(() => fresh.signInWithPassword(email, 'wrong-password-123'), error => error instanceof ApiError && error.status === 401)
  await assert.rejects(() => fresh.signInWithToken('adaptai_pat_' + 'x'.repeat(43)), error => error instanceof ApiError && error.status === 401)
  assert.equal(fresh.auth, 'none')
})

test('a token cannot manage tokens, as the backend says', { skip }, async () => {
  const error = await backend.api('/api/tokens').catch(e => e)
  assert.ok(error instanceof ApiError && error.status === 401)
})

test('Analyse (demonstration) goes through the real API and opens as a document with the real fields', { skip }, async () => {
  const result = await analyser.runForTest('Compare two API designs and recommend one, with the trade-offs.')
  assert.equal(result.analysis.mode, 'demonstration')
  assert.ok(result.analysis.recommendation.name)
  await analyser.show(result, false)
  const text = analyser.provideTextDocumentContent({ scheme: 'adaptai-analysis', path: `/${result.analysis.id}.md` })
  assert.match(text, /^# AdaptAI · /)
  assert.match(text, /Demonstration mode/)
  assert.match(text, /## Task profile/)
  global.result = result
})

test('the Prompt Coach answers on that analysis, and the outcome is recorded once', { skip }, async () => {
  const result = global.result
  await backend.api('/api/prompt-coach/settings', 'PUT', { enabled: true })
  await analyser.coach(result, 'rewrite', true)
  assert.equal(result.error, undefined, result.error)
  assert.ok(result.coach)
  ui.quickPick = items => items.find(item => item.outcome === 'resolved')
  await analyser.taskOutcome(result.analysis.id)
  assert.match(log.info.at(-1), /saved/)
  await analyser.taskOutcome(result.analysis.id)
  assert.match(log.error.at(-1), /409|already/i)
})

test('the chat streams a real answer, keeps the chat on the backend, lists it and renames it', { skip }, async () => {
  const chat = new ChatService(backend, analyser)
  const out = sink()
  await chat.send('Say hello in one short sentence.', out, new AbortController().signal)
  assert.ok(out.out.text.length > 0, `an answer arrived (${JSON.stringify(out.out.text)})`)
  assert.ok(chat.current)
  const listed = await chat.list()
  assert.ok(listed.some(item => item.id === chat.current))
  const transcript = await chat.transcript(chat.current)
  assert.match(transcript, /## You\n\nSay hello in one short sentence\./)
  await chat.rename(chat.current, 'Integration chat')
  assert.ok((await chat.list()).some(item => item.title === 'Integration chat'))
  const retry = sink()
  await chat.retry(retry, new AbortController().signal)
  assert.ok(retry.out.text.length > 0)
  const id = chat.current
  await chat.remove(id)
  assert.ok(!(await chat.list()).some(item => item.id === id))
})

test('/analyse inside a chat belongs to the chat session, as in the app', { skip }, async () => {
  const chat = new ChatService(backend, analyser)
  config.confirmExternal = false
  const out = sink()
  // The demo backend has no assessor, so the chat model (the demonstration) analyses.
  await chat.analyse('Plan a database migration for a small team', out, new AbortController().signal)
  assert.match(out.out.text, /^# AdaptAI · /)
  const chats = await chat.list()
  assert.ok(chats.some(item => item.id === chat.current))
  await chat.remove(chat.current)
})

test('the profile reads and changes the real switches, and the report shows the real counts', { skip }, async () => {
  const view = new ProfileView(backend)
  await view.refresh()
  assert.equal(view.getChildren().find(row => row.key === 'save_enabled').on, false)
  await view.setToggle('save_enabled', true)
  assert.equal(view.getChildren().find(row => row.key === 'save_enabled').on, true)
  await view.setToggle('coach', false)
  assert.equal(view.getChildren().find(row => row.key === 'coach').on, false)
  await view.setToggle('coach', true)
  ui.warning = (_m, _o, buttons) => buttons[0]
  await view.delete('history')
  const report = new ProgressReport(backend)
  await report.open()
  const text = report.provideTextDocumentContent()
  assert.match(text, /^# My progress/)
  assert.match(text, /0 sessions · 0 analyses/, 'deleting the history emptied it')
})

test('models: add a local configuration, test it, see it in the tree, delete it; the evaluations list answers', { skip }, async () => {
  const models = new ModelsView(backend, analyser.connections)
  await models.refresh()
  const queue = ['Local LM Studio', 'integration-model']
  vscode.window.showInputBox = async () => queue.shift()
  ui.quickPick = items => items.find(item => item.provider === 'lmstudio')
  await models.add()
  await models.refresh()
  const [, mine] = models.getChildren()
  const rows = models.getChildren(mine)
  const added = rows.find(row => row.kind === 'personal')
  assert.ok(added, 'the configuration is listed')
  assert.equal(added.config.provider, 'lmstudio')
  assert.equal(added.config.has_key, false)
  const [, , evaluations] = models.getChildren()
  assert.ok(models.getChildren(evaluations).length >= 1)
  await models.remove(added.config)
  await models.refresh()
  assert.ok(!models.getChildren(mine).some(row => row.kind === 'personal'))
})

test('a revoked token is reported as rejected, and signing out forgets it', { skip }, async () => {
  const login = await fetch(`${URL_}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = login.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  const tokens = await (await fetch(`${URL_}/api/tokens`, { headers: { cookie } })).json()
  assert.ok(tokens.length >= 1)
  for (const token of tokens) await fetch(`${URL_}/api/tokens/${token.id}`, { method: 'DELETE', headers: { cookie } })
  const status = await backend.status()
  assert.equal(status.online, true)
  assert.equal(status.rejected, true)
  await backend.signOut()
  assert.equal(backend.auth, 'none')
  assert.equal(store.data.has('adaptai.token'), false)
})

test('registering from the extension signs in, and a password session manages tokens (create, list, revoke)', { skip }, async () => {
  const other = new Backend(secretStore())
  await other.load()
  const mail = `reg-${Date.now()}@example.com`
  const made = await other.register(mail, 'registered-password-1')
  assert.equal(made.auth, 'token')
  assert.equal(other.managing, false)
  await assert.rejects(() => other.tokenApi('/api/tokens'), error => error instanceof ApiError && error.status === 401)
  await other.startManaging(mail, 'registered-password-1')
  assert.equal(other.managing, true)
  const created = await other.tokenApi('/api/tokens', 'POST', { name: 'second', expires_in_days: 30 })
  assert.match(created.token, /^adaptai_pat_/)
  const list = await other.tokenApi('/api/tokens')
  assert.ok(list.length >= 2)
  await other.tokenApi(`/api/tokens/${created.id}`, 'DELETE')
  assert.ok((await other.tokenApi('/api/tokens')).find(item => item.id === created.id).revoked)
  await assert.rejects(() => other.tokenApi('/api/chats'), error => error instanceof ApiError && error.status === 0)
  await other.signOut()
  assert.equal(other.managing, false)
})
