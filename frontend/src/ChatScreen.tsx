import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { usePageActive } from './PagePanel'
import {
  api, createChat, renameChat, errorMessage, getChat, notifyProgressChange, streamChat, candidateLabel, putOutcome, ApiError,
  type Analysis, type ChatMessage, type HistoryItem, type LLMOption, type LLMOptions, type OutcomeReason, type TaskOutcome,
} from './api'
import { AnalysisDrawer, type UseRecommended } from './AnalysisDrawer'
import { ChatMarkdown } from './ChatMarkdown'
import { ModelPicker } from './ModelPicker'
import { OpenRouterModelPicker } from './OpenRouterModelPicker'
import { statusKey, statusOf, type ModelStatus } from './modelStatus'
import { PromptCoachBubble } from './PromptCoachBubble'
import { OutcomeCard, SolvedButton } from './TaskOutcome'
import { Button, useSheetClearance } from './ui'
import './Composer.css'
import './ChatScreen.css'

// Optional chat (ADR-011). Shown only when /api/features reports "chat".
const MAX_CHARS = 8000

// Failures that another model would not have: a limit or the credit of this model (A11).
const LIMIT_ERRORS = new Set(['provider_rate_limit', 'provider_insufficient_credits', 'provider_model_unavailable', 'provider_timeout', 'empty_answer'])

function Bubble({ message, last, busy, onRetry, onShowAnalysis, fallback }: { message: ChatMessage; last: boolean; busy: boolean; onRetry: () => void; onShowAnalysis: (id: string) => void; fallback?: { label: string; onUse: () => void } }) {
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
          {last && fallback && message.status === 'failed' && LIMIT_ERRORS.has(message.error ?? '') && (
            <button type="button" className="chat-link" onClick={fallback.onUse} disabled={busy} data-send-with-assessor="">Send with {fallback.label}</button>
          )}
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

// The chat list itself lives in the sidebar (App); this screen reports back what changes.
export function ChatScreen({ onConfigureModels, initialChatId, onNotAChat, title, error: listError, onChatCreated, onChatsChanged, onBusyChange, carriedTask, onTaskState }: {
  onConfigureModels: () => void
  initialChatId?: string
  onNotAChat?: () => void
  title?: string
  error?: string
  onChatCreated: (id: string | null) => void
  onChatsChanged: () => void
  onBusyChange: (locked: boolean) => void
  // Feedback per task (ADR-014) across chats: switching chat remounts this screen, so App
  // keeps the task to ask about and hands it to the next chat.
  carriedTask?: OpenTask | null
  onTaskState: (state: TaskState) => void
}) {
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [options, setOptions] = useState<LLMOption[]>([])
  const [autoId, setAutoId] = useState<string | null>(null)
  // ADR-014 A11: Analyse always uses the project's assessor; the picker is the chat model.
  const [assessor, setAssessor] = useState<LLMOption | null>(null)
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
  const [pending, setPending] = useState<OpenTask | null>(carriedTask ?? null)
  const [savingOutcome, setSavingOutcome] = useState(false)
  const current = openTask(messages)
  // Report the open task (if it has an answer) and the unanswered question, for App to carry.
  const answered = current?.answers.filter(item => item.status === 'complete').length ?? 0
  useEffect(() => {
    onTaskState({ open: current && answered > 0 ? current : null, pending })
  }, [current?.analysisId, answered, pending]) // eslint-disable-line react-hooks/exhaustive-deps
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

  const refreshList = onChatsChanged

  useEffect(() => {
    const controller = new AbortController()
    api<LLMOptions>('llm-options', undefined, controller.signal).then(result => {
      setOptions(result.options); setAutoId(result.auto_configuration_id); setAssessor(result.assessment ?? null)
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load models. Check LLM config or refresh.') })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false) })
    return () => { controller.abort(); active.current?.abort() }
  }, [])

  const activePage = usePageActive()
  const historyDirty = useRef(false)
  useEffect(() => {
    const markChanged = () => { if (!activePage) historyDirty.current = true }
    window.addEventListener('adaptai-progress-updated', markChanged)
    return () => window.removeEventListener('adaptai-progress-updated', markChanged)
  }, [activePage])
  useEffect(() => {
    if (!activePage || !historyDirty.current) return
    historyDirty.current = false
    const controller = new AbortController()
    onChatsChanged()
    if (chatId) void getChat(chatId, controller.signal).then(chat => setMessages(chat.messages))
      .catch(failure => {
        if (controller.signal.aborted) return
        if (failure instanceof ApiError && failure.status === 404) {
          setChatId(null); onChatCreated(null); setMessages([]); setShown(null); setDraftAnalysis(null); setDrawer(false)
        } else setError('Could not refresh your chat.')
      })
    return () => controller.abort()
  }, [activePage])
  useEffect(() => {
    const controller = new AbortController()
    const refreshModels = () => {
      void api<LLMOptions>('llm-options', undefined, controller.signal).then(result => {
        setOptions(result.options); setAutoId(result.auto_configuration_id); setAssessor(result.assessment ?? null)
        setModel(current => current === 'auto' || result.options.some(item => item.id === current) ? current : 'auto')
      }).catch(() => { if (!controller.signal.aborted) setError('Could not refresh model settings.') })
    }
    window.addEventListener('adaptai-models-updated', refreshModels)
    return () => { controller.abort(); window.removeEventListener('adaptai-models-updated', refreshModels) }
  }, [])
  useEffect(() => { if (activePage) end.current?.scrollIntoView({ block: 'end' }) }, [messages])
  useEffect(() => {
    if (!initialChatId || initialChatId === chatId) return
    getChat(initialChatId).then(chat => { setChatId(chat.id); setMessages(chat.messages) })
      .catch(failure => { if (failure instanceof ApiError && failure.status === 404) onNotAChat?.() })
  }, [initialChatId]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = options.find(item => item.id === (model === 'auto' ? autoId : model))
  // OpenRouter only: the exact catalogue id the user picked; null keeps the configured model.
  const [routerModel, setRouterModel] = useState<string | null>(null)
  // ADR-014 A12: the evaluation state of the user's models, shown in the chat model picker.
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({})
  const loadStatuses = () => {
    void api<{ models: Parameters<typeof statusOf>[0][] }>('evaluations')
      .then(data => setStatuses(Object.fromEntries(data.models.map(item => [statusKey(item!.provider, item!.model), statusOf(item)]))))
      .catch(() => undefined)
  }
  useEffect(() => {
    loadStatuses()
    window.addEventListener('adaptai-models-updated', loadStatuses)
    return () => window.removeEventListener('adaptai-models-updated', loadStatuses)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // "Use recommended" (ADR-014): following the recommendation is an explicit, visible choice.
  const recommendedFor = (analysis: Analysis | null | undefined, which: 'recommendation' | 'suggestion' = 'recommendation'): UseRecommended | undefined => {
    if (!analysis || !draftAnalysis || draftAnalysis.analysis.id !== analysis.id) return undefined
    const best = which === 'suggestion' ? analysis.suggestion : analysis.recommendation
    if (!best) return undefined
    if (best.illustrative) return { state: 'illustrative' }
    const target = best.configuration_id
    const config = options.find(item => item.id === target)
    if (!target || !config) return { state: 'unavailable' }
    // A model picked from OpenRouter's catalogue: select the configuration and that model.
    const pick = config.provider === 'openrouter' && best.model && best.model !== config.model ? best.model : null
    const current = config.provider === 'openrouter' ? (routerModel ?? config.model) : null
    if (target === selected?.id && (!pick || current === pick)) return { state: 'selected' }
    return { state: 'available', onUse: () => { setModel(target === autoId ? 'auto' : target); setRouterModel(pick) } }
  }
  const useRecommended = recommendedFor(draftAnalysis?.analysis)
  const usesRouter = selected?.provider === 'openrouter'
  const routerValue = routerModel ?? selected?.model ?? ''
  const target = { provider: 'auto' as const, configuration_id: model === 'auto' ? undefined : model, model: usesRouter ? routerValue : undefined, allow_external: selected?.external === true }

  const ensureChat = async () => {
    if (chatId) return chatId
    const id = (await createChat()).id
    setChatId(id); onChatCreated(id)
    return id
  }

  const [analysisError, setAnalysisError] = useState('')
  const analyse = async () => {
    const content = draft.trim()
    if (!content || busy || analysing || !selected) return
    // A new analysis starts a new task: the open one, if answered, gets its question now.
    if (!draftAnalysis) askAboutOpenTask()
    setAnalysing(true); setDrawer(true); setError(''); setAnalysisError('')
    try {
      const fresh = !chatId
      const id = await ensureChat()
      // A chat started by Analyse is named after the draft, as Send would name it.
      if (fresh) await renameChat(id, titleFrom(content)).catch(() => undefined)
      // The project's assessor analyses every task, whatever model answers in the chat; only
      // without one (no project model configured) does the chat model analyse.
      const how = assessor
        ? { provider: 'auto', allow_external: assessor.external }
        : {
            provider: 'auto', configuration_id: target.configuration_id,
            expected_configuration_id: selected.id, expected_provider: selected.provider, expected_model: (usesRouter ? routerValue : selected.model) ?? undefined, model: target.model,
            allow_external: target.allow_external,
          }
      const result = await api<Analysis>('analyze', {
        task: draft, ...how,
        session_id: id, previous_analysis_id: draftAnalysis?.analysis.id,
        required_capabilities: ['text'],
      })
      cache.current.set(result.id, result)
      setDraftAnalysis({ analysis: result, text: draft }); setShown(result); setShownFromHistory(false)
      notifyProgressChange(); refreshList()
    } catch (failure) {
      const message = failure instanceof ApiError ? failure.message : 'The analysis failed. Please retry.'
      setError(message); setAnalysisError(message)
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
  // ADR-014 A11: when the chat model hit a limit, one click answers with the project's model.
  const retryWithAssessor = () => {
    const last = messages[messages.length - 1]
    if (!chatId || !last || last.role !== 'assistant' || !assessor) return
    setModel(assessor.id === autoId ? 'auto' : assessor.id); setRouterModel(null)
    run(chatId, `chats/${chatId}/messages/${last.id}/retry`, { provider: 'auto', configuration_id: assessor.id, model: undefined, allow_external: assessor.external }, [...messages.slice(0, -1), placeholder(last.id)])
  }
  const stop = () => active.current?.abort()
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }

  const stale = shown !== null && draftAnalysis?.analysis.id === shown.id && draftAnalysis.text !== draft
  // The panel's own Send: only for the analysis of exactly the text in the composer.
  const sendable = shown !== null && draftAnalysis?.analysis.id === shown.id && draftAnalysis.text === draft && !!draft.trim() && !!selected
  const locked = busy || analysing
  // The analysis panel floats over the chat but stops above the message box, so Analyse,
  // Send and the Prompt Coach stay usable while it is open. Track where the box starts.
  // The feedback card (ADR-014) sits right above the box and must stay reachable too.
  const composer = useRef<HTMLElement>(null)
  const composerSpace = useSheetClearance(composer, { active: activePage, above: '[data-outcome-card]' })
  // The sidebar must not switch chats mid-answer: switching remounts this screen.
  useEffect(() => { onBusyChange(locked) }, [locked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBusyChange(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="page chat-layout" data-chat-screen="" style={{ '--composer-space': `${composerSpace}px` } as CSSProperties}>
      <section className="chat-main">
        <div className="chat-toolbar">
          <span className="chat-title">{chatId ? title : ''}</span>
        </div>
        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-empty"><h2>What do you need to do?</h2><p>Write your prompt. <strong>Analyse</strong> shows how complete it is and which model fits; <strong>Send</strong> gets the answer.</p></div>
          ) : messages.map((message, index) => (
            <Bubble key={message.id} message={message} last={index === messages.length - 1} busy={busy} onRetry={retry} onShowAnalysis={showAnalysis}
              fallback={assessor && message.model !== assessor.model ? { label: assessor.model ?? assessor.label, onUse: retryWithAssessor } : undefined} />
          ))}
          {current && !busy && pending?.analysisId !== current.analysisId && current.answers.some(item => item.status === 'complete') && (
            <div className="chat-message theirs"><SolvedButton models={modelsLine(current)} disabled={savingOutcome} onAnswer={outcome => answerOutcome(current, outcome)} /></div>
          )}
          <div ref={end} />
        </div>
        {(error || listError) && <p className="error-banner" role="alert">{error || listError}</p>}
        {pending && (
          <OutcomeCard title={pending.title} models={modelsLine(pending)} disabled={savingOutcome} onAnswer={(outcome, reason) => answerOutcome(pending, outcome, reason)} />
        )}
        <section ref={composer} className="chat-composer composer" data-analysis-id={draftAnalysis?.analysis.id ?? ''} data-session-id={chatId ?? ''}>
          <PromptCoachBubble analysis={draftAnalysis?.analysis} analysisId={draftAnalysis?.analysis.id} task={draft}
            disabled={locked} onTaskChange={setDraft} onAnalyse={analyse}>
            <textarea aria-label="Message" placeholder="Message AdaptAI…" value={draft} maxLength={MAX_CHARS}
              onChange={event => setDraft(event.target.value)} onKeyDown={onKey} rows={3} data-chat-input="" data-task-input="" disabled={busy} />
          </PromptCoachBubble>
          <div className="composer-footer">
            <ModelPicker options={options} value={model} autoId={autoId} loading={modelsLoading} disabled={locked} statuses={statuses} onChange={value => { setModel(value); setRouterModel(null) }} onConfigure={onConfigureModels} />
            {usesRouter && <OpenRouterModelPicker value={routerValue} disabled={locked} configurationId={selected?.source === 'personal' ? selected.id : undefined} onChange={value => setRouterModel(value)} />}
            <div className="composer-actions">
              <span>{draft.length}/{MAX_CHARS}</span>
              {/* Names the recommended model (ADR-014) and reopens this draft's analysis after the panel was closed with ×. */}
              {draftAnalysis && draftAnalysis.text === draft && (
                <button type="button" className="chat-recommendation" title="Show analysis" data-recommended-model="" data-analysis-open=""
                  onClick={() => { setShown(draftAnalysis.analysis); setShownFromHistory(false); setDrawer(true) }}>
                  Recommended: <strong>{candidateLabel(draftAnalysis.analysis.recommendation)}</strong>
                  {useRecommended?.state === 'selected' ? ' · selected' : ''}
                </button>
              )}
              {draftAnalysis && draftAnalysis.text === draft && useRecommended?.state === 'available' && (
                <button type="button" className="chat-link" onClick={useRecommended.onUse} data-use-recommended="">Use</button>
              )}
              <Button variant="secondary" onClick={analyse} disabled={locked || !draft.trim() || modelsLoading || !selected} data-analyse-button="">
                {analysing ? 'Analysing…' : 'Analyse'}
              </Button>
              {busy
                ? <Button variant="secondary" onClick={stop} data-chat-stop="">Stop</Button>
                : <Button onClick={send} disabled={analysing || !draft.trim() || modelsLoading || !selected || (usesRouter && !routerValue)} title={usesRouter && !routerValue ? 'Choose an OpenRouter model first' : undefined} data-chat-send="">Send</Button>}
            </div>
          </div>
        </section>
        {assessor
          ? (assessor.external || selected?.external) && <p className="processing-notice" data-processing-notice="">Selecting <strong>Analyse</strong> sends your text to <strong>{assessor.provider}</strong> (the project's assessor); <strong>Send</strong> sends it to <strong>{selected?.provider}</strong>. Messages are saved in this chat until you delete it.</p>
          : selected?.external && <p className="processing-notice">Selecting <strong>Analyse</strong> or <strong>Send</strong> sends your text to <strong>{selected.provider}</strong>. Messages are saved in this chat until you delete it.</p>}
      </section>
      <div className="sheet-slot">
        <AnalysisDrawer open={drawer} onClose={() => setDrawer(false)} error={analysisError || undefined} useRecommended={recommendedFor(shown)} useSuggestion={recommendedFor(shown, 'suggestion')} analysis={shown} task={draftAnalysis && shown && draftAnalysis.analysis.id === shown.id ? draft : undefined} loading={analysing} stale={stale} fromHistory={shownFromHistory}
          onSend={sendable && !busy && !analysing ? () => { setDrawer(false); void send() } : undefined} />
      </div>
    </main>
  )
}

export type OpenTask = { analysisId: string; title: string; answers: ChatMessage[]; recommended?: ChatMessage['recommended'] }
export type TaskState = { open: OpenTask | null; pending: OpenTask | null }

/** "You used X · Recommended Y": what the feedback is about. */
function modelsLine(task: OpenTask) {
  const used = [...task.answers].reverse().find(item => item.status === 'complete' && item.model)
  const models = new Set(task.answers.filter(item => item.model).map(item => item.model))
  const usedText = used ? `You used ${used.model}${models.size > 1 ? ` (and ${models.size - 1} other)` : ''}` : 'Model used unknown'
  const best = task.recommended
  const bestText = !best?.name ? '' : best.illustrative ? ` · Recommended: ${best.name} (illustrative, not a real model)` : ` · Recommended: ${best.name}`
  return usedText + bestText
}

/** The task still open in a chat: the last analysed message without feedback, and its answers. */
function openTask(messages: ChatMessage[]): OpenTask | null {
  let index = -1
  messages.forEach((item, position) => { if (item.role === 'user' && item.analysis_id) index = position })
  const question = messages[index]
  if (!question || !question.analysis_id || question.outcome) return null
  const rest = messages.slice(index + 1)
  return { analysisId: question.analysis_id, title: titleFrom(question.content), answers: rest.filter(item => item.role === 'assistant'), recommended: question.recommended ?? null }
}

function titleFrom(text: string) {
  const line = text.split(/\s+/).join(' ')
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`
}

function placeholder(id: string): ChatMessage {
  return { id, role: 'assistant', content: '', provider: null, model: null, analysis_id: null, status: 'complete', error: null, created_at: '', completeness: null }
}
