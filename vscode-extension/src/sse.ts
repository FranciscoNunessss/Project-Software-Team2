// A Server-Sent Events parser that is safe with chunks: an event or even a UTF-8 character may be split
// between two reads. Pure: no VS Code import. The backend writes `event: name` and `data: {json}` lines
// (backend/app/chat.py `sse`), separated from the next event by a blank line.

export type SseEvent = { event: string; data: unknown }

export class SseParser {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')

  /** Feeds bytes (or text) and returns the events completed by them. */
  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    return this.drain()
  }

  /** At the end of the stream: an event the server did not close with a blank line is still delivered. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode()
    const events = this.drain()
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) {
      const event = parseBlock(rest)
      if (event) events.push(event)
    }
    return events
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = []
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    for (;;) {
      const end = this.buffer.indexOf('\n\n')
      if (end < 0) break
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const event = parseBlock(block)
      if (event) events.push(event)
    }
    return events
  }
}

function parseBlock(block: string): SseEvent | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // a comment or a keep-alive
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return undefined
  const text = data.join('\n')
  try {
    return { event, data: JSON.parse(text) }
  } catch {
    return { event, data: text }
  }
}
