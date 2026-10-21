export type Tier = 'Small' | 'Medium' | 'Large'
export type Candidate = { id: string; name: string; capacity: number; capabilities: string[] }
export type Provider = { id: string; enabled: boolean; external: boolean }
export type Analysis = {
  id: string
  mode: 'demonstration' | 'semantic'
  provider: string
  profile: { reasoning: number; context: number; ambiguity: number; explanation: string }
  recommendation: Candidate
  alternatives: Candidate[]
  rationale: string
  warnings: string[]
  confidence_basis: string
  latency_ms: number
  catalogue_version: string
  policy_version: string
}
export function tierOf(candidate: Candidate): Tier {
  return candidate.capacity === 1 ? 'Small' : candidate.capacity === 2 ? 'Medium' : 'Large'
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(45000),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}))
    throw new Error(typeof failure.detail === 'string' ? failure.detail.replace(/_/g, ' ') : 'Request failed')
  }
  return response.json()
}
