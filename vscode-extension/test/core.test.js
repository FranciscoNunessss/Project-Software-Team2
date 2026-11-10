const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../dist/core.js')

test('a token is recognised by its prefix and shape', () => {
  assert.equal(core.looksLikeToken('adaptai_pat_' + 'a'.repeat(43)), true)
  assert.equal(core.looksLikeToken('adaptai_pat_short'), false)
  assert.equal(core.looksLikeToken('Bearer adaptai_pat_' + 'a'.repeat(43)), false)
  assert.equal(core.looksLikeToken('gsk_' + 'a'.repeat(40)), false)
})

test('html is escaped', () => {
  assert.equal(core.escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;')
})

test('a remote backend must use https; local may use http', () => {
  assert.equal(core.checkBackendUrl('http://127.0.0.1:8000').ok, true)
  assert.equal(core.checkBackendUrl('http://localhost:8000/').ok, true)
  assert.equal(core.checkBackendUrl('https://adaptai.example.org').ok, true)
  assert.equal(core.checkBackendUrl('http://adaptai.example.org').ok, false)
  assert.equal(core.checkBackendUrl('ftp://x').ok, false)
  assert.equal(core.checkBackendUrl('nope').ok, false)
  assert.equal(core.checkBackendUrl('https://a.example/api/').url, 'https://a.example/api')
})

test('the task is the selection, else the file, cut at the API limit', () => {
  assert.deepEqual(core.taskFrom('  hi ', 'whole file'), { text: 'hi', source: 'selection', truncated: false })
  assert.deepEqual(core.taskFrom('  ', 'whole file\n'), { text: 'whole file', source: 'file', truncated: false })
  const long = core.taskFrom('', 'x'.repeat(9000))
  assert.equal(long.text.length, 8000)
  assert.equal(long.truncated, true)
})

test('applyEdit replaces the quote once and refuses a missing quote', () => {
  assert.equal(core.applyEdit('write a poem about the sea', { quote: 'a poem', replacement: 'a haiku' }), 'write a haiku about the sea')
  assert.equal(core.applyEdit('abc', { quote: 'zzz', replacement: 'x' }), undefined)
  assert.equal(core.applyEdit('abc', { quote: null, replacement: 'x' }), undefined)
})

test('improvedText: rewrite, edits applied in order, tips never change the text', () => {
  const coach = {
    status: 'ok', fallback: false, dropped: 0, open_questions: [], rewrite: 'better text',
    suggestions: [
      { dimension: 'context', kind: 'edit', title: 'a', rationale: 'r', quote: 'poem', replacement: 'haiku' },
      { dimension: 'risk', kind: 'tip', title: 'b', rationale: 'r', quote: null, replacement: null },
      { dimension: 'domain', kind: 'edit', title: 'c', rationale: 'r', quote: 'sea', replacement: 'ocean' },
    ],
  }
  assert.equal(core.improvedText('a poem on the sea', coach, 'rewrite'), 'better text')
  assert.equal(core.improvedText('better text', coach, 'rewrite'), undefined)
  assert.equal(core.improvedText('a poem on the sea', coach, 'edits'), 'a haiku on the ocean')
  assert.equal(core.improvedText('nothing matches', coach, 'edits'), undefined)
  assert.equal(core.improvedText('a poem on the sea', coach, 'tips'), undefined)
})

test('text that looks like a secret is flagged; ordinary prompts are not', () => {
  assert.deepEqual(core.secretsIn('Write a poem about the sea and compare two API designs'), [])
  assert.ok(core.secretsIn('use key sk-or-v1-' + 'a'.repeat(40)).length)
  assert.ok(core.secretsIn('GROQ=' + 'gsk_' + 'b'.repeat(30)).length)
  assert.ok(core.secretsIn('-----BEGIN RSA PRIVATE KEY-----\nabc').length)
  assert.ok(core.secretsIn('password = hunter2hunter2').length)
  assert.ok(core.secretsIn('Authorization: ' + 'adaptai_pat_' + 'c'.repeat(43)).length)
  assert.deepEqual(core.secretsIn('how should I store a password safely?'), [])
})

test('secret files are never sent', () => {
  for (const name of ['.env', '.env.local', 'server.pem', 'id_rsa', '.npmrc', 'cert.key']) assert.equal(core.isSecretFile(name), true, name)
  for (const name of ['prompt.md', 'environment.ts', 'main.py', 'keys.md']) assert.equal(core.isSecretFile(name), false, name)
})
