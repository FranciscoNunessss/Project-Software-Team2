import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  api, createChat, deleteChat, renameChat, errorMessage, getChat, listChats, notifyProgressChange, streamChat, candidateLabel, putOutcome, ApiError,
  type Analysis, type ChatMessage, type ChatSummary, type HistoryItem, type LLMOption, type LLMOptions, type OutcomeReason, type TaskOutcome,
} from './api'
import { AnalysisDrawer } from './AnalysisDrawer'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatMenu, type ChatMenuHost } from './ChatMenu'
import { ModelPicker } from './ModelPicker'
import { OpenRouterModelPicker } from './OpenRouterModelPicker'
import { PromptCoachBubble } from './PromptCoachBubble'
import { OutcomeCard, SolvedButton } from './TaskOutcome'

// Optional chat (ADR-011). Shown only when /api/features reports "chat".
const MAX_CHARS = 8000

function Bubble({ message, last, busy, onRetry, onShowAnalysis }: { message: ChatMessage; last: boolean; busy: boolean; onRetry: () => void; onShowAnalysis: (id: string) => void }) {
  const mine = message.role === 'user'
  const pending = !mine && busy && last
  return (
    <div className={`chat-message ${mine ? 'mine' : 'theirs'}`} data-chat-message={message.role} data-status={message.status}>
      <div className="chat-bubble">
        {message.content
          ? (mine ? <p>{message.content}</p> : <ChatMarkdown text={message.content} />)
          : pending ? <p className="chat-typing" aria-label="Writing">…</p> : null}
      </div>
      {!mine && !pending && message.status !== 'complete' && (
        <div className="chat-note" role="status">
          <span>{message.status === 'stopped' ? 'Stopped.' : errorMessage(message.error)}</span>
          {last && <button type="button" className="chat-link" onClick={onRetry} disabled={busy}>Retry</button>}
        </div>
      )}
      {!mine && message.model && message.status === 'complete' && <span className="chat-meta">{message.model}</span>}
      {mine && message.analysis_id && (
        <button type="button" className="chat-analysis-chip" onClick={() => onShowAnalysis(message.analysis_id as string)} data-analysis-chip="">
          Analysis {message.completeness ?? '–'}/100
        </button>
      )}
    </div>
  )
}

export function ChatScreen({ onConfigureModels, initialChatId, onNotAChat, menu }: {
  onConfigureModels: () => void
  initialChatId?: string
  onNotAChat?: () => void
  menu: ChatMenuHost
}) {
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [options, setOptions] = useState<LLMOption[]>([])
  const [autoId, setAutoId] = useState<string | null>(null)
  const [model, setModel] = useState('auto')
  const [modelsLoading, setModelsLoading] = useState(true)
  const active = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  // Analysis panel: the shown analysis, and the one made from the current draft.
  const [shown, setShown] = useState<Analysis | null>(null)
  const [shownFromHistory, setShownFromHistory] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [analysing, setAnalysing] = useState(false)
  const [draftAnalysis, setDraftAnalysis] = useState<{ analysis: Analysis; text: string } | null>(null)
  // Live analyses of this visit, kept whole (history drops tips and evidence).
  const cache = useRef(new Map<string, Analysis>())
  // Feedback per task (ADR-014): Retry clicks per task, and the task to ask about when the
  // next one starts.
  const retries = useRef(new Map<string, number>())
  const [pending, setPending] = useState<OpenTask | null>(null)
  const [savingOutcome, setSavingOutcome] = useState(false)
  const current = openTask(messages)
  // Ask about the open task once, when the user moves on to another one.
  const askAboutOpenTask = () => {
    if (current && current.answers.some(item => item.status === 'complete')) setPending(current)
  }
  const answerOutcome = async (task: OpenTask, outcome: TaskOutcome, reason?: OutcomeReason | null) => {
    setSavingOutcome(true); setError('')
    const answered = task.answers.filter(item => item.status === 'complete' && item.model)
    const last = answered[answered.length - 1]
    try {
      await putOutcome(task.analysisId, {
        outcome, reason: reason ?? null, provider: last?.provider ?? null, model: last?.model ?? null,
        turns: task.answers.filter(item => item.status === 'complete').length,
        switched_model: new Set(answered.map(item => `${item.provider}/${item.model}`)).size > 1,
        stops: task.answers.filter(item => item.status === 'stopped').length,
        retries: retries.current.get(task.analysisId) ?? 0,
      })
    } catch (failure) {
      // Already answered elsewhere: nothing to ask any more.
      if (!(failure instanceof ApiError && failure.status === 409)) { setError('Could not save your feedback.'); setSavingOutcome(false); return }
    }
    setMessages(items => items.map(item => item.analysis_id === task.analysisId && item.role === 'user' ? { ...item, outcome } : item))
    setPending(item => item?.analysisId === task.analysisId ? null : item)
    setSavingOutcome(false); notifyProgressChange()
  }

  const refreshList = () => listChats().then(setChats).catch(() => setError('Could not load your chats.'))

  useEffect(() => {
    const controller = new AbortController()
    listChats(controller.signal).then(setChats).catch(() => { if (!controller.signal.aborted) setError('Could not load your chats.') })
    api<LLMOptions>('llm-options', undefined, controller.signal).then(result => {
      setOptions(result.options); setAutoId(result.auto_configuration_id)
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load models. Check LLM config or refresh.') })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false) })
    return () => { controller.abort(); active.current?.abort() }
  }, [])

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages])
  useEffect(() => {
    if (!initialChatId) return
    getChat(initialChatId).then(chat => { setChatId(chat.id); setMessages(chat.messages) })
      .catch(failure => { if (failure instanceof ApiError && failure.status === 404) onNotAChat?.() })
  }, [initialChatId]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = options.find(item => item.id === (model === 'auto' ? autoId : model))
  // OpenRouter only: the exact catalogue id the user picked; null keeps the configured model.
  const [routerModel, setRouterModel] = useState<string | null>(null)
  const usesRouter = selected?.provider === 'openrouter'
  const routerValue = routerModel ?? selected?.model ?? ''
  const target = { provider: 'auto' as const, configuration_id: model === 'auto' ? undefined : model, model: usesRouter ? routerValue : undefined, allow_external: selected?.external === true }

  const resetAnalysis = () => { setShown(null); setDraftAnalysis(null); setDrawer(false) }
  const open = async (id: string) => {
    if (busy) return
    if (id !== chatId) askAboutOpenTask()
    setError(''); setChatId(id); resetAnalysis()
    try { setMessages((await getChat(id)).messages) } catch { setError('Could not open this chat.') }
  }
  const startNew = () => { if (busy) return; askAboutOpenTask(); setChatId(null); setMessages([]); setDraft(''); setError(''); resetAnalysis() }

  const ensureChat = async () => {
    if (chatId) return chatId
    const id = (await createChat()).id
    setChatId(id)
    return id
  }

  const analyse = async () => {
    const content = draft.trim()
    if (!content || busy || analysing || !selected) return
    // A new analysis starts a new task: the open one, if answered, gets its question now.
    if (!draftAnalysis) askAboutOpenTask()
    setAnalysing(true); setDrawer(true); setError('')
    try {
      const fresh = !chatId
      const id = await ensureChat()
      // A chat started by Analyse is named after the draft, as Send would name it.
      if (fresh) await renameChat(id, titleFrom(content)).catch(() => undefined)
      const result = await api<Analysis>('analyze', {
        task: draft, provider: 'auto', configuration_id: target.configuration_id,
        expected_configuration_id: selected.id, expected_provider: selected.provider, expected_model: (usesRouter ? routerValue : selected.model) ?? undefined, model: target.model,
        session_id: id, previous_analysis_id: draftAnalysis?.analysis.id, allow_external: target.allow_external,
        required_capabilities: ['text'],
      })
      cache.current.set(result.id, result)
      setDraftAnalysis({ analysis: result, text: draft }); setShown(result); setShownFromHistory(false)
      // Following the recommendation is one click away: it is selected for Send (ADR-014).
      const recommended = result.recommendation.configuration_id
      if (recommended && options.some(item => item.id === recommended) && recommended !== (model === 'auto' ? autoId : model)) {
        setModel(recommended === autoId ? 'auto' : recommended); setRouterModel(null)
      }
      notifyProgressChange(); refreshList()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'The analysis failed. Please retry.')
    } finally { setAnalysing(false) }
  }

  const showAnalysis = async (analysisId: string) => {
    setDrawer(true)
    const cached = cache.current.get(analysisId)
    if (cached) { setShown(cached); setShownFromHistory(false); return }
    try {
      const session = await api<{ analyses: HistoryItem[] }>(`sessions/${chatId}`)
      const item = session.analyses.find(entry => entry.result.id === analysisId)
      if (item) { setShown(item.conversation?.response ?? item.result); setShownFromHistory(!item.conversation) }
    } catch { setError('Could not open this analysis.') }
  }
  const remove = async (id: string) => {
    if (busy) return
    try { await deleteChat(id) } catch { setError('Could not delete the chat.'); return }
    if (id === chatId) startNew()
    refreshList()
  }

  // Shared by Send and Retry: streams the answer into the last bubble.
  const run = async (id: string, path: string, body: unknown, optimistic: ChatMessage[]) => {
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    setMessages(optimistic)
    try {
      const turn = await streamChat(path, body, {
        onMessage: (message, answerId) => setMessages(current => {
          const kept = current.filter(item => item.id !== 'draft-question' && item.id !== 'draft-answer' && item.id !== answerId)
          return [...kept, message, placeholder(answerId)]
        }),
        onDelta: text => setMessages(current => current.map((item, index) =>
          index === current.length - 1 ? { ...item, content: item.content + text } : item)),
      }, controller.signal)
      setMessages(current => current.map(item => item.id === turn.answer.id ? turn.answer : item.id === turn.message.id ? turn.message : item))
    } catch (failure) {
      if (controller.signal.aborted) {
        // Stop: the server kept what arrived; show the stored state.
        setMessages(current => current.map((item, index) =>
          index === current.length - 1 && item.role === 'assistant' ? { ...item, status: 'stopped' } : item))
      } else {
        setError(failure instanceof ApiError ? failure.message : 'The answer failed. Please retry.')
        getChat(id).then(chat => setMessages(chat.messages)).catch(() => undefined)
      }
    } finally {
      if (active.current === controller) active.current = null
      setBusy(false)
      refreshList()
    }
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || busy || content.length > MAX_CHARS) return
    let id: string
    try { id = await ensureChat() } catch { setError('Could not create a chat.'); return }
    // The analysis goes with the message only if it was made from this exact text.
    const analysisId = draftAnalysis && draftAnalysis.text === draft ? draftAnalysis.analysis.id : undefined
    setDraft(''); setDraftAnalysis(null)
    const question: ChatMessage = { ...placeholder('draft-question'), role: 'user', content, analysis_id: analysisId ?? null, completeness: analysisId ? draftAnalysis?.analysis.completeness ?? null : null }
    await run(id, `chats/${id}/messages`, { content, ...target, analysis_id: analysisId }, [...messages, question, placeholder('draft-answer')])
  }
  const retry = () => {
    const last = messages[messages.length - 1]
    if (!chatId || !last || last.role !== 'assistant') return
    if (current) retries.current.set(current.analysisId, (retries.current.get(current.analysisId) ?? 0) + 1)
    run(chatId, `chats/${chatId}/messages/${last.id}/retry`, target, [...messages.slice(0, -1), placeholder(last.id)])
  }
  const stop = () => active.current?.abort()
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }

  const stale = shown !== null && draftAnalysis?.analysis.id === shown.id && draftAnalysis.text !== draft
  const locked = busy || analysing

  return (
    <main className={`page chat-layout${drawer ? ' with-drawer' : ''}`} data-chat-screen="">
      <ChatMenu host={menu} chats={chats} activeId={chatId} locked={locked} onNew={startNew} onOpen={open} onDelete={remove} />
      <section className="chat-main">
        <div className="chat-toolbar">
          <span className="muted chat-title">{chats.find(chat => chat.id === chatId)?.title ?? 'New chat'}</span>
          {chatId && <button type="button" className="button button-secondary chat-toolbar-new" onClick={startNew} disabled={locked}>New chat</button>}
        </div>
        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-empty"><h2>What do you need to do?</h2><p>Write your prompt. <strong>Analyse</strong> shows how complete it is and which model fits; <strong>Send</strong> gets the answer.</p></div>
          ) : messages.map((message, index) => (
            <Bubble key={message.id} message={message} last={index === messages.length - 1} busy={busy} onRetry={retry} onShowAnalysis={showAnalysis} />
          ))}
          {current && !busy && pending?.analysisId !== current.analysisId && current.answers.some(item => item.status === 'complete') && (
            <div className="chat-message theirs"><SolvedButton disabled={savingOutcome} onAnswer={outcome => answerOutcome(current, outcome)} /></div>
          )}
          <div ref={end} />
        </div>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {pending && (
          <OutcomeCard title={pending.title} disabled={savingOutcome} onAnswer={(outcome, reason) => answerOutcome(pending, outcome, reason)} />
        )}
        <section className="chat-composer composer" data-analysis-id={draftAnalysis?.analysis.id ?? ''} data-session-id={chatId ?? ''}>
          <PromptCoachBubble analysis={draftAnalysis?.analysis} analysisId={draftAnalysis?.analysis.id} task={draft}
            disabled={locked} onTaskChange={setDraft} onAnalyse={analyse}>
            <textarea aria-label="Message" placeholder="Message AdaptAI…" value={draft} maxLength={MAX_CHARS}
              onChange={event => setDraft(event.target.value)} onKeyDown={onKey} rows={3} data-chat-input="" data-task-input="" disabled={busy} />
          </PromptCoachBubble>
          <div className="composer-footer">
            <ModelPicker options={options} value={model} autoId={autoId} loading={modelsLoading} disabled={locked} onChange={value => { setModel(value); setRouterModel(null); setDraftAnalysis(null) }} onConfigure={onConfigureModels} />
            {usesRouter && <OpenRouterModelPicker value={routerValue} disabled={locked} onChange={value => { setRouterModel(value); setDraftAnalysis(null) }} />}
            <div className="composer-actions">
              <span>{draft.length}/{MAX_CHARS}</span>
              {draftAnalysis && draftAnalysis.text === draft && <span className="chat-recommendation" data-recommended-model="">Recommended: <strong>{candidateLabel(draftAnalysis.analysis.recommendation)}</strong>{draftAnalysis.analysis.recommendation.configuration_id && draftAnalysis.analysis.recommendation.configuration_id === selected?.id ? ' · selected' : ''}</span>}
              <button type="button" className="button button-secondary" onClick={analyse} disabled={locked || !draft.trim() || modelsLoading || !selected} data-analyse-button="">
                {analysing ? 'Analysing…' : 'Analyse'}
              </button>
              {busy
                ? <button type="button" className="button button-secondary" onClick={stop} data-chat-stop="">Stop</button>
                : <button type="button" className="button button-primary" onClick={send} disabled={analysing || !draft.trim() || modelsLoading || !selected} data-chat-send="">Send</button>}
            </div>
          </div>
        </section>
        {selected?.external && <p className="processing-notice">Selecting <strong>Analyse</strong> or <strong>Send</strong> sends your text to <strong>{selected.provider}</strong>. Messages are saved in this chat until you delete it.</p>}
      </section>
      <div className="drawer-slot">
        <AnalysisDrawer open={drawer} onToggle={setDrawer} analysis={shown} task={draftAnalysis && shown && draftAnalysis.analysis.id === shown.id ? draft : undefined} loading={analysing} stale={stale} fromHistory={shownFromHistory} />
      </div>
    </main>
  )
}

type OpenTask = { analysisId: string; title: string; answers: ChatMessage[] }

/** The task still open in a chat: the last analysed message without feedback, and its answers. */
function openTask(messages: ChatMessage[]): OpenTask | null {
  let index = -1
  messages.forEach((item, position) => { if (item.role === 'user' && item.analysis_id) index = position })
  const question = messages[index]
  if (!question || !question.analysis_id || question.outcome) return null
  const rest = messages.slice(index + 1)
  return { analysisId: question.analysis_id, title: titleFrom(question.content), answers: rest.filter(item => item.role === 'assistant') }
}

function titleFrom(text: string) {
  const line = text.split(/\s+/).join(' ')
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`
}

function placeholder(id: string): ChatMessage {
  return { id, role: 'assistant', content: '', provider: null, model: null, analysis_id: null, status: 'complete', error: null, created_at: '', completeness: null }
}
