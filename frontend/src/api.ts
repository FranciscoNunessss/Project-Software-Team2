export type Tier = 'Small' | 'Medium' | 'Large'
export type Candidate = { id: string; name: string; capacity: number; capabilities: string[] }
export type Provider = { id: string; label: string; model: string | null; enabled: boolean; external: boolean }
export type LLMOption = {id:string;label:string;provider:string;model:string|null;external:boolean;source:'server'|'personal'}
export type LLMOptions = {options:LLMOption[];auto_configuration_id:string|null;auto_policy:string}
export type LLMConfiguration = LLMOption & {model:string;provider:'openai'|'claude'|'groq'|'ollama';has_key:boolean;responses_api:boolean;enabled:boolean;is_default:boolean;created_at:string}
export type Confidence = 'low' | 'medium' | 'high' | 'undetermined'
export type Dimension = { score: 1 | 2 | 3 | null; confidence: Confidence; evidence: string }
export type Profile = {
  reasoning: Dimension
  context: Dimension
  ambiguity: Dimension
  domain: Dimension
  risk: Dimension
  tools: Dimension
  modality: { required: ('text' | 'image' | 'audio' | 'video')[] | null; confidence: Confidence; evidence: string }
  explanation: string
}
export type Analysis = {
  id: string
  session_id: string
  mode: 'demonstration' | 'semantic'
  provider: string
  assessment_model: string | null
  configuration_id?: string
  selection_mode?: 'auto'|'manual'
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null
  profile: Profile
  profile_version: string
  recommendation_provisional: boolean
  clarification_questions: string[]
  guidance: string[]
  recommendation: Candidate
  alternatives: Candidate[]
  rationale: string
  warnings: string[]
  confidence_basis: string
  latency_ms: number
  catalogue_version: string
  policy_version: string
}
export type SavedSession = { id: string; title: string; context: string; created_at: string; analysis_count?:number; choice_count?:number }
export type HistoryItem = { request: { task?: string; session_context?: string; personal_context?: string }; result: Analysis; candidate_id: string | null; created_at: string; conversation?: {task:string;task_context:string;response:Analysis}|null }
export type Resume = { sessionId: string; analysis?: HistoryItem }
export type MemorySettings = {content:string; updated_at:string|null; save_enabled:boolean; use_enabled:boolean; coaching_auto_enabled:boolean; conversation_memory_enabled:boolean;saved_conversations:number; memory:{analysis_id:string; profile:Record<string,number|string[]|null>; recommended_capacity:number; chosen_capacity:number|null}[]}
export function tierOf(candidate: Candidate): Tier {
  return candidate.capacity === 1 ? 'Small' : candidate.capacity === 2 ? 'Medium' : 'Large'
}
export function notifyProgressChange() {
  window.dispatchEvent(new Event('adaptai-progress-updated'))
  try { window.localStorage.setItem('adaptai-progress-updated', String(Date.now())) } catch { /* Refresh on focus remains available. */ }
}
const errorMessages: Record<string, string> = {
  no_history_for_coaching: 'Analyse a task first to generate guidance from your usage metadata.',
  history_changed: 'Your history changed while guidance was being generated. Refresh and try again.',
  project_default_not_configured: 'The project Groq model is not configured. Ask the project administrator or select a configured model manually.',
  model_configuration_changed: 'The selected model settings changed. Refresh the page and confirm the destination again.',
  api_key_required: 'Add an API key for this provider. The existing key can only be reused with the same provider.',
  default_must_be_enabled: 'Enable the model before making it the Auto default.',
  configuration_not_found: 'This configuration no longer exists or is unavailable to your account.',
  configuration_disabled: 'Enable this model in LLM config before using it.',
  credentials_key_missing: 'The backend encryption key is missing. Restore it before changing saved credentials.',
  credentials_key_unavailable: 'The backend encryption key cannot be read. Check the server configuration.',
  credentials_unavailable: 'The saved credential could not be decrypted. Restore the matching backend key or replace this API key.',
  invalid_credentials: 'The email or password is incorrect. Please try again.',
  email_already_registered: 'This email already has an account. Sign in to continue.',
  authentication_required: 'Your session has expired. Please sign in again.',
  provider_authentication: 'The assessment provider rejected the API key. Update the backend .env file and restart the API.',
  provider_not_configured: 'This provider is not configured. Add its credentials on the backend and restart the API.',
  external_processing_requires_consent: 'Allow external processing before requesting this assessment.',
  provider_timeout: 'The provider took too long to respond. Please try again.',
  provider_rate_limit: 'The provider rate limit or quota was reached. Wait before retrying or check the provider account.',
  invalid_provider_output: 'The provider returned an invalid assessment. No recommendation was generated.',
  provider_model_unavailable: 'The configured model is unavailable. Check the model ID and account access.',
  provider_unsupported_request: 'The configured model does not support this request. Check structured output compatibility.',
  provider_unavailable: 'The assessment provider is unavailable. Check the connection or try again later.',
  no_eligible_candidate: 'No catalogue model meets the required capabilities. Review the task requirements or update the catalogue.',
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
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
