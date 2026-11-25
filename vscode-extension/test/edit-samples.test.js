// The 10 sample edits that measure how often a model answers a change request in a usable way (release plan
// task E1: well-formed rate per model). This tests the samples and the scoring offline; `measure-edits.cjs`
// runs them against a real backend and model.
const test = require('node:test')
const assert = require('node:assert/strict')
const { SAMPLES, scoreAnswer, summarise } = require('./edit-samples.cjs')

const block = (code, lang = 'text') => '```' + lang + '\n' + code + '\n```'

test('e1 there are 10 samples, each with an instruction, code, a check and a reference answer', () => {
  assert.equal(SAMPLES.length, 10)
  assert.equal(new Set(SAMPLES.map(sample => sample.id)).size, 10)
  for (const sample of SAMPLES) {
    assert.ok(sample.instruction && sample.code.trim() && sample.reference.trim(), sample.id)
    assert.equal(typeof sample.check, 'function', sample.id)
  }
})

test('e1 the reference answer of every sample is well formed and passes its own check, and the original does not', () => {
  for (const sample of SAMPLES) {
    const good = scoreAnswer(sample, `Done.\n${block(sample.reference, sample.language)}`)
    assert.equal(good.wellFormed, true, sample.id + ' reference is not well formed')
    assert.equal(good.passed, true, sample.id + ' reference does not pass its check')
    assert.equal(sample.check(sample.code), false, sample.id + ' the original already passes: the sample proves nothing')
  }
})

test('e1 an answer is well formed only with exactly one closed, non-empty code block', () => {
  const sample = SAMPLES[0]
  assert.deepEqual(scoreAnswer(sample, 'No code here.'), { wellFormed: false, passed: false, reason: 'none' })
  assert.equal(scoreAnswer(sample, `${block('a')}\n${block('b')}`).reason, 'several')
  assert.equal(scoreAnswer(sample, '```ts\n```').wellFormed, false)
  assert.equal(scoreAnswer(sample, '```ts\nunclosed').reason, 'none')
  const unrelated = scoreAnswer(sample, block('const x = 1'))
  assert.equal(unrelated.wellFormed, true)
  assert.equal(unrelated.passed, false, 'a well formed block that does not do the change must not pass')
})

test('e1 the summary gives the well-formed and passed rates per model', () => {
  const results = [
    { model: 'a', wellFormed: true, passed: true },
    { model: 'a', wellFormed: true, passed: false },
    { model: 'a', wellFormed: false, passed: false },
    { model: 'b', wellFormed: true, passed: true },
  ]
  assert.deepEqual(summarise(results), [
    { model: 'a', total: 3, wellFormed: 2, passed: 1, wellFormedRate: 2 / 3, passedRate: 1 / 3 },
    { model: 'b', total: 1, wellFormed: 1, passed: 1, wellFormedRate: 1, passedRate: 1 },
  ])
})
