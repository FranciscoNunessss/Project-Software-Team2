import { tierOf, type HistoryItem } from './api'

export function HistoryAnalysis({item,busy,onConfirm,onOpen}:{item:HistoryItem;busy:boolean;onConfirm:(item:HistoryItem,candidate:string)=>void;onOpen:()=>void}) {
  const candidates=[item.result.recommendation,...item.result.alternatives]
  const chosen=candidates.find(candidate=>candidate.id===item.candidate_id)
  return <article className="history-analysis">
    <p className="eyebrow">{new Date(item.created_at).toLocaleString()} · {item.result.provider}</p>
    <div className="card-heading"><h3>Assessment {item.result.id.slice(0,8)}</h3><span className={`period ${chosen?'choice-saved':'choice-pending'}`}>{chosen?'Choice saved':'Choice pending'}</span></div>
    <dl><div><dt>Recommended</dt><dd>{tierOf(item.result.recommendation)}</dd></div><div><dt>Your choice</dt><dd>{chosen?tierOf(chosen):'Not confirmed'}</dd></div></dl>
    {!chosen&&<div className="pending-choice-actions"><p>Confirm the tier you would use. This updates your chart and patterns.</p><div className="history-actions">{candidates.map(candidate=><button className={`button ${candidate.id===item.result.recommendation.id?'button-primary':'button-secondary'}`} disabled={busy} key={candidate.id} onClick={()=>onConfirm(item,candidate.id)}>Confirm {tierOf(candidate)}{candidate.id===item.result.recommendation.id?' · recommended':''}</button>)}</div></div>}
    <button className="button button-secondary" disabled={busy} onClick={onOpen}>View profile</button>
  </article>
}
