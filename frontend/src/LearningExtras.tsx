import { useEffect, useState } from 'react'
import {
  chooseGoal, getAchievements, getGoal, getLearningSettings, notifyProgressChange, setLearningPaused, startLearningOver,
  type Achievement, type LearningSettings, type WeeklyGoal,
} from './api'
import { GOAL_TEXT } from './educatorCards'
import { DIMENSION_LABELS } from './MyLearning'

// WS4 L9 (weekly goal), L13 (achievements, never for volume) and L17 (pause, start over).

function useReloading<T>(load: (signal: AbortSignal) => Promise<T>): [T | undefined, () => void] {
  const [data, setData] = useState<T>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(setData).catch(() => undefined)
    const reload = () => setTick(value => value + 1)
    window.addEventListener('adaptai-progress-updated', reload)
    return () => { controller.abort(); window.removeEventListener('adaptai-progress-updated', reload) }
  }, [tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return [data, () => setTick(value => value + 1)]
}

export function WeeklyGoalCard() {
  const [goal, reload] = useReloading<WeeklyGoal>(getGoal)
  const [busy, setBusy] = useState(false)
  if (!goal) return null
  const { code, target, progress, met, chosen } = goal.goal
  // The suggestions come first, but the user may pick any goal (autonomy keeps goals alive).
  const others = Object.keys(GOAL_TEXT).filter(item => item !== code && !goal.alternatives.includes(item))
  const pick = async (next: string) => { setBusy(true); try { await chooseGoal(next); reload() } finally { setBusy(false) } }
  return (
    <div className="learning-goal" data-weekly-goal={code}>
      <h3>This week's goal</h3>
      <p><strong>{GOAL_TEXT[code] ?? code}</strong>{!chosen && <span className="muted"> (suggested)</span>}</p>
      <div className="goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={progress} aria-label="Goal progress">
        <span style={{ width: `${(100 * progress) / target}%` }} />
      </div>
      <p className="muted" data-goal-progress="">{met ? `Done: ${progress} of ${target}. Well done.` : `${progress} of ${target} this week`}</p>
      {goal.alternatives.length > 0 && (
        <p className="goal-alternatives">Prefer another? {goal.alternatives.map(item => (
          <button key={item} type="button" className="chip" disabled={busy} onClick={() => void pick(item)} data-goal-alternative={item}>{GOAL_TEXT[item] ?? item}</button>
        ))}{!chosen && <button type="button" className="chat-link" disabled={busy} onClick={() => void pick(code)} data-goal-accept="">Keep this one</button>}</p>
      )}
      {others.length > 0 && (
        <details className="goal-others" data-goal-others="">
          <summary>Other goals…</summary>
          <p className="goal-alternatives">{others.map(item => (
            <button key={item} type="button" className="chip" disabled={busy} onClick={() => void pick(item)} data-goal-option={item}>{GOAL_TEXT[item]}</button>
          ))}</p>
        </details>
      )}
    </div>
  )
}

const ACHIEVEMENT_TEXT = (item: Achievement) => {
  const dimension = item.dimension ? DIMENSION_LABELS[item.dimension] : ''
  if (item.code === 'clear_dimension') return { title: `Clear ${dimension.toLowerCase()}`, rule: `${dimension} clear in ${item.target} tasks in a row` }
  if (item.code === 'proficient_dimension') return { title: `Proficient: ${dimension.toLowerCase()}`, rule: `Reach Proficient in ${dimension.toLowerCase()}` }
  return { title: 'Right model', rule: `${item.target} tasks solved with the recommended model` }
}

export function Achievements() {
  const [data] = useReloading(getAchievements)
  if (!data) return null
  const unlocked = data.achievements.filter(item => item.unlocked)
  const next = data.achievements.filter(item => !item.unlocked && item.progress > 0).sort((a, b) => b.progress / b.target - a.progress / a.target).slice(0, 3)
  return (
    <div className="learning-achievements" data-achievements="">
      <h3>Achievements</h3>
      <p className="muted">Earned by how well you work, never by how much you use AdaptAI.</p>
      {unlocked.length === 0 && next.length === 0 && <p className="muted">None yet.</p>}
      <ul>
        {unlocked.map(item => <li key={`${item.code}-${item.dimension}`} className="achievement unlocked" data-achievement={`${item.code}:${item.dimension ?? ''}`}>★ {ACHIEVEMENT_TEXT(item).title}</li>)}
        {next.map(item => <li key={`${item.code}-${item.dimension}`} className="achievement" data-achievement-next={`${item.code}:${item.dimension ?? ''}`}>{ACHIEVEMENT_TEXT(item).rule}: {item.progress} of {item.target}</li>)}
      </ul>
    </div>
  )
}

/** Shows once when the overall level rises (the last level seen is kept in this browser). */
export function LevelUp({ level }: { level: number | null }) {
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (!level) return
    let seen: number | null = null
    try { seen = Number(window.localStorage.getItem('adaptai-level-seen')) || null } catch { /* storage off */ }
    if (seen !== null && level > seen) setShown(level)
    try { window.localStorage.setItem('adaptai-level-seen', String(level)) } catch { /* storage off */ }
  }, [level])
  if (!shown) return null
  return <p className="level-up" role="status" data-level-up="">Level up! You reached {['', 'Starting', 'Developing', 'Proficient', 'Expert'][shown]}. <button type="button" className="chat-link" onClick={() => setShown(null)}>Close</button></p>
}

export function LearningControls() {
  const [settings, setSettings] = useState<LearningSettings>()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    getLearningSettings(controller.signal).then(setSettings).catch(() => undefined)
    return () => controller.abort()
  }, [])
  if (!settings) return null
  const act = async (action: () => Promise<LearningSettings>) => {
    setBusy(true)
    try { setSettings(await action()); setConfirming(false); notifyProgressChange() } finally { setBusy(false) }
  }
  return (
    <details className="learning-controls" data-learning-controls="">
      <summary>Your learning data</summary>
      <p className="muted">You can also leave a single task out from the list above it in the history.</p>
      {settings.can_pause && (
        <label className="learning-toggle"><input type="checkbox" checked={settings.paused} disabled={busy} onChange={event => void act(() => setLearningPaused(event.target.checked))} data-learning-pause="" /> Pause learning: new tasks do not count while this is on</label>
      )}
      {settings.can_reset && (!confirming
        ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirming(true)} data-learning-reset="">Start over</button>
        : <div role="alert"><p>Delete your levels, patterns, goals and disputes? Your feedback on tasks is kept.</p>
            <button type="button" className="button button-danger" disabled={busy} onClick={() => void act(startLearningOver)} data-learning-reset-confirm="">Start over</button>{' '}
            <button type="button" className="chat-link" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div>)}
      {(!settings.can_pause || !settings.can_reset) && <p className="muted" data-learning-policy="">Your organisation has turned off {[!settings.can_pause && 'pausing', !settings.can_reset && 'starting over'].filter(Boolean).join(' and ')}.</p>}
      {settings.reset_at && <p className="muted">Started over on {new Date(settings.reset_at).toLocaleDateString()}.</p>}
    </details>
  )
}
