import * as os from 'node:os'
import * as vscode from 'vscode'
import { TOKEN_PREFIX, buildApiUrl, checkBackendUrl, describeFailure, looksLikeToken, safeRequest } from './core'
import { SseParser, type SseEvent } from './sse'

const SESSION_KEY = 'adaptai.session'
const TOKEN_KEY = 'adaptai.token'
const AUTH_ROUTES = ['/api/auth/login', '/api/auth/register']
/** No bytes from the backend for this long ends a streamed request (the chat) with an error. */
export const IDLE_TIMEOUT_MS = 120_000

type ApiRequest = {
  path: string
  method: string
  headers: Record<string, string>
  body: string | null
}

export type Auth = 'token' | 'cookie' | 'none'
export type Status = {
  online: boolean
  email: string | null
  url: string
  auth: Auth
  rejected: boolean
  /** Why requests are not even attempted (an unsafe or invalid address). */
  problem?: string
  /** Stored credentials belong to another backend and are not sent to this one. */
  foreign?: string
}

/** An error from the backend (or a refusal to call it). `friendly` is a sentence for the user. */
export class ApiError extends Error {
  readonly friendly: string
  constructor(readonly status: number, readonly detail: string, provider?: string) {
    super(`${status}: ${detail}`)
    this.friendly = status === 0 ? detail : describeFailure(status, detail, provider)
  }
}

type StoredToken = { origin: string; token: string }
type StoredSession = { origin: string; cookies: Record<string, string> }

/**
 * Talks to the AdaptAI backend for the webviews and the commands.
 *
 * Credentials (a personal API token, ADR-013 decision e, or a session cookie) live in SecretStorage and
 * are bound to the backend origin that issued them: if the address changes they are not sent to the new
 * one. Every request goes through `call`, which refuses a remote http address, builds the URL only from
 * an /api/ path, forwards only a few content headers and never follows redirects.
 */
export class Backend {
  private cookies = new Map<string, string>()
  private token: string | undefined
  private credOrigin: string | undefined
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeSession = this.changed.event
  idleMs = IDLE_TIMEOUT_MS

  constructor(private readonly secrets: vscode.SecretStorage) {}

  get url(): string {
    const configured = vscode.workspace.getConfiguration('adaptai').get<string>('backendUrl', 'http://127.0.0.1:8000')
    return configured.trim().replace(/\/+$/, '')
  }

  /** The reason this address cannot be used, if any. */
  get urlProblem(): string | undefined {
    const checked = checkBackendUrl(this.url)
    return checked.ok ? undefined : checked.reason
  }

  private get origin(): string | undefined {
    const checked = checkBackendUrl(this.url)
    return checked.ok ? checked.origin : undefined
  }

  private get usable(): boolean {
    return this.credOrigin !== undefined && this.credOrigin === this.origin
  }

  get auth(): Auth {
    if (!this.usable) return 'none'
    return this.token ? 'token' : this.cookies.size ? 'cookie' : 'none'
  }

  /** The origin the stored credentials belong to, when it is not the current backend. */
  get foreignOrigin(): string | undefined {
    return (this.token || this.cookies.size) && !this.usable ? this.credOrigin : undefined
  }

  async load(): Promise<void> {
    try {
      const rawToken = await this.secrets.get(TOKEN_KEY)
      const rawSession = await this.secrets.get(SESSION_KEY)
      const current = this.origin
      let migrated = false
      if (rawToken) {
        try {
          const parsed = JSON.parse(rawToken) as Partial<StoredToken>
          if (parsed && typeof parsed.token === 'string' && typeof parsed.origin === 'string') {
            this.token = parsed.token
            this.credOrigin = parsed.origin
          }
        } catch {
          // Version 0.2.0 stored the bare token: it was issued by the address in use then, so bind it to the current one.
          if (looksLikeToken(rawToken) && current) {
            this.token = rawToken
            this.credOrigin = current
            migrated = true
          }
        }
      }
      if (rawSession) {
        try {
          const parsed = JSON.parse(rawSession) as Partial<StoredSession> & Record<string, string>
          if (parsed.cookies && typeof parsed.origin === 'string') {
            this.cookies = new Map(Object.entries(parsed.cookies))
            this.credOrigin ??= parsed.origin
          } else if (current) {
            this.cookies = new Map(Object.entries(parsed as Record<string, string>))
            this.credOrigin ??= current
            migrated = true
          }
        } catch {
          this.cookies.clear()
        }
      }
      if (migrated) await this.persist()
    } catch {
      this.cookies.clear()
      this.token = undefined
    }
  }

  private async persist(): Promise<void> {
    if (this.token && this.credOrigin) await this.secrets.store(TOKEN_KEY, JSON.stringify({ origin: this.credOrigin, token: this.token } satisfies StoredToken))
    else await this.secrets.delete(TOKEN_KEY)
    if (this.cookies.size && this.credOrigin) await this.secrets.store(SESSION_KEY, JSON.stringify({ origin: this.credOrigin, cookies: Object.fromEntries(this.cookies) } satisfies StoredSession))
    else await this.secrets.delete(SESSION_KEY)
  }

  /** Before a sign-in: credentials of another backend are dropped, never sent to this one. */
  private async adopt(): Promise<void> {
    const origin = this.origin
    if (!origin || this.credOrigin === origin) return
    this.token = undefined
    this.cookies.clear()
    this.credOrigin = origin
    await this.persist()
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private async remember(response: Response): Promise<void> {
    const lines = response.headers.getSetCookie()
    if (lines.length === 0) return
    await this.adopt()
    const before = this.cookieHeader()
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some(item => /^\s*max-age=0/i.test(item))
      if (!value || expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    if (this.cookieHeader() !== before) {
      await this.persist()
      this.changed.fire()
    }
  }

  /**
   * One request. `as` forces a credential for the sign-in steps. It throws ApiError(0, reason) for an
   * address or request that must not be sent, before anything leaves the machine.
   */
  async call(init: ApiRequest, signal: AbortSignal, as?: { token?: string; cookie?: boolean }): Promise<Response> {
    const built = buildApiUrl(this.url, init.path)
    if (!built.ok) throw new ApiError(0, built.reason)
    const request = safeRequest(init.method, init.headers)
    if (!request) throw new ApiError(0, 'Refusing a request method the AdaptAI API does not use.')
    const headers: Record<string, string> = { ...request.headers }
    const token = as ? as.token : AUTH_ROUTES.includes(init.path) || !this.usable ? undefined : this.token
    if (token) headers.authorization = `Bearer ${token}`
    else if (as?.cookie !== false && this.usable && this.cookies.size) headers.cookie = this.cookieHeader()
    const hasBody = request.method !== 'GET' && init.body !== null && init.body !== undefined
    const response = await fetch(built.url, {
      method: request.method,
      headers,
      body: hasBody ? init.body ?? undefined : undefined,
      signal,
      redirect: 'manual', // a redirect is never followed, so credentials cannot be forwarded elsewhere
    })
    if (!token) await this.remember(response)
    return response
  }

  /** A JSON call for the commands. Throws ApiError with the backend's `detail` code. */
  async api<T>(path: string, method = 'GET', body?: unknown, signal: AbortSignal = AbortSignal.timeout(120_000), provider?: string): Promise<T> {
    const response = await this.call(
      { path, method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) },
      signal,
    )
    if (response.status >= 300 && response.status < 400) throw new ApiError(0, 'The backend answered with a redirect, which is never followed. Check the backend address.')
    const text = await response.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }
    if (!response.ok) {
      const detail = (data as { detail?: unknown } | undefined)?.detail
      throw new ApiError(response.status, typeof detail === 'string' ? detail : response.statusText || 'request_failed', provider)
    }
    return data as T
  }

  /**
   * A streamed request (Server-Sent Events): yields each event as it arrives. `signal` ends it (Stop), and a
   * stream that sends nothing for `idleMs` fails with a TimeoutError instead of hanging.
   */
  async *events(path: string, method: string, body: unknown, signal: AbortSignal, provider?: string): AsyncGenerator<SseEvent> {
    const response = await this.call({ path, method, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) }, signal)
    if (response.status >= 300 && response.status < 400) throw new ApiError(0, 'The backend answered with a redirect, which is never followed. Check the backend address.')
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { detail?: unknown }
      throw new ApiError(response.status, typeof data.detail === 'string' ? data.detail : response.statusText || 'request_failed', provider)
    }
    if (!response.body) return
    const parser = new SseParser()
    const reader = response.body.getReader()
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('idle'), { name: 'TimeoutError' })), this.idleMs)
        })
        const read = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer))
        if (read.done) break
        for (const event of parser.push(read.value)) yield event
      }
      for (const event of parser.end()) yield event
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  /** Reachability and the signed-in user, for the status bar and the side view. */
  async status(): Promise<Status> {
    const url = this.url
    const auth = this.auth
    const problem = this.urlProblem
    const foreign = this.foreignOrigin
    const base = { url, auth, rejected: false, problem, foreign }
    if (problem) return { ...base, online: false, email: null }
    try {
      const health = await this.call({ path: '/api/health', method: 'GET', headers: {}, body: null }, AbortSignal.timeout(3000))
      if (!health.ok) return { ...base, online: false, email: null }
      if (auth === 'none') return { ...base, online: true, email: null }
      const me = await this.call({ path: '/api/auth/me', method: 'GET', headers: {}, body: null }, AbortSignal.timeout(3000))
      const email = me.ok ? ((await me.json()) as { email?: string }).email ?? null : null
      return { ...base, online: true, email, rejected: !me.ok && me.status === 401 && auth === 'token' }
    } catch {
      return { ...base, online: false, email: null }
    }
  }

  /** Stores a token after checking that the backend accepts it. Returns the account email. */
  async signInWithToken(raw: string): Promise<string> {
    const token = raw.trim()
    if (!looksLikeToken(token)) throw new ApiError(0, `A token starts with ${TOKEN_PREFIX}`)
    const me = await this.call({ path: '/api/auth/me', method: 'GET', headers: {}, body: null }, AbortSignal.timeout(5000), { token })
    if (!me.ok) throw new ApiError(me.status, me.status === 401 ? 'token_rejected' : 'request_failed')
    const email = ((await me.json()) as { email: string }).email
    this.cookies.clear()
    this.token = token
    this.credOrigin = this.origin
    await this.persist()
    this.changed.fire()
    return email
  }

  /**
   * Email and password are used once, here, to sign in and mint a token for this machine; only the
   * token is kept. Nothing is sent unless the address passed `checkBackendUrl` (https, or this machine).
   * Against a backend without tokens the session cookie stays as the fallback.
   */
  async signInWithPassword(email: string, password: string): Promise<{ email: string; auth: Auth }> {
    const problem = this.urlProblem
    if (problem) throw new ApiError(0, problem)
    await this.adopt()
    const login = await this.call(
      { path: '/api/auth/login', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) },
      AbortSignal.timeout(10_000),
      { cookie: false },
    )
    if (login.status >= 300 && login.status < 400) throw new ApiError(0, 'The backend answered with a redirect, which is never followed. Check the backend address.')
    if (!login.ok) {
      const detail = ((await login.json().catch(() => ({}))) as { detail?: unknown }).detail
      throw new ApiError(login.status, typeof detail === 'string' ? detail : 'sign_in_failed')
    }
    const who = ((await login.json()) as { email: string }).email
    const created = await this.call(
      { path: '/api/tokens', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `VS Code on ${os.hostname()}`.slice(0, 60), expires_in_days: 90 }) },
      AbortSignal.timeout(10_000),
    )
    if (created.status === 201) {
      const { token } = (await created.json()) as { token: string }
      this.token = token
      this.credOrigin = this.origin
      this.cookies.clear()
      await this.persist()
      this.changed.fire()
      return { email: who, auth: 'token' }
    }
    this.changed.fire()
    return { email: who, auth: 'cookie' }
  }

  // ---- account and token management (a token cannot manage tokens, so a short password session does) ----------

  private manage: { cookie: string; until: number } | undefined

  /** True for ten minutes after the password was confirmed for token management. */
  get managing(): boolean {
    return Boolean(this.manage && this.manage.until > Date.now() && this.usable)
  }

  /** Creates an account (the same call as the app's sign-up) and signs in with it. */
  async register(email: string, password: string): Promise<{ email: string; auth: Auth }> {
    const problem = this.urlProblem
    if (problem) throw new ApiError(0, problem)
    const response = await this.call(
      { path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) },
      AbortSignal.timeout(10_000),
      { cookie: false },
    )
    if (!response.ok) {
      const detail = ((await response.json().catch(() => ({}))) as { detail?: unknown }).detail
      throw new ApiError(response.status, typeof detail === 'string' ? detail : 'register_failed')
    }
    return this.signInWithPassword(email, password)
  }

  /** Confirms the password for managing API tokens. The session lives in memory only and is never stored. */
  async startManaging(email: string, password: string): Promise<void> {
    const problem = this.urlProblem
    if (problem) throw new ApiError(0, problem)
    const built = buildApiUrl(this.url, '/api/auth/login')
    if (!built.ok) throw new ApiError(0, built.reason)
    const response = await fetch(built.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    if (!response.ok) {
      const detail = ((await response.json().catch(() => ({}))) as { detail?: unknown }).detail
      throw new ApiError(response.status, typeof detail === 'string' ? detail : 'sign_in_failed')
    }
    const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    this.manage = { cookie, until: Date.now() + 10 * 60_000 }
  }

  /** A call to /api/tokens with the temporary password session. */
  async tokenApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/api/tokens')) throw new ApiError(0, 'Only the token routes use the password session.')
    if (!this.managing || !this.manage) throw new ApiError(401, 'password_required')
    const built = buildApiUrl(this.url, path)
    if (!built.ok) throw new ApiError(0, built.reason)
    const response = await fetch(built.url, {
      method: method === 'DELETE' ? 'DELETE' : method === 'POST' ? 'POST' : 'GET',
      headers: { cookie: this.manage.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    })
    const data = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined
    if (response.status === 401) this.manage = undefined
    if (!response.ok) throw new ApiError(response.status, typeof data?.detail === 'string' ? data.detail : 'request_failed')
    return data as T
  }

  async signOut(): Promise<void> {
    try {
      if (this.usable && this.cookies.size && !this.urlProblem) {
        await this.call(
          { path: '/api/auth/logout', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
          AbortSignal.timeout(3000),
          { cookie: true },
        )
      }
    } catch {
      // Offline: still forget the credentials locally.
    } finally {
      this.manage = undefined
      this.token = undefined
      this.cookies.clear()
      this.credOrigin = undefined
      await this.persist()
      this.changed.fire()
    }
  }
}
