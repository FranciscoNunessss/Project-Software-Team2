import { useEffect, useState } from 'react'
import { api, type MemorySettings } from './api'

export function ProfileScreen() {
  const [settings, setSettings] = useState<MemorySettings>()
  const [content, setContent] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [forget, setForget] = useState(false)
  const [forgetConversations, setForgetConversations] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api<MemorySettings>('context', undefined, controller.signal), api<{email:string}>('auth/me', undefined, controller.signal)])
      .then(([memory, user]) => {setSettings(memory); setContent(memory.content); setEmail(user.email)})
      .catch(failure => {if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load profile')})
    return () => controller.abort()
  }, [])
  const update = async (changes: Partial<Pick<MemorySettings,'content'|'save_enabled'|'use_enabled'|'coaching_auto_enabled'|'conversation_memory_enabled'>>) => {
    setBusy(true); setError(''); setMessage('')
    try {const saved = await api<MemorySettings>('context',changes,undefined,'PUT');setSettings(saved);if ('content' in changes) setContent(saved.content);setMessage('Settings saved.')}
    catch(failure) {setError(failure instanceof Error ? failure.message : 'Could not save settings')}
    finally {setBusy(false)}
  }
  const clear = async () => {
    setBusy(true);setError('');setMessage('')
    try {setSettings(await api<MemorySettings>('context/memory',undefined,undefined,'DELETE'));setForget(false);setMessage('Learned memory cleared. Progress history and your preferences are unchanged.')}
    catch(failure) {setError(failure instanceof Error ? failure.message : 'Could not clear memory')}
    finally {setBusy(false)}
  }
  const clearConversations = async () => {
    setBusy(true);setError('');setMessage('')
    try {setSettings(await api<MemorySettings>('context/conversations',undefined,undefined,'DELETE'));setForgetConversations(false);setMessage('Saved conversation text and derived coaching cleared. Assessment metadata and choices remain.')}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not delete conversations')}
    finally{setBusy(false)}
  }
  return <main className="page profile-page"><div className="intro"><div><p className="eyebrow">Profile & settings</p><h1>Your profile. Your control.</h1><p>Manage preferences, memory and how your saved information is used.</p></div></div>
    {error && <p className="api-error" role="alert">{error}</p>}{message && <p role="status" className="confidence-note">{message}</p>}
    {!settings && !error && <p role="status">Loading profile…</p>}
    {settings && <>
      <section className="card profile-card-settings"><p className="eyebrow">Account</p><h2>{email}</h2><p>Your preferences and usage metadata belong to this account.</p></section>
      <section className="card profile-card-settings"><p className="eyebrow">Personalisation</p><h2>Memory between sessions</h2><p>This memory keeps derived complexity scores and model choices. Conversation text has its own optional control below.</p>
        <label className="settings-switch"><span><strong>Save memory between sessions</strong><small>Update learned memory after new analyses and choices. Turning this off keeps existing memory.</small></span><input type="checkbox" role="switch" checked={settings.save_enabled} disabled={busy} onChange={event => void update({save_enabled:event.target.checked})} /></label>
        <label className="settings-switch"><span><strong>Use memory in recommendations</strong><small>Use preferences and recent learned metadata. Saved conversation excerpts are also used only when their separate permission below is enabled. The Assistant follows these settings automatically.</small></span><input type="checkbox" role="switch" checked={settings.use_enabled} disabled={busy} onChange={event => void update({use_enabled:event.target.checked})} /></label>
        <p className="muted">Saving and using memory are separate. Selecting Analyse sends the task and enabled memory to your selected assessment provider.</p>
      </section>
      <section className="card profile-card-settings"><p className="eyebrow">Optional conversation memory</p><h2>Save conversations for personalisation</h2>
        <label className="settings-switch"><span><strong>Save task text and AI responses</strong><small>Store new task text, additional context and AI assessment responses in this project's local database. With Use memory enabled, up to 5 bounded excerpts can be sent to the selected Assistant provider and to project Groq for personalised guidance and provisional prompt analysis. Automatic Groq updates follow the separate setting below. This does not train the model.</small></span><input type="checkbox" role="switch" checked={settings.conversation_memory_enabled} disabled={busy} onChange={event=>void update({conversation_memory_enabled:event.target.checked})} /></label>
        <p className="muted">Off by default. Turning this off stops future text saving and reuse; existing saved conversations remain available to review or delete. Old task text that was never saved cannot be recovered. Avoid entering passwords or API keys in tasks.</p>
        <p className="muted">{settings.saved_conversations} saved conversations. Review and export them in My progress.</p>
        <div className="history-delete">{forgetConversations?<><p>Permanently delete saved conversation text, AI responses and generated coaching? Numeric history and choices remain. New conversations can still be saved if the switch stays on.</p><div className="history-actions"><button className="button button-danger" disabled={busy} onClick={()=>void clearConversations()}>Delete saved conversations permanently</button><button className="button button-secondary" disabled={busy} onClick={()=>setForgetConversations(false)}>Cancel</button></div></>:<button className="button button-danger" disabled={busy||!settings.saved_conversations} onClick={()=>setForgetConversations(true)}>Delete saved conversations…</button>}</div>
      </section>
      <section className="card profile-card-settings"><p className="eyebrow">My progress</p><h2>Automatic learning suggestions</h2>
        <label className="settings-switch"><span><strong>Automatically update suggestions with Groq</strong><small>Send your latest 50 derived assessment profiles and confirmed choices to project Groq after history changes, including existing history when enabled. Up to 5 saved conversation excerpts are included only when both text saving and Use memory are enabled above. Saved preferences and provider keys are excluded. Suggestions are saved to your account; provider quota may be used.</small></span><input type="checkbox" role="switch" checked={settings.coaching_auto_enabled} disabled={busy} onChange={event=>void update({coaching_auto_enabled:event.target.checked})} /></label>
        <p className="muted">This is separate from Assistant memory. Turning it off pauses new suggestions and keeps existing ones. When enabled, My progress updates automatically after new analyses and confirmed choices.</p>
      </section>
      <section className="card personal-context"><div className="card-heading"><div><p className="eyebrow">Preferences</p><h2>What should AdaptAI know about you?</h2></div></div><p>Optional preferences you choose to save, such as language, experience and explanation style. Avoid confidential project or task details.</p><label htmlFor="profile-preferences">Your preferences</label><textarea id="profile-preferences" value={content} maxLength={4000} disabled={busy} onChange={event => setContent(event.target.value)} placeholder="For example: I prefer Portuguese and concise explanations. I am learning software engineering." /><div className="context-save"><span>{content.length}/4,000 characters</span><button className="button button-primary" disabled={busy || content===settings.content} onClick={() => void update({content})}>Save preferences</button></div></section>
      <section className="card profile-card-settings"><p className="eyebrow">Transparency</p><h2>Learned memory</h2><p>Recent metadata available to the Assistant (up to 20 entries). Model-generated profiles remain provisional.</p>
        {!settings.memory.length && <div className="dashboard-empty"><h3>No learned memory yet</h3><p>Enable saving and analyse a task to start building it.</p></div>}
        {settings.memory.map((entry,index) => <details className="memory-entry" key={entry.analysis_id}><summary>Assessment {index+1} · recommended tier {entry.recommended_capacity} · {entry.chosen_capacity ? `chosen tier ${entry.chosen_capacity}` : 'choice pending'}</summary><dl>{Object.entries(entry.profile).map(([dimension,value]) => <div key={dimension}><dt>{dimension}</dt><dd>{value===null?'Undetermined':Array.isArray(value)?value.join(', '):value}</dd></div>)}</dl></details>)}
        <div className="history-delete">{forget ? <><p>Clear all learned memory? This cannot be undone. Your progress history and manually saved preferences remain available.</p><div className="history-actions"><button className="button button-danger" disabled={busy} onClick={() => void clear()}>Clear learned memory</button><button className="button button-secondary" disabled={busy} onClick={() => setForget(false)}>Cancel</button></div></> : <button className="button button-danger" disabled={busy || !settings.memory.length} onClick={() => setForget(true)}>Clear learned memory…</button>}</div>
      </section>
      <p className="confidence-note">My progress contains your dashboard, saved suggestions, export and session deletion controls. Conversation text is retained only after explicit permission. Clearing learned metadata above does not delete saved conversation text.</p>
    </>}
  </main>
}
