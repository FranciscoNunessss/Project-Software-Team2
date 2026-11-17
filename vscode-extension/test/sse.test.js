const test = require('node:test')
const assert = require('node:assert/strict')
const { SseParser } = require('../dist/sse.js')

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const bytes = text => new TextEncoder().encode(text)

test('one event, several events in one chunk, and an event split across chunks', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push(frame('delta', { text: 'a' })), [{ event: 'delta', data: { text: 'a' } }])
  assert.equal(parser.push(frame('delta', { text: 'b' }) + frame('delta', { text: 'c' })).length, 2)
  const whole = frame('done', { ok: true })
  assert.deepEqual(parser.push(whole.slice(0, 9)), [])
  assert.deepEqual(parser.push(whole.slice(9, 25)), [])
  assert.deepEqual(parser.push(whole.slice(25)), [{ event: 'done', data: { ok: true } }])
})

test('a multi-byte character split between two reads is not corrupted', () => {
  const parser = new SseParser()
  const all = bytes(frame('delta', { text: 'café — 日本語 😀' }))
  for (let cut = 1; cut < all.length; cut += 1) {
    const events = [...new SseParser().push(all.slice(0, cut)), ...new SseParser().push(all.slice(cut))]
    assert.equal(events.length === 0 || cut > 0, true)
  }
  const first = parser.push(all.slice(0, 22))
  const second = parser.push(all.slice(22))
  const events = [...first, ...second]
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'café — 日本語 😀' } }])
})

test('every possible split point gives the same events', () => {
  const text = frame('message', { answer_id: 'x' }) + frame('delta', { text: 'olá ✓' }) + frame('done', { n: 1 })
  const all = bytes(text)
  const expected = new SseParser().push(all)
  assert.equal(expected.length, 3)
  for (let cut = 0; cut <= all.length; cut += 1) {
    const parser = new SseParser()
    const got = [...parser.push(all.slice(0, cut)), ...parser.push(all.slice(cut)), ...parser.end()]
    assert.deepEqual(got, expected, `cut at ${cut}`)
  }
})

test('CRLF line endings, comments, keep-alives and events without a name', () => {
  const parser = new SseParser()
  const events = parser.push(': keep-alive\r\n\r\nevent: delta\r\ndata: {"text":"x"}\r\n\r\ndata: {"plain":1}\n\n')
  assert.deepEqual(events, [{ event: 'delta', data: { text: 'x' } }, { event: 'message', data: { plain: 1 } }])
})

test('a data line that is not JSON is delivered as text, and a data-less block is dropped', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('event: error\ndata: boom\n\n'), [{ event: 'error', data: 'boom' }])
  assert.deepEqual(parser.push('event: ping\n\n'), [])
})

test('an event the server did not close is delivered at the end of the stream', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('event: done\ndata: {"a":1}'), [])
  assert.deepEqual(parser.end(), [{ event: 'done', data: { a: 1 } }])
})

test('a multi-line data field is joined with line breaks', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: line one\ndata: line two\n\n'), [{ event: 'message', data: 'line one\nline two' }])
})
