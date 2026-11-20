// The message that carries selected code to the chat and the answer that proposes a change. Pure text
// work with no VS Code in it, so it is tested alone (docs/vscode-extension.md, "The code assistant").

/** The chat takes up to this many characters in one message (the backend's limit). */
export const MAX_MESSAGE = 8000

export type CodeContext = { path: string; languageId: string; startLine: number; endLine: number; code: string }
export type Built = { ok: true; content: string; cut: boolean; sent: number; total: number } | { ok: false; reason: 'too_large' }
export type SelectionView = { path: string; languageId: string; startLine: number; endLine: number; code: string; kind: 'ask' | 'change'; cut: { sent: number; total: number } | undefined }
export type Parsed = { text: string; selection?: SelectionView }
export type Proposal = { ok: true; code: string } | { ok: false; reason: 'none' | 'several' | 'empty' }

const RULE = '[Change request: reply with one short sentence and exactly one code block that replaces the selected lines. Keep the language and change nothing outside them.]'
const MARK = '\n\nSelection ('

/** A fence longer than any run of backticks at the start of a line of the code. */
function fenceFor(code: string): string {
  let longest = 0
  for (const line of code.split('\n')) longest = Math.max(longest, /^`+/.exec(line)?.[0].length ?? 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

const lineRange = (start: number, end: number): string => (start === end ? `line ${start}` : `lines ${start}-${end}`)

function block(ctx: CodeContext, code: string): string {
  const fence = fenceFor(code)
  return `${MARK.slice(2)}${ctx.path}, ${ctx.languageId}, ${lineRange(ctx.startLine, ctx.endLine)}):\n${fence}${ctx.languageId}\n${code}\n${fence}`
}

/**
 * The text the chat receives: what the user typed, then the selection with its file, language and lines.
 * An `ask` message that is too long loses the end of the code, at a line break, and says so. A `change`
 * message is never cut, because a cut selection could not be replaced safely.
 */
export function buildMessage(kind: 'ask' | 'change', text: string, ctx: CodeContext, limit = MAX_MESSAGE): Built {
  const code = ctx.code.replace(/\r\n/g, '\n')
  const head = kind === 'change' ? `${text}\n\n${RULE}` : text
  const whole = `${head}\n\n${block(ctx, code)}`
  if (whole.length <= limit) return { ok: true, content: whole, cut: false, sent: code.length, total: code.length }
  if (kind === 'change') return { ok: false, reason: 'too_large' }
  const total = code.length
  const noteRoom = 90
  const room = limit - `${head}\n\n${block(ctx, '')}`.length - noteRoom
  const at = room > 0 ? code.lastIndexOf('\n', room) : -1
  if (at < 1) return { ok: false, reason: 'too_large' }
  const kept = code.slice(0, at)
  const content = `${head}\n\n${block(ctx, kept)}\n[Selection cut: the first ${kept.length} of ${total} characters are shown.]`
  return { ok: true, content, cut: true, sent: kept.length, total }
}

/** A chat is titled with the start of its first message: cut the request rule and the code off it. */
export function cleanTitle(title: string): string {
  // The backend turns the line breaks of the first message into spaces, so the header is also found after a space:
  // a whole header, or a title cut short inside it (no closing bracket).
  const header = /\s+Selection \((?:[^)]*, [^,)]*, lines? \d|[^)]*$)/.exec(title)?.index ?? -1
  const cuts = [title.indexOf(' [Change request:'), title.indexOf('\n\nSelection ('), header].filter(index => index >= 0)
  return (cuts.length ? title.slice(0, Math.min(...cuts)) : title).trim()
}

/** The inverse of `buildMessage`: what the user typed, and the selection if the message carries one. */
export function splitMessage(content: string): Parsed {
  const at = content.lastIndexOf(MARK)
  if (at < 0) return { text: content }
  const rest = content.slice(at + 2)
  const newline = rest.indexOf('\n')
  const header = /^Selection \((.*), ([^,]*), lines? (\d+)(?:-(\d+))?\):$/.exec(rest.slice(0, newline))
  if (!header) return { text: content }
  const lines = rest.slice(newline + 1).split('\n')
  const open = /^(`{3,})/.exec(lines[0] ?? '')
  if (!open) return { text: content }
  let end = -1
  for (let i = lines.length - 1; i > 0; i--) if (lines[i] === open[1]) { end = i; break }
  if (end < 0) return { text: content }
  let text = content.slice(0, at)
  const kind: 'ask' | 'change' = text.endsWith(RULE) ? 'change' : 'ask'
  if (kind === 'change') text = text.slice(0, -RULE.length).replace(/\n+$/, '')
  const note = /^\[Selection cut: the first (\d+) of (\d+) characters are shown\.\]$/.exec(lines[end + 1] ?? '')
  return {
    text,
    selection: {
      path: header[1],
      languageId: header[2],
      startLine: Number(header[3]),
      endLine: Number(header[4] ?? header[3]),
      code: lines.slice(1, end).join('\n'),
      kind,
      cut: note ? { sent: Number(note[1]), total: Number(note[2]) } : undefined,
    },
  }
}

/** The one code block of an answer, if there is exactly one and it is closed and not empty. */
export function extractProposal(answer: string): Proposal {
  const lines = answer.replace(/\r\n/g, '\n').split('\n')
  const blocks: { code: string[]; closed: boolean }[] = []
  let open: { fence: string; code: string[] } | undefined
  for (const line of lines) {
    if (!open) {
      const start = /^\s{0,3}(`{3,})[^`]*$/.exec(line)
      if (start) open = { fence: start[1], code: [] }
    } else if (new RegExp('^\\s{0,3}`{' + open.fence.length + ',}\\s*$').test(line)) {
      blocks.push({ code: open.code, closed: true })
      open = undefined
    } else open.code.push(line)
  }
  if (open) blocks.push({ code: open.code, closed: false })
  if (blocks.length > 1) return { ok: false, reason: 'several' }
  if (!blocks.length || !blocks[0].closed) return { ok: false, reason: 'none' }
  const code = blocks[0].code.join('\n')
  if (!code.trim()) return { ok: false, reason: 'empty' }
  return { ok: true, code }
}

/** The proposal with the blank lines the selection had at its start and its end, so a replace leaves the spacing alone. */
export function fitProposal(original: string, proposed: string): string {
  const blank = (line: string) => line.trim() === ''
  const old = original.replace(/\r\n/g, '\n').split('\n')
  const core = proposed.replace(/\r\n/g, '\n').split('\n')
  let head = 0
  while (head < old.length - 1 && blank(old[head])) head++
  let tail = 0
  while (tail < old.length - 1 - head && blank(old[old.length - 1 - tail])) tail++
  while (core.length && blank(core[0])) core.shift()
  while (core.length && blank(core[core.length - 1])) core.pop()
  return [...old.slice(0, head), ...core, ...(tail ? old.slice(old.length - tail) : [])].join('\n')
}

/** The first and last line (0-based) of a selection widened to whole lines; a selection that ends at the start of a line leaves that line out. */
export function wholeLines(start: { line: number; character: number }, end: { line: number; character: number }): { first: number; last: number } {
  return { first: start.line, last: end.character === 0 && end.line > start.line ? end.line - 1 : end.line }
}
