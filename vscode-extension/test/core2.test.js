const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../dist/core.js')

test('servedBy: a result from another provider or model than the one chosen is flagged', () => {
  const option = { id: 'server:lmstudio', provider: 'lmstudio', label: 'LM Studio', model: 'm1', external: false, source: 'server' }
  assert.equal(core.servedBy({ provider: 'lmstudio', assessment_model: 'm1', configuration_id: 'server:lmstudio' }, option), undefined)
  assert.match(core.servedBy({ provider: 'groq', assessment_model: 'x' }, option), /came from groq/)
  assert.match(core.servedBy({ provider: 'lmstudio', assessment_model: 'other' }, option), /lmstudio · other/)
  assert.match(core.servedBy({ provider: 'lmstudio', assessment_model: 'm1', configuration_id: 'server:groq' }, option), /configuration server:groq/)
  assert.equal(core.servedBy({ provider: 'x', assessment_model: 'y' }, undefined), undefined)
})

test('every error code the backend uses has a plain message, and LM Studio ones are specific', () => {
  for (const code of ['external_processing_requires_consent', 'provider_not_configured', 'model_configuration_changed', 'model_not_compatible', 'invalid_provider_output', 'empty_answer', 'provider_output_truncated', 'provider_authentication', 'provider_rate_limit', 'provider_model_unavailable', 'provider_timeout', 'provider_unavailable', 'prompt_coach_disabled', 'analysis_not_found']) {
    assert.doesNotMatch(core.describeFailure(502, code), /answered 502/, code)
  }
  assert.match(core.describeFailure(401, 'authentication_required'), /Sign in/)
  assert.match(core.describeFailure(502, 'provider_unavailable', 'lmstudio'), /LM Studio could not be reached/)
  assert.match(core.describeFailure(502, 'provider_unavailable', 'groq'), /Groq/)
  assert.match(core.describeFailure(502, 'something_new'), /answered 502 \(something_new\)/)
})

test('LM Studio model list: loaded, missing, embedding only, malformed', () => {
  const base = 'http://127.0.0.1:1234'
  assert.deepEqual(core.checkLmStudioModels({ data: [{ id: 'a' }, { id: 'text-embedding-x' }] }, 'a', base), { ok: true, loaded: ['a'] })
  assert.match(core.checkLmStudioModels({ data: [{ id: 'b' }] }, 'a', base).reason, /is not loaded\. Loaded: b/)
  assert.match(core.checkLmStudioModels({ data: [{ id: 'text-embedding-x' }] }, 'a', base).reason, /no chat model/)
  assert.match(core.checkLmStudioModels({ nope: 1 }, 'a', base).reason, /not like LM Studio's model list/)
  assert.match(core.checkLmStudioModels(null, 'a', base).reason, /not like LM Studio's model list/)
  assert.equal(core.lmStudioModelsUrl('http://127.0.0.1:1234/v1').url, 'http://127.0.0.1:1234/v1/models')
  assert.equal(core.lmStudioModelsUrl('http://127.0.0.1:1234').url, 'http://127.0.0.1:1234/v1/models')
  assert.equal(core.lmStudioModelsUrl('http://lm.example.org').ok, false)
})

test('text is sent in NFC so the Coach quotes match', () => {
  assert.equal(core.taskFrom('', 'café au lait').text, 'café au lait')
})

test('connection labels: configured, tested, failed, and old', () => {
  assert.equal(core.connectionLabel(undefined), 'configured, not tested')
  assert.match(core.connectionLabel({ state: 'tested', at: Date.now(), ms: 1500 }), /connection tested OK at .*1\.5 s/)
  assert.match(core.connectionLabel({ state: 'tested', at: Date.now() - 20 * 60_000 }), /older than 10 min/)
  assert.match(core.connectionLabel({ state: 'failed', at: Date.now(), detail: 'boom' }), /last test failed at .*: boom/)
})

