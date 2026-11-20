// The message that carries selected code to the chat, and the answer that proposes a change.
// Requirements SEL-02, SEL-04, SEL-05, CHG-02, CHG-03, CHG-04, CHG-05 of docs/vscode-extension.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildMessage, splitMessage, extractProposal, fitProposal, wholeLines, MAX_MESSAGE } = require('../dist/codemsg.js')

const code = 'export function save(id, value) {\n  db.set(id, value)\n  return value\n}'
const ctx = { path: 'src/service.ts', languageId: 'typescript', startLine: 7, endLine: 10, code }

test('sel_02 an ask message holds what was typed, the file, the language, the lines and the code', () => {
  const built = buildMessage('ask', 'Explain this', ctx)
  assert.equal(built.ok, true)
  assert.ok(built.content.startsWith('Explain this'))
  assert.match(built.content, /Selection \(src\/service\.ts, typescript, lines 7-10\)/)
  assert.ok(built.content.includes(code))
  assert.equal(built.cut, false)
})

test('sel_02 one line is called line, not lines', () => {
  const built = buildMessage('ask', 'What is this?', { ...ctx, startLine: 4, endLine: 4, code: 'const a = 1' })
  assert.match(built.content, /typescript, line 4\)/)
})

test('sel_04 splitting gives back what was typed and the selection', () => {
  const parts = splitMessage(buildMessage('ask', 'Explain this', ctx).content)
  assert.equal(parts.text, 'Explain this')
  assert.deepEqual({ ...parts.selection }, { path: 'src/service.ts', languageId: 'typescript', startLine: 7, endLine: 10, code, kind: 'ask', cut: undefined })
})

test('sel_04 a message without a selection is left as it is', () => {
  assert.deepEqual({ ...splitMessage('Just a question') }, { text: 'Just a question' })
})

test('sel_04 code that contains a fence is fenced with a longer one and comes back whole', () => {
  const tricky = 'const s = `\n```\nhi\n```\n`'
  const parts = splitMessage(buildMessage('ask', 'Why?', { ...ctx, code: tricky }).content)
  assert.equal(parts.selection.code, tricky)
  assert.equal(parts.text, 'Why?')
})

test('sel_05 a long selection is cut at a line break and the message says how much was sent', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line number ${i} of a very long file`)
  const long = lines.join('\n')
  const built = buildMessage('ask', 'Summarise', { ...ctx, code: long })
  assert.equal(built.ok, true)
  assert.equal(built.cut, true)
  assert.ok(built.content.length <= MAX_MESSAGE)
  assert.match(built.content, /Selection cut: the first \d+ of \d+ characters are shown/)
  const sent = splitMessage(built.content).selection.code
  assert.ok(long.startsWith(sent) && long[sent.length] === '\n', 'the cut is at the end of a line')
})

test('sel_05 the text the user typed is never cut', () => {
  const typed = 'x'.repeat(MAX_MESSAGE - 20)
  assert.deepEqual({ ...buildMessage('ask', typed, ctx) }, { ok: false, reason: 'too_large' })
})

test('chg_02 a change message carries the instruction, the rule and every selected line', () => {
  const built = buildMessage('change', 'Throw if id is empty', ctx)
  assert.equal(built.ok, true)
  assert.match(built.content, /exactly one code block/)
  assert.ok(built.content.includes(code))
  assert.equal(splitMessage(built.content).selection.kind, 'change')
  assert.equal(splitMessage(built.content).text, 'Throw if id is empty')
})

test('chg_05 a change that does not fit is refused, never cut', () => {
  const big = Array.from({ length: 400 }, (_, i) => `line number ${i} of a very long file`).join('\n')
  assert.deepEqual({ ...buildMessage('change', 'Rename things', { ...ctx, code: big }) }, { ok: false, reason: 'too_large' })
})

test('chg_02 the selection is widened to whole lines', () => {
  assert.deepEqual({ ...wholeLines({ line: 6, character: 4 }, { line: 8, character: 2 }) }, { first: 6, last: 8 })
  assert.deepEqual({ ...wholeLines({ line: 6, character: 0 }, { line: 6, character: 9 }) }, { first: 6, last: 6 })
})

test('chg_02 a selection that ends at the start of a line does not take that line', () => {
  assert.deepEqual({ ...wholeLines({ line: 6, character: 0 }, { line: 9, character: 0 }) }, { first: 6, last: 8 })
})

test('chg_03 exactly one closed code block is a proposal', () => {
  const answer = 'Added a check.\n\n```ts\nexport function save(id) {\n  if (!id) throw new Error("id")\n}\n```\n'
  assert.deepEqual({ ...extractProposal(answer) }, { ok: true, code: 'export function save(id) {\n  if (!id) throw new Error("id")\n}' })
})

test('chg_03 no block, several blocks, an empty block and an unfinished block are not proposals', () => {
  assert.deepEqual({ ...extractProposal('Just words.') }, { ok: false, reason: 'none' })
  assert.deepEqual({ ...extractProposal('```\na\n```\nand\n```\nb\n```') }, { ok: false, reason: 'several' })
  assert.deepEqual({ ...extractProposal('```\n\n```') }, { ok: false, reason: 'empty' })
  assert.deepEqual({ ...extractProposal('```\nunfinished') }, { ok: false, reason: 'none' })
})

test('chg_03 a block that contains a shorter fence is still one block', () => {
  const answer = '````md\nuse ```js``` here\n```\ninner\n```\n````'
  const found = extractProposal(answer)
  assert.equal(found.ok, true)
  assert.ok(found.code.includes('inner'))
})

test('chg_04 blank lines at the start and the end of the selection are kept', () => {
  const original = '\nfunction a() {}\n\n'
  assert.equal(fitProposal(original, 'function a(x) {}'), '\nfunction a(x) {}\n\n')
  assert.equal(fitProposal(original, '\n\nfunction a(x) {}\n'), '\nfunction a(x) {}\n\n')
})

test('chg_04 the indentation of the proposal is left alone', () => {
  assert.equal(fitProposal('  a()', '  b()\n    c()'), '  b()\n    c()')
})
