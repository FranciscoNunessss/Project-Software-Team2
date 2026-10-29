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
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api<MemorySettings>('context', undefined, controller.signal), api<{email:string}>('auth/me', undefined, controller.signal)])
      .then(([memory, user]) => {setSettings(memory); setContent(memory.content); setEmail(user.email)})
      .catch(failure => {if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load profile')})
    return () => controller.abort()
  }, [])
  const update = async (changes: Partial<Pick<MemorySettings,'content'|'save_enabled'|'use_enabled'|'coaching_auto_enabled'>>) => {
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
  return <main className="page profile-page"><div className="intro"><div><p className="eyebrow">Profile & settings</p><h1>Your profile. Your control.</h1><p>Manage preferences, memory and how your saved information is used.</p></div></div>
    {error && <p className="api-error" role="alert">{error}</p>}{message && <p role="status" className="confidence-note">{message}</p>}
    {!settings && !error && <p role="status">Loading profile…</p>}
    {settings && <>
      <section className="card profile-card-settings"><p className="eyebrow">Account</p><h2>{email}</h2><p>Your preferences and usage metadata belong to this account.</p></section>
      <section className="card profile-card-settings"><p className="eyebrow">Personalisation</p><h2>Memory between sessions</h2><p>Memory keeps derived complexity scores and model choices. It never keeps your task text or task-specific context.</p>
        <label className="settings-switch"><span><strong>Save memory between sessions</strong><small>Update learned memory after new analyses and choices. Turning this off keeps existing memory.</small></span><input type="checkbox" role="switch" checked={settings.save_enabled} disabled={busy} onChange={event => void update({save_enabled:event.target.checked})} /></label>
        <label className="settings-switch"><span><strong>Use memory in recommendations</strong><small>Use your preferences and recent learned metadata. The Assistant follows this setting automatically.</small></span><input type="checkbox" role="switch" checked={settings.use_enabled} disabled={busy} onChange={event => void update({use_enabled:event.target.checked})} /></label>
        <p className="muted">Saving and using memory are separate. Selecting Analyse sends the task and enabled memory to your selected assessment provider.</p>
      </section>
      <section className="card profile-card-settings"><p className="eyebrow">My progress</p><h2>Automatic learning suggestions</h2>
        <label className="settings-switch"><span><strong>Automatically update suggestions with Groq</strong><small>Send your latest 50 derived assessment profiles and confirmed choices to the project Groq model after history changes. This includes existing history when enabled. Raw tasks, saved preferences and API keys are excluded. Suggestions are saved to your account; provider quota may be used.</small></span><input type="checkbox" role="switch" checked={settings.coaching_auto_enabled} disabled={busy} onChange={event=>void update({coaching_auto_enabled:event.target.checked})} /></label>
        <p className="muted">This is separate from Assistant memory. Turning it off stops future automatic updates and keeps saved suggestions. You can still request an update manually in My progress.</p>
      </section>
      <section className="card personal-context"><div className="card-heading"><div><p className="eyebrow">Preferences</p><h2>What should AdaptAI know about you?</h2></div></div><p>Optional preferences you choose to save, such as language, experience and explanation style. Avoid confidential project or task details.</p><label htmlFor="profile-preferences">Your preferences</label><textarea id="profile-preferences" value={content} maxLength={4000} disabled={busy} onChange={event => setContent(event.target.value)} placeholder="For example: I prefer Portuguese and concise explanations. I am learning software engineering." /><div className="context-save"><span>{content.length}/4,000 characters</span><button className="button button-primary" disabled={busy || content===settings.content} onClick={() => void update({content})}>Save preferences</button></div></section>
      <section className="card profile-card-settings"><p className="eyebrow">Transparency</p><h2>Learned memory</h2><p>Recent metadata available to the Assistant (up to 20 entries). Model-generated profiles remain provisional.</p>
        {!settings.memory.length && <div className="dashboard-empty"><h3>No learned memory yet</h3><p>Enable saving and analyse a task to start building it.</p></div>}
        {settings.memory.map((entry,index) => <details className="memory-entry" key={entry.analysis_id}><summary>Assessment {index+1} · recommended tier {entry.recommended_capacity} · {entry.chosen_capacity ? `chosen tier ${entry.chosen_capacity}` : 'choice pending'}</summary><dl>{Object.entries(entry.profile).map(([dimension,value]) => <div key={dimension}><dt>{dimension}</dt><dd>{value===null?'Undetermined':Array.isArray(value)?value.join(', '):value}</dd></div>)}</dl></details>)}
        <div className="history-delete">{forget ? <><p>Clear all learned memory? This cannot be undone. Your progress history and manually saved preferences remain available.</p><div className="history-actions"><button className="button button-danger" disabled={busy} onClick={() => void clear()}>Clear learned memory</button><button className="button button-secondary" disabled={busy} onClick={() => setForget(false)}>Cancel</button></div></> : <button className="button button-danger" disabled={busy || !settings.memory.length} onClick={() => setForget(true)}>Clear learned memory…</button>}</div>
      </section>
      <p className="confidence-note">My progress contains your dashboard, saved suggestions, export and session deletion controls. Historic task text is not retained.</p>
    </>}
  </main>
}
