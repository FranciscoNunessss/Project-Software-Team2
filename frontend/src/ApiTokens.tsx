import { useEffect, useState, type FormEvent } from 'react'
import { api } from './api'

type Token = { id: string; name: string; prefix: string; created_at: number; expires_at: number; last_used_at: number | null; revoked: boolean; expired: boolean }
type Created = Token & { token: string }

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString()

/** Personal API tokens (ADR-013): lets a client that is not a browser, such as the VS Code extension, sign in as you. */
export function ApiTokens() {
  const [tokens, setTokens] = useState<Token[]>()
  const [name, setName] = useState('VS Code')
  const [days, setDays] = useState(90)
  const [created, setCreated] = useState<Created>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<string>()

  const load = (signal?: AbortSignal) => api<Token[]>('tokens', undefined, signal).then(setTokens)
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load tokens') })
    return () => controller.abort()
  }, [])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setCopied(false)
    try {
      setCreated(await api<Created>('tokens', { name, expires_in_days: days }))
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create the token') }
    finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    setBusy(true); setError('')
    try {
      await api(`tokens/${id}`, undefined, undefined, 'DELETE')
      setRevoking(undefined)
      if (created?.id === id) setCreated(undefined)
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke the token') }
    finally { setBusy(false) }
  }
  const copy = async () => {
    if (!created) return
    try { await navigator.clipboard.writeText(created.token); setCopied(true) } catch { setError('Could not copy. Select the token and copy it by hand.') }
  }
  const active = tokens?.filter(token => !token.revoked && !token.expired).length ?? 0

  return <section className="card profile-card-settings" aria-labelledby="api-tokens-title" data-api-tokens="">
    <p className="eyebrow">Access from other tools</p><h2 id="api-tokens-title">API tokens</h2>
    <p>A token lets a tool that is not a browser, such as the VS Code extension, use AdaptAI as you. It is shown once, stored only as a hash and can be revoked here. Treat it like a password.</p>
    {error && <p className="api-error" role="alert">{error}</p>}
    {created && <div className="confidence-note" role="status" data-new-token="">
      <div><strong>Copy your new token now. It is not shown again.</strong>
        <p><code data-token-value="">{created.token}</code></p>
        <div className="history-actions"><button type="button" className="button button-secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy token'}</button>
          <button type="button" className="button button-secondary" onClick={() => setCreated(undefined)}>I have saved it</button></div></div>
    </div>}
    <form className="llm-form" onSubmit={event => void create(event)}>
      <label htmlFor="token-name">Name</label>
      <input id="token-name" value={name} required maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} placeholder="For example: VS Code on my laptop" />
      <label htmlFor="token-days">Expires after</label>
      <select id="token-days" value={days} disabled={busy} onChange={event => setDays(Number(event.target.value))}>
        <option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
      </select>
      <div className="history-actions"><button className="button button-primary" disabled={busy || !name.trim() || active >= 10}>{busy ? 'Working…' : 'Create token'}</button></div>
      {active >= 10 && <p className="muted">You have 10 active tokens, the maximum. Revoke one to create another.</p>}
    </form>
    {tokens === undefined && !error && <p role="status">Loading tokens…</p>}
    {tokens && tokens.length === 0 && <p className="muted">No tokens yet.</p>}
    {tokens && tokens.map(token => <div className="provider-model" key={token.id} data-token-row="">
      <div className="card-heading"><div><h3>{token.name}</h3><p className="muted">{token.prefix}… · created {day(token.created_at)} · {token.revoked ? 'revoked' : token.expired ? `expired ${day(token.expires_at)}` : `expires ${day(token.expires_at)}`} · {token.last_used_at ? `last used ${day(token.last_used_at)}` : 'never used'}</p></div>
        <span className="period">{token.revoked ? 'Revoked' : token.expired ? 'Expired' : 'Active'}</span></div>
      {!token.revoked && <div className="history-actions">
        {revoking === token.id
          ? <><button type="button" className="button button-danger" disabled={busy} onClick={() => void revoke(token.id)}>Confirm revoke</button>
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => setRevoking(undefined)}>Cancel</button></>
          : <button type="button" className="button button-danger" disabled={busy} onClick={() => setRevoking(token.id)}>Revoke</button>}
      </div>}
    </div>)}
  </section>
}
