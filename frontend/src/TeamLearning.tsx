import { useEffect, useState } from 'react'
import { api } from './api'
import { EDUCATOR_CARDS, GOAL_TEXT } from './educatorCards'
import { DIMENSION_LABELS, Radar } from './MyLearning'
import { Button, Card } from './ui'

// Team Scope learning panels (WS3 TL1 to TL5): aggregates only; a number appears only with enough
// members behind it (ADR-016).

type Dimension = { enough: false } | { enough: true; median: number; previous: number | null; distribution: number[] }
type Learning = {
  min_group_size: number; until: string; enough_members: boolean
  dimensions: Record<string, Dimension>
  patterns: { code: string; dimension: string | null; share: number }[]
  feedback: { enough: boolean; response_rate?: number }
  coach: { available: boolean; enough?: boolean; accepted_rate?: number; solved_when_accepted?: number | null; solved_when_not?: number | null }
}
type TeamGoal = { group: string; week: string; goal: { code: string; enough_members: boolean; met: number | null; tasks: number | null } | null; suggestions?: string[] }

const LEVEL_NAMES = ['', 'Starting', 'Developing', 'Proficient', 'Expert']
const PATTERN_NAMES: Record<string, string> = {
  missing_dimension: 'leave out', over_sizing: 'choose a bigger model than recommended', under_sizing: 'choose a smaller model and do not solve the task',
  coach_ignored: "turn down the Coach's rewrite", long_chats: 'have unusually long chats', model_switching: 'switch model in the middle of a chat',
}
const percent = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}%`
const trend = (now: number, before: number | null) => before === null ? '—' : now > before ? '↑ up' : now < before ? '↓ down' : '→ same'
const patternName = (code: string, dimension: string | null) =>
  `${PATTERN_NAMES[code] ?? code}${code === 'missing_dimension' && dimension ? ` ${dimension === 'context' ? 'context' : (DIMENSION_LABELS[dimension] ?? dimension).toLowerCase()}` : ''}`

function goalProgress(goal: NonNullable<TeamGoal['goal']>) {
  return goal.enough_members ? `${goal.met} of ${goal.tasks} tasks this week met it.` : 'Progress appears once at least 5 members have tasks this week.'
}

export function TeamLearning({ groupId, weeks }: { groupId: string; weeks: number }) {
  const [data, setData] = useState<Learning>()
  const [goal, setGoal] = useState<TeamGoal>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    Promise.all([
      api<Learning>(`groups/${groupId}/learning?weeks=${weeks}`, undefined, controller.signal).then(setData),
      api<TeamGoal>(`groups/${groupId}/goal`, undefined, controller.signal).then(setGoal),
    ]).catch(() => { if (!controller.signal.aborted) setError('Could not load the learning figures') })
    return () => controller.abort()
  }, [groupId, weeks])
  if (error) return <p className="api-error" role="alert">{error}</p>
  if (!data || !goal) return null
  const shown = Object.keys(DIMENSION_LABELS).filter(name => data.dimensions[name]?.enough)
  const radar = Object.fromEntries(Object.keys(DIMENSION_LABELS).map(name => {
    const item = data.dimensions[name]
    const level = item?.enough ? item.median : null
    return [name, { level, level_raw: level, tasks: 0, confidence: null, confidence_reasons: [] }]
  }))
  const pick = async (code: string) => {
    try { const saved = await api<TeamGoal>(`groups/${groupId}/goal`, { code }, undefined, 'PUT'); setGoal({ ...saved, suggestions: goal.suggestions }) }
    catch { setError('Could not save the team goal') }
  }
  return <section data-team-learning="">
    <div className="section-heading"><h2>How the group learns</h2></div>
    <p className="muted">Closed weeks up to {data.until}. Each number needs at least {data.min_group_size} people behind it.</p>
    {shown.length === 0 ? <Card className="team-card"><p>Not assessed yet: fewer than {data.min_group_size} members have a level on any dimension.</p></Card> :
      <Card className="team-card">
        <div className="team-learning-body">
          <Radar dimensions={radar} />
          <table className="team-table">
            <caption className="visually-hidden">Typical level, trend and number of members at each level</caption>
            <thead><tr><th scope="col">Dimension</th><th scope="col">Typical level</th><th scope="col">Trend</th>{LEVEL_NAMES.slice(1).map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead>
            <tbody>{Object.keys(DIMENSION_LABELS).map(name => {
              const item = data.dimensions[name]
              return <tr key={name}><th scope="row">{DIMENSION_LABELS[name]}</th>
                {item?.enough
                  ? <><td>{LEVEL_NAMES[item.median]}</td><td>{trend(item.median, item.previous)}</td>{item.distribution.map((count, index) => <td key={index}>{count}</td>)}</>
                  : <td colSpan={6} className="muted">Not enough members</td>}
              </tr>
            })}</tbody>
          </table>
        </div>
      </Card>}
    <Card className="team-card">
      <h2>Group patterns</h2>
      {data.patterns.length === 0 ? <p className="muted">No shared pattern to show.</p> :
        <ul className="team-patterns">{data.patterns.map(pattern => <li key={`${pattern.code}-${pattern.dimension}`}>
          <strong>{pattern.share}%</strong> {patternName(pattern.code, pattern.dimension)}.
          {EDUCATOR_CARDS[pattern.code] && <> Advice for the team: {EDUCATOR_CARDS[pattern.code].how}</>}
        </li>)}</ul>}
    </Card>
    <div className="team-tiles">
      <Card className="team-tile"><p className="team-tile-label">Feedback response rate</p><p className="team-tile-value">{percent(data.feedback.response_rate)}</p><p className="team-tile-detail">Share of tasks with feedback: how far to trust the numbers</p></Card>
      <Card className="team-tile"><p className="team-tile-label">Coach suggestions accepted</p><p className="team-tile-value">{percent(data.coach.accepted_rate)}</p>
        <p className="team-tile-detail">{!data.coach.available ? 'Not recorded yet' : data.coach.enough ? `Solved when accepted ${percent(data.coach.solved_when_accepted)} · when not ${percent(data.coach.solved_when_not)}` : 'Not enough members'}</p></Card>
    </div>
    <Card className="team-card" data-team-goal="">
      <h2>Team goal this week</h2>
      {goal.goal ? <><p><strong>{GOAL_TEXT[goal.goal.code] ?? goal.goal.code}</strong></p><p className="muted">{goalProgress(goal.goal)}</p></> : <p className="muted">No team goal yet.</p>}
      <div className="team-actions">{(goal.suggestions ?? []).filter(code => code !== goal.goal?.code).map(code =>
        <Button key={code} size="sm" variant="secondary" onClick={() => void pick(code)} data-team-goal-option={code}>{GOAL_TEXT[code] ?? code}</Button>)}</div>
    </Card>
  </section>
}

/** On My progress, next to the person's own goal. */
export function MyTeamGoals() {
  const [goals, setGoals] = useState<TeamGoal[]>([])
  useEffect(() => {
    const controller = new AbortController()
    api<{ goals: TeamGoal[] }>('progress/team-goals', undefined, controller.signal).then(body => setGoals(body.goals)).catch(() => undefined)
    return () => controller.abort()
  }, [])
  return <>{goals.map(item => item.goal && <div className="learning-goal" key={item.group} data-my-team-goal={item.goal.code}>
    <h3>{item.group}: team goal</h3>
    <p><strong>{GOAL_TEXT[item.goal.code] ?? item.goal.code}</strong></p>
    <p className="muted">{goalProgress(item.goal)}</p>
  </div>)}</>
}
