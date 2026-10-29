import { useEffect, useState } from 'react'
import { api } from './api'

type Report = {report:{summary:string;suggestions:{title:string;explanation:string;action:string}[]};model:string;updated_at:string;stale:boolean}
type CoachingState = {configured:boolean;model:string;saved:Report|null;automatic_enabled:boolean;generating:boolean;error:string|null}

export function CoachingPanel({revision,analyses}:{revision:unknown;analyses:number}) {
  const [state,setState]=useState<CoachingState>()
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>|undefined
    const load=async()=>{
      try {
        const value=await api<CoachingState>('progress/coaching',undefined,controller.signal)
        if(controller.signal.aborted)return
        setState(value);setError(value.error?'Automatic guidance could not be updated. Retry below, or check your project Groq configuration and quota.':'')
        if(value.generating)timer=setTimeout(()=>void load(),2000)
      }catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Could not load coaching')}
    }
    void load()
    return()=>{controller.abort();clearTimeout(timer)}
  },[revision])
  const generate=async()=>{
    if(!state)return
    setBusy(true);setError('')
    try {const saved=await api<Report>('progress/coaching',{allow_external:true,expected_model:state.model});setState({...state,saved,error:null,generating:false})}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not generate guidance')}
    finally{setBusy(false)}
  }
  return <section className="card personal-coaching" aria-labelledby="coaching-title"><div className="card-heading"><div><p className="eyebrow">Personalised learning</p><h2 id="coaching-title">Guidance from your history</h2></div><span className="period">Groq</span></div>
    <p>Generate suggestions from your latest 50 assessment profiles and model choices. Raw tasks, personal preferences and API keys are not included.</p>
    <p className="muted" role="status">{state?.generating?'Updating suggestions automatically…':state?.automatic_enabled?'Automatic updates are enabled in Profile. New analyses and confirmed choices update your suggestions.':'Automatic updates are off. Enable them in Profile, or generate suggestions below.'}</p>
    {!analyses&&<p className="muted">Analyse a task first. You can request guidance before confirming choices, but it will have less evidence.</p>}
    {state&&!state.configured&&<p className="api-error">Project Groq is not configured. Your dashboard and history remain available.</p>}
    {error&&<p role="alert" className="api-error">{error}</p>}
    {state?.saved&&<div className={state.saved.stale?'coaching-report is-stale':'coaching-report'}><p className="eyebrow">{state.saved.stale?'New history available · update this guidance':'Based on your saved history'} · {new Date(state.saved.updated_at).toLocaleString()}</p><p>{state.saved.report.summary}</p><div className="coaching-suggestions">{state.saved.report.suggestions.map((suggestion,index)=><article key={index}><h3>{suggestion.title}</h3><p>{suggestion.explanation}</p><div className="next-time"><strong>Next step</strong><span>{suggestion.action}</span></div></article>)}</div></div>}
    <button className="button button-primary" disabled={busy||state?.generating||!state?.configured||!analyses||(!!state.saved&&!state.saved.stale)} onClick={()=>void generate()}>{busy||state?.generating?'Generating guidance…':error?'Retry guidance with Groq':state?.saved?.stale?'Update guidance with Groq':state?.saved?'Guidance is up to date':'Generate guidance with Groq'}</button>
    <p className="muted">Automatic updates enabled in Profile and manual updates send derived usage metadata to Groq ({state?.model||'project model'}) and may consume provider quota. Saved guidance is reused until your history changes.</p>
  </section>
}
