import { apiUrl, authHeaders, apiCredentials } from './auth'

export type Tier = 'Small' | 'Medium' | 'Large'
export type NeedName = 'reasoning' | 'context' | 'domain' | 'reliability' | 'tools'
export type CoverageState = 'covers' | 'covers_as_described' | 'short'
export type Coverage = { need: NeedName; estimated: number; top: number; capability: number | null; state: CoverageState; provisional: boolean }
/** A model the analysis compared (ADR-014). Analyses stored before needs-capabilities-1 carry an
 * illustrative tier instead: `capacity` 1-3 and the graded `fit`. */
export type Candidate = {
  id: string; name: string; capabilities: string[]
  capacity?: number | null; sufficiency?: number | null; fit?: number | null
  provider?: string | null; model?: string | null; configuration_id?: string | null; label?: string | null
  status?: CoverageState | null; shortfalls?: NeedName[]; coverage?: Coverage[]
  blended_price?: number | null; cost_band?: 'low' | 'medium' | 'high' | null
  free?: boolean; local?: boolean; illustrative?: boolean; calibrated?: boolean; levels_from?: string | null; gap?: number | null
}
export type TaskNeeds = { needs: Record<NeedName, { estimated: number; top: number; determined: boolean }>; modalities: string[]; capabilities: string[]; length_tokens: number; ambiguous: boolean }
export type Grading = { demand: number; spread: number; parameters: Record<string, unknown>; basis: string }
export type Provider = { id: string; label: string; model: string | null; enabled: boolean; external: boolean }
export type LLMOption = {id:string;label:string;provider:string;model:string|null;external:boolean;source:'server'|'personal'}
export type LLMOptions = {options:LLMOption[];auto_configuration_id:string|null;auto_policy:string}
export type LLMConfiguration = LLMOption & {model:string;provider:'openai'|'claude'|'groq'|'openrouter'|'ollama'|'lmstudio';has_key:boolean;responses_api:boolean;enabled:boolean;is_default:boolean;created_at:string}
export type OpenRouterModel = {
  id: string; name: string; organisation: string; description: string; context_length: number | null
  price_input_per_million: number | null; price_output_per_million: number | null; free: boolean
  input_modalities: string[]; output_modalities: string[]; supported_parameters: string[]
  top_provider: { context_length: number | null; max_completion_tokens: number | null; is_moderated: boolean | null }
  text_chat: boolean; structured_output: boolean; selectable: boolean; unavailable_reason: string | null
}
export type OpenRouterCatalogue = { fetched_at: number; models: OpenRouterModel[] }
/** USD per 1M tokens as a short string; null means the API gave no fixed price. */
export function formatPrice(perMillion: number | null): string {
  if (perMillion === null) return 'variable'
  if (perMillion === 0) return '$0'
  return `$${perMillion >= 1 ? perMillion.toFixed(2) : perMillion.toPrecision(2)}`
}
export function formatContext(tokens: number | null): string {
  if (tokens === null) return 'n/a'
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`
}
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
export type DimensionName = 'reasoning' | 'context' | 'ambiguity' | 'domain' | 'risk' | 'tools' | 'modality'
// History keeps dimension/before/after only; evidence is present only in the live response.
export type Change = { dimension: DimensionName; before: number | string[] | null; after: number | string[] | null; evidence?: string }
export type Tip = { dimension: DimensionName | null; text: string }
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
  // Absent on analyses stored before AA-019; history never retains tips.
  tips?: Tip[]
  recommendation: Candidate
  alternatives: Candidate[]
  rationale: string
  warnings: string[]
  confidence_basis: string
  latency_ms: number
  catalogue_version: string
  policy_version: string
  grading?: Grading | null
  needs?: TaskNeeds | null
  notes?: string[]
  previous_analysis_id?: string | null
  completeness?: number | null
  changes?: Change[]
}
// Keep in sync with backend/app/assessment.py PROFILE_VERSION.
export const PROFILE_VERSION = 'profile-2'

// Optional Prompt Coach (ADR-009, AA-019 B3). Mirrors backend CoachResponse.
export type Features = { prompt_coach: boolean; chat?: boolean }
export type CoachMode = 'tips' | 'edits' | 'rewrite'
export type CoachSuggestion = {
  dimension: DimensionName
  kind: 'question' | 'tip' | 'edit'
  title: string
  rationale: string
  quote: string | null
  replacement: string | null
  expected_effect: 'lower_ambiguity' | 'determine_dimension' | 'raise_confidence' | 'reduce_words'
}
export type CoachResponse = {
  status: 'ok' | 'nothing_to_improve'
  suggestions: CoachSuggestion[]
  rewrite: string | null
  open_questions: string[]
  fallback: boolean
  dropped: number
  event_id: string | null
}
export type SavedSession = { id: string; title: string; context: string; created_at: string; analysis_count?:number; choice_count?:number }
export type HistoryItem = { request: { task?: string; session_context?: string; personal_context?: string }; result: Analysis; candidate_id: string | null; created_at: string; conversation?: {task:string;task_context:string;response:Analysis}|null }
export type Resume = { sessionId: string; analysis?: HistoryItem }
export type MemorySettings = {content:string; updated_at:string|null; save_enabled:boolean; use_enabled:boolean; coaching_auto_enabled:boolean; conversation_memory_enabled:boolean;saved_conversations:number; memory:{analysis_id:string; profile:Record<string,number|string[]|null>; recommended_capacity?:number; chosen_capacity?:number|null; recommended_model?:string; chosen_model?:string|null; chosen_gap?:number|null}[]}
export function tierOf(candidate: Candidate): Tier {
  return candidate.capacity === 1 ? 'Small' : candidate.capacity === 2 ? 'Medium' : 'Large'
}
/** True for analyses recommended by the old tier policy (stored before ADR-014). */
export function isLegacy(candidate: Candidate): boolean {
  return typeof candidate.capacity === 'number' && !candidate.status
}
/** How a candidate is named in the UI: the model, or the tier for old analyses. */
export function candidateLabel(candidate: Candidate): string {
  return isLegacy(candidate) ? tierOf(candidate) : candidate.name
}
export const NEED_LABELS: Record<NeedName, string> = { reasoning: 'Reasoning', context: 'Context', domain: 'Domain knowledge', reliability: 'Reliability', tools: 'Tools' }
export const COST_BAND_LABELS = { low: 'Low cost', medium: 'Medium cost', high: 'High cost' } as const
export const STATUS_LABELS: Record<CoverageState, string> = { covers: 'Covers the task', covers_as_described: 'Covers it as described', short: 'Falls short' }
export function fitPercent(candidate: Candidate): number | null {
  return typeof candidate.fit === 'number' ? Math.round(candidate.fit * 100) : null
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
  authentication_unavailable: 'The sign-in service is temporarily unavailable. Please try again.',
  verified_email_required: 'Confirm your email address before signing in.',
  account_link_required: 'An existing AdaptAI account uses this email. Enter its previous password to keep your history.',
  account_already_linked: 'This account is already linked. Sign in again or contact the project administrator.',
  provider_authentication: 'The assessment provider rejected the API key. Update the backend .env file and restart the API.',
  provider_not_configured: 'This provider is not configured. Add its credentials on the backend and restart the API.',
  external_processing_requires_consent: 'Allow external processing before requesting this assessment.',
  provider_timeout: 'The provider took too long to respond. Please try again.',
  provider_rate_limit: 'The provider rate limit or quota was reached. Wait before retrying or check the provider account.',
  provider_output_truncated: 'The model used its whole output budget (reasoning models often do) before finishing. Try again or choose another model.',
  invalid_provider_output: 'The provider returned an invalid assessment. No recommendation was generated.',
  provider_model_unavailable: 'The configured model is unavailable. Check the model ID and account access.',
  provider_unsupported_request: 'The configured model does not support this request. Check structured output compatibility.',
  provider_insufficient_credits: 'This model is paid and the OpenRouter API key has no credit or spending limit for it. Choose a free model, or raise the limit in your OpenRouter account.',
  openrouter_catalogue_unavailable: 'The OpenRouter model catalogue could not be loaded. Check the connection and try again.',
  openrouter_catalogue_invalid: 'OpenRouter returned a catalogue the app could not read. Try again later.',
  model_not_found: 'This model is not in the OpenRouter catalogue. Reload the models and choose again.',
  model_not_compatible: 'This model cannot be used for task assessment: no provider offers it with structured output (JSON schema). Choose another model; it may still work in the chat.',
  model_override_not_supported: 'A model can only be chosen manually for OpenRouter.',
  empty_answer: 'The model returned no text. Select Retry, or choose another model.',
  provider_unavailable: 'The assessment provider is unavailable. Check the connection or try again later.',
  previous_analysis_requires_session: 'Re-analysis needs its saved session. Start a new task and try again.',
  previous_analysis_other_session: 'The previous analysis belongs to another session. Start a new task and try again.',
  previous_analysis_incompatible: 'The previous analysis used an older profile version. Start a new task to compare from here.',
  analysis_not_found: 'This analysis no longer exists, possibly because its history was deleted. Analyse the task again to continue.',
  no_eligible_candidate: 'No catalogue model meets the required capabilities. Review the task requirements or update the catalogue.',
}
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) { super(message); this.name = 'ApiError' }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: apiCredentials,
    headers: { ...await authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}))
    const detail = typeof failure.detail === 'string' ? failure.detail : undefined
    throw new ApiError(detail ? errorMessages[detail] ?? detail.replace(/_/g, ' ') : 'Request failed', response.status, detail)
  }
  return response.json()
}

export function getFeatures(signal?: AbortSignal): Promise<Features> {
  return api<Features>('features', undefined, signal)
}
export type CoachSettings = { enabled: boolean }
export function getCoachSettings(signal?: AbortSignal): Promise<CoachSettings> {
  return api<CoachSettings>('prompt-coach/settings', undefined, signal)
}
export async function setCoachSettings(body: CoachSettings): Promise<CoachSettings> {
  const settings = await api<CoachSettings>('prompt-coach/settings', body, undefined, 'PUT')
  window.dispatchEvent(new CustomEvent<CoachSettings>('adaptai-coach-settings-updated', { detail: settings }))
  return settings
}
// True when the module is installed on the server and this user has it switched on.
export async function coachAvailable(signal?: AbortSignal): Promise<boolean> {
  const features = await getFeatures(signal)
  if (features.prompt_coach !== true) return false
  return (await getCoachSettings(signal)).enabled === true
}
export function promptCoach(
  body: { analysis_id: string; task: string; mode: CoachMode; allow_external: boolean },
  signal?: AbortSignal,
): Promise<CoachResponse> {
  return api<CoachResponse>('prompt-coach', body, signal)
}

export function errorMessage(code: string | null | undefined): string {
  if (!code) return 'Something went wrong.'
  return errorMessages[code] ?? code.replace(/_/g, ' ')
}

// Feedback per task (ADR-014). Mirrors backend/app/outcomes.py.
export type TaskOutcome = 'resolved' | 'resolved_with_refinement' | 'not_resolved' | 'skipped'
export type OutcomeReason = 'quality' | 'instructions' | 'description' | 'other'
export type OutcomeInput = {
  outcome: TaskOutcome; reason?: OutcomeReason | null; provider?: string | null; model?: string | null
  turns?: number; switched_model?: boolean; retries?: number; stops?: number
}
export type OutcomeSummary = {
  tasks: number; skipped: number; resolved: number; resolved_with_refinement: number; not_resolved: number
  described_poorly: number; solved_rate_following: number | null; solved_rate_not_following: number | null
  followed: number; mean_turns: number | null; by_model: { model: string | null; tasks: number; solved: number }[]
}
export const putOutcome = (analysisId: string, body: OutcomeInput) => api(`analyses/${analysisId}/outcome`, body, undefined, 'PUT')
export const OUTCOME_REASONS: Record<OutcomeReason, string> = {
  quality: 'Not good or deep enough', instructions: 'Did not follow my request', description: 'I described it poorly', other: 'Other',
}

// Optional chat (ADR-011). Mirrors backend/app/chat.py.
export type ChatStatus = 'complete' | 'stopped' | 'failed'
export type ChatMessage = {
  id: string; role: 'user' | 'assistant'; content: string; provider: string | null; model: string | null
  analysis_id: string | null; status: ChatStatus; error: string | null; created_at: string; completeness: number | null
  /** Feedback for the task this analysed message starts (ADR-014); null while it is open. */
  outcome?: TaskOutcome | null
  /** The model the analysis of this message recommended (ADR-014). */
  recommended?: { name: string | null; provider: string | null; model: string | null; configuration_id: string | null; illustrative: boolean } | null
}
export type ChatSummary = { id: string; title: string; created_at: string; updated_at?: string; message_count: number }
export type Chat = ChatSummary & { messages: ChatMessage[] }
export type ChatTurn = { title: string; message: ChatMessage; answer: ChatMessage }
export type ChatTarget = { provider: 'auto'; configuration_id?: string; allow_external: boolean }
export type ChatHandlers = {
  onMessage?: (message: ChatMessage, answerId: string) => void
  onDelta?: (text: string) => void
  onError?: (code: string) => void
}

export const listChats = (signal?: AbortSignal) => api<ChatSummary[]>('chats', undefined, signal)
export const createChat = () => api<Chat>('chats', {})
export const getChat = (id: string, signal?: AbortSignal) => api<Chat>(`chats/${id}`, undefined, signal)
export const renameChat = (id: string, title: string) => api<ChatSummary>(`chats/${id}`, { title }, undefined, 'PATCH')
export async function deleteChat(id: string): Promise<void> {
  const response = await fetch(apiUrl(`chats/${id}`), { method: 'DELETE', credentials: apiCredentials, headers: await authHeaders() })
  if (!response.ok && response.status !== 404) throw new ApiError('Could not delete the chat', response.status)
}

// Sends (or retries) and reads the Server-Sent Events as they arrive. Aborting the signal is
// Stop: the server keeps the text received so far with status "stopped".
export async function streamChat(path: string, body: unknown, handlers: ChatHandlers, signal: AbortSignal): Promise<ChatTurn> {
  const response = await fetch(apiUrl(path), {
    method: 'POST', credentials: apiCredentials, signal,
    headers: { ...await authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => ({}))
    const detail = typeof failure.detail === 'string' ? failure.detail : undefined
    throw new ApiError(errorMessage(detail ?? 'request_failed'), response.status, detail)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let done: ChatTurn | null = null
  for (;;) {
    const { value, done: finished } = await reader.read()
    if (finished) break
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (!event || data === undefined) continue
      const payload = JSON.parse(data)
      if (event === 'message') handlers.onMessage?.(payload.message, payload.answer_id)
      else if (event === 'delta') handlers.onDelta?.(payload.text)
      else if (event === 'error') handlers.onError?.(payload.code)
      else if (event === 'done') done = payload
    }
  }
  if (!done) throw new ApiError('The answer was interrupted.', 0)
  return done
}
