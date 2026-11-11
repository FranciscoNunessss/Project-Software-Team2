import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, ApiError, candidateLabel, deleteChat, getFeatures, listChats, PROFILE_VERSION, notifyProgressChange, type Analysis, type Candidate, type ChatSummary, type LLMOption, type LLMOptions, type SavedSession, type Resume } from './api'
import { Account, type AccountInfo } from './Account'
import { PagePanel } from './PagePanel'
import { AnalysisChanges } from './AnalysisChanges'

import { ProgressScreen } from './Progress'
import { ProfileScreen } from './Profile'
import { LLMConfigScreen } from './LLMConfig'
import { ModelPicker } from './ModelPicker'
import { OpenRouterModelPicker } from './OpenRouterModelPicker'
import { TipsCard } from './TipsCard'
import { PromptCoachTips } from './PromptCoachTips'
import { PromptCoachBubble } from './PromptCoachBubble'
import { ChatScreen, type OpenTask, type TaskState } from './ChatScreen'
import { Icon, ProfileCard, RecommendationCard } from './AnalysisResult'
import { Button, Card } from './ui'
import { AssistantOutcome } from './TaskOutcome'
import { Sidebar, type Screen } from './Sidebar'
import './App.css'

type ResultState = 'empty' | 'loading' | 'result'

function EmptyResult() {
  return (
    <div className="empty-result">
      <span className="empty-icon"><Icon name="spark" size={20} /></span>
      <h2>Your recommendation will appear here</h2>
      <p>Describe an outcome, the context available, and what happens if the answer is wrong.</p>
    </div>
  )
}

function LoadingResult() {
  return (
    <div className="result-grid" aria-live="polite" aria-busy="true">
      {[1, 2, 3].map((card) => (
        <div className="card skeleton-card" key={card}>
          <div className="skeleton short" />
          <div className="skeleton title" />
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton medium" />
        </div>
      ))}
      <p className="loading-label"><span className="spinner" />Assessing complexity, risk and context…</p>
    </div>
  )
}

function Override({
  selected,
  recommended,
  onChange,
  candidates,
  disabled,
}: {
  selected: string
  recommended: string
  onChange: (id: string) => void
  candidates: Candidate[]
  disabled: boolean
}) {
  const applied = selected !== recommended
  const chosen = candidates.find(item => item.id === selected)
  return (
    <div className={`override ${applied ? 'override-applied' : ''}`}>
      <div className="override-copy">
        <div className="override-title">
          <h2>Override</h2>
          {applied && <span className="applied-badge"><Icon name="check" size={13} />Applied</span>}
        </div>
        <p>You always choose. Confirmed selections are saved to your account.</p>
      </div>
      <div className="segments" role="group" aria-label="Choose a model">
        {candidates.map((item) => (
          <button
            key={item.id}
            disabled={disabled}
            className={selected === item.id ? 'selected' : ''}
            onClick={() => onChange(item.id)}
            aria-pressed={selected === item.id}
          >
            {candidateLabel(item)}
          </button>
        ))}
      </div>
      {applied && chosen && <p className="override-message">Your choice is set to {candidateLabel(chosen)}. The recommendation remains visible for comparison.</p>}
    </div>
  )
}

const staleAnalysisErrors = new Set(['previous_analysis_incompatible', 'previous_analysis_other_session', 'analysis_not_found'])

function AssistantScreen({ resume, onConfigureModels }: { resume: Resume | null; onConfigureModels: () => void }) {
  const [session, setSession] = useState<SavedSession>()
  const [sessionId, setSessionId] = useState('')
  const [context, setContext] = useState('')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [task, setTask] = useState('')
  const [state, setState] = useState<ResultState>('empty')
  const [choice, setChoice] = useState('')
  const [analysis, setAnalysis] = useState<Analysis>()
  // True when the shown analysis was opened from history, which never stores tips.
  const [fromHistory, setFromHistory] = useState(false)
  // Survives edits to the task text; cleared only by New task or a session change.
  const [lastAnalysisId, setLastAnalysisId] = useState<string>()
  const [providers, setProviders] = useState<LLMOption[]>([])
  const [autoId, setAutoId] = useState<string|null>(null)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [provider, setProvider] = useState('auto')
  // OpenRouter only: the exact catalogue id chosen by the user; null keeps the configured model.
  const [routerModel, setRouterModel] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!resume) return
    const controller = new AbortController()
    setHistoryBusy(true)
    api<SavedSession>(`sessions/${resume.sessionId}`, undefined, controller.signal).then(saved => {
      setSession(saved); setSessionId(saved.id); setContext(''); setLastAnalysisId(resume.analysis?.result.profile_version === PROFILE_VERSION ? resume.analysis.result.id : undefined)
      if (resume.analysis) {
        const item = resume.analysis
        setTask(item.conversation?.task??'');setContext(item.conversation?.task_context??'');setAnalysis(item.conversation?.response??item.result); setFromHistory(!item.conversation); setState('result')
        setProvider('auto')
        const candidates = [item.result.recommendation, ...item.result.alternatives]
        setChoice((candidates.find(candidate => candidate.id === item.candidate_id) ?? item.result.recommendation).id)
        setSaved(item.candidate_id !== null)
      } else { setTask('') }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not open saved session') })
      .finally(() => { if (!controller.signal.aborted) setHistoryBusy(false) })
    return () => controller.abort()
  }, [resume])
  const newTask = () => {
    setSession(undefined); setSessionId(''); setContext(''); setTask(''); setLastAnalysisId(undefined)
    setAnalysis(undefined); setState('empty'); setSaved(false); setError('')
  }
  useEffect(() => {
    const controller = new AbortController()
    api<LLMOptions>('llm-options', undefined, controller.signal).then(result => {
      setProviders(result.options);setAutoId(result.auto_configuration_id)
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load models. Check LLM config or refresh.') })
      .finally(() => {if (!controller.signal.aborted) setModelsLoading(false)})
    return () => { controller.abort(); active.current?.abort() }
  }, [])

  const analyse = async () => {
    if (!task.trim()) return
    const controller = new AbortController()
    active.current?.abort()
    active.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 45000)
    setState('loading'); setAnalysis(undefined); setError(''); setSaved(false)
    try {
      const result = await api<Analysis>('analyze', {
        task, provider: 'auto', configuration_id: provider === 'auto' ? undefined : provider,
        expected_configuration_id: selectedProvider?.id, expected_provider: selectedProvider?.provider,
        expected_model: (usesRouter ? routerValue : selectedProvider?.model) ?? undefined,
        model: usesRouter ? routerValue : undefined,
        task_context: context, session_id: sessionId || undefined,
        previous_analysis_id: sessionId && lastAnalysisId ? lastAnalysisId : undefined, allow_external: requiresConsent, required_capabilities: ['text'],
      }, controller.signal)
      if (active.current !== controller) return
      setAnalysis(result);setFromHistory(false);setSessionId(result.session_id);setLastAnalysisId(result.id);setChoice(result.recommendation.id);setState('result');notifyProgressChange()
    } catch (failure) {
      if (active.current !== controller) return
      // A stale previous analysis cannot be compared; drop it so the user's next try starts fresh.
      if (failure instanceof ApiError && staleAnalysisErrors.has(failure.detail ?? '')) setLastAnalysisId(undefined)
      setError(controller.signal.aborted ? 'Analysis cancelled or timed out. Please retry.' : failure instanceof Error ? failure.message : 'Analysis failed')
      setState('empty')
    } finally { window.clearTimeout(timeout) }
  }
  // Any edit (typed or applied from the Prompt Coach) makes the shown analysis stale.
  const editTask = (value: string) => {
    setTask(value)
    setState('empty'); setAnalysis(undefined); setSaved(false)
  }
  const candidates = analysis ? [analysis.recommendation, ...analysis.alternatives] : []
  const selectedProvider = providers.find(item => item.id === (provider === 'auto' ? autoId : provider))
  const requiresConsent = selectedProvider?.external === true
  const usesRouter = selectedProvider?.provider === 'openrouter'
  // The exact id sent to the backend: the one picked from the catalogue, else the configured model.
  const routerValue = routerModel ?? selectedProvider?.model ?? ''
  const confirm = async () => {
    const selected = candidates.find(candidate => candidate.id === choice)
    if (!analysis || !selected) return
    setSaving(true); setError('')
    try {
      await api('decisions', { analysis_id: analysis.id, candidate_id: selected.id })
      setSaved(true);notifyProgressChange()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Selection failed') }
    finally { setSaving(false) }
  }

  return (
    <main className="page assistant-page">
      <div className="intro">
        <div>
          <p className="eyebrow">AI model guidance</p>
          <h1>Choose capability with confidence.</h1>
          <p>Describe what you need to do. We’ll assess the task and explain the right level of AI—without choosing for you.</p>
        </div>
        <span className="step-label">Research prototype</span>
      </div>

      {sessionId && <div className="active-session"><span>Saved automatically in My progress{session ? ` · ${session.title}` : ''}</span><Button variant="secondary" disabled={state === 'loading' || saving || historyBusy} onClick={newTask}>New task</Button></div>}
      {historyBusy && <p role="status">Opening your saved work…</p>}
      <section className="composer" aria-labelledby="task-label" data-analysis-id={lastAnalysisId ?? ""} data-session-id={sessionId ?? ""}>
        <label id="task-label" htmlFor="task">Describe your task</label>
        <PromptCoachBubble analysis={analysis} analysisId={lastAnalysisId} task={task}
          disabled={state === 'loading' || saving || historyBusy} onTaskChange={editTask} onAnalyse={analyse}>
          <textarea
            id="task"
            data-task-input
            value={task}
            maxLength={8000}
            disabled={state === 'loading' || saving}
            onChange={(event) => editTask(event.target.value)}
            placeholder="Describe what you need to do…"
          />
        </PromptCoachBubble>

        <div className="composer-footer">
          <ModelPicker options={providers} value={provider} autoId={autoId} loading={modelsLoading} disabled={state === 'loading' || saving || historyBusy} onChange={value => {setProvider(value);setRouterModel(null);setAnalysis(undefined);setState('empty');setSaved(false)}} onConfigure={onConfigureModels} />
          {usesRouter && <OpenRouterModelPicker value={routerValue} disabled={state === 'loading' || saving || historyBusy} onChange={value => {setRouterModel(value);setAnalysis(undefined);setState('empty');setSaved(false)}} />}
          <div className="composer-actions">
            <Button data-analyse-button="" onClick={analyse} disabled={state === 'loading' || saving || historyBusy || modelsLoading || !selectedProvider || !task.trim()}>
              {state === 'loading' ? 'Analysing…' : 'Analyse'} <Icon name="arrow" size={17} />
            </Button>
          </div>
        </div>
        <p className="composer-meta muted">Text only · {task.length}/8,000 characters</p>
      </section>
      {requiresConsent && <p className="processing-notice assistant-processing-notice">Selecting <strong>Analyse</strong> sends this task and memory enabled in Profile to <strong>{selectedProvider?.provider}</strong>. Task text is saved only with your conversation-storage permission in Profile.</p>}

      {error && <p className="api-error" role="alert">{error}</p>}
      {state === 'empty' && <EmptyResult />}
      {state === 'loading' && <LoadingResult />}
      {state === 'result' && analysis && (
        <>
          <div className="results-heading">
            <h2>{analysis.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation'}</h2>
            <span>{analysis.mode} · {analysis.provider} · {analysis.latency_ms} ms</span>
          </div>
          {analysis.clarification_questions.length > 0 && (
            <Card className="assessment-advice">
              <h3>Clarification suggested</h3>
              <p>Add the relevant details to your task above and analyse it again. You can still choose one of the models.</p>
              <ul>{analysis.clarification_questions.map(question => <li key={question}>{question}</li>)}</ul>
            </Card>
          )}
          {analysis.guidance.length > 0 && (
            <Card className="assessment-advice">
              <h3>Assessment guidance</h3>
              <ul>{analysis.guidance.map(item => <li key={item}>{item}</li>)}</ul>
            </Card>
          )}
          <AnalysisChanges analysis={analysis} />
          <div className="result-grid">
            <ProfileCard analysis={analysis} />
            <RecommendationCard analysis={analysis} />
            <TipsCard analysis={analysis} fromHistory={fromHistory} />
          </div>
          <PromptCoachTips analysis={analysis} task={task} />
          <Override
            selected={choice}
            recommended={analysis.recommendation.id}
            onChange={setChoice}
            candidates={candidates}
            disabled={saving || saved}
          />
          <div className="choice-confirmation"><p>Choose a model above, then confirm it to update your progress. Analysing alone does not record a model choice.</p><Button onClick={confirm} disabled={saving || saved}>{saved ? 'Choice saved to My progress' : saving ? 'Saving…' : 'Confirm choice & update progress'}</Button></div>
          {saved && <p role="status">Choice saved to your account. No task execution is performed.</p>}
          {saved && <AssistantOutcome key={analysis.id} analysisId={analysis.id} />}
          {analysis.warnings.map(warning => <p className="confidence-note" key={warning}>{warning}</p>)}
          <p className="privacy">Profile metadata and choices are saved. Task text, context and AI responses are additionally saved only with explicit conversation-storage permission in Profile. Manage and delete saved sessions in My progress.</p>
          <p className="muted">{analysis.confidence_basis} · Profile {analysis.profile_version} · Catalogue {analysis.catalogue_version} · Policy {analysis.policy_version}</p>
          {analysis.assessment_model && <p className="muted">Assessed by {analysis.assessment_model} · {analysis.usage?.total_tokens === undefined ? 'Token usage unavailable' : `${analysis.usage.total_tokens} tokens`}</p>}
        </>
      )}
    </main>
  )
}

export default function App() {
  const [dark, setDark] = useState(() => window.localStorage.getItem('adaptai-theme') === 'dark')
  const toggleTheme = () => {
    setDark((current) => {
      const next = !current
      window.localStorage.setItem('adaptai-theme', next ? 'dark' : 'light')
      return next
    })
  }
  return (
    <div className={dark ? 'app theme-dark' : 'app'}>
      <Account dark={dark} onToggleTheme={toggleTheme}>
        {account => <Shell account={account} dark={dark} onToggleTheme={toggleTheme} />}
      </Account>
    </div>
  )
}

// Everything shown once signed in. Remounted per user by Account.
function Shell({ account, dark, onToggleTheme }: { account: AccountInfo; dark: boolean; onToggleTheme: () => void }) {
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const saved = window.localStorage.getItem('adaptai-screen')
      if (saved === 'assistant' || saved === 'progress' || saved === 'profile' || saved === 'llm') return saved
    } catch { /* Navigation remains available without browser storage. */ }
    return 'assistant'
  })
  const [visited, setVisited] = useState<Set<Screen>>(() => new Set([screen]))
  const scrollPositions = useRef<Partial<Record<Screen, number>>>({})
  const [resume, setResume] = useState<Resume | null>(null)
  // The chat is optional (ADR-011): shown only when the server has the module.
  // null while unknown, so neither screen flashes before /api/features answers.
  const [hasChat, setHasChat] = useState<boolean | null>(null)
  // A saved session that is not a chat (made before the chat existed) opens in the old Assistant.
  const [legacy, setLegacy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    getFeatures(controller.signal).then(features => setHasChat(features.chat === true)).catch(() => { if (!controller.signal.aborted) setHasChat(false) })
    return () => controller.abort()
  }, [])
  useLayoutEffect(() => {
    try { window.localStorage.setItem('adaptai-screen', screen) } catch { /* Storage may be disabled. */ }
    window.scrollTo({ top: scrollPositions.current[screen] ?? 0, behavior: 'instant' })
  }, [screen])

  // Chats: the list lives here so the sidebar shows it on every page.
  // `chat.key` remounts ChatScreen (open another chat, new chat); `chat.id` follows the open chat.
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [chat, setChat] = useState<{ key: string; id: string | null }>({ key: 'new-0', id: null })
  const [chatLocked, setChatLocked] = useState(false)
  // Feedback per task (ADR-014): moving to another chat asks about the task left open, as the
  // chat itself did before the list moved here. The next ChatScreen shows the question.
  const taskState = useRef<TaskState>({ open: null, pending: null })
  const [carriedTask, setCarriedTask] = useState<OpenTask | null>(null)
  const onTaskState = (state: TaskState) => { taskState.current = state; setCarriedTask(state.pending) }
  const carryOpenTask = () => setCarriedTask(taskState.current.open ?? taskState.current.pending)
  const [chatError, setChatError] = useState('')
  const refreshChats = () => listChats().then(setChats).catch(() => setChatError('Could not load your chats.'))
  useEffect(() => { if (hasChat) refreshChats() }, [hasChat]) // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (next: Screen) => {
    if (next === screen) return
    scrollPositions.current[screen] = window.scrollY
    setVisited(current => new Set([...current, next]))
    setScreen(next)
  }
  const openChat = (id: string) => { if (id !== chat.id) carryOpenTask(); setResume(null); setLegacy(false); setChatError(''); setChat({ key: id, id }); navigate('assistant') }
  const newChat = () => { carryOpenTask(); setResume(null); setLegacy(false); setChatError(''); setChat({ key: `new-${Date.now()}`, id: null }); navigate('assistant') }
  const removeChat = async (id: string) => {
    try { await deleteChat(id) } catch { setChatError('Could not delete the chat.'); return }
    if (id === chat.id) newChat()
    refreshChats()
  }
  const chatActive = screen === 'assistant' && hasChat === true && !legacy

  return (
    <>
      <Sidebar screen={screen} onNavigate={navigate} dark={dark} onToggleTheme={onToggleTheme} account={account}
        chats={hasChat ? { list: chats, activeId: chat.id, locked: chatLocked, onOpen: openChat, onNew: newChat, onDelete: id => void removeChat(id) } : undefined} />
      <div className="app-main">
        {/* With the chat module (ADR-011) the Assistant is the chat, with the analysis in a side panel. */}
        {visited.has('assistant') && <PagePanel active={screen === 'assistant'}>
        {hasChat === true && !legacy && <ChatScreen key={chat.key} initialChatId={chat.id ?? undefined} title={chats.find(item => item.id === chat.id)?.title}
          error={chatError} onChatCreated={id => setChat(current => ({ ...current, id }))} onChatsChanged={refreshChats} onBusyChange={setChatLocked}
          carriedTask={carriedTask} onTaskState={onTaskState}
          onNotAChat={() => setLegacy(true)} onConfigureModels={() => navigate('llm')} />}
        {(hasChat === false || legacy) && <AssistantScreen resume={resume} onConfigureModels={() => navigate('llm')} />}
        </PagePanel>}
        {visited.has('progress') && <PagePanel active={screen === 'progress'}><ProgressScreen onResume={saved => {
          setResume(saved); setLegacy(false)
          if (hasChat) setChat({ key: saved.sessionId, id: saved.sessionId })
          navigate('assistant')
        }} /></PagePanel>}
        {visited.has('profile') && <PagePanel active={screen === 'profile'}><ProfileScreen /></PagePanel>}
        {visited.has('llm') && <PagePanel active={screen === 'llm'}><LLMConfigScreen /></PagePanel>}
        {/* The chat fills the window and scrolls only its conversation, so it has no footer. */}
        {!chatActive && <footer><span>AdaptAI</span><p>Clearer choices. Better AI judgement.</p><button>Privacy</button><button>How it works</button></footer>}
      </div>
    </>
  )
}
