// The commands against a stub backend: the assessor, consent, secrets, failures, retry, cancel, timeouts,
// the Prompt Coach, diff, apply, task outcome and "use this model". The stub makes every outcome deterministic.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode, secretStore, stub, json, TOKEN, fixture, OPTIONS } = require('./helpers')

const config = { backendUrl: 'http://127.0.0.1:1', confirmExternal: true, coachMode: 'rewrite', improveApply: 'replace', resultView: 'preview', chatModel: '' }
const { vscode, log, ui, editor, progress } = installVscode(config)
const { Backend } = require('../dist/backend.js')
const { Analyser, ANALYSIS_SCHEME } = require('../dist/analyse.js')

const REWRITE = 'Write a two-page report about dogs, for children aged 8 to 10.'

async function backendStub(mode = {}) {
  const server = await stub((request, response, body) => {
    const send = (data, status = 200) => json(response, data, status)
    const parsed = body ? JSON.parse(body) : {}
    if (request.url === '/api/llm-options') return send(mode.options ?? OPTIONS)
    if (request.url === '/api/features') return send({ prompt_coach: mode.coachFeature ?? true, chat: true })
    if (request.url === '/api/prompt-coach/settings') return send({ enabled: mode.coachEnabled ?? true })
    if (request.url === '/api/analyze') return mode.analyze ? mode.analyze(parsed, send) : send(fixture())
    if (request.url === '/api/prompt-coach') {
      if (mode.coach) return mode.coach(parsed, send)
      return send({ status: 'ok', fallback: false, dropped: 0, open_questions: [], rewrite: REWRITE, suggestions: [{ dimension: 'context', kind: 'tip', title: 'Say who it is for', rationale: 'r', quote: null, replacement: null }] })
    }
    if (request.url === '/api/decisions') return mode.decision ? mode.decision(parsed, send) : send({ status: 'recorded' })
    if (request.url.includes('/outcome') && request.method === 'PUT') return mode.outcome ? mode.outcome(parsed, send) : send({ status: 'saved' })
    if (request.url.startsWith('/api/sessions/') && request.method === 'DELETE') return send({ status: 'deleted' })
    send({ detail: 'not_found' }, 404)
  })
  config.backendUrl = server.url
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: server.url, token: TOKEN }) }))
  await backend.load()
  return { server, backend, analyser: new Analyser(backend) }
}

const reset = () => {
  config.confirmExternal = true
  config.coachMode = 'rewrite'
  config.improveApply = 'replace'
  config.resultView = 'preview'
  config.chatModel = ''
  ui.warning = (_m, _o, buttons) => buttons[0]
  ui.info = () => undefined
  ui.error = () => undefined
  ui.quickPick = items => items[0]
  progress.cancelAfterMs = undefined
  editor.document.text = 'write something about dogs'
  editor.selectedText = ''
  editor.document.uri = { path: '/work/prompt.md' }
  for (const key of Object.keys(log)) log[key].length = 0
  vscode.env.clipboard.text = ''
}
const bodies = (server, url) => server.hits.filter(hit => hit.url === url).map(hit => (hit.body ? JSON.parse(hit.body) : {}))
const rendered = (analyser, result) => analyser.provideTextDocumentContent({ scheme: ANALYSIS_SCHEME, path: `/${result.analysis.id}.md` })

test('Analyse uses the project assessor, names it in the confirmation, and opens the analysis as a document', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    const result = await analyser.fromClipboard()
    const [body] = bodies(server, '/api/analyze')
    assert.equal(body.provider, 'auto')
    assert.equal(body.allow_external, true, 'the assessor is external, so the consent is carried')
    assert.equal(body.configuration_id, undefined, 'the chat model is not the analysis model')
    assert.match(log.warning[0].message, /Groq · llama-test, outside your machine/)
    assert.match(log.warning[0].message, /42 characters/)
    assert.equal(result.analysis.recommendation.label, 'Groq · llama-test')
    const preview = log.executed.find(call => call[0] === 'markdown.showPreviewToSide')
    assert.ok(preview, 'the preview opened beside the editor')
    assert.equal(preview[1].scheme, ANALYSIS_SCHEME)
    assert.match(rendered(analyser, result), /^# AdaptAI · Groq · llama-test/)
  } finally {
    await server.close()
  }
})

test('with a local assessor nothing leaves the machine, so there is no dialog for a selection', async () => {
  reset()
  const lm = OPTIONS.options[1]
  const { server, analyser } = await backendStub({ options: { ...OPTIONS, assessment: lm, assessment_chain: [lm.id] } })
  try {
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    await analyser.fromClipboard()
    assert.equal(log.warning.length, 0)
    assert.equal(bodies(server, '/api/analyze')[0].allow_external, false)
  } finally {
    await server.close()
  }
})

test('without an assessor the chat model analyses; a manual choice that is answered by another model is discarded', async () => {
  reset()
  config.chatModel = 'server:lmstudio'
  const { server, analyser } = await backendStub({ options: { ...OPTIONS, assessment: null, assessment_chain: [] }, analyze: (body, send) => send(fixture({ provider: 'groq', configuration_id: 'server:groq' })) })
  try {
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    assert.equal(await analyser.fromClipboard(), undefined)
    const [body] = bodies(server, '/api/analyze')
    assert.equal(body.configuration_id, 'server:lmstudio')
    assert.equal(body.expected_provider, 'lmstudio')
    assert.match(log.error.join(' '), /You chose LM Studio.*came from groq.*discarded/s)
  } finally {
    await server.close()
  }
})

test('cancelling the confirmation sends nothing and says so', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    ui.warning = () => undefined
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    assert.equal(await analyser.fromClipboard(), undefined)
    assert.equal(bodies(server, '/api/analyze').length, 0)
    assert.match(log.info.join(' '), /Nothing was sent/)
  } finally {
    await server.close()
  }
})

test('"do not ask again" is an explicit button, and sending once never switches the check off', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    await analyser.fromClipboard()
    assert.equal(config.confirmExternal, true)
    ui.warning = (_m, _o, buttons) => buttons.find(label => /do not ask again/.test(label))
    await analyser.fromClipboard()
    assert.equal(config.confirmExternal, false)
  } finally {
    await server.close()
  }
})

test('a whole file always asks, says nothing was selected, and names the file and its size', async () => {
  reset()
  config.confirmExternal = false
  const { server, analyser } = await backendStub()
  try {
    editor.document.text = 'write something about dogs, in detail'
    await analyser.fromEditor()
    assert.match(log.warning[0].message, /Nothing is selected, so the whole content of prompt\.md \(37 characters\)/)
    assert.deepEqual(log.warning[0].buttons, ['Send'])
  } finally {
    await server.close()
  }
})

test('secret-looking text is explained first; secret files are never read or sent', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    ui.warning = () => undefined
    vscode.env.clipboard.text = 'Use this key gsk_' + 'a'.repeat(30) + ' to call the model'
    assert.equal(await analyser.fromClipboard(), undefined)
    assert.match(log.warning[0].message, /Groq API key.*Nothing has been sent yet/s)
    editor.document.uri = { path: '/work/.env' }
    assert.equal(await analyser.fromEditor(), undefined)
    let read = false
    vscode.workspace.fs = { readFile: async () => ((read = true), new Uint8Array()) }
    assert.equal(await analyser.fromUri({ path: '/work/id_rsa' }), undefined)
    assert.equal(read, false)
    assert.equal(bodies(server, '/api/analyze').length, 0)
  } finally {
    await server.close()
  }
})

test('a failed request is an error with the reason and a Retry that repeats the same text', async () => {
  reset()
  let fail = true
  const { server, analyser } = await backendStub({ analyze: (body, send) => (fail ? send({ detail: 'provider_unavailable' }, 502) : send(fixture())) })
  try {
    ui.error = (_m, buttons) => (buttons.includes('Retry') ? 'Retry' : undefined)
    vscode.env.clipboard.text = 'A task that fails first.'
    assert.equal(await analyser.fromClipboard(), undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.match(log.error[0], /the request for “A task that fails first\.” failed\. Groq could not be reached or failed/)
    fail = false
    vscode.env.clipboard.text = 'something else now'
    await analyser.retry()
    assert.equal(bodies(server, '/api/analyze').at(-1).task, 'A task that fails first.')
    assert.equal(analyser.results.size, 1)
  } finally {
    await server.close()
  }
})

for (const [code, status, pattern] of [
  ['provider_rate_limit', 502, /rate limiting/],
  ['provider_authentication', 502, /refused the credentials/],
  ['external_processing_requires_consent', 403, /did not carry your consent/],
  ['provider_timeout', 502, /took too long/],
]) {
  test(`the error "${code}" is explained in plain words`, async () => {
    reset()
    const { server, analyser } = await backendStub({ analyze: (body, send) => send({ detail: code }, status) })
    try {
      vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
      await analyser.fromClipboard()
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.match(log.error.join(' '), pattern)
    } finally {
      await server.close()
    }
  })
}

test('cancelling is quiet; a timeout is reported as a timeout', async () => {
  reset()
  const { server, analyser } = await backendStub({ analyze: () => {} })
  try {
    vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
    progress.cancelAfterMs = 60
    assert.equal(await analyser.fromClipboard(), undefined)
    assert.equal(log.error.length, 0)
    progress.cancelAfterMs = undefined
    analyser.timeoutMs = 150
    await analyser.fromClipboard()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.match(log.error.join(' '), /timed out/)
  } finally {
    analyser.timeoutMs = 150_000
    await server.close()
  }
})

// ---- Prompt Coach ---------------------------------------------------------------------------------------

const COACH_EDITS = {
  status: 'ok', fallback: false, dropped: 0, open_questions: ['For whom?'], rewrite: 'REWRITE TEXT',
  suggestions: [
    { dimension: 'context', kind: 'edit', title: 'Add the audience', rationale: 'r', quote: 'something', replacement: 'a report' },
    { dimension: 'domain', kind: 'tip', title: 'Name the topic', rationale: 'r', quote: null, replacement: null },
    { dimension: 'risk', kind: 'edit', title: 'Missing quote', rationale: 'r', quote: 'not in the text', replacement: 'x' },
  ],
}

test('Tips never change the text; Edits apply only quotes that are there; Rewrite replaces everything', async () => {
  reset()
  const { server, analyser } = await backendStub({ coach: (body, send) => send(COACH_EDITS) })
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    await analyser.coach(result, 'tips', true)
    assert.equal(result.improved, undefined)
    await analyser.coach(result, 'edits', true)
    assert.equal(result.improved, 'write a report about dogs')
    await analyser.coach(result, 'rewrite', true)
    assert.equal(result.improved, 'REWRITE TEXT')
    assert.match(rendered(analyser, result), /replace “something” with “a report”/)
    assert.match(rendered(analyser, result), /Improved text \(rewrite\)/)
  } finally {
    await server.close()
  }
})

test('the Coach request names the analysis and the exact text analysed', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = '  write something about dogs  \n'
    const result = await analyser.fromClipboard()
    await analyser.coach(result, 'rewrite', true)
    assert.deepEqual(bodies(server, '/api/prompt-coach')[0], { analysis_id: 'a1', task: 'write something about dogs', mode: 'rewrite', allow_external: true })
  } finally {
    await server.close()
  }
})

test('Improve with "replace" puts the rewrite in the editor; with "diff" it shows the diff and leaves the text alone', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    editor.document.text = '\n  write something about dogs\n'
    await analyser.improveInEditor()
    assert.equal(editor.document.text, `\n  ${REWRITE}\n`, 'the surrounding whitespace is kept')
    config.improveApply = 'diff'
    editor.document.text = 'write something about dogs'
    log.executed.length = 0
    await analyser.improveInEditor()
    const diff = log.executed.find(call => call[0] === 'vscode.diff')
    assert.ok(diff)
    assert.equal(analyser.provideTextDocumentContent(diff[1]), 'write something about dogs')
    assert.equal(analyser.provideTextDocumentContent(diff[2]), REWRITE)
    assert.equal(editor.document.text, 'write something about dogs')
  } finally {
    await server.close()
  }
})

test('Apply does not overwrite text that changed after the analysis; it opens a new file instead', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    const result = await analyser.fromEditor()
    await analyser.coach(result, 'rewrite', true)
    editor.document.text = 'I typed something else meanwhile'
    let opened
    const saved = vscode.workspace.openTextDocument
    vscode.workspace.openTextDocument = async arg => {
      if (arg && arg.content !== undefined) opened = arg.content
      return editor.document
    }
    await analyser.apply(result)
    vscode.workspace.openTextDocument = saved
    assert.equal(editor.document.text, 'I typed something else meanwhile')
    assert.equal(opened, REWRITE)
  } finally {
    await server.close()
  }
})

test('Coach the clipboard: one confirmation naming both requests, then the improved text on the clipboard', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    await analyser.coachClipboard()
    assert.equal(log.warning.length, 1)
    assert.match(log.warning[0].message, /sent twice: to analyse it, then to ask the Prompt Coach/)
    assert.equal(vscode.env.clipboard.text, REWRITE)
  } finally {
    await server.close()
  }
})

test('the Coach cancelled or failed shows in the analysis, and the analysis stays', async () => {
  reset()
  const { server, analyser } = await backendStub({ coach: (body, send) => send({ detail: 'analysis_not_found' }, 404) })
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    await analyser.coach(result, 'rewrite', true)
    assert.match(result.error, /no longer stored/)
    assert.match(rendered(analyser, result), /The Prompt Coach failed:\*\* .*no longer stored/)
    assert.ok(result.analysis)
  } finally {
    await server.close()
  }
})

// ---- the actions of the app --------------------------------------------------------------------------------

test('Task solved sends the outcome, and a reason only when it was not solved', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    ui.quickPick = items => items.find(item => item.outcome === 'resolved_with_refinement') ?? items[0]
    await analyser.taskOutcome(result.analysis.id)
    assert.deepEqual(bodies(server, `/api/analyses/${result.analysis.id}/outcome`)[0], { outcome: 'resolved_with_refinement' })
    ui.quickPick = items => items.find(item => item.outcome === 'not_resolved') ?? items.find(item => item.reason === 'description')
    await analyser.taskOutcome(result.analysis.id)
    assert.deepEqual(bodies(server, `/api/analyses/${result.analysis.id}/outcome`)[1], { outcome: 'not_resolved', reason: 'description' })
  } finally {
    await server.close()
  }
})

test('a second answer is explained (the outcome is recorded once per task)', async () => {
  reset()
  const { server, analyser } = await backendStub({ outcome: (body, send) => send({ detail: 'outcome_already_recorded' }, 409) })
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    await analyser.taskOutcome(result.analysis.id)
    assert.match(log.error.join(' '), /409|outcome_already_recorded/)
  } finally {
    await server.close()
  }
})

test('Use this model records the decision and makes it the chat model', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    await analyser.useModel(result.analysis.id)
    assert.deepEqual(bodies(server, '/api/decisions')[0], { analysis_id: 'a1', candidate_id: 'groq:gpt-oss-20b' })
    assert.equal(config.chatModel, 'server:groq')
    assert.match(log.info.at(-1), /the chat will use Groq · llama-test/)
  } finally {
    await server.close()
  }
})

test('Copy summary puts the model, its price and the assessor on the clipboard', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    await analyser.copySummary(result.analysis.id)
    assert.match(vscode.env.clipboard.text, /AdaptAI recommends: Groq · llama-test \(low cost band/)
    assert.match(vscode.env.clipboard.text, /Assessed by groq · llama-test\./)
  } finally {
    await server.close()
  }
})

test('the CodeLens actions sit on the analysis document, and the Coach one only when the backend has the Coach', async () => {
  reset()
  const { server, analyser } = await backendStub({ coachFeature: false })
  try {
    vscode.env.clipboard.text = 'write something about dogs'
    const result = await analyser.fromClipboard()
    const lenses = analyser.provideCodeLenses({ uri: { scheme: ANALYSIS_SCHEME, path: `/${result.analysis.id}.md` } })
    assert.deepEqual(lenses.map(item => item.command.command), ['adaptai.copySummary', 'adaptai.taskOutcome', 'adaptai.useModel'])
    assert.deepEqual(analyser.provideCodeLenses({ uri: { scheme: 'file', path: '/x.md' } }), [])
  } finally {
    await server.close()
  }
})

test('signed out, an unusable address, no connection: each is said in words and nothing is sent', async () => {
  reset()
  const server = await stub((request, response) => json(response, OPTIONS))
  config.backendUrl = server.url
  const signedOut = new Analyser(new Backend(secretStore()))
  vscode.env.clipboard.text = 'Compare two API designs and recommend one.'
  assert.equal(await signedOut.fromClipboard(), undefined)
  assert.match(log.info[0], /sign in first/)
  assert.equal(server.hits.length, 0)
  await server.close()
  config.backendUrl = 'http://adaptai.example.org'
  const remote = new Analyser(new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: 'http://adaptai.example.org', token: TOKEN }) })))
  assert.equal(await remote.fromClipboard(), undefined)
  assert.match(log.error[0], /https/)
})

test('an empty clipboard and an empty file say so', async () => {
  reset()
  const { server, analyser } = await backendStub()
  try {
    assert.equal(await analyser.fromClipboard(), undefined)
    assert.match(log.info.at(-1), /clipboard is empty/)
    editor.document.text = '   '
    assert.equal(await analyser.fromEditor(), undefined)
    assert.match(log.info.at(-1), /is empty/)
  } finally {
    await server.close()
  }
})
