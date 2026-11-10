import * as vscode from 'vscode'
import { Backend } from './backend'
import { explain } from './analyse'
import type { LlmOption, LlmOptions } from './api'
import { connectionLabel, destination, type Connection } from './core'

export type Estimate = { calls_max: number; input_tokens_max: number; output_tokens_max: number; price_known: boolean; free: boolean; estimated_usd: number | null; max_usd: number | null }
export type Evaluation = {
  provider: string
  model: string
  configuration_id: string | null
  shared: boolean
  paid_by_you: boolean
  picked?: boolean
  levels_source: string | null
  levels: Record<string, number> | null
  evaluation: null | { id: string; status: string; progress: number; total: number; errors: number; failure: string | null; estimate: Estimate | null; spent_usd: number | null; finished_at: string | null; levels: Record<string, number> | null }
}
export type PersonalConfig = { id: string; label: string; provider: string; model: string; has_key: boolean; enabled: boolean; is_default: boolean; external: boolean; responses_api: boolean }
export type CatalogueModel = { id: string; name: string; organisation: string; context_length?: number | null; price_input_per_million?: number | null; price_output_per_million?: number | null; free?: boolean; selectable?: boolean; reason?: string | null }

export const PROVIDERS = [
  { label: 'Groq', provider: 'groq', key: true, hint: 'for example openai/gpt-oss-20b' },
  { label: 'OpenAI', provider: 'openai', key: true, hint: 'for example gpt-5.4-mini' },
  { label: 'Claude (Anthropic)', provider: 'claude', key: true, hint: 'for example claude-sonnet-5-5' },
  { label: 'OpenRouter', provider: 'openrouter', key: true, hint: 'optional: any model of the catalogue can be picked later' },
  { label: 'LM Studio', provider: 'lmstudio', key: false, hint: 'the model loaded in LM Studio' },
  { label: 'Ollama', provider: 'ollama', key: false, hint: 'for example gemma3:12b' },
] as const

export const CAPABILITIES = ['reasoning', 'context', 'domain', 'reliability', 'tools'] as const

/** The state of one evaluation in words the user can act on. */
export function describeEvaluation(entry: Evaluation): { text: string; icon: string; consent: boolean } {
  const e = entry.evaluation
  if (!e) return entry.levels ? { text: `Not measured · ${entry.levels_source ?? 'provisional levels'}`, icon: 'circle-outline', consent: false } : { text: 'Not evaluated', icon: 'circle-slash', consent: false }
  const levels = (e.levels ?? entry.levels) ? ' · ' + Object.entries((e.levels ?? entry.levels) as Record<string, number>).map(([name, value]) => `${name[0].toUpperCase()}${value}`).join(' ') : ''
  switch (e.status) {
    case 'awaiting_consent':
      return { text: 'Waiting for your consent', icon: 'bell', consent: true }
    case 'declined':
      return { text: `Declined${entry.levels ? ` · ${entry.levels_source ?? 'provisional levels'}` : ''}`, icon: 'circle-slash', consent: false }
    case 'queued':
      return { text: 'Queued', icon: 'clock', consent: false }
    case 'running':
      return { text: `Evaluating ${e.progress}/${e.total}`, icon: 'sync~spin', consent: false }
    case 'done':
      return { text: `Measured by AdaptAI${levels}`, icon: 'pass-filled', consent: false }
    case 'failed':
      return { text: `Evaluation failed${e.failure ? ` (${e.failure.replace(/_/g, ' ')})` : ''}`, icon: 'error', consent: false }
    default:
      return { text: e.status, icon: 'question', consent: false }
  }
}

/** What the consent dialog says before a paid evaluation: what is sent, the cost, the ceiling, what declining means. */
export function consentText(entry: Evaluation): string {
  const e = entry.evaluation?.estimate
  const cost = !e ? 'The cost is not known.' : e.free ? 'It is free.' : e.price_known ? `Estimated cost ${e.estimated_usd?.toFixed(4)} USD, never more than ${e.max_usd?.toFixed(4)} USD.` : 'The price of this model is not known, so the cost cannot be estimated.'
  return `Evaluate ${entry.provider} · ${entry.model}?\n\nAdaptAI sends up to ${e?.calls_max ?? 40} synthetic tasks (none of your text) to ${entry.provider} with your key, to measure the model's levels. ${cost}\n\nIf you decline, you can still use the model in the chat; it may just not be recommended until it is measured.`
}

type Row =
  | { kind: 'group'; id: string; label: string }
  | { kind: 'server'; option: LlmOption; assessor: boolean }
  | { kind: 'personal'; config: PersonalConfig }
  | { kind: 'evaluation'; entry: Evaluation }
  | { kind: 'info'; label: string; icon: string }

/** Models and their evaluations: the project's models, yours (LLM config), and how each was measured. */
export class ModelsView implements vscode.TreeDataProvider<Row> {
  static readonly viewType = 'adaptai.models'
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changed.event
  private options: LlmOptions | undefined
  private configs: PersonalConfig[] = []
  private evaluations: Evaluation[] = []
  private failed: string | undefined

  constructor(private readonly backend: Backend, private readonly connections: Map<string, Connection>) {}

  async refresh(): Promise<void> {
    this.failed = undefined
    if (this.backend.auth === 'none') {
      this.options = undefined
      this.changed.fire()
      return
    }
    try {
      const signal = AbortSignal.timeout(10_000)
      this.options = await this.backend.api<LlmOptions>('/api/llm-options', 'GET', undefined, signal)
      this.configs = await this.backend.api<PersonalConfig[]>('/api/llm-configs', 'GET', undefined, signal)
      this.evaluations = (await this.backend.api<{ models: Evaluation[] }>('/api/evaluations', 'GET', undefined, signal).catch(() => ({ models: [] }))).models
    } catch (error) {
      this.failed = explain(error)
    }
    this.changed.fire()
  }

  getChildren(row?: Row): Row[] {
    if (this.backend.auth === 'none') return [{ kind: 'info', label: 'Sign in to see your models', icon: 'account' }]
    if (this.failed) return [{ kind: 'info', label: this.failed, icon: 'warning' }]
    if (!this.options) return [{ kind: 'info', label: 'Loading…', icon: 'sync~spin' }]
    if (!row) {
      return [
        { kind: 'group', id: 'server', label: 'Project models' },
        { kind: 'group', id: 'personal', label: 'Your models' },
        { kind: 'group', id: 'evaluations', label: 'How models were evaluated' },
      ]
    }
    if (row.kind !== 'group') return []
    if (row.id === 'server') {
      const server = this.options.options.filter(item => item.source === 'server')
      return server.length ? server.map(option => ({ kind: 'server' as const, option, assessor: this.options?.assessment?.id === option.id })) : [{ kind: 'info', label: 'The project has no model configured', icon: 'circle-slash' }]
    }
    if (row.id === 'personal') return this.configs.length ? this.configs.map(config => ({ kind: 'personal' as const, config })) : [{ kind: 'info', label: 'None yet: use "Add a model"', icon: 'add' }]
    return this.evaluations.length ? this.evaluations.map(entry => ({ kind: 'evaluation' as const, entry })) : [{ kind: 'info', label: 'Nothing evaluated yet', icon: 'circle-outline' }]
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const group = row.kind === 'group'
    const item = new vscode.TreeItem(
      row.kind === 'group' ? row.label : row.kind === 'server' ? row.option.label : row.kind === 'personal' ? row.config.label : row.kind === 'evaluation' ? `${row.entry.provider} · ${row.entry.model}` : row.label,
      group ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    )
    if (row.kind === 'server') {
      item.description = `${row.option.model ?? ''} · ${row.option.external ? 'external' : 'local'}${row.assessor ? ' · assesses tasks' : ''} · ${connectionLabel(this.connections.get(row.option.id))}`
      item.iconPath = new vscode.ThemeIcon(row.assessor ? 'beaker' : 'server')
      item.contextValue = 'adaptai.serverModel'
    } else if (row.kind === 'personal') {
      const c = row.config
      item.description = `${c.provider}${c.model ? ` · ${c.model}` : ' · any catalogue model'}${c.enabled ? '' : ' · off'}${c.is_default ? ' · default' : ''}${c.external && !c.has_key ? ' · no key' : ''} · ${connectionLabel(this.connections.get(c.id))}`
      item.iconPath = new vscode.ThemeIcon(c.enabled ? 'person' : 'circle-slash')
      item.contextValue = 'adaptai.personalModel'
      item.id = c.id
    } else if (row.kind === 'evaluation') {
      const d = describeEvaluation(row.entry)
      item.description = `${d.text}${row.entry.shared ? ' · shared' : ' · yours only'}`
      item.iconPath = new vscode.ThemeIcon(d.icon)
      item.contextValue = d.consent ? 'adaptai.evaluationAsk' : 'adaptai.evaluation'
      item.tooltip = row.entry.evaluation?.failure ? `Failed: ${row.entry.evaluation.failure}` : item.description
    } else if (row.kind === 'info') item.iconPath = new vscode.ThemeIcon(row.icon)
    return item
  }

  // ---- your models (LLM config) -----------------------------------------------------------------

  async add(): Promise<void> {
    const kind = await vscode.window.showQuickPick(PROVIDERS.map(item => ({ label: item.label, description: item.key ? 'needs your API key' : 'runs on your machine, no key', provider: item.provider, key: item.key, hint: item.hint })), { title: 'AdaptAI: add a model', ignoreFocusOut: true })
    if (!kind) return
    const label = await vscode.window.showInputBox({ title: `Add ${kind.label}`, prompt: 'A name for it', value: kind.label, ignoreFocusOut: true, validateInput: value => (value.trim() ? undefined : 'A name is needed') })
    if (!label) return
    const model = await vscode.window.showInputBox({ title: `Add ${kind.label}`, prompt: `Model, ${kind.hint}`, ignoreFocusOut: true, validateInput: value => (value.trim() || kind.provider === 'openrouter' ? undefined : 'This provider needs a model') })
    if (model === undefined) return
    let apiKey: string | undefined
    if (kind.key) {
      apiKey = await vscode.window.showInputBox({ title: `Add ${kind.label}`, prompt: 'API key. It is encrypted on the backend and never shown again.', password: true, ignoreFocusOut: true, validateInput: value => (/\s/.test(value) ? 'A key has no spaces' : value ? undefined : 'A key is needed') })
      if (!apiKey) return
    }
    try {
      await this.backend.api('/api/llm-configs', 'POST', { label: label.trim(), provider: kind.provider, model: model.trim(), api_key: apiKey, enabled: true, is_default: false })
      void vscode.window.showInformationMessage(`AdaptAI: ${label.trim()} added. Use "Test connection" to check it; it is evaluated in the background.`)
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  async edit(config: PersonalConfig): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Rename', field: 'label' },
        { label: 'Change the model', field: 'model' },
        { label: 'Replace the API key', field: 'key' },
        { label: config.enabled ? 'Switch off' : 'Switch on', field: 'enabled' },
        { label: config.is_default ? 'Stop being the default' : 'Make it the default', field: 'default' },
      ],
      { title: `AdaptAI: ${config.label}`, ignoreFocusOut: true },
    )
    if (!picked) return
    const body: Record<string, unknown> = { label: config.label, provider: config.provider, model: config.model, responses_api: config.responses_api, enabled: config.enabled, is_default: config.is_default }
    if (picked.field === 'label' || picked.field === 'model') {
      const value = await vscode.window.showInputBox({ title: picked.label, value: String(body[picked.field]), ignoreFocusOut: true })
      if (value === undefined || (!value.trim() && picked.field === 'label')) return
      body[picked.field] = value.trim()
    } else if (picked.field === 'key') {
      const key = await vscode.window.showInputBox({ title: picked.label, prompt: 'The new API key', password: true, ignoreFocusOut: true, validateInput: value => (/\s/.test(value) ? 'A key has no spaces' : undefined) })
      if (!key) return
      body.api_key = key
    } else if (picked.field === 'enabled') body.enabled = !config.enabled
    else body.is_default = !config.is_default
    try {
      await this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}`, 'PUT', body)
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  async remove(config: PersonalConfig): Promise<void> {
    const sure = await vscode.window.showWarningMessage(`Delete ${config.label}? Its encrypted key is deleted too. Past analyses stay.`, { modal: true }, 'Delete')
    if (!sure) return
    try {
      await this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}`, 'DELETE')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  /** The backend's own test: the key, and one short chat answer. Nothing of yours is sent. */
  async test(config: PersonalConfig): Promise<void> {
    const started = Date.now()
    try {
      await this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}/test`, 'POST', undefined, AbortSignal.timeout(90_000), config.provider)
      this.connections.set(config.id, { state: 'tested', at: Date.now(), ms: Date.now() - started })
      void vscode.window.showInformationMessage(`AdaptAI: ${config.label} answered. This only proves one short request worked.`)
    } catch (error) {
      const message = explain(error, config.provider)
      this.connections.set(config.id, { state: 'failed', at: Date.now(), detail: message })
      void vscode.window.showErrorMessage(`AdaptAI: the test of ${config.label} failed. ${message}`)
    }
    this.changed.fire()
  }

  // ---- evaluations --------------------------------------------------------------------------------

  /** A paid evaluation never starts without this: what is sent, the cost and its ceiling; an unknown price asks twice. */
  async consent(entry: Evaluation): Promise<void> {
    const evaluation = entry.evaluation
    if (!evaluation) return
    const accepted = await vscode.window.showWarningMessage(consentText(entry), { modal: true }, 'Evaluate', 'Not now')
    if (!accepted) return
    const accept = accepted === 'Evaluate'
    let confirmUnknown = false
    if (accept && !evaluation.estimate?.price_known) {
      const again = await vscode.window.showWarningMessage('The price of this model is not known. The cost cannot be guaranteed. Evaluate anyway?', { modal: true }, 'Yes, evaluate anyway')
      if (!again) return
      confirmUnknown = true
    }
    try {
      await this.backend.api(`/api/evaluations/${encodeURIComponent(evaluation.id)}/consent`, 'POST', { accept, confirm_unknown_price: confirmUnknown })
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  async reevaluate(entry: Evaluation): Promise<void> {
    if (!entry.configuration_id) return void vscode.window.showWarningMessage('AdaptAI: only a model of one of your configurations can be evaluated again.')
    try {
      await this.backend.api('/api/evaluations/reevaluate', 'POST', { configuration_id: entry.configuration_id, model: entry.model })
      void vscode.window.showInformationMessage('AdaptAI: a new evaluation was opened. A paid model asks for your consent first.')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  /** "Disagree" is recorded for the calibration report; it never changes a level. */
  async disagree(entry: Evaluation): Promise<void> {
    const id = entry.evaluation?.id
    if (!id) return
    const picked = await vscode.window.showQuickPick(CAPABILITIES.map(name => ({ label: name, description: entry.levels ? `level ${entry.levels[name] ?? '?'}` : undefined })), { title: 'AdaptAI: which level do you disagree with?', placeHolder: 'It is recorded for the team; it does not change the level', ignoreFocusOut: true })
    if (!picked) return
    try {
      await this.backend.api(`/api/evaluations/${encodeURIComponent(id)}/disagree`, 'POST', { capability: picked.label })
      void vscode.window.showInformationMessage('AdaptAI: noted. The level does not change; the team sees it in the calibration report.')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
  }

  /** Adds a model of OpenRouter's live catalogue to the models that are evaluated and recommended. Nothing is sent to a model. */
  async addOpenRouterModel(): Promise<void> {
    const openrouter = this.configs.filter(item => item.provider === 'openrouter' && item.enabled)
    if (!openrouter.length) return void vscode.window.showWarningMessage('AdaptAI: connect OpenRouter first (Add a model > OpenRouter).')
    let configuration = openrouter[0]
    if (openrouter.length > 1) {
      const pick = await vscode.window.showQuickPick(openrouter.map(item => ({ label: item.label, config: item })), { title: 'AdaptAI: which OpenRouter configuration?', ignoreFocusOut: true })
      if (!pick) return
      configuration = pick.config
    }
    let catalogue: { fetched_at?: string; models: CatalogueModel[] }
    try {
      catalogue = await this.backend.api('/api/openrouter/models', 'GET', undefined, AbortSignal.timeout(20_000))
    } catch (error) {
      return void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    const items = catalogue.models.map(model => ({
      label: model.id,
      description: model.free ? 'free' : model.price_input_per_million != null ? `${model.price_input_per_million.toFixed(2)} / ${(model.price_output_per_million ?? 0).toFixed(2)} USD per million tokens` : 'price variable',
      detail: model.selectable === false ? `Cannot be chosen: ${model.reason ?? 'not compatible'}` : [model.name, model.context_length ? `${model.context_length} tokens of context` : ''].filter(Boolean).join(' · '),
      model,
    }))
    const picked = await vscode.window.showQuickPick(items, { title: `AdaptAI: add a model of the OpenRouter catalogue (${items.length})`, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true })
    if (!picked) return
    if (picked.model.selectable === false) return void vscode.window.showWarningMessage(`AdaptAI: ${picked.model.id} cannot be chosen: ${picked.model.reason ?? 'not compatible'}.`)
    try {
      await this.backend.api('/api/evaluations/models', 'POST', { configuration_id: configuration.id, model: picked.model.id })
      void vscode.window.showInformationMessage(`AdaptAI: ${picked.model.id} added. Nothing was sent to it; a paid model asks for your consent before it is evaluated.`)
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }

  async removeOpenRouterModel(entry: Evaluation): Promise<void> {
    if (!entry.picked || !entry.configuration_id) return
    try {
      await this.backend.api(`/api/evaluations/models?configuration_id=${encodeURIComponent(entry.configuration_id)}&model=${encodeURIComponent(entry.model)}`, 'DELETE')
    } catch (error) {
      void vscode.window.showErrorMessage(`AdaptAI: ${explain(error)}`)
    }
    await this.refresh()
  }
}

export { destination }
