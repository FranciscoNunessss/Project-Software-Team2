import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, tierOf, type Analysis, type Provider, type Tier } from './api'

type Screen = 'assistant' | 'progress' | 'team'
type ResultState = 'empty' | 'loading' | 'result'

const sampleTask =
  'Review a 20-page supplier contract, identify unusual liability clauses, and summarise the risks for a non-legal audience.'

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
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  onClick?: () => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
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
          <button className={screen === 'team' ? 'nav-item active secondary-nav' : 'nav-item secondary-nav'} onClick={() => onNavigate('team')}>
            Team view
          </button>
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
              <span className="info-tip" tabIndex={0} aria-label={`${item.label}: ${analysis.profile.explanation}`}>
                <Icon name="info" size={14} />
                <span role="tooltip">{analysis.profile.explanation}</span>
              </span>
            </div>
            <div className="bar-track" role="meter" aria-label={item.label} aria-valuemin={0} aria-valuemax={3} aria-valuenow={item.value}>
              <span className="bar-fill" style={{ width: `${item.value / 3 * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="confidence-note">{analysis.profile.explanation}</p>
      <p className="muted">Scale: 1 low · 2 medium · 3 high. Domain, risk, tools and modality scores are not implemented yet.</p>
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
        <p>You always choose. Selections are not persisted in this increment.</p>
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

function AssistantScreen() {
  const [task, setTask] = useState(sampleTask)
  const [state, setState] = useState<ResultState>('empty')
  const [tier, setTier] = useState<Tier>('Large')
  const [analysis, setAnalysis] = useState<Analysis>()
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState('demo')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api<Provider[]>('providers', undefined, controller.signal).then(items => {
      setProviders(items)
      const configured = items.find(item => item.id === 'groq' && item.enabled)
        ?? items.find(item => item.id !== 'demo' && item.enabled)
      if (configured) setProvider(configured.id)
    })
      .catch(() => { if (!controller.signal.aborted) setError('Cannot reach the backend. Start the API and refresh.') })
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
        task, provider, allow_external: consent, required_capabilities: ['text'],
      }, controller.signal)
      if (active.current !== controller) return
      setAnalysis(result); setTier(tierOf(result.recommendation)); setState('result')
    } catch (failure) {
      if (active.current !== controller) return
      setError(controller.signal.aborted ? 'Analysis cancelled or timed out. Please retry.' : failure instanceof Error ? failure.message : 'Analysis failed')
      setState('empty')
    } finally { window.clearTimeout(timeout) }
  }
  const candidates = analysis ? [analysis.recommendation, ...analysis.alternatives] : []
  const selectedProvider = providers.find(item => item.id === provider)
  const requiresConsent = selectedProvider?.external === true
  const confirm = async () => {
    const selected = candidates.find(candidate => tierOf(candidate) === tier)
    if (!analysis || !selected) return
    setSaving(true); setError('')
    try {
      await api('decisions', { analysis_id: analysis.id, candidate_id: selected.id })
      setSaved(true)
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

      <section className="composer" aria-labelledby="task-label">
        <label id="task-label" htmlFor="task">Describe your task</label>
        <textarea
          id="task"
          value={task}
          maxLength={8000}
          disabled={state === 'loading' || saving}
          onChange={(event) => {
            setTask(event.target.value)
            setState('empty'); setAnalysis(undefined); setSaved(false)
          }}
          placeholder="For example: Compare three CRM proposals and recommend one for a 25-person sales team…"
        />
        <div className="composer-footer">
          <span className="muted">Text only · {task.length}/8,000 characters</span>
          <div className="composer-actions">
            <span>Be specific about the outcome</span>
            <Button onClick={analyse} disabled={state === 'loading' || saving || !task.trim() || (requiresConsent && !consent)}>
              {state === 'loading' ? 'Analysing…' : 'Analyse'} <Icon name="arrow" size={17} />
            </Button>
          </div>
        </div>
        <div className="api-controls">
          <label htmlFor="assessment-provider">Assessment provider</label>
          <select id="assessment-provider" value={provider} disabled={state === 'loading' || saving} onChange={event => {
            setProvider(event.target.value); setConsent(false); setAnalysis(undefined); setState('empty'); setSaved(false)
          }}>
            <option value="demo">Demonstration · local heuristic</option>
            {providers.filter(item => item.id !== 'demo').map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>
              {item.label}{item.enabled ? '' : ' · not configured'}
            </option>)}
          </select>
          {requiresConsent && <label className="consent"><input type="checkbox" checked={consent} disabled={state === 'loading'} onChange={event => setConsent(event.target.checked)} />I allow this task to be sent to {selectedProvider?.label} for assessment.</label>}
          {selectedProvider?.model && <p className="muted">Assessment model: {selectedProvider.model}</p>}
          <p className="muted">{provider === 'demo' ? 'Demo uses word count and provisional values, not semantic AI assessment.' : 'Semantic assessment is uncalibrated. Provider availability depends on server configuration.'}</p>
        </div>
      </section>

      {error && <p className="api-error" role="alert">{error}</p>}
      {state === 'empty' && <EmptyResult />}
      {state === 'loading' && <LoadingResult />}
      {state === 'result' && analysis && (
        <>
          <div className="results-heading">
            <h2>Recommendation</h2>
            <span>{analysis.mode} · {analysis.provider} · {analysis.latency_ms} ms</span>
          </div>
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
          <Button onClick={confirm} disabled={saving || saved}>{saved ? 'Choice acknowledged' : saving ? 'Confirming…' : 'Confirm choice'}</Button>
          {saved && <p role="status">Choice acknowledged for this session. No task execution or persistent learning is performed.</p>}
          {analysis.warnings.map(warning => <p className="confidence-note" key={warning}>{warning}</p>)}
          <p className="privacy">No raw task text is persisted. Choices are acknowledged without permanent storage.</p>
          <p className="muted">{analysis.confidence_basis} · Catalogue {analysis.catalogue_version} · Policy {analysis.policy_version}</p>
          {analysis.assessment_model && <p className="muted">Assessed by {analysis.assessment_model} · {analysis.usage?.total_tokens === undefined ? 'Token usage unavailable' : `${analysis.usage.total_tokens} tokens`}</p>}
        </>
      )}
    </main>
  )
}

function LineChart() {
  return (
    <div className="chart-wrap">
      <div className="chart-y"><span>100%</span><span>75%</span><span>50%</span><span>25%</span></div>
      <svg className="chart" viewBox="0 0 900 220" preserveAspectRatio="none" role="img" aria-label="Match rate increased from 56 percent in session one to 84 percent in session six">
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3a3a3a" stopOpacity=".18" />
            <stop offset="100%" stopColor="#3a3a3a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="grid-lines"><path d="M0 20H900M0 80H900M0 140H900M0 200H900" /></g>
        <path className="chart-area" d="M20 153 C120 147 140 132 195 135 S310 125 370 111 S470 112 545 91 S670 90 720 64 S825 54 880 46 V220 H20Z" />
        <path className="chart-line" d="M20 153 C120 147 140 132 195 135 S310 125 370 111 S470 112 545 91 S670 90 720 64 S825 54 880 46" />
        {[[20,153],[195,135],[370,111],[545,91],[720,64],[880,46]].map(([cx,cy]) => <circle key={cx} cx={cx} cy={cy} r="5" />)}
      </svg>
      <div className="chart-x"><span>Session 1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>Session 6</span></div>
    </div>
  )
}

function ProgressScreen() {
  const patterns = [
    { title: 'Over-provisioning', status: 'Detected', tone: 'attention', text: 'You chose Large for 4 tasks where Medium was recommended.', example: 'Next time try Medium for summarising a short, well-structured report.' },
    { title: 'Under-provisioning', status: 'Not enough data', tone: 'neutral', text: 'We need at least 5 comparable choices to identify a pattern.', example: 'Example: step up when errors carry financial or legal risk.' },
    { title: 'Inflated prompting', status: 'Improving', tone: 'positive', text: 'Your prompts are 18% shorter with the same recommendation quality.', example: 'Keep stating the outcome first, then add only decision-relevant context.' },
  ]
  return (
    <main className="page progress-page">
      <p className="confidence-note" role="note">Design preview · All figures and patterns below are static examples. Progress tracking and data controls are not connected.</p>
      <div className="intro progress-intro">
        <div><p className="eyebrow">My progress</p><h1>Your judgement over time</h1><p>See where your model choices are becoming more precise—without tracking what your tasks were about.</p></div>
        <div className="metric"><strong>84%</strong><span>match rate</span><em>+12% this month</em></div>
      </div>
      <Card className="chart-card">
        <div className="card-heading"><div><h2>Recommendation match</h2><p className="muted">Share of tasks where your chosen tier matched the recommendation</p></div><span className="period">Last 6 sessions</span></div>
        <LineChart />
      </Card>
      <div className="section-heading"><div><p className="eyebrow">Patterns</p><h2>What your choices reveal</h2></div><p>Based on 18 anonymised tier choices</p></div>
      <div className="pattern-grid">
        {patterns.map((pattern) => (
          <Card className="pattern-card" key={pattern.title}>
            <div className="pattern-top"><span className="pattern-icon"><Icon name="spark" size={15} /></span><span className={`pattern-status ${pattern.tone}`}>{pattern.status}</span></div>
            <h3>{pattern.title}</h3><p>{pattern.text}</p>
            <div className="next-time"><strong>Next time try…</strong><span>{pattern.example}</span></div>
          </Card>
        ))}
      </div>
      <div className="lower-grid">
        <section className="lessons">
          <div className="section-heading compact"><div><p className="eyebrow">Learning suggestions</p><h2>Build your model judgement</h2></div></div>
          {[
            ['When “more capable” is just more expensive', 'Learn to spot bounded tasks that smaller models handle well.'],
            ['Context is not the same as complexity', 'Separate how much a model must read from how deeply it must reason.'],
          ].map(([title, copy]) => (
            <Card className="lesson" key={title}>
              <span className="lesson-icon"><Icon name="book" /></span>
              <div><h3>{title}</h3><p>{copy}</p><span className="read-time">2-minute read</span></div>
              <Button variant="secondary">Try it <Icon name="arrow" size={15} /></Button>
            </Card>
          ))}
        </section>
        <Card className="data-card">
          <p className="eyebrow">Privacy controls</p><h2>My data</h2>
          <p>No tier choices or session data are stored in this prototype; persistent progress and data controls are design previews.</p>
          <div className="data-actions">
            <Button variant="secondary"><Icon name="eye" size={16} />See</Button>
            <Button variant="secondary"><Icon name="download" size={16} />Export</Button>
            <Button variant="danger"><Icon name="trash" size={16} />Delete</Button>
          </div>
        </Card>
      </div>
    </main>
  )
}

function TeamScreen() {
  return (
    <main className="page team-page">
      <p className="confidence-note" role="note">Design preview · Team aggregation is not implemented. No group data is being collected.</p>
      <div className="intro">
        <div><p className="eyebrow">Team view</p><h1>Shared judgement, not surveillance.</h1><p>Aggregate signals help your team use AI efficiently. Individual activity and task content are never shown.</p></div>
        <span className="privacy-pill"><Icon name="users" size={16} />Aggregates only</span>
      </div>
      <div className="team-metrics">
        <Card><p>Spend by task type</p><strong>—</strong><span>Awaiting group threshold</span></Card>
        <Card><p>Over-provisioned tasks</p><strong>—%</strong><span>No individual breakdown</span></Card>
        <Card><p>Team judgement trend</p><strong>—</strong><span>Compared across sessions</span></Card>
      </div>
      <Card className="team-empty">
        <span className="empty-people"><Icon name="users" size={26} /></span>
        <h2>Not enough people for an aggregate view</h2>
        <p>The minimum group size has not been reached. Data will appear only when enough people participate to protect individual privacy.</p>
        <div className="threshold"><span><i /><i /><i className="pending" /><i className="pending" /><i className="pending" /></span><strong>Group privacy threshold</strong></div>
      </Card>
      <div className="aggregate-note"><Icon name="info" size={17} /><span><strong>What team leads can see:</strong> grouped task types, tier efficiency, and shared trends. Never names, rankings, prompts, or task history.</span></div>
    </main>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('assistant')
  const [dark, setDark] = useState(() => window.localStorage.getItem('adaptai-theme') === 'dark')
  useEffect(() => {
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
      <Header screen={screen} onNavigate={setScreen} dark={dark} onToggleTheme={toggleTheme} />
      {screen === 'assistant' && <AssistantScreen />}
      {screen === 'progress' && <ProgressScreen />}
      {screen === 'team' && <TeamScreen />}
      <footer><span>AdaptAI</span><p>Clearer choices. Better AI judgement.</p><button>Privacy</button><button>How it works</button></footer>
    </div>
  )
}
