import * as vscode from 'vscode'
import { Backend } from './backend'

type Session = { id: string; title: string; created_at: string; analysis_count: number; choice_count: number }

/** "Recent analyses" in the AdaptAI side bar: your sessions, newest first. A click opens the app. */
export class HistoryView implements vscode.TreeDataProvider<Session> {
  static readonly viewType = 'adaptai.history'
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private failed = ''

  constructor(private readonly backend: Backend) {}

  refresh(): void {
    this.changed.fire()
  }

  async getChildren(): Promise<Session[]> {
    this.failed = ''
    if (this.backend.auth === 'none') return []
    try {
      return await this.backend.api<Session[]>('/api/sessions?limit=30', 'GET', undefined, AbortSignal.timeout(5000))
    } catch (error) {
      this.failed = error instanceof Error ? error.message : String(error)
      return []
    }
  }

  getTreeItem(session: Session): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None)
    const when = new Date(session.created_at)
    item.description = `${session.analysis_count} ${session.analysis_count === 1 ? 'analysis' : 'analyses'}`
    item.tooltip = `${when.toLocaleString()}\n${session.analysis_count} analyses · ${session.choice_count} choices`
    item.iconPath = new vscode.ThemeIcon('history')
    item.command = { command: 'adaptai.open', title: 'Open AdaptAI' }
    return item
  }
}
