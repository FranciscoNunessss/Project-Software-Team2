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
type Row =
  | { kind: 'toggle'; key: Key; label: string; description: string; tooltip: string; on: boolean }
  | { kind: 'action'; label: string; description?: string; icon: string; command: string; tooltip?: string }
  | { kind: 'info'; label: string; description?: string; icon: string; tooltip?: string }

/** What each switch means, in the words the app uses: what is kept, what is sent and to whom. */
const SWITCHES: Record<Key, { label: string; description: string; tooltip: string }> = {
  save_enabled: { label: 'Save learned memory', description: 'derived values only', tooltip: 'Records derived profile values and your model choices for later. No task text.' },
  use_enabled: { label: 'Use memory in analyses', description: 'sent with the analysis', tooltip: 'Lets your preferences and the latest learned metadata go with an analysis to the assessor.' },
  conversation_memory_enabled: { label: 'Save task text and AI responses', description: 'stored on the backend', tooltip: 'Stores new task text, task context and full AI responses on the backend. They can be reused with memory and sent to the assessor or the chat model. You can delete them below.' },
  coaching_auto_enabled: { label: 'Automatic suggestions', description: 'uses the project model', tooltip: 'Lets the Educator update your suggestions after analyses, sending derived metadata (and saved excerpts, if enabled) to the project model. It may use its quota.' },
  coach: { label: 'Prompt Coach', description: 'on by default', tooltip: 'The Coach helps describe a task. With it off, nothing is asked of a model.' },
  auto_analyse: { label: 'Always analyse before sending', description: 'in the chat', tooltip: 'Makes Send run an analysis first (it costs an analysis and an answer).' },
}

/** Turning one of these on sends more of your text somewhere, so it asks first. */
export const CONSENT: Partial<Record<Key, string>> = {
  conversation_memory_enabled: 'Save task text and AI responses?\n\nNew task text, context and full AI responses will be stored on the backend, may be reused with memory, and may be sent to the assessor or the chat model. You can delete them at any time.',
  coaching_auto_enabled: 'Switch on automatic suggestions?\n\nThe Educator will send derived metadata (counts, scores, and saved excerpts if you saved text) to the project model after analyses, and may use its quota.',
}

export class ProfileView implements vscode.TreeDataProvider<Row> {
  static readonly viewType = 'adaptai.profile'
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private context: Settings | undefined
  private coach = true
  private autoAnalyse = false
  private failed: string | undefined

  constructor(private readonly backend: Backend) {}

  async refresh(): Promise<void> {
    this.failed = undefined
    if (this.backend.auth === 'none') {
      this.context = undefined
      this.changed.fire()
      return
    }
    try {
      const signal = AbortSignal.timeout(8000)
      this.context = await this.backend.api<Settings>('/api/context', 'GET', undefined, signal)
      this.coach = (await this.backend.api<{ enabled: boolean }>('/api/prompt-coach/settings', 'GET', undefined, signal).catch(() => ({ enabled: true }))).enabled
      this.autoAnalyse = (await this.backend.api<{ auto_analyse: boolean }>('/api/chat/settings', 'GET', undefined, signal).catch(() => ({ auto_analyse: false }))).auto_analyse
    } catch (error) {
      this.failed = explain(error)
    }
    this.changed.fire()
  }

  getChildren(): Row[] {
    if (this.backend.auth === 'none') return [{ kind: 'info', label: 'Sign in to see your profile', icon: 'account', tooltip: 'Run AdaptAI: Sign in' }]
    if (this.failed) return [{ kind: 'info', label: this.failed, icon: 'warning' }]
    const c = this.context
    if (!c) return [{ kind: 'info', label: 'Loading…', icon: 'sync~spin' }]
    const toggle = (key: Key, on: boolean): Row => ({ kind: 'toggle', key, on, ...SWITCHES[key] })
    return [
      toggle('save_enabled', c.save_enabled),
      toggle('use_enabled', c.use_enabled),
      toggle('conversation_memory_enabled', c.conversation_memory_enabled),
      toggle('coaching_auto_enabled', c.coaching_auto_enabled),
      toggle('coach', this.coach),
      toggle('auto_analyse', this.autoAnalyse),
      { kind: 'action', label: 'Preferences', description: c.content ? c.content.slice(0, 60) : 'none', icon: 'edit', command: 'adaptai.editPreferences', tooltip: 'Free text the assessor may use when memory is on. Do not put sensitive information in it.' },
      { kind: 'action', label: 'Clear learned memory', description: `${c.memory.length} entries`, icon: 'trash', command: 'adaptai.clearMemory' },
      { kind: 'action', label: 'Delete stored conversations', description: `${c.saved_conversations} saved`, icon: 'trash', command: 'adaptai.clearConversations' },
      { kind: 'action', label: 'Delete all usage history', description: 'sessions, choices, memory, advice', icon: 'trash', command: 'adaptai.clearHistory' },
      { kind: 'action', label: 'My progress', icon: 'graph', command: 'adaptai.openProgress' },
      { kind: 'info', label: 'API tokens are managed in the app', icon: 'key', tooltip: 'A token cannot create or revoke tokens, so a stolen one cannot mint more. Use the app: Profile > API tokens.' },
    ]
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None)
    item.tooltip = 'tooltip' in row && row.tooltip ? row.tooltip : row.label
    item.description = row.description
    if (row.kind === 'toggle') {
      item.checkboxState = row.on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
      item.id = row.key
    } else {
      item.iconPath = new vscode.ThemeIcon(row.icon)
      if (row.kind === 'action') item.command = { command: row.command, title: row.label }
    }
    return item
  }

  // ---- changes --------------------------------------------------------------------------------

  /** A switch was ticked or unticked in the tree. Anything that sends more text asks first. */
  async setToggle(key: Key, on: boolean): Promise<void> {
    if (on && CONSENT[key]) {
      const ok = await vscode.window.showWarningMessage(CONSENT[key] as string, { modal: true }, 'Switch on')
      if (!ok) return this.refresh()
    }
    try {
      if (key === 'coach') await this.backend.api('/api/prompt-coach/settings', 'PUT', { enabled: on })
      else if (key === 'auto_analyse') await this.backend.api('/api/chat/settings', 'PUT', { auto_analyse: on })
      else await this.backend.api('/api/context', 'PUT', { [key]: on })
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  async editPreferences(): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'AdaptAI: preferences', prompt: 'Free text the assessor may use when memory is on (empty clears it). Do not enter sensitive information.', value: this.context?.content ?? '', ignoreFocusOut: true })
    if (value === undefined) return
    try {
      await this.backend.api('/api/context', 'PUT', { content: value })
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  /** The three deletions the app offers, each behind its own confirmation. */
  async delete(what: 'memory' | 'conversations' | 'history'): Promise<void> {
    const plan = {
      memory: { path: '/api/context/memory', text: 'Clear the learned memory? Your progress and preferences stay.' },
      conversations: { path: '/api/context/conversations', text: 'Delete the stored task text and AI responses, and the advice made from them? Numbers and settings stay.' },
      history: { path: '/api/progress/history', text: 'Delete all usage history: sessions, choices, learned memory and coaching advice? Your account, preferences and model configurations stay. This cannot be undone.' },
    }[what]
    const sure = await vscode.window.showWarningMessage(plan.text, { modal: true }, 'Delete')
    if (!sure) return
    try {
      await this.backend.api(plan.path, 'DELETE')
      void vscode.window.showInformationMessage('AdaptAI: done.')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }
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
