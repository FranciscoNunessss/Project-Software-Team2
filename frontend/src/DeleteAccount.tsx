import { useEffect, useState, type FormEvent } from 'react'
import { api } from './api'
import { cloudAuth, supabase } from './auth'
import type { PrivacyState } from './PolicyConsent'

// Your policy record and self-service account deletion (GDPR Art. 17). Deletion is immediate.
export function DeleteAccount({ email }: { email: string }) {
  const [state, setState] = useState<PrivacyState>()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [partial, setPartial] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<PrivacyState>('account/privacy', undefined, controller.signal).then(setState).catch(() => undefined)
    return () => controller.abort()
  }, [])
  async function remove(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await api<{ sign_in_record_removed: boolean }>('account', { confirm_email: typed, password }, undefined, 'DELETE')
      if (supabase) await supabase.auth.signOut().catch(() => undefined)
      if (!result.sign_in_record_removed) { setPartial(true); return }
      window.location.assign('/')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not delete the account.') }
    finally { setBusy(false) }
  }
  if (partial) return <section className="card profile-card-settings" role="status"><p className="eyebrow">Account deleted</p><h2>Your AdaptAI data is deleted</h2><p>All your data was removed from AdaptAI. Your sign-in record at our authentication provider could not be removed automatically; email the privacy contact to have it deleted.</p><button type="button" className="button button-secondary" onClick={() => window.location.assign('/')}>Continue</button></section>
  const matches = typed.trim().toLowerCase() === email.toLowerCase() && (cloudAuth || password.length > 0)
  return <section className="card profile-card-settings">
    <p className="eyebrow">Your account</p><h2>Policy record and account deletion</h2>
    {state?.accepted_at && <p className="muted">You accepted Privacy Policy version {state.accepted_version} on {new Date(state.accepted_at).toLocaleDateString(undefined, { dateStyle: 'long' })}.</p>}
    {!open ? <button type="button" className="button button-danger" onClick={() => setOpen(true)}>Delete my account</button> : <form onSubmit={remove} className="account-form" aria-busy={busy}>
      <p>This permanently deletes your account and everything linked to it: history, memory, saved conversation text, model configurations, API keys and tokens. It cannot be undone. Export your data first from My progress if you want a copy.</p>
      <label htmlFor="delete-email">Type your email address ({email}) to confirm</label>
      <input id="delete-email" type="email" autoComplete="off" required value={typed} disabled={busy} onChange={event => setTyped(event.target.value)} />
      {!cloudAuth && <><label htmlFor="delete-password">Your password</label><input id="delete-password" type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></>}
      {error && <p role="alert" className="api-error">{error}</p>}
      <div className="history-actions"><button type="submit" className="button button-danger" disabled={!matches || busy}>{busy ? 'Deleting…' : 'Delete everything'}</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setPassword(''); setError('') }}>Cancel</button></div>
    </form>}
  </section>
}
