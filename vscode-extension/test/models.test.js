// The words of an evaluation's state and the consent text before a paid evaluation. The flows (add, edit, delete, test,
// consent, the OpenRouter catalogue) are tested through the page in dashboard-models.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const { describeEvaluation, consentText } = require('../dist/models.js')

const waiting = (id, estimate) => ({ provider: 'openai', model: 'gpt-5.4-mini', configuration_id: 'c1', shared: false, paid_by_you: true, picked: false, levels_source: 'LMArena public ranking', levels: { reasoning: 3, context: 3, domain: 2, reliability: 2, tools: 3 }, evaluation: { id, status: 'awaiting_consent', progress: 0, total: 40, errors: 0, failure: null, estimate, spent_usd: null, finished_at: null, levels: null } })
const done = { provider: 'groq', model: 'openai/gpt-oss-20b', configuration_id: null, shared: true, paid_by_you: false, picked: true, levels_source: 'measured', levels: { reasoning: 2, context: 2, domain: 2, reliability: 2, tools: 2 }, evaluation: { id: 'e-done', status: 'done', progress: 40, total: 40, errors: 0, failure: null, estimate: null, spent_usd: 0, finished_at: 't', levels: { reasoning: 2, context: 2, domain: 2, reliability: 2, tools: 2 } } }
const PAID = { calls_max: 40, input_tokens_max: 20000, output_tokens_max: 40960, price_known: true, free: false, estimated_usd: 0.1234, max_usd: 0.3 }
const UNKNOWN = { ...PAID, price_known: false, estimated_usd: null, max_usd: null }

test('each evaluation state is said in words the user can act on', () => {
  const base = { provider: 'p', model: 'm', configuration_id: 'c', shared: true, paid_by_you: false, levels_source: null, levels: null }
  const ev = (status, extra = {}) => ({ ...base, evaluation: { id: 'e', status, progress: 12, total: 40, errors: 0, failure: null, estimate: null, spent_usd: null, finished_at: null, levels: null, ...extra } })
  assert.equal(describeEvaluation({ ...base, evaluation: null }).text, 'Not evaluated')
  assert.match(describeEvaluation({ ...base, levels_source: 'LMArena', levels: { reasoning: 2 }, evaluation: null }).text, /Not measured · LMArena/)
  assert.deepEqual(describeEvaluation(ev('awaiting_consent')), { text: 'Waiting for your consent', icon: 'bell', consent: true })
  assert.equal(describeEvaluation(ev('running')).text, 'Evaluating 12/40')
  assert.equal(describeEvaluation(ev('queued')).text, 'Queued')
  assert.match(describeEvaluation(ev('done', { levels: { reasoning: 3, tools: 1 } })).text, /Measured by AdaptAI · R3 T1/)
  assert.match(describeEvaluation(ev('failed', { failure: 'provider_refused' })).text, /Evaluation failed \(provider refused\)/)
  assert.match(describeEvaluation(ev('declined')).text, /Declined/)
})

test('the consent says what is sent, the cost and its ceiling, and what declining means', () => {
  const text = consentText(waiting('e', PAID))
  assert.match(text, /Evaluate openai · gpt-5\.4-mini\?/)
  assert.match(text, /up to 40 synthetic tasks \(none of your text\) to openai with your key/)
  assert.match(text, /Estimated cost 0\.1234 USD, never more than 0\.3000 USD/)
  assert.match(text, /If you decline, you can still use the model in the chat/)
  assert.match(consentText(waiting('e', UNKNOWN)), /price of this model is not known/)
  assert.match(consentText(waiting('e', { ...PAID, free: true })), /It is free\./)
})
