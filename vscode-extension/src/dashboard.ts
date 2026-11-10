import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { explain, type Analyser } from './analyse'
import { ApiError, type Backend } from './backend'
import type { ChatMessage, ChatService, ChatsView, ChatSummary } from './chat'
import type { Analysis, LlmOptions } from './api'
import { CAPABILITIES, PROVIDERS, consentText, describeEvaluation, type CatalogueModel, type Evaluation, type ModelsView, type PersonalConfig } from './models'
import { CONSENT, type ProfileView, type ProgressReport, type Settings } from './profile'
import { describeFailure } from './core'
import { assessedBy, modelName, price, summaryLine } from './format'
import type { Result } from './analyse'

type Tab = 'analyse' | 'chat' | 'progress' | 'profile' | 'models' | 'shortcuts'
const TABS: Tab[] = ['analyse', 'chat', 'progress', 'profile', 'models', 'shortcuts']
/** Commands the Shortcuts page may run: they need nothing but a click. */
const RUNNABLE = ['analyseSelection', 'analyseClipboard', 'analyseInput', 'improvePrompt', 'coachClipboard', 'testConnection', 'checkConnection', 'openProgress', 'chatNew', 'openSettings']
const SWITCHES = ['save_enabled', 'use_enabled', 'conversation_memory_enabled', 'coaching_auto_enabled', 'coach', 'auto_analyse'] as const
const DELETES = ['memory', 'conversations', 'history'] as const
const RESULT_ACTIONS = new Set(['adaptai.copySummary', 'adaptai.taskOutcome', 'adaptai.useModel', 'adaptai.coachResult'])

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
  private streaming: AbortController | undefined
  private readonly dialogs = new Map<string, (values?: Record<string, unknown>) => void>()
  private seq = 0
  private markReady: () => void = () => undefined
  private ready: Promise<void> = new Promise(resolve => (this.markReady = resolve))
  private cache: { configs: PersonalConfig[]; evaluations: Evaluation[] } = { configs: [], evaluations: [] }

  constructor(
    private readonly backend: Backend,
    private readonly analyser: Analyser,
    private readonly models: ModelsView,
    private readonly profile: ProfileView,
    private readonly chat: ChatService,
    private readonly chats: ChatsView,
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
        chatModel,
        assessment: options.assessment ? { label: options.assessment.label, model: options.assessment.model, provider: options.assessment.provider } : null,
        options: options.options.filter(item => item.provider !== 'openrouter').map(item => ({ id: item.id, label: item.label, provider: item.provider, model: item.model, external: item.external })),
        last: last ? richResult(last) : undefined,
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
      return { pending: pending.map(item => ({ id: item.result.id, title: item.session_title, recommended: modelName(item.result.recommendation), options: [item.result.recommendation, ...item.result.alternatives].filter(candidate => candidate.id).map(candidate => ({ id: candidate.id, name: modelName(candidate) })) })), sessions: sessions.map(item => ({ title: item.title, count: item.analysis_count, at: item.created_at })), progress: await get('/api/progress'), dashboard: await get('/api/progress/dashboard'), outcomes: await get('/api/progress/outcomes'), learning: await get('/api/progress/learning'), coaching: await get('/api/progress/coaching') }
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
      }
    }
    const options = await api<LlmOptions>('/api/llm-options')
    const chats = await this.chat.list().catch(() => [] as ChatSummary[])
    const current = this.chat.current && chats.some(item => item.id === this.chat.current) ? this.chat.current : undefined
    const detail = current ? await api<{ messages: ChatMessage[] }>(`/api/chats/${encodeURIComponent(current)}`).catch(() => undefined) : undefined
    return {
      chatModel,
      options: options.options.filter(item => item.provider !== 'openrouter').map(item => ({ id: item.id, label: item.label, provider: item.provider, model: item.model, external: item.external })),
      chats: chats.map(item => ({ id: item.id, title: item.title, count: item.message_count, at: item.updated_at ?? item.created_at })),
      current,
      streaming: Boolean(this.streaming),
      messages: (detail?.messages ?? []).map(item => ({
        role: item.role,
        text: item.content,
        who: item.role === 'user' ? 'You' : `AdaptAI${item.model ? ` · ${item.provider ?? ''} ${item.model}` : ''}`,
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
      void this.models.refresh()
      void this.profile.refresh()
      await this.reload()
    }
  }

  // ---- account ---------------------------------------------------------------------------------------

  async signIn(): Promise<void> {
    await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 6000))])
    if (this.backend.urlProblem) return this.toast('err', this.backend.urlProblem)
    const answer = await this.ask({
      title: 'Sign in',
      text: 'Your password is used once to sign in. Only a token is kept on this machine.',
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
    if (provider.key) fields.push({ name: 'key', label: 'API key', type: 'password', required: true, hint: 'Encrypted on the backend. It is never shown again.' })
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
      const data = { exported_at: new Date().toISOString(), preferences: await get('/api/context'), coaching: await get('/api/progress/coaching').catch(() => null), sessions }
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
          const result = await this.analyser.fromText(text)
          if (result) await this.analyser.show(result, false)
        } finally {
          this.busy = false
          await this.reload()
        }
        return
      }
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
        this.toast('ok', 'Chat model changed.')
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
          else await this.chat.send(text, sink, abort.signal)
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


const DIMENSIONS: [string, string][] = [['reasoning', 'Reasoning depth'], ['context', 'Context demand'], ['ambiguity', 'Ambiguity'], ['domain', 'Domain specificity'], ['risk', 'Risk of error'], ['tools', 'Tool use']]

/** What the web app's three result cards show, as plain data. */
function richResult(result: Result): unknown {
  const a = result.analysis
  const m = a.recommendation
  return {
    id: a.id,
    name: modelName(m),
    title: summaryLine(a),
    price: price(m),
    cost: m.cost_band ?? null,
    provisional: a.recommendation_provisional,
    demo: a.mode === 'demonstration',
    assessor: assessedBy(a),
    rationale: a.rationale,
    why: [...(a.notes ?? []), ...a.warnings, ...(m.shortfalls?.length ? [`Falls short on: ${m.shortfalls.join(', ')}.`] : [])],
    profile: DIMENSIONS.map(([key, label]) => {
      const item = (a.profile as unknown as Record<string, { score: number | null; confidence: string }>)[key]
      return { label, score: item?.score ?? null, confidence: item?.confidence ?? '' }
    }),
    coverage: (m.coverage ?? []).map(entry => ({ need: entry.need, estimated: entry.estimated, top: entry.top, level: entry.capability, state: entry.state })),
    changes: (a.changes ?? []).map(change => `${change.dimension}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`),
    tips: [...a.tips.map(tip => tip.text), ...a.guidance].slice(0, 6),
    questions: a.clarification_questions.slice(0, 4),
    alternatives: a.alternatives.slice(0, 3).map(item => ({ name: modelName(item), price: price(item) })),
    coach: result.coachAvailable,
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
  [hidden] { display: none !important; }
</style></head>
<body>
<aside class="side">
  <div class="brand"><span class="mark">✦</span>AdaptAI</div>
  <nav class="nav" id="nav">
    <button data-tab="analyse">Assistant</button><button data-tab="chat">Chat</button><button data-tab="progress">My progress</button><button data-tab="profile">Profile</button><button data-tab="models">LLM config</button><button data-tab="shortcuts">Shortcuts</button>
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
  const el = (tag, props, ...kids) => { const e = document.createElement(tag); if (props) for (const k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else e[k] = props[k] } for (const kid of kids.flat()) if (kid != null) e.append(kid); return e }
  const btn = (label, type, extra, cls) => el('button', { text: label, class: 'btn small ' + (cls || ''), onclick: () => send(type, extra) })
  const intro = (eyebrow, title, lead) => [el('p', { class: 'eyebrow', text: eyebrow }), el('h1', { text: title }), el('p', { class: 'lead', text: lead })]
  const row = (title, sub, ...buttons) => el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', { text: title }), sub ? el('p', { class: 'muted', text: sub }) : null), el('div', { class: 'btns' }, buttons))
  const card = (eyebrow, title, ...kids) => el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: eyebrow }), title ? el('h2', { text: title, style: 'margin-bottom:12px' }) : null, kids)
  const mark = () => document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  document.getElementById('nav').addEventListener('click', e => { const t = e.target.closest('button'); if (t) { tab = t.dataset.tab; mark(); send('tab', { tab }) } })
  document.getElementById('gear').addEventListener('click', () => send('settings'))
  document.getElementById('signout').addEventListener('click', () => send('signOut'))

  function resultCards(r) {
    const out = []
    out.push(el('div', { class: 'rh' }, el('h2', { text: 'Recommendation' }), el('span', { text: 'Assessed by ' + r.assessor + ' · ' + r.at })))
    const profile = el('section', { class: 'card' }, el('div', { class: 'ch' }, el('div', null, el('p', { class: 'eyebrow', text: 'Task profile' }), el('h2', { text: 'What your task needs' })), el('span', { class: 'pill', text: r.provisional ? 'provisional' : 'assessed' })))
    const list = el('div', { class: 'plist' })
    for (const d of r.profile) list.append(el('div', null, el('div', { class: 'plabel' }, el('span', { text: d.label }), el('span', { text: d.score == null ? 'Not determined' : ['Low', 'Medium', 'High'][d.score - 1] + ' · ' + d.confidence })), d.score == null ? null : el('div', { class: 'track' }, el('span', { class: 'fill', style: 'width:' + (d.score / 3 * 100) + '%' }))))
    profile.append(list)
    const tier = el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: r.demo ? 'Recommended model (demonstration)' : 'Recommended model' }), el('div', { class: 'tier' }, el('div', { class: 'orb' }, el('span', { text: (r.name || '?')[0].toUpperCase() })), el('div', null, el('h2', { text: r.name }), el('p', { class: 'muted', text: r.price }))))
    const bands = { low: 1, medium: 2, high: 3 }
    if (r.cost) { const dots = el('div', { class: 'dots' }); for (let i = 1; i <= 3; i++) dots.append(el('i', { class: i <= bands[r.cost] ? 'f' : '' })); tier.append(el('div', { class: 'cost' }, 'Cost', dots, el('strong', { text: r.cost }))) }
    if (r.coverage && r.coverage.length) { const t = el('table', { class: 'cov', style: 'margin-top:14px' }); t.append(el('tr', null, el('th', { text: 'Need' }), el('th', { text: 'Task' }), el('th', { text: 'Model' }), el('th', { text: '' }))); const NAMES = { reasoning: 'Reasoning', context: 'Context', domain: 'Domain', reliability: 'Reliability', tools: 'Tools' }; const STATE = { covers: 'covers', covers_as_described: 'as described', short: 'short' }; for (const c of r.coverage) t.append(el('tr', null, el('td', { text: NAMES[c.need] || c.need }), el('td', { text: c.estimated + '/' + c.top }), el('td', { text: c.level == null ? '–' : c.level }), el('td', { text: STATE[c.state] || c.state }))); tier.append(t) }
    const why = el('ul', { class: 'why' }); for (const line of [r.rationale, ...r.why]) if (line) why.append(el('li', null, el('span', { class: 'tick', text: '✓' }), el('span', { text: line })))
    tier.append(why)
    if (r.alternatives.length) { tier.append(el('p', { class: 'eyebrow', style: 'margin-top:18px', text: 'Alternatives' })); for (const a of r.alternatives) tier.append(el('p', { class: 'muted', text: a.name + ' · ' + a.price })) }
    const tips = el('section', { class: 'card' }, el('p', { class: 'eyebrow', text: 'Tips' }), el('h2', { text: 'Improve your request', style: 'margin-bottom:8px' }))
    if (r.changes && r.changes.length) { tips.append(el('p', { class: 'eyebrow', style: 'margin-top:4px', text: 'Since the previous analysis' })); for (const c of r.changes) tips.append(el('p', { class: 'muted', text: c })) }
    const lines = [...r.tips, ...r.questions]
    if (!lines.length) tips.append(el('p', { class: 'muted', text: 'Nothing to add: the task is clear enough.' }))
    lines.forEach((t, i) => tips.append(el('div', { class: 'tip' }, el('span', { class: 'tipn', text: String(i + 1).padStart(2, '0') }), el('p', { text: t }))))
    out.push(el('div', { class: 'grid3' }, profile, tier, tips))
    out.push(el('div', { class: 'override' }, el('div', null, el('h3', { text: 'What now?' }), el('p', { class: 'muted', text: 'Use it for the chat, say whether it solved the task, or improve the prompt.' })), el('div', { class: 'btns' },
      btn('Use this model', 'result', { command: 'adaptai.useModel', id: r.id }, 'primary'), btn('Task solved?', 'result', { command: 'adaptai.taskOutcome', id: r.id }), r.coach ? btn('Prompt Coach', 'result', { command: 'adaptai.coachResult', id: r.id }) : null, btn('Full report', 'open', { id: r.id }), btn('Copy', 'result', { command: 'adaptai.copySummary', id: r.id }))))
    return out
  }

  function analyseTab(d) {
    const out = intro('AI model guidance', 'Choose capability with confidence.', 'Describe a task and see which model covers what it needs, at what cost. Your text is sent only when you press Analyse.')
    const area = el('textarea', { placeholder: 'Describe the task you would give to an AI model…', value: draft, id: 'task', oninput: () => { draft = area.value; api.setState({ text: draft }) } })
    area.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click() } })
    const go = el('button', { class: 'btn primary', text: d.busy ? 'Analysing…' : 'Analyse', disabled: !!d.busy, onclick: () => area.value.trim() && send('analyse', { text: area.value }) })
    const pick = el('select', { 'aria-label': 'Chat model', onchange: () => send('chatModel', { id: pick.value }) })
    pick.append(el('option', { value: '', text: 'Chat model: Auto' }))
    for (const o of d.options) pick.append(el('option', { value: o.id, text: 'Chat model: ' + o.label + (o.model ? ' · ' + o.model : '') + (o.external ? ' (external)' : ' (local)'), selected: o.id === d.chatModel }))
    out.push(el('section', { class: 'card composer' }, el('label', { for: 'task', text: 'Describe your task' }), area, el('div', { class: 'cfoot' }, el('div', null, pick, el('p', { class: 'muted', style: 'margin-top:6px', text: d.assessment ? 'Analysed by ' + d.assessment.label + (d.assessment.model ? ' · ' + d.assessment.model : '') + ' (the project assessor). The chat model is used by @adaptai.' : 'No project assessor: the chat model also analyses.' })), el('div', { class: 'btns' }, el('span', { class: 'muted', text: 'Ctrl+Enter' }), go))))
    if (d.last) out.push(...resultCards(d.last))
    out.push(el('p', { class: 'privacy', text: 'In your editor: select a prompt and press Ctrl+Alt+A to analyse it, or Ctrl+K Ctrl+E to improve it. No telemetry. Secrets are never sent without asking.' }))
    return out
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

  function chatTab(d) {
    const out = intro('Chat', 'Talk to your models.', 'The chat uses the models set up in LLM config, through the backend. Your chats are saved on the backend; delete them any time.')
    const list = el('section', { class: 'card chatlist' }, el('div', { class: 'btns', style: 'margin-bottom:8px' }, el('button', { class: 'btn primary small', text: 'New chat', onclick: () => send('chatSelect', { id: '' }) })))
    if (!d.chats.length) list.append(el('p', { class: 'muted', text: 'No chats yet.' }))
    for (const x of d.chats) { const r = row(x.title, x.count + ' messages', btn('Rename', 'chatRename', { id: x.id }), btn('×', 'chatDelete', { id: x.id }, 'danger')); r.className = 'row' + (x.id === d.current ? ' on' : ''); r.querySelector('.w').addEventListener('click', () => send('chatSelect', { id: x.id })); list.append(r) }
    const msgs = el('div', { class: 'msgs', id: 'msgs' })
    if (!d.messages.length) msgs.append(el('div', { class: 'empty', text: 'Ask anything. Start a message with /analyse to analyse a task inside this chat.' }))
    for (const m of d.messages) msgs.append(bubble(m.role, m.who, m.text, m.error))
    live = null
    const area = el('textarea', { placeholder: 'Message… (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message' })
    const send_ = () => { const text = area.value; if (text.trim()) { area.value = ''; send('chatSend', { text }) } }
    area.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send_() } })
    const pick = el('select', { 'aria-label': 'Chat model', onchange: () => send('chatModel', { id: pick.value }) })
    pick.append(el('option', { value: '', text: 'Model: Auto' }))
    for (const o of d.options) pick.append(el('option', { value: o.id, text: o.label + (o.model ? ' · ' + o.model : '') + (o.external ? ' (external)' : ' (local)'), selected: o.id === d.chatModel }))
    const last = d.messages[d.messages.length - 1]
    const btns = el('div', { class: 'btns' }, pick, last && last.role === 'assistant' && last.error ? el('button', { class: 'btn small', text: 'Retry', onclick: () => send('chatRetry') }) : null, el('button', { class: 'btn small', id: 'stop', text: 'Stop', hidden: !d.streaming, onclick: () => send('chatStop') }), el('button', { class: 'btn primary', id: 'sendbtn', text: 'Send', onclick: send_ }))
    const conv = el('section', { class: 'card conv' }, msgs, el('div', { class: 'cmp' }, area, el('div', { class: 'cfoot', style: 'border:0;margin:0;padding-top:8px' }, el('span', { class: 'muted', id: 'note', text: '' }), btns)))
    out.push(el('div', { class: 'chatwrap' }, list, conv))
    setTimeout(() => { const m = document.getElementById('msgs'); if (m) m.scrollTop = m.scrollHeight }, 0)
    return out
  }

  const pct = v => v == null ? 'n/a' : Math.round(v * (v <= 1 ? 100 : 1)) + '%'
  function progressTab(d) {
    const out = intro('My progress', 'See how your choices are going.', 'Computed by the backend from your saved metadata. Agreement measures how often your choice matched the recommendation, not whether it was right.')
    out.push(el('div', { class: 'btns', style: 'margin:-10px 0 16px' }, el('button', { class: 'btn small', text: 'Export my data', onclick: () => send('export') })))
    const p = d.progress, o = d.outcomes, l = d.learning, c = d.coaching
    const stats = el('div', { class: 'stats' })
    const stat = (label, value) => stats.append(el('div', { class: 'card' }, el('p', { class: 'eyebrow', text: label }), el('div', { class: 'stat', text: String(value) })))
    if (p) { stat('Sessions', p.sessions); stat('Analyses', p.analyses); stat('Choices', p.choices); stat('Agreement', pct(p.agreement)) } else stats.append(el('p', { class: 'muted', text: 'Activity not available.' }))
    out.push(stats)
    const grid = el('div', { class: 'grid2' })
    if (d.dashboard) grid.append(card('Provisioning', 'Over and under', el('p', { text: 'Over: ' + d.dashboard.over + ' · Under: ' + d.dashboard.under }), el('p', { class: 'muted', text: 'Over: a model that covers more than the task needed. Under: one that covers less.' })))
    const solved = card('Outcomes', 'Your solved tasks')
    if (o && o.tasks + o.skipped > 0) { solved.append(el('p', { text: o.tasks + ' answered, ' + o.skipped + ' skipped: ' + o.resolved + ' solved · ' + o.resolved_with_refinement + ' after refining · ' + o.not_resolved + ' not solved.' }), el('p', { class: 'muted', text: 'Following the recommendation: ' + pct(o.solved_rate_following) + ' of ' + o.followed + '. Not following it: ' + pct(o.solved_rate_not_following) + '.' }))
      if (o.by_model.length) { const t = el('table'); t.append(el('tr', null, el('th', { text: 'Model' }), el('th', { text: 'Tasks' }), el('th', { text: 'Solved' }))); for (const m of o.by_model) t.append(el('tr', null, el('td', { text: m.model || 'unknown' }), el('td', { text: m.tasks }), el('td', { text: m.solved }))); solved.append(t) } }
    else solved.append(el('p', { class: 'muted', text: 'No answers yet: after an analysis, say whether the model solved the task.' }))
    grid.append(solved); out.push(grid)
    const P = card('Next step', 'Choices to confirm (' + ((d.pending || []).length) + ')'); P.style.marginTop = '14px'
    P.append(el('p', { class: 'muted', text: 'Analyses are saved automatically. Tell AdaptAI which model you actually used to build your match chart and patterns.' }))
    if (!d.pending || !d.pending.length) P.append(el('p', { class: 'muted', text: 'No choices waiting for confirmation.' }))
    else for (const x of d.pending) P.append(el('div', { class: 'row' }, el('div', { class: 'w' }, el('div', { text: x.title }), el('p', { class: 'muted', text: 'Recommended: ' + x.recommended })), el('div', { class: 'btns' }, x.options.slice(0, 4).map(o => el('button', { class: 'btn small', text: 'I used ' + o.name, onclick: () => send('choose', { analysis: x.id, candidate: o.id }) })))))
    out.push(P)
    const L = card('Learning', 'Do you describe tasks better?'); L.style.marginTop = '14px'
    L.append(el('p', { text: l ? ({ insufficient_history: 'Not enough sessions yet.', improving: 'You describe tasks more completely than at the start.', declining: 'Your descriptions are less complete than at the start.', stable: 'About as complete as at the start.' }[l.verdict] || l.verdict) : 'Not available.' }))
    if (l && l.points.length) L.append(el('p', { class: 'muted', text: 'Completeness per session: ' + l.points.map(x => x.completeness).join(' · ') }))
    out.push(L)
    const E = card('Educator', 'Suggestions')
    if (!c) E.append(el('p', { class: 'muted', text: 'Not available.' }))
    else if (!c.configured) E.append(el('p', { class: 'muted', text: 'The Educator is not configured on this backend.' }))
    else if (c.saved) { E.append(el('p', { text: c.saved.summary })); for (const s of c.saved.suggestions) E.append(row(s.title, s.explanation + ' Practice: ' + s.action)) }
    else E.append(el('p', { class: 'muted', text: c.automatic_enabled ? 'None yet: they appear after more analyses.' : 'Automatic suggestions are off. Switch them on in Profile.' }))
    out.push(E)
    const H = card('Saved work', 'Session history'); H.style.marginTop = '14px'
    if (!d.sessions || !d.sessions.length) H.append(el('p', { class: 'muted', text: 'No analyses yet.' }))
    else for (const x of d.sessions) H.append(row(x.title, x.count + ' analyses · ' + x.at))
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
    out.push(c, card('Preferences', 'What should AdaptAI know about you?', el('p', { text: d.preferences || 'Nothing saved.', style: 'white-space:pre-wrap' }), el('div', { class: 'btns', style: 'margin-top:10px' }, el('button', { class: 'btn small', text: 'Edit preferences', onclick: () => send('preferences', { current: d.preferences || '' }) }))))
    out.push(card('Transparency', 'Delete your data', row('Learned memory', d.counts.memory + ' entries', btn('Delete', 'delete', { what: 'memory' }, 'danger')), row('Stored conversations', d.counts.conversations + ' saved', btn('Delete', 'delete', { what: 'conversations' }, 'danger')), row('All usage history', 'Sessions, choices, memory, advice', btn('Delete', 'delete', { what: 'history' }, 'danger'))))
    const mem = card('Transparency', 'Learned memory'); mem.append(el('p', { class: 'muted', text: 'Recent metadata available to the Assistant (up to 20 entries). Model-generated profiles stay provisional.' }))
    if (!d.memory || !d.memory.length) mem.append(el('p', { class: 'muted', style: 'margin-top:8px', text: 'No learned memory yet. Switch on saving and analyse a task to start building it.' }))
    else for (const x of d.memory) { const dl = el('dl'); for (const kv of x.profile) dl.append(el('dt', { text: kv[0] }), el('dd', { text: kv[1] })); mem.append(el('details', { class: 'mem' }, el('summary', { text: x.title }), dl)) }
    out.push(mem)
    const chatsCard = card('Conversations', 'Active conversations')
    if (!d.chats.length) chatsCard.append(el('p', { class: 'muted', text: 'No chats yet.' }))
    for (const x of d.chats) chatsCard.append(row(x.title, x.count + ' messages · ' + x.at, el('button', { class: 'btn small', text: 'Open', onclick: () => { tab = 'chat'; mark(); send('chatSelect', { id: x.id }); send('tab', { tab: 'chat' }) } }), btn('Delete', 'chatDelete', { id: x.id }, 'danger')))
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
    if (m && m.type === 'chatStart') { const box = document.getElementById('msgs'); if (!box) return; const empty = box.querySelector('.empty'); if (empty) empty.remove(); if (m.user) box.append(bubble('user', 'You', m.user)); live = { raw: '', el: bubble('ai', 'AdaptAI', '') }; box.append(live.el); box.scrollTop = box.scrollHeight; const stop = document.getElementById('stop'); if (stop) stop.hidden = false; const sb = document.getElementById('sendbtn'); if (sb) sb.disabled = true; return }
    if (m && m.type === 'delta') { if (!live) return; live.raw += m.text; const next = bubble('ai', 'AdaptAI', live.raw); live.el.replaceWith(next); live.el = next; const box = document.getElementById('msgs'); if (box) box.scrollTop = box.scrollHeight; const note = document.getElementById('note'); if (note) note.textContent = ''; return }
    if (m && m.type === 'note') { const note = document.getElementById('note'); if (note) note.textContent = m.text; return }
    const d = event.data; if (!d || d.type !== 'data') return
    tab = d.tab; mark(); main.replaceChildren()
    document.getElementById('signout').hidden = !!d.signedOut
    document.getElementById('acct').replaceChildren(...(d.signedOut ? [el('b', { text: 'Not signed in' })] : [el('b', { text: d.email || '' }), el('span', { class: 'dot' }), 'Connected']))
    if (d.signedOut) return main.append(el('div', { class: 'center' }, el('h1', { text: 'Sign in to use AdaptAI' }), el('p', { class: 'lead', style: 'margin:0 auto 20px', text: 'Use your email and password once. Only a token is kept on this machine.' }), el('div', { class: 'btns', style: 'justify-content:center' }, el('button', { class: 'btn primary', text: 'Sign in', onclick: () => send('signIn') }), el('button', { class: 'btn', text: 'Create an account', onclick: () => send('register') }))))
    if (d.failed) return main.append(el('div', { class: 'err', text: d.failed }), el('p'), el('button', { class: 'btn', text: 'Try again', onclick: () => send('ready') }))
    main.append(...{ analyse: analyseTab, chat: chatTab, progress: progressTab, profile: profileTab, models: modelsTab, shortcuts: shortcutsTab }[tab](d))
  })
  mark(); send('ready')
</script></body></html>`
}
