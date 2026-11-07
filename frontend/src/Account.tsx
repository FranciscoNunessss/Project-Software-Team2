import { useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { api, ApiError } from './api'
import { supabase } from './auth'

type User = { id: string; email: string }

// What the signed-in shell needs to show the account and sign out (at the bottom of the sidebar).
export type AccountInfo = { email: string; busy: boolean; signOut: () => void }

export function Account({ children, dark, onToggleTheme }: { children: (account: AccountInfo) => ReactNode; dark: boolean; onToggleTheme: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [notice, setNotice] = useState('')
  const [needsLink, setNeedsLink] = useState(false)
  const [recovery, setRecovery] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let generation = 0
    const syncUser = async () => {
      const current = ++generation
      try {
        const account = await api<User>('auth/me', undefined, controller.signal)
        if (!controller.signal.aborted && current === generation) { setUser(account); setNeedsLink(false) }
      } catch (failure) {
        if (!controller.signal.aborted && current === generation) {
          setUser(null)
          if (failure instanceof ApiError && failure.detail === 'account_link_required') {
            setNeedsLink(true); setError(failure.message)
          } else if (!(failure instanceof ApiError && failure.status === 401)) {
            setError(failure instanceof Error ? failure.message : 'Could not load your account.')
          }
        }
      } finally { if (!controller.signal.aborted && current === generation) setLoading(false) }
    }
    if (!supabase) { void syncUser(); return () => controller.abort() }
    // Avoid calling Supabase methods inside its auth callback (the SDK holds a lock).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (controller.signal.aborted) return
      if (event === 'PASSWORD_RECOVERY') { setRecovery(true); setUser(null); setLoading(false); return }
      if (!session) { ++generation; setUser(null); setNeedsLink(false); setLoading(false); return }
      setEmail(session.user.email ?? '')
      setTimeout(() => { if (!controller.signal.aborted) void syncUser() }, 0)
    })
    return () => { controller.abort(); subscription.unsubscribe() }
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      if (supabase) {
        if (needsLink) {
          setUser(await api<User>('auth/link-legacy', { email, password })); setNeedsLink(false)
        } else if (recovery) {
          const { error } = await supabase.auth.updateUser({ password })
          if (error) throw error
          setRecovery(false); setUser(await api<User>('auth/me'))
        } else if (register) {
          const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
          if (error) throw error
          if (data.session) setUser(await api<User>('auth/me'))
          else { setNotice('Check your email to confirm your account, then sign in.'); setRegister(false) }
        } else {
          const { error } = await supabase.auth.signInWithPassword({ email, password })
          if (error) throw error
          setUser(await api<User>('auth/me'))
        }
        setPassword(''); return
      }
      setUser(await api<User>(register ? 'auth/register' : 'auth/login', { email, password }))
      setPassword('')
    } catch (failure) {
      if (failure instanceof ApiError && failure.detail === 'account_link_required') { setNeedsLink(true); setPassword('') }
      setError(failure instanceof Error ? failure.message : 'Sign in failed')
    }
    finally { setBusy(false) }
  }
  async function logout() {
    setBusy(true); setError('')
    try {
      if (supabase) { const { error } = await supabase.auth.signOut(); if (error) throw error }
      else await api('auth/logout', {})
      setUser(null); setNeedsLink(false); setRecovery(false)
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Sign out failed') }
    finally { setBusy(false) }
  }
  async function resetPassword() {
    if (!supabase) return
    if (!email) { setError('Enter your email address first.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
      if (error) throw error
      setNotice('If an account exists, a password reset link will be sent to your email.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send reset email.') }
    finally { setBusy(false) }
  }
  if (loading || !user) return <div className="auth-shell">
    <header className="auth-header">
      <div className="auth-brand"><span className="brand-mark" aria-hidden="true">✦</span>AdaptAI</div>
      <button type="button" className="button button-secondary" onClick={onToggleTheme}>{dark ? 'Light mode' : 'Dark mode'}</button>
    </header>
    <main className="auth-main">
      {loading ? <p role="status">Loading your account…</p> : <section className="card auth-card" aria-labelledby="account-title">
        <div className="auth-symbol" aria-hidden="true">✦</div>
        <p className="eyebrow">Your workspace for better AI choices</p>
        <h1 id="account-title">{needsLink ? 'Keep your existing history' : recovery ? 'Choose a new password' : register ? 'Create your account' : 'Welcome back.'}</h1>
        <p className="auth-description">{register ? 'Keep your sessions, context and model choices together in one place.' : 'Sign in to pick up where you left off.'}</p>
        <form onSubmit={submit} className="account-form" aria-busy={busy}>
          <label htmlFor="account-email">Email address</label>
          <input id="account-email" type="email" required maxLength={254} autoComplete="username" placeholder="you@example.com" disabled={busy || needsLink || recovery} value={email} onChange={event => setEmail(event.target.value)} />
          <div className="password-label"><label htmlFor="account-password">Password</label><button type="button" aria-controls="account-password" aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></div>
          <input id="account-password" type={showPassword ? 'text' : 'password'} required minLength={12} maxLength={128} aria-describedby="password-hint" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Choose a password' : 'Enter your password'} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
          <p id="password-hint" className="auth-hint">{needsLink ? 'Enter the password used in AdaptAI before the Supabase migration.' : 'Use 12–128 characters.'}</p>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert" className="api-error">{error}</p>}
          <button className="button button-primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : needsLink ? 'Link my history' : recovery ? 'Save password' : register ? 'Create account' : 'Sign in'}<span aria-hidden="true">→</span></button>
        </form>
        {supabase && !register && !needsLink && !recovery && <button type="button" className="button button-ghost" disabled={busy} onClick={resetPassword}>Forgot password?</button>}
        {needsLink || recovery ? <button type="button" className="button button-ghost" disabled={busy} onClick={logout}>Cancel and sign out</button> : <div className="auth-switch"><span>{register ? 'Already have an account?' : 'New to AdaptAI?'}</span><button type="button" disabled={busy} onClick={() => { setRegister(!register); setError(''); setNotice(''); setPassword(''); setShowPassword(false) }}>{register ? 'Sign in' : 'Create an account'}</button></div>}
        <p className="auth-storage-note">Your preferences and model choices are saved to your account.</p>
      </section>}
    </main>
    <p className="auth-footer">Clearer choices. Better AI judgement.</p>
  </div>
  // Keyed by user, so nothing of one account's state survives into the next.
  return <div className="app-shell" key={user.id}>
    {error && <p role="alert" className="api-error account-error">{error}</p>}
    {children({ email: user.email, busy, signOut: () => void logout() })}
  </div>
}
