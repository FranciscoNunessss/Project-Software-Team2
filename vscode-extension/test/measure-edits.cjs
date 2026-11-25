// Measures how often a model answers a change request in a usable way: the 10 sample edits of edit-samples.cjs
// through the extension's real chat code, against a real backend. Release plan task E1.
//
//   ADAPTAI_URL=http://127.0.0.1:8033 ADAPTAI_TOKEN=adaptai_pat_... ADAPTAI_MODELS=<option id>,<option id> \
//     node test/measure-edits.cjs [report.json]
//
// ADAPTAI_MODELS are ids from /api/llm-options (the chat's model list); without it the first usable model is used.
// Use a throw-away account: every sample starts a chat, and the chats stay in the account.
const { installVscode, secretStore } = require('./helpers')
const { SAMPLES, scoreAnswer, summarise } = require('./edit-samples.cjs')

const URL_ = process.env.ADAPTAI_URL
const TOKEN = process.env.ADAPTAI_TOKEN
if (!URL_ || !TOKEN) {
  console.error('Set ADAPTAI_URL and ADAPTAI_TOKEN (a personal token of a throw-away account).')
  process.exit(2)
}
const config = { backendUrl: URL_, confirmExternal: true, chatModel: '', coachMode: 'rewrite', improveApply: 'diff', resultView: 'preview' }
installVscode(config)
const { Backend } = require('../dist/backend.js')
const { Analyser } = require('../dist/analyse.js')
const { ChatService } = require('../dist/chat.js')
const { buildMessage } = require('../dist/codemsg.js')

const EXTENSION = { typescript: 'ts', javascript: 'js', python: 'py' }

;(async () => {
  const backend = new Backend(secretStore({ 'adaptai.token': JSON.stringify({ origin: URL_, token: TOKEN }) }))
  await backend.load()
  const chat = new ChatService(backend, new Analyser(backend))
  const options = await backend.api('/api/llm-options')
  const wanted = (process.env.ADAPTAI_MODELS || '').split(',').map(id => id.trim()).filter(Boolean)
  const models = wanted.length ? wanted : [options.options.find(option => option.provider !== 'demo' && option.provider !== 'openrouter')?.id].filter(Boolean)
  if (!models.length) {
    console.error('The backend lists no model to measure.')
    process.exit(2)
  }
  const results = []
  for (const model of models) {
    const label = options.options.find(option => option.id === model)?.label ?? model
    for (const sample of SAMPLES) {
      const lines = sample.code.split('\n')
      const message = buildMessage('change', sample.instruction, { path: `sample.${EXTENSION[sample.language] ?? 'txt'}`, languageId: sample.language, startLine: 1, endLine: lines.length, code: sample.code })
      let answer = ''
      let outcome = 'refused'
      const started = Date.now()
      try {
        await chat.setCurrent(undefined)
        await chat.send(message.content, { markdown: text => void (answer += text), progress: () => undefined, button: () => undefined }, AbortSignal.timeout(180_000), { optionId: model }, { code: true })
        outcome = chat.outcome
      } catch (error) {
        outcome = 'failed'
        answer = String(error?.message ?? error)
      }
      const score = outcome === 'ok' ? scoreAnswer(sample, answer) : { wellFormed: false, passed: false, reason: outcome }
      results.push({ model: label, sample: sample.id, seconds: Math.round((Date.now() - started) / 100) / 10, ...score })
      console.log(`${label}  ${sample.id.padEnd(20)} ${score.wellFormed ? 'well formed' : 'NOT usable: ' + score.reason}${score.wellFormed ? (score.passed ? ', does the change' : ', does NOT do the change') : ''}`)
    }
  }
  const summary = summarise(results)
  console.log('\nModel | well formed | does the change')
  for (const row of summary) console.log(`${row.model} | ${row.wellFormed}/${row.total} (${Math.round(row.wellFormedRate * 100)}%) | ${row.passed}/${row.total} (${Math.round(row.passedRate * 100)}%)`)
  const file = process.argv[2]
  if (file) require('node:fs').writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), summary, results }, null, 2))
})().catch(error => {
  console.error(error)
  process.exit(1)
})
