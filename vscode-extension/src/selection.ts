import * as vscode from 'vscode'
import { wholeLines, type CodeContext } from './codemsg'
import { fileName, isSecretFile } from './core'

export type Picked = { ok: true; ctx: CodeContext; first: number; last: number; uri?: vscode.Uri } | { ok: false; reason: 'no_editor' | 'no_selection' | 'secret_file'; name?: string }

/** The code selected in the active editor, widened to whole lines, with its file, language and lines (1-based in the context). */
export function readSelection(): Picked {
  const editor = vscode.window.activeTextEditor
  if (!editor) return { ok: false, reason: 'no_editor' }
  const name = fileName(editor.document.uri.path)
  // The same rule as Analyse: files that hold secrets by convention are never sent (release plan E2).
  if (isSecretFile(name)) return { ok: false, reason: 'secret_file', name }
  const selection = editor.selection
  if (!selection || selection.isEmpty) return { ok: false, reason: 'no_selection' }
  const { first, last } = wholeLines(selection.start, selection.end)
  const document = editor.document
  const code = Array.from({ length: last - first + 1 }, (_, i) => document.lineAt(first + i).text).join('\n')
  const path = vscode.workspace.asRelativePath?.(document.uri, false) ?? fileName(document.uri.path)
  return { ok: true, ctx: { path, languageId: document.languageId, startLine: first + 1, endLine: last + 1, code }, first, last, uri: document.uri }
}

/** What the chat button shows: `service.ts · 7–9`, or an empty text when nothing is selected. */
export function describeSelection(): string {
  const picked = readSelection()
  if (!picked.ok) return ''
  const { path, startLine, endLine } = picked.ctx
  return `${fileName(path)} · ${startLine === endLine ? startLine : `${startLine}–${endLine}`}`
}
