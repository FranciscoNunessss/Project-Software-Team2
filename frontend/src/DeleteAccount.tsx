import { useState, type FormEvent } from 'react'
import { api } from './api'
import { cloudAuth, supabase } from './auth'
import './Profile.css'
import './Progress.css'

// Self-service erasure: deletes the account and everything stored for it. The user confirms
// by typing the account's email and, with a local account, the password.
export function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const matches = typed.trim().toLowerCase() === email.toLowerCase() && !!email
  const ready = matches && (cloudAuth || password.length > 0)

  const remove = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true); setError('')
    try {
      await api('auth/account', { email: typed.trim(), ...(cloudAuth ? {} : { password }) }, undefined, 'DELETE')
      // The data is gone: end the sign-in on this device and start again from the sign-in page.
      if (supabase) await supabase.auth.signOut().catch(() => undefined)
      window.location.reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not delete the account')
      setBusy(false)
    }
  }

  return (
    <section className="card profile-card-settings" data-delete-account>
      <p className="eyebrow">Account</p><h2>Delete my account</h2>
      <p>Permanently deletes this account and everything stored for it: sessions, analyses, model choices, task feedback, learned memory, saved conversations, chats, your model configurations and their keys, and coaching. This cannot be undone.</p>
      {cloudAuth && <p className="muted">Your sign-in (email and password) is kept by the sign-in service and is not deleted here. Signing in again starts an empty account.</p>}
      {!open
        ? <button type="button" className="button button-danger" onClick={() => setOpen(true)}>Delete my account…</button>
        : <form className="history-delete" onSubmit={remove}>
            <label>Type <strong>{email}</strong> to confirm
              <input type="email" autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} aria-label="Account email" disabled={busy} /></label>
            {!cloudAuth && <label>Password
              <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} aria-label="Account password" disabled={busy} /></label>}
            {error && <p className="api-error" role="alert">{error}</p>}
            <div className="data-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setPassword(''); setError('') }}>Cancel</button>
              <button type="submit" className="button button-danger" disabled={!ready || busy}>{busy ? 'Deleting…' : 'Delete account permanently'}</button>
            </div>
          </form>}
    </section>
  )
}
