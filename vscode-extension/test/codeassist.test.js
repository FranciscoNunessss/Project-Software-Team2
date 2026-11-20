// Suggest a change: the request built from the selection, and what is shown only when the answer is usable.
// Requirements CHG-01 to CHG-05 of docs/vscode-extension.md. The chat and the editor are replaced by small fakes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode, log } = installVscode({})
const { CodeAssist } = require('../dist/codeassist.js')

const code = '\nexport function save(id, value) {\n  db.set(id, value)\n}'
const picked = { ok: true, ctx: { path: 'src/service.ts', languageId: 'typescript', startLine: 6, endLine: 9, code }, first: 5, last: 8 }

function setup(answer, { outcome = 'ok', read = () => picked } = {}) {
  const sent = []
  const shown = []
  const chat = {
    outcome,
    async send(prompt, sink, _signal, _override, options) {
      sent.push({ prompt, options })
      sink.markdown(answer)
    },
  }
  const host = { show: async (first, last, proposed) => void shown.push({ first, last, proposed }) }
  log.warning.length = 0
  return { assist: new CodeAssist(chat, host, read), sent, shown }
}

const block = body => `Added a check.\n\n\`\`\`ts\n${body}\n\`\`\`\n`

test('chg_01 nothing selected: it says so and sends nothing', async () => {
  const { assist, sent, shown } = setup('', { read: () => ({ ok: false, reason: 'no_selection' }) })
  const result = await assist.suggest('Add validation')
  assert.equal(result.ok, false)
  assert.equal(sent.length + shown.length, 0)
  assert.match(log.warning[0].message, /select the code/i)
})

test('chg_01 an empty instruction asks for nothing', async () => {
  const { assist, sent } = setup('')
  vscode.window.showInputBox = async () => '   '
  await assist.suggestFromEditor()
  assert.equal(sent.length, 0)
})

test('chg_02 the request has the instruction, the rule and every selected line, and flags the code for the secret check', async () => {
  const { assist, sent } = setup(block('export function save() {}'))
  await assist.suggest('Throw if id is empty')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].prompt.startsWith('Throw if id is empty'))
  assert.match(sent[0].prompt, /exactly one code block/)
  assert.ok(sent[0].prompt.includes(code))
  assert.equal(sent[0].options.code, true)
})

test('chg_03 one code block is shown in place, over the selected lines', async () => {
  const { assist, shown } = setup(block('export function save(id) {\n  if (!id) throw new Error("id")\n}'))
  const result = await assist.suggest('Throw if id is empty')
  assert.equal(result.ok, true)
  assert.equal(shown.length, 1)
  assert.equal(shown[0].first, 5)
  assert.equal(shown[0].last, 8)
})

test('chg_03 an answer without exactly one code block changes nothing and says which problem it was', async () => {
  for (const [answer, reason, text] of [
    ['Just words.', 'none', /no code block/],
    ['```\na\n```\n```\nb\n```', 'several', /more than one/],
    ['```\n\n```', 'empty', /empty/],
  ]) {
    const { assist, shown } = setup(answer)
    const result = await assist.suggest('Do it')
    assert.deepEqual({ ...result }, { ok: false, reason })
    assert.equal(shown.length, 0)
    assert.match(log.warning[0].message, text)
  }
})

test('chg_03 a failed or stopped answer changes nothing', async () => {
  for (const outcome of ['failed', 'stopped', 'refused']) {
    const { assist, shown } = setup(block('x'), { outcome })
    const result = await assist.suggest('Do it')
    assert.equal(result.ok, false)
    assert.equal(shown.length, 0)
  }
})

test('chg_04 blank lines at the start and the end of the selection are kept in what is shown', async () => {
  const { assist, shown } = setup(block('export function save(id) {}'))
  await assist.suggest('Simplify')
  assert.ok(shown[0].proposed.startsWith('\nexport function save(id) {}'))
})

test('chg_05 a selection that does not fit in one message is refused before anything is sent', async () => {
  const big = { ...picked, ctx: { ...picked.ctx, code: Array.from({ length: 400 }, (_, i) => `line number ${i} of a very long file`).join('\n') } }
  const { assist, sent, shown } = setup(block('x'), { read: () => big })
  const result = await assist.suggest('Rename')
  assert.deepEqual({ ...result }, { ok: false, reason: 'too_large' })
  assert.equal(sent.length + shown.length, 0)
  assert.match(log.warning[0].message, /does not fit/)
})
