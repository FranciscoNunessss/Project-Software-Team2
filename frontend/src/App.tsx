import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, tierOf, notifyProgressChange, type Analysis, type LLMOption, type LLMOptions, type Tier, type SavedSession, type Resume } from './api'
import { Account } from './Account'
import { AnalysisChanges } from './AnalysisChanges'

import { ProgressScreen } from './Progress'
import { ProfileScreen } from './Profile'
import { LLMConfigScreen } from './LLMConfig'
import { ModelPicker } from './ModelPicker'

type Screen = 'assistant' | 'progress' | 'profile' | 'llm'
type ResultState = 'empty' | 'loading' | 'result'

function Icon({
  name,
  size = 18,
}: {
  name: 'spark' | 'upload' | 'arrow' | 'check' | 'info' | 'book' | 'download' | 'trash' | 'eye' | 'users'
  size?: number
}) {
  const paths: Record<typeof name, ReactNode> = {
    spark: <path d="M12 2l1.35 4.65L18 8l-4.65 1.35L12 14l-1.35-4.65L6 8l4.65-1.35L12 2ZM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z" />,
    upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 15v4h14v-4" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" /></>,
    download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5" /><path d="M4 19h16" /></>,
    trash: <><path d="M4 7h16M9 3h6l1 4H8l1-4Zm-2 4 1 14h8l1-14M10 11v6m4-6v6" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="4" /><path d="M16 4.5a4 4 0 0 1 0 7.5m2 2.5a4 4 0 0 1 4 4V20" /></>,
  }
  const filled = name === 'spark'
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

function Button({
  children,
  variant = 'primary',
  onClick,
  disabled,
  className = '',
  ariaLabel,
  dataAnalyseButton,
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  onClick?: () => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
  dataAnalyseButton?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-analyse-button={dataAnalyseButton ? '' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`button button-${variant} ${className}`}
    >
      {children}
    </button>
  )
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

function Header({
  screen,
  onNavigate,
  dark,
  onToggleTheme,
}: {
  screen: Screen
  onNavigate: (screen: Screen) => void
  dark: boolean
  onToggleTheme: () => void
}) {
  const [online, setOnline] = useState<boolean | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api('health', undefined, controller.signal).then(() => setOnline(true))
      .catch(() => { if (!controller.signal.aborted) setOnline(false) })
    return () => controller.abort()
  }, [])
  return (
    <header className="topbar">
      <div className="nav-shell">
        <button className="brand" onClick={() => onNavigate('assistant')} aria-label="AdaptAI home">
          <span className="brand-mark"><Icon name="spark" size={16} /></span>
          <span>AdaptAI</span>
        </button>
        <nav aria-label="Main navigation" className="main-nav">
          <button className={screen === 'assistant' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate('assistant')}>
            Assistant
          </button>
          <button className={screen === 'progress' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate('progress')}>
            My progress
          </button>
          <button className={screen === 'profile' ? 'nav-item active secondary-nav' : 'nav-item secondary-nav'} onClick={() => onNavigate('profile')}>
            Profile
          </button>
          <button className={screen === 'llm' ? 'nav-item active' : 'nav-item'} onClick={() => onNavigate('llm')}>LLM config</button>
        </nav>
        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
          aria-pressed={dark}
        >
          <span className="theme-toggle-icon" aria-hidden="true" />
          <span>{dark ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <span className={`status ${online === false ? 'degraded' : ''}`} role="status">
          <span className="status-dot" />
          {online === null ? 'Checking API' : online ? 'API online' : 'API unavailable'}
        </span>
      </div>
    </header>
  )
}

function ProfileCard({ analysis }: { analysis: Analysis }) {
  const profile = [
    { label: 'Reasoning depth', value: analysis.profile.reasoning },
    { label: 'Context demand', value: analysis.profile.context },
    { label: 'Ambiguity', value: analysis.profile.ambiguity },
    { label: 'Domain specificity', value: analysis.profile.domain },
    { label: 'Risk of error', value: analysis.profile.risk },
    { label: 'Tool / integration need', value: analysis.profile.tools },
  ]
  return (
    <Card className="profile-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Task analysis</p>
          <h2>Complexity profile</h2>
        </div>
        <span className="confidence confidence-low">
          {analysis.mode === 'demonstration' ? 'Heuristic demo' : 'Uncalibrated'}
        </span>
      </div>
      <div className="profile-list">
        {profile.map((item) => (
          <div className="profile-row" key={item.label}>
            <div className="profile-label">
              <span>{item.label}</span>
              <span className="info-tip" tabIndex={0} aria-label={`${item.label}: ${item.value.evidence}`}>
                <Icon name="info" size={14} />
                <span role="tooltip">{item.value.evidence}</span>
              </span>
            </div>
            {item.value.score === null ? <span className="muted">Not determined</span> : (
              <div className="bar-track" role="meter" aria-label={item.label} aria-valuemin={1} aria-valuemax={3} aria-valuenow={item.value.score} aria-valuetext={['Low', 'Medium', 'High'][item.value.score - 1]}>
                <span className="bar-fill" style={{ width: `${item.value.score / 3 * 100}%` }} />
              </div>
            )}
            <p className="muted">{item.value.score === null ? '' : `${['Low', 'Medium', 'High'][item.value.score - 1]} · `}Confidence: {item.value.confidence}</p>
            <p className="muted">{item.value.evidence}</p>
          </div>
        ))}
      </div>
      <p className="confidence-note">{analysis.profile.explanation}</p>
      <div className="profile-row">
        <strong>Required modalities</strong>
        <span>{analysis.profile.modality.required?.join(', ') ?? 'Not determined'}</span>
        <p className="muted">Confidence: {analysis.profile.modality.confidence}</p>
        <p className="muted">{analysis.profile.modality.evidence}</p>
      </div>
      <p className="muted">Scale: 1 low · 2 medium · 3 high. Modality describes execution requirements; this form accepts text only.</p>
      <p className="muted">Confidence labels are qualitative and uncalibrated.</p>
    </Card>
  )
}

function TierCard({ analysis }: { analysis: Analysis }) {
  const tier = tierOf(analysis.recommendation)
  return (
    <Card className="tier-card">
      <p className="eyebrow">Recommended tier</p>
      <div className="tier-title-row">
        <div className="tier-orb"><span>{tier.slice(0, 1)}</span></div>
        <div>
          <h2>{tier}</h2>
          <p className="muted">{analysis.recommendation.name}</p>
        </div>
      </div>
      <div className="cost-row">
        <span>Observed cost</span><strong>Unavailable</strong>
      </div>
      <div className="why">
        <h3>Why this tier</h3>
        <p>{analysis.rationale}</p>
        <p className="muted">Capabilities: {analysis.recommendation.capabilities.join(', ')}</p>
      </div>
    </Card>
  )
}

function TipsCard() {
  const tips = [
    ['Frame the outcome', 'State the result you need and how it will be used.'],
    ['Add useful context', 'Describe constraints, audience and the impact of an error.'],
    ['Review with intent', 'Compare eligible options; these prototype tiers are illustrative.'],
  ]
  return (
    <Card className="tips-card">
      <p className="eyebrow">Practical guidance</p>
      <h2>How to use it</h2>
      <div className="tips-list">
        {tips.map(([title, text], index) => (
          <div className="tip" key={title}>
            <span className="tip-number">0{index + 1}</span>
            <div><h3>{title}</h3><p>{text}</p></div>
          </div>
        ))}
      </div>
    </Card>
  )
}

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
  tier,
  recommended,
  onChange,
  eligible,
  disabled,
}: {
  tier: Tier
  recommended: Tier
  onChange: (tier: Tier) => void
  eligible: Tier[]
  disabled: boolean
}) {
  const applied = tier !== recommended
  return (
    <div className={`override ${applied ? 'override-applied' : ''}`}>
      <div className="override-copy">
        <div className="override-title">
          <h2>Override</h2>
          {applied && <span className="applied-badge"><Icon name="check" size={13} />Applied</span>}
        </div>
        <p>You always choose. Confirmed selections are saved to your account.</p>
      </div>
      <div className="segments" role="group" aria-label="Choose a model tier">
        {(['Small', 'Medium', 'Large'] as Tier[]).map((item) => (
          <button
            key={item}
            disabled={disabled || !eligible.includes(item)}
            className={tier === item ? 'selected' : ''}
            onClick={() => onChange(item)}
            aria-pressed={tier === item}
          >
            {item}
          </button>
        ))}
      </div>
      {applied && <p className="override-message">Your choice is set to {tier}. The recommendation remains visible for comparison.</p>}
    </div>
  )
}

function AssistantScreen({ resume, onConfigureModels }: { resume: Resume | null; onConfigureModels: () => void }) {
  const [session, setSession] = useState<SavedSession>()
  const [sessionId, setSessionId] = useState('')
  const [context, setContext] = useState('')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [task, setTask] = useState('')
  const [state, setState] = useState<ResultState>('empty')
  const [tier, setTier] = useState<Tier>('Large')
  const [analysis, setAnalysis] = useState<Analysis>()
  // Survives edits to the task text; cleared only by New task or a session change.
  const [lastAnalysisId, setLastAnalysisId] = useState<string>()
  const [providers, setProviders] = useState<LLMOption[]>([])
  const [autoId, setAutoId] = useState<string|null>(null)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [provider, setProvider] = useState('auto')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!resume) return
    const controller = new AbortController()
    setHistoryBusy(true)
    api<SavedSession>(`sessions/${resume.sessionId}`, undefined, controller.signal).then(saved => {
      setSession(saved); setSessionId(saved.id); setContext(''); setLastAnalysisId(resume.analysis?.result.id)
      if (resume.analysis) {
        const item = resume.analysis
        setTask(item.conversation?.task??'');setContext(item.conversation?.task_context??'');setAnalysis(item.conversation?.response??item.result); setState('result')
        setProvider('auto')
        const candidates = [item.result.recommendation, ...item.result.alternatives]
        setTier(tierOf(candidates.find(candidate => candidate.id === item.candidate_id) ?? item.result.recommendation))
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
        expected_model: selectedProvider?.model ?? undefined,
        task_context: context, session_id: sessionId || undefined,
        previous_analysis_id: sessionId && lastAnalysisId ? lastAnalysisId : undefined, allow_external: requiresConsent, required_capabilities: ['text'],
      }, controller.signal)
      if (active.current !== controller) return
      setAnalysis(result);setSessionId(result.session_id);setLastAnalysisId(result.id);setTier(tierOf(result.recommendation));setState('result');notifyProgressChange()
    } catch (failure) {
      if (active.current !== controller) return
      setError(controller.signal.aborted ? 'Analysis cancelled or timed out. Please retry.' : failure instanceof Error ? failure.message : 'Analysis failed')
      setState('empty')
    } finally { window.clearTimeout(timeout) }
  }
  const candidates = analysis ? [analysis.recommendation, ...analysis.alternatives] : []
  const selectedProvider = providers.find(item => item.id === (provider === 'auto' ? autoId : provider))
  const requiresConsent = selectedProvider?.external === true
  const confirm = async () => {
    const selected = candidates.find(candidate => tierOf(candidate) === tier)
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
        <textarea
          id="task"
          data-task-input
          value={task}
          maxLength={8000}
          disabled={state === 'loading' || saving}
          onChange={(event) => {
            setTask(event.target.value)
            setState('empty'); setAnalysis(undefined); setSaved(false)
          }}
          placeholder="Describe what you need to do…"
        />

        <div className="composer-footer">
          <ModelPicker options={providers} value={provider} autoId={autoId} loading={modelsLoading} disabled={state === 'loading' || saving || historyBusy} onChange={value => {setProvider(value);setAnalysis(undefined);setState('empty');setSaved(false)}} onConfigure={onConfigureModels} />
          <div className="composer-actions">
            <Button dataAnalyseButton onClick={analyse} disabled={state === 'loading' || saving || historyBusy || modelsLoading || !selectedProvider || !task.trim()}>
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
              <p>Add the relevant details to your task above and analyse it again. You can still choose an eligible tier.</p>
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
            <TierCard analysis={analysis} />
            <TipsCard />
          </div>
          <Override
            tier={tier}
            recommended={tierOf(analysis.recommendation)}
            onChange={setTier}
            eligible={candidates.map(tierOf)}
            disabled={saving || saved}
          />
          <div className="choice-confirmation"><p>Choose a tier above, then confirm it to update your progress. Analysing alone does not record a model choice.</p><Button onClick={confirm} disabled={saving || saved}>{saved ? 'Choice saved to My progress' : saving ? 'Saving…' : 'Confirm choice & update progress'}</Button></div>
          {saved && <p role="status">Choice saved to your account. No task execution is performed.</p>}
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
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const saved = window.localStorage.getItem('adaptai-screen')
      if (saved === 'assistant' || saved === 'progress' || saved === 'profile' || saved === 'llm') return saved
    } catch { /* Navigation remains available without browser storage. */ }
    return 'assistant'
  })
  const [resume, setResume] = useState<Resume | null>(null)
  const navigate = (next: Screen) => { setResume(null); setScreen(next) }
  const [dark, setDark] = useState(() => window.localStorage.getItem('adaptai-theme') === 'dark')
  useEffect(() => {
    try { window.localStorage.setItem('adaptai-screen', screen) } catch { /* Storage may be disabled. */ }
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [screen])
  const toggleTheme = () => {
    setDark((current) => {
      const next = !current
      window.localStorage.setItem('adaptai-theme', next ? 'dark' : 'light')
      return next
    })
  }
  return (
    <div className={dark ? 'app theme-dark' : 'app'}>
      <Account dark={dark} onToggleTheme={toggleTheme} header={<Header screen={screen} onNavigate={navigate} dark={dark} onToggleTheme={toggleTheme} />}>
      {screen === 'assistant' && <AssistantScreen resume={resume} onConfigureModels={() => navigate('llm')} />}
      {screen === 'progress' && <ProgressScreen onResume={saved => { setResume(saved); setScreen('assistant') }} />}
      {screen === 'profile' && <ProfileScreen />}
      {screen === 'llm' && <LLMConfigScreen />}
      <footer><span>AdaptAI</span><p>Clearer choices. Better AI judgement.</p><button>Privacy</button><button>How it works</button></footer>
      </Account>
    </div>
  )
}
