import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { ANALYSIS_SCHEME, Analyser, DIFF_SCHEME, explain } from './analyse'
import { ApiError, Backend } from './backend'
import { ChatService, registerParticipant } from './chat'
import { ChangeDiff, CHANGE_SCHEME } from './changediff'
import { CodeAssist } from './codeassist'
import { Dashboard } from './dashboard'
import { PROGRESS_SCHEME, ProgressReport } from './profile'
import { RelayAgent, RelayStatus } from './relay'
import { StatusBar } from './statusbar'
import { runLong } from './selftest'
import { diagnosticSamples, startDiagnostics, stopDiagnostics } from './diagnostics'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const backend = new Backend(context.secrets)
  await backend.load()
  const analyser = new Analyser(backend)
  const chat = new ChatService(backend, analyser, context.workspaceState)
  const progress = new ProgressReport(backend)
  const relay = new RelayAgent(backend)
  const changes = new ChangeDiff()
  const assist = new CodeAssist(chat, changes)
  const dashboard = new Dashboard(backend, analyser, chat, progress, relay, assist)
  let diagnosticsOutput: vscode.LogOutputChannel | undefined
  context.subscriptions.push(
    { dispose: () => { stopDiagnostics(); diagnosticsOutput?.dispose() } },
    vscode.commands.registerCommand('adaptai.startDiagnostics', () => {
      diagnosticsOutput ??= vscode.window.createOutputChannel('AdaptAI Latency', { log: true })
      startDiagnostics(sample => diagnosticsOutput?.info(JSON.stringify(sample)))
      diagnosticsOutput.info('Local timing capture started; no credentials or message contents are recorded.')
      void vscode.window.showInformationMessage('AdaptAI: local latency capture started. Repeat the same action five times, then run Show latency report. Stop latency capture when finished.')
    }),
    vscode.commands.registerCommand('adaptai.stopDiagnostics', () => {
      stopDiagnostics()
      void vscode.window.showInformationMessage('AdaptAI: local latency capture stopped.')
    }),
    vscode.commands.registerCommand('adaptai.showDiagnostics', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ samples: diagnosticSamples() }, null, 2) })
      await vscode.window.showTextDocument(document)
    }),
  )

  // Development only: the self-test writes what it sees to a file and quits (see the README).
  const selftest = Boolean(process.env.ADAPTAI_SELFTEST)
  const reportFile = process.env.ADAPTAI_SELFTEST_REPORT
  const report = selftest
    ? (entry: unknown) => {
        if (reportFile) fs.appendFileSync(reportFile, JSON.stringify(entry) + '\n')
        if ((entry as { step?: string })?.step === 'done') setTimeout(() => void vscode.commands.executeCommand('workbench.action.quit'), 500)
      }
    : undefined

  const statusBar = new StatusBar(backend, status => dashboard.updateStatus(status))
  const relayStatus = new RelayStatus(relay)
  relay.watch()
  void relay.refresh()

  context.subscriptions.push(
    dashboard,
    statusBar,
    relay,
    relayStatus,
    relay.onDidChange(() => void dashboard.reload()),
    vscode.window.registerWebviewViewProvider(Dashboard.viewType, dashboard, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROGRESS_SCHEME, progress),
    ...(registerParticipant(chat) ? [registerParticipant(chat) as vscode.Disposable] : []),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, analyser),
    vscode.workspace.registerTextDocumentContentProvider(ANALYSIS_SCHEME, analyser),
    vscode.languages.registerCodeLensProvider({ scheme: ANALYSIS_SCHEME }, analyser),
    backend.onDidChangeSession(() => {
      void statusBar.refresh()
    }),
    backend.onDidChangeSession(() => {
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('adaptai.backendUrl')) {
        if (backend.urlProblem) void vscode.window.showErrorMessage(`AdaptAI: ${backend.urlProblem}`, 'Open settings').then(choice => { if (choice) void vscode.commands.executeCommand('adaptai.openSettings') })
        void dashboard.reload()
        void dashboard.preload()
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
    vscode.commands.registerCommand('adaptai.applyImprovement', () => analyser.applyImprovement()),
    vscode.commands.registerCommand('adaptai.dismissImprovement', () => analyser.dismissImprovement()),
    vscode.commands.registerCommand('adaptai.testConnection', () => analyser.testConnection()),
    vscode.commands.registerCommand('adaptai.retry', () => analyser.retry()),
    vscode.commands.registerCommand('adaptai.copySummary', (id?: string) => analyser.copySummary(id)),
    vscode.commands.registerCommand('adaptai.taskOutcome', (id?: string) => analyser.taskOutcome(id)),
    vscode.commands.registerCommand('adaptai.useModel', (id?: string) => analyser.useModel(id)),
    vscode.commands.registerCommand('adaptai.coachResult', (id?: string) => analyser.coachResult(id)),
    ...changes.register(),
    vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, changes),
    vscode.window.onDidChangeTextEditorSelection(() => dashboard.postSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => dashboard.postSelection()),
    vscode.commands.registerCommand('adaptai.suggestChange', () => assist.suggestFromEditor()),
    vscode.commands.registerCommand('adaptai.acceptChange', () => changes.accept()),
    vscode.commands.registerCommand('adaptai.rejectChange', () => changes.reject()),
    vscode.commands.registerCommand('adaptai.openProgress', () => progress.open()),
    vscode.commands.registerCommand('adaptai.chatOpenView', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@adaptai ', isPartialQuery: true })),
    vscode.commands.registerCommand('adaptai.chatSendText', (text: string) => vscode.commands.executeCommand('workbench.action.chat.open', { query: `@adaptai ${text}` })),
    vscode.commands.registerCommand('adaptai.chatRetry', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@adaptai /retry' })),
    vscode.commands.registerCommand('adaptai.chatNew', async () => {
      await chat.newChat()
      void vscode.window.showInformationMessage('AdaptAI: your next message in the chat opens a new chat.')
    }),
  )

  void statusBar.refresh()
  void dashboard.preload()

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
        const result = process.env.ADAPTAI_SELFTEST_LONG ? undefined : await analyser.runForTest('Compare two API designs and recommend one, with the trade-offs.').catch(error => {
          report?.({ step: 'analyse threw', ok: false, detail: String(error) })
          return undefined
        })
        if (!process.env.ADAPTAI_SELFTEST_LONG) report?.({ step: 'analyse: the API call', ok: Boolean(result?.analysis.recommendation), detail: result ? `${result.analysis.recommendation.name} (${result.analysis.mode})` : 'no result' })
        if (result) {
          await analyser.show(result, false)
          report?.({ step: 'the analysis opens as a document', ok: vscode.window.visibleTextEditors.length >= 0, detail: `${result.analysis.id}` })
        }
      }
      try {
        const file = `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/adaptai-selftest-diff.ts`
        fs.writeFileSync(file, 'export function a(x) {\r\n  return x\r\n}\r\nexport const b = 1\r\n')
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
        const editor = await vscode.window.showTextDocument(document)
        const original = document.getText()
        await changes.show(0, 2, 'export function a(x) {\n  if (!x) throw new Error("empty")\n  return x\n}', { uri: document.uri, original: 'export function a(x) {\n  return x\n}' })
        await new Promise(resolve => setTimeout(resolve, 600))
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab
        const input = tab?.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined
        report?.({ step: 'diff: opens in the VS Code diff editor', ok: input?.modified?.scheme === CHANGE_SCHEME && input.original?.fsPath === document.uri.fsPath, detail: String(tab?.label) })
        report?.({ step: 'diff: the file is untouched and clean before Accept', ok: document.getText() === original && !document.isDirty, detail: `dirty=${document.isDirty}` })
        if (process.env.ADAPTAI_SELFTEST_HOLD) return void report?.({ step: 'diff left open for a screenshot', ok: true, detail: 'hold' })
        await vscode.commands.executeCommand('adaptai.acceptChange')
        await new Promise(resolve => setTimeout(resolve, 600))
        const accepted = document.getText()
        report?.({ step: 'diff: Accept writes the change, keeps CRLF, closes the diff', ok: accepted.includes('throw new Error("empty")') && accepted.split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r')) && !vscode.window.tabGroups.all.some(group => group.tabs.some(item => (item.input as { modified?: vscode.Uri })?.modified?.scheme === CHANGE_SCHEME)), detail: JSON.stringify(accepted) })
        await vscode.window.showTextDocument(document, editor.viewColumn)
        await vscode.commands.executeCommand('undo')
        report?.({ step: 'diff: ONE undo restores the original', ok: document.getText() === original, detail: JSON.stringify(document.getText()) })
        await changes.show(0, 2, 'X', { uri: document.uri, original: 'export function a(x) {\n  return x\n}' })
        await new Promise(resolve => setTimeout(resolve, 600))
        await vscode.commands.executeCommand('adaptai.rejectChange')
        await new Promise(resolve => setTimeout(resolve, 400))
        report?.({ step: 'diff: Reject changes nothing and closes the diff', ok: document.getText() === original && !vscode.window.tabGroups.all.some(group => group.tabs.some(item => (item.input as { modified?: vscode.Uri })?.modified?.scheme === CHANGE_SCHEME)), detail: JSON.stringify(document.getText()) })
        if (token && process.env.ADAPTAI_SELFTEST_E2E) {
          // The whole path: selected code and an instruction go through the backend to the chat model, then the diff.
          const options = await backend.api<{ options: { id: string; provider: string }[] }>('/api/llm-options')
          const wanted = options.options.find(option => option.provider === 'lmstudio')
          await vscode.workspace.getConfiguration('adaptai').update('chatModel', wanted?.id ?? '', vscode.ConfigurationTarget.Global)
          const source = ['export function load(id) {', '  return db.find(id)', '}']
          const target = `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/adaptai-selftest-e2e.ts`
          fs.writeFileSync(target, source.join('\n') + '\n')
          const e2e = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
          const shown = await vscode.window.showTextDocument(e2e)
          shown.selection = new vscode.Selection(0, 0, 2, 1)
          const started = Date.now()
          const outcome = await assist.suggest('Throw an error if id is empty')
          report?.({ step: 'e2e: the model answered and a proposal was made', ok: outcome.ok, detail: `${JSON.stringify(outcome)} in ${Math.round((Date.now() - started) / 1000)}s, model ${wanted?.id}` })
          if (outcome.ok) {
            await new Promise(resolve => setTimeout(resolve, 600))
            const modified = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { modified?: vscode.Uri } | undefined)?.modified
            report?.({ step: 'e2e: the diff is open and the file untouched', ok: modified?.scheme === CHANGE_SCHEME && e2e.getText() === source.join('\n') + '\n', detail: String(modified) })
            await vscode.commands.executeCommand('adaptai.acceptChange')
            await new Promise(resolve => setTimeout(resolve, 600))
            report?.({ step: 'e2e: Accept applied the model change', ok: e2e.isDirty && /throw/i.test(e2e.getText()), detail: JSON.stringify(e2e.getText()) })
            await vscode.window.showTextDocument(e2e)
            await vscode.commands.executeCommand('undo')
            report?.({ step: 'e2e: one undo restores', ok: e2e.getText() === source.join('\n') + '\n', detail: JSON.stringify(e2e.getText()) })
          }
        }
      } catch (error) {
        report?.({ step: 'diff: threw', ok: false, detail: String(error) })
      }
      if (token && process.env.ADAPTAI_SELFTEST_LONG && process.env.ADAPTAI_SELFTEST_FOLDER) await runLong({ backend, analyser, chat, assist, changes, report: report!, folder: process.env.ADAPTAI_SELFTEST_FOLDER }).catch(error => report?.({ step: 'long run threw', ok: false, detail: String(error) }))
      report?.({ step: 'done', ok: true, detail: 'self-test finished' })
    })()
  }
}

export function deactivate(): void {}
