import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { coachAvailable, promptCoach, type Analysis, type CoachMode, type CoachResponse, type DimensionName, type Profile } from './api'
import './PromptCoachBubble.css'

// Optional Prompt Coach module (ADR-009, AA-030). A bubble on the task field: it counts what
// the last analysis left uncertain (no model call), and opens a panel that asks the Coach
// only on click and changes the task only on click. With the Coach switched off it runs the
// local checks only. App.tsx mounts it in one place; removing it leaves the composer intact.

const LABELS: Record<DimensionName, string> = {
  reasoning: 'Reasoning', context: 'Context', ambiguity: 'Ambiguity', domain: 'Domain',
  risk: 'Risk', tools: 'Tools', modality: 'Modality',
}
const SCORED: Exclude<DimensionName, 'modality'>[] = ['reasoning', 'context', 'ambiguity', 'domain', 'risk', 'tools']

type Check = { title: string; detail: string }

export function localChecks(value: string): Check[] {
  if (!value.trim()) return [{ title: 'Describe your task', detail: 'The analysis needs a description of what you want to do.' }]
  const found: Check[] = []
  if (value.trim().split(/\s+/).length < 6) {
    found.push({ title: 'Very short description', detail: 'Say what the result is for and who it is for; a few words rarely determine the task.' })
  }
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) {
    found.push({ title: 'Email address in the task', detail: 'The task is sent to a model. Replace personal data with a placeholder such as [email].' })
  }
  if (/(?:\+?\d[\s-]?){9,}/.test(value)) {
    found.push({ title: 'Phone or ID number in the task', detail: 'Replace personal numbers with a placeholder before analysing.' })
  }
  return found
}

// Mirrors select_targets in backend/app/prompt_coach.py (priority order, at most 4), so the
// bubble counts what the Coach would work on without sending the task anywhere.
export function uncertainDimensions(profile: Profile): DimensionName[] {
  const found: [number, number, DimensionName][] = []
  SCORED.forEach((name, order) => {
    const { score, confidence } = profile[name]
    const unknown = score === null
    let rank: number
    if (name === 'ambiguity' && (unknown || score === 2 || score === 3 || confidence === 'low')) rank = 0
    else if (unknown || confidence === 'undetermined') rank = 1
    else if (confidence === 'low') rank = 2
    else return
    found.push([rank, order, name])
  })
  if (profile.modality.required === null) found.push([1, SCORED.length, 'modality'])
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return found.slice(0, 4).map(entry => entry[2])
}

// Word diff for the rewrite preview; [placeholders] are for the user to fill in.
function diffWords(before: string, after: string): ReactNode[] {
  // A [placeholder] is one token, so it is marked whole even when it contains spaces.
  const tokens = (text: string) => text.split(/(\[[^\]]+\]|\s+)/).filter(Boolean)
  const a = tokens(before)
  const b = tokens(after)
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: ReactNode[] = []
  const word = (text: string, key: number, kind: 'same' | 'ins' | 'del') => {
    const parts = text.split(/(\[[^\]]+\])/).map((part, index) =>
      /^\[[^\]]+\]$/.test(part) ? <mark key={index}>{part}</mark> : part)
    if (kind === 'ins') return <ins key={key}>{parts}</ins>
    if (kind === 'del') return <del key={key}>{parts}</del>
    return <span key={key}>{parts}</span>
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(word(a[i], out.length, 'same')); i++; j++ }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push(word(a[i++], out.length, 'del'))
    else out.push(word(b[j++], out.length, 'ins'))
  }
  while (i < a.length) out.push(word(a[i++], out.length, 'del'))
  while (j < b.length) out.push(word(b[j++], out.length, 'ins'))
  return out
}

// What the Coach works on: the last analysis and the exact text it was made from. Kept
// here because the app clears the shown analysis as soon as the text is edited.
type Base = { id: string; profile: Profile; provider: string; model: string | null; text: string }

export function PromptCoachBubble({ analysis, analysisId, task, disabled, onTaskChange, onAnalyse, children }: {
  analysis?: Analysis
  analysisId?: string
  task: string
  disabled: boolean
  onTaskChange: (value: string) => void
  onAnalyse: () => void
  // The task field: the bubble sits on it and the panel floats above it (below if no room).
  children: ReactNode
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [base, setBase] = useState<Base | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CoachResponse | null>(null)
  const [view, setView] = useState<'list' | 'rewrite'>('list')
  // Answers are keyed by suggestion, not by position, so ignoring one card keeps the others' text.
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [applied, setApplied] = useState(false)
  // The text the current suggestions apply to: the task sent to the Coach, then the result of
  // each change made from the panel. Any other edit makes the suggestions stale.
  const resultText = useRef<string | null>(null)
  const active = useRef<AbortController | null>(null)

  useEffect(() => {
    const changed = (event: Event) => {
      setEnabled((event as CustomEvent<{ enabled: boolean }>).detail.enabled)
      active.current?.abort(); setBusy(false); setOpen(false); setResult(null)
    }
    window.addEventListener('adaptai-coach-settings-updated', changed)
    return () => window.removeEventListener('adaptai-coach-settings-updated', changed)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    coachAvailable(controller.signal)
      .then(available => { if (!controller.signal.aborted) setEnabled(available) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(false) })
    return () => controller.abort()
  }, [])

  // A new analysis replaces the base and any earlier Coach result. An analysis reopened from
  // history without its saved text cannot be coached (the Coach needs the analysed text).
  useEffect(() => {
    if (!analysis) return
    active.current?.abort()
    setBase(task.trim() ? { id: analysis.id, profile: analysis.profile, provider: analysis.provider, model: analysis.assessment_model, text: task } : null)
    setResult(null); setView('list'); setError(''); setAnswers({}); setApplied(false); setBusy(false); resultText.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the analysis changes
  }, [analysis?.id])

  // New task (or a session change) clears the base.
  useEffect(() => { if (!analysisId) { setBase(null); setResult(null) } }, [analysisId])

  useEffect(() => () => active.current?.abort(), [])

  // The panel opens above the bubble, as tall as the space between the bubble and the header
  // allows. When there is too little room above, it opens below instead.
  const bubbleRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<{ below: boolean; maxHeight: number }>({ below: false, maxHeight: 520 })
  useLayoutEffect(() => {
    if (!open || !bubbleRef.current) return
    const rect = bubbleRef.current.getBoundingClientRect()
    // The app header is a sidebar on wide screens and a top bar on narrow ones: only a top
    // bar takes room above the field.
    const bar = document.querySelector('.topbar')?.getBoundingClientRect()
    const header = (bar && bar.width > bar.height ? Math.max(0, bar.bottom) : 0) + 12
    const above = rect.top - 8 - header
    const below = window.innerHeight - rect.bottom - 14
    const fitsAbove = above >= Math.min(320, below)
    setPlace({ below: !fitsAbove, maxHeight: Math.max(220, Math.min(520, fitsAbove ? above : below)) })
  }, [open, view])

  // A floating panel: Escape or a click anywhere outside it (and outside the bubble) closes it.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointer) }
  }, [open])

  const current = base !== null && base.id === analysisId && task === base.text
  const uncertain = enabled && current && base ? uncertainDimensions(base.profile) : []
  const checks = localChecks(task)
  // An empty field is not counted: the bubble should not nag before the user has written.
  // With the Coach off (or not installed) the bubble shows no count at all; the quick checks
  // are still listed when the user opens it.
  // Coach suggestions count only while they still fit the text; once it changes, they do not.
  const fresh = result !== null && resultText.current === task
  const pending = enabled ? (task.trim() ? checks.length : 0) + (fresh ? result.suggestions.length : uncertain.length) : 0
  const local = base?.provider === 'demo'
  const destination = base ? (base.model ? `${base.provider} · ${base.model}` : base.provider) : ''

  const ask = async (mode: CoachMode) => {
    if (!base || busy) return
    const controller = new AbortController()
    active.current?.abort()
    active.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 45000)
    setBusy(true); setError('')
    try {
      // The panel names the destination; the click is the consent, as with Analyse.
      const response = await promptCoach({ analysis_id: base.id, task, mode, allow_external: !local }, controller.signal)
      if (active.current !== controller) return
      resultText.current = task
      setResult(response)
      setView(mode === 'rewrite' && response.rewrite ? 'rewrite' : 'list')
    } catch (failure) {
      if (active.current !== controller) return
      setError(controller.signal.aborted ? 'The Prompt Coach took too long. Your text is unchanged.'
        : failure instanceof Error ? `${failure.message} Your text is unchanged.` : 'The Prompt Coach is unavailable right now. Your text is unchanged.')
    } finally {
      window.clearTimeout(timeout)
      if (active.current === controller) { active.current = null; setBusy(false) }
    }
  }

  const change = (value: string) => { resultText.current = value; onTaskChange(value); setApplied(true) }
  const stale = () => {
    if (resultText.current === task) return false
    setError('The text changed since these suggestions. Ask again.')
    return true
  }
  const drop = (index: number) => setResult(previous => previous && { ...previous, suggestions: previous.suggestions.filter((_, at) => at !== index) })

  const applyEdit = (index: number) => {
    const suggestion = result?.suggestions[index]
    if (!suggestion?.quote || suggestion.replacement === null || stale()) return
    // The backend compares and quotes in NFC; match in the same form so accented text still applies.
    const text = task.normalize('NFC')
    const quote = suggestion.quote.normalize('NFC')
    const at = text.indexOf(quote)
    if (at < 0 || text.indexOf(quote, at + 1) >= 0) { setError('The text changed since these suggestions. Ask again.'); return }
    change(text.slice(0, at) + suggestion.replacement + text.slice(at + quote.length))
    drop(index)
  }
  const keyOf = (index: number) => {
    const suggestion = result?.suggestions[index]
    return suggestion ? `${suggestion.dimension}:${suggestion.title}` : ''
  }
  const addAnswer = (index: number) => {
    const key = keyOf(index)
    const answer = (answers[key] ?? '').trim()
    if (!answer) return
    const value = task.replace(/\s+$/, '')
    change(`${value}${/[.!?]$/.test(value) ? '' : '.'} ${answer}`)
    drop(index)
    setAnswers(({ [key]: _used, ...rest }) => rest)
  }
  const analyseAgain = () => { setOpen(false); onAnalyse() }

  if (enabled === null) return <div className="coach"><div className="coach-field">{children}</div></div>
  const label = pending ? `Prompt Coach: ${pending} ${pending === 1 ? 'suggestion' : 'suggestions'}` : 'Prompt Coach'

  return (
    <div className="coach" ref={root}>
      <div className="coach-field">
      {children}
      <button type="button" ref={bubbleRef} className="coach-bubble" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen(value => !value)}>
        {pending ? <><span className="coach-dot" aria-hidden="true" />{pending}</> : '✦'}
      </button>
      </div>
      {open && (
        <div className={place.below ? 'coach-panel below' : 'coach-panel'} role="dialog" aria-label="Prompt Coach" style={{ maxHeight: place.maxHeight }}>
          {view === 'rewrite' && result?.rewrite ? (
            <>
              <div className="coach-head"><div><b>Suggested rewrite</b><small>Green is added, red removed, yellow is for you to fill in</small></div>
                <button type="button" className="coach-x" aria-label="Close" onClick={() => setOpen(false)}>×</button></div>
              <div className="coach-body"><pre className="coach-diff">{diffWords(task, result.rewrite)}</pre></div>
              <div className="coach-foot">
                <button type="button" className="coach-btn" onClick={() => setView('list')}>Back</button>
                <button type="button" className="coach-btn primary" onClick={() => { if (stale()) return; change(result.rewrite ?? task); setResult({ ...result, rewrite: null, suggestions: [] }); setView('list') }}>Apply rewrite</button>
              </div>
            </>
          ) : (
            <>
              <div className="coach-head"><div><b>Prompt Coach</b><small>Describe the task so the analysis can determine it</small></div>
                <button type="button" className="coach-x" aria-label="Close" onClick={() => setOpen(false)}>×</button></div>
              <div className="coach-body">
                {analysisId && base && !current && (
                  <>
                    <p className="coach-notice">{applied ? 'Task updated.' : 'The text changed since the last analysis.'} Analyse again to see what changed.</p>
                    <div className="coach-row"><button type="button" className="coach-btn primary" onClick={analyseAgain} disabled={disabled || !task.trim()}>Analyse again</button></div>
                  </>
                )}
                {checks.map(check => (
                  <div className="coach-card" key={check.title}><span className="coach-kicker">Quick check</span>
                    <span className="coach-title">{check.title}</span><p className="coach-detail">{check.detail}</p></div>
                ))}
                {enabled === false ? (
                  <p className="coach-notice">The Prompt Coach is switched off. Only quick checks run; nothing is sent. You can switch it on in Profile.</p>
                ) : !base ? (
                  <p className="coach-notice">Analyse the task first. Suggestions are based on what its analysis left uncertain.</p>
                ) : (
                  <>
                    {error && <p className="coach-error" role="alert">{error}</p>}
                    {!result && current && uncertain.length > 0 && (
                      <div className="coach-card"><span className="coach-kicker">From this analysis</span>
                        <span className="coach-title">{uncertain.length} {uncertain.length === 1 ? 'dimension' : 'dimensions'} left uncertain</span>
                        <p className="coach-detail">{uncertain.map(name => LABELS[name]).join(', ')}. Get suggestions to see how to describe them.</p></div>
                    )}
                    {!result && current && (
                      <p className="coach-note">{local ? 'Asking uses the demonstration coach; the task does not leave AdaptAI.' : <>Asking sends this task to <b>{destination}</b>. The Prompt Coach never saves the task or its suggestions.</>}</p>
                    )}
                    {result?.status === 'nothing_to_improve' && <p className="coach-notice">Nothing to improve: every dimension of this analysis is determined.</p>}
                    {result?.fallback && <p className="coach-note">The model was unavailable; these are standard questions for the uncertain dimensions.</p>}
                    {result?.status === 'ok' && result.suggestions.length === 0 && <p className="coach-note">All suggestions handled.</p>}
                    {result?.suggestions.map((suggestion, index) => (
                      <div className="coach-card" key={`${suggestion.dimension}-${suggestion.title}`}>
                        <span className="coach-kicker">{LABELS[suggestion.dimension] ?? suggestion.dimension} · {suggestion.kind}</span>
                        <span className="coach-title">{suggestion.title}</span>
                        <p className="coach-detail">{suggestion.rationale}</p>
                        {suggestion.kind === 'edit' && suggestion.quote && suggestion.replacement !== null ? (
                          <>
                            <div className="coach-preview">{diffWords(suggestion.quote, suggestion.replacement)}</div>
                            <div className="coach-row"><button type="button" className="coach-btn primary" onClick={() => applyEdit(index)}>Apply</button>
                              <button type="button" className="coach-btn" onClick={() => drop(index)}>Ignore</button></div>
                          </>
                        ) : suggestion.kind === 'question' ? (
                          <>
                            <textarea className="coach-answer" placeholder="Your answer (only you know this)" aria-label={`Answer: ${suggestion.title}`}
                              value={answers[keyOf(index)] ?? ''} onChange={event => setAnswers({ ...answers, [keyOf(index)]: event.target.value })} />
                            <div className="coach-row"><button type="button" className="coach-btn primary" onClick={() => addAnswer(index)}>Add to task</button>
                              <button type="button" className="coach-btn" onClick={() => drop(index)}>Ignore</button></div>
                          </>
                        ) : (
                          <div className="coach-row"><button type="button" className="coach-btn" onClick={() => drop(index)}>Got it</button></div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
              {enabled && base && current && (
                <div className="coach-foot">
                  <button type="button" className="coach-btn" disabled={busy} onClick={() => ask('rewrite')}>Suggest a rewrite</button>
                  <button type="button" className="coach-btn primary" disabled={busy} onClick={() => ask('edits')}>{busy ? 'Asking…' : result ? 'Ask again' : 'Get suggestions'}</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
