import * as vscode from 'vscode'
import { ApiError, Backend } from './backend'
import type { CoachMode, LlmOption, LlmOptions } from './api'
import { Analyser, explain, type Result } from './analyse'
import { describeFailure, destination } from './core'
import { renderAnalysis } from './format'

const MAX_MESSAGE = 8000

export type ChatSummary = { id: string; title: string; created_at: string; updated_at?: string; message_count: number }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; provider: string | null; model: string | null; analysis_id: string | null; status: string; error: string | null; created_at: string }
type ChatDetail = ChatSummary & { messages: ChatMessage[] }

/** Where the chat writes: the native chat view in VS Code, or a stand-in in tests. */
export type Sink = {
  markdown(text: string): void
  progress(text: string): void
  button(command: { command: string; title: string; arguments?: unknown[] }): void
}

/**
 * The AdaptAI chat (ADR-011) without a webview: the participant `@adaptai` in the chat view streams the
 * answer of the model you chose, and the chats live on the backend like in the app. The message goes to
 * that model only when you send it, after the same confirmation as an analysis when the model is external.
 */
export class ChatService {
  private chatId: string | undefined
  private lastAnswerId: string | undefined
  /** The text of the last analysis, so a message with exactly that text carries it (as the app does). */
  private analysed: { text: string; id: string } | undefined
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event

  constructor(
    private readonly backend: Backend,
    private readonly analyser: Analyser,
    private readonly memento?: vscode.Memento,
  ) {
    this.chatId = memento?.get<string>('adaptai.chatId')
  }

  get current(): string | undefined {
    return this.chatId
  }

  async setCurrent(id: string | undefined): Promise<void> {
    this.chatId = id
    this.lastAnswerId = undefined
    this.analysed = undefined
    await this.memento?.update('adaptai.chatId', id)
    this.changed.fire()
  }

  // ---- the model of the chat --------------------------------------------------------------------

  /** The chat model: `adaptai.chatModel`, else Auto. OpenRouter models are picked in the app (live catalogue). */
  private model(options: LlmOptions): LlmOption | undefined {
    const wanted = vscode.workspace.getConfiguration('adaptai').get<string>('chatModel', '')
    return options.options.find(item => item.id === wanted) ?? options.options.find(item => item.id === options.auto_configuration_id) ?? options.options.find(item => item.provider !== 'demo') ?? options.options[0]
  }

  private target(option: LlmOption, options: LlmOptions) {
    const auto = option.id === options.auto_configuration_id
    return {
      provider: 'auto',
      configuration_id: auto ? undefined : option.id,
      model: option.provider === 'openrouter' ? option.model ?? undefined : undefined,
      allow_external: option.external,
    }
  }

  /** The confirmation before the message leaves the editor: the model, the backend, the size. */
  private async confirm(option: LlmOption, characters: number): Promise<boolean> {
    if (!option.external) return true
    const config = vscode.workspace.getConfiguration('adaptai')
    if (!config.get<boolean>('confirmExternal', true)) return true
    const host = new URL(this.backend.url).host
    const send = 'Send'
    const always = 'Send and do not ask again'
    const choice = await vscode.window.showWarningMessage(
      `AdaptAI will send your message (${characters} characters) through the backend at ${host} to ${destination(option)}, outside your machine. The chat stores it on the backend until you delete the chat.`,
      { modal: true },
      send,
      always,
    )
    if (choice === always) await config.update('confirmExternal', false, vscode.ConfigurationTarget.Global)
    return Boolean(choice)
  }

  // ---- sending ----------------------------------------------------------------------------------

  private async ensureChat(): Promise<string> {
    if (this.chatId) return this.chatId
    const chat = await this.backend.api<{ id: string }>('/api/chats', 'POST', {})
    await this.setCurrent(chat.id)
    return chat.id
  }

  private async stream(sink: Sink, path: string, body: Record<string, unknown>, signal: AbortSignal, provider?: string): Promise<void> {
    let failure: string | undefined
    try {
      for await (const { event, data } of this.backend.events(path, 'POST', body, signal, provider)) {
        const payload = (data ?? {}) as Record<string, unknown>
        if (event === 'message') this.lastAnswerId = typeof payload.answer_id === 'string' ? payload.answer_id : this.lastAnswerId
        else if (event === 'delta') sink.markdown(String(payload.text ?? ''))
        else if (event === 'error') failure = String(payload.code ?? 'provider_unavailable')
        else if (event === 'done') this.changed.fire()
      }
    } catch (error) {
      if (signal.aborted && !(error instanceof Error && error.name === 'TimeoutError')) {
        sink.markdown('\n\n_Stopped. The part already written is kept in the chat._')
        this.changed.fire()
        return
      }
      failure = error instanceof ApiError ? undefined : error instanceof Error && error.name === 'TimeoutError' ? 'idle' : 'unreachable'
      if (error instanceof ApiError) sink.markdown(`\n\n**${error.friendly}**`)
      else if (failure === 'idle') sink.markdown('\n\n**The backend sent nothing for a while, so the answer was stopped.** The part already written is kept; use `/retry`.')
      else sink.markdown(`\n\n**${explain(error)}**`)
      sink.button({ command: 'adaptai.chatRetry', title: 'Retry' })
      this.changed.fire()
      return
    }
    if (failure) {
      sink.markdown(`\n\n**${describeFailure(502, failure, provider)}**`)
      sink.button({ command: 'adaptai.chatRetry', title: 'Retry' })
      this.changed.fire()
    }
  }

  /** A normal message: sent to the chat model, the answer streams back. */
  async send(prompt: string, sink: Sink, signal: AbortSignal, override?: { optionId: string; model?: string }): Promise<void> {
    if (this.backend.auth === 'none' || this.backend.urlProblem) return sink.markdown(this.backend.urlProblem ? `**${this.backend.urlProblem}**` : '**Sign in first** (the AdaptAI view, or the command *AdaptAI: Sign in*).')
    if (prompt.length > MAX_MESSAGE) return sink.markdown(`**That message is ${prompt.length} characters; the chat takes up to ${MAX_MESSAGE}.**`)
    const options = await this.backend.api<LlmOptions>('/api/llm-options').catch(error => {
      sink.markdown(`**${explain(error)}**`)
      return undefined
    })
    if (!options) return
    const picked = override ? options.options.find(item => item.id === override.optionId) : undefined
    const option = picked ? { ...picked, model: override?.model ?? picked.model } : this.model(options)
    if (!option) return sink.markdown('**No model is available for the chat.** Add one in the app (LLM config), or configure one on the backend.')
    if (!(await this.confirm(option, prompt.length))) return sink.markdown('_Cancelled. Nothing was sent._')
    sink.progress(`Asking ${destination(option)}…`)
    const id = await this.ensureChat()
    const analysisId = this.analysed && this.analysed.text === prompt ? this.analysed.id : undefined
    await this.stream(sink, `/api/chats/${encodeURIComponent(id)}/messages`, { content: prompt, ...this.target(option, options), analysis_id: analysisId }, signal, option.provider)
  }

  /** Answers the last question again (a stopped or failed answer). */
  async retry(sink: Sink, signal: AbortSignal): Promise<void> {
    if (!this.chatId || !this.lastAnswerId) return sink.markdown('**There is no answer to retry in this chat yet.**')
    const options = await this.backend.api<LlmOptions>('/api/llm-options').catch(() => undefined)
    const option = options ? this.model(options) : undefined
    if (!options || !option) return sink.markdown('**No model is available for the chat.**')
    if (!(await this.confirm(option, 0))) return sink.markdown('_Cancelled. Nothing was sent._')
    const { configuration_id, model, allow_external, provider } = this.target(option, options)
    await this.stream(sink, `/api/chats/${encodeURIComponent(this.chatId)}/messages/${encodeURIComponent(this.lastAnswerId)}/retry`, { provider, configuration_id, model, allow_external }, signal, option.provider)
  }

  /** `/analyse text`: the analysis inside the chat session, as the app's Analyse button does. */
  async analyse(text: string, sink: Sink, signal: AbortSignal): Promise<void> {
    const sessionId = await this.ensureChat().catch(() => undefined)
    const result = await this.analyser.analyseText(text, { sessionId, previousId: this.analysed?.id, signal })
    if (!result) return sink.markdown('_No analysis was made (it was cancelled or failed; the reason is in the notification)._')
    this.analysed = { text: result.task, id: result.analysis.id }
    sink.markdown(renderAnalysis(result.analysis, { source: result.source, at: result.at }))
    sink.button({ command: 'adaptai.taskOutcome', title: 'Task solved?', arguments: [result.analysis.id] })
    sink.button({ command: 'adaptai.useModel', title: 'Use this model in the chat', arguments: [result.analysis.id] })
    sink.button({ command: 'adaptai.chatSendText', title: 'Send it to the chat', arguments: [result.task] })
  }

  /**
   * The analysis button of the page: the same call as `/analyse` inside the chat's own session (so the next
   * message carries it), but nothing is written to a sink: the page shows the result. A past session picked
   * with "Continue this session" takes the place of the chat's session.
   */
  async analyseForPage(text: string, opts: { thenCoach?: boolean; signal?: AbortSignal } = {}): Promise<Result | undefined> {
    const continuing = this.analyser.continueFrom
    const sessionId = continuing?.sessionId ?? (await this.ensureChat().catch(() => undefined))
    const previousId = continuing ? continuing.previousId : this.analysed?.id
    const result = await this.analyser.analyseText(text, { sessionId, previousId, signal: opts.signal, quiet: true, thenCoach: opts.thenCoach })
    if (!result) return undefined
    this.analysed = { text, id: result.analysis.id }
    if (continuing) this.analyser.continueFrom = { ...continuing, previousId: result.analysis.id }
    return result
  }

  /** The Prompt Coach on the text of the page: the analysis in the chat's session, then the Coach in the given mode. */
  async coachForPage(text: string, mode: CoachMode, signal?: AbortSignal): Promise<Result | undefined> {
    const result = await this.analyseForPage(text, { thenCoach: true, signal })
    if (!result) return undefined
    if (!result.coachAvailable) {
      void vscode.window.showWarningMessage('AdaptAI: Prompt Coach is not installed on this backend.')
      return result
    }
    await this.analyser.coach(result, mode, true)
    return result
  }

  async newChat(): Promise<void> {
    await this.setCurrent(undefined)
  }

  // ---- the list of chats ------------------------------------------------------------------------

  async list(): Promise<ChatSummary[]> {
    return this.backend.api<ChatSummary[]>('/api/chats', 'GET', undefined, AbortSignal.timeout(8000))
  }

  async transcript(id: string): Promise<string> {
    const chat = await this.backend.api<ChatDetail>(`/api/chats/${encodeURIComponent(id)}`)
    const lines = [`# ${chat.title}`, '']
    for (const message of chat.messages) {
      const who = message.role === 'user' ? 'You' : `AdaptAI${message.model ? ` · ${message.provider ?? ''} ${message.model}` : ''}`
      lines.push(`## ${who}`, '', message.content || '_(empty)_', '')
      if (message.status === 'failed' || message.error) lines.push(`_${message.error ? describeFailure(502, message.error, message.provider ?? undefined) : 'This answer failed.'}_`, '')
      if (message.status === 'stopped') lines.push('_Stopped by you._', '')
    }
    return lines.join('\n')
  }

  async rename(id: string, title: string): Promise<void> {
    await this.backend.api(`/api/chats/${encodeURIComponent(id)}`, 'PATCH', { title })
    this.changed.fire()
  }

  async remove(id: string): Promise<void> {
    await this.backend.api(`/api/chats/${encodeURIComponent(id)}`, 'DELETE')
    if (this.chatId === id) await this.setCurrent(undefined)
    this.changed.fire()
  }
}

export function registerParticipant(chat: ChatService): vscode.Disposable | undefined {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return undefined
  const participant = vscode.chat.createChatParticipant('adaptai.chat', async (request, _context, response, token) => {
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    const sink: Sink = { markdown: text => void response.markdown(text), progress: text => void response.progress(text), button: command => void response.button(command) }
    const prompt = request.prompt.trim()
    if (request.command === 'new') {
      await chat.newChat()
      return void response.markdown('Started a new chat. Your next message opens it on the backend.')
    }
    if (request.command === 'retry') return chat.retry(sink, controller.signal)
    if (request.command === 'analyse') {
      if (!prompt) return void response.markdown('Write the task after `/analyse`, for example `/analyse compare two API designs`.')
      return chat.analyse(prompt, sink, controller.signal)
    }
    if (!prompt) return void response.markdown('Write a message. Use `/analyse <task>` to see which model fits a task, `/new` for a new chat and `/retry` to answer the last question again.')
    return chat.send(prompt, sink, controller.signal)
  })
  participant.iconPath = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'media', 'icon.png')
  return participant
}
