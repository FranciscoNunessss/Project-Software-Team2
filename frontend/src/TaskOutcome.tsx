import { useState } from 'react'
import { ApiError, notifyProgressChange, OUTCOME_REASONS, putOutcome, type OutcomeReason, type TaskOutcome } from './api'

// Feedback per task (ADR-014): once per task, at the end, never per answer.

/** A quiet "Task solved" under the answers of the open task. */
export function SolvedButton({ disabled, onAnswer }: { disabled: boolean; onAnswer: (outcome: TaskOutcome) => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return <button type="button" className="chat-link task-solved" onClick={() => setAsking(true)} disabled={disabled} data-task-solved="">✓ Task solved</button>
  }
  return (
    <div className="task-refine" role="group" aria-label="Did you need to refine it?" data-task-refine="">
      <span>Did you need to refine it?</span>
      <button type="button" className="chat-link" disabled={disabled} onClick={() => onAnswer('resolved_with_refinement')}>Yes</button>
      <button type="button" className="chat-link" disabled={disabled} onClick={() => onAnswer('resolved')}>No</button>
    </div>
  )
}

/** "Did the previous task get solved?", asked once when the next task starts. */
export function OutcomeCard({ title, question = 'Did the previous task get solved?', disabled, onAnswer }: {
  title: string
  question?: string
  disabled: boolean
  onAnswer: (outcome: TaskOutcome, reason?: OutcomeReason | null) => void
}) {
  const [failed, setFailed] = useState(false)
  const [reason, setReason] = useState<OutcomeReason | null>(null)
  return (
    <section className="outcome-card" aria-label="Feedback on the previous task" data-outcome-card="">
      <p><strong>{question}</strong> <span className="muted">{title}</span></p>
      {!failed ? (
        <div className="outcome-actions">
          <button type="button" className="button button-secondary" disabled={disabled} onClick={() => onAnswer('resolved')}>Solved</button>
          <button type="button" className="button button-secondary" disabled={disabled} onClick={() => onAnswer('resolved_with_refinement')}>Solved after refining</button>
          <button type="button" className="button button-secondary" disabled={disabled} onClick={() => setFailed(true)}>Not solved</button>
          <button type="button" className="chat-link" disabled={disabled} onClick={() => onAnswer('skipped')}>Skip</button>
        </div>
      ) : (
        <div className="outcome-actions" role="radiogroup" aria-label="What went wrong? (optional)">
          {(Object.keys(OUTCOME_REASONS) as OutcomeReason[]).map(key => (
            <button type="button" key={key} role="radio" aria-checked={reason === key} className={`chip${reason === key ? ' selected' : ''}`} disabled={disabled} onClick={() => setReason(reason === key ? null : key)}>{OUTCOME_REASONS[key]}</button>
          ))}
          <button type="button" className="button button-primary" disabled={disabled} onClick={() => onAnswer('not_resolved', reason)}>Save</button>
        </div>
      )}
    </section>
  )
}

/** The Assistant page: after the choice is saved, ask once whether the model solved the task. */
export function AssistantOutcome({ analysisId }: { analysisId: string }) {
  const [state, setState] = useState<'open' | 'saving' | 'done' | 'failed'>('open')
  if (state === 'done') return <p role="status" className="muted">Thanks, your feedback is saved in My progress.</p>
  return (
    <>
      <OutcomeCard question="After using the model, did it solve the task?" title="" disabled={state === 'saving'} onAnswer={async (outcome, reason) => {
        setState('saving')
        try { await putOutcome(analysisId, { outcome, reason: reason ?? null }); setState('done'); notifyProgressChange() } catch (failure) { setState(failure instanceof ApiError && failure.status === 409 ? 'done' : 'failed') }
      }} />
      {state === 'failed' && <p className="api-error" role="alert">Could not save your feedback.</p>}
    </>
  )
}
