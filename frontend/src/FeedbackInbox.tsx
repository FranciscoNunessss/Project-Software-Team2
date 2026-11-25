import { useEffect, useState } from 'react'
import { getFeedbackInbox, notifyProgressChange, OUTCOME_REASONS, putOutcome, type FeedbackInbox as Inbox, type FeedbackItem, type OutcomeReason, type TaskOutcome } from './api'
import './FeedbackInbox.css'

// WS4 L16 (ADR-014 revision, 24 Nov 2026): answer "Did it solve it?" without reopening the
// chat, and change an answer given too early. Ids, answers and chat titles only.

const LABELS: Record<TaskOutcome, string> = {
  resolved: 'Solved',
  resolved_with_refinement: 'Solved after refining',
  not_resolved: 'Not solved',
  skipped: 'Skipped',
}

function Answer({ item, onSaved }: { item: FeedbackItem; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [askReason, setAskReason] = useState(false)
  const save = async (outcome: TaskOutcome, reason: OutcomeReason | null = null) => {
    setSaving(true); setFailed(false)
    try { await putOutcome(item.analysis_id, { outcome, reason }); setAskReason(false); onSaved(); notifyProgressChange() }
    catch { setFailed(true) }
    finally { setSaving(false) }
  }
  if (askReason) {
    return (
      <div className="feedback-actions" role="group" aria-label="What went wrong? (optional)">
        {(Object.keys(OUTCOME_REASONS) as OutcomeReason[]).map(key => (
          <button key={key} type="button" className="chip" disabled={saving} onClick={() => void save('not_resolved', key)}>{OUTCOME_REASONS[key]}</button>
        ))}
        <button type="button" className="chip" disabled={saving} onClick={() => void save('not_resolved')}>No reason</button>
      </div>
    )
  }
  return (
    <div className="feedback-actions" role="group" aria-label={`Did it solve ${item.title}?`}>
      {(['resolved', 'resolved_with_refinement'] as TaskOutcome[]).map(outcome => (
        <button key={outcome} type="button" className={`chip${item.outcome === outcome ? ' selected' : ''}`} aria-pressed={item.outcome === outcome} disabled={saving} onClick={() => void save(outcome)}>{LABELS[outcome]}</button>
      ))}
      <button type="button" className={`chip${item.outcome === 'not_resolved' ? ' selected' : ''}`} aria-pressed={item.outcome === 'not_resolved'} disabled={saving} onClick={() => setAskReason(true)}>{LABELS.not_resolved}</button>
      {item.outcome === null && <button type="button" className="chat-link" disabled={saving} onClick={() => void save('skipped')}>Skip</button>}
      {failed && <span className="api-error" role="alert">Could not save.</span>}
    </div>
  )
}

export function FeedbackInbox() {
  const [data, setData] = useState<Inbox>()
  const [showRecent, setShowRecent] = useState(false)
  const load = (signal?: AbortSignal) => getFeedbackInbox(signal).then(setData).catch(() => undefined)
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const reload = () => void load(controller.signal)
    window.addEventListener('adaptai-progress-updated', reload)
    return () => { controller.abort(); window.removeEventListener('adaptai-progress-updated', reload) }
  }, [])
  if (!data || data.run_with_a_model === 0) return null
  return (
    <section className="card feedback-inbox" aria-labelledby="feedback-inbox-title" data-feedback-inbox="">
      <div className="card-heading"><div><p className="eyebrow">Feedback</p><h2 id="feedback-inbox-title">Tasks without feedback ({data.pending_count})</h2></div></div>
      <p className="muted" data-response-rate="">
        You answered {data.answered} of {data.asked} tasks{data.response_rate !== null ? ` (${data.response_rate}%)` : ''}{data.run_with_a_model > data.asked ? `; ${data.run_with_a_model - data.asked} skipped` : ''}. More answers make your patterns and savings more reliable.
      </p>
      {data.pending.length === 0 ? <p className="muted">Nothing waiting: every task you ran has an answer.</p> : (
        <ul className="feedback-list">
          {data.pending.map(item => (
            <li key={item.analysis_id} data-feedback-pending={item.analysis_id}>
              <span className="feedback-title">{item.title}</span>
              <Answer item={item} onSaved={() => void load()} />
            </li>
          ))}
        </ul>
      )}
      {data.recent.length > 0 && (
        <details open={showRecent} onToggle={event => setShowRecent(event.currentTarget.open)}>
          <summary>Change a recent answer</summary>
          <ul className="feedback-list">
            {data.recent.map(item => (
              <li key={item.analysis_id} data-feedback-recent={item.analysis_id}>
                <span className="feedback-title">{item.title} <span className="muted">· {item.outcome ? LABELS[item.outcome] : ''}</span></span>
                <Answer item={item} onSaved={() => void load()} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
