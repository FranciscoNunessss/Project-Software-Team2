import { useEffect, useState } from 'react'
import { api } from './api'

// "Are you describing tasks better?" Completeness of the first analysis of each session, with
// the verdict computed by the backend (GET /api/progress/learning). Numeric only, no task text.
type Point = { date: string; completeness: number }
type DimensionRate = { dimension: string; early_rate: number; recent_rate: number }
export type Learning = {
  verdict: 'insufficient_history' | 'improving' | 'stable' | 'declining'
  points: Point[]
  min_sessions: number
  margin: number
  window?: number
  early_mean?: number
  recent_mean?: number
  delta?: number
  dimensions: DimensionRate[]
}

const LABELS: Record<string, string> = {
  reasoning: 'Reasoning', context: 'Context', ambiguity: 'Ambiguity', domain: 'Domain',
  risk: 'Risk', tools: 'Tools', modality: 'Modality',
}
const VERDICT: Record<Learning['verdict'], { title: string; text: string }> = {
  improving: { title: 'Improving', text: 'Your first descriptions are more complete than when you started.' },
  stable: { title: 'Stable', text: 'Your first descriptions are about as complete as when you started.' },
  declining: { title: 'Less complete lately', text: 'Your recent first descriptions leave more open than your early ones.' },
  insufficient_history: { title: 'Not enough history yet', text: '' },
}

export function LearningProgress({ summary }: { summary: unknown }) {
  const [data, setData] = useState<Learning>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!summary) return
    const controller = new AbortController()
    api<Learning>('progress/learning', undefined, controller.signal)
      .then(result => { setData(result); setError('') })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load learning progress') })
    return () => controller.abort()
  }, [summary])

  const points = data?.points ?? []
  const coordinates = points.map((point, i) => [points.length === 1 ? 450 : 20 + i * 860 / (points.length - 1), 200 - point.completeness * 1.8])
  const line = coordinates.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const changes = (data?.dimensions ?? [])
    .map(row => ({ ...row, change: Math.round((row.recent_rate - row.early_rate) * 100) }))
    .filter(row => row.change !== 0)
    .sort((a, b) => b.change - a.change)
  const verdict = data ? VERDICT[data.verdict] : undefined

  return (
    <section className="card chart-card learning-progress" aria-labelledby="learning-title" data-learning-progress>
      <div className="card-heading"><div>
        <p className="eyebrow">Learning</p>
        <h2 id="learning-title">Are you describing tasks better?</h2>
        <p className="muted">Completeness of the first analysis of each session. Re-analyses after suggestions are not counted, so this shows how you write unaided.</p>
      </div>{data && <span className="period">{points.length} {points.length === 1 ? 'session' : 'sessions'}</span>}</div>
      {error && <p className="api-error" role="alert">{error}</p>}
      {data && verdict && (
        <div className={`learning-verdict ${data.verdict}`} role="status">
          <strong>{verdict.title}</strong>
          {data.verdict === 'insufficient_history'
            ? <span>Analyse tasks in at least {data.min_sessions} sessions to see a trend ({points.length} so far).</span>
            : <span>{verdict.text} Average {data.early_mean} in your first {data.window} sessions, {data.recent_mean} in the last {data.window} ({(data.delta ?? 0) > 0 ? '+' : ''}{data.delta}; a change under {data.margin} points counts as stable).</span>}
        </div>
      )}
      {points.length > 0 && <div className="chart-wrap">
        <div className="chart-y"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
        <svg className="chart" viewBox="0 0 900 220" preserveAspectRatio="none" role="img" aria-label="Completeness of the first analysis per session">
          <g className="grid-lines"><path d="M0 20H900M0 65H900M0 110H900M0 155H900M0 200H900" /></g>
          {coordinates.length > 1 && <path className="chart-line" d={line} />}
          {coordinates.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="5"><title>Session {i + 1}: {points[i].completeness}/100</title></circle>)}
        </svg>
        <div className="chart-x">{points.map((_, i) => <span key={i}>Session {i + 1}</span>)}</div>
      </div>}
      {changes.length > 0 && (
        <div className="learning-dimensions">
          <h3>What changed in your first descriptions</h3>
          <ul>{changes.map(row => (
            <li key={row.dimension} className={row.change > 0 ? 'up' : 'down'}>
              <span>{LABELS[row.dimension] ?? row.dimension}</span>
              <span>{row.change > 0 ? 'now described more often' : 'now described less often'}</span>
              <strong>{Math.round(row.early_rate * 100)}% → {Math.round(row.recent_rate * 100)}%</strong>
            </li>
          ))}</ul>
        </div>
      )}
      {data && data.verdict !== 'insufficient_history' && changes.length === 0 && <p className="muted">The same dimensions are described as often as at the start.</p>}
    </section>
  )
}
