import { useEffect, useState } from 'react'
import { api, type OutcomeSummary } from './api'
import './TaskOutcomes.css'

// My progress: "Your solved tasks" (ADR-014). Counts only, from GET /api/progress/outcomes.
export function TaskOutcomes() {
  const [data, setData] = useState<OutcomeSummary>()
  useEffect(() => {
    const controller = new AbortController()
    const load = () => api<OutcomeSummary>('progress/outcomes', undefined, controller.signal).then(setData).catch(() => undefined)
    load()
    window.addEventListener('adaptai-progress-updated', load)
    return () => { controller.abort(); window.removeEventListener('adaptai-progress-updated', load) }
  }, [])
  if (!data) return null
  const solved = data.resolved + data.resolved_with_refinement
  return (
    <section className="card task-outcomes" aria-labelledby="outcomes-title" data-task-outcomes="">
      <div className="card-heading"><div><p className="eyebrow">Feedback</p><h2 id="outcomes-title">Your solved tasks</h2></div></div>
      {data.tasks === 0 ? (
        <p className="muted">After a task, say whether the model solved it (“Task solved” in the chat). Your answers appear here.</p>
      ) : (
        <>
          <dl className="outcome-metrics">
            <div><dt>Solved</dt><dd>{solved} of {data.tasks}</dd></div>
            <div><dt>After refining</dt><dd>{data.resolved_with_refinement}</dd></div>
            <div><dt>Followed the recommendation</dt><dd>{data.followed} of {data.tasks}</dd></div>
            <div><dt>Solved when following it</dt><dd>{data.solved_rate_following === null ? 'n/a' : `${data.solved_rate_following}%`}</dd></div>
            <div><dt>Solved with another model</dt><dd>{data.solved_rate_not_following === null ? 'n/a' : `${data.solved_rate_not_following}%`}</dd></div>
            <div><dt>Answers per task</dt><dd>{data.mean_turns ?? 'n/a'}</dd></div>
          </dl>
          {data.by_model.length > 0 && (
            <ul className="outcome-models">{data.by_model.map(item => <li key={item.model ?? 'unknown'}><span>{item.model ?? 'Unknown model'}</span><strong>{item.solved}/{item.tasks} solved</strong></li>)}</ul>
          )}
          {data.described_poorly > 0 && <p className="muted">{data.described_poorly} not solved because the task was described poorly: the Coach can help before you send.</p>}
        </>
      )}
      <p className="muted">Your own judgement of each task, not a measure of quality. Skipped: {data.skipped}.</p>
    </section>
  )
}
