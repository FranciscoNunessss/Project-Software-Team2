import { useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { api } from './api'

type User = { id: string; email: string }

export function Account({ children, header, dark, onToggleTheme }: { children: ReactNode; header: ReactNode; dark: boolean; onToggleTheme: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<User>('auth/me', undefined, controller.signal).then(setUser).catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      setUser(await api<User>(register ? 'auth/register' : 'auth/login', { email, password }))
      setPassword('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Sign in failed') }
    finally { setBusy(false) }
  }
  async function logout() {
    setBusy(true); setError('')
    try { await api('auth/logout', {}); setUser(null) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Sign out failed') }
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
        <h1 id="account-title">{register ? 'Create your account' : 'Welcome back.'}</h1>
        <p className="auth-description">{register ? 'Keep your sessions, context and model choices together in one place.' : 'Sign in to pick up where you left off.'}</p>
        <form onSubmit={submit} className="account-form" aria-busy={busy}>
          <label htmlFor="account-email">Email address</label>
          <input id="account-email" type="email" required maxLength={254} autoComplete="username" placeholder="you@example.com" disabled={busy} value={email} onChange={event => setEmail(event.target.value)} />
          <div className="password-label"><label htmlFor="account-password">Password</label><button type="button" aria-controls="account-password" aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></div>
          <input id="account-password" type={showPassword ? 'text' : 'password'} required minLength={12} maxLength={128} aria-describedby="password-hint" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Choose a password' : 'Enter your password'} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
          <p id="password-hint" className="auth-hint">Use 12–128 characters.</p>
          {error && <p role="alert" className="api-error">{error}</p>}
          <button className="button button-primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}<span aria-hidden="true">→</span></button>
        </form>
        <div className="auth-switch"><span>{register ? 'Already have an account?' : 'New to AdaptAI?'}</span><button type="button" disabled={busy} onClick={() => { setRegister(!register); setError(''); setPassword(''); setShowPassword(false) }}>{register ? 'Sign in' : 'Create an account'}</button></div>
        <p className="auth-storage-note">Your preferences and model choices are saved to your account.</p>
      </section>}
    </main>
    <p className="auth-footer">Clearer choices. Better AI judgement.</p>
  </div>
  return <>
    {header}
    <div className="page account-bar"><div><span className="account-indicator" aria-hidden="true" /><span className="account-email">{user.email}</span></div><button className="button button-secondary" disabled={busy} onClick={logout}>Sign out</button>{error && <p role="alert">{error}</p>}</div>
    <div key={user.id}>{children}</div>
  </>
}
