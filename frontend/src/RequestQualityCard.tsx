import { useState } from 'react'
import { dismissHint, disputeQuality, notifyProgressChange, type Analysis, type DisputeResult, type QualityDimension } from './api'
import { Card } from './ui'
import { DIMENSION_LABELS } from './MyLearning'
import { EDUCATOR_CARDS } from './educatorCards'
import './RequestQualityCard.css'

// WS4 L1, L10, L5 and L11: how the request is framed, why each score, the Educator hint and
// a dispute backed by a passage of the request. Reasons are shown once and never stored.

const SCORE_WORDS = { 0: 'Missing', 1: 'Partial', 2: 'Clear' } as const
const NOT_RETAINED = 'Reason is not retained in history.'

function Dispute({ analysis, task, dimension, onDone }: { analysis: Analysis; task: string; dimension: QualityDimension; onDone: (result: DisputeResult) => void }) {
  const [open, setOpen] = useState(false)
  const [passage, setPassage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!open) return <button type="button" className="chat-link" onClick={() => setOpen(true)} data-dispute={dimension}>Dispute</button>
  const send = async () => {
    setBusy(true); setError('')
    try { onDone(await disputeQuality(analysis.id, { dimension, task, passage, allow_external: analysis.mode === 'semantic' })); notifyProgressChange() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send the dispute.') }
    finally { setBusy(false) }
  }
  return (
    <div className="quality-dispute" data-dispute-form={dimension}>
      <label>Copy here the part of your message that covers this:
        <textarea value={passage} onChange={event => setPassage(event.target.value)} rows={2} maxLength={1000} />
      </label>
      <p className="muted">Only a passage of your own message counts; a reviewer checks it against this dimension and can raise the score by one level at most.</p>
      <div className="quality-dispute-actions">
        <button type="button" className="button button-secondary" disabled={busy || passage.trim().length < 3} onClick={() => void send()}>Send dispute</button>
        <button type="button" className="chat-link" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="api-error" role="alert">{error}</p>}
    </div>
  )
}

export function RequestQualityCard({ analysis, task }: { analysis: Analysis; task?: string }) {
  const quality = analysis.profile.request_quality
  const [results, setResults] = useState<Partial<Record<QualityDimension, DisputeResult>>>({})
  const [hintGone, setHintGone] = useState(false)
  const [showAdvice, setShowAdvice] = useState(false)
  if (!quality) return null
  const summary = analysis.request_quality_summary
  const hint = !hintGone ? analysis.educator_hint : null
  const names = Object.keys(DIMENSION_LABELS) as QualityDimension[]
  return (
    <Card className="request-quality" data-request-quality="">
      <p className="eyebrow">How you described it</p>
      {summary && <h3 data-quality-summary="">{summary.clear} of {summary.applicable} clear</h3>}
      {hint && (
        <div className="educator-hint" role="note" data-educator-hint={hint.dimension}>
          <p>You often leave out <strong>{DIMENSION_LABELS[hint.dimension].toLowerCase()}</strong> ({hint.hits} of your last {hint.window} tasks), and this message does too. Add it before you send?</p>
          <div className="educator-hint-actions">
            <button type="button" className="chat-link" onClick={() => setShowAdvice(!showAdvice)}>{showAdvice ? 'Hide advice' : 'Why and how'}</button>
            <button type="button" className="chat-link" onClick={() => { setHintGone(true); void dismissHint(hint.key).catch(() => undefined) }} data-dismiss-hint="">Not now</button>
          </div>
          {showAdvice && <div className="educator-advice"><p>{EDUCATOR_CARDS.missing_dimension.why}</p><p>{EDUCATOR_CARDS.missing_dimension.how}</p></div>}
        </div>
      )}
      <table className="quality-table">
        <caption className="sr-only">How clearly the message states each part</caption>
        <tbody>
          {names.map(name => {
            const item = quality[name]
            const result = results[name]
            const score = result ? result.score_after : item.score
            return (
              <tr key={name} data-quality-dimension={name}>
                <th scope="row">{DIMENSION_LABELS[name]}</th>
                <td className={`quality-score score-${score ?? 'na'}`}>{score === null ? 'Not needed' : SCORE_WORDS[score as 0 | 1 | 2]}</td>
                <td className="muted">
                  {item.reason !== NOT_RETAINED && item.reason}
                  {result && <span role="status" data-dispute-result={result.accepted ? 'accepted' : 'refused'}>{result.accepted ? ` Dispute accepted: now ${SCORE_WORDS[result.score_after as 0 | 1 | 2].toLowerCase()}.` : ' Dispute not accepted: the passage does not show more than this.'}</span>}
                </td>
                <td>{task !== undefined && !result && item.score !== null && item.score < 2 && (
                  <Dispute analysis={analysis} task={task} dimension={name} onDone={answer => setResults(current => ({ ...current, [name]: answer }))} />
                )}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
