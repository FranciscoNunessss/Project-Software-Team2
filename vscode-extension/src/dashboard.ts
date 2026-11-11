import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { explain, type Analyser } from './analyse'
import { ApiError, type Backend } from './backend'
import type { ChatMessage, ChatService, ChatSummary } from './chat'
import type { Analysis, Candidate, CoachMode, LlmOptions } from './api'
import { CAPABILITIES, PROVIDERS, consentText, describeEvaluation, type CatalogueModel, type Evaluation, type PersonalConfig } from './models'
import { CONSENT, type ProgressReport, type Settings } from './profile'
import { describeFailure } from './core'
import { assessedBy, modelName, price, summaryLine } from './format'
import type { Result } from './analyse'

type Tab = 'analyse' | 'progress' | 'profile' | 'models' | 'shortcuts'
const TABS: Tab[] = ['analyse', 'progress', 'profile', 'models', 'shortcuts']
/** Commands the Shortcuts page may run: they need nothing but a click. */
const RUNNABLE = ['analyseSelection', 'analyseClipboard', 'analyseInput', 'improvePrompt', 'coachClipboard', 'testConnection', 'checkConnection', 'openProgress', 'chatNew', 'openSettings']
const SWITCHES = ['save_enabled', 'use_enabled', 'conversation_memory_enabled', 'coaching_auto_enabled', 'coach', 'auto_analyse'] as const
const DELETES = ['memory', 'conversations', 'history'] as const
const RESULT_ACTIONS = new Set(['adaptai.copySummary', 'adaptai.taskOutcome', 'adaptai.useModel', 'adaptai.coachResult'])

/** One short status per model for the picker: the rules of the web app's modelStatus.tsx. */
function statusOf(entry: Evaluation | undefined): { state: string; text: string } {
  const status = entry?.evaluation?.status
  if (status === 'queued' || status === 'running') return { state: 'evaluating', text: `Evaluating ${entry?.evaluation?.progress}/${entry?.evaluation?.total}` }
  if (status === 'awaiting_consent') return { state: 'consent', text: 'Waiting for consent' }
  const source = entry?.levels_source
  if (source === 'calibrated' || source === 'measured') return { state: 'measured', text: 'Measured' }
  if (source === 'arena') return { state: 'public', text: 'Public ranking' }
  if (source === 'benchmark' || source === 'provisional' || source === 'family') return { state: 'provisional', text: 'Provisional' }
  if (status === 'failed') return { state: 'failed', text: 'Evaluation failed' }
  return { state: 'none', text: 'Not evaluated' }
}

type Message = { type: string; [key: string]: unknown }

type Field = { name: string; label: string; type?: 'text' | 'password' | 'textarea' | 'select' | 'checkbox' | 'cards'; value?: string | boolean; options?: { value: string; label: string; sub?: string }[]; hint?: string; placeholder?: string; required?: boolean }
type Dialog = {
  title: string
  text?: string
  fields?: Field[]
  confirm?: string
  cancel?: string
  danger?: boolean
  extra?: { key: string; label: string }[]
  list?: { items: { key: string; title: string; sub?: string; disabled?: boolean }[] }
  reveal?: string
}

/**
 * AdaptAI in a full editor tab: one place to analyse, choose the model, manage your models and evaluations,
 * set the profile and see the activity. It draws data the backend returns and calls the same services as the
 * commands, so every consent, secret check and URL rule is the one the commands use. Text is drawn with
 * textContent only, and the page may only send the messages handled below.
 */
export class Dashboard implements vscode.WebviewViewProvider {
  static readonly viewType = 'adaptai.home'
  private view: vscode.WebviewView | undefined
  private tab: Tab = 'analyse'
  private busy = false
  private coachBusy = false
  private analysisError: string | undefined
  private streaming: AbortController | undefined
  /** The model of the next chat message only (the default stays in LLM config). */
  private chatOverride: { optionId: string; model?: string; label: string } | undefined
  private readonly dialogs = new Map<string, (values?: Record<string, unknown>) => void>()
  private seq = 0
  private markReady: () => void = () => undefined
  private ready: Promise<void> = new Promise(resolve => (this.markReady = resolve))
  private cache: { configs: PersonalConfig[]; evaluations: Evaluation[] } = { configs: [], evaluations: [] }

  constructor(
    private readonly backend: Backend,
    private readonly analyser: Analyser,
    private readonly chat: ChatService,
    private readonly progress: ProgressReport,
  ) {
    analyser.onDidAnalyse(() => void this.reload())
    backend.onDidChangeSession(() => void this.reload())
  }

  /** Shows the AdaptAI side bar (the page lives there). */
  open(tab?: Tab): void {
    if (tab) this.tab = tab
    void vscode.commands.executeCommand('workbench.view.extension.adaptai')
    if (this.view) void this.reload()
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    this.ready = new Promise(resolve => (this.markReady = resolve))
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    const nonce = crypto.randomBytes(16).toString('base64')
    view.webview.html = page(nonce, view.webview.cspSource, this.tab)
    view.webview.onDidReceiveMessage((message: Message) => void this.handle(message))
    view.onDidChangeVisibility(() => view.visible && void this.reload())
    view.onDidDispose(() => {
      this.view = undefined
      for (const resolve of this.dialogs.values()) resolve(undefined)
      this.dialogs.clear()
    })
  }

  private post(data: unknown): void {
    void this.view?.webview.postMessage(data)
  }

  async reload(): Promise<void> {
    if (!this.view) return
    if (this.backend.auth === 'none') return this.post({ type: 'data', tab: this.tab, signedOut: true })
    try {
      const status = await this.backend.status()
      this.post({ type: 'data', tab: this.tab, ...(await this.load(this.tab)), busy: this.busy, email: status.email })
    } catch (error) {
      this.post({ type: 'data', tab: this.tab, failed: explain(error) })
    }
  }

  private async load(tab: Tab): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(10_000)
    const api = <T>(path: string) => this.backend.api<T>(path, 'GET', undefined, signal)
    const chatModel = vscode.workspace.getConfiguration('adaptai').get<string>('chatModel', '')
    if (tab === 'analyse') {
      const options = await api<LlmOptions>('/api/llm-options')
      const last = [...this.analyser.results.values()].at(-1)
      return {
        ...(await this.chatData(api, chatModel, options)),
        assessment: options.assessment ? { label: options.assessment.label, model: options.assessment.model, provider: options.assessment.provider, external: options.assessment.external } : null,
        last: last ? richResult(last) : undefined,
        continuing: this.analyser.continueFrom?.title,
        coachBusy: this.coachBusy,
        analysing: this.busy,
        analysisError: this.analysisError,
      }
    }
    if (tab === 'shortcuts') {
      const json = vscode.extensions.getExtension('adaptai-dev.adaptai')?.packageJSON as { contributes?: { commands?: { command: string; title: string }[]; keybindings?: { command: string; key: string; mac?: string }[] } } | undefined
      const titles = new Map((json?.contributes?.commands ?? []).map(item => [item.command, item.title]))
      const mac = process.platform === 'darwin'
      const keys = new Map((json?.contributes?.keybindings ?? []).map(item => [item.command, (mac ? item.mac ?? item.key : item.key).split(' ').map(part => part.replace(/(^|\+)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase())).join(' ')]))
      return {
        shortcuts: [...keys].map(([command, key]) => ({ command, title: titles.get(command) ?? command, key })),
        actions: RUNNABLE.map(name => ({ command: `adaptai.${name}`, title: titles.get(`adaptai.${name}`) ?? name, key: keys.get(`adaptai.${name}`) ?? '' })),
      }
    }
    if (tab === 'progress') {
      const get = (path: string) => api<unknown>(path).catch(() => undefined)
      const sessions = await api<{ id: string; title: string; created_at: string; analysis_count: number }[]>('/api/sessions?limit=20').catch(() => [])
      const pending = await api<{ result: Analysis; session_title: string }[]>('/api/progress/pending?limit=10').catch(() => [])
      return { activity: await get('/api/progress/activity'), pending: pending.map(item => ({ id: item.result.id, title: item.session_title, recommended: modelName(item.result.recommendation), options: [item.result.recommendation, ...item.result.alternatives].filter(candidate => candidate.id).map(candidate => ({ id: candidate.id, name: modelName(candidate) })) })), sessions: sessions.map(item => ({ id: item.id, title: item.title, count: item.analysis_count, at: item.created_at })), progress: await get('/api/progress'), dashboard: await get('/api/progress/dashboard'), outcomes: await get('/api/progress/outcomes'), learning: await get('/api/progress/learning'), coaching: await get('/api/progress/coaching') }
    }
    if (tab === 'models') {
      const options = await api<LlmOptions>('/api/llm-options')
      const configs = await api<PersonalConfig[]>('/api/llm-configs')
      const evaluations = (await api<{ models: Evaluation[] }>('/api/evaluations').catch(() => ({ models: [] as Evaluation[] }))).models
      this.cache = { configs, evaluations }
      return {
        chatModel,
        project: options.options.filter(item => item.source === 'server').map(item => ({ id: item.id, label: item.label, provider: item.provider, model: item.model, assessor: options.assessment?.id === item.id })),
        configs: configs.map(item => ({ id: item.id, label: item.label, provider: item.provider, model: item.model, hasKey: item.has_key, external: item.external })),
        evaluations: evaluations.map(entry => ({ key: `${entry.provider}/${entry.model}`, provider: entry.provider, model: entry.model, shared: entry.shared, picked: Boolean(entry.picked), ...describeEvaluation(entry) })),
      }
    }
    if (tab === 'profile') {
      const context = await api<Settings>('/api/context')
      const coach = (await api<{ enabled: boolean }>('/api/prompt-coach/settings').catch(() => ({ enabled: true }))).enabled
      const auto = (await api<{ auto_analyse: boolean }>('/api/chat/settings').catch(() => ({ auto_analyse: false }))).auto_analyse
      return {
        values: { save_enabled: context.save_enabled, use_enabled: context.use_enabled, conversation_memory_enabled: context.conversation_memory_enabled, coaching_auto_enabled: context.coaching_auto_enabled, coach, auto_analyse: auto },
        preferences: context.content,
        memory: (context.memory as { recommended_model?: string; chosen_model?: string; profile?: Record<string, unknown> }[]).slice(0, 20).map((item, index) => ({ title: `Assessment ${index + 1} · ${item.recommended_model ? `recommended ${item.recommended_model}` : 'recommended'} · ${item.chosen_model ? `chosen ${item.chosen_model}` : 'choice pending'}`, profile: Object.entries(item.profile ?? {}).map(([name, value]) => [name, value === null ? 'Undetermined' : Array.isArray(value) ? value.join(', ') : String(value)]) })),
        counts: { memory: context.memory.length, conversations: context.saved_conversations },
        chats: (await this.chat.list().catch(() => [] as ChatSummary[])).slice(0, 12).map(item => ({ id: item.id, title: item.title, count: item.message_count, at: item.updated_at ?? item.created_at })),
        tokens: this.backend.managing ? await this.backend.tokenApi<unknown[]>('/api/tokens').catch(() => undefined) : undefined,
        tokenMode: this.backend.managing ? 'open' : 'locked',
        coachAuto: vscode.workspace.getConfiguration('adaptai').get<boolean>('coachAfterAnalysis', false),
      }
    }
    return {}
  }

  /** The conversation, the chats and the models of the picker: what the Assistant screen needs. */
  private async chatData(api: <T>(path: string) => Promise<T>, chatModel: string, options: LlmOptions): Promise<Record<string, unknown>> {
    const evaluations = (await api<{ models: Evaluation[] }>('/api/evaluations').catch(() => ({ models: [] as Evaluation[] }))).models
    const status = new Map(evaluations.map(entry => [`${entry.provider}|${entry.model}`, statusOf(entry)]))
    const chats = await this.chat.list().catch(() => [] as ChatSummary[])
    const current = this.chat.current && chats.some(item => item.id === this.chat.current) ? this.chat.current : undefined
    const detail = current ? await api<{ messages: ChatMessage[] }>(`/api/chats/${encodeURIComponent(current)}`).catch(() => undefined) : undefined
    return {
      chatModel,
      autoId: options.auto_configuration_id,
      auto: options.options.find(item => item.id === options.auto_configuration_id) ? { label: options.options.find(item => item.id === options.auto_configuration_id)?.label ?? '', model: options.options.find(item => item.id === options.auto_configuration_id)?.model ?? null, provider: options.options.find(item => item.id === options.auto_configuration_id)?.provider ?? '' } : null,
      options: options.options.map(item => ({ id: item.id, label: item.label, provider: item.provider, model: item.model, external: item.external, source: item.source, status: status.get(`${item.provider}|${item.model ?? ''}`) ?? { state: 'none', text: 'Not evaluated' } })),
      override: this.chatOverride ? { id: this.chatOverride.optionId, label: this.chatOverride.label, openrouter: Boolean(this.chatOverride.model) } : undefined,
      chats: chats.map(item => ({ id: item.id, title: item.title, count: item.message_count, at: item.updated_at ?? item.created_at })),
      current,
      streaming: Boolean(this.streaming),
      messages: (detail?.messages ?? []).map(item => ({
        role: item.role,
        text: item.content,
        who: item.role === 'user' ? 'You' : `AdaptAI${item.model ? ` · ${item.provider ?? ''} ${item.model}` : ''}`,
        cut: item.error === 'answer_truncated',
        error: item.error ? describeFailure(502, item.error, item.provider ?? undefined) : item.status === 'failed' ? 'This answer failed.' : item.status === 'stopped' ? 'Stopped by you.' : '',
      })),
    }
  }

  // ---- dialogs inside the page ---------------------------------------------------------------------

  /** Shows a dialog in the page and waits for the answer (undefined when it is cancelled or the page is closed). */
  private ask(spec: Dialog): Promise<Record<string, unknown> | undefined> {
    if (!this.view) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const id = String(++this.seq)
      this.dialogs.set(id, resolve)
      this.post({ type: 'dialog', id, ...spec })
    })
  }

  private toast(kind: 'ok' | 'err', text: string): void {
    this.post({ type: 'toast', kind, text })
  }

  private async confirm(title: string, text: string, confirm = 'Confirm', danger = false): Promise<boolean> {
    return Boolean(await this.ask({ title, text, confirm, danger }))
  }

  /** Runs a backend action, shows a failure as a message in the page, and refreshes the data. */
  private async act(run: () => Promise<unknown>, done?: string): Promise<boolean> {
    try {
      await run()
      if (done) this.toast('ok', done)
      return true
    } catch (error) {
      this.toast('err', explain(error))
      return false
    } finally {
      await this.reload()
    }
  }

  // ---- account ---------------------------------------------------------------------------------------

  async signIn(): Promise<void> {
    await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 6000))])
    if (this.backend.urlProblem) return this.toast('err', this.backend.urlProblem)
    const answer = await this.ask({
      title: 'Sign in',
      text: 'Your password is used once to sign in. Only a token is kept on this machine. A forgotten password and the link to an older history are handled in the web app.',
      fields: [
        { name: 'email', label: 'Email', required: true, placeholder: 'you@example.com' },
        { name: 'password', label: 'Password', type: 'password', required: true },
      ],
      confirm: 'Sign in',
      extra: [
        { key: 'register', label: 'Create an account' },
        { key: 'token', label: 'Use a token' },
      ],
    })
    if (!answer) return
    if (answer.__extra === 'register') return this.register()
    if (answer.__extra === 'token') return this.signInWithToken()
    try {
      const result = await this.backend.signInWithPassword(String(answer.email).trim(), String(answer.password))
      this.toast('ok', `Signed in as ${result.email}.`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.detail === 'use_supabase_auth') return this.signInWithToken(true)
      this.toast('err', explain(error))
    }
  }

  async signInWithToken(cloud = false): Promise<void> {
    await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 6000))])
    const answer = await this.ask({
      title: 'Sign in with a token',
      text: cloud ? 'This backend signs in with Supabase, in the cloud app. Create a token there (Profile > API tokens) and paste it here.' : 'Paste a personal API token.',
      fields: [{ name: 'token', label: 'Token', type: 'password', required: true, placeholder: 'adaptai_pat_…' }],
      confirm: 'Sign in',
    })
    if (!answer) return
    try {
      this.toast('ok', `Signed in as ${await this.backend.signInWithToken(String(answer.token))}.`)
    } catch (error) {
      this.toast('err', explain(error))
    }
  }

  async register(): Promise<void> {
    await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 6000))])
    if (this.backend.urlProblem) return this.toast('err', this.backend.urlProblem)
    const answer = await this.ask({
      title: 'Create an account',
      fields: [
        { name: 'email', label: 'Email', required: true },
        { name: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 12 characters.' },
        { name: 'again', label: 'Repeat the password', type: 'password', required: true },
      ],
      confirm: 'Create account',
    })
    if (!answer) return
    if (String(answer.password).length < 12) return this.toast('err', 'The password needs at least 12 characters.')
    if (answer.password !== answer.again) return this.toast('err', 'The two passwords are not the same.')
    try {
      const result = await this.backend.register(String(answer.email).trim(), String(answer.password))
      this.toast('ok', `Account created. Signed in as ${result.email}.`)
    } catch (error) {
      this.toast('err', error instanceof ApiError && error.status === 404 ? 'This backend uses Supabase accounts, which are created in the cloud app.' : explain(error))
    }
  }

  async signOut(): Promise<void> {
    await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 6000))])
    if (!(await this.confirm('Sign out?', 'The token stored here is forgotten. Revoke it in Profile > API tokens to invalidate it everywhere.', 'Sign out'))) return
    await this.backend.signOut()
    this.toast('ok', 'Signed out.')
  }

  // ---- models ------------------------------------------------------------------------------------------

  private async addModel(): Promise<void> {
    const kind = await this.ask({
      title: 'Add a model',
      text: 'Pick where the model runs.',
      fields: [{ name: 'provider', label: 'Provider', type: 'cards', value: 'groq', options: PROVIDERS.map(item => ({ value: item.provider, label: item.label, sub: item.key ? 'needs your API key' : 'runs on your machine, no key' })) }],
      confirm: 'Next',
    })
    if (!kind) return
    const provider = PROVIDERS.find(item => item.provider === kind.provider)
    if (!provider) return
    const fields: Field[] = [
      { name: 'label', label: 'Name', value: provider.label, required: true },
      { name: 'model', label: 'Model', placeholder: provider.hint, required: provider.provider !== 'openrouter', hint: provider.hint },
    ]
    if (provider.key) fields.push({ name: 'key', label: 'API key', type: 'password', required: true, hint: provider.provider === 'openrouter' ? 'Encrypted on the backend. Each model is also evaluated in the background (about 40 requests); free OpenRouter models allow around 50 requests a day in total.' : 'Encrypted on the backend. It is never shown again.' })
    const form = await this.ask({ title: `Add ${provider.label}`, fields, confirm: 'Add model' })
    if (!form) return
    await this.act(
      () => this.backend.api('/api/llm-configs', 'POST', { label: String(form.label).trim(), provider: provider.provider, model: String(form.model ?? '').trim(), api_key: provider.key ? String(form.key) : undefined, enabled: true, is_default: false }),
      `${String(form.label).trim()} added. Test it, and it is evaluated in the background.`,
    )
  }

  private async editModel(config: PersonalConfig): Promise<void> {
    const form = await this.ask({
      title: `Edit ${config.label}`,
      fields: [
        { name: 'label', label: 'Name', value: config.label, required: true },
        { name: 'model', label: 'Model', value: config.model },
        ...(PROVIDERS.find(item => item.provider === config.provider)?.key ? [{ name: 'key', label: 'Replace the API key', type: 'password' as const, hint: 'Leave empty to keep the current key.' }] : []),
        { name: 'enabled', label: 'Enabled', type: 'checkbox', value: config.enabled },
        { name: 'is_default', label: 'Use as my default', type: 'checkbox', value: config.is_default },
      ],
      confirm: 'Save',
    })
    if (!form) return
    const body: Record<string, unknown> = { label: String(form.label).trim(), provider: config.provider, model: String(form.model ?? '').trim(), responses_api: config.responses_api, enabled: form.enabled === true, is_default: form.is_default === true }
    if (form.key) body.api_key = String(form.key)
    await this.act(() => this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}`, 'PUT', body), 'Saved.')
  }

  private async removeModel(config: PersonalConfig): Promise<void> {
    if (!(await this.confirm(`Delete ${config.label}?`, 'Its encrypted key is deleted too. Past analyses stay.', 'Delete', true))) return
    await this.act(() => this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}`, 'DELETE'), 'Deleted.')
  }

  private async testModel(config: PersonalConfig): Promise<void> {
    this.toast('ok', `Testing ${config.label}…`)
    await this.act(() => this.backend.api(`/api/llm-configs/${encodeURIComponent(config.id)}/test`, 'POST', undefined, AbortSignal.timeout(90_000), config.provider), `${config.label} answered. This only proves one short request worked.`)
  }

  private async consent(entry: Evaluation): Promise<void> {
    const evaluation = entry.evaluation
    if (!evaluation) return
    const first = await this.ask({ title: 'Evaluate this model?', text: consentText(entry), confirm: 'Evaluate', cancel: 'Not now' })
    const accept = Boolean(first)
    if (!first) {
      const declined = await this.confirm('Decline this evaluation?', 'The model keeps its provisional levels. You can ask again later.', 'Decline')
      if (!declined) return
    }
    let confirmUnknown = false
    if (accept && !evaluation.estimate?.price_known) {
      if (!(await this.confirm('Price not known', 'The price of this model is not known. The cost cannot be guaranteed. Evaluate anyway?', 'Yes, evaluate anyway', true))) return
      confirmUnknown = true
    }
    await this.act(() => this.backend.api(`/api/evaluations/${encodeURIComponent(evaluation.id)}/consent`, 'POST', { accept, confirm_unknown_price: confirmUnknown }), accept ? 'The evaluation was started.' : 'Declined.')
  }

  private async redo(entry: Evaluation): Promise<void> {
    if (!entry.configuration_id) return this.toast('err', 'Only a model of one of your configurations can be evaluated again.')
    await this.act(() => this.backend.api('/api/evaluations/reevaluate', 'POST', { configuration_id: entry.configuration_id, model: entry.model }), 'A new evaluation was opened. A paid model asks for your consent first.')
  }

  private async disagree(entry: Evaluation): Promise<void> {
    const id = entry.evaluation?.id
    if (!id) return
    const form = await this.ask({
      title: 'Which level do you disagree with?',
      text: 'It is recorded for the calibration report. It never changes a level.',
      fields: [{ name: 'capability', label: 'Capability', type: 'select', value: 'reasoning', options: CAPABILITIES.map(name => ({ value: name, label: `${name}${entry.levels ? ` (level ${entry.levels[name] ?? '?'})` : ''}` })) }],
      confirm: 'Send',
    })
    if (!form) return
    await this.act(() => this.backend.api(`/api/evaluations/${encodeURIComponent(id)}/disagree`, 'POST', { capability: String(form.capability) }), 'Noted. The level does not change.')
  }

  private async openRouter(): Promise<void> {
    const configs = this.cache.configs.filter(item => item.provider === 'openrouter' && item.enabled)
    if (!configs.length) return this.toast('err', 'Connect OpenRouter first: Add a model > OpenRouter.')
    let configuration = configs[0]
    if (configs.length > 1) {
      const pick = await this.ask({ title: 'Which OpenRouter configuration?', fields: [{ name: 'id', label: 'Configuration', type: 'select', options: configs.map(item => ({ value: item.id, label: item.label })) }], confirm: 'Next' })
      if (!pick) return
      configuration = configs.find(item => item.id === pick.id) ?? configs[0]
    }
    let catalogue: { models: CatalogueModel[] }
    try {
      catalogue = await this.backend.api('/api/openrouter/models', 'GET', undefined, AbortSignal.timeout(20_000))
    } catch (error) {
      return this.toast('err', explain(error))
    }
    const picked = await this.ask({
      title: `OpenRouter catalogue (${catalogue.models.length})`,
      text: 'Pick a model to add to the ones that are evaluated and recommended. Nothing is sent to it.',
      list: {
        items: catalogue.models.map(model => ({
          key: model.id,
          title: model.id,
          sub: [model.free ? 'free' : model.price_input_per_million != null ? `${model.price_input_per_million.toFixed(2)} / ${(model.price_output_per_million ?? 0).toFixed(2)} USD per million tokens` : 'price variable', model.context_length ? `${model.context_length} tokens` : '', model.selectable === false ? `cannot be chosen: ${model.reason ?? 'not compatible'}` : ''].filter(Boolean).join(' · '),
          disabled: model.selectable === false,
        })),
      },
    })
    if (!picked?.pick) return
    await this.act(() => this.backend.api('/api/evaluations/models', 'POST', { configuration_id: configuration.id, model: String(picked.pick) }), `${String(picked.pick)} added. A paid model asks for your consent before it is evaluated.`)
  }

  private async removeOpenRouter(entry: Evaluation): Promise<void> {
    if (!entry.picked || !entry.configuration_id) return
    if (!(await this.confirm('Remove this model?', `${entry.model} will no longer be evaluated or recommended.`, 'Remove', true))) return
    await this.act(() => this.backend.api(`/api/evaluations/models?configuration_id=${encodeURIComponent(entry.configuration_id as string)}&model=${encodeURIComponent(entry.model)}`, 'DELETE'), 'Removed.')
  }

  // ---- profile -----------------------------------------------------------------------------------------

  private async toggle(key: (typeof SWITCHES)[number], on: boolean): Promise<void> {
    if (on && CONSENT[key]) {
      if (!(await this.confirm('Please confirm', CONSENT[key] as string, 'Switch on'))) return void (await this.reload())
    }
    await this.act(() => (key === 'coach' ? this.backend.api('/api/prompt-coach/settings', 'PUT', { enabled: on }) : key === 'auto_analyse' ? this.backend.api('/api/chat/settings', 'PUT', { auto_analyse: on }) : this.backend.api('/api/context', 'PUT', { [key]: on })))
  }

  private async preferences(current: string): Promise<void> {
    const form = await this.ask({
      title: 'What should AdaptAI know about you?',
      text: 'Optional preferences, such as language, experience and explanation style. The assessor may use them when memory is on. Avoid confidential details.',
      fields: [{ name: 'content', label: 'Your preferences', type: 'textarea', value: current, placeholder: 'For example: I prefer Portuguese and concise explanations.' }],
      confirm: 'Save',
    })
    if (!form) return
    await this.act(() => this.backend.api('/api/context', 'PUT', { content: String(form.content).slice(0, 4000) }), 'Saved.')
  }

  private async deleteData(what: (typeof DELETES)[number]): Promise<void> {
    const texts = { memory: ['Clear learned memory?', 'This cannot be undone. Your progress history and saved preferences stay.', '/api/context/memory'], conversations: ['Delete stored conversations?', 'The saved task text and responses are deleted. This cannot be undone.', '/api/context/conversations'], history: ['Delete all usage history?', 'Sessions, choices, learned memory and advice are deleted. This cannot be undone.', '/api/progress/history'] } as const
    const [title, text, path] = texts[what]
    if (!(await this.confirm(title, text, 'Delete', true))) return
    await this.act(() => this.backend.api(path, 'DELETE'), 'Deleted.')
  }

  // ---- tokens --------------------------------------------------------------------------------------------

  private async tokenUnlock(): Promise<void> {
    const status = await this.backend.status()
    if (!status.email) return
    const form = await this.ask({ title: 'Confirm your password', text: `Needed to manage API tokens of ${status.email} for the next 10 minutes. It is kept in memory only.`, fields: [{ name: 'password', label: 'Password', type: 'password', required: true }], confirm: 'Unlock' })
    if (!form) return
    try {
      await this.backend.startManaging(status.email, String(form.password))
    } catch (error) {
      this.toast('err', error instanceof ApiError && error.status === 404 ? 'This backend signs in with Supabase, so tokens are created in the cloud app.' : explain(error))
    }
    await this.reload()
  }

  private async tokenCreate(): Promise<void> {
    if (!this.backend.managing) return
    const form = await this.ask({
      title: 'New API token',
      fields: [
        { name: 'name', label: 'Name', value: 'VS Code', required: true, hint: 'To recognise it by, for example: my laptop.' },
        { name: 'days', label: 'Lasts', type: 'select', value: '90', options: ['30', '90', '180', '365'].map(value => ({ value, label: `${value} days` })) },
      ],
      confirm: 'Create',
    })
    if (!form) return
    try {
      const created = await this.backend.tokenApi<{ token: string }>('/api/tokens', 'POST', { name: String(form.name).trim().slice(0, 60), expires_in_days: Number.parseInt(String(form.days), 10) })
      await this.ask({ title: 'Your new token', text: 'It is shown only now. Copy it and keep it safe.', reveal: created.token, confirm: 'Done', cancel: '' })
    } catch (error) {
      this.toast('err', explain(error))
    }
    await this.reload()
  }

  private async tokenRevoke(id: string): Promise<void> {
    if (!this.backend.managing) return
    if (!(await this.confirm('Revoke this token?', 'Anything using it stops working immediately.', 'Revoke', true))) return
    await this.act(() => this.backend.tokenApi(`/api/tokens/${encodeURIComponent(id)}`, 'DELETE'), 'Revoked.')
  }

  // ---- chats and outcomes ------------------------------------------------------------------------------

  private async renameChat(id: string): Promise<void> {
    const item = (await this.chat.list().catch(() => [])).find(chat => chat.id === id)
    if (!item) return
    const form = await this.ask({ title: 'Rename chat', fields: [{ name: 'title', label: 'Title', value: item.title, required: true }], confirm: 'Rename' })
    if (!form) return
    await this.act(() => this.chat.rename(id, String(form.title).trim().slice(0, 120)))
  }

  private async deleteChat(id: string): Promise<void> {
    if (!(await this.confirm('Delete this chat?', 'The conversation is deleted from the backend.', 'Delete', true))) return
    await this.act(() => this.chat.remove(id), 'Deleted.')
  }

  private async outcome(id: string): Promise<void> {
    const form = await this.ask({
      title: 'Did the recommended model solve the task?',
      text: 'It feeds My progress and the calibration of the catalogue. No text is stored with it.',
      fields: [
        { name: 'outcome', label: 'Outcome', type: 'cards', value: 'resolved', options: [{ value: 'resolved', label: 'Solved' }, { value: 'resolved_with_refinement', label: 'Solved after refining' }, { value: 'not_resolved', label: 'Not solved' }, { value: 'skipped', label: 'Skip' }] },
        { name: 'reason', label: 'If not solved, why?', type: 'select', value: '', options: [{ value: '', label: 'No reason' }, { value: 'quality', label: 'The model fell short' }, { value: 'instructions', label: 'It ignored my instructions' }, { value: 'description', label: 'I described the task poorly' }, { value: 'other', label: 'Something else' }] },
      ],
      confirm: 'Save',
    })
    if (!form) return
    const reason = form.outcome === 'not_resolved' && form.reason ? String(form.reason) : undefined
    await this.act(() => this.backend.api(`/api/analyses/${encodeURIComponent(id)}/outcome`, 'PUT', { outcome: String(form.outcome), reason }), 'Saved.')
  }

  private async choose(analysisId: string, candidateId: string): Promise<void> {
    await this.act(() => this.backend.api('/api/decisions', 'POST', { analysis_id: analysisId, candidate_id: candidateId }), 'Choice saved.')
  }

  private async openSession(id: string): Promise<void> {
    type Item = { result: Analysis; candidate_id: string | null; created_at: string }
    let detail: { id: string; title: string; created_at: string; analyses: Item[] }
    try {
      detail = await this.backend.api(`/api/sessions/${encodeURIComponent(id)}?limit=100`, 'GET', undefined, AbortSignal.timeout(10_000))
    } catch (error) {
      return this.toast('err', explain(error))
    }
    const items = detail.analyses.map(item => {
      const chosen = [item.result.recommendation, ...item.result.alternatives].find(candidate => candidate.id === item.candidate_id)
      return { key: item.result.id, title: `${modelName(item.result.recommendation)} recommended`, sub: [new Date(item.created_at).toLocaleString(), chosen ? `you chose ${modelName(chosen)}` : 'choice pending', item.result.provider].join(' · ') }
    })
    const answer = await this.ask({
      title: detail.title || 'Session',
      text: items.length ? 'Pick an analysis to open its full report, or continue this session: the next analysis is compared with the last one.' : 'This session has no analyses.',
      list: { items },
      extra: [{ key: 'continue', label: 'Continue this session' }, { key: 'delete', label: 'Delete session' }],
    })
    if (!answer) return
    if (answer.pick) {
      const item = detail.analyses.find(entry => entry.result.id === answer.pick)
      if (!item) return
      const result: Result = { task: '', analysis: item.result, truncated: false, at: new Date(item.created_at).toLocaleString(), source: 'history', coachAvailable: false }
      this.analyser.results.set(item.result.id, result)
      await this.analyser.show(result, false)
      return
    }
    if (answer.__extra === 'continue') {
      const last = [...detail.analyses].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
      if (!last) return this.toast('err', 'This session has no analysis to continue from.')
      this.analyser.continueFrom = { sessionId: detail.id, previousId: last.result.id, title: detail.title || 'a past session' }
      this.tab = 'analyse'
      this.toast('ok', 'The next analysis continues this session.')
      return this.reload()
    }
    if (answer.__extra === 'delete') {
      if (!(await this.confirm('Delete this session?', 'Its analyses, choices and the learned memory they produced are deleted. This cannot be undone.', 'Delete', true))) return
      if (this.analyser.continueFrom?.sessionId === detail.id) this.analyser.continueFrom = undefined
      await this.act(() => this.backend.api(`/api/sessions/${encodeURIComponent(detail.id)}`, 'DELETE'), 'Deleted.')
    }
  }

  private async setOverride(value: string): Promise<void> {
    if (value === '__current') return
    if (!value) {
      this.chatOverride = undefined
      return this.reload()
    }
    try {
      const options = await this.backend.api<LlmOptions>('/api/llm-options', 'GET', undefined, AbortSignal.timeout(10_000))
      if (value !== '__openrouter') return this.reload()
      const openrouter = options.options.find(item => item.provider === 'openrouter')
      if (!openrouter) return this.toast('err', 'Connect OpenRouter first: LLM config > Add a model.')
      const catalogue = await this.backend.api<{ models: CatalogueModel[] }>('/api/openrouter/models', 'GET', undefined, AbortSignal.timeout(20_000))
      const picked = await this.ask({
        title: `OpenRouter catalogue (${catalogue.models.length})`,
        text: 'Pick the OpenRouter model for your messages. A paid model costs money; the price is shown.',
        list: {
          items: catalogue.models.map(model => ({
            key: model.id,
            title: model.id,
            sub: [model.free ? 'free' : model.price_input_per_million != null ? `${model.price_input_per_million.toFixed(2)} / ${(model.price_output_per_million ?? 0).toFixed(2)} USD per million tokens` : 'price variable', model.context_length ? `${model.context_length} tokens` : '', model.selectable === false ? `cannot be chosen: ${model.reason ?? 'not compatible'}` : ''].filter(Boolean).join(' · '),
            disabled: model.selectable === false,
          })),
        },
      })
      if (picked?.pick) {
        this.chatOverride = { optionId: openrouter.id, model: String(picked.pick), label: `OpenRouter · ${String(picked.pick)}` }
        this.toast('ok', `Messages go to ${String(picked.pick)} until you change it.`)
      }
    } catch (error) {
      this.toast('err', explain(error))
    }
    await this.reload()
  }

  private async coachNow(text: string, mode: CoachMode): Promise<void> {
    if (!text.trim() || this.busy || this.coachBusy) return
    this.coachBusy = true
    await this.reload()
    try {
      this.analysisError = undefined
      const result = await this.chat.coachForPage(text, mode)
      if (!result) this.analysisError = this.analyser.lastError
    } finally {
      this.coachBusy = false
      await this.reload()
    }
  }

  private async exportData(): Promise<void> {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('adaptai-export.json'), filters: { JSON: ['json'] }, title: 'Export my AdaptAI data' })
    if (!target) return
    try {
      const get = <T>(path: string) => this.backend.api<T>(path, 'GET', undefined, AbortSignal.timeout(20_000))
      const sessions: unknown[] = []
      for (let offset = 0; offset < 1000; offset += 100) {
        const batch = await get<{ id: string }[]>(`/api/sessions?limit=100&offset=${offset}`)
        for (const session of batch) sessions.push(await get(`/api/sessions/${encodeURIComponent(session.id)}?limit=100&offset=0`).catch(() => session))
        if (batch.length < 100) break
      }
      const chats: unknown[] = []
      for (const chat of await get<{ id: string }[]>('/api/chats').catch(() => [] as { id: string }[])) chats.push(await get(`/api/chats/${encodeURIComponent(chat.id)}`).catch(() => chat))
      const data = { exported_at: new Date().toISOString(), preferences: await get('/api/context'), coaching: await get('/api/progress/coaching').catch(() => null), sessions, chats }
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(data, null, 2), 'utf8'))
      this.toast('ok', `Exported to ${target.fsPath}.`)
    } catch (error) {
      this.toast('err', explain(error))
    }
  }

  // ---- messages from the page ------------------------------------------------------------------------

  async handle(message: Message): Promise<void> {
    if (!message || typeof message !== 'object') return
    const str = (key: string): string => (typeof message[key] === 'string' ? (message[key] as string) : '')
    const config = () => this.cache.configs.find(item => item.id === str('id'))
    const entry = () => this.cache.evaluations.find(item => `${item.provider}/${item.model}` === str('id'))
    switch (message.type) {
      case 'ready':
        this.markReady()
        return this.reload()
      case 'dialogResult': {
        const resolve = this.dialogs.get(str('id'))
        this.dialogs.delete(str('id'))
        const values = message.values
        resolve?.(values && typeof values === 'object' ? (values as Record<string, unknown>) : undefined)
        return
      }
      case 'tab':
        if (TABS.includes(str('tab') as Tab)) {
          this.tab = str('tab') as Tab
          await this.reload()
        }
        return
      case 'analyse': {
        const text = str('text').slice(0, 16_000)
        if (!text.trim() || this.busy) return
        this.busy = true
        await this.reload()
        try {
          this.analysisError = undefined
          const after = vscode.workspace.getConfiguration('adaptai').get<boolean>('coachAfterAnalysis', false)
          const result = await this.chat.analyseForPage(text, { thenCoach: after })
          if (!result) this.analysisError = this.analyser.lastError
          if (after && result?.coachAvailable) {
            const configured = vscode.workspace.getConfiguration('adaptai').get<string>('coachMode', 'rewrite')
            await this.analyser.coach(result, configured === 'tips' || configured === 'edits' ? configured : 'rewrite', true)
            await this.reload()
          }
        } finally {
          this.busy = false
          await this.reload()
        }
        return
      }
      case 'coach': {
        const mode = str('mode')
        return this.coachNow(str('text').slice(0, 16_000), mode === 'tips' || mode === 'edits' ? mode : 'rewrite')
      }
      case 'sessionOpen':
        return this.openSession(str('id'))
      case 'continueClear':
        this.analyser.continueFrom = undefined
        return this.reload()
      case 'chatOverride':
        return this.setOverride(str('value'))
      case 'open': {
        const result = this.analyser.results.get(str('id'))
        if (result) await this.analyser.show(result, false)
        return
      }
      case 'result': {
        if (!this.analyser.results.has(str('id'))) return
        if (str('command') === 'adaptai.taskOutcome') return this.outcome(str('id'))
        if (RESULT_ACTIONS.has(str('command'))) await vscode.commands.executeCommand(str('command'), str('id'))
        return this.reload()
      }
      case 'chatModel':
        await vscode.workspace.getConfiguration('adaptai').update('chatModel', str('id'), vscode.ConfigurationTarget.Global)
        this.chatOverride = undefined
        return this.reload()
      case 'modelAdd':
        return this.addModel()
      case 'modelEdit':
        return config() ? this.editModel(config() as PersonalConfig) : undefined
      case 'modelRemove':
        return config() ? this.removeModel(config() as PersonalConfig) : undefined
      case 'modelTest':
        return config() ? this.testModel(config() as PersonalConfig) : undefined
      case 'openrouter':
        return this.openRouter()
      case 'evalConsent':
        return entry() ? this.consent(entry() as Evaluation) : undefined
      case 'evalRedo':
        return entry() ? this.redo(entry() as Evaluation) : undefined
      case 'evalDisagree':
        return entry() ? this.disagree(entry() as Evaluation) : undefined
      case 'evalRemove':
        return entry() ? this.removeOpenRouter(entry() as Evaluation) : undefined
      case 'toggle':
        if ((SWITCHES as readonly string[]).includes(str('key'))) await this.toggle(str('key') as (typeof SWITCHES)[number], message.on === true)
        return
      case 'coachAuto': {
        const on = message.on === true
        if (on) {
          const ok = await this.confirm(
            'Run the Coach after every analysis?',
            'After each analysis started from this page, AdaptAI will send the same text again to the model for the Prompt Coach. That is a second request: it uses your rate limit and, with a paid model, costs money. With an external model the text leaves your machine twice. The first confirmation of each analysis will say so. You can switch this off at any time.',
            'Switch on',
          )
          if (!ok) return this.reload()
        }
        await vscode.workspace.getConfiguration('adaptai').update('coachAfterAnalysis', on, vscode.ConfigurationTarget.Global)
        this.toast('ok', on ? 'The Coach will run after every analysis.' : 'The Coach runs only when you ask.')
        return this.reload()
      }
      case 'preferences':
        return this.preferences(typeof message.current === 'string' ? message.current : '')
      case 'delete':
        if ((DELETES as readonly string[]).includes(str('what'))) await this.deleteData(str('what') as (typeof DELETES)[number])
        return
      case 'progress':
        return this.progress.open()
      case 'export':
        return this.exportData()
      case 'choose':
        return this.choose(str('analysis'), str('candidate'))
      case 'chatSend': {
        const text = str('text').slice(0, 8000)
        if (!text.trim() || this.streaming) return
        const analyse = /^\/analy[sz]e\s+/i.test(text)
        const abort = new AbortController()
        this.streaming = abort
        this.post({ type: 'chatStart', user: text })
        const sink = { markdown: (t: string) => this.post({ type: 'delta', text: t }), progress: (t: string) => this.post({ type: 'note', text: t }), button: () => undefined }
        try {
          if (analyse) await this.chat.analyse(text.replace(/^\/analy[sz]e\s+/i, ''), sink, abort.signal)
          else await this.chat.send(text, sink, abort.signal, this.chatOverride)
        } finally {
          this.streaming = undefined
          await this.reload()
        }
        return
      }
      case 'chatStop':
        this.streaming?.abort()
        return
      case 'chatRetry': {
        if (this.streaming) return
        const abort = new AbortController()
        this.streaming = abort
        this.post({ type: 'chatStart', user: '' })
        const sink = { markdown: (t: string) => this.post({ type: 'delta', text: t }), progress: (t: string) => this.post({ type: 'note', text: t }), button: () => undefined }
        try {
          await this.chat.retry(sink, abort.signal)
        } finally {
          this.streaming = undefined
          await this.reload()
        }
        return
      }
      case 'chatSelect':
        await this.chat.setCurrent(str('id') || undefined)
        return this.reload()
      case 'chatRename':
        return this.renameChat(str('id'))
      case 'chatDelete':
        return this.deleteChat(str('id'))
      case 'signIn':
        return this.signIn()
      case 'register':
        return this.register()
      case 'signOut':
        return this.signOut()
      case 'tokenUnlock':
        return this.tokenUnlock()
      case 'tokenCreate':
        return this.tokenCreate()
      case 'tokenRevoke':
        return this.tokenRevoke(str('id'))
      case 'settings':
        return void (await vscode.commands.executeCommand('adaptai.openSettings'))
      case 'runCommand':
        if (RUNNABLE.map(name => `adaptai.${name}`).includes(str('command'))) await vscode.commands.executeCommand(str('command'))
        return
      case 'changeKey':
        if (/^adaptai\.[A-Za-z]+$/.test(str('command'))) await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@command:${str('command')}`)
        return
      case 'allKeys':
        return void (await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'adaptai'))
      default:
        return
    }
  }
}


const DIMENSIONS: [string, string][] = [['reasoning', 'Reasoning depth'], ['context', 'Context demand'], ['ambiguity', 'Ambiguity'], ['domain', 'Domain specificity'], ['risk', 'Risk of error'], ['tools', 'Tool / integration need']]
const CHANGE_LABELS: Record<string, string> = { reasoning: 'Reasoning depth', context: 'Context demand', ambiguity: 'Ambiguity', domain: 'Domain specificity', risk: 'Risk of error', tools: 'Tool / integration need', modality: 'Required modalities' }
const changeText = (value: unknown): string => (value === null || value === undefined ? 'Not determined' : Array.isArray(value) ? value.join(', ') : String(value))
const TIP_LABELS: Record<string, string> = { reasoning: 'Reasoning', context: 'Context', ambiguity: 'Ambiguity', domain: 'Domain', risk: 'Risk', tools: 'Tools', modality: 'Modality' }
const NEED_LABELS: Record<string, string> = { reasoning: 'Reasoning', context: 'Context', domain: 'Domain knowledge', reliability: 'Reliability', tools: 'Tools' }
const STATUS_LABELS: Record<string, string> = { covers: 'Covers the task', covers_as_described: 'Covers it as described', short: 'Falls short' }
const COST_LABELS: Record<string, string> = { low: 'Low cost', medium: 'Medium cost', high: 'High cost' }

/** The cost line the web app writes under a model name. */
const costText = (item: Candidate): string => [item.cost_band ? COST_LABELS[item.cost_band] : '', item.local ? 'local' : item.free ? 'free, rate-limited' : '', item.illustrative ? 'illustrative' : ''].filter(Boolean).join(' · ')
const shortText = (item: Candidate): string => (item.status === 'short' ? `Falls short in ${(item.shortfalls ?? []).map(need => (NEED_LABELS[need] ?? need).toLowerCase()).join(', ')}` : STATUS_LABELS[item.status ?? 'short'])

/** What the web app's cards show for an analysis (AnalysisResult.tsx, TipsCard.tsx), as plain data, with the same words. */
export function richResult(result: Result): unknown {
  const a = result.analysis
  const m = a.recommendation
  const profile = a.profile as unknown as Record<string, { score: number | null; confidence: string; evidence: string }>
  const modality = a.profile.modality
  return {
    id: a.id,
    task: result.task,
    modelId: m.configuration_id ?? null,
    tag: a.mode === 'demonstration' ? 'Heuristic demo' : 'Uncalibrated',
    explanation: a.profile.explanation,
    profile: DIMENSIONS.map(([key, label]) => ({ label, score: profile[key]?.score ?? null, confidence: profile[key]?.confidence ?? '', evidence: profile[key]?.evidence ?? '' })),
    modality: { required: modality.required, confidence: modality.confidence, evidence: modality.evidence },
    name: m.name,
    sub: [m.label && m.label !== m.name ? m.label : '', costText(m)].filter(Boolean).join(' · '),
    status: m.status ?? 'short',
    statusText: STATUS_LABELS[m.status ?? 'short'],
    price: price(m),
    illustrative: Boolean(m.illustrative),
    usable: Boolean(m.configuration_id) && !m.illustrative,
    coverage: (m.coverage ?? []).map(entry => ({
      need: NEED_LABELS[entry.need] ?? entry.need,
      task: entry.estimated === entry.top ? String(entry.top) : `${entry.estimated}–${entry.top}`,
      level: entry.capability ?? 'n/a',
      provisional: entry.provisional,
      covers: entry.state === 'covers' ? 'Yes' : entry.state === 'covers_as_described' ? 'As described' : 'No',
      state: entry.state,
    })),
    footnote: (m.coverage ?? []).some(entry => entry.provisional) ? (m.illustrative ? '* Illustrative level of a demo model, not a real measurement.' : '* Level from public benchmarks or the automatic measurement, not reviewed by the team yet.') : '',
    levelsFrom: m.levels_from ?? null,
    assessedBy: a.assessment_model ? `Task assessed by ${a.assessment_model} (the project's assessor; your chat model answers)` : null,
    notes: a.notes ?? [],
    warnings: a.warnings,
    heading: a.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation',
    headMeta: `${a.mode} · ${a.provider} · ${a.latency_ms} ms`,
    meta: `${a.mode} · ${a.provider} · ${a.latency_ms} ms · Policy ${a.policy_version}`,
    completeness: a.completeness ?? null,
    hasPrevious: Boolean(a.previous_analysis_id),
    changeList: (a.changes ?? []).map(change => ({ label: CHANGE_LABELS[change.dimension] ?? change.dimension, before: changeText(change.before), after: changeText(change.after), evidence: change.evidence ?? '' })),
    rationale: a.rationale,
    alternatives: a.alternatives.map(item => ({ name: item.name, short: shortText(item) + (item.status !== 'short' && item.gap === 1 ? ', more than needed' : ''), cost: costText(item) })),
    suggestion: a.suggestion ? { name: a.suggestion.name, reason: a.suggestion_reason ?? '', sub: [a.suggestion.model ?? '', a.suggestion.cost_band ? `${a.suggestion.cost_band} cost` : '', a.suggestion.levels_from ? `Levels from: ${a.suggestion.levels_from}` : ''].filter(Boolean).join(' · ') } : null,
    questions: a.clarification_questions,
    guidance: a.guidance,
    tips: a.tips.map(tip => ({ title: tip.dimension ? TIP_LABELS[tip.dimension] ?? tip.dimension : 'General', text: tip.text })),
    assessor: assessedBy(a),
    coach: result.coachAvailable,
    coachCard: result.coach
      ? {
          mode: result.coachMode,
          status: result.coach.status,
          improved: result.improved ?? null,
          suggestions: result.coach.suggestions.map(item => ({ kind: item.kind, title: item.title, why: item.rationale, quote: item.quote, replacement: item.replacement })),
          questions: result.coach.open_questions,
        }
      : undefined,
    coachError: result.error,
    at: result.at,
  }
}

function page(nonce: string, csp: string, tab: Tab): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  :root { --ink:#222; --muted:#727272; --line:#e4e4e4; --surface:#fff; --bg:#f9f9f9; --blue:#3a3a3a; --blue-dark:#292929; --soft:#f2f2f2; --dark:#202020; --track:#f0f0f0; --field:#fff; --chip:#f3f3f3; }
  body.vscode-dark, body.vscode-high-contrast { --ink:#ececec; --muted:#9a9a9a; --line:#333; --surface:#1d1d1d; --bg:#141414; --blue:#e8e8e8; --blue-dark:#fff; --soft:#262626; --dark:#ececec; --track:#2c2c2c; --field:#181818; --chip:#2a2a2a; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: 'Inter', ui-sans-serif, system-ui, 'Segoe UI', sans-serif; font-size: 13px; }
  button, input, select, textarea { font: inherit; } button { cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--muted); outline-offset: 2px; }
  .side { position: fixed; inset: 14px auto 14px 14px; width: 210px; display: flex; flex-direction: column; padding: 18px 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 10px 35px rgba(0,0,0,.06); }
  .brand { display: flex; align-items: center; gap: 10px; padding: 2px 10px 22px; font-size: 19px; font-weight: 700; letter-spacing: -.04em; }
  .mark { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: var(--dark); color: var(--bg); font-size: 15px; }
  .nav { display: flex; flex-direction: column; gap: 6px; }
  .nav button { min-height: 42px; border: 0; border-radius: 10px; background: none; padding: 0 13px; text-align: left; color: var(--muted); font-size: 13px; font-weight: 500; }
  .nav button:hover { color: var(--ink); } .nav button.on { color: var(--bg); background: var(--dark); font-weight: 650; }
  .foot { margin-top: auto; border-top: 1px solid var(--line); padding: 14px 10px 2px; font-size: 11px; color: var(--muted); }
  .foot b { display: block; color: var(--ink); font-weight: 600; word-break: break-all; margin-bottom: 6px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2f9e44; margin-right: 6px; box-shadow: 0 0 0 3px rgba(47,158,68,.18); }
  .page { max-width: 1180px; margin: 0 auto 0 240px; padding: 30px 30px 70px; }
  @media (max-width: 760px) {
    .side { position: static; width: auto; margin: 8px 8px 0; padding: 10px; border-radius: 14px; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 10px; box-shadow: none; }
    .brand { padding: 0 4px; font-size: 15px; } .mark { width: 24px; height: 24px; font-size: 13px; border-radius: 7px; }
    .nav { flex-direction: row; flex-wrap: wrap; gap: 3px; width: 100%; order: 3; } .nav button { min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 8px; }
    .foot { margin: 0 0 0 auto; border: 0; padding: 0; display: flex; align-items: center; gap: 8px; font-size: 10.5px; } .foot b { display: inline; margin: 0 6px 0 0; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .foot > div { display: flex !important; margin: 0 !important; } .foot .btn { width: auto !important; margin: 0 !important; }
    .page { margin: 0; padding: 14px 12px 50px; } h1 { font-size: 24px; } .lead { font-size: 13px; margin-bottom: 16px; } .card { padding: 14px; border-radius: 12px; } .composer textarea { font-size: 14px; }
    .row { flex-wrap: wrap; } .stat { font-size: 24px; } .msgs { max-height: 55vh; } .grid3, .grid2, .chatwrap { grid-template-columns: 1fr; }
  }
  .eyebrow { margin: 0 0 8px; text-transform: uppercase; letter-spacing: .11em; font-size: 11px; font-weight: 700; color: var(--muted); }
  h1 { margin: 0 0 10px; font-size: 34px; line-height: 1.1; letter-spacing: -.045em; font-weight: 650; } h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; } h3 { margin: 0 0 4px; font-size: 13px; }
  .lead { margin: 0 0 24px; max-width: 680px; color: var(--muted); font-size: 15px; line-height: 1.6; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 22px; box-shadow: 0 8px 24px rgba(0,0,0,.04); margin-bottom: 14px; }
  .composer { border-color: var(--line); box-shadow: 0 12px 38px rgba(0,0,0,.07); }
  .composer label { display: block; margin-bottom: 10px; font-weight: 650; font-size: 14px; }
  textarea { display: block; width: 100%; min-height: 120px; resize: vertical; padding: 0; border: 0; outline: none; background: transparent; color: var(--ink); font-size: 15px; line-height: 1.6; }
  textarea::placeholder { color: #a4a4a4; }
  .cfoot { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .btn { min-height: 38px; padding: 0 16px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-weight: 650; font-size: 13px; transition: .15s; }
  .btn:hover { border-color: var(--muted); } .btn:disabled { opacity: .55; cursor: wait; }
  .btn.primary { background: var(--blue); color: var(--bg); border-color: transparent; box-shadow: 0 4px 12px rgba(0,0,0,.14); } .btn.primary:hover { background: var(--blue-dark); transform: translateY(-1px); }
  .btn.small { min-height: 30px; padding: 0 11px; font-size: 12px; } .btn.danger { color: var(--muted); }
  select, .input { height: 38px; border: 1px solid var(--line); border-radius: 9px; background: var(--field); color: var(--ink); padding: 0 10px; max-width: 100%; }
  .muted { color: var(--muted); font-size: 11.5px; line-height: 1.5; margin: 0; }
  .rh { display: flex; justify-content: space-between; align-items: baseline; margin: 30px 2px 14px; } .rh h2 { font-size: 15px; } .rh span { color: var(--muted); font-size: 11px; }
  .grid3 { display: grid; grid-template-columns: 1.1fr 1fr .9fr; gap: 14px; align-items: start; } .grid3 .card { margin: 0; min-height: 360px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .grid2 .card { margin: 0; }
  @media (max-width: 1000px) { .grid3, .grid2 { grid-template-columns: 1fr; } }
  .ch { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .pill { border-radius: 999px; padding: 4px 9px; background: var(--chip); color: var(--muted); font-size: 10px; font-weight: 700; white-space: nowrap; }
  .plist { margin-top: 18px; display: grid; gap: 14px; } .plabel { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
  .track { height: 6px; border-radius: 6px; background: var(--track); overflow: hidden; } .fill { display: block; height: 100%; border-radius: 6px; background: var(--blue); }
  .tier { display: flex; align-items: center; gap: 13px; margin: 20px 0 16px; } .orb { width: 46px; height: 46px; border: 1px solid var(--line); border-radius: 14px; display: grid; place-items: center; background: var(--soft); }
  .orb span { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--blue); color: var(--bg); font-weight: 700; }
  .tier h2 { font-size: 22px; margin-bottom: 2px; }
  .cost { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); font-size: 11px; } .cost strong { margin-left: auto; color: var(--ink); }
  .dots { display: flex; gap: 3px; } .dots i { width: 15px; height: 5px; border-radius: 3px; background: var(--track); } .dots .f { background: var(--blue); }
  ul.why { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 10px; } ul.why li { display: flex; gap: 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .tick { flex: none; width: 18px; height: 18px; border-radius: 50%; background: var(--chip); display: grid; place-items: center; font-size: 10px; color: var(--ink); }
  .tip { display: flex; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); } .tip:first-of-type { border-top: 0; } .tipn { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; } .tip p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
  .override { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 14px; padding: 16px 20px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .privacy { text-align: center; margin: 18px 0 0; color: var(--muted); font-size: 11px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 0; border-top: 1px solid var(--line); } .row:first-of-type { border-top: 0; } .row .w { min-width: 0; } .row .w div:first-child { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
  .sw { display: flex; align-items: flex-start; gap: 12px; padding: 13px 0; border-top: 1px solid var(--line); cursor: pointer; } .sw:first-of-type { border-top: 0; } .sw input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--blue); }
  .stat { font-size: 30px; font-weight: 650; letter-spacing: -.03em; } .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 14px; } .stats .card { margin: 0; padding: 18px; }
  .center { text-align: center; padding: 90px 20px; } table { width: 100%; border-collapse: collapse; font-size: 12px; } td, th { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); } th { color: var(--muted); font-weight: 600; border-top: 0; }
  .err { padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  .chatwrap { display: grid; grid-template-columns: 250px 1fr; gap: 14px; align-items: start; } @media (max-width: 900px) { .chatwrap { grid-template-columns: 1fr; } }
  .chatlist .row { padding: 9px 0; cursor: pointer; } .chatlist .row.on .w div:first-child { color: var(--blue-dark); text-decoration: underline; }
  .conv { display: flex; flex-direction: column; min-height: 520px; padding: 0; overflow: hidden; margin: 0; }
  .msgs { flex: 1; overflow: auto; padding: 18px 20px; max-height: calc(100vh - 290px); min-height: 360px; display: flex; flex-direction: column; gap: 14px; }
  .bubble { max-width: 86%; padding: 11px 14px; border-radius: 14px; line-height: 1.6; font-size: 13.5px; overflow-wrap: anywhere; } .bubble.user { align-self: flex-end; background: var(--blue); color: var(--bg); } .bubble.ai { align-self: flex-start; background: var(--soft); }
  .who { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; } .bubble.user .who { color: inherit; opacity: .7; }
  .bubble p { margin: 0 0 8px; } .bubble p:last-child { margin: 0; } .bubble h4 { margin: 8px 0 4px; font-size: 14px; } .bubble ul { margin: 4px 0 8px; padding-left: 18px; } .bubble code { background: var(--chip); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; } .bubble pre { background: var(--chip); padding: 10px; border-radius: 8px; overflow: auto; font-size: 12px; margin: 6px 0; }
  .bubble .bad { color: var(--muted); font-style: italic; margin-top: 6px; font-size: 12px; }
  .cmp { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--surface); } .cmp textarea { min-height: 54px; max-height: 180px; font-size: 14px; }
  .empty { margin: auto; text-align: center; color: var(--muted); max-width: 420px; line-height: 1.6; }
  .backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(15,15,15,.45); display: grid; place-items: center; padding: 20px; animation: fade .12s ease; }
  .dialog { width: min(480px, 100%); max-height: 88vh; overflow: auto; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 18px; padding: 24px; box-shadow: 0 24px 70px rgba(0,0,0,.28); }
  .dialog h2 { font-size: 20px; margin-bottom: 8px; } .dtext { margin: 0 0 14px; color: var(--muted); line-height: 1.55; white-space: pre-wrap; font-size: 13px; }
  .field { margin: 12px 0; } .field > label { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 650; } .field .hint { margin-top: 4px; }
  .dialog input[type=text], .dialog input[type=password], .dialog input:not([type]), .dialog textarea, .dialog select { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--field); color: var(--ink); font-size: 14px; }
  .dialog textarea { height: auto; min-height: 120px; padding: 10px 12px; line-height: 1.55; } .dialog input:focus, .dialog textarea:focus, .dialog select:focus { outline: 2px solid var(--muted); outline-offset: 1px; }
  .dialog .bad { border-color: #c92a2a !important; }
  .cards { display: grid; gap: 8px; } .opt { text-align: left; padding: 11px 13px; border: 1px solid var(--line); border-radius: 12px; background: var(--field); color: var(--ink); cursor: pointer; } .opt:hover { border-color: var(--muted); } .opt.on { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); } .opt b { display: block; font-size: 13px; } .opt span { color: var(--muted); font-size: 11.5px; }
  .dlist { max-height: 340px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; margin-top: 8px; } .dlist .opt { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; width: 100%; } .dlist .opt:disabled { opacity: .45; cursor: not-allowed; }
  .dfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; flex-wrap: wrap; } .dfoot .spacer { margin-right: auto; display: flex; gap: 6px; }
  .btn.dangerfill { background: #c92a2a; color: #fff; border-color: transparent; box-shadow: none; } .btn.link { background: none; border: 0; color: var(--muted); text-decoration: underline; padding: 0 6px; }
  .check { display: flex; align-items: center; gap: 10px; font-size: 13px; } .check input { width: 16px; height: 16px; accent-color: var(--blue); }
  #toasts { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 36px)); }
  .toast { padding: 12px 14px; border-radius: 12px; background: var(--dark); color: var(--bg); font-size: 13px; line-height: 1.5; box-shadow: 0 10px 30px rgba(0,0,0,.25); animation: rise .18s ease; } .toast.err { background: #c92a2a; color: #fff; }
  details.mem { border-top: 1px solid var(--line); padding: 10px 0; } details.mem summary { cursor: pointer; font-weight: 600; font-size: 13px; } details.mem dl { margin: 8px 0 0; display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; font-size: 12px; } details.mem dt { color: var(--muted); }
  .cov td, .cov th { font-size: 11.5px; padding: 6px 4px; } .gold { color: var(--muted); }
  @keyframes fade { from { opacity: 0 } to { opacity: 1 } } @keyframes rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
  .chart { width: 100%; height: auto; display: block; } .bar-a { fill: var(--blue); } .bar-b { fill: var(--muted); opacity: .6; } .axis { fill: var(--muted); font-size: 11px; text-anchor: middle; } .gridl { stroke: var(--line); stroke-width: 1; fill: none; }
  .line { fill: none; stroke: var(--blue); stroke-width: 3; stroke-linejoin: round; } .area { fill: var(--blue); opacity: .08; } .dot { fill: var(--surface); stroke: var(--blue); stroke-width: 3; }
  .legend { display: flex; gap: 16px; margin: 6px 0 8px; font-size: 11px; color: var(--muted); } .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; background: var(--blue); } .legend i.b { background: var(--muted); opacity: .6; }
  .tabsmall { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); margin: 4px 0 10px; } .tabsmall button { border: 0; background: none; padding: 6px 12px; border-radius: 8px; color: var(--muted); font-size: 12px; font-weight: 600; } .tabsmall button.on { background: var(--surface); color: var(--ink); box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 10px 0; } .metrics div { padding: 12px; border: 1px solid var(--line); border-radius: 12px; } .metrics dt { color: var(--muted); font-size: 11px; } .metrics dd { margin: 4px 0 0; font-size: 18px; font-weight: 650; }
  .banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); font-size: 12.5px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: var(--chip); font-size: 11.5px; }
  .coach pre { white-space: pre-wrap; margin: 8px 0; padding: 12px; border-radius: 10px; background: var(--soft); font: inherit; line-height: 1.6; }
  .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; margin-right: 8px; }
  .info { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--muted); color: var(--muted); font-size: 10px; cursor: help; }
  .note { margin-top: 14px; padding: 10px; border-radius: 8px; background: var(--soft); color: var(--muted); font-size: 11.5px; line-height: 1.5; }
  .warnnote { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--soft); border-left: 3px solid var(--muted); font-size: 12px; line-height: 1.5; }
  .pill.st-covers { background: var(--blue); color: var(--bg); } .pill.st-short { border: 1px solid var(--muted); }
  .live { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; min-height: 0; } .hint { display: flex; gap: 8px; align-items: flex-start; max-width: 100%; padding: 7px 11px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); font-size: 12px; line-height: 1.45; } .hint b { display: block; font-size: 12px; } .hint.warn { border-color: var(--muted); } .hint.ok { color: var(--muted); background: none; border-style: dashed; }
  .newchat { width: 100%; margin: 0 0 8px; justify-content: flex-start; }
  .assist { display: block; } .assist-main { display: flex; flex-direction: column; min-height: calc(100vh - 80px); position: relative; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; min-height: 34px; margin-bottom: 6px; } .toolbar .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .assist .msgs { flex: 1; max-height: none; min-height: 220px; padding: 8px 2px 18px; overflow: visible; }
  .chat-empty { margin: 60px auto; text-align: center; max-width: 440px; } .chat-empty h2 { font-size: 26px; letter-spacing: -.03em; margin-bottom: 10px; } .chat-empty p { line-height: 1.6; }
  .composer2 { position: sticky; bottom: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px 12px; box-shadow: 0 12px 38px rgba(0,0,0,.09); }
  .composer2 .wrapta { position: relative; } .composer2 textarea { padding-right: 40px; min-height: 64px; }
  .coachbtn { position: absolute; top: 0; right: 0; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line); background: var(--soft); color: var(--ink); cursor: pointer; display: grid; place-items: center; } .coachbtn b { position: absolute; top: -6px; right: -6px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--blue); color: var(--bg); font-size: 10px; display: grid; place-items: center; padding: 0 3px; }
  .cfoot2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; border-top: 1px solid var(--line); margin-top: 10px; padding-top: 10px; } .cfoot2 .left, .cfoot2 .right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .trigger { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--field); color: var(--ink); cursor: pointer; max-width: 100%; font-size: 12px; } .trigger b { color: var(--muted); font-weight: 600; } .trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
  .count { color: var(--muted); font-size: 11.5px; } .recchip { border: 0; background: none; color: var(--ink); text-decoration: underline; cursor: pointer; font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pop { position: absolute; z-index: 20; left: 0; right: auto; width: min(380px, 100%); max-height: 70vh; overflow: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.22); padding: 10px; } .pop.up { bottom: calc(100% + 8px); } .pop.down { top: 40px; right: 0; left: auto; }
  .pop h4 { margin: 4px 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); } .pop .opt { width: 100%; display: flex; gap: 10px; align-items: flex-start; border: 0; border-radius: 10px; margin: 0; } .pop .opt:hover, .pop .opt[aria-pressed=true] { background: var(--soft); } .pop .opt:disabled { opacity: .5; cursor: not-allowed; }
  .sym { flex: none; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--soft); border: 1px solid var(--line); font-size: 12px; font-weight: 700; } .pop small { display: block; color: var(--muted); font-size: 11px; line-height: 1.4; }
  .badge { margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; background: var(--chip); color: var(--muted); } .badge.is-measured { background: rgba(47,158,68,.15); color: #2f9e44; } .badge.is-evaluating { background: rgba(210,153,34,.18); color: #b07d12; } .badge.is-failed { background: rgba(201,42,42,.15); color: #c92a2a; }
  .popfoot { border-top: 1px solid var(--line); margin-top: 6px; padding: 8px 6px 2px; } .popfoot button { border: 0; background: none; color: var(--ink); font-weight: 600; cursor: pointer; padding: 0; }
  .notice { margin: 8px 2px 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .drawer { position: fixed; z-index: 40; right: 0; top: 0; bottom: 0; width: min(540px, 100%); background: var(--surface); border-left: 1px solid var(--line); box-shadow: -18px 0 50px rgba(0,0,0,.22); display: flex; flex-direction: column; }
  .drawer-backdrop { position: fixed; inset: 0; z-index: 39; background: rgba(15,15,15,.35); }
  .drawer-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 20px 12px; border-bottom: 1px solid var(--line); } .drawer-head h2 { margin-top: 2px; }
  .drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px 24px; display: flex; flex-direction: column; gap: 14px; } .drawer-body > * { flex: none; } .drawer-body .card { margin: 0; box-shadow: none; min-height: 0; padding: 18px; }
  .drawer-foot { border-top: 1px solid var(--line); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .spin { display: inline-block; width: 14px; height: 14px; margin-right: 8px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--blue); animation: turn .8s linear infinite; vertical-align: -2px; } @keyframes turn { to { transform: rotate(360deg) } }
  @media (max-width: 760px) { .drawer { top: auto; left: 0; width: 100%; max-height: 82vh; border-left: 0; border-top: 1px solid var(--line); border-radius: 18px 18px 0 0; box-shadow: 0 -18px 50px rgba(0,0,0,.25); } .pop.down { left: 0; right: auto; } }
  @media (min-width: 1280px) { .assist.with-drawer { display: grid; grid-template-columns: minmax(0, 1fr) 460px; gap: 18px; align-items: start; } .assist.with-drawer .drawer { position: sticky; top: 14px; width: auto; height: calc(100vh - 28px); border: 1px solid var(--line); border-radius: 16px; box-shadow: none; } .assist.with-drawer + .drawer-backdrop, .assist .drawer-backdrop { display: none; } }
  [hidden] { display: none !important; }
</style></head>
<body>
<aside class="side">
  <div class="brand"><span class="mark">✦</span>AdaptAI</div>
  <button class="btn newchat" id="newchat">＋ New chat</button>
  <nav class="nav" id="nav">
    <button data-tab="analyse">Assistant</button><button data-tab="progress">My progress</button><button data-tab="profile">Profile</button><button data-tab="models">LLM config</button><button data-tab="shortcuts">Shortcuts</button>
  </nav>
  <div class="foot"><span id="acct"></span><div style="display:grid;gap:6px;margin-top:10px"><button class="btn small" id="signout" hidden>Sign out</button><button class="btn small" id="gear">Settings</button></div></div>
</aside>
<main class="page" id="main"></main>
<div id="modal"></div><div id="toasts" aria-live="polite"></div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi()
  const send = (type, extra) => api.postMessage(Object.assign({ type }, extra))
  let tab = ${JSON.stringify(tab)}
  let draft = (api.getState() || {}).text || ''
  const main = document.getElementById('main')
  const el = (tag, props, ...kids) => { const e = document.createElement(tag); if (props) for (const k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else if (k === 'role' || k.indexOf('aria-') === 0 || k.indexOf('data-') === 0) e.setAttribute(k, props[k]); else e[k] = props[k] } for (const kid of kids.flat()) if (kid != null) e.append(kid); return e }
  const btn = (label, type, extra, cls) => el('button', { text: label, class: 'btn small ' + (cls || ''), onclick: () => send(type, extra) })
  const intro = (eyebrow, title, lead) => [el('p', { class: 'eyebrow', text: eyebrow }), el('h1', { text: title }), el('p', { class: 'lead', text: lead })]
  const row = (title, sub, ...buttons) => el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', { text: title }), sub ? el('p', { class: 'muted', text: sub }) : null), el('div', { class: 'btns' }, buttons))
  const card = (eyebrow, title, ...kids) => el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: eyebrow }), title ? el('h2', { text: title, style: 'margin-bottom:12px' }) : null, kids)
  const mark = () => document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  document.getElementById('nav').addEventListener('click', e => { const t = e.target.closest('button'); if (t) { tab = t.dataset.tab; mark(); send('tab', { tab }) } })
  document.getElementById('gear').addEventListener('click', () => send('settings'))
  document.getElementById('newchat').addEventListener('click', () => { tab = 'analyse'; mark(); drawerOpen = false; pop = null; send('tab', { tab: 'analyse' }); send('chatSelect', { id: '' }) })
  document.getElementById('signout').addEventListener('click', () => send('signOut'))

  function drawerCards(r, d) {
    const out = []
    if (r.completeness != null) {
      const cc = el('section', { class: 'card' }, el('h3', { text: 'Profile completeness' }), el('div', { class: 'track', role: 'meter', 'aria-label': 'Profile completeness', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': r.completeness, style: 'margin:8px 0' }, el('span', { class: 'fill', style: 'width:' + r.completeness + '%' })), el('p', { class: 'muted', text: r.completeness + '/100 · how much of the profile is determined and confident. Uncalibrated.' }))
      if (r.hasPrevious) {
        cc.append(el('h3', { text: 'What changed since the previous analysis', style: 'margin-top:12px' }))
        if (!r.changeList.length) cc.append(el('p', { class: 'muted', text: 'No dimension changed.' }))
        else cc.append(el('ul', null, r.changeList.map(c => el('li', null, el('strong', { text: c.label }), ': ' + c.before + ' → ' + c.after, c.evidence ? el('span', { class: 'muted', text: ' · ' + c.evidence }) : null))))
      }
      out.push(cc)
    }
    if (r.questions.length) out.push(el('section', { class: 'card' }, el('h3', { text: 'Clarification suggested' }), el('p', { text: 'Add these details to your message and analyse it again.' }), el('ul', null, r.questions.map(q => el('li', { text: q })))))
    if (r.guidance.length) out.push(el('section', { class: 'card' }, el('h3', { text: 'Assessment guidance' }), el('ul', null, r.guidance.map(q => el('li', { text: q })))))

    const tier = el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: 'Recommended model' }),
      el('div', { class: 'ch' }, el('div', null, el('h2', { text: r.name }), el('p', { class: 'muted', text: r.sub })), el('span', { class: 'pill st-' + r.status, text: r.statusText })))
    if (r.usable) tier.append(el('div', { class: 'btns', style: 'margin-top:10px' }, btn('Use this model', 'result', { command: 'adaptai.useModel', id: r.id }, 'primary')))
    else tier.append(el('p', { class: 'muted', style: 'margin-top:8px', text: r.illustrative ? 'Illustrative: not a real model' : 'Not among your models' }))
    if (r.illustrative) tier.append(el('p', { class: 'warnnote', text: 'None of your models is classified yet, so AdaptAI shows an example. Add a model in LLM config and let it be evaluated to get a real recommendation.' }))
    if (r.coverage.length) { const t = el('table', { class: 'cov', style: 'margin-top:12px' }); t.append(el('tr', null, el('th', { text: 'Need' }), el('th', { text: 'Task' }), el('th', { text: 'Model' }), el('th', { text: 'Covers' }))); for (const c of r.coverage) t.append(el('tr', null, el('td', { text: c.need }), el('td', { text: c.task }), el('td', { text: String(c.level) + (c.provisional ? ' *' : '') }), el('td', { text: c.covers }))); tier.append(t) }
    if (r.footnote) tier.append(el('p', { class: 'muted', text: r.footnote }))
    if (r.levelsFrom) tier.append(el('p', { class: 'muted', text: 'Levels from: ' + r.levelsFrom }))
    if (r.assessedBy) tier.append(el('p', { class: 'muted', text: r.assessedBy }))
    if (r.notes.length) tier.append(el('ul', { class: 'why' }, r.notes.map(n => el('li', null, el('span', { class: 'tick', text: '!' }), el('span', { text: n })))))
    tier.append(el('h3', { text: 'Why this model', style: 'margin-top:14px' }), el('p', { text: r.rationale }))
    if (r.alternatives.length) { tier.append(el('h3', { text: 'Other models you can use', style: 'margin-top:14px' })); for (const a of r.alternatives) tier.append(el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', { text: a.name }), el('p', { class: 'muted', text: a.short + (a.cost ? ' · ' + a.cost : '') })))) }
    if (r.suggestion) tier.append(el('div', { class: 'banner', style: 'margin-top:14px;display:block' }, el('p', { class: 'eyebrow', text: 'Also on OpenRouter' }), el('p', null, el('strong', { text: r.suggestion.name }), ' ' + r.suggestion.reason + '.'), el('p', { class: 'muted', text: r.suggestion.sub })))
    tier.append(el('div', { class: 'btns', style: 'margin-top:12px' }, btn('Task solved?', 'result', { command: 'adaptai.taskOutcome', id: r.id }), btn('Full report', 'open', { id: r.id }), btn('Copy summary', 'result', { command: 'adaptai.copySummary', id: r.id })))
    out.push(tier)

    const tips = el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: 'Practical guidance' }), el('h2', { text: 'Improve your request', style: 'margin-bottom:8px' }))
    if (r.questions.length) tips.append(el('div', { class: 'tip' }, el('span', { class: 'tipn', text: '01' }), el('div', null, el('h3', { text: 'Clarify first' }), el('p', { text: 'Answer the ' + (r.questions.length === 1 ? 'clarification question' : r.questions.length + ' clarification questions') + ' above and analyse the task again; tips for each dimension follow once the task is clear.' }))))
    else if (!r.tips.length) tips.append(el('div', { class: 'tip' }, el('div', null, el('p', { text: 'No tips for this analysis.' }))))
    else r.tips.forEach((t, i) => tips.append(el('div', { class: 'tip' }, el('span', { class: 'tipn', text: '0' + (i + 1) }), el('div', null, el('h3', { text: t.title }), el('p', { text: t.text })))))
    out.push(tips)

    if (r.coach) {
      const cc = el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: 'Optional' }), el('h3', { text: 'Prompt Coach' }), el('p', { class: 'muted', text: 'Selecting Improve with Prompt Coach sends this task to ' + destinationText(d) + '. The Prompt Coach never saves the task it receives or its suggestions.' }), el('div', { class: 'btns', style: 'margin-top:8px' }, el('button', { class: 'btn small', text: d.coachBusy ? 'Improving…' : 'Improve with Prompt Coach', disabled: !!(d.coachBusy || d.analysing), onclick: () => send('coach', { text: r.task, mode: 'rewrite' }) })))
      out.push(cc)
      if (r.coachCard) out.push(coachPanel(r.coachCard, null))
    }

    const profile = el('section', { class: 'card' }, el('div', { class: 'ch' }, el('div', null, el('p', { class: 'eyebrow', text: 'Task analysis' }), el('h2', { text: 'Complexity profile' })), el('span', { class: 'pill', text: r.tag })))
    const list = el('div', { class: 'plist' })
    const LV = ['Low', 'Medium', 'High']
    for (const x of r.profile) list.append(el('div', null,
      el('div', { class: 'plabel' }, el('span', { text: x.label }), el('span', { class: 'info', tabIndex: 0, title: x.evidence, text: 'i' })),
      x.score == null ? el('p', { class: 'muted', text: 'Not determined' }) : el('div', { class: 'track', role: 'meter', 'aria-label': x.label, 'aria-valuemin': 1, 'aria-valuemax': 3, 'aria-valuenow': x.score, 'aria-valuetext': LV[x.score - 1] }, el('span', { class: 'fill', style: 'width:' + (x.score / 3 * 100) + '%' })),
      el('p', { class: 'muted', text: (x.score == null ? '' : LV[x.score - 1] + ' · ') + 'Confidence: ' + x.confidence }),
      el('p', { class: 'muted', text: x.evidence })))
    profile.append(list, el('p', { class: 'note', text: r.explanation }),
      el('div', { style: 'margin-top:12px' }, el('strong', { text: 'Required modalities' }), el('span', { text: ' ' + (r.modality.required ? r.modality.required.join(', ') : 'Not determined') }), el('p', { class: 'muted', text: 'Confidence: ' + r.modality.confidence }), el('p', { class: 'muted', text: r.modality.evidence })),
      el('p', { class: 'muted', style: 'margin-top:10px', text: 'Scale: 1 low · 2 medium · 3 high. Modality describes execution requirements; this form accepts text only.' }),
      el('p', { class: 'muted', text: 'Confidence labels are qualitative and uncalibrated.' }))
    out.push(profile)
    for (const w of r.warnings) out.push(el('p', { class: 'note', text: w }))
    out.push(el('p', { class: 'muted', text: r.meta }))
    return out
  }

  function destinationText(d) {
    if (d.assessment) return d.assessment.label + (d.assessment.model ? ' · ' + d.assessment.model : '')
    const o = d.options.find(x => x.id === d.chatModel) || d.options.find(x => x.id === d.autoId)
    return o ? o.label + (o.model ? ' · ' + o.model : '') : 'the selected model'
  }

  function localChecks(value, last) {
    const found = []
    const text = value.trim()
    if (!text) return found
    const words = text.split(/\\s+/).length
    if (words < 6) found.push({ title: 'Very short description', detail: 'Say what the result is for and who it is for; a few words rarely determine the task.' })
    if (/[\\w.+-]+@[\\w-]+\\.[\\w.]+/.test(text)) found.push({ warn: true, title: 'Email address in the task', detail: 'The task is sent to a model. Replace personal data with a placeholder such as [email].' })
    if (/(?:\\+?\\d[\\s-]?){9,}/.test(text)) found.push({ warn: true, title: 'Phone or ID number in the task', detail: 'Replace personal numbers with a placeholder before analysing.' })
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /(api[_-]?key|secret|token|passw(or)?d)\\s*[:=]\\s*\\S{6,}/i.test(text) || /\\b(sk|gsk|ghp|xox[bp])[-_][A-Za-z0-9_-]{16,}/.test(text)) found.push({ warn: true, title: 'This looks like a key or a password', detail: 'Keys and passwords do not belong in a task. Remove it; you will be asked again before anything is sent.' })
    if (/\\b(attached|attachment|enclosed|anexo|anexos|em anexo)\\b/i.test(text) && text.length < 600) found.push({ warn: true, title: 'It mentions an attachment, but only text is sent', detail: 'Files are not attached. Paste the content into the message, or the model has to guess what it says.' })
    if (text.length > 8000) found.push({ warn: true, title: 'Longer than 8000 characters', detail: 'The analysis reads only the first 8000 characters, and the result says so.' })
    if (last && last.task && last.task.trim() === text) {
      const open = last.profile.filter(p => p.score == null || p.confidence === 'low' || p.confidence === 'undetermined').map(p => p.label.toLowerCase())
      if (open.length) found.push({ title: 'The last analysis was unsure about ' + open.length + (open.length === 1 ? ' dimension' : ' dimensions'), detail: open.slice(0, 4).join(', ') + '. Add detail about them and analyse again.' })
    }
    return found
  }

  function toast(kind, text) { const t = el('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), text }); document.getElementById('toasts').append(t); setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4500) }
  function showDialog(m) {
    const back = el('div', { class: 'backdrop' }); const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': m.title })
    const getters = {}; let done = false
    const finish = values => { if (done) return; done = true; back.remove(); document.removeEventListener('keydown', onKey, true); send('dialogResult', { id: m.id, values }) }
    const collect = extra => { const out = {}; let ok = true; for (const f of m.fields || []) { const g = getters[f.name]; const v = g.get(); out[f.name] = v; if (f.required && !String(v).trim()) { ok = false; g.mark() } } if (extra) out.__extra = extra; return ok ? out : null }
    const submit = extra => { const v = collect(extra); if (v) finish(v) }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(undefined) } }
    document.addEventListener('keydown', onKey, true)
    box.append(el('h2', { text: m.title })); if (m.text) box.append(el('p', { class: 'dtext', text: m.text }))
    let first = null
    for (const f of m.fields || []) {
      const wrap = el('div', { class: 'field' }); let input
      if (f.type === 'cards') {
        let value = f.value || (f.options[0] && f.options[0].value); const group = el('div', { class: 'cards' })
        const draw = () => group.querySelectorAll('.opt').forEach(b => b.classList.toggle('on', b.dataset.v === value))
        for (const o of f.options) group.append(el('button', { type: 'button', class: 'opt', 'data-v': o.value, onclick: () => { value = o.value; draw() } }, el('b', { text: o.label }), o.sub ? el('span', { text: o.sub }) : null))
        getters[f.name] = { get: () => value, mark: () => {} }; draw(); wrap.append(el('label', { text: f.label }), group); box.append(wrap); continue
      }
      if (f.type === 'checkbox') { input = el('input', { type: 'checkbox', checked: !!f.value }); wrap.append(el('label', { class: 'check' }, input, f.label)); getters[f.name] = { get: () => input.checked, mark: () => {} } }
      else {
        if (f.type === 'textarea') input = el('textarea', { value: f.value || '', placeholder: f.placeholder || '' })
        else if (f.type === 'select') { input = el('select'); for (const o of f.options) input.append(el('option', { value: o.value, text: o.label, selected: o.value === f.value })) }
        else { input = el('input', { type: f.type === 'password' ? 'password' : 'text', value: f.value || '', placeholder: f.placeholder || '', autocomplete: f.type === 'password' ? 'current-password' : 'off' }); input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }) }
        wrap.append(el('label', { text: f.label }), input); getters[f.name] = { get: () => input.value, mark: () => input.classList.add('bad') }
        input.addEventListener('input', () => input.classList.remove('bad'))
      }
      if (f.hint) wrap.append(el('p', { class: 'muted hint', text: f.hint })); box.append(wrap); if (!first && f.type !== 'cards') first = input
    }
    if (m.reveal) { const field = el('input', { type: 'text', value: m.reveal, readOnly: true }); field.addEventListener('focus', () => field.select()); box.append(el('div', { class: 'field' }, field, el('div', { class: 'btns', style: 'margin-top:8px' }, el('button', { type: 'button', class: 'btn small', text: 'Copy', onclick: () => { field.select(); try { document.execCommand('copy'); toast('ok', 'Copied.') } catch (e) { toast('err', 'Select the text and copy it.') } } })))); first = field }
    if (m.list) {
      const search = el('input', { type: 'text', placeholder: 'Search…' }); const list = el('div', { class: 'dlist' })
      const draw = () => { list.replaceChildren(); const q = search.value.toLowerCase(); let n = 0; for (const it of m.list.items) { if (q && !(it.title + ' ' + (it.sub || '')).toLowerCase().includes(q)) continue; if (++n > 200) break; list.append(el('button', { type: 'button', class: 'opt', disabled: !!it.disabled, onclick: () => finish({ pick: it.key }) }, el('b', { text: it.title }), it.sub ? el('span', { text: it.sub }) : null)) } if (!n) list.append(el('p', { class: 'muted', style: 'padding:12px', text: 'No match.' })) }
      search.addEventListener('input', draw); draw(); box.append(search, list); first = search
    }
    const foot = el('div', { class: 'dfoot' })
    if (m.extra && m.extra.length) { const sp = el('div', { class: 'spacer' }); for (const x of m.extra) sp.append(el('button', { type: 'button', class: 'btn link', text: x.label, onclick: () => finish({ __extra: x.key }) })); foot.append(sp) }
    if (m.cancel !== '') foot.append(el('button', { type: 'button', class: 'btn', text: m.cancel || 'Cancel', onclick: () => finish(undefined) }))
    if (!m.list) foot.append(el('button', { type: 'button', class: 'btn ' + (m.danger ? 'dangerfill' : 'primary'), text: m.confirm || 'OK', onclick: () => submit() }))
    box.append(foot); back.append(box); back.addEventListener('mousedown', e => { if (e.target === back) finish(undefined) }); document.getElementById('modal').append(back)
    setTimeout(() => first && first.focus(), 30)
  }

  function inline(text) {
    const out = []
    const parts = text.split(/(\\*\\*[^*]+\\*\\*|\\x60[^\\x60]+\\x60)/)
    for (const part of parts) { if (!part) continue; if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push(el('strong', { text: part.slice(2, -2) })); else if (part.startsWith('\\x60') && part.endsWith('\\x60') && part.length > 2) out.push(el('code', { text: part.slice(1, -1) })); else out.push(part) }
    return out
  }
  function md(text) {
    const box = el('div'); let list = null, fence = null, table = null
    const flush = () => { list = null; table = null }
    for (const line of String(text).split('\\n')) {
      if (line.startsWith('\\x60\\x60\\x60')) { if (fence) { box.append(fence); fence = null } else { flush(); fence = el('pre', { text: '' }) } continue }
      if (fence) { fence.textContent += line + '\\n'; continue }
      if (/^\\s*\\|/.test(line)) { if (!table) { table = el('pre', { text: '' }); box.append(table) } if (!/^\\s*\\|[\\s:|-]+\\|\\s*$/.test(line)) table.textContent += line + '\\n'; continue }
      table = null
      const h = line.match(/^#{1,6}\\s+(.*)/); if (h) { flush(); box.append(el('h4', null, inline(h[1]))); continue }
      const li = line.match(/^\\s*[-*]\\s+(.*)/); if (li) { if (!list) { list = el('ul'); box.append(list) } list.append(el('li', null, inline(li[1]))); continue }
      list = null
      if (line.trim()) box.append(el('p', null, inline(line)))
    }
    if (fence) box.append(fence)
    return box
  }
  let live = null
  const bubble = (role, who, text, error) => { const b = el('div', { class: 'bubble ' + (role === 'user' ? 'user' : 'ai') }, el('div', { class: 'who', text: who }), role === 'user' ? el('div', { text, style: 'white-space:pre-wrap' }) : md(text || '')); if (error) b.append(el('div', { class: 'bad', text: error })); return b }

  let drawerOpen = false
  let pop = null
  let lastData = null
  const MAXC = 8000
  const SYMBOLS = { demo: 'D', openrouter: 'R', lmstudio: 'S' }

  function modelPop(d, sel) {
    const box = el('div', { class: 'pop up', role: 'dialog', 'aria-label': 'Choose chat model' })
    const choose = id => { pop = null; send('chatModel', { id }); }
    box.append(el('h4', { text: 'Chat model' }))
    box.append(el('button', { class: 'opt', type: 'button', 'aria-pressed': !sel, disabled: !d.autoId, onclick: () => choose('') }, el('span', { class: 'sym', text: '✦' }), el('span', null, el('b', null, 'Auto ', el('span', { class: 'badge', text: 'Default' })), el('small', { text: d.auto ? 'Uses the project ' + (d.auto.provider === 'groq' ? 'Groq' : d.auto.label) + ' model' : 'Project model is unavailable' }), d.auto && d.auto.model ? el('small', { text: d.auto.model }) : null)))
    for (const [source, title] of [['personal', 'Your models'], ['server', 'Project models']]) {
      const items = d.options.filter(o => o.source === source)
      if (!items.length) continue
      box.append(el('h4', { text: title }))
      for (const o of items) box.append(el('button', { class: 'opt', type: 'button', 'aria-pressed': !!(sel && sel.id === o.id), onclick: () => choose(o.id) }, el('span', { class: 'sym', text: SYMBOLS[o.provider] || o.provider.slice(0, 1).toUpperCase() }), el('span', null, el('b', null, o.model || o.label, el('span', { class: 'badge is-' + o.status.state, text: o.status.text })), el('small', { text: o.label + ' · ' + (o.external ? 'External' : 'Local') }))))
    }
    box.append(el('div', { class: 'popfoot' }, el('button', { type: 'button', text: 'Manage models ↗', onclick: () => { pop = null; tab = 'models'; mark(); send('tab', { tab: 'models' }) } }), el('small', { class: 'muted', text: ' Add your own providers in LLM config.' })))
    return box
  }

  function chatsPop(d) {
    const box = el('div', { class: 'pop down', role: 'dialog', 'aria-label': 'Chats' })
    box.append(el('h4', { text: 'Chats' }))
    if (!d.chats.length) box.append(el('p', { class: 'muted', style: 'padding:6px', text: 'No chats yet.' }))
    for (const x of d.chats) {
      const r = el('div', { class: 'row', style: 'padding:8px 6px' }, el('div', { class: 'w', style: 'cursor:pointer', onclick: () => { pop = null; send('chatSelect', { id: x.id }) } }, el('div', { text: x.title + (x.id === d.current ? ' (current)' : '') }), el('p', { class: 'muted', text: x.count + ' messages' })), el('div', { class: 'btns' }, btn('Rename', 'chatRename', { id: x.id }), btn('Delete', 'chatDelete', { id: x.id }, 'danger')))
      box.append(r)
    }
    return box
  }

  function coachPop(d, area, found) {
    const box = el('div', { class: 'pop up coach', role: 'dialog', 'aria-label': 'Prompt Coach' })
    box.append(el('h4', { text: 'Prompt Coach' }))
    if (!area.value.trim()) box.append(el('p', { class: 'muted', style: 'padding:6px', text: 'Describe your task first. The Coach looks at what you wrote.' }))
    else if (!found.length) box.append(el('p', { class: 'muted', style: 'padding:6px', text: 'No issues found by the local checks. Nothing was sent.' }))
    for (const h of found) box.append(el('div', { class: 'hint ' + (h.warn ? 'warn' : ''), style: 'margin:4px 0' }, el('span', { text: h.warn ? '!' : 'i' }), el('div', null, el('b', { text: h.title }), el('span', { text: h.detail }))))
    const mode = el('select', { 'aria-label': 'How the Prompt Coach helps' }, el('option', { value: 'rewrite', text: 'Rewrite' }), el('option', { value: 'edits', text: 'Edits' }), el('option', { value: 'tips', text: 'Tips' }))
    box.append(el('p', { class: 'muted', style: 'margin:10px 6px 6px', text: 'Selecting Improve sends this task to ' + destinationText(d) + '. It changes your text only when you press Use this text.' }),
      el('div', { class: 'btns', style: 'padding:0 6px 6px' }, mode, el('button', { class: 'btn small primary', text: d.coachBusy ? 'Improving…' : 'Improve with Prompt Coach', disabled: !!(d.coachBusy || d.analysing || !area.value.trim()), onclick: () => send('coach', { text: area.value, mode: mode.value }) })))
    if (d.last && d.last.coachCard && d.last.task && d.last.task.trim() === area.value.trim()) box.append(coachPanel(d.last.coachCard, area))
    return box
  }

  function drawerEl(d, area) {
    const r = d.last
    const loading = !!d.analysing
    const stale = !!(r && r.task && area.value.trim() !== r.task.trim())
    const close = () => { drawerOpen = false; renderTab() }
    const head = el('div', { class: 'drawer-head' }, el('div', null, el('p', { class: 'eyebrow', text: 'Analysis' }), el('h2', { text: loading ? 'Analysing…' : d.analysisError && !r ? 'Analysis failed' : r ? r.heading : 'No analysis yet' })), el('button', { class: 'btn small', 'aria-label': 'Close analysis', text: '×', onclick: close }))
    const body = el('div', { class: 'drawer-body' })
    if (loading) body.append(el('p', { role: 'status', class: 'muted' }, el('span', { class: 'spin' }), 'Assessing complexity, risk and context…'))
    else {
      if (d.analysisError) body.append(el('div', { class: 'err', role: 'alert', text: 'The analysis failed: ' + d.analysisError + ' Select Analyse to try again.' }))
      if (!r && !d.analysisError) body.append(el('p', { class: 'muted', text: 'Write a message and select Analyse to see how complete it is and which of your models fits it.' }))
      if (r) {
        if (stale) body.append(el('p', { class: 'banner', role: 'status', text: 'The message changed since this analysis. Analyse again to update it.' }))
        body.append(...drawerCards(r, d))
      }
    }
    const aside = el('aside', { class: 'drawer', 'aria-label': 'Analysis' }, head, body)
    if (r && !loading && !stale && area.value.trim() && !d.streaming) aside.append(el('div', { class: 'drawer-foot' }, el('span', { text: 'Happy with the analysis?' }), el('button', { class: 'btn primary', text: 'Send this message', onclick: () => sendNow(area) })))
    return aside
  }

  function sendNow(area) {
    const text = area.value
    if (!text.trim()) return
    area.value = ''; draft = ''; api.setState({ text: '' }); drawerOpen = false; pop = null
    send('chatSend', { text })
  }

  function assistantTab(d) {
    const wrap = el('div', { class: 'assist' + (drawerOpen ? ' with-drawer' : '') })
    const col = el('section', { class: 'assist-main' })
    const current = d.chats.find(c => c.id === d.current)
    col.append(el('div', { class: 'toolbar' }, el('span', { class: 'muted', text: current ? current.title : '' }), el('div', { class: 'btns' }, el('button', { class: 'btn small', text: 'Chats' + (d.chats.length ? ' (' + d.chats.length + ')' : ''), 'aria-expanded': pop === 'chats', onclick: () => { pop = pop === 'chats' ? null : 'chats'; renderTab() } }))))
    if (pop === 'chats') col.append(chatsPop(d))
    const msgs = el('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' })
    if (!d.messages.length) msgs.append(el('div', { class: 'chat-empty' }, el('h2', { text: 'What do you need to do?' }), el('p', { class: 'muted' }, 'Write your prompt. ', el('strong', { text: 'Analyse' }), ' shows how complete it is and which model fits; ', el('strong', { text: 'Send' }), ' gets the answer.')))
    for (const m of d.messages) msgs.append(bubble(m.role, m.who, m.text, m.error))
    live = null
    col.append(msgs)
    const lastMsg = d.messages[d.messages.length - 1]
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.error) col.append(el('div', { class: 'banner' }, el('span', { text: lastMsg.error }), lastMsg.cut ? el('button', { class: 'btn small primary', text: 'Continue', onclick: () => send('chatSend', { text: 'Continue exactly where you stopped.' }) }) : el('button', { class: 'btn small', text: 'Retry', onclick: () => send('chatRetry') })))
    if (d.continuing) col.append(el('div', { class: 'banner' }, el('span', { text: 'The next analysis continues ' + d.continuing + ' and is compared with the last one.' }), btn('Stop continuing', 'continueClear')))

    // the composer
    const sel = d.options.find(o => o.id === d.chatModel) || null
    const usesRouter = !!(sel && sel.provider === 'openrouter')
    const area = el('textarea', { placeholder: 'Message AdaptAI…', value: draft, id: 'task', rows: 3, maxLength: MAXC, 'aria-label': 'Message' })
    const counter = el('span', { class: 'count', text: draft.length + '/' + MAXC })
    const live2 = el('div', { class: 'live', 'aria-live': 'polite' })
    const badge = el('b', { text: '' })
    const found = () => localChecks(area.value, d.last)
    let timer = null
    const hints = () => {
      live2.replaceChildren()
      const f = found()
      badge.textContent = f.length ? String(f.length) : ''
      badge.hidden = !f.length
      if (!area.value.trim() || pop === 'coach') return
      for (const h of f) live2.append(el('div', { class: 'hint ' + (h.warn ? 'warn' : '') }, el('span', { text: h.warn ? '!' : 'i' }), el('div', null, el('b', { text: h.title }), el('span', { text: h.detail }))))
    }
    area.addEventListener('input', () => { draft = area.value; api.setState({ text: draft }); counter.textContent = draft.length + '/' + MAXC; clearTimeout(timer); timer = setTimeout(hints, 250) })
    area.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendNow(area) } })
    const coachBtn = el('button', { class: 'coachbtn', type: 'button', 'aria-label': 'Prompt Coach', 'aria-expanded': pop === 'coach', onclick: () => { pop = pop === 'coach' ? null : 'coach'; renderTab() } }, '✦', badge)
    const busy = !!(d.analysing || d.streaming || d.coachBusy)
    const needText = !area.value.trim() && !draft.trim()
    const modelTitle = !sel ? 'Auto' : sel.model || sel.label
    const trigger = el('button', { class: 'trigger', type: 'button', 'aria-label': 'Chat model: ' + modelTitle, 'aria-expanded': pop === 'model', onclick: () => { pop = pop === 'model' ? null : 'model'; renderTab() } }, el('b', { text: 'Model' }), el('span', { text: modelTitle }), sel && sel.status && sel.status.state !== 'none' ? el('small', { class: 'pill st-' + sel.status.state, text: sel.status.text }) : null, '▾')
    const router = usesRouter ? el('button', { class: 'trigger', type: 'button', onclick: () => send('chatOverride', { value: '__openrouter' }) }, el('b', { text: 'OpenRouter' }), el('span', { text: d.override && d.override.openrouter ? d.override.label.replace('OpenRouter · ', '') : 'Choose a model' }), '▾') : null
    const analyseBtn = el('button', { class: 'btn', type: 'button', text: d.analysing ? 'Analysing…' : 'Analyse', disabled: busy || needText, onclick: () => { if (!area.value.trim()) return; drawerOpen = true; pop = null; send('analyse', { text: area.value }); renderTab() } })
    const sendBtn = el('button', { class: 'btn primary', id: 'sendbtn', type: 'button', text: 'Send', hidden: !!d.streaming, disabled: busy || needText || (usesRouter && !(d.override && d.override.openrouter)), title: usesRouter && !(d.override && d.override.openrouter) ? 'Choose an OpenRouter model first' : '', onclick: () => sendNow(area) })
    const stopBtn = el('button', { class: 'btn', id: 'stop', type: 'button', text: 'Stop', hidden: !d.streaming, onclick: () => send('chatStop') })
    const chip = d.last && d.last.task && d.last.task.trim() === draft.trim() && draft.trim() ? el('button', { class: 'recchip', type: 'button', title: 'Show analysis', onclick: () => { drawerOpen = true; renderTab() } }, 'Recommended: ', el('strong', { text: d.last.name }), d.last.usable && sel && d.last.modelId === sel.id ? ' · selected' : '') : null
    const composer = el('section', { class: 'composer2' },
      el('div', { class: 'wrapta' }, area, coachBtn), live2,
      el('div', { class: 'cfoot2' }, el('div', { class: 'left' }, trigger, router), el('div', { class: 'right' }, el('span', { class: 'muted', id: 'note' }), counter, chip, analyseBtn, sendBtn, stopBtn)))
    if (pop === 'model') composer.append(modelPop(d, sel))
    if (pop === 'coach') composer.append(coachPop(d, area, found()))
    col.append(composer)
    const external = d.assessment ? (d.assessment.external || (sel && sel.external)) : (sel && sel.external) || (!sel && d.auto && d.auto.provider !== 'lmstudio')
    if (d.assessment && (d.assessment.external || (sel && sel.external))) col.append(el('p', { class: 'notice' }, 'Selecting ', el('strong', { text: 'Analyse' }), ' sends your text to ', el('strong', { text: d.assessment.provider }), ' (the project assessor); ', el('strong', { text: 'Send' }), ' sends it to ', el('strong', { text: sel ? sel.provider : d.auto ? d.auto.provider : 'the chat model' }), '. Messages are saved in this chat until you delete it.'))
    else if (!d.assessment && sel && sel.external) col.append(el('p', { class: 'notice' }, 'Selecting ', el('strong', { text: 'Analyse' }), ' or ', el('strong', { text: 'Send' }), ' sends your text to ', el('strong', { text: sel.provider }), '. Messages are saved in this chat until you delete it.'))
    wrap.append(col)
    if (drawerOpen) { wrap.append(el('div', { class: 'drawer-backdrop', onclick: () => { drawerOpen = false; renderTab() } }), drawerEl(d, area)) }
    setTimeout(hints, 0)
    setTimeout(() => { const m = document.getElementById('msgs'); if (m && m.lastElementChild) m.lastElementChild.scrollIntoView({ block: 'nearest' }) }, 0)
    return [wrap]
  }

  function coachPanel(c, area) {
    const card = el('section', { class: 'card coach' }, el('p', { class: 'eyebrow', text: 'Prompt Coach · ' + (c.mode || 'rewrite') }), el('h2', { text: 'Improve your request', style: 'margin-bottom:6px' }))
    if (c.status === 'nothing_to_improve') card.append(el('p', { class: 'muted', text: 'Nothing to improve: the task is clear enough.' }))
    if (c.improved) {
      card.append(el('pre', { text: c.improved }), el('div', { class: 'btns' }, el('button', { class: 'btn primary small', text: 'Use this text', onclick: () => { const box = area || document.getElementById('task'); if (box) { box.value = c.improved; box.dispatchEvent(new Event('input')) } draft = c.improved; api.setState({ text: draft }); toast('ok', 'The improved text is in the box.') } }), el('button', { class: 'btn small', text: 'Copy', onclick: () => { const t = el('textarea', { value: c.improved }); document.body.append(t); t.select(); try { document.execCommand('copy'); toast('ok', 'Copied.') } catch (e) { toast('err', 'Could not copy.') } t.remove() } })))
    }
    for (const x of c.suggestions) { const r = el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', null, el('span', { class: 'kind', text: x.kind }), x.title), el('p', { class: 'muted', text: x.why }), x.quote ? el('p', { class: 'muted', text: 'From: ' + x.quote }) : null, x.replacement ? el('p', { text: 'Try: ' + x.replacement }) : null)); card.append(r) }
    if (c.questions && c.questions.length) { card.append(el('p', { class: 'eyebrow', style: 'margin-top:12px', text: 'Questions that would sharpen it' })); for (const q of c.questions) card.append(el('p', { class: 'muted', text: q })) }
    return card
  }

  const pct = v => v == null ? 'n/a' : Math.round(v * (v <= 1 ? 100 : 1)) + '%'
  const NS = 'http://www.w3.org/2000/svg'
  function sv(tag, attrs, ...kids) { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); for (const kid of kids.flat()) if (kid != null) e.append(kid); return e }
  function svText(x, y, text) { const t = sv('text', { x, y, class: 'axis' }); t.textContent = text; return t }
  const tip = text => sv('title', {}, document.createTextNode(text))
  function activityChart(items) {
    const W = 600, H = 190, max = Math.max(1, ...items.map(i => Math.max(i.analyses, i.choices)))
    const g = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Analyses and confirmed choices per session' })
    g.append(sv('path', { d: 'M0 150H' + W, class: 'gridl' }))
    const slot = W / items.length
    items.forEach((it, n) => {
      const x = n * slot + slot * 0.2, bw = slot * 0.28, ha = it.analyses / max * 140, hc = it.choices / max * 140
      g.append(sv('rect', { x, y: 150 - ha, width: bw, height: ha, rx: 3, class: 'bar-a' }, tip(it.title + ': ' + it.analyses + ' analyses')))
      g.append(sv('rect', { x: x + bw + 4, y: 150 - hc, width: bw, height: hc, rx: 3, class: 'bar-b' }, tip(it.title + ': ' + it.choices + ' confirmed choices')))
      g.append(svText(x + bw, 172, 'S' + (n + 1)))
    })
    return g
  }
  function lineChart(values, label, titles) {
    const W = 900, H = 220
    const g = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': label })
    g.append(sv('path', { d: 'M0 20H900M0 65H900M0 110H900M0 155H900M0 200H900', class: 'gridl' }))
    const pts = values.map((v, i) => [values.length === 1 ? 450 : 20 + i * 860 / (values.length - 1), 200 - Math.max(0, Math.min(100, v)) * 1.8])
    const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ')
    if (pts.length > 1) { g.append(sv('path', { d: d + ' L' + pts[pts.length - 1][0] + ' 220 L20 220 Z', class: 'area' })); g.append(sv('path', { d, class: 'line' })) }
    pts.forEach((q, i) => g.append(sv('circle', { cx: q[0], cy: q[1], r: 5, class: 'dot' }, tip(titles[i]))))
    return g
  }
  let chartMode = 'activity'
  function chartCard(d) {
    const card = card_('Overview', 'Your judgement over time')
    const body = el('div')
    const tabs = el('div', { class: 'tabsmall', role: 'group', 'aria-label': 'Progress chart' })
    const draw = () => {
      tabs.replaceChildren(el('button', { class: chartMode === 'activity' ? 'on' : '', text: 'Activity', onclick: () => { chartMode = 'activity'; draw() } }), el('button', { class: chartMode === 'match' ? 'on' : '', text: 'Recommendation match', onclick: () => { chartMode = 'match'; draw() } }))
      body.replaceChildren()
      const act = d.activity || [], ser = (d.dashboard && d.dashboard.series) || []
      if (chartMode === 'activity') {
        if (!act.length) return body.append(el('p', { class: 'muted', text: 'Your first analysis starts your progress. It is saved automatically, even before you confirm a model.' }))
        body.append(el('div', { class: 'legend' }, el('span', null, el('i'), 'Analyses'), el('span', null, el('i', { class: 'b' }), 'Confirmed choices')), activityChart(act))
        body.append(el('details', null, el('summary', { text: 'View chart values' }), el('ul', null, act.map(i => el('li', { text: i.title + ': ' + i.analyses + ' analyses, ' + i.choices + ' confirmed' })))))
      } else {
        if (!ser.length) return body.append(el('p', { class: 'muted', text: 'Confirm a choice to build this chart. Pending choices are never counted as matches.' }))
        body.append(el('p', { class: 'muted', text: 'Agreement score: full credit for the recommended model, half credit one step away.' }), lineChart(ser.map(x => x.score == null ? x.rate : x.score), 'Recommendation match by saved session', ser.map(x => x.title + ': ' + (x.score == null ? x.rate : x.score) + '% agreement, ' + x.rate + '% exact (' + x.matches + '/' + x.choices + ')')))
        body.append(el('details', null, el('summary', { text: 'View chart values' }), el('ul', null, ser.map(x => el('li', { text: x.title + ': ' + (x.score == null ? x.rate : x.score) + '% agreement, ' + x.rate + '% exact, ' + x.matches + '/' + x.choices + ' choices' })))))
      }
    }
    draw(); card.append(tabs, body); return card
  }
  const card_ = (eyebrow, title) => card(eyebrow, title)

  function progressTab(d) {
    const out = intro('My progress', 'Your judgement over time.', 'Computed by the backend from your saved metadata. Agreement measures how often your choice matched the recommendation, not whether it was right.')
    out.push(el('div', { class: 'btns', style: 'margin:-10px 0 16px' }, el('button', { class: 'btn small', text: 'Export my data', onclick: () => send('export') })))
    const p = d.progress, o = d.outcomes, l = d.learning, c = d.coaching
    const stats = el('div', { class: 'stats' })
    const stat = (label, value) => stats.append(el('div', { class: 'card' }, el('p', { class: 'eyebrow', text: label }), el('div', { class: 'stat', text: String(value) })))
    if (p) { stat('Sessions', p.sessions); stat('Analyses', p.analyses); stat('Choices confirmed', p.choices); stat('Choices pending', Math.max(0, p.analyses - p.choices)); stat('Agreement', pct(p.agreement)) } else stats.append(el('p', { class: 'muted', text: 'Activity not available.' }))
    out.push(stats, chartCard(d))

    const P = card('Next step', 'Choices to confirm (' + ((d.pending || []).length) + ')'); P.style.marginTop = '14px'
    P.append(el('p', { class: 'muted', text: 'Analyses are saved automatically. Tell AdaptAI which model you actually used to build your match chart and patterns.' }))
    if (!d.pending || !d.pending.length) P.append(el('p', { class: 'muted', text: 'No choices waiting for confirmation.' }))
    else for (const x of d.pending) P.append(el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', { text: x.title }), el('p', { class: 'muted', text: 'Recommended: ' + x.recommended })), el('div', { class: 'btns' }, x.options.slice(0, 4).map(q => el('button', { class: 'btn small', text: 'I used ' + q.name, onclick: () => send('choose', { analysis: x.id, candidate: q.id }) })))))
    out.push(P)

    const S = card('Feedback', 'Your solved tasks'); S.style.marginTop = '14px'
    if (o && o.tasks > 0) {
      const dl = el('dl', { class: 'metrics' })
      const m = (k, v) => dl.append(el('div', null, el('dt', { text: k }), el('dd', { text: String(v) })))
      m('Solved', (o.resolved + o.resolved_with_refinement) + ' of ' + o.tasks); m('After refining', o.resolved_with_refinement); m('Followed the recommendation', o.followed + ' of ' + o.tasks)
      m('Solved when following it', o.solved_rate_following == null ? 'n/a' : o.solved_rate_following + '%'); m('Solved with another model', o.solved_rate_not_following == null ? 'n/a' : o.solved_rate_not_following + '%'); m('Answers per task', o.mean_turns == null ? 'n/a' : o.mean_turns)
      S.append(dl)
      if (o.by_model.length) for (const x of o.by_model) S.append(row(x.model || 'Unknown model', x.solved + '/' + x.tasks + ' solved'))
      if (o.described_poorly > 0) S.append(el('p', { class: 'muted', text: o.described_poorly + ' not solved because the task was described poorly: the Coach can help before you send.' }))
    } else S.append(el('p', { class: 'muted', text: 'After a task, say whether the model solved it. Your answers appear here.' }))
    S.append(el('p', { class: 'muted', style: 'margin-top:8px', text: 'Your own judgement of each task, not a measure of quality. Skipped: ' + (o ? o.skipped : 0) + '.' }))
    out.push(S)

    const L = card('Learning', 'Are you describing tasks better?'); L.style.marginTop = '14px'
    const V = { insufficient_history: 'Not enough history yet: it needs at least ' + (l ? l.min_sessions : 3) + ' sessions.', improving: 'Improving: your first descriptions are more complete than when you started.', declining: 'Less complete lately: your recent first descriptions leave more open than your early ones.', stable: 'Stable: your first descriptions are about as complete as when you started.' }
    L.append(el('p', { text: l ? (V[l.verdict] || l.verdict) : 'Not available.' }))
    if (l && l.points && l.points.length > 1) L.append(lineChart(l.points.map(x => x.completeness), 'Completeness of the first analysis of each session', l.points.map(x => x.date + ': ' + x.completeness + '% complete')), el('p', { class: 'muted', text: 'Completeness of the first analysis of each session, newest on the right.' }))
    if (l && l.dimensions && l.dimensions.length) { const t = el('table'); t.append(el('tr', null, el('th', { text: 'Dimension' }), el('th', { text: 'Early' }), el('th', { text: 'Recent' }))); for (const x of l.dimensions) t.append(el('tr', null, el('td', { text: x.dimension }), el('td', { text: pct(x.early_rate) }), el('td', { text: pct(x.recent_rate) }))); L.append(t) }
    out.push(L)

    const E = card('Patterns', 'What your choices reveal'); E.style.marginTop = '14px'
    const grid = el('div', { class: 'grid3', style: 'margin-top:8px' })
    const saved = c && c.saved
    const pat = (title, count, insight) => { const x = el('section', { class: 'card', style: 'min-height:0;margin:0' }, el('h3', { text: title }), el('p', { class: 'muted', text: count })); if (insight) x.append(el('p', { text: insight.explanation }), el('p', { class: 'muted', text: 'Next: ' + insight.action })); return x }
    const pats = saved ? saved.patterns || {} : {}
    grid.append(pat('Over-provisioning', d.dashboard ? d.dashboard.over + ' confirmed choices used more model than the task needed.' : 'Not available.', pats.over_provisioning), pat('Under-provisioning', d.dashboard ? d.dashboard.under + ' confirmed choices used a model that covers less than recommended.' : 'Not available.', pats.under_provisioning), pat('Inflated prompting', 'Needs saved text samples; see Profile.', pats.prompting))
    E.append(grid)
    if (!c) E.append(el('p', { class: 'muted', text: 'Suggestions not available.' }))
    else if (!c.configured) E.append(el('p', { class: 'muted', text: 'The Educator is not configured on this backend.' }))
    else if (saved) { E.append(el('p', { style: 'margin-top:12px', text: saved.summary })); for (const x of saved.suggestions) E.append(row(x.title, x.explanation + ' Practice: ' + x.action)) }
    else E.append(el('p', { class: 'muted', style: 'margin-top:12px', text: c.automatic_enabled ? 'No suggestions yet: they appear after more analyses.' : 'Automatic suggestions are off. Switch them on in Profile.' }))
    out.push(E)

    const H = card('Saved work', 'Session history'); H.style.marginTop = '14px'
    if (!d.sessions || !d.sessions.length) H.append(el('p', { class: 'muted', text: 'No analyses yet.' }))
    else for (const x of d.sessions) H.append(row(x.title, x.count + ' analyses · ' + x.at, el('button', { class: 'btn small', text: 'Open', onclick: () => send('sessionOpen', { id: x.id }) })))
    out.push(H); return out
  }

  function shortcutsTab(d) {
    const out = intro('Shortcuts', 'Do it from the keyboard.', 'Every action of AdaptAI, with its keyboard shortcut. Change a shortcut and VS Code remembers it for you.')
    const keys = card('Keyboard', 'Shortcuts')
    for (const x of d.shortcuts) keys.append(row(x.title, x.command, el('kbd', { text: x.key, style: 'padding:3px 8px;border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;background:var(--soft);font-size:12px;white-space:nowrap' }), btn('Change', 'changeKey', { command: x.command })))
    keys.append(el('div', { class: 'btns', style: 'margin-top:10px' }, btn('All keyboard shortcuts', 'allKeys')))
    const acts = card('Actions', 'Run an action')
    for (const x of d.actions) acts.append(row(x.title, x.key ? 'Shortcut: ' + x.key : 'No shortcut yet', btn('Run', 'runCommand', { command: x.command }), btn(x.key ? 'Change key' : 'Set a key', 'changeKey', { command: x.command })))
    out.push(keys, acts, el('p', { class: 'muted', text: 'The shortcuts work in the editor. Inside another extension\\'s panel (for example Claude Code) copy the text and use Analyse clipboard or Coach clipboard.' }))
    return out
  }

  const LABELS = { save_enabled: ['Save learned memory', 'Records derived profile values and your model choices. No task text.'], use_enabled: ['Use memory in analyses', 'Lets your preferences and learned metadata go with an analysis to the assessor.'], conversation_memory_enabled: ['Save task text and AI responses', 'Stores new task text and full AI responses on the backend. Asks first.'], coaching_auto_enabled: ['Automatic suggestions', 'The Educator updates your suggestions after analyses. Asks first.'], coach: ['Prompt Coach', 'Helps describe a task. Off means nothing is asked of a model.'], auto_analyse: ['Always analyse before sending', 'In the chat, Send runs an analysis first.'] }
  function profileTab(d) {
    const out = intro('Profile & settings', 'Your profile. Your control.', 'Manage preferences, memory and how your saved information is used.')
    const c = card('Personalisation', 'Memory and privacy')
    for (const k in LABELS) { const box = el('input', { type: 'checkbox', checked: !!d.values[k], onchange: () => send('toggle', { key: k, on: box.checked }) }); c.append(el('label', { class: 'sw' }, box, el('div', null, el('div', { text: LABELS[k][0], style: 'font-weight:600' }), el('p', { class: 'muted', text: LABELS[k][1] })))) }
    const auto = card('Prompt Coach', 'Coach after every analysis')
    const autoBox = el('input', { type: 'checkbox', checked: !!d.coachAuto, onchange: () => send('coachAuto', { on: autoBox.checked }) })
    auto.append(el('label', { class: 'sw' }, autoBox, el('div', null, el('div', { text: 'Run the Coach after every analysis', style: 'font-weight:600' }), el('p', { class: 'muted', text: 'A second request with the same text, so it costs a second call and, with an external model, sends the text again. Off by default; switching it on asks first.' }))))
    out.push(c, auto, card('Preferences', 'What should AdaptAI know about you?', el('p', { text: d.preferences || 'Nothing saved.', style: 'white-space:pre-wrap' }), el('div', { class: 'btns', style: 'margin-top:10px' }, el('button', { class: 'btn small', text: 'Edit preferences', onclick: () => send('preferences', { current: d.preferences || '' }) }))))
    out.push(card('Transparency', 'Delete your data', row('Learned memory', d.counts.memory + ' entries', btn('Delete', 'delete', { what: 'memory' }, 'danger')), row('Stored conversations', d.counts.conversations + ' saved', btn('Delete', 'delete', { what: 'conversations' }, 'danger')), row('All usage history', 'Sessions, choices, memory, advice', btn('Delete', 'delete', { what: 'history' }, 'danger'))))
    const mem = card('Transparency', 'Learned memory'); mem.append(el('p', { class: 'muted', text: 'Recent metadata available to the Assistant (up to 20 entries). Model-generated profiles stay provisional.' }))
    if (!d.memory || !d.memory.length) mem.append(el('p', { class: 'muted', style: 'margin-top:8px', text: 'No learned memory yet. Switch on saving and analyse a task to start building it.' }))
    else for (const x of d.memory) { const dl = el('dl'); for (const kv of x.profile) dl.append(el('dt', { text: kv[0] }), el('dd', { text: kv[1] })); mem.append(el('details', { class: 'mem' }, el('summary', { text: x.title }), dl)) }
    out.push(mem)
    const chatsCard = card('Conversations', 'Active conversations')
    if (!d.chats.length) chatsCard.append(el('p', { class: 'muted', text: 'No chats yet.' }))
    for (const x of d.chats) chatsCard.append(row(x.title, x.count + ' messages · ' + x.at, el('button', { class: 'btn small', text: 'Open', onclick: () => { tab = 'analyse'; mark(); send('chatSelect', { id: x.id }); send('tab', { tab: 'analyse' }) } }), btn('Delete', 'chatDelete', { id: x.id }, 'danger')))
    out.push(chatsCard)
    const tk = card('Access', 'API tokens')
    tk.append(el('p', { class: 'muted', text: 'Personal tokens let tools such as this extension sign in without your password. A token is shown once, expires, and can be revoked. Managing them needs your password (kept in memory for 10 minutes only).' }))
    if (d.tokenMode !== 'open') tk.append(el('div', { class: 'btns', style: 'margin-top:10px' }, el('button', { class: 'btn primary small', text: 'Unlock with your password', onclick: () => send('tokenUnlock') })))
    else {
      tk.append(el('div', { class: 'btns', style: 'margin:10px 0 4px' }, el('button', { class: 'btn primary small', text: 'Create a token', onclick: () => send('tokenCreate') })))
      const fmt = t => t ? new Date(t * 1000).toLocaleDateString() : 'never'
      const rows = (d.tokens || []).filter(t => !t.revoked)
      if (!rows.length) tk.append(el('p', { class: 'muted', text: 'No active tokens.' }))
      for (const t of rows) tk.append(row(t.name, t.prefix + '… · expires ' + fmt(t.expires_at) + (t.expired ? ' (expired)' : '') + ' · last used ' + fmt(t.last_used_at), btn('Revoke', 'tokenRevoke', { id: t.id }, 'danger')))
    }
    out.push(tk)
    return out
  }

  function modelsTab(d) {
    const out = intro('LLM config', 'Ready by default. More when you need it.', 'The project provides its own models. You can connect your own (Groq, OpenAI, Claude, OpenRouter, LM Studio, Ollama); keys are stored encrypted on the backend.')
    const p = card('Project', 'Project models')
    if (!d.project.length) p.append(el('p', { class: 'muted', text: 'The project has no model configured.' }))
    for (const m of d.project) p.append(row(m.label + (m.model ? ' · ' + m.model : ''), m.provider + (m.assessor ? ' · analyses every task' : ''), m.id === d.chatModel ? el('span', { class: 'pill', text: 'chat model' }) : btn('Use for chat', 'chatModel', { id: m.id })))
    const y = card('Yours', 'Your models'); y.append(el('div', { class: 'btns', style: 'margin-bottom:6px' }, el('button', { class: 'btn primary small', text: 'Add a model', onclick: () => send('modelAdd') })))
    if (!d.configs.length) y.append(el('p', { class: 'muted', text: 'None yet.' }))
    for (const m of d.configs) y.append(row(m.label + ' · ' + m.model, m.provider + (m.external ? ' · external' : ' · local') + (m.hasKey ? ' · key saved' : ''), m.id === d.chatModel ? el('span', { class: 'pill', text: 'chat model' }) : btn('Use for chat', 'chatModel', { id: m.id }), btn('Test', 'modelTest', { id: m.id }), btn('Edit', 'modelEdit', { id: m.id }), btn('Delete', 'modelRemove', { id: m.id }, 'danger')))
    const v = card('Evaluations', 'How models were evaluated'); v.append(el('div', { class: 'btns', style: 'margin-bottom:6px' }, btn('Add from the OpenRouter catalogue', 'openrouter')))
    if (!d.evaluations.length) v.append(el('p', { class: 'muted', text: 'Nothing evaluated yet.' }))
    for (const e of d.evaluations) v.append(row(e.model, e.provider + ' · ' + e.text, e.consent ? btn('Decide', 'evalConsent', { id: e.key }, 'primary') : null, btn('Evaluate again', 'evalRedo', { id: e.key }), btn('I disagree', 'evalDisagree', { id: e.key }), e.picked ? btn('Remove', 'evalRemove', { id: e.key }, 'danger') : null))
    out.push(p, y, v); return out
  }

  window.addEventListener('message', event => {
    const m = event.data
    if (m && m.type === 'dialog') return showDialog(m)
    if (m && m.type === 'toast') return toast(m.kind, m.text)
    if (m && m.type === 'chatStart') { const box = document.getElementById('msgs'); if (!box) return; const empty = box.querySelector('.empty, .chat-empty'); if (empty) empty.remove(); if (m.user) box.append(bubble('user', 'You', m.user)); live = { raw: '', el: bubble('ai', 'AdaptAI', '') }; box.append(live.el); box.scrollTop = box.scrollHeight; const stop = document.getElementById('stop'); if (stop) stop.hidden = false; const sb = document.getElementById('sendbtn'); if (sb) sb.hidden = true; return }
    if (m && m.type === 'delta') { if (!live) return; live.raw += m.text; const next = bubble('ai', 'AdaptAI', live.raw); live.el.replaceWith(next); live.el = next; const box = document.getElementById('msgs'); if (box) box.scrollTop = box.scrollHeight; const note = document.getElementById('note'); if (note) note.textContent = ''; return }
    if (m && m.type === 'note') { const note = document.getElementById('note'); if (note) note.textContent = m.text; return }
    const d = event.data; if (!d || d.type !== 'data') return
    tab = d.tab; mark(); lastData = d
    document.getElementById('signout').hidden = !!d.signedOut
    document.getElementById('acct').replaceChildren(...(d.signedOut ? [el('b', { text: 'Not signed in' })] : [el('b', { text: d.email || '' }), el('span', { class: 'dot' }), 'Connected']))
    renderTab()
  })
  function renderTab() {
    const d = lastData
    if (!d) return
    main.replaceChildren()
    if (d.signedOut) return main.append(el('div', { class: 'center' }, el('h1', { text: 'Sign in to use AdaptAI' }), el('p', { class: 'lead', style: 'margin:0 auto 20px', text: 'Use your email and password once. Only a token is kept on this machine.' }), el('div', { class: 'btns', style: 'justify-content:center' }, el('button', { class: 'btn primary', text: 'Sign in', onclick: () => send('signIn') }), el('button', { class: 'btn', text: 'Create an account', onclick: () => send('register') }))))
    if (d.failed) return main.append(el('div', { class: 'err', text: d.failed }), el('p'), el('button', { class: 'btn', text: 'Try again', onclick: () => send('ready') }))
    main.append(...{ analyse: assistantTab, progress: progressTab, profile: profileTab, models: modelsTab, shortcuts: shortcutsTab }[tab](d))
  }
  mark(); send('ready')
</script></body></html>`
}
