import { useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import { CoachingPanel } from './CoachingPanel'

export type Summary = { sessions: number; analyses: number; choices: number; matches: number }
type Point = { session_id: string; title: string; created_at: string; rate: number; choices: number; matches: number }
type Activity = {session_id:string;title:string;analyses:number;choices:number;created_at:string}

type Dashboard = { over: number; under: number; series: Point[] }

export function ProgressDashboard({ summary, onHistory, onExport, onDeleteAll, busy, onReviewPending, pendingContent }: { summary?: Summary; onHistory: () => void; onExport: () => void; onDeleteAll:()=>void; busy: boolean; onReviewPending:()=>void; pendingContent:ReactNode }) {
  const [data, setData] = useState<Dashboard>()
  const [error, setError] = useState('')
  const [activity,setActivity]=useState<Activity[]>([])
  const [chartMode,setChartMode]=useState<'activity'|'match'>('activity')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api<Dashboard>('progress/dashboard', undefined, controller.signal),api<Activity[]>('progress/activity',undefined,controller.signal)]).then(([dashboard,counts])=>{setData(dashboard);setActivity(counts);setError('')})
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load chart') })
    return () => controller.abort()
  }, [summary])
  const rate = summary?.choices ? `${Math.round(summary.matches / summary.choices * 100)}%` : '—'
  const points = data?.series ?? []
  const maxActivity=Math.max(1,...activity.map(item=>item.analyses))
  const pending=summary?summary.analyses-summary.choices:0
  const coordinates = points.map((point, i) => [points.length === 1 ? 450 : 20 + i * 860 / (points.length - 1), 200 - point.rate * 1.8])
  const line = coordinates.map(([x,y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const patterns = [
    {title:'Over-provisioning', count:data?.over, text:'confirmed choices used a larger tier than recommended.', advice:'Review whether extra capacity is needed for the task. The catalogue is illustrative; a larger tier does not establish better quality.'},
    {title:'Under-provisioning', count:data?.under, text:'confirmed choices used a smaller tier than recommended.', advice:'Review the task requirements and uncertainty before choosing less capacity.'},
    {title:'Inflated prompting', count:undefined, text:'Prompt quality and unnecessary context cannot be inferred from length alone.', advice:'Keep relevant constraints and the intended outcome. Personalised analysis of prompting is not implemented yet.'},
  ]
  return <>
    <div className="intro progress-intro"><div><p className="eyebrow">My progress</p><h1>Your judgement over time</h1><p>Understand your model choices and keep the context that helps personalise your experience.</p></div><div className="metric"><strong>{rate}</strong><span>match rate</span><em>{summary ? `${summary.matches} matches · ${summary.choices} confirmed choices` : 'Loading your choices…'}</em></div></div>
    {error && <p className="api-error" role="alert">{error}</p>}
    <div className="progress-metrics"><section className="card"><p>Analyses completed</p><strong>{summary?.analyses??'—'}</strong><span>Saved after every successful analysis</span></section><section className="card"><p>Choices confirmed</p><strong>{summary?.choices??'—'}</strong><span>Used in your match chart and patterns</span></section><section className="card"><p>Choices pending</p><strong>{summary?pending:'—'}</strong><button className="button button-secondary" disabled={busy||!pending} onClick={onReviewPending}>Review pending choices</button></section></div>
    <section className="card chart-card"><div className="card-heading"><div><h2>{chartMode==='activity'?'Analysis activity':'Recommendation match'}</h2><p className="muted">{chartMode==='activity'?'Analyses and confirmed choices in your recent sessions':'Share of confirmed choices that matched the recommendation'}</p></div><span className="period">{chartMode==='activity'?`Last ${activity.length} active sessions`:`${points.length} sessions with confirmed choices`}</span></div>
      <div className="chart-tabs" role="group" aria-label="Progress chart"><button className="button button-secondary" aria-pressed={chartMode==='activity'} onClick={()=>setChartMode('activity')}>Activity</button><button className="button button-secondary" aria-pressed={chartMode==='match'} onClick={()=>setChartMode('match')}>Recommendation match</button></div>
      {chartMode==='activity'?<div className="activity-chart">{activity.length?<><div className="activity-legend"><span>Analyses</span><span>Confirmed choices</span></div><div className="activity-bars">{activity.map((item,index)=><div className="activity-column" key={item.session_id}><div className="activity-bar-pair"><div className="activity-bar analysed" style={{height:`${item.analyses/maxActivity*100}%`}}><span>{item.analyses}</span></div><div className="activity-bar confirmed" style={{height:`${item.choices/maxActivity*100}%`}}><span>{item.choices}</span></div></div><span title={item.title}>Session {index+1}</span></div>)}</div></>:<div className="dashboard-empty"><h3>Your first analysis starts your progress</h3><p>Analyse a task in Assistant. It is saved automatically, even before you confirm a tier.</p></div>}</div>:points.length ? <><div className="chart-wrap"><div className="chart-y"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div><svg className="chart" viewBox="0 0 900 220" preserveAspectRatio="none" role="img" aria-label="Recommendation match by saved session"><g className="grid-lines"><path d="M0 20H900M0 65H900M0 110H900M0 155H900M0 200H900" /></g>{coordinates.length > 1 && <><path className="chart-area" d={`${line} L${coordinates.at(-1)![0]} 220 L20 220 Z`} /><path className="chart-line" d={line} /></>}{coordinates.map(([cx,cy], i) => <circle key={points[i].session_id} cx={cx} cy={cy} r="5"><title>{points[i].title}: {points[i].rate}% ({points[i].matches}/{points[i].choices})</title></circle>)}</svg><div className="chart-x">{points.map((point, i) => <span key={point.session_id} title={point.title}>Session {i+1}</span>)}</div></div><details className="chart-data"><summary>View chart values</summary><ul>{points.map(point => <li key={point.session_id}>{point.title}: {point.rate}% · {point.matches}/{point.choices} choices</li>)}</ul></details></> : <div className="dashboard-empty"><h3>Confirm a choice to build this chart</h3><p>Your analyses are already saved. Confirm a model choice below to calculate agreement; pending choices are never counted as matches.</p>{pending>0&&<button className="button button-primary" disabled={busy} onClick={onReviewPending}>Review {pending} pending choices</button>}</div>}
    </section>
    {pending>0&&pendingContent}
    <div className="section-heading"><div><p className="eyebrow">Patterns</p><h2>What your choices reveal</h2></div><p>Based on {summary?.choices ?? 0} confirmed choices</p></div>
    <div className="pattern-grid">{patterns.map(pattern => <section className="card pattern-card" key={pattern.title}><div className="pattern-top"><span className="pattern-icon" aria-hidden="true">✦</span><span className="pattern-status neutral">{pattern.count === undefined ? 'Not assessed' : summary?.choices ? `${pattern.count} choices` : 'Not enough data'}</span></div><h3>{pattern.title}</h3><p>{pattern.count === undefined ? pattern.text : summary?.choices ? `${pattern.count} ${pattern.text}` : 'Confirm model choices to start seeing your history here.'}</p><div className="next-time"><strong>Next time try…</strong><span>{pattern.advice}</span></div></section>)}</div>
    <CoachingPanel revision={summary} analyses={summary?.analyses??0} />
    <div className="lower-grid">
      <section className="lessons"><div className="section-heading compact"><div><p className="eyebrow">Learning suggestions</p><h2>Build your model judgement</h2></div></div>
        {[{title:'When “more capable” is just more expensive',copy:'Check the capabilities required by the task.',body:'Start with the outcome, required modalities and tools. Compare eligible tiers and review the uncertainty before choosing. This prototype cannot establish price or real-world quality.'},{title:'Context is not the same as complexity',copy:'Separate how much a model must read from how deeply it must reason.',body:'State the audience, important constraints and relevant source material. More words do not necessarily require deeper reasoning. These are general tips; the Groq guidance above uses your actual metadata.'}].map(lesson => <article className="card lesson" key={lesson.title}><span className="lesson-icon" aria-hidden="true">↗</span><div><h3>{lesson.title}</h3><p>{lesson.copy}</p><details><summary>Read guidance</summary><p>{lesson.body}</p></details></div></article>)}
      </section>
      <section className="card data-card"><p className="eyebrow">Privacy controls</p><h2>My data</h2><p>{summary?.sessions ?? 0} sessions · {summary?.analyses ?? 0} analyses · {summary?.choices ?? 0} choices saved to your account.</p><p>Review saved profile metadata and choices, or delete individual sessions below.</p><div className="data-actions"><button className="button button-secondary" disabled={busy} onClick={onHistory}>See</button><button className="button button-secondary" disabled={busy} onClick={onExport}>Export</button><button className="button button-danger" disabled={busy} onClick={onDeleteAll}>Delete…</button></div></section>
    </div>

  </>
}
