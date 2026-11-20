import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import { PrivacyPolicy } from './PrivacyPolicy'
import './PolicyConsent.css'

export type PrivacyState = { current_version: string; accepted_version: string | null; accepted_at: string | null; needs_acceptance: boolean }

// Records that the signed-in user accepted the policy version the server currently asks for.
export async function acceptCurrentPolicy(): Promise<PrivacyState> {
  const state = await api<PrivacyState>('account/privacy')
  return api<PrivacyState>('account/policy-acceptance', { version: state.current_version })
}

// Opens the app only once the user has accepted the current policy version (GDPR Art. 7(1)).
// A new version asks again; an accepted one never shows this screen.
export function PolicyConsent({ onSignOut, children }: { onSignOut: () => void; children: ReactNode }) {
  const [state, setState] = useState<PrivacyState>()
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = useCallback((signal?: AbortSignal) => {
    setError('')
    api<PrivacyState>('account/privacy', undefined, signal)
      .then(setState)
      .catch(failure => { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'Could not check the Privacy Policy.') })
  }, [])
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort() }, [load])
  if (state && !state.needs_acceptance) return <>{children}</>
  if (!state) return <main className="consent-shell">
    {error ? <section className="card consent-card" role="alert"><p>{error}</p><div className="history-actions"><button type="button" className="button button-primary" onClick={() => load()}>Try again</button><button type="button" className="button button-secondary" onClick={onSignOut}>Sign out</button></div></section> : <p role="status">Checking your account…</p>}
  </main>
  async function accept() {
    setBusy(true); setError('')
    try { setState(await acceptCurrentPolicy()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save your acceptance.') }
    finally { setBusy(false) }
  }
  return <main className="consent-shell">
    <section className="card consent-card" aria-labelledby="consent-title">
      <p className="eyebrow">{state.accepted_version ? 'Updated policy' : 'Before you start'}</p>
      <h1 id="consent-title">{state.accepted_version ? 'Our Privacy Policy has changed' : 'Please review our Privacy Policy'}</h1>
      <p>{state.accepted_version ? `You accepted version ${state.accepted_version}. Please read and accept version ${state.current_version} to continue.` : 'AdaptAI keeps metadata by default and only stores or shares your text when you switch that on. Read the full policy below.'}</p>
      <div className="consent-scroll" tabIndex={0} aria-label="Privacy Policy text"><PrivacyPolicy embedded /></div>
      <label className="consent-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I have read the Privacy Policy and I am at least 16 years old.</span></label>
      {error && <p role="alert" className="api-error">{error}</p>}
      <div className="history-actions">
        <button type="button" className="button button-primary" disabled={!confirmed || busy} onClick={() => void accept()}>{busy ? 'Saving…' : 'Accept and continue'}</button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={onSignOut}>Sign out</button>
      </div>
    </section>
  </main>
}
