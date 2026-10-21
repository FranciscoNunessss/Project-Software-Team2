export type Tier = 'Small' | 'Medium' | 'Large'
export type Candidate = { id: string; name: string; capacity: number; capabilities: string[] }
export type Provider = { id: string; label: string; model: string | null; enabled: boolean; external: boolean }
export type Analysis = {
  id: string
  mode: 'demonstration' | 'semantic'
  provider: string
  assessment_model: string | null
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null
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
const errorMessages: Record<string, string> = {
  provider_authentication: 'The assessment provider rejected the API key. Update the backend .env file and restart the API.',
  provider_not_configured: 'This provider is not configured. Add its credentials on the backend and restart the API.',
  external_processing_requires_consent: 'Allow external processing before requesting this assessment.',
  provider_timeout: 'The provider took too long to respond. Please try again.',
  provider_rate_limit: 'The provider rate limit or quota was reached. Wait before retrying or check the provider account.',
  invalid_provider_output: 'The provider returned an invalid assessment. No recommendation was generated.',
  provider_model_unavailable: 'The configured model is unavailable. Check the model ID and account access.',
  provider_unsupported_request: 'The configured model does not support this request. Check structured output compatibility.',
  provider_unavailable: 'The assessment provider is unavailable. Check the connection or try again later.',
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
    throw new Error(typeof failure.detail === 'string'
      ? errorMessages[failure.detail] ?? failure.detail.replace(/_/g, ' ')
      : 'Request failed')
  }
  return response.json()
}
