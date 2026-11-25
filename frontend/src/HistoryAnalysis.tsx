import { useEffect, useState } from 'react'
import { candidateLabel, notifyProgressChange, setTaskExcluded, type HistoryItem } from './api'
import './HistoryAnalysis.css'

/** WS4 L17: leave this task out of "How you use AI", or count it again. Only where the history says which. */
function LearningToggle({ item }: { item: HistoryItem }) {
  const [excluded, setExcluded] = useState(item.excluded === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setExcluded(item.excluded === true), [item.excluded])
  const toggle = async () => {
    setSaving(true); setError('')
    try { await setTaskExcluded(item.result.id, !excluded); setExcluded(!excluded); notifyProgressChange() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change this task.') }
    finally { setSaving(false) }
  }
  return (
    <div className="history-learning" data-history-learning={excluded ? 'excluded' : 'counted'}>
      {excluded && <p className="muted">Left out of your learning: this task does not count in "How you use AI".</p>}
      <button type="button" className="button button-secondary" disabled={saving} onClick={() => void toggle()} data-learning-exclude="">
        {excluded ? 'Count again' : 'Leave out of my learning'}
      </button>
      {error && <p className="api-error" role="alert">{error}</p>}
    </div>
  )
}

export function HistoryAnalysis({item,busy,onConfirm,onOpen}:{item:HistoryItem;busy:boolean;onConfirm:(item:HistoryItem,candidate:string)=>void;onOpen:()=>void}) {
  const candidates=[item.result.recommendation,...item.result.alternatives]
  const chosen=candidates.find(candidate=>candidate.id===item.candidate_id)
  return <article className="history-analysis">
    <p className="eyebrow">{new Date(item.created_at).toLocaleString()} · {item.result.provider}</p>
    <div className="card-heading"><h3>Assessment {item.result.id.slice(0,8)}</h3><span className={`period ${chosen?'choice-saved':'choice-pending'}`}>{chosen?'Choice saved':'Choice pending'}</span></div>
    <dl><div><dt>Recommended</dt><dd>{candidateLabel(item.result.recommendation)}</dd></div><div><dt>Your choice</dt><dd>{chosen?candidateLabel(chosen):'Not confirmed'}</dd></div></dl>
    {item.conversation&&<details className="saved-conversation"><summary>Saved conversation · stored with your permission</summary><h4>Your task</h4><p>{item.conversation.task}</p>{item.conversation.task_context&&<><h4>Task context</h4><p>{item.conversation.task_context}</p></>}<h4>AI assessment</h4><p>{item.conversation.response.profile.explanation}</p><p>{item.conversation.response.rationale}</p></details>}
    {!chosen&&<div className="pending-choice-actions"><p>Confirm the model you would use. This updates your chart and patterns.</p><div className="history-actions">{candidates.map(candidate=><button className={`button ${candidate.id===item.result.recommendation.id?'button-primary':'button-secondary'}`} disabled={busy} key={candidate.id} onClick={()=>onConfirm(item,candidate.id)}>Confirm {candidateLabel(candidate)}{candidate.id===item.result.recommendation.id?' · recommended':''}</button>)}</div></div>}
    <div className="history-actions"><button className="button button-secondary" disabled={busy} onClick={onOpen}>View profile</button>{item.excluded !== undefined && <LearningToggle item={item} />}</div>
  </article>
}
