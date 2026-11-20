// A proposed change shown in place: the original lines stay, the proposed lines go right below them, and the
// user accepts (the proposal stays, the original goes) or rejects (the proposal goes). It works on any text
// document through a small interface, so it has no VS Code in it and is tested on a string
// (docs/vscode-extension.md, requirements APP-01 to APP-04).

/** What the review needs from a document. `replace` writes text over a range and says whether it worked. */
export interface TextDoc {
  readonly lineCount: number
  readonly eol: string
  line(index: number): string
  replace(startLine: number, startChar: number, endLine: number, endChar: number, text: string): Promise<boolean>
}

/** Lines `first` to `last`, both included, 0-based. */
export type Span = { first: number; last: number }
export type EditRange = { startLine: number; startChar: number; endLine: number; endChar: number }

export class Review {
  open = true

  private constructor(
    private readonly doc: TextDoc,
    public removed: Span,
    public added: Span,
    private readonly originalLines: string[],
    private readonly addedLines: string[],
  ) {}

  /** Writes the proposal below lines `first` to `last` of the document. Nothing else in the document is touched. */
  static async start(doc: TextDoc, first: number, last: number, proposed: string): Promise<Review | undefined> {
    const originalLines = Array.from({ length: last - first + 1 }, (_, i) => doc.line(first + i))
    const addedLines = proposed.replace(/\r\n/g, '\n').split('\n')
    const body = addedLines.join(doc.eol)
    const atEnd = last >= doc.lineCount - 1
    const done = atEnd ? await doc.replace(last, doc.line(last).length, last, doc.line(last).length, doc.eol + body) : await doc.replace(last + 1, 0, last + 1, 0, body + doc.eol)
    if (!done) return undefined
    return new Review(doc, { first, last }, { first: last + 1, last: last + addedLines.length }, originalLines, addedLines)
  }

  /** The range that removes whole lines, also when they are the last ones of the document. */
  private spanRange(span: Span): EditRange {
    if (span.last < this.doc.lineCount - 1) return { startLine: span.first, startChar: 0, endLine: span.last + 1, endChar: 0 }
    if (span.first > 0) return { startLine: span.first - 1, startChar: this.doc.line(span.first - 1).length, endLine: span.last, endChar: this.doc.line(span.last).length }
    return { startLine: 0, startChar: 0, endLine: span.last, endChar: this.doc.line(span.last).length }
  }

  private intact(): boolean {
    if (!this.open || this.added.last >= this.doc.lineCount) return false
    const same = (span: Span, lines: string[]) => lines.every((text, i) => this.doc.line(span.first + i) === text)
    return same(this.removed, this.originalLines) && same(this.added, this.addedLines)
  }

  /** The text of the document changed: lines `startLine` to `endLine` (before the change) became `text`. */
  change(startLine: number, endLine: number, text: string): 'moved' | 'same' | 'broken' {
    if (!this.open) return 'same'
    const delta = (text.match(/\n/g)?.length ?? 0) - (endLine - startLine)
    if (endLine < this.removed.first) {
      this.removed = { first: this.removed.first + delta, last: this.removed.last + delta }
      this.added = { first: this.added.first + delta, last: this.added.last + delta }
      return 'moved'
    }
    if (startLine > this.added.last) return 'same'
    this.open = false
    return 'broken'
  }

  /** The range to delete to bring the original back (it is also what a save applies before writing the file). */
  rejectRange(): EditRange {
    return this.spanRange(this.added)
  }

  private async drop(span: Span): Promise<boolean> {
    if (!this.intact()) {
      this.open = false
      return false
    }
    const range = this.spanRange(span)
    this.open = false
    return this.doc.replace(range.startLine, range.startChar, range.endLine, range.endChar, '')
  }

  /** Keeps the proposed lines, removes the original ones. */
  accept(): Promise<boolean> {
    return this.drop(this.removed)
  }

  /** Removes the proposed lines. */
  reject(): Promise<boolean> {
    return this.drop(this.added)
  }
}

/** One review at a time for each file. */
export class Reviews {
  private readonly map = new Map<string, Review>()

  /** A new proposal in a file that has one pending rejects the old one first. */
  async show(key: string, doc: TextDoc, first: number, last: number, proposed: string): Promise<Review | undefined> {
    const previous = this.map.get(key)
    if (previous?.open) await previous.reject()
    const review = await Review.start(doc, first, last, proposed)
    if (review) this.map.set(key, review)
    else this.map.delete(key)
    return review
  }

  get(key: string): Review | undefined {
    const review = this.map.get(key)
    return review?.open ? review : undefined
  }

  change(key: string, startLine: number, endLine: number, text: string): 'moved' | 'same' | 'broken' | undefined {
    const review = this.get(key)
    if (!review) return undefined
    const result = review.change(startLine, endLine, text)
    if (result === 'broken') this.map.delete(key)
    return result
  }

  forget(key: string): void {
    this.map.delete(key)
  }
}
