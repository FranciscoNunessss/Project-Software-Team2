import { useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { api } from './api'

type User = { id: string; email: string }

export function Account({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
  if (loading) return <main className="page"><p role="status">Loading account…</p></main>
  if (!user) return <main className="page">
    <section className="card">
      <h1>{register ? 'Create your account' : 'Sign in to AdaptAI'}</h1>
      <p>Your tasks, context and choices are saved privately to your account.</p>
      <form onSubmit={submit} className="account-form">
        <label>Email<input type="email" required maxLength={254} autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password (12–128 characters)<input type="password" required minLength={12} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button className="button button-primary" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setRegister(!register); setError('') }}>{register ? 'Use an existing account' : 'Create an account'}</button>
      </form>
      {error && <p role="alert" className="api-error">{error}</p>}
    </section>
  </main>
  return <>
    <div className="page account-bar"><span>{user.email}</span><button className="button button-secondary" disabled={busy} onClick={logout}>Sign out</button>{error && <p role="alert">{error}</p>}</div>
    <div key={user.id}>{children}</div>
  </>
}
