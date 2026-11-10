const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../dist/core.js')
const format = require('../dist/format.js')

const dimension = (score = 2, confidence = 'medium') => ({ score, confidence, evidence: `evidence ${score}` })
const card = (overrides = {}) => ({
  id: 'groq:gpt-oss-20b',
  name: 'GPT-OSS 20B',
  label: 'Groq · openai/gpt-oss-20b',
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
  configuration_id: 'server:groq',
  status: 'covers',
  shortfalls: [],
  coverage: [
    { need: 'reasoning', estimated: 2, top: 2, capability: 3, state: 'covers', provisional: true },
    { need: 'tools', estimated: 3, top: 3, capability: 2, state: 'short', provisional: false },
  ],
  blended_price: 0.12,
  cost_band: 'low',
  free: false,
  local: false,
  calibrated: false,
  levels_from: 'LMArena public ranking of 2026-11-06 (CC BY 4.0), provisional',
  ...overrides,
})
const analysis = (overrides = {}) => ({
  id: 'a1',
  session_id: 's1',
  mode: 'semantic',
  provider: 'groq',
  assessment_model: 'openai/gpt-oss-20b',
  profile: { reasoning: dimension(), context: dimension(1), ambiguity: dimension(3, 'low'), domain: dimension(), risk: dimension(null, 'undetermined'), tools: dimension(), modality: { required: ['text'], confidence: 'high', evidence: 'text only' }, explanation: 'Why the profile looks like this | with a pipe.' },
  profile_version: 'profile-2',
  rubric_version: 'rubric-2.0',
  recommendation_provisional: false,
  clarification_questions: ['Who is the audience?'],
  guidance: [],
  tips: [{ dimension: 'context', text: 'Add background.' }, { dimension: null, text: 'Be specific.' }],
  recommendation: card(),
  alternatives: [card({ id: 'x', label: 'LM Studio · local', status: 'covers_as_described', cost_band: null, blended_price: null, local: true, shortfalls: ['tools'], gap: -1 })],
  rationale: 'Because it covers reasoning for the lowest price.',
  warnings: ['Risk of error is undetermined.'],
  catalogue_version: 'catalogue-2.1',
  policy_version: 'needs-capabilities-1',
  latency_ms: 1200,
  completeness: 71,
  needs: { needs: { reasoning: { estimated: 2, top: 2, determined: true }, context: { estimated: 1, top: 2, determined: true }, domain: { estimated: 2, top: 2, determined: true }, reliability: { estimated: 2, top: 3, determined: false }, tools: { estimated: 3, top: 3, determined: true } }, modalities: ['text'], capabilities: ['text'], length_tokens: 40, ambiguous: true },
  notes: ['Tools need level 3: the chat does not run tools.'],
  ...overrides,
})

test('the analysis names the recommended model, its price, where its levels come from and who assessed the task', () => {
  const md = format.renderAnalysis(analysis(), { source: 'selection', at: '12:03:00' })
  assert.match(md, /^# AdaptAI · Groq · openai\/gpt-oss-20b/)
  assert.match(md, /Covers every need/)
  assert.match(md, /low cost band \(0\.12 USD per million tokens, blended\)/)
  assert.match(md, /levels from LMArena public ranking of 2026-11-06/)
  assert.match(md, /not calibrated/)
  assert.match(md, /Assessed by groq · openai\/gpt-oss-20b at 12:03:00\. Source: selection\./)
})

test('coverage, needs, alternatives, notes, tips and questions are all there, as in the app', () => {
  const md = format.renderAnalysis(analysis())
  assert.match(md, /\| Tools \| High \| Medium \| Falls short \|/)
  assert.match(md, /## What the task needs/)
  assert.match(md, /Not determined \(assumed Medium to High\)/)
  assert.match(md, /## Alternatives/)
  assert.match(md, /LM Studio · local \| Covers the task as described \| local, no cost \| tools \| covers less/)
  assert.match(md, /Tools need level 3: the chat does not run tools\./)
  assert.match(md, /\*\*Warning:\*\* Risk of error is undetermined\./)
  assert.match(md, /- \*\*Context demand:\*\* Add background\./)
  assert.match(md, /- \*\*General:\*\* Be specific\./)
  assert.match(md, /Who is the audience\?/)
  assert.match(md, /Completeness: 71\/100 · profile profile-2 · policy needs-capabilities-1 · catalogue catalogue-2\.1 · rubric rubric-2\.0/)
})

test('a pipe or a line break in model text cannot break a table', () => {
  const md = format.renderAnalysis(analysis({ alternatives: [card({ label: 'a | b\nc', shortfalls: ['x | y'] })] }))
  const row = md.split('\n').find(line => line.startsWith('| a'))
  assert.ok(row)
  assert.equal(row.split(/(?<!\\)\|/).length, 7, 'five cells, escaped pipes do not split')
})

test('demonstration and provisional results are labelled as such', () => {
  const demo = format.renderAnalysis(analysis({ mode: 'demonstration', provider: 'demo', assessment_model: null, recommendation_provisional: true }))
  assert.match(demo, /\*\*Demonstration mode\.\*\*/)
  assert.match(demo, /\*\*Provisional\.\*\*/)
  assert.match(demo, /the demonstration heuristic \(no model/)
})

test('an illustrative or free or local model says so', () => {
  assert.match(format.renderAnalysis(analysis({ recommendation: card({ illustrative: true, free: true }) })), /free · .*illustrative catalogue entry, not a real model/)
  assert.equal(format.price(card({ local: true, free: false })), 'local, no cost')
})

test('an analysis stored before ADR-014 still renders, with its tier named', () => {
  const old = analysis({ recommendation: { id: 'demo-balanced', name: 'Illustrative balanced tier', capacity: 2, capabilities: ['text'] }, alternatives: [], needs: null, notes: undefined })
  const md = format.renderAnalysis(old)
  assert.match(md, /Illustrative balanced tier \(Medium tier, stored before ADR-014\)/)
})

test('the suggestion "also on OpenRouter" and the changes since the previous analysis appear when present', () => {
  const md = format.renderAnalysis(analysis({ suggestion: card({ label: 'OpenRouter · x/y' }), suggestion_reason: 'Covers tools, which yours falls short on.', changes: [{ dimension: 'context', before: 1, after: 2 }] }))
  assert.match(md, /## Also on OpenRouter/)
  assert.match(md, /Covers tools, which yours falls short on\./)
  assert.match(md, /Context demand: 1 → 2/)
})

test('the summary for the clipboard has the model, its price, the reason and the assessor', () => {
  const text = format.textSummary(analysis())
  assert.match(text, /AdaptAI recommends: Groq · openai\/gpt-oss-20b \(low cost band/)
  assert.match(text, /Because it covers reasoning/)
  assert.match(text, /Assessed by groq · openai\/gpt-oss-20b\./)
  assert.match(text, /Alternatives: LM Studio · local/)
})

// ---- the request: the project's assessor analyses every task (ADR-014 A11) ----------------------

const GROQ = { id: 'server:groq', provider: 'groq', label: 'Groq', model: 'openai/gpt-oss-20b', external: true, source: 'server' }
const LM = { id: 'server:lmstudio', provider: 'lmstudio', label: 'LM Studio', model: 'local', external: false, source: 'server' }

test('with an assessor, Analyse sends no model choice and carries the assessor\'s consent', () => {
  const plan = core.analysisPlan('a task', { options: [GROQ, LM], auto_configuration_id: 'server:groq', assessment: GROQ }, { chat: LM })
  assert.equal(plan.via.id, 'server:groq')
  assert.equal(plan.manual, false)
  assert.equal(plan.body.provider, 'auto')
  assert.equal(plan.body.allow_external, true)
  assert.equal(plan.body.configuration_id, undefined, 'the chat model is not the analysis model')
  assert.equal(plan.body.expected_model, undefined)
})

test('with a local assessor no external consent is claimed', () => {
  const plan = core.analysisPlan('a task', { options: [LM], auto_configuration_id: null, assessment: LM }, {})
  assert.equal(plan.body.allow_external, false)
})

test('without an assessor the chat model analyses, and a manual choice is sent as such', () => {
  const none = { options: [GROQ, LM], auto_configuration_id: 'server:groq', assessment: null }
  const auto = core.analysisPlan('t', none, { chat: GROQ })
  assert.equal(auto.manual, false)
  assert.equal(auto.body.configuration_id, undefined)
  assert.equal(auto.body.expected_provider, 'groq')
  const manual = core.analysisPlan('t', none, { chat: LM })
  assert.equal(manual.manual, true)
  assert.equal(manual.body.configuration_id, 'server:lmstudio')
  assert.equal(manual.body.expected_model, 'local')
  assert.equal(manual.body.allow_external, false)
  assert.match(core.analysisPlan('t', none, {}).error, /no assessment model and no model was chosen/)
})

test('a re-analysis names its session and previous analysis; without a session it cannot', () => {
  const options = { options: [GROQ], auto_configuration_id: 'server:groq', assessment: GROQ }
  const again = core.analysisPlan('t', options, { sessionId: 's1', previousId: 'a1' })
  assert.equal(again.body.session_id, 's1')
  assert.equal(again.body.previous_analysis_id, 'a1')
  assert.equal(core.analysisPlan('t', options, { previousId: 'a1' }).body.previous_analysis_id, undefined)
})
