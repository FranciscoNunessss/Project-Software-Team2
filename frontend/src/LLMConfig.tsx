import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type LLMConfiguration, type LLMOptions } from './api'

type ProviderId = LLMConfiguration['provider']
type ModelForm = {label:string; provider:ProviderId; model:string; api_key:string; responses_api:boolean; enabled:boolean; is_default:boolean}
const providers: {id:ProviderId;name:string;mark:string;description:string;endpoint:string}[] = [
  {id:'groq',name:'Groq',mark:'G',description:'The project default, managed centrally. No personal credentials needed.',endpoint:'https://api.groq.com/openai/v1'},
  {id:'claude',name:'Claude',mark:'C',description:'Connect an Anthropic model with your own account.',endpoint:'https://api.anthropic.com'},
  {id:'openai',name:'OpenAI / Codex',mark:'O',description:'Use an OpenAI model available to your API account.',endpoint:'https://api.openai.com'},
  {id:'ollama',name:'Ollama',mark:'L',description:'Use a model installed on the backend machine.',endpoint:'http://127.0.0.1:11434'},
]
const emptyForm = (provider:ProviderId):ModelForm => ({label:`My ${providers.find(item=>item.id===provider)?.name}`,provider,model:'',api_key:'',responses_api:false,enabled:true,is_default:false})

export function LLMConfigScreen() {
  const [items,setItems] = useState<LLMConfiguration[]>([])
  const [server,setServer] = useState<LLMOptions['options']>([])
  const [selected,setSelected] = useState<ProviderId|null>(null)
  const [form,setForm] = useState<ModelForm|null>(null)
  const [editing,setEditing] = useState<string>()
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [message,setMessage] = useState('')
  const [deleting,setDeleting] = useState<string>()
  const dialog = useRef<HTMLDialogElement>(null)
  const load = async (signal?:AbortSignal) => {
    const [configs,options] = await Promise.all([api<LLMConfiguration[]>('llm-configs',undefined,signal),api<LLMOptions>('llm-options',undefined,signal)])
    setItems(configs);setServer(options.options.filter(item=>item.source==='server'))
  }
  useEffect(()=>{const controller=new AbortController();load(controller.signal).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Could not load providers')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[])
  useEffect(()=>{
    if(selected && dialog.current && !dialog.current.open) dialog.current.showModal()
    if(!selected) dialog.current?.close()
  },[selected])
  const close = () => {setSelected(null);setForm(null);setEditing(undefined);setDeleting(undefined);setError('');setMessage('')}
  const open = (id:ProviderId) => {
    setSelected(id);setEditing(undefined);setDeleting(undefined);setError('');setMessage('')
    const configured=items.some(item=>item.provider===id) || server.some(item=>item.provider===id)
    setForm(id!=='groq'&&!configured?emptyForm(id):null)
  }
  const submit = async (event:FormEvent) => {
    event.preventDefault();if(!form)return
    setBusy(true);setError('');setMessage('')
    try {await api(editing?`llm-configs/${editing}`:'llm-configs',{...form,api_key:form.api_key||undefined},undefined,editing?'PUT':'POST');setForm(null);setEditing(undefined);await load();setMessage('Model saved. Select it in Assistant when you want to use it.')}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not save model')}
    finally{setBusy(false)}
  }
  const edit = (item:LLMConfiguration) => {setEditing(item.id);setForm({label:item.label,provider:item.provider,model:item.model,api_key:'',responses_api:item.responses_api,enabled:item.enabled,is_default:item.is_default});setError('');setMessage('')}
  const test = async (item:LLMConfiguration) => {
    setBusy(true);setError('');setMessage('')
    try{await api(`llm-configs/${item.id}/test`,{});setMessage(`${item.label}: connection and structured assessment succeeded.`)}
    catch(failure){setError(failure instanceof Error?failure.message:'Connection test failed')}
    finally{setBusy(false)}
  }
  const remove = async (item:LLMConfiguration) => {
    setBusy(true);setError('');setMessage('')
    try{await api(`llm-configs/${item.id}`,undefined,undefined,'DELETE');if(editing===item.id){setEditing(undefined);setForm(null)}setDeleting(undefined);await load();setMessage('Personal model and its saved credential removed.')}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not remove model')}
    finally{setBusy(false)}
  }
  const activeProvider=providers.find(item=>item.id===selected)
  const personal=items.filter(item=>item.provider===selected)
  const shared=server.filter(item=>item.provider===selected)
  return <main className="page llm-config-page">
    <div className="intro"><div><p className="eyebrow">LLM config</p><h1>Ready by default. More when you need it.</h1><p>Groq powers the project's default assessments. Connecting another provider is optional.</p></div></div>
    <div className="provider-overview"><span className="provider-overview-mark" aria-hidden="true">G</span><div><strong>Auto uses the project Groq model</strong><p>Use it straight away, or select a personal model in Assistant. Intelligent routing comes later.</p></div></div>
    {loading&&<p role="status">Loading providers…</p>}{!selected&&error&&<p className="api-error" role="alert">{error}</p>}
    <div className="provider-grid">{providers.map(provider=>{
      const accounts=items.filter(item=>item.provider===provider.id)
      const configured=server.some(item=>item.provider===provider.id)||(provider.id!=='groq'&&accounts.some(item=>item.enabled))
      const project=provider.id==='groq'
      const label=loading?'Loading…':configured?(project?'Project default':'Configured'):accounts.length?'Disabled':'Not configured'
      return <button key={provider.id} className={`card provider-tile provider-${provider.id}`} disabled={loading} onClick={()=>open(provider.id)} aria-label={`${provider.name} · ${label}`}>
        <div className="provider-tile-top"><span className="provider-mark" aria-hidden="true">{provider.mark}</span><span className={`provider-status ${configured?'is-ready':''}`}><i aria-hidden="true" />{label}</span></div>
        <h2>{provider.name}</h2><p>{provider.description}</p><div className="provider-tile-bottom"><span>{project?'View project model':accounts.length||configured?'Manage models':'Connect provider'}</span><span aria-hidden="true">↗</span></div>
      </button>
    })}</div>
    <p className="provider-footnote">Configured means settings are saved. Use Test connection to verify a personal model. Provider availability and quota depend on the selected account.</p>
    <details className="provider-notes"><summary>How project models and personal models work</summary><p>Groq is managed by the project. Optional personal credentials belong to your account and are stored encrypted. Auto stays on project Groq even after you add another model. No provider is selected silently after a failure.</p><p>My progress currently calculates its dashboard from stored metadata. Groq-based longitudinal coaching and routing between models are future features.</p></details>
    <dialog ref={dialog} className="provider-dialog" aria-labelledby="provider-dialog-title" onCancel={event=>{if(busy){event.preventDefault()}else{close()}}}>
      {activeProvider&&<div className="provider-dialog-content"><div className="provider-dialog-heading"><div><p className="eyebrow">{selected==='groq'?'Project model':'Optional provider'}</p><h2 id="provider-dialog-title">{activeProvider.name}</h2></div><button type="button" className="dialog-close" aria-label="Close provider settings" disabled={busy} onClick={close}>×</button></div>
        {error&&<p className="api-error" role="alert">{error}</p>}{message&&<p className="confidence-note" role="status">{message}</p>}
        {selected==='groq'?<><p>Groq is configured centrally for this project. You do not need to add an API key.</p>{shared.length?shared.map(item=><section className="provider-shared" key={item.id}><span className="provider-status is-ready">Project default</span><h3>{item.model}</h3><p>Used by Auto in Assistant. Settings are managed by the project administrator.</p></section>):<p className="api-error">The project Groq model is not configured. Ask the project administrator to enable it, or choose another configured model manually.</p>}<p className="muted">Groq also updates your personalised suggestions in My progress when automatic learning suggestions are enabled in Profile. Statistics are calculated from your saved choices.</p></>:<>
          {shared.map(item=><section className="provider-shared" key={item.id}><p className="eyebrow">Available from the project</p><h3>{item.model}</h3><p>This model is ready to select in Assistant. No personal key is required.</p></section>)}
          {personal.map(item=><section className="provider-model" key={item.id}><div className="card-heading"><div><h3>{item.label}</h3><p>{item.model}</p></div><span className="period">{item.enabled?'Enabled':'Disabled'}</span></div><div className="history-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>edit(item)}>Edit</button><button type="button" className="button button-secondary" disabled={busy} onClick={()=>void test(item)}>Test connection</button>{deleting===item.id?<><button type="button" className="button button-danger" disabled={busy} onClick={()=>void remove(item)}>Confirm removal</button><button type="button" className="button button-secondary" disabled={busy} onClick={()=>setDeleting(undefined)}>Cancel</button></>:<button type="button" className="button button-danger" disabled={busy} onClick={()=>setDeleting(item.id)}>Remove</button>}</div></section>)}
          {!form&&<button type="button" className="button button-primary provider-add" disabled={busy} onClick={()=>{setForm(emptyForm(selected!));setEditing(undefined)}}>{personal.length?'Add another model':'Connect my account'}</button>}
          {form&&<form className="llm-form" onSubmit={submit}><h3>{editing?'Edit model':'Connect your model'}</h3>
            <label htmlFor="llm-label">Display name</label><input id="llm-label" value={form.label} required maxLength={80} disabled={busy} onChange={event=>setForm({...form,label:event.target.value})} />
            <label htmlFor="llm-model">Model ID</label><input id="llm-model" value={form.model} required maxLength={200} disabled={busy} onChange={event=>setForm({...form,model:event.target.value})} placeholder="Exact model ID available to your account" />
            {selected!=='ollama'&&<><label htmlFor="llm-key">{editing?'Replace API key (optional)':'API key'}</label><input id="llm-key" type="password" autoComplete="new-password" value={form.api_key} required={!editing} maxLength={4096} disabled={busy} onChange={event=>setForm({...form,api_key:event.target.value})} placeholder={editing?'Leave blank to keep the saved key':'Paste your provider API key'} /></>}
            {selected==='openai'&&<label className="consent"><input type="checkbox" checked={form.responses_api} disabled={busy} onChange={event=>setForm({...form,responses_api:event.target.checked})} />Use Responses API (for compatible models, including Codex)</label>}
            <label className="consent"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={event=>setForm({...form,enabled:event.target.checked,is_default:false})} />Enable this model in Assistant</label>
            <p className="muted">{selected==='ollama'?'Ollama must run on the backend machine. No API key is required.':'Keys are stored encrypted and are never returned to this form.'} Saving does not call a provider.</p>
            <div className="history-actions"><button className="button button-primary" disabled={busy}>{busy?'Saving…':'Save model'}</button><button type="button" className="button button-secondary" disabled={busy} onClick={()=>{setForm(null);setEditing(undefined)}}>Cancel</button></div>
          </form>}
          <p className="provider-dialog-note">Test connection sends a synthetic task and may consume provider quota. Endpoint: {activeProvider.endpoint}.</p>
        </>}
      </div>}
    </dialog>
  </main>
}
