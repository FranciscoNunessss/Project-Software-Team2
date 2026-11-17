// The page shows what the web app shows. The fixture is a real answer of develop (c249595) to
// POST /api/analyze for a task, with a measured LM Studio model, as the web app displayed it; the
// expectations are the words of that web page (AnalysisDrawer, AnalysisResult, TipsCard, AnalysisChanges).
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')
installVscode({ backendUrl: 'http://127.0.0.1:1' })
const { richResult } = require('../dist/dashboard.js')
const fixture = require('./fixtures/develop-lmstudio-analysis.json').design

const rich = richResult({ task: fixture.task, analysis: fixture.analysis, truncated: false, at: '12:00', source: 'typed text', coachAvailable: true })

test('the recommended model card says what the web card says', () => {
  assert.equal(rich.heading, 'Provisional recommendation')
  assert.equal(rich.name, 'gemma4-12b-qat-uncensored-hauhaucs-balanced')
  assert.equal(rich.sub, 'LM Studio · gemma4-12b-qat-uncensored-hauhaucs-balanced · Low cost · local')
  assert.equal(rich.statusText, 'Falls short')
  assert.deepEqual(rich.coverage.map(c => [c.need, c.task, c.level, c.covers]), [
    ['Reasoning', '3', 1, 'No'],
    ['Context', '2', 2, 'Yes'],
    ['Domain knowledge', '2', 3, 'Yes'],
    ['Reliability', '2', 3, 'Yes'],
    ['Tools', '1', 3, 'Yes'],
  ])
  assert.equal(rich.footnote, '* Level from public benchmarks or the automatic measurement, not reviewed by the team yet.')
  assert.equal(rich.levelsFrom, 'Measured by AdaptAI (measure-suite-1)')
  assert.equal(rich.assessedBy, "Task assessed by gemma4-12b-qat-uncensored-hauhaucs-balanced (the project's assessor; your chat model answers)")
  assert.deepEqual(rich.notes, ['None of your models covers reasoning 3: add a more capable model or split the task.'])
  assert.match(rich.rationale, /^None of your models covers this task\./)
  assert.equal(rich.usable, true)
})

test('the complexity profile has the web labels, levels, confidence, evidence, explanation and modality', () => {
  assert.equal(rich.tag, 'Uncalibrated')
  assert.deepEqual(rich.profile.map(p => [p.label, p.score, p.confidence]), [
    ['Reasoning depth', 3, 'high'],
    ['Context demand', 2, 'high'],
    ['Ambiguity', 2, 'high'],
    ['Domain specificity', 2, 'high'],
    ['Risk of error', 2, 'high'],
    ['Tool / integration need', 1, 'high'],
  ])
  assert.match(rich.profile[0].evidence, /^The task requires managing multiple interacting dependencies/)
  assert.match(rich.explanation, /^This is an architectural design task/)
  assert.deepEqual({ ...rich.modality }, { required: ['text'], confidence: 'high', evidence: 'The output requires a text-based architectural description and comparison.' })
})

test('completeness, guidance, tips, warnings and the footer are the web ones', () => {
  assert.equal(rich.completeness, 92)
  assert.equal(rich.hasPrevious, false)
  assert.deepEqual(rich.guidance, ['Use authoritative domain references; model size alone does not ensure expertise.'])
  assert.deepEqual(rich.tips.map(t => t.title), ['Ambiguity', 'Reasoning', 'Context'])
  assert.deepEqual(rich.warnings, ['Model capability levels are provisional until the team calibrates them.', 'The assessment has not been calibrated or validated.'])
  assert.equal(rich.meta, 'semantic · lmstudio · 20612 ms · Policy needs-capabilities-1')
})

test('an illustrative recommendation is labelled as one and cannot be used', () => {
  const demo = JSON.parse(JSON.stringify(fixture.analysis))
  demo.mode = 'demonstration'
  demo.recommendation = { ...demo.recommendation, name: 'Illustrative balanced model', label: 'Illustrative balanced model', illustrative: true, configuration_id: null, local: false, free: false, cost_band: 'medium' }
  const result = richResult({ task: 'x', analysis: demo, truncated: false, at: '12:00', source: 'typed text', coachAvailable: false })
  assert.equal(result.tag, 'Heuristic demo')
  assert.equal(result.illustrative, true)
  assert.equal(result.usable, false)
  assert.match(result.sub, /Medium cost · illustrative$/)
  assert.match(result.footnote, /^\* Illustrative level of a demo model/)
})
