// Pure helpers: no VS Code import, so they run under `node --test` (see test/*.test.js).

export const TOKEN_PREFIX = 'adaptai_pat_'
export const MAX_TASK = 8000 // AnalysisRequest.task max_length

import type { Analysis, Coach, CoachMode, LlmOption, LlmOptions, Suggestion } from './api'

export type { Analysis, Coach, CoachMode, LlmOption, LlmOptions, Suggestion }

export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length + 20 && !/\s/.test(value)
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
}

// ---- the backend address ----------------------------------------------------------------------

export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

export type BackendUrl = { ok: true; url: string; origin: string; local: boolean } | { ok: false; reason: string }

/**
 * Every request the extension makes (sign-in, token, cookie, the app in the webview) goes to this
 * address, so this is the one place that decides whether it is acceptable. http is only for this
 * machine; anything remote needs https. No credentials, query or fragment in the address itself.
 */
export function checkBackendUrl(value: string): BackendUrl {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return { ok: false, reason: 'The backend address is not a valid URL.' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'The backend address must start with http:// or https://.' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'The backend address must not contain a user name or password.' }
  if (parsed.search || parsed.hash) return { ok: false, reason: 'The backend address must not contain a query or a fragment.' }
  const local = LOCAL_HOSTS.includes(parsed.hostname)
  if (parsed.protocol === 'http:' && !local) {
    return { ok: false, reason: `Refusing plain http to ${parsed.hostname}: a remote backend must use https, otherwise your email, password, token and text would travel in clear text.` }
  }
  return { ok: true, url: parsed.origin + parsed.pathname.replace(/\/+$/, ''), origin: parsed.origin, local }
}

const API_PATH = /^\/api\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*(\?[A-Za-z0-9._~%!$&'()*+,;=:@/?-]*)?$/

/** The only way a request URL is built: the path must be an /api/ path and must stay on the backend. */
export function buildApiUrl(backendUrl: string, path: string): { ok: true; url: string } | { ok: false; reason: string } {
  const base = checkBackendUrl(backendUrl)
  if (!base.ok) return base
  if (typeof path !== 'string' || !API_PATH.test(path) || path.includes('//') || path.includes('..') || path.includes('\\')) {
    return { ok: false, reason: 'Refusing a request outside the AdaptAI API.' }
  }
  let target: URL
  try {
    target = new URL(base.url + path)
  } catch {
    return { ok: false, reason: 'Refusing a malformed request address.' }
  }
  const basePath = new URL(base.url).pathname.replace(/\/+$/, '')
  if (target.origin !== base.origin || !target.pathname.startsWith(`${basePath}/api/`)) {
    return { ok: false, reason: 'Refusing a request that would leave the backend.' }
  }
  return { ok: true, url: target.toString() }
}

const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'accept-language', 'cache-control'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** What a webview may send: a few content headers and a plain method. Never credentials, origin or host. */
export function safeRequest(method: string, headers: Record<string, string>): { method: string; headers: Record<string, string> } | undefined {
  const upper = String(method || 'GET').toUpperCase()
  if (!METHODS.has(upper)) return undefined
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase()
    if (FORWARDED_HEADERS.has(key) && typeof value === 'string') kept[key] = value
  }
  return { method: upper, headers: kept }
}

// ---- what is sent ---------------------------------------------------------------------------------

/** The text to analyse: the selection, else the whole document. Over the API limit it is cut and flagged. */
export function taskFrom(selection: string, document: string): { text: string; source: 'selection' | 'file'; truncated: boolean } {
  const picked = selection.trim() ? selection : document
  // The Coach matches quotes against NFC text, so the text is sent (and edited) in NFC.
  const text = picked.trim().normalize('NFC')
  return { text: text.slice(0, MAX_TASK), source: selection.trim() ? 'selection' : 'file', truncated: text.length > MAX_TASK }
}

/**
 * The same request the web app sends for Analyse (frontend/src/ChatScreen.tsx). ADR-014 A11: the
 * project's assessor analyses every task, whatever model answers in the chat, so there is no model to
 * pick; without an assessor the chat model analyses. `via` is the model that will see the text.
 */
export function analysisPlan(
  task: string,
  options: LlmOptions,
  extra: { chat?: LlmOption; sessionId?: string; previousId?: string; context?: string },
): { body: Record<string, unknown>; via: LlmOption | undefined; manual: boolean } | { error: string } {
  const assessor = options.assessment ?? undefined
  const common = {
    task,
    provider: 'auto',
    task_context: extra.context ?? '',
    required_capabilities: ['text'],
    session_id: extra.sessionId,
    previous_analysis_id: extra.sessionId ? extra.previousId : undefined,
  }
  if (assessor) return { via: assessor, manual: false, body: { ...common, allow_external: assessor.external } }
  const chat = extra.chat
  if (!chat) return { error: 'This backend has no assessment model and no model was chosen. Configure Groq on the backend or add a model in the app (LLM config). An OpenRouter model can chat but cannot assess a task: add Groq, LM Studio or another model for the analysis.' }
  const auto = options.auto_configuration_id === chat.id
  return {
    via: chat,
    manual: !auto,
    body: {
      ...common,
      configuration_id: auto ? undefined : chat.id,
      expected_configuration_id: chat.id,
      expected_provider: chat.provider,
      expected_model: chat.model ?? undefined,
      allow_external: chat.external,
    },
  }
}

export function destination(option: LlmOption | undefined): string {
  if (!option) return 'the selected model'
  return option.model ? `${option.label} · ${option.model}` : option.label
}

/** Did the result come from the model that was chosen? A silent switch to another provider is a failure. */
export function servedBy(analysis: Pick<Analysis, 'provider' | 'assessment_model' | 'configuration_id'>, option: LlmOption | undefined): string | undefined {
  if (!option) return undefined
  if (analysis.provider !== option.provider) return `You chose ${destination(option)}, but the result says it came from ${analysis.provider}.`
  if (option.model && analysis.assessment_model && analysis.assessment_model !== option.model) {
    return `You chose ${destination(option)}, but the result says it came from ${analysis.provider} · ${analysis.assessment_model}.`
  }
  if (analysis.configuration_id && analysis.configuration_id !== option.id) return `You chose ${destination(option)}, but the result came from configuration ${analysis.configuration_id}.`
  return undefined
}

// ---- errors in plain words ------------------------------------------------------------------------

const GENERIC: Record<string, string> = {
  // The codes below were missing; the words are the web app's (frontend/src/api.ts errorMessages).
  no_eligible_candidate: 'No catalogue model meets the required capabilities. Review the task requirements or update the catalogue.',
  no_history_for_coaching: 'Analyse a task first to generate guidance from your usage metadata.',
  history_changed: 'Your history changed while guidance was being generated. Refresh and try again.',
  api_key_required: 'Add an API key for this provider. The existing key can only be reused with the same provider.',
  default_must_be_enabled: 'Enable the model before making it the Auto default.',
  credentials_key_missing: 'The backend encryption key is missing. Restore it before changing saved credentials.',
  credentials_key_unavailable: 'The backend encryption key cannot be read. Check the server configuration.',
  credentials_unavailable: 'The saved credential could not be decrypted. Restore the matching backend key or replace this API key.',
  email_already_registered: 'This email already has an account. Sign in to continue.',
  authentication_required: 'Your session has expired. Please sign in again.',
  authentication_unavailable: 'The sign-in service is temporarily unavailable. Please try again.',
  verified_email_required: 'Confirm your email address before signing in.',
  account_link_required: 'An existing AdaptAI account uses this email. Enter its previous password to keep your history.',
  account_already_linked: 'This account is already linked. Sign in again or contact the project administrator.',
  openrouter_catalogue_unavailable: 'The OpenRouter model catalogue could not be loaded. Check the connection and try again.',
  openrouter_catalogue_invalid: 'OpenRouter returned a catalogue the app could not read. Try again later.',
  model_not_found: 'This model is not in the OpenRouter catalogue. Reload the models and choose again.',
  model_override_not_supported: 'A model can only be chosen manually for OpenRouter.',
  previous_analysis_requires_session: 'Re-analysis needs its saved session. Start a new task and try again.',
  previous_analysis_other_session: 'The previous analysis belongs to another session. Start a new task and try again.',
  previous_analysis_incompatible: 'The previous analysis used an older profile version. Start a new task to compare from here.',
  external_processing_requires_consent: 'This model is external and the request did not carry your consent.',
  provider_not_configured: 'That model is not configured on this backend. Add it in the app (LLM config).',
  configuration_disabled: 'That model configuration is switched off in the app.',
  configuration_not_found: 'That model configuration no longer exists. Pick another.',
  project_default_not_configured: 'The project has no default model configured, so Auto is unavailable.',
  model_configuration_changed: 'The model configuration changed while you were choosing. Pick the model again and retry.',
  model_not_compatible: 'That model cannot return the structured answer AdaptAI needs. Pick another model.',
  invalid_provider_output: 'The model answered, but not in the format AdaptAI needs (invalid output). Retry, or pick another model.',
  empty_answer: 'The model returned an empty answer. Retry, or pick another model.',
  answer_truncated: 'The answer reached the length limit and was cut off. Select Continue to get the rest.',
  provider_output_truncated: 'The model stopped before finishing its answer. Retry, or pick another model.',
  provider_authentication: 'The provider refused the credentials (API key missing, wrong or without access).',
  provider_insufficient_credits: 'The provider account has no credit left.',
  provider_rate_limit: 'The provider is rate limiting. Wait a moment and retry.',
  provider_unsupported_request: 'The provider rejected the request as unsupported for this model.',
  provider_model_unavailable: 'The provider does not know that model.',
  provider_timeout: 'The model took too long to answer.',
  provider_unavailable: 'The provider could not be reached or failed.',
  prompt_coach_disabled: 'Prompt Coach is off for your account.',
  analysis_not_found: 'The analysis is no longer stored, so the Coach cannot use it. Analyse again.',
  token_rejected: 'The backend does not accept this token (revoked or expired).',
  invalid_credentials: 'Wrong email or password.',
  use_supabase_auth: 'This backend signs in with Supabase in the app, so a password cannot be checked here. Create a token in the app (Profile > API tokens) and paste it.',
  token_limit_reached: 'You already have 10 active tokens. Revoke one in Profile > API tokens.',
}

const LM_STUDIO: Record<string, string> = {
  provider_unavailable: 'LM Studio could not be reached. Start its local server (Developer tab) and check that the address the backend uses is the one it listens on.',
  provider_model_unavailable: 'LM Studio does not have that model loaded. Load the model in LM Studio, or pick the one that is loaded.',
  provider_timeout: 'LM Studio took too long. The model may still be loading, or it is too large for this machine; retry in a moment.',
  invalid_provider_output: 'LM Studio answered, but not in the structured format AdaptAI needs. Try another model.',
  provider_unsupported_request: 'LM Studio rejected the structured request. This model may not support JSON schema output.',
  model_not_compatible: 'This LM Studio model is not compatible with structured output. Pick another.',
  provider_output_truncated: 'The LM Studio model ran out of output budget before finishing. Retry, or use a model that reasons less.',
  empty_answer: 'LM Studio returned no text. Either the model is still loading, or it is a reasoning model that spent the short test budget thinking (the chat and the analysis give it more room and usually work). Retry, or send a real message.',
}

/** A message for an HTTP status and backend `detail` code. `provider` makes LM Studio errors specific. */
export function describeFailure(status: number, detail: string, provider?: string): string {
  if (status === 401) return 'You are signed out, or the token was revoked or expired. Run "AdaptAI: Sign in".'
  if (provider === 'lmstudio' && LM_STUDIO[detail]) return LM_STUDIO[detail]
  if (provider === 'groq' && detail === 'provider_unavailable') return 'Groq could not be reached or failed. Check your connection and the API key, then retry.'
  if (status === 422) return `The backend rejected the request as invalid (${detail}).`
  return GENERIC[detail] ?? `The backend answered ${status} (${detail}).`
}

// ---- tiers, in the app's words ----------------------------------------------------------------------

/** Replace the quote with its replacement in the text, once; undefined when the quote is not there. */
export function applyEdit(text: string, suggestion: Pick<Suggestion, 'quote' | 'replacement'>): string | undefined {
  if (!suggestion.quote || suggestion.replacement === null || suggestion.replacement === undefined) return undefined
  const index = text.indexOf(suggestion.quote)
  if (index < 0) return undefined
  return text.slice(0, index) + suggestion.replacement + text.slice(index + suggestion.quote.length)
}

/** The improved text a mode produces: the full rewrite, or every grounded edit applied in turn. */
export function improvedText(original: string, coach: Coach, mode: CoachMode): string | undefined {
  if (mode === 'rewrite') return coach.rewrite && coach.rewrite !== original ? coach.rewrite : undefined
  if (mode === 'edits') {
    let text = original
    for (const item of coach.suggestions) {
      if (item.kind !== 'edit') continue
      text = applyEdit(text, item) ?? text
    }
    return text !== original ? text : undefined
  }
  return undefined
}

// ---- secrets ----------------------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:sk|pk|rk)-(?:or-v1-|ant-|live-|proj-)?[A-Za-z0-9_-]{20,}/, 'an API key (sk-...)'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'a Groq API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\badaptai_pat_[A-Za-z0-9_-]{20,}/, 'an AdaptAI token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JSON web token'],
  [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i, 'a password or secret assignment'],
]

/** What the text looks like it contains, so the user is warned before it leaves the machine. */
export function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

/** Files that hold secrets by convention are never sent. */
export function isSecretFile(name: string): boolean {
  return /^\.env(\..*)?$/i.test(name) || /\.(pem|key|p12|pfx|keystore)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)$/.test(name) || /^\.?(npmrc|netrc|pgpass)$/i.test(name)
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

// ---- connection state -----------------------------------------------------------------------------

export type Connection = { state: 'tested' | 'failed'; at: number; ms?: number; detail?: string }

/** "configured" is only what the backend lists; "tested" means a real request succeeded, and when. */
export function connectionLabel(connection: Connection | undefined, now = Date.now()): string {
  if (!connection) return 'configured, not tested'
  const time = new Date(connection.at).toLocaleTimeString()
  const age = now - connection.at > 10 * 60_000 ? ' (older than 10 min)' : ''
  return connection.state === 'tested'
    ? `connection tested OK at ${time}${connection.ms ? `, ${(connection.ms / 1000).toFixed(1)} s` : ''}${age}`
    : `last test failed at ${time}: ${connection.detail ?? 'unknown error'}`
}

// ---- LM Studio: is the server there, and is the model loaded? ---------------------------------

/** The model list URL for the configured LM Studio address (with or without a trailing /v1). */
export function lmStudioModelsUrl(setting: string): { ok: true; url: string; base: string } | { ok: false; reason: string } {
  const checked = checkBackendUrl(setting)
  if (!checked.ok) return { ok: false, reason: `LM Studio address: ${checked.reason}` }
  const base = checked.url.replace(/\/v1$/, '')
  return { ok: true, base, url: `${base}/v1/models` }
}

/** Reads LM Studio's GET /v1/models answer and says whether `model` is loaded. */
export function checkLmStudioModels(body: unknown, model: string | null, base: string): { ok: true; loaded: string[] } | { ok: false; reason: string } {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.some(item => typeof (item as { id?: unknown })?.id !== 'string')) {
    return { ok: false, reason: `${base} answered, but not like LM Studio's model list. Is this the LM Studio server address (adaptai.lmStudioUrl)?` }
  }
  const loaded = data.map(item => (item as { id: string }).id).filter(id => !/embed/i.test(id))
  if (loaded.length === 0) return { ok: false, reason: `LM Studio is running at ${base}, but no chat model is loaded. Load one in LM Studio.` }
  if (model && !loaded.includes(model)) {
    return { ok: false, reason: `LM Studio is running at ${base}, but the model “${model}” is not loaded. Loaded: ${loaded.join(', ')}. LM Studio would answer with a different model, so AdaptAI refuses to call that a pass.` }
  }
  return { ok: true, loaded }
}
