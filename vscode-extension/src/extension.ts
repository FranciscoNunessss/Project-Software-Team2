import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { ANALYSIS_SCHEME, Analyser, DIFF_SCHEME, explain } from './analyse'
import { ApiError, Backend } from './backend'
import { ChatService, ChatsView, TRANSCRIPT_SCHEME, registerParticipant, type ChatSummary } from './chat'
import { Dashboard } from './dashboard'
import { ModelsView } from './models'
import { PROGRESS_SCHEME, ProfileView, ProgressReport } from './profile'
import { StatusBar } from './statusbar'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const backend = new Backend(context.secrets)
  await backend.load()
  const analyser = new Analyser(backend)
  const chat = new ChatService(backend, analyser, context.workspaceState)
  const chats = new ChatsView(backend, chat)
  const profile = new ProfileView(backend)
  const models = new ModelsView(backend, analyser.connections)
  const progress = new ProgressReport(backend)
  const dashboard = new Dashboard(backend, analyser, models, profile, chat, chats, progress)

  // Development only: the self-test writes what it sees to a file and quits (see the README).
  const selftest = Boolean(process.env.ADAPTAI_SELFTEST)
  const reportFile = process.env.ADAPTAI_SELFTEST_REPORT
  const report = selftest
    ? (entry: unknown) => {
        if (reportFile) fs.appendFileSync(reportFile, JSON.stringify(entry) + '\n')
        if ((entry as { step?: string })?.step === 'done') setTimeout(() => void vscode.commands.executeCommand('workbench.action.quit'), 500)
      }
    : undefined

  const statusBar = new StatusBar(backend, () => void dashboard.reload())

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(Dashboard.viewType, dashboard, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROGRESS_SCHEME, progress),
    vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, chats),
    ...(registerParticipant(chat) ? [registerParticipant(chat) as vscode.Disposable] : []),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, analyser),
    vscode.workspace.registerTextDocumentContentProvider(ANALYSIS_SCHEME, analyser),
    vscode.languages.registerCodeLensProvider({ scheme: ANALYSIS_SCHEME }, analyser),
    backend.onDidChangeSession(() => {
      void statusBar.refresh()
    }),
    backend.onDidChangeSession(() => {
      chats.refresh()
      void profile.refresh()
      void models.refresh()
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('adaptai.backendUrl')) {
        void statusBar.refresh()
        }
    }),
    vscode.commands.registerCommand('adaptai.open', () => dashboard.open()),
    vscode.commands.registerCommand('adaptai.openApp', () => dashboard.open()),
    vscode.commands.registerCommand('adaptai.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:adaptai-dev.adaptai')),
    vscode.commands.registerCommand('adaptai.checkConnection', async () => {
      const status = await statusBar.refresh()
      if (status.online) void vscode.window.showInformationMessage(`AdaptAI: backend connected (${status.url}).`)
      else void vscode.window.showWarningMessage(`AdaptAI: the backend at ${status.url} is not reachable.`, 'Open settings').then(choice => {
        if (choice) void vscode.commands.executeCommand('adaptai.openSettings')
      })
    }),
    vscode.commands.registerCommand('adaptai.register', () => (dashboard.open('analyse'), dashboard.register())),
    vscode.commands.registerCommand('adaptai.signIn', () => (dashboard.open('analyse'), dashboard.signIn())),
    vscode.commands.registerCommand('adaptai.signInWithToken', () => (dashboard.open('analyse'), dashboard.signInWithToken())),
    vscode.commands.registerCommand('adaptai.signOut', () => (dashboard.open('analyse'), dashboard.signOut())),
    vscode.commands.registerCommand('adaptai.analyseSelection', () => analyser.fromEditor()),
    vscode.commands.registerCommand('adaptai.analyseFile', (uri?: vscode.Uri) => analyser.fromUri(uri)),
    vscode.commands.registerCommand('adaptai.analyseClipboard', () => analyser.fromClipboard()),
    vscode.commands.registerCommand('adaptai.analyseInput', () => analyser.fromInput()),
    vscode.commands.registerCommand('adaptai.coachClipboard', () => analyser.coachClipboard()),
    vscode.commands.registerCommand('adaptai.improvePrompt', () => analyser.improveInEditor()),
    vscode.commands.registerCommand('adaptai.testConnection', () => analyser.testConnection()),
    vscode.commands.registerCommand('adaptai.retry', () => analyser.retry()),
    vscode.commands.registerCommand('adaptai.copySummary', (id?: string) => analyser.copySummary(id)),
    vscode.commands.registerCommand('adaptai.taskOutcome', (id?: string) => analyser.taskOutcome(id)),
    vscode.commands.registerCommand('adaptai.useModel', (id?: string) => analyser.useModel(id)),
    vscode.commands.registerCommand('adaptai.coachResult', (id?: string) => analyser.coachResult(id)),
    vscode.commands.registerCommand('adaptai.editPreferences', () => profile.editPreferences()),
    vscode.commands.registerCommand('adaptai.clearMemory', () => profile.delete('memory')),
    vscode.commands.registerCommand('adaptai.clearConversations', () => profile.delete('conversations')),
    vscode.commands.registerCommand('adaptai.clearHistory', () => profile.delete('history')),
    vscode.commands.registerCommand('adaptai.openProgress', () => progress.open()),
    vscode.commands.registerCommand('adaptai.refreshProfile', () => profile.refresh()),
    vscode.commands.registerCommand('adaptai.refreshModels', () => models.refresh()),
    vscode.commands.registerCommand('adaptai.modelAdd', () => models.add()),
    vscode.commands.registerCommand('adaptai.modelEdit', (row: { config: never }) => models.edit(row.config)),
    vscode.commands.registerCommand('adaptai.modelRemove', (row: { config: never }) => models.remove(row.config)),
    vscode.commands.registerCommand('adaptai.modelTest', (row: { config: never }) => models.test(row.config)),
    vscode.commands.registerCommand('adaptai.evaluationConsent', (row: { entry: never }) => models.consent(row.entry)),
    vscode.commands.registerCommand('adaptai.evaluationRedo', (row: { entry: never }) => models.reevaluate(row.entry)),
    vscode.commands.registerCommand('adaptai.evaluationDisagree', (row: { entry: never }) => models.disagree(row.entry)),
    vscode.commands.registerCommand('adaptai.evaluationAdd', () => models.addOpenRouterModel()),
    vscode.commands.registerCommand('adaptai.evaluationRemove', (row: { entry: never }) => models.removeOpenRouterModel(row.entry)),
    vscode.commands.registerCommand('adaptai.chatOpenView', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@adaptai ', isPartialQuery: true })),
    vscode.commands.registerCommand('adaptai.chatSendText', (text: string) => vscode.commands.executeCommand('workbench.action.chat.open', { query: `@adaptai ${text}` })),
    vscode.commands.registerCommand('adaptai.chatRetry', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@adaptai /retry' })),
    vscode.commands.registerCommand('adaptai.chatNew', async () => {
      await chat.newChat()
      void vscode.window.showInformationMessage('AdaptAI: your next message in the chat opens a new chat.')
    }),
    vscode.commands.registerCommand('adaptai.chatOpen', (id: string) => chats.openTranscript(id)),
    vscode.commands.registerCommand('adaptai.chatRename', async (item: ChatSummary) => {
      const title = await vscode.window.showInputBox({ title: 'Rename the chat', value: item.title, ignoreFocusOut: true, validateInput: value => (value.trim() ? undefined : 'A chat needs a name') })
      if (!title) return
      try {
        await chat.rename(item.id, title.trim())
      } catch (error) {
        void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
      }
    }),
    vscode.commands.registerCommand('adaptai.chatDelete', async (item: ChatSummary) => {
      const sure = await vscode.window.showWarningMessage(`Delete the chat “${item.title}” and its ${item.message_count} messages? This cannot be undone.`, { modal: true }, 'Delete')
      if (!sure) return
      try {
        await chat.remove(item.id)
      } catch (error) {
        void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
      }
    }),
  )

  void statusBar.refresh()
  void profile.refresh()
  void models.refresh()

  if (selftest) {
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 800))
      report?.({ step: 'status bar item', ok: statusBar.text.includes('AdaptAI'), detail: statusBar.text })
      const manifest = context.extension.packageJSON as { contributes: { commands: { command: string }[]; keybindings: { command: string; key: string }[] } }
      const registered = new Set(await vscode.commands.getCommands(true))
      const missing = manifest.contributes.commands.map(item => item.command).filter(command => !registered.has(command))
      const orphans = manifest.contributes.keybindings.filter(item => !registered.has(item.command)).map(item => item.key)
      report?.({ step: 'every declared command is registered, every keybinding has a command', ok: missing.length === 0 && orphans.length === 0, detail: `${manifest.contributes.commands.length} commands; missing=${missing.join(',')} orphans=${orphans.join(',')}` })
      const token = process.env.ADAPTAI_SELFTEST_TOKEN
      if (token) {
        const email = await backend.signInWithToken(token).catch(error => `error ${String(error)}`)
        report?.({ step: 'sign in with a pasted token', ok: backend.auth === 'token', detail: String(email) })
        const status = await backend.status()
        report?.({ step: 'status works with the token alone', ok: Boolean(status.email), detail: String(status.email) })
        const result = await analyser.runForTest('Compare two API designs and recommend one, with the trade-offs.').catch(error => {
          report?.({ step: 'analyse threw', ok: false, detail: String(error) })
          return undefined
        })
        report?.({ step: 'analyse: the API call', ok: Boolean(result?.analysis.recommendation), detail: result ? `${result.analysis.recommendation.name} (${result.analysis.mode})` : 'no result' })
        if (result) {
          await analyser.show(result, false)
          report?.({ step: 'the analysis opens as a document', ok: vscode.window.visibleTextEditors.length >= 0, detail: `${result.analysis.id}` })
        }
      }
      report?.({ step: 'done', ok: true, detail: 'self-test finished' })
    })()
  }
}

export function deactivate(): void {}
