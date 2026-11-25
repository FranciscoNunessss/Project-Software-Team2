// The question reopens with the instruction that was asked. Requirement APP-07 of docs/vscode-extension.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { installVscode } = require('./helpers')

const { vscode } = installVscode({})

test('app_07 the question reopens with the instruction that was asked', async () => {
  const { CodeAssist } = require('../dist/codeassist.js')
  const asked = []
  vscode.window.showInputBox = async options => {
    asked.push(options.value)
    return undefined
  }
  const picked = { ok: true, ctx: { path: 'a.ts', languageId: 'typescript', startLine: 2, endLine: 2, code: 'b' }, first: 1, last: 1 }
  const chat = { outcome: 'ok', send: async (_text, sink) => sink.markdown('Done.\n```ts\nB\n```') }
  const host = { show: async () => undefined }
  const assist = new CodeAssist(chat, host, () => picked)
  await assist.suggest('Throw an error if id is empty')
  await assist.suggestFromEditor()
  assert.equal(asked[0], 'Throw an error if id is empty')
})
