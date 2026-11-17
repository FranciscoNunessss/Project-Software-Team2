import * as vscode from 'vscode'
import { Backend } from './backend'

/**
 * The relay agent (ADR-015): runs your own LM Studio for a backend that cannot reach your machine.
 *
 * A hosted backend cannot call `localhost`, but this extension can call the backend. So while you are
 * signed in and have a model set to run "on this computer", the extension keeps a request open
 * (`GET /api/relay/next`). When the backend needs your model, the request comes down that connection;
 * the extension sends it to LM Studio on this machine and sends the answer back. Nothing is opened to
 * the internet and nobody else's request can reach your LM Studio: the backend only gives a request to
 * the client of the account that made it.
 *
 * What it will do, and nothing else: POST `/v1/chat/completions` to the LM Studio address in
 * `adaptai.relay.lmStudioUrl`, which must be this machine. The backend cannot make it call any other
 * address, path or method.
 */

export const RELAY_PATH = '/v1/chat/completions'
const MAX_BODY_BYTES = 1_000_000
/** Bytes of LM Studio's answer per event (the backend accepts up to 256000 once decoded). */
const SLICE = 192_000
const UUID = /^[0-9a-f-]{36}$/

export type RelayState = { state: 'off' | 'connecting' | 'connected' | 'working' | 'error'; text: string }

type Job = { id: string; method: string; path: string; content_type?: string; body: string }
type RelayEvent = { type: 'ack' } | { type: 'start'; status: number; content_type?: string } | { type: 'chunk'; data: string } | { type: 'end' } | { type: 'error'; code: string }

/** The LM Studio address, only if it is this machine: the relay is never a way to reach another host. */
export function lmStudioAddress(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'The LM Studio address is not a valid URL.' }
  }
  if (parsed.protocol !== 'http:') return { ok: false, reason: 'The LM Studio address must start with http://.' }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return { ok: false, reason: 'The LM Studio address must be this computer (127.0.0.1 or localhost).' }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false, reason: 'The LM Studio address must be a plain address.' }
  return { ok: true, url: `${parsed.origin}${RELAY_PATH}` }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class RelayAgent implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RelayState>()
  readonly onDidChange = this.changed.event
  private current: RelayState = { state: 'off', text: 'No model is set to run on this computer.' }
  private generation = 0
  private running = false
  private working = 0
  private pollAbort: AbortController | undefined
  private timer: NodeJS.Timeout | undefined
  /** How long a poll waits for work, in seconds (the backend allows up to 10). */
  pollSeconds = 10
  /** The pause after an error, in milliseconds. */
  retryMs = 5000
  /** The least time between two checks of the models (the page reloads often). */
  minGapMs = 3000
  private checked = 0

  constructor(private readonly backend: Backend) {}

  get state(): RelayState {
    return this.current
  }

  private set(state: RelayState['state'], text: string): void {
    if (this.current.state === state && this.current.text === text) return
    this.current = { state, text }
    this.changed.fire(this.current)
  }

  /** Starts or stops the agent: it runs while you are signed in and a model of yours runs on this computer. */
  async refresh(): Promise<void> {
    if (Date.now() - this.checked < this.minGapMs) return
    this.checked = Date.now()
    if (this.backend.auth === 'none' || this.backend.urlProblem) return this.stop('off', 'Sign in to use a model on this computer.')
    let needed = false
    try {
      const configs = await this.backend.api<Array<{ enabled: boolean; execution?: string }>>('/api/llm-configs', 'GET', undefined, AbortSignal.timeout(8000))
      needed = configs.some(item => item.enabled && item.execution === 'client')
    } catch {
      return // the backend is not reachable now: keep what we have, the next refresh decides
    }
    if (!needed) return this.stop('off', 'No model is set to run on this computer.')
    if (!this.running) this.start()
  }

  /** Re-checks now and then, so a model added in the web app is picked up too. */
  watch(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.refresh(), everyMs)
  }

  private start(): void {
    const generation = ++this.generation
    this.running = true
    this.set('connecting', 'Connecting to the backend…')
    void this.loop(generation)
  }

  stop(state: RelayState['state'] = 'off', text = 'Stopped.'): void {
    this.generation += 1
    this.pollAbort?.abort() // the open request goes too, so the backend stops handing it work
    this.running = false
    this.set(state, text)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.stop('off', 'Stopped.')
    this.changed.dispose()
  }

  private async loop(generation: number): Promise<void> {
    let first = true
    while (generation === this.generation) {
      try {
        // The first request returns at once, so the state is known; the next ones wait for work.
        const wait = first ? 0 : this.pollSeconds
        first = false
        const controller = new AbortController()
        this.pollAbort = controller
        const response = await this.backend.call({ path: `/api/relay/next?wait=${wait}`, method: 'GET', headers: {}, body: null }, AbortSignal.any([controller.signal, AbortSignal.timeout((this.pollSeconds + 15) * 1000)]))
        if (generation !== this.generation) return
        if (response.status === 204) {
          if (!this.working) this.set('connected', 'Connected: your LM Studio answers requests from the backend.')
          continue
        }
        if (response.status === 401) return this.stop('error', 'The backend refused your sign-in. Sign in again.')
        if (response.status === 404) return this.stop('error', 'This backend has no relay yet (it has to be updated).')
        if (!response.ok) throw new Error(`relay ${response.status}`)
        const job = (await response.json()) as Job
        void this.handle(job, generation)
      } catch {
        if (generation !== this.generation) return
        this.set('error', 'The backend is not reachable. Trying again…')
        await sleep(this.retryMs)
      }
    }
  }

  private async handle(job: Job, generation: number): Promise<void> {
    this.working += 1
    this.set('working', 'Your LM Studio is answering a request from the backend…')
    const pending: RelayEvent[] = []
    let sending: Promise<void> | undefined
    const abort = new AbortController()
    const flush = async (): Promise<void> => {
      try {
        while (pending.length) {
          const events = pending.splice(0, pending.length)
          const posted = await this.backend.call({ path: `/api/relay/jobs/${job.id}/events`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }, AbortSignal.timeout(20_000))
          // The backend does not know the job any more (it timed out): stop wasting the model's time.
          if (posted.status === 404) abort.abort()
        }
      } catch {
        abort.abort() // the backend cannot be reached: nobody is waiting for this answer
      }
    }
    const emit = (event: RelayEvent): Promise<void> => {
      pending.push(event)
      sending ??= flush().finally(() => (sending = undefined))
      return sending
    }
    try {
      if (!UUID.test(String(job.id))) return
      void emit({ type: 'ack' }) // the backend knows at once that this client has the request
      const target = lmStudioAddress(vscode.workspace.getConfiguration('adaptai').get<string>('relay.lmStudioUrl', 'http://127.0.0.1:1234'))
      if (job.method !== 'POST' || job.path !== RELAY_PATH) return void (await emit({ type: 'error', code: 'relay_path_not_allowed' }))
      if (!target.ok) return void (await emit({ type: 'error', code: 'relay_client_error' }))
      const body = Buffer.from(String(job.body), 'base64')
      if (body.length === 0 || body.length > MAX_BODY_BYTES) return void (await emit({ type: 'error', code: 'relay_request_too_large' }))
      let response: Response
      try {
        response = await fetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)]), redirect: 'manual' })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return void (await emit({ type: 'error', code: timedOut ? 'relay_lm_studio_timeout' : 'relay_lm_studio_unreachable' }))
      }
      void emit({ type: 'start', status: response.status, content_type: response.headers.get('content-type') ?? undefined })
      if (response.body) {
        for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
          for (let at = 0; at < part.length; at += SLICE) void emit({ type: 'chunk', data: Buffer.from(part.subarray(at, at + SLICE)).toString('base64') })
          if (sending) await sending
        }
      }
      await emit({ type: 'end' })
    } catch {
      if (!abort.signal.aborted) await emit({ type: 'error', code: 'relay_lm_studio_unreachable' }).catch(() => undefined)
    } finally {
      await sending
      if (pending.length) await flush()
      this.working -= 1
      if (generation === this.generation && !this.working) this.set('connected', 'Connected: your LM Studio answers requests from the backend.')
    }
  }
}

/** A status bar item that shows the relay while it is in use. */
export class RelayStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
  private readonly subscription: vscode.Disposable

  constructor(private readonly agent: RelayAgent) {
    this.item.command = 'adaptai.open'
    this.subscription = agent.onDidChange(() => this.render())
    this.render()
  }

  private render(): void {
    const { state, text } = this.agent.state
    if (state === 'off') return this.item.hide()
    const icon = state === 'error' ? '$(warning)' : state === 'working' ? '$(sync~spin)' : state === 'connecting' ? '$(loading~spin)' : '$(plug)'
    this.item.text = `${icon} LM Studio relay`
    this.item.tooltip = text
    this.item.show()
  }

  dispose(): void {
    this.subscription.dispose()
    this.item.dispose()
  }
}
