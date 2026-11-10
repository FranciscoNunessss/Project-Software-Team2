// Profile and settings (switches, preferences, deletions) and the My progress report, with a stub backend.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1' }
const { vscode, log, ui } = installVscode(config)
const { Backend } = require('../dist/backend.js')
const { ProfileView, ProgressReport } = require('../dist/profile.js')
const { renderProgress, sparkline } = require('../dist/progress.js')

const CONTEXT = { content: 'I prefer short answers', updated_at: 't', save_enabled: false, use_enabled: false, coaching_auto_enabled: false, conversation_memory_enabled: false, saved_conversations: 3, memory: [{}, {}] }

async function backendStub(mode = {}) {
  const state = { context: { ...CONTEXT }, coach: true, auto: false, calls: [] }
  const server = await stub((request, response, body) => {
    const send = (data, status = 200) => json(response, data, status)
    const parsed = body ? JSON.parse(body) : {}
    state.calls.push(`${request.method} ${request.url}${body ? ' ' + body : ''}`)
    if (mode.fail && request.url === '/api/context') return send({ detail: 'provider_unavailable' }, 502)
    if (request.url === '/api/context' && request.method === 'GET') return send(state.context)
    if (request.url === '/api/context' && request.method === 'PUT') {
      Object.assign(state.context, parsed)
      return send(state.context)
    }
    if (request.url === '/api/prompt-coach/settings') {
      if (request.method === 'PUT') state.coach = parsed.enabled
      return send({ enabled: state.coach })
    }
    if (request.url === '/api/chat/settings') {
      if (request.method === 'PUT') state.auto = parsed.auto_analyse
      return send({ auto_analyse: state.auto })
    }
    if (request.method === 'DELETE') return send({ status: 'deleted' })
    if (request.url === '/api/progress') return send({ sessions: 4, analyses: 6, choices: 3, matches: 2, agreement: 0.667, mean_gap: 0.33 })
    if (request.url === '/api/progress/dashboard') return send({ over: 1, under: 1, series: [] })
    if (request.url === '/api/progress/outcomes') return send({ tasks: 5, skipped: 1, resolved: 3, resolved_with_refinement: 1, not_resolved: 1, described_poorly: 1, solved_rate_following: 0.8, solved_rate_not_following: 0.5, followed: 4, mean_turns: 2.5, by_model: [{ model: 'groq | gpt', tasks: 5, solved: 4 }] })
    if (request.url === '/api/progress/learning') return send({ points: [{ completeness: 20 }, { completeness: 60 }, { completeness: 100 }], min_sessions: 5, margin: 5, verdict: 'insufficient_history', dimensions: [] })
    if (request.url === '/api/progress/coaching') return send({ configured: true, model: 'm', automatic_enabled: true, generating: false, error: null, saved: { summary: 'You over-provision often.', patterns: { over_provisioning: { explanation: 'Large models for small tasks.', action: 'Try a smaller one.' }, prompting: { status: 'not_assessed', explanation: 'No text saved.', action: 'Save text to assess.' } }, suggestions: [{ title: 'Right-size', explanation: 'Match the model to the need.', action: 'Pick the cheapest that covers it.' }] } })
    send({ detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  return { server, backend, state }
}

const reset = () => {
  ui.warning = (_m, _o, buttons) => buttons[0]
  ui.info = () => undefined
  for (const key of Object.keys(log)) log[key].length = 0
}
const rows = view => view.getChildren()
const toggle = (view, key) => rows(view).find(row => row.key === key)

test('the profile shows each switch with its state, the preferences and the deletions', async () => {
  reset()
  const { server, backend } = await backendStub()
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    const labels = rows(view).map(row => row.label)
    assert.deepEqual(labels.slice(0, 6), ['Save learned memory', 'Use memory in analyses', 'Save task text and AI responses', 'Automatic suggestions', 'Prompt Coach', 'Always analyse before sending'])
    assert.equal(toggle(view, 'coach').on, true)
    assert.equal(toggle(view, 'save_enabled').on, false)
    const prefs = rows(view).find(row => row.label === 'Preferences')
    assert.equal(prefs.description, 'I prefer short answers')
    assert.match(rows(view).find(row => row.label === 'Delete stored conversations').description, /3 saved/)
    const item = view.getTreeItem(toggle(view, 'coach'))
    assert.equal(item.checkboxState, 1)
    assert.match(item.tooltip, /Coach helps describe a task/)
    assert.match(rows(view).at(-1).label, /API tokens are managed in the app/)
  } finally {
    await server.close()
  }
})

test('ticking a plain switch changes it on the backend, without a question', async () => {
  reset()
  const { server, backend, state } = await backendStub()
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    await view.setToggle('save_enabled', true)
    await view.setToggle('coach', false)
    await view.setToggle('auto_analyse', true)
    assert.equal(state.context.save_enabled, true)
    assert.equal(state.coach, false)
    assert.equal(state.auto, true)
    assert.equal(log.warning.length, 0)
    assert.equal(toggle(view, 'save_enabled').on, true)
  } finally {
    await server.close()
  }
})

test('saving task text and automatic suggestions ask first, explain what is sent, and do nothing if declined', async () => {
  reset()
  const { server, backend, state } = await backendStub()
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    ui.warning = () => undefined
    await view.setToggle('conversation_memory_enabled', true)
    await view.setToggle('coaching_auto_enabled', true)
    assert.match(log.warning[0].message, /stored on the backend.*may be sent to the assessor or the chat model/s)
    assert.match(log.warning[1].message, /derived metadata.*project model.*quota/s)
    assert.equal(state.context.conversation_memory_enabled, false)
    assert.equal(state.context.coaching_auto_enabled, false)
    assert.equal(toggle(view, 'conversation_memory_enabled').on, false, 'the tree went back to the real state')
    ui.warning = (_m, _o, buttons) => buttons[0]
    await view.setToggle('conversation_memory_enabled', true)
    assert.equal(state.context.conversation_memory_enabled, true)
  } finally {
    await server.close()
  }
})

test('preferences are saved as typed, and an empty value clears them', async () => {
  reset()
  const { server, backend, state } = await backendStub()
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    vscode.window.showInputBox = async options => {
      assert.match(options.prompt, /Do not enter sensitive information/)
      assert.equal(options.value, 'I prefer short answers')
      return ''
    }
    await view.editPreferences()
    assert.equal(state.context.content, '')
  } finally {
    await server.close()
  }
})

test('each deletion asks, names what stays, and is sent only after the confirmation', async () => {
  reset()
  const { server, backend, state } = await backendStub()
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    ui.warning = () => undefined
    await view.delete('history')
    assert.equal(state.calls.filter(call => call.startsWith('DELETE')).length, 0)
    assert.match(log.warning[0].message, /account, preferences and model configurations stay.*cannot be undone/s)
    ui.warning = (_m, _o, buttons) => buttons[0]
    await view.delete('memory')
    await view.delete('conversations')
    await view.delete('history')
    assert.deepEqual(state.calls.filter(call => call.startsWith('DELETE')), ['DELETE /api/context/memory', 'DELETE /api/context/conversations', 'DELETE /api/progress/history'])
  } finally {
    await server.close()
  }
})

test('signed out or a failing backend is said in the tree, not hidden', async () => {
  reset()
  const out = new ProfileView(new Backend(secretStore()))
  await out.refresh()
  assert.match(rows(out)[0].label, /Sign in to see your profile/)
  const { server, backend } = await backendStub({ fail: true })
  try {
    const view = new ProfileView(backend)
    await view.refresh()
    assert.match(rows(view)[0].label, /Groq could not be reached|provider could not be reached|failed/i)
  } finally {
    await server.close()
  }
})

// ---- My progress ---------------------------------------------------------------------------------------

test('the progress report has the app\'s sections with real numbers', async () => {
  reset()
  const { server, backend } = await backendStub()
  try {
    const report = new ProgressReport(backend)
    await report.open()
    const text = report.provideTextDocumentContent()
    assert.match(text, /4 sessions · 6 analyses · 3 choices · 2 matched the recommendation · agreement 67%/)
    assert.match(text, /Over: 1 · Under: 1/)
    assert.match(text, /5 answered, 1 skipped: 3 solved · 1 solved after refining · 1 not solved \(1 because the task was described poorly\)/)
    assert.match(text, /Following the recommendation: solved 80% of 4 tasks; not following it: 50%/)
    assert.match(text, /\| groq \\\| gpt \| 5 \| 4 \|/, 'a pipe in a model name cannot break the table')
    assert.match(text, /Not enough sessions yet/)
    assert.match(text, /\(3\): ▂▅█/)
    assert.match(text, /You over-provision often\./)
    assert.match(text, /over provisioning:\*\* Large models for small tasks\. \*Next:\* Try a smaller one\./)
    assert.match(text, /prompting \(not assessed\)/)
    assert.match(text, /Right-size:\*\* Match the model to the need\. \*Practice:\*/)
    assert.ok(log.executed.some(call => call[0] === 'markdown.showPreviewToSide'))
  } finally {
    await server.close()
  }
})

test('an empty account says what to do instead of showing zeros as results', () => {
  const text = renderProgress({
    progress: { sessions: 0, analyses: 0, choices: 0, matches: 0, agreement: null, mean_gap: null },
    outcomes: { tasks: 0, skipped: 0, resolved: 0, resolved_with_refinement: 0, not_resolved: 0, described_poorly: 0, solved_rate_following: null, solved_rate_not_following: null, followed: 0, mean_turns: null, by_model: [] },
    learning: { points: [], min_sessions: 5, verdict: 'insufficient_history', dimensions: [] },
    coaching: { configured: false, model: 'm', automatic_enabled: false, generating: false, error: null, saved: null },
  })
  assert.match(text, /agreement not enough data · mean gap n\/a/)
  assert.match(text, /No answers yet: after an analysis, say whether the model solved the task\./)
  assert.match(text, /It needs at least 5 sessions\./)
  assert.match(text, /not configured on this backend/)
})

test('a missing endpoint or a signed-out user does not break the report', async () => {
  reset()
  assert.match(renderProgress({}), /Not available\./)
  const report = new ProgressReport(new Backend(secretStore()))
  await report.open()
  assert.match(log.info.at(-1), /sign in first/)
})

test('the sparkline maps 0 to 100 onto eight bars', () => {
  assert.equal(sparkline([0, 50, 100]), '▁▅█')
  assert.equal(sparkline([]), '')
  assert.equal(sparkline([150, -5]), '█▁')
})
