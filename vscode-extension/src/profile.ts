import * as vscode from 'vscode'
import { Backend } from './backend'
import { explain } from './analyse'
import { renderProgress, type ProgressData } from './progress'

export const PROGRESS_SCHEME = 'adaptai-progress'

export type Settings = {
  content: string
  save_enabled: boolean
  use_enabled: boolean
  coaching_auto_enabled: boolean
  conversation_memory_enabled: boolean
  saved_conversations: number
  memory: unknown[]
}

type Key = 'save_enabled' | 'use_enabled' | 'conversation_memory_enabled' | 'coaching_auto_enabled' | 'coach' | 'auto_analyse'
/** Turning one of these on sends more of your text somewhere, so it asks first. */
export const CONSENT: Partial<Record<Key, string>> = {
  conversation_memory_enabled: 'Save task text and AI responses?\n\nNew task text, context and full AI responses will be stored on the backend, may be reused with memory, and may be sent to the assessor or the chat model. You can delete them at any time.',
  coaching_auto_enabled: 'Switch on automatic suggestions?\n\nThe Educator will send derived metadata (counts, scores, and saved excerpts if you saved text) to the project model after analyses, and may use its quota.',
}

/** The progress report is a read-only Markdown document, opened as a preview. */
export class ProgressReport implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.changed.event
  private text = '# My progress\n\nLoading…'
  private readonly uri = vscode.Uri.from({ scheme: PROGRESS_SCHEME, path: '/progress.md' })

  constructor(private readonly backend: Backend) {}

  provideTextDocumentContent(): string {
    return this.text
  }

  async open(): Promise<void> {
    if (this.backend.auth === 'none') return void vscode.window.showInformationMessage('AdaptAI: sign in first.')
    const get = <T>(path: string) => this.backend.api<T>(path, 'GET', undefined, AbortSignal.timeout(10_000)).catch(() => undefined)
    const data: ProgressData = {
      progress: await get('/api/progress'),
      dashboard: await get('/api/progress/dashboard'),
      outcomes: await get('/api/progress/outcomes'),
      learning: await get('/api/progress/learning'),
      coaching: await get('/api/progress/coaching'),
    }
    this.text = renderProgress(data)
    this.changed.fire(this.uri)
    await vscode.commands.executeCommand('markdown.showPreviewToSide', this.uri)
  }
}
