import * as vscode from 'vscode'
import { Backend, type Status } from './backend'

/** The AdaptAI item at the bottom of the window: one click opens the app; its colour shows the backend state. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private timer: NodeJS.Timeout | undefined
  last: Status | undefined

  constructor(private readonly backend: Backend, private readonly onStatus: (status: Status) => void) {
    this.item = vscode.window.createStatusBarItem('adaptai.status', vscode.StatusBarAlignment.Right, 100)
    this.item.name = 'AdaptAI'
    this.item.command = 'adaptai.open'
    this.render(undefined)
    this.item.show()
    this.timer = setInterval(() => void this.refresh(), 60_000)
  }

  async refresh(): Promise<Status> {
    const status = await this.backend.status()
    this.render(status)
    this.onStatus(status)
    return status
  }

  get text(): string {
    return this.item.text
  }

  private render(status: Status | undefined): void {
    this.last = status
    if (!status) {
      this.item.text = '$(sparkle) AdaptAI'
      this.item.backgroundColor = undefined
      this.item.tooltip = 'AdaptAI: open the app'
      return
    }
    this.item.text = status.online ? '$(sparkle) AdaptAI' : '$(warning) AdaptAI'
    this.item.backgroundColor = status.online ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
    const who = status.rejected
      ? 'The stored token was rejected (revoked or expired). Run "AdaptAI: Sign in".'
      : status.foreign
        ? `Your saved sign-in belongs to ${status.foreign}, so it is not used here. Run "AdaptAI: Sign in".`
        : status.email
          ? `Signed in as ${status.email} (${status.auth === 'token' ? 'token' : 'session'})`
          : 'Not signed in'
    const offline = status.problem
      ? `The backend address cannot be used: ${status.problem}\n\nChange \`adaptai.backendUrl\`.`
      : `The backend at ${status.url} is not reachable.\n\nStart it, or change \`adaptai.backendUrl\`. Click to open the app anyway.`
    if (status.problem) this.item.text = '$(error) AdaptAI'
    this.item.tooltip = new vscode.MarkdownString(status.online ? `**AdaptAI**\n\nBackend connected (${status.url})\n\n${who}\n\nClick to open the app.` : `**AdaptAI**\n\n${offline}`)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.item.dispose()
  }
}
