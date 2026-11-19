/** Opt-in, local timing only. Never pass request bodies, headers, URLs or errors here. */
export type Timing = { sequence: number; startedMs: number; phase: 'api' | 'stream' | 'firstText' | 'reload'; route: string; method?: string; ms: number; status?: number; outcome: 'ok' | 'error' | 'cancelled' }
const routes = new Set(['/api/health', '/api/features', '/api/providers', '/api/auth/me', '/api/llm-options', '/api/llm-configs', '/api/evaluations', '/api/chats', '/api/analyze', '/api/sessions', '/api/context', '/api/prompt-coach/settings', '/api/chat/settings', '/api/progress', '/api/progress/pending', '/api/progress/activity', '/api/progress/dashboard', '/api/progress/outcomes', '/api/progress/learning', '/api/progress/coaching'])
const tabs = new Set(['analyse', 'progress', 'profile', 'models', 'shortcuts'])
let session = 0
let enabled = false
let sequence = 0
let captureStarted = 0
let samples: Timing[] = []
let write: ((sample: Timing) => void) | undefined

export function startDiagnostics(sink?: (sample: Timing) => void): void {
  session++
  enabled = true
  sequence = 0
  captureStarted = performance.now()
  samples = []
  write = sink
}

export function stopDiagnostics(): void { enabled = false; write = undefined }
export function diagnosticSamples(): Timing[] { return samples.map(sample => ({ ...sample })) }

function safeRoute(route: string): string {
  const clean = route.split('?')[0]
  if (routes.has(clean) || tabs.has(clean)) return clean
  if (/^\/api\/chats\/[^/]+\/messages(?:\/[^/]+\/retry)?$/.test(clean)) return '/api/chats/:id/messages'
  if (/^\/api\/chats\/[^/]+$/.test(clean)) return '/api/chats/:id'
  if (/^\/api\/sessions\/[^/]+$/.test(clean)) return '/api/sessions/:id'
  return 'other'
}

/** Allocate a timer at entry, so overlapping requests can be reconstructed by sequence. */
export function beginTiming(phase: Timing['phase'], route: string, method?: string): (outcome?: Timing['outcome'], status?: number) => void {
  if (!enabled) return () => undefined
  const started = performance.now()
  const generation = session
  const id = ++sequence
  const safe = safeRoute(route)
  let ended = false
  return (outcome = 'ok', status) => {
    if (ended || !enabled || session !== generation) return
    ended = true
    const sample: Timing = { sequence: id, startedMs: Math.round((started - captureStarted) * 10) / 10, phase, route: safe, ms: Math.round((performance.now() - started) * 10) / 10, outcome }
    if (method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) sample.method = method.toUpperCase()
    if (status !== undefined) sample.status = status
    samples.push(sample)
    if (samples.length > 1000) samples.shift()
    try { write?.({ ...sample }) } catch { /* Diagnostics must never break a request. */ }
  }
}
