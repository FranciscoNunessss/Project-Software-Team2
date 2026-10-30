import { useEffect, useRef, useState } from 'react'
import { api, notifyProgressChange, type SavedSession, type HistoryItem, type Resume } from './api'

import { HistoryAnalysis } from './HistoryAnalysis'
import { ProgressDashboard, type Summary } from './ProgressDashboard'
type SessionDetail = SavedSession & { analyses: HistoryItem[] }
const pageSize = 20
const dateLabel = (date: string) => new Date(date).toLocaleString()

export function ProgressScreen({ onResume }: { onResume: (resume: Resume) => void }) {
  const [summary, setSummary] = useState<Summary>()
  const historySection = useRef<HTMLDetailsElement>(null)
  const pendingSection = useRef<HTMLElement>(null)
  const [pending,setPending] = useState<HistoryItem[]>([])
  const [morePending,setMorePending] = useState(false)
  const [updated,setUpdated] = useState<Date>()
  const [refreshing,setRefreshing] = useState(false)
  const refreshRequest = useRef<AbortController|null>(null)
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [selected, setSelected] = useState<SessionDetail>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [moreSessions, setMoreSessions] = useState(false)
  const [moreAnalyses, setMoreAnalyses] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteAll,setDeleteAll]=useState(false)
  const active = useRef<AbortController | null>(null)
  const exportData = async () => {
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    try {
      const [personal,coaching] = await Promise.all([api<{content:string}>('context', undefined, controller.signal),api('progress/coaching',undefined,controller.signal)])
      const all: SessionDetail[] = []
      for (let offset = 0; ; offset += 100) {
        const batch = await api<SavedSession[]>(`sessions?limit=100&offset=${offset}`, undefined, controller.signal)
        for (const session of batch) {
          const analyses: HistoryItem[] = []
          for (let start = 0; ; start += 100) {
            const detail = await api<SessionDetail>(`sessions/${session.id}?limit=100&offset=${start}`, undefined, controller.signal)
            analyses.push(...detail.analyses)
            if (detail.analyses.length < 100) break
          }
          all.push({...session, analyses})
        }
        if (batch.length < 100) break
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify({exported_at:new Date().toISOString(),personal_context:personal,coaching,sessions:all}, null, 2)], {type:'application/json'}))
      const link = document.createElement('a')
      link.href = url; link.download = 'adaptai-my-data.json'; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not export data') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const refresh = async (signal?:AbortSignal) => {
    refreshRequest.current?.abort()
    const controller=new AbortController()
    refreshRequest.current=controller
    const requestSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    setRefreshing(true)
    try {
      const [counts,items,waiting]=await Promise.all([
        api<Summary>('progress',undefined,requestSignal),
        api<SavedSession[]>(`sessions?limit=${pageSize}`,undefined,requestSignal),
        api<HistoryItem[]>(`progress/pending?limit=${pageSize}`,undefined,requestSignal),
      ])
      if(requestSignal.aborted)return
      setSummary(counts);setSessions(items);setMoreSessions(items.length===pageSize)
      setPending(waiting);setMorePending(waiting.length===pageSize);setUpdated(new Date())
    } finally {if(!requestSignal.aborted)setRefreshing(false)}
  }
  useEffect(()=>{
    const controller=new AbortController()
    refresh(controller.signal).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Could not load progress')})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>{controller.abort();refreshRequest.current?.abort();active.current?.abort()}
  },[])
  useEffect(()=>{
    const reload=()=>{
      if(busy||document.visibilityState==='hidden')return
      refresh().then(async()=>{
        if(selected){
          const detail=await api<SessionDetail>(`sessions/${selected.id}?limit=${Math.min(100,Math.max(pageSize,selected.analyses.length))}`)
          setSelected(detail);setMoreAnalyses(detail.analyses.length>=pageSize)
        }
      }).catch(failure=>{if(failure instanceof Error&&failure.name!=='AbortError')setError(failure.message)})
    }
    const storage=(event:StorageEvent)=>{if(event.key==='adaptai-progress-updated')reload()}
    window.addEventListener('focus',reload);window.addEventListener('adaptai-progress-updated',reload)
    window.addEventListener('storage',storage);document.addEventListener('visibilitychange',reload)
    return()=>{window.removeEventListener('focus',reload);window.removeEventListener('adaptai-progress-updated',reload);window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',reload)}
  },[busy,selected?.id,selected?.analyses.length])
  const confirm = async (item:HistoryItem,candidate:string) => {
    setBusy(true);setError('')
    try {
      await api('decisions',{analysis_id:item.result.id,candidate_id:candidate})
      setSelected(previous=>previous?{...previous,analyses:previous.analyses.map(row=>row.result.id===item.result.id?{...row,candidate_id:candidate}:row)}:previous)
      await refresh();notifyProgressChange()
    }catch(failure){setError(failure instanceof Error?failure.message:'Could not save choice');await refresh().catch(()=>{})}
    finally{setBusy(false)}
  }
  const loadPending = async () => {
    setBusy(true);setError('')
    try {const page=await api<HistoryItem[]>(`progress/pending?limit=${pageSize}&offset=${pending.length}`);setPending(previous=>[...previous,...page]);setMorePending(page.length===pageSize)}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not load pending choices')}
    finally{setBusy(false)}
  }
  const open = async (id: string) => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(''); setDeleting(false); setSelected(undefined)
    try {
      const detail = await api<SessionDetail>(`sessions/${id}?limit=${pageSize}`, undefined, controller.signal)
      if (!controller.signal.aborted) { setSelected(detail); setMoreAnalyses(detail.analyses.length === pageSize) }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load session') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const loadMore = async (analyses: boolean) => {
    setBusy(true); setError('')
    const controller = new AbortController()
    active.current = controller
    try {
      if (analyses && selected) {
        const detail = await api<SessionDetail>(`sessions/${selected.id}?limit=${pageSize}&offset=${selected.analyses.length}`, undefined, controller.signal)
        setSelected({ ...selected, analyses: [...selected.analyses, ...detail.analyses] })
        setMoreAnalyses(detail.analyses.length === pageSize)
      } else {
        const items = await api<SavedSession[]>(`sessions?limit=${pageSize}&offset=${sessions.length}`, undefined, controller.signal)
        setSessions(previous => [...previous, ...items]); setMoreSessions(items.length === pageSize)
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load history') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const remove = async () => {
    if (!selected) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    try {
      await api(`sessions/${selected.id}`, undefined, controller.signal, 'DELETE')
      setSelected(undefined); setDeleting(false)
      await refresh(controller.signal);notifyProgressChange()
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not delete session') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const clearAll=async()=>{
    setBusy(true);setError('')
    try {await api('progress/history',undefined,undefined,'DELETE');setSelected(undefined);setDeleteAll(false);await refresh();notifyProgressChange()}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not clear history')}
    finally{setBusy(false)}
  }
  return <main className="page progress-page">
    <div className="progress-refresh"><span role="status">{busy?'Updating your data…':refreshing?'Updating progress…':updated?`Updated ${updated.toLocaleTimeString()}`:'Loading progress…'}</span><button className="button button-secondary" disabled={busy||refreshing} onClick={()=>{setError('');void refresh().catch(failure=>setError(failure instanceof Error?failure.message:'Refresh failed'))}}>Refresh</button></div>
    <ProgressDashboard summary={summary} busy={busy} onExport={()=>void exportData()} onDeleteAll={()=>setDeleteAll(true)} onReviewPending={()=>pendingSection.current?.scrollIntoView({behavior:'smooth',block:'start'})} onHistory={()=>{if(historySection.current){historySection.current.open=true;historySection.current.scrollIntoView({behavior:'smooth',block:'start'})}}} pendingContent={<section className="card pending-choices" ref={pendingSection} aria-labelledby="pending-title"><div className="card-heading"><div><p className="eyebrow">Next step</p><h2 id="pending-title">Choices to confirm ({summary?summary.analyses-summary.choices:0})</h2></div></div><p>Analyses are saved automatically. Confirm your actual model choices here to build your match chart and patterns.</p>{pending.map(item=><HistoryAnalysis key={item.result.id} item={item} busy={busy} onConfirm={(row,candidate)=>void confirm(row,candidate)} onOpen={()=>onResume({sessionId:item.result.session_id,analysis:item})} />)}{morePending&&<button className="button button-secondary" disabled={busy} onClick={()=>void loadPending()}>Load more pending choices</button>}{!pending.length&&!loading&&<p className="muted">No choices waiting for confirmation.</p>}</section>} />

    {loading && <p role="status">Loading your progress…</p>}
    {error && <p className="api-error" role="alert">{error}</p>}
    {deleteAll&&<section className="card delete-history-confirmation" role="alert" aria-labelledby="delete-history-title"><h2 id="delete-history-title">Delete all usage history?</h2><p>This permanently removes your sessions, assessments, choices, learned memory and generated coaching. Your account, saved preferences and LLM configurations remain. Export your data first if you want a copy.</p><div className="history-actions"><button className="button button-danger" disabled={busy} onClick={()=>void clearAll()}>Delete all usage history permanently</button><button className="button button-secondary" disabled={busy} onClick={()=>setDeleteAll(false)}>Cancel</button></div></section>}
    <details className="progress-history" ref={historySection} onToggle={event=>{if(event.currentTarget.open&&!selected&&!busy&&sessions[0])void open(sessions[0].id)}}><summary>Saved history · {summary?.sessions ?? 0} sessions</summary>
    <div className="section-heading"><div><p className="eyebrow">Saved work</p><h2>Session history</h2></div></div>
    {!loading && sessions.length === 0 && !error && <section className="card history-empty"><IconPlaceholder /><h2>Your history starts here</h2><p>Analyse a task in Assistant. Its profile and confirmed choice will appear here. Conversation text is saved only with permission in Profile.</p></section>}
    <div className="history-layout">
      <div className="history-sessions">{sessions.map(session => <button key={session.id} className={`card history-session ${selected?.id === session.id ? 'is-selected' : ''}`} disabled={busy} onClick={() => void open(session.id)}><strong>Session · {dateLabel(session.created_at)}</strong><span>{session.analysis_count??0} analyses · {session.choice_count??0} choices confirmed</span><span>{selected?.id === session.id ? 'Viewing session' : 'View history →'}</span></button>)}{moreSessions && <button className="button button-secondary" disabled={busy} onClick={() => void loadMore(false)}>Load more sessions</button>}</div>
      {selected && <section className="card history-detail" aria-labelledby="session-title">
        <div className="history-detail-heading"><div><p className="eyebrow">Session details</p><h2 id="session-title">Session · {dateLabel(selected.created_at)}</h2></div><button className="button button-secondary" disabled={busy} onClick={() => onResume({ sessionId: selected.id })}>Continue in Assistant</button></div>
        {selected.context && <details className="history-context"><summary>Saved context</summary><p>{selected.context}</p></details>}
        {selected.analyses.length === 0 && <p>No completed analyses in this session yet.</p>}
        {selected.analyses.map(item=><HistoryAnalysis key={item.result.id} item={item} busy={busy} onConfirm={(row,candidate)=>void confirm(row,candidate)} onOpen={()=>onResume({sessionId:selected.id,analysis:item})} />)}
        {moreAnalyses && <button className="button button-secondary" disabled={busy} onClick={() => void loadMore(true)}>Load more analyses</button>}
        <div className="history-delete">{deleting ? <><p>Delete this session, its analyses and choices? This cannot be undone.</p><div className="history-actions"><button className="button button-danger" disabled={busy} onClick={() => void remove()}>Delete permanently</button><button className="button button-secondary" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button></div></> : <button className="button button-danger" disabled={busy} onClick={() => setDeleting(true)}>Delete session</button>}</div>
      </section>}
      {busy && <p role="status">Loading…</p>}
    </div>
    </details>
    <p className="confidence-note">Matching a recommendation measures agreement with this prototype, not the quality of your decision. Groq guidance follows your Profile permissions, may include opted-in conversation excerpts, and remains advice to review.</p>
  </main>
}

function IconPlaceholder() { return <span className="auth-symbol" aria-hidden="true">↗</span> }
