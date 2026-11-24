import { useEffect, useState } from 'react'
import { api } from './api'
import './MyLearning.css'
import { EDUCATOR_CARDS } from './educatorCards'
import { Achievements, LearningControls, LevelUp, WeeklyGoalCard } from './LearningExtras'

// WS4 PR7 (L4, L7, L14): how the user frames tasks and chooses models, from
// GET /api/progress/indicators. Always against the user's own earlier range, never other people.

type Level = number | null
type DimensionIndicator = { level: Level; level_raw: Level; tasks: number; confidence: 'high' | 'medium' | 'low' | null; confidence_reasons: string[] }
type PatternIndicator = { code: string; kind: 'improve' | 'positive'; hits: number; window: number; dimension: string | null; level_from: Level; level_to: Level; caveat: string | null }
export type Indicators = {
  version: string
  tasks: number
  overall_level: Level
  overall_level_raw: Level
  dimensions: Record<string, DimensionIndicator>
  patterns: PatternIndicator[]
  range: { last: number | null; days: number | null }
  feedback: { answered: number; solved: number }
  assessed_tasks: number
  previous: { tasks: number; overall_level: Level; dimensions: Record<string, Level> } | null
}

export const DIMENSION_LABELS: Record<string, string> = {
  objective: 'Objective',
  context: 'Context you gave',
  constraints: 'Constraints',
  risks: 'Risks',
  ambiguity: 'Open points',
  success_criteria: 'Success criteria',
  audience_format: 'Audience and format',
}
const LEVEL_NAMES = ['', 'Starting', 'Developing', 'Proficient', 'Expert']
const CONFIDENCE_REASONS: Record<string, string> = {
  few_tasks: 'few tasks',
  varied_scores: 'varied scores',
  less_stable_dimension: 'harder to assess reliably',
}
const RANGES: { label: string; query: string }[] = [
  { label: 'All tasks', query: '' },
  { label: 'Last 10 tasks', query: 'last=10' },
  { label: 'Last 25 tasks', query: 'last=25' },
  { label: 'Last 7 days', query: 'days=7' },
  { label: 'Last 30 days', query: 'days=30' },
]
const MIN_TASKS = 5

const dim = (name: string | null) => (name ? DIMENSION_LABELS[name] ?? name : '').toLowerCase()

/** One sentence per pattern; the caveat says what the evidence cannot claim. */
export function patternText(p: PatternIndicator): string {
  const of = `${p.hits} of your last ${p.window}`
  switch (p.code) {
    case 'missing_dimension': return `You left out ${dim(p.dimension)} in ${of} tasks where it mattered.`
    case 'improving_dimension': return `${DIMENSION_LABELS[p.dimension ?? ''] ?? p.dimension} improved from ${LEVEL_NAMES[p.level_from ?? 0]} to ${LEVEL_NAMES[p.level_to ?? 0]}.`
    case 'over_sizing': return `In ${of} tasks you chose a bigger model than recommended and it worked. A smaller one might have done it for less; this is a possible saving, not a proven one.`
    case 'under_sizing': return `In ${of} tasks you chose a smaller model than recommended and the task was not solved.` + (p.caveat === 'model_or_request' ? ' The way the task was described may also have played a part.' : '')
    case 'good_model_choice': return `You followed the recommendation and solved the task in ${of} tasks.`
    case 'coach_ignored': return `You turned down the Coach's rewrite in ${of} tasks where it found at least 2 gaps.`
    case 'coach_pays_off': return `In your tasks, accepting the Coach's rewrite went together with solving more tasks (${p.hits} of ${p.window} accepted rewrites solved). This is a correlation, not proof that the Coach caused it.`
    case 'long_chats': return `${of} solved chats needed more than twice your usual number of answers.`
    case 'model_switching': return `You switched model in the middle of the chat in ${of} chats.`
    default: return p.code
  }
}

/** A pattern with its Educator card (L5): why it matters, how to fix it, an example. */
function PatternItem({ pattern }: { pattern: PatternIndicator }) {
  const card = EDUCATOR_CARDS[pattern.code]
  return (
    <li className={`pattern ${pattern.kind}`} data-pattern={pattern.code}>
      {patternText(pattern)}
      {card && (
        <details className="pattern-advice" data-pattern-advice={pattern.code}>
          <summary>{pattern.kind === 'improve' ? 'Why it matters and how to fix it' : 'Why this is good'}</summary>
          <p>{card.why}</p>
          <p>{card.how}</p>
          {card.before && card.after && <p className="muted">Before: “{card.before}”<br />After: “{card.after}”</p>}
        </details>
      )}
    </li>
  )
}

function trend(now: Level, before: Level | undefined): string {
  if (now === null || before === null || before === undefined) return ''
  return now > before ? '↑' : now < before ? '↓' : '→'
}

/** A radar of the 7 dimensions (levels 1 to 4); a dimension without a level sits at the centre. */
export function Radar({ dimensions }: { dimensions: Record<string, DimensionIndicator> }) {
  const names = Object.keys(DIMENSION_LABELS)
  const size = 260, centre = size / 2, radius = 90
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / names.length
    return [centre + Math.cos(angle) * radius * (value / 4), centre + Math.sin(angle) * radius * (value / 4)]
  }
  const shape = names.map((name, index) => point(index, dimensions[name]?.level ?? 0).join(',')).join(' ')
  return (
    <svg className="learning-radar" viewBox={`-70 0 ${size + 140} ${size}`} role="img" aria-labelledby="radar-title radar-desc" data-learning-radar="">
      <title id="radar-title">Your level on each of the 7 dimensions</title>
      <desc id="radar-desc">{names.map(name => `${DIMENSION_LABELS[name]}: ${dimensions[name]?.level ? LEVEL_NAMES[dimensions[name].level as number] : 'no level yet'}`).join('; ')}</desc>
      {[1, 2, 3, 4].map(ring => (
        <polygon key={ring} className="radar-ring" points={names.map((_, index) => point(index, ring).join(',')).join(' ')} />
      ))}
      {names.map((name, index) => {
        const [x, y] = point(index, 4.9)
        const [ax, ay] = point(index, 4)
        return (
          <g key={name}>
            <line className="radar-axis" x1={centre} y1={centre} x2={ax} y2={ay} />
            <text className="radar-label" x={x} y={y} textAnchor={x < centre - 5 ? 'end' : x > centre + 5 ? 'start' : 'middle'} dominantBaseline="middle">{DIMENSION_LABELS[name]}</text>
          </g>
        )
      })}
      <polygon className="radar-shape" points={shape} />
    </svg>
  )
}

export function MyLearning() {
  const [range, setRange] = useState(RANGES[0].query)
  const [data, setData] = useState<Indicators>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const load = () => {
      setFailed(false)
      api<Indicators>(`progress/indicators${range ? `?${range}` : ''}`, undefined, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    }
    load()
    window.addEventListener('adaptai-progress-updated', load)
    return () => { controller.abort(); window.removeEventListener('adaptai-progress-updated', load) }
  }, [range])
  if (failed) return <section className="card my-learning"><p className="api-error" role="alert">Could not load your learning profile.</p></section>
  if (!data) return null
  const { answered, solved } = data.feedback
  const assessed = data.assessed_tasks > 0
  const improve = data.patterns.filter(p => p.kind === 'improve')
  const positive = data.patterns.filter(p => p.kind === 'positive')
  return (
    <section className="card my-learning" aria-labelledby="my-learning-title" data-my-learning="">
      <div className="card-heading my-learning-heading">
        <div><p className="eyebrow">Your progress</p><h2 id="my-learning-title">How you use AI</h2></div>
        <label className="my-learning-range">Show <select value={range} onChange={event => setRange(event.target.value)} data-learning-range="">
          {RANGES.map(item => <option key={item.label} value={item.query}>{item.label}</option>)}
        </select></label>
      </div>

      <LevelUp level={data.overall_level} />
      <dl className="learning-top" data-learning-top="">
        <div data-top-savings="">
          <dt>Estimated savings</dt>
          <dd>Not measured yet</dd>
          <p className="muted">Needs the token counts of each call (usage metering). Until then no saving is claimed.</p>
        </div>
        <div data-top-resolved="">
          <dt>Tasks solved</dt>
          <dd>{answered > 0 ? `${Math.round((100 * solved) / answered)}%` : '—'}</dd>
          <p className="muted">{answered > 0 ? `${solved} of ${answered} tasks with feedback in this range` : 'Answer "Did it solve it?" to see this.'}</p>
        </div>
        <div data-top-maturity="">
          <dt>Level</dt>
          <dd>{data.overall_level ? `${LEVEL_NAMES[data.overall_level]} ${trend(data.overall_level, data.previous?.overall_level)}` : '—'}</dd>
          <p className="muted">{data.overall_level ? `Based on ${data.tasks} tasks` : `After ${MIN_TASKS} assessed tasks`}</p>
        </div>
      </dl>

      {data.tasks >= MIN_TASKS && !assessed ? (
        <div className="learning-tour" data-learning-not-assessed="">
          <h3>How you describe tasks is not assessed yet</h3>
          <p>The assessment of request quality (objective, context, success criteria…) is not switched on in this version, so there are no levels yet. Your patterns about model choices and chats still appear below.</p>
        </div>
      ) : data.tasks < MIN_TASKS ? (
        <div className="learning-tour" data-learning-tour="">
          <h3>Your learning profile is on its way</h3>
          <p>After {MIN_TASKS} analysed tasks, this section shows:</p>
          <ol>
            <li><strong>A radar of 7 dimensions</strong> of how you describe tasks, such as the objective and the success criteria.</li>
            <li><strong>Patterns with their evidence</strong>, for example "you left out success criteria in 4 of your last 6 tasks".</li>
            <li><strong>Your level and its trend</strong>, always compared with yourself, never with other people.</li>
          </ol>
          <p className="muted">You have {data.tasks} of {MIN_TASKS} tasks so far.</p>
        </div>
      ) : (
        <div className="learning-body">
          <Radar dimensions={data.dimensions} />
          <table className="learning-table" data-learning-table="">
            <caption className="muted">Levels: Starting, Developing, Proficient, Expert</caption>
            <thead><tr><th scope="col">Dimension</th><th scope="col">Level</th><th scope="col">Based on</th><th scope="col">Confidence</th></tr></thead>
            <tbody>
              {Object.keys(DIMENSION_LABELS).map(name => {
                const item = data.dimensions[name]
                return (
                  <tr key={name} data-learning-dimension={name}>
                    <th scope="row">{DIMENSION_LABELS[name]}</th>
                    <td>{item?.level ? `${LEVEL_NAMES[item.level]} ${trend(item.level, data.previous?.dimensions[name])}` : '—'}</td>
                    <td>{item?.tasks ? `${item.tasks} tasks` : 'Not needed yet'}</td>
                    <td>{item?.confidence ? `${item.confidence}${item.confidence_reasons.length ? ` (${item.confidence_reasons.map(reason => CONFIDENCE_REASONS[reason] ?? reason).join(', ')})` : ''}` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {(improve.length > 0 || positive.length > 0) && (
        <div className="learning-patterns" data-learning-patterns="">
          {positive.length > 0 && <><h3>Going well</h3><ul>{positive.map(p => <PatternItem key={`${p.code}-${p.dimension}`} pattern={p} />)}</ul></>}
          {improve.length > 0 && <><h3>To work on</h3><ul>{improve.map(p => <PatternItem key={`${p.code}-${p.dimension}`} pattern={p} />)}</ul></>}
        </div>
      )}
      <div className="learning-extras">
        <WeeklyGoalCard />
        <Achievements />
      </div>
      <LearningControls />
      <p className="muted learning-note">Patterns follow rules the team set (for example 3 of your last 5 tasks) and are not yet validated with real users. The levels rise as soon as you improve and fall only after 3 weaker tasks in a row.</p>
    </section>
  )
}
