// The proposed change shown in place, accepted or rejected. The logic works on any text document
// (a small interface), so these tests run it on a string. Requirements APP-01 to APP-04 of
// docs/vscode-extension.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Review, Reviews } = require('../dist/review.js')

/** A text document in memory with the five things the review needs. */
function makeDoc(text, eol = '\n') {
  const doc = {
    text,
    eol,
    get lineCount() {
      return doc.text.split(eol).length
    },
    line: index => doc.text.split(eol)[index],
    async replace(startLine, startChar, endLine, endChar, insert) {
      const lines = doc.text.split(eol)
      const offset = (line, char) => lines.slice(0, line).reduce((sum, item) => sum + item.length + eol.length, 0) + char
      doc.text = doc.text.slice(0, offset(startLine, startChar)) + insert + doc.text.slice(offset(endLine, endChar))
      return true
    },
  }
  return doc
}

const file = ['import { db } from "../db"', '', 'export function save(id, value) {', '  db.set(id, value)', '}', '', 'export const answer = 42'].join('\n')
const proposed = 'export function save(id, value) {\n  if (!id) throw new Error("id")\n  db.set(id, value)\n}'

test('app_01 the proposal is written right below the original lines, which stay as they were', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  assert.deepEqual({ ...review.removed }, { first: 2, last: 4 })
  assert.deepEqual({ ...review.added }, { first: 5, last: 8 })
  const lines = file.split('\n')
  assert.equal(doc.text, [...lines.slice(0, 5), ...proposed.split('\n'), ...lines.slice(5)].join('\n'))
})

test('app_02 accept keeps the proposed lines and removes the original ones', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  assert.equal(await review.accept(), true)
  assert.equal(doc.text, ['import { db } from "../db"', '', proposed, '', 'export const answer = 42'].join('\n'))
  assert.equal(review.open, false)
})

test('app_02 reject gives back exactly the original text', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  assert.equal(await review.reject(), true)
  assert.equal(doc.text, file)
  assert.equal(review.open, false)
})

test('app_02 it works when the selection ends on the last line and the file has no final newline', async () => {
  const accept = makeDoc(file)
  const first = await Review.start(accept, 6, 6, 'export const answer = 43')
  assert.equal(await first.accept(), true)
  assert.equal(accept.text, file.replace('42', '43'))
  const reject = makeDoc(file)
  const second = await Review.start(reject, 6, 6, 'export const answer = 43')
  assert.equal(await second.reject(), true)
  assert.equal(reject.text, file)
})

test('app_02 it works when the selection is the whole file', async () => {
  const accept = makeDoc('a\nb')
  await (await Review.start(accept, 0, 1, 'c')).accept()
  assert.equal(accept.text, 'c')
  const reject = makeDoc('a\nb')
  await (await Review.start(reject, 0, 1, 'c')).reject()
  assert.equal(reject.text, 'a\nb')
})

test('app_02 the line ending of the file is kept', async () => {
  const doc = makeDoc('a\r\nb\r\nc', '\r\n')
  const review = await Review.start(doc, 1, 1, 'x\ny')
  assert.equal(doc.text, 'a\r\nb\r\nx\r\ny\r\nc')
  await review.accept()
  assert.equal(doc.text, 'a\r\nx\r\ny\r\nc')
})

test('app_03 only the selected lines change: the lines around them are the same after accept', async () => {
  const doc = makeDoc(file)
  await (await Review.start(doc, 2, 4, proposed)).accept()
  const after = doc.text.split('\n')
  assert.deepEqual(after.slice(0, 2), file.split('\n').slice(0, 2))
  assert.deepEqual(after.slice(-2), file.split('\n').slice(-2))
})

test('app_03 lines added above the proposal move it along, and accept still hits the right lines', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  await doc.replace(0, 0, 0, 0, '// header\n// more\n')
  review.change(0, 0, '// header\n// more\n')
  assert.deepEqual({ ...review.removed }, { first: 4, last: 6 })
  assert.equal(await review.accept(), true)
  assert.equal(doc.text, ['// header', '// more', 'import { db } from "../db"', '', proposed, '', 'export const answer = 42'].join('\n'))
})

test('app_03 a change below the proposal leaves it where it is', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  await doc.replace(10, 0, 10, 0, '// footer\n')
  review.change(10, 10, '// footer\n')
  assert.deepEqual({ ...review.removed }, { first: 2, last: 4 })
  assert.equal(await review.reject(), true)
  assert.equal(doc.text, file.replace('export const answer = 42', '// footer\nexport const answer = 42'))
})

test('app_03 a change inside the proposal ends the review and the text is left as it is', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  await doc.replace(3, 2, 3, 4, 'xx')
  assert.equal(review.change(3, 3, 'xx'), 'broken')
  assert.equal(review.open, false)
  const before = doc.text
  assert.equal(await review.accept(), false)
  assert.equal(await review.reject(), false)
  assert.equal(doc.text, before)
})

test('app_04 the lines to drop before a save bring the original back', async () => {
  const doc = makeDoc(file)
  const review = await Review.start(doc, 2, 4, proposed)
  const range = review.rejectRange()
  await doc.replace(range.startLine, range.startChar, range.endLine, range.endChar, '')
  assert.equal(doc.text, file)
})

test('app_04 a second proposal in the same file rejects the first one', async () => {
  const doc = makeDoc(file)
  const reviews = new Reviews()
  await reviews.show('file:///a.ts', doc, 2, 4, proposed)
  await reviews.show('file:///a.ts', doc, 6, 6, 'export const answer = 1')
  assert.equal(doc.text, [...file.split('\n').slice(0, 6), 'export const answer = 42', 'export const answer = 1'].join('\n'))
  assert.deepEqual({ ...reviews.get('file:///a.ts').removed }, { first: 6, last: 6 })
})

test('app_04 a proposal in another file does not touch the first one', async () => {
  const one = makeDoc(file)
  const two = makeDoc('x\ny')
  const reviews = new Reviews()
  await reviews.show('file:///a.ts', one, 2, 4, proposed)
  await reviews.show('file:///b.ts', two, 0, 0, 'z')
  assert.ok(reviews.get('file:///a.ts').open)
  assert.ok(reviews.get('file:///b.ts').open)
})
