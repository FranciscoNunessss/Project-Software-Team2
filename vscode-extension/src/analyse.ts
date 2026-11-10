import * as vscode from 'vscode'
import { ApiError, Backend } from './backend'
import type { Analysis, Coach, CoachMode, LlmOption, LlmOptions, OutcomeReason, OutcomeValue } from './api'
import {
  analysisPlan,
  checkLmStudioModels,
  connectionLabel,
  describeFailure,
  destination,
  fileName,
  improvedText,
  isSecretFile,
  lmStudioModelsUrl,
  secretsIn,
  servedBy,
  taskFrom,
  type Connection,
} from './core'
import { assessedBy, renderAnalysis, summaryLine, textSummary } from './format'

export const DIFF_SCHEME = 'adaptai-coach'
export const ANALYSIS_SCHEME = 'adaptai-analysis'
const MAX_FILE_BYTES = 200_000
// A local reasoning model can need minutes for a structured answer; the backend stops at its own limit
// (ADAPTAI_TIMEOUT_SECONDS, 120 s by default), so this one is a little longer and only catches a hung connection.
const ANALYSIS_TIMEOUT_MS = 150_000
const SYNTHETIC = 'Explain what an API is in one sentence. This is a synthetic connectivity test.'

export type Target = { uri: vscode.Uri; range: vscode.Range; original: string }

/** What the user asked to analyse, kept so a failed attempt can be repeated exactly. */
type Request = {
  raw: string
  source: 'selection' | 'file' | 'clipboard' | 'text'
  name?: string
  target?: Target
  /** The file was analysed because nothing was selected. */
  noSelection?: boolean
  /** The Prompt Coach will be asked about the same text afterwards. */
  thenCoach?: boolean
}

/** One analysis and what was done with it. */
export type Result = {
  task: string
  analysis: Analysis
  via?: LlmOption
  target?: Target
  truncated: boolean
  at: string
  source: string
  coachAvailable: boolean
  coach?: Coach
  coachMode?: CoachMode
  improved?: string
  error?: string
}

export function explain(error: unknown, provider?: string): string {
  if (error instanceof ApiError) return provider && error.status !== 0 ? describeFailure(error.status, error.detail, provider) : error.friendly
  if (error instanceof Error && error.name === 'AbortError') return 'Cancelled.'
  if (error instanceof Error && error.name === 'TimeoutError') return 'The request timed out. The model may be busy or still loading; retry in a moment.'
  return `Could not reach the backend: ${error instanceof Error ? error.message : String(error)}`
}

const isCancel = (message: string): boolean => message === 'Cancelled.'

/**
 * Analyse from the editor. Gets the text, asks consent, calls the API and shows the result as a Markdown
 * document next to the editor, with the actions of the app (Prompt Coach, task solved, copy). The model
 * that analyses is the project's assessor (ADR-014 A11); the model you pick is for the chat.
 */
export class Analyser implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private readonly virtual = new Map<string, string>()
  readonly results = new Map<string, Result>()
  private counter = 0
  private readonly refreshed = new vscode.EventEmitter<void>()
  readonly onDidAnalyse = this.refreshed.event
  private readonly lensChanged = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.lensChanged.event
  readonly virtualRefresh = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.virtualRefresh.event
  private lastRequest: Request | undefined
  readonly connections = new Map<string, Connection>()
  /** How long a model request may take before it is stopped. */
  timeoutMs = ANALYSIS_TIMEOUT_MS

  constructor(private readonly backend: Backend) {}

  // ---- virtual documents -------------------------------------------------------------------

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme === ANALYSIS_SCHEME) {
      const result = this.results.get(uri.path.replace(/^\//, '').replace(/\.md$/, ''))
      return result ? this.render(result) : '# This analysis is no longer in memory\n\nAnalyse again, or open it from the history.'
    }
    return this.virtual.get(uri.path) ?? ''
  }

  private render(result: Result): string {
    const base = renderAnalysis(result.analysis, { source: result.source, truncated: result.truncated, at: result.at })
    if (!result.coach && !result.error) return base
    const lines = [base, '## Prompt Coach', '']
    if (result.error) lines.push(`**The Prompt Coach failed:** ${result.error}`, '')
    if (result.coach) {
      if (result.coach.status === 'nothing_to_improve') lines.push('Nothing to improve: every dimension of this analysis is already clear.', '')
      for (const item of result.coach.suggestions) {
        lines.push(`- **${item.title}** (${item.dimension}, ${item.kind}): ${item.rationale}`)
        if (item.kind === 'edit' && item.quote) lines.push(`  - replace “${item.quote}” with “${item.replacement ?? ''}”`)
      }
      for (const question of result.coach.open_questions) lines.push(`- Question: ${question}`)
      if (result.coach.fallback) lines.push('', '_Fallback: the model was unavailable or its output was unusable, so these are standard questions from the rubric._')
      if (result.improved) lines.push('', `Improved text (${result.coachMode}):`, '', '```text', result.improved, '```')
    }
    return lines.join('\n') + '\n'
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== ANALYSIS_SCHEME) return []
    const id = document.uri.path.replace(/^\//, '').replace(/\.md$/, '')
    const result = this.results.get(id)
    if (!result) return []
    const top = new vscode.Range(0, 0, 0, 0)
    const lens = (title: string, command: string) => new vscode.CodeLens(top, { title, command, arguments: [id] })
    const lenses = [lens('$(copy) Copy summary', 'adaptai.copySummary'), lens('$(check) Task solved?', 'adaptai.taskOutcome'), lens('$(pass) Use this model in the chat', 'adaptai.useModel')]
    if (result.coachAvailable) lenses.unshift(lens('$(lightbulb) Prompt Coach: improve', 'adaptai.coachResult'))
    return lenses
  }

  // ---- entry points ------------------------------------------------------------------------

  /** The selection; with nothing selected, the whole file (the confirmation says so). */
  async fromEditor(opts: { wholeFile?: boolean; thenCoach?: boolean } = {}): Promise<Result | undefined> {
    const editor = vscode.window.activeTextEditor
    if (!editor) return void vscode.window.showInformationMessage('AdaptAI: open a file and select the prompt you want to analyse.')
    const name = fileName(editor.document.uri.path)
    if (isSecretFile(name)) return void vscode.window.showWarningMessage(`AdaptAI: ${name} holds secrets by convention and is never sent.`)
    const selected = opts.wholeFile ? '' : editor.document.getText(editor.selection)
    if (selected.trim()) {
      return this.run({ raw: selected, source: 'selection', name, thenCoach: opts.thenCoach, target: { uri: editor.document.uri, range: editor.selection, original: selected } })
    }
    const range = editor.document.validateRange(new vscode.Range(0, 0, editor.document.lineCount, 0))
    const whole = editor.document.getText(range)
    if (!whole.trim()) return void vscode.window.showInformationMessage(`AdaptAI: ${name} is empty, so there is nothing to analyse.`)
    return this.run({ raw: whole, source: 'file', name, noSelection: !opts.wholeFile, thenCoach: opts.thenCoach, target: { uri: editor.document.uri, range, original: whole } })
  }

  async fromUri(uri: vscode.Uri | undefined): Promise<Result | undefined> {
    if (!uri) return this.fromEditor({ wholeFile: true })
    const name = fileName(uri.path)
    if (isSecretFile(name)) return void vscode.window.showWarningMessage(`AdaptAI: ${name} holds secrets by convention and is never sent.`)
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
      return void vscode.window.showWarningMessage(`AdaptAI: ${name} is larger than ${MAX_FILE_BYTES / 1000} KB or is not text, so it is not analysed.`)
    }
    return this.run({ raw: Buffer.from(bytes).toString('utf8'), source: 'file', name })
  }

  async fromClipboard(thenCoach = false): Promise<Result | undefined> {
    const text = await vscode.env.clipboard.readText()
    if (!text.trim()) return void vscode.window.showInformationMessage('AdaptAI: the clipboard is empty. Copy the prompt first (Ctrl+A, Ctrl+C in its box), then run this again.')
    return this.run({ raw: text, source: 'clipboard', thenCoach })
  }

  /** Text typed in the AdaptAI panel: the same consent, secret check and request as a typed task. */
  async fromText(text: string): Promise<Result | undefined> {
    if (!text.trim()) return undefined
    return this.run({ raw: text, source: 'text' })
  }

  async fromInput(): Promise<Result | undefined> {
    const text = await vscode.window.showInputBox({ title: 'AdaptAI: describe the task', prompt: 'The task you would give to an AI model', ignoreFocusOut: true })
    if (!text?.trim()) return undefined
    return this.run({ raw: text, source: 'text' })
  }

  /**
   * For prompts written in another tool (the Claude Code box, a browser chat): copy the prompt, run this,
   * and paste back the improved text. Analyses, asks the Prompt Coach with the mode from the settings,
   * and puts the improved text on the clipboard. The confirmation names both requests.
   */
  async coachClipboard(): Promise<Result | undefined> {
    const result = await this.fromClipboard(true)
    if (!result) return undefined
    const configured = vscode.workspace.getConfiguration('adaptai').get<string>('coachMode', 'rewrite')
    const mode: CoachMode = configured === 'tips' || configured === 'edits' ? configured : 'rewrite'
    if (!result.coachAvailable) return void vscode.window.showWarningMessage('AdaptAI: Prompt Coach is not installed on this backend.')
    await this.coach(result, mode, true)
    if (result.improved) {
      await vscode.env.clipboard.writeText(result.improved)
      void vscode.window.showInformationMessage('AdaptAI: the improved prompt is on your clipboard. Paste it (Ctrl+V) where you wrote the original.')
    } else if (result.coach && !result.error) {
      void vscode.window.showInformationMessage(mode === 'tips' ? 'AdaptAI: the Coach gave tips only; there is no new text to paste.' : 'AdaptAI: nothing to improve, or this mode produced no change. Your clipboard is unchanged.')
    }
    return result
  }

  /**
   * "Autocorrect the prompt": analyses the selection (or the file), asks the Coach for a rewrite, and either
   * shows the diff and asks to apply it (default) or applies it at once (`adaptai.improveApply`).
   * Only on this command, never while typing; Undo restores the original.
   */
  async improveInEditor(): Promise<Result | undefined> {
    const result = await this.fromEditor({ thenCoach: true })
    if (!result) return undefined
    if (!result.coachAvailable) return void vscode.window.showWarningMessage('AdaptAI: Prompt Coach is not installed on this backend.')
    const configured = vscode.workspace.getConfiguration('adaptai').get<string>('coachMode', 'rewrite')
    await this.coach(result, configured === 'edits' ? 'edits' : 'rewrite', true)
    if (!result.improved) {
      if (result.coach && !result.error) void vscode.window.showInformationMessage('AdaptAI: nothing to improve in this prompt.')
      return result
    }
    const how = vscode.workspace.getConfiguration('adaptai').get<string>('improveApply', 'diff')
    if (how === 'replace') {
      await this.apply(result)
      return result
    }
    await this.diff(result)
    const choice = await vscode.window.showInformationMessage('AdaptAI: apply the improved prompt?', 'Apply', 'Not now')
    if (choice === 'Apply') await this.apply(result)
    return result
  }

  /** Repeats the latest request exactly (same text), after a failure or to refresh a result. */
  async retry(): Promise<Result | undefined> {
    if (!this.lastRequest) return void vscode.window.showInformationMessage('AdaptAI: there is nothing to retry yet.')
    return this.run(this.lastRequest)
  }

  // ---- model choice and confirmation -----------------------------------------------------------

  private async signedIn(): Promise<boolean> {
    const problem = this.backend.urlProblem
    if (problem) {
      void this.notify('error', `AdaptAI: ${problem}`, { settings: true })
      return false
    }
    if (this.backend.auth !== 'none') return true
    const foreign = this.backend.foreignOrigin
    const choice = await vscode.window.showInformationMessage(
      foreign ? `AdaptAI: your saved sign-in belongs to ${foreign}, not to ${this.backend.url}, so it was not used. Sign in again for this backend.` : 'AdaptAI: sign in first.',
      'Sign in',
    )
    if (choice) await vscode.commands.executeCommand('adaptai.signIn')
    return this.backend.auth !== 'none'
  }

  async options(): Promise<LlmOptions | undefined> {
    try {
      return await this.backend.api<LlmOptions>('/api/llm-options')
    } catch (error) {
      void this.notify('error', `AdaptAI: ${explain(error)}`, { settings: !(error instanceof ApiError && error.status === 401) })
      return undefined
    }
  }

  /** The model chosen for the chat (`adaptai.chatModel`, an option id), used only when the backend has no assessor. */
  private chatModel(options: LlmOptions): LlmOption | undefined {
    const wanted = vscode.workspace.getConfiguration('adaptai').get<string>('chatModel', '')
    const usable = options.options.filter(item => item.provider !== 'openrouter')
    return usable.find(item => item.id === wanted) ?? usable.find(item => item.id === options.auto_configuration_id) ?? (usable.length === 1 ? usable[0] : undefined)
  }

  /**
   * The one confirmation before text leaves the editor. It names what is sent (selection, file, clipboard),
   * how many characters, through which backend, and to which model. A whole file always asks; an external
   * model asks unless the user chose "do not ask again" for selections.
   */
  async confirmSend(what: { source: Request['source']; name?: string; characters: number; noSelection?: boolean; thenCoach?: boolean }, option: LlmOption | undefined): Promise<boolean> {
    const external = Boolean(option?.external)
    const whole = what.source === 'file'
    const config = vscode.workspace.getConfiguration('adaptai')
    if (!external && !whole) return true
    if (external && !whole && !config.get<boolean>('confirmExternal', true)) return true
    const subject =
      what.source === 'file'
        ? `${what.noSelection ? 'Nothing is selected, so ' : ''}the whole content of ${what.name ?? 'the file'} (${what.characters} characters)`
        : what.source === 'selection'
          ? `the selected text (${what.characters} characters)`
          : what.source === 'clipboard'
            ? `the clipboard text (${what.characters} characters)`
            : `the text you typed (${what.characters} characters)`
    const host = new URL(this.backend.url).host
    const where = external ? `sent through the AdaptAI backend at ${host} to ${destination(option)}, outside your machine` : `analysed through the AdaptAI backend at ${host} with ${destination(option)}`
    const twice = what.thenCoach ? ' The same text is sent twice: to analyse it, then to ask the Prompt Coach for an improved version.' : ''
    const send = external ? 'Send' : 'Analyse'
    const always = 'Send and do not ask again'
    const buttons = external && !whole ? [send, always] : [send]
    const choice = await vscode.window.showWarningMessage(`AdaptAI will have ${subject} ${where}.${twice} Files that hold secrets are never sent.`, { modal: true }, ...buttons)
    if (choice === always) await config.update('confirmExternal', false, vscode.ConfigurationTarget.Global)
    if (!choice) void vscode.window.showInformationMessage('AdaptAI: cancelled. Nothing was sent.')
    return Boolean(choice)
  }

  /** A progress notification the user can cancel; a timeout ends it too. Errors keep their names (AbortError, TimeoutError). */
  async cancellable<T>(title: string, task: (signal: AbortSignal) => Promise<T>, ms = this.timeoutMs): Promise<T> {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_progress, cancel) => {
      const controller = new AbortController()
      cancel.onCancellationRequested(() => controller.abort())
      return task(AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]))
    })
  }

  private async notify(kind: 'error' | 'warning', message: string, actions: { retry?: boolean; settings?: boolean } = {}): Promise<void> {
    const buttons = [actions.retry ? 'Retry' : '', actions.settings ? 'Open settings' : ''].filter(Boolean)
    const show = kind === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage
    const choice = await show(message, ...buttons)
    if (choice === 'Retry') void this.retry()
    else if (choice === 'Open settings') void vscode.commands.executeCommand('adaptai.openSettings')
  }

  // ---- analysis ----------------------------------------------------------------------------

  private async run(request: Request): Promise<Result | undefined> {
    if (!(await this.signedIn())) return undefined
    this.lastRequest = request
    const task = taskFrom(request.source === 'file' ? '' : request.raw, request.raw)
    if (!task.text) return void vscode.window.showInformationMessage('AdaptAI: there is no text to analyse.')
    const secrets = secretsIn(task.text)
    if (secrets.length) {
      const go = await vscode.window.showWarningMessage(
        `The text looks like it contains ${secrets.join(', ')}. Nothing has been sent yet. If you continue, it goes to the model that analyses it. Send anyway?`,
        { modal: true },
        'Send anyway',
      )
      if (!go) return void vscode.window.showInformationMessage('AdaptAI: cancelled. Nothing was sent.')
    }
    const options = await this.options()
    if (!options) return undefined
    const plan = analysisPlan(task.text, options, { chat: this.chatModel(options) })
    if ('error' in plan) return void vscode.window.showWarningMessage(`AdaptAI: ${plan.error}`)
    if (!(await this.confirmSend({ source: request.source, name: request.name, characters: task.text.length, noSelection: request.noSelection, thenCoach: request.thenCoach }, plan.via))) return undefined
    const started = Date.now()
    try {
      const analysis = await this.cancellable(`AdaptAI: analysing with ${destination(plan.via)}`, signal => this.backend.api<Analysis>('/api/analyze', 'POST', plan.body, signal, plan.via?.provider))
      // Only a model chosen by hand must be the one that answered; the assessor may hand over (the result says so).
      const mismatch = plan.manual ? servedBy(analysis, plan.via) : undefined
      if (mismatch) throw new ApiError(0, `${mismatch} The result was discarded.`)
      if (plan.via) this.connections.set(plan.via.id, { state: 'tested', at: Date.now(), ms: Date.now() - started })
      const features = await this.backend.api<{ prompt_coach?: boolean }>('/api/features').catch(() => ({ prompt_coach: false }))
      const result: Result = {
        task: task.text,
        analysis,
        via: plan.via,
        target: request.target && !task.truncated ? request.target : undefined,
        truncated: task.truncated,
        at: new Date().toLocaleTimeString(),
        source: request.source === 'file' ? `file ${request.name ?? ''}`.trim() : request.source === 'selection' ? 'selection' : request.source === 'clipboard' ? 'clipboard' : 'typed text',
        coachAvailable: Boolean(features.prompt_coach),
      }
      await this.show(result, !request.thenCoach)
      this.refreshed.fire()
      return result
    } catch (error) {
      return this.failed(task.text, error, plan.via)
    }
  }

  /**
   * The analysis of a text typed in the chat (`/analyse`): the same call and confirmation, inside the chat's
   * own session, and nothing is opened: the chat shows the result. Returns undefined when cancelled or failed.
   */
  async analyseText(text: string, extra: { sessionId?: string; previousId?: string; signal?: AbortSignal } = {}): Promise<Result | undefined> {
    if (!(await this.signedIn())) return undefined
    const task = taskFrom(text, text)
    const secrets = secretsIn(task.text)
    if (secrets.length) {
      const go = await vscode.window.showWarningMessage(`The text looks like it contains ${secrets.join(', ')}. Nothing has been sent yet. If you continue, it goes to the model that analyses it. Send anyway?`, { modal: true }, 'Send anyway')
      if (!go) return void vscode.window.showInformationMessage('AdaptAI: cancelled. Nothing was sent.')
    }
    const options = await this.options()
    if (!options) return undefined
    const plan = analysisPlan(task.text, options, { chat: this.chatModel(options), sessionId: extra.sessionId, previousId: extra.previousId })
    if ('error' in plan) return void vscode.window.showWarningMessage(`AdaptAI: ${plan.error}`)
    if (!(await this.confirmSend({ source: 'text', characters: task.text.length }, plan.via))) return undefined
    try {
      const signal = extra.signal ? AbortSignal.any([extra.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
      const analysis = await this.backend.api<Analysis>('/api/analyze', 'POST', plan.body, signal, plan.via?.provider)
      const mismatch = plan.manual ? servedBy(analysis, plan.via) : undefined
      if (mismatch) throw new ApiError(0, `${mismatch} The result was discarded.`)
      const features = await this.backend.api<{ prompt_coach?: boolean }>('/api/features').catch(() => ({ prompt_coach: false }))
      const result: Result = { task: task.text, analysis, via: plan.via, truncated: task.truncated, at: new Date().toLocaleTimeString(), source: 'the chat', coachAvailable: Boolean(features.prompt_coach) }
      this.results.set(analysis.id, result)
      this.refreshed.fire()
      return result
    } catch (error) {
      return this.failed(task.text, error, plan.via)
    }
  }

  /** A failed attempt is never presented as an answer: it is an error with the reason and a way to retry. */
  private failed(task: string, error: unknown, via: LlmOption | undefined): undefined {
    const message = explain(error, via?.provider)
    if (isCancel(message)) return undefined
    if (via) this.connections.set(via.id, { state: 'failed', at: Date.now(), detail: message })
    void this.notify('error', `AdaptAI: the request for “${task.slice(0, 60)}${task.length > 60 ? '…' : ''}” failed. ${message}`, { retry: true, settings: error instanceof ApiError && error.status === 0 })
    return undefined
  }

  /** Opens the analysis as a Markdown document beside the editor, then offers the actions of the app. */
  async show(result: Result, offer = true): Promise<void> {
    const id = result.analysis.id
    this.results.set(id, result)
    const uri = vscode.Uri.from({ scheme: ANALYSIS_SCHEME, path: `/${id}.md` })
    this.lensChanged.fire()
    const view = vscode.workspace.getConfiguration('adaptai').get<string>('resultView', 'preview')
    if (view === 'preview') await vscode.commands.executeCommand('markdown.showPreviewToSide', uri)
    else {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true })
    }
    if (!offer) return
    const buttons = ['Copy summary', 'Task solved?', ...(result.coachAvailable ? ['Improve with the Coach'] : [])]
    const choice = await vscode.window.showInformationMessage(`AdaptAI: ${summaryLine(result.analysis)} · assessed by ${assessedBy(result.analysis)}`, ...buttons)
    if (choice === 'Copy summary') await vscode.commands.executeCommand('adaptai.copySummary', id)
    else if (choice === 'Task solved?') await vscode.commands.executeCommand('adaptai.taskOutcome', id)
    else if (choice === 'Improve with the Coach') await vscode.commands.executeCommand('adaptai.coachResult', id)
  }

  /** A development self-test: the same API calls as a command, without the pickers and dialogs. */
  async runForTest(text: string): Promise<Result | undefined> {
    const options = await this.backend.api<LlmOptions>('/api/llm-options')
    const plan = analysisPlan(text, options, { chat: this.chatModel(options) })
    if ('error' in plan) throw new Error(plan.error)
    const analysis = await this.backend.api<Analysis>('/api/analyze', 'POST', { ...plan.body, allow_external: false, provider: 'demo' })
    const result: Result = { task: text, analysis, via: plan.via, truncated: false, at: new Date().toLocaleTimeString(), source: 'typed text', coachAvailable: true }
    this.results.set(analysis.id, result)
    return result
  }

  // ---- the actions of the app --------------------------------------------------------------

  private find(id: string | undefined): Result | undefined {
    const result = id ? this.results.get(id) : [...this.results.values()].at(-1)
    if (!result) void vscode.window.showInformationMessage('AdaptAI: there is no analysis to act on yet. Analyse a prompt first.')
    return result
  }

  async copySummary(id?: string): Promise<void> {
    const result = this.find(id)
    if (!result) return
    await vscode.env.clipboard.writeText(textSummary(result.analysis))
    void vscode.window.showInformationMessage('AdaptAI: summary copied.')
  }

  /** "Task solved?" (ADR-014 D9, D10): once per task, three answers, a reason only when it was not solved. */
  async taskOutcome(id?: string): Promise<void> {
    const result = this.find(id)
    if (!result) return
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(check) Solved', outcome: 'resolved' as OutcomeValue },
        { label: '$(sync) Solved after refining', outcome: 'resolved_with_refinement' as OutcomeValue },
        { label: '$(x) Not solved', outcome: 'not_resolved' as OutcomeValue },
        { label: '$(circle-slash) Skip', outcome: 'skipped' as OutcomeValue },
      ],
      { title: 'AdaptAI: did the recommended model solve the task?', ignoreFocusOut: true },
    )
    if (!picked) return
    let reason: OutcomeReason | undefined
    if (picked.outcome === 'not_resolved') {
      const why = await vscode.window.showQuickPick(
        [
          { label: 'The model fell short', reason: 'quality' as OutcomeReason },
          { label: 'It ignored my instructions', reason: 'instructions' as OutcomeReason },
          { label: 'I described the task poorly', reason: 'description' as OutcomeReason },
          { label: 'Something else', reason: 'other' as OutcomeReason },
        ],
        { title: 'Why not? (optional: press Escape to skip)', ignoreFocusOut: true },
      )
      reason = why?.reason
    }
    try {
      await this.backend.api(`/api/analyses/${encodeURIComponent(result.analysis.id)}/outcome`, 'PUT', { outcome: picked.outcome, reason })
      void vscode.window.showInformationMessage('AdaptAI: saved. It feeds My progress and the calibration of the catalogue (no text is stored with it).')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
  }

  /** "Use this model": records the choice for the analysis and makes it the chat model. */
  async useModel(id?: string): Promise<void> {
    const result = this.find(id)
    if (!result) return
    const model = result.analysis.recommendation
    if (!model.configuration_id) return void vscode.window.showWarningMessage('AdaptAI: this analysis was stored before ADR-014, so it names no model you can use.')
    try {
      await this.backend.api('/api/decisions', 'POST', { analysis_id: result.analysis.id, candidate_id: model.id })
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) return void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await vscode.workspace.getConfiguration('adaptai').update('chatModel', model.configuration_id, vscode.ConfigurationTarget.Global)
    void vscode.window.showInformationMessage(`AdaptAI: the chat will use ${model.label ?? model.name}.`)
  }

  // ---- Prompt Coach -------------------------------------------------------------------------

  async coachResult(id?: string): Promise<void> {
    const result = this.find(id)
    if (!result) return
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Tips', description: 'Where the prompt is unclear, without changing the text', mode: 'tips' as CoachMode },
        { label: 'Edits', description: 'Small corrections quoted from your text', mode: 'edits' as CoachMode },
        { label: 'Rewrite', description: 'A full improved version', mode: 'rewrite' as CoachMode },
      ],
      { title: 'AdaptAI: what should the Prompt Coach give you?', ignoreFocusOut: true },
    )
    if (!picked) return
    await this.coach(result, picked.mode)
    if (result.improved) {
      const choice = await vscode.window.showInformationMessage('AdaptAI: improved text ready.', 'Show diff', result.target ? 'Apply' : 'Open as new file', 'Copy')
      if (choice === 'Show diff') await this.diff(result)
      else if (choice === 'Apply' || choice === 'Open as new file') await this.apply(result)
      else if (choice === 'Copy') await vscode.env.clipboard.writeText(result.improved)
    }
  }

  async coach(result: Result, mode: CoachMode, consented = false): Promise<void> {
    const changed = () => {
      this.lensChanged.fire()
      this.refreshed.fire()
      // Refresh an open preview or source view of this analysis.
      this.virtualRefresh.fire(vscode.Uri.from({ scheme: ANALYSIS_SCHEME, path: `/${result.analysis.id}.md` }))
    }
    result.error = undefined
    try {
      const settings = await this.backend.api<{ enabled: boolean }>('/api/prompt-coach/settings')
      if (!settings.enabled) {
        const turnOn = await vscode.window.showInformationMessage('Prompt Coach is off for your account. Turn it on?', { modal: true }, 'Turn on')
        if (!turnOn) return changed()
        await this.backend.api('/api/prompt-coach/settings', 'PUT', { enabled: true })
      }
      const external = result.analysis.provider !== 'demo'
      const pretend: LlmOption | undefined = external ? { ...(result.via ?? { id: '', provider: result.analysis.provider, label: result.analysis.provider, model: null, source: '' }), external: true } : undefined
      if (!consented && !(await this.confirmSend({ source: 'selection', characters: result.task.length }, pretend))) return changed()
      const coach = await this.cancellable('AdaptAI: asking the Prompt Coach', signal =>
        this.backend.api<Coach>('/api/prompt-coach', 'POST', { analysis_id: result.analysis.id, task: result.task, mode, allow_external: external }, signal, result.analysis.provider),
      )
      result.coach = coach
      result.coachMode = mode
      result.improved = improvedText(result.task, coach, mode)
    } catch (error) {
      const message = explain(error, result.analysis.provider)
      result.error = isCancel(message) ? 'The Prompt Coach request was cancelled.' : message
    }
    changed()
  }

  async diff(result: Result): Promise<void> {
    if (!result.improved) return
    const id = ++this.counter
    const name = result.target ? fileName(result.target.uri.path) : 'prompt.txt'
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/original/${name}` })
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/improved/${name}` })
    this.virtual.set(left.path, result.task)
    this.virtual.set(right.path, result.improved)
    await vscode.commands.executeCommand('vscode.diff', left, right, 'AdaptAI: original ↔ improved')
  }

  async apply(result: Result): Promise<void> {
    if (!result.improved) return
    const target = result.target
    if (target) {
      const document = await vscode.workspace.openTextDocument(target.uri)
      if (document.getText(target.range) === target.original) {
        const lead = target.original.match(/^\s*/)?.[0] ?? ''
        const trail = target.original.match(/\s*$/)?.[0] ?? ''
        const edit = new vscode.WorkspaceEdit()
        edit.replace(target.uri, target.range, lead + result.improved + trail)
        if (await vscode.workspace.applyEdit(edit)) {
          void vscode.window.showInformationMessage('AdaptAI: the improved text is in the editor. Undo (Ctrl+Z) brings the original back.')
          return
        }
      } else {
        void vscode.window.showWarningMessage('AdaptAI: the text changed since the analysis, so it was not replaced. Opened as a new file instead.')
      }
    }
    const created = await vscode.workspace.openTextDocument({ content: result.improved, language: 'plaintext' })
    await vscode.window.showTextDocument(created, { viewColumn: vscode.ViewColumn.Beside })
  }

  // ---- connection test -------------------------------------------------------------------------

  /**
   * "Configured" only means the backend lists the model. This sends a short synthetic sentence through the
   * real path and records whether it worked, and why not if it did not. The analysis is tested with the
   * project's assessor; the chat models with their own test route or a short synthetic analysis.
   */
  async testConnection(): Promise<void> {
    if (!(await this.signedIn())) return
    const options = await this.options()
    if (!options) return
    const usable = options.options.filter(item => item.provider !== 'openrouter' && item.provider !== 'demo')
    if (usable.length === 0) return void vscode.window.showWarningMessage('AdaptAI: this backend lists no Groq, LM Studio or personal model to test.')
    const items = usable.map(item => ({
      label: options.assessment?.id === item.id ? `$(beaker) Assessor · ${item.label}` : item.label,
      description: item.model ?? undefined,
      detail: connectionLabel(this.connections.get(item.id)),
      option: item,
    }))
    const picked = await vscode.window.showQuickPick(items, { title: 'AdaptAI: test the connection of which model?', placeHolder: 'Sends one short synthetic sentence; none of your text', ignoreFocusOut: true })
    if (!picked) return
    const option = picked.option
    const host = new URL(this.backend.url).host
    if (option.external) {
      const ok = await vscode.window.showWarningMessage(`The test sends one synthetic sentence ("${SYNTHETIC.slice(0, 40)}…") through the backend at ${host} to ${destination(option)}, outside your machine. None of your text is sent. Continue?`, { modal: true }, 'Test')
      if (!ok) return
    }
    const started = Date.now()
    try {
      let model = option.model
      if (option.provider === 'lmstudio' && option.source === 'server') await this.checkLmStudio(option)
      if (option.source !== 'server') {
        await this.cancellable(`AdaptAI: testing ${destination(option)}`, signal => this.backend.api('/api/llm-configs/' + encodeURIComponent(option.id) + '/test', 'POST', undefined, signal, option.provider))
      } else {
        const plan = analysisPlan(SYNTHETIC, { ...options, assessment: null }, { chat: option })
        if ('error' in plan) throw new ApiError(0, plan.error)
        const analysis = await this.cancellable(`AdaptAI: testing ${destination(option)}`, signal => this.backend.api<Analysis>('/api/analyze', 'POST', plan.body, signal, option.provider))
        model = analysis.assessment_model
        const mismatch = plan.manual ? servedBy(analysis, option) : undefined
        // The probe is not kept in the user's history.
        if (analysis.session_id) await this.backend.api('/api/sessions/' + encodeURIComponent(analysis.session_id), 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => undefined)
        if (mismatch) throw new ApiError(0, mismatch)
      }
      const ms = Date.now() - started
      this.connections.set(option.id, { state: 'tested', at: Date.now(), ms })
      void vscode.window.showInformationMessage(`AdaptAI: connection tested OK with ${destination({ ...option, model })} (${(ms / 1000).toFixed(1)} s). This only proves one short request worked.`)
    } catch (error) {
      const message = explain(error, option.provider)
      if (isCancel(message)) return
      this.connections.set(option.id, { state: 'failed', at: Date.now(), detail: message })
      void vscode.window.showErrorMessage(`AdaptAI: the connection test for ${destination(option)} failed. ${message}`)
    }
  }

  /**
   * LM Studio answers with whichever model is loaded, even when asked for one that is not, so a passing
   * analysis does not prove the configured model is the one answering. This asks LM Studio itself
   * (`adaptai.lmStudioUrl`, which must match the address the backend uses) what it has loaded.
   */
  private async checkLmStudio(option: LlmOption): Promise<void> {
    const setting = vscode.workspace.getConfiguration('adaptai').get<string>('lmStudioUrl', 'http://127.0.0.1:1234')
    const target = lmStudioModelsUrl(setting)
    if (!target.ok) throw new ApiError(0, target.reason)
    let response: Response
    try {
      response = await fetch(target.url, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new ApiError(0, timedOut ? `LM Studio did not answer within 5 s at ${target.base}. It may be busy or loading a model.` : `LM Studio is not reachable at ${target.base} (nothing is listening there). Start its local server (Developer tab), or set adaptai.lmStudioUrl to the address it uses.`)
    }
    if (!response.ok) throw new ApiError(0, `${target.base} answered HTTP ${response.status} to the model list. Is this the LM Studio server address (adaptai.lmStudioUrl)?`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ApiError(0, `${target.base} answered, but not with JSON. Is this the LM Studio server address (adaptai.lmStudioUrl)?`)
    }
    const checked = checkLmStudioModels(body, option.model, target.base)
    if (!checked.ok) throw new ApiError(0, checked.reason)
  }
}
