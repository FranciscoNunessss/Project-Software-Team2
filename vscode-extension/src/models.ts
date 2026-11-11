import { destination } from './core'

export type Estimate = { calls_max: number; input_tokens_max: number; output_tokens_max: number; price_known: boolean; free: boolean; estimated_usd: number | null; max_usd: number | null }
export type Evaluation = {
  provider: string
  model: string
  configuration_id: string | null
  shared: boolean
  paid_by_you: boolean
  picked?: boolean
  levels_source: string | null
  levels: Record<string, number> | null
  evaluation: null | { id: string; status: string; progress: number; total: number; errors: number; failure: string | null; estimate: Estimate | null; spent_usd: number | null; finished_at: string | null; levels: Record<string, number> | null }
}
export type PersonalConfig = { id: string; label: string; provider: string; model: string; has_key: boolean; enabled: boolean; is_default: boolean; external: boolean; responses_api: boolean }
export type CatalogueModel = { id: string; name: string; organisation: string; context_length?: number | null; price_input_per_million?: number | null; price_output_per_million?: number | null; free?: boolean; selectable?: boolean; reason?: string | null }

export const PROVIDERS = [
  { label: 'Groq', provider: 'groq', key: true, hint: 'for example openai/gpt-oss-20b' },
  { label: 'OpenAI', provider: 'openai', key: true, hint: 'for example gpt-5.4-mini' },
  { label: 'Claude (Anthropic)', provider: 'claude', key: true, hint: 'for example claude-sonnet-5-5' },
  { label: 'OpenRouter', provider: 'openrouter', key: true, hint: 'optional: any model of the catalogue can be picked later' },
  { label: 'LM Studio', provider: 'lmstudio', key: false, hint: 'the model loaded in LM Studio' },
  { label: 'Ollama', provider: 'ollama', key: false, hint: 'for example gemma3:12b' },
] as const

export const CAPABILITIES = ['reasoning', 'context', 'domain', 'reliability', 'tools'] as const

/** The state of one evaluation in words the user can act on. */
export function describeEvaluation(entry: Evaluation): { text: string; icon: string; consent: boolean } {
  const e = entry.evaluation
  if (!e) return entry.levels ? { text: `Not measured · ${entry.levels_source ?? 'provisional levels'}`, icon: 'circle-outline', consent: false } : { text: 'Not evaluated', icon: 'circle-slash', consent: false }
  const levels = (e.levels ?? entry.levels) ? ' · ' + Object.entries((e.levels ?? entry.levels) as Record<string, number>).map(([name, value]) => `${name[0].toUpperCase()}${value}`).join(' ') : ''
  switch (e.status) {
    case 'awaiting_consent':
      return { text: 'Waiting for your consent', icon: 'bell', consent: true }
    case 'declined':
      return { text: `Declined${entry.levels ? ` · ${entry.levels_source ?? 'provisional levels'}` : ''}`, icon: 'circle-slash', consent: false }
    case 'queued':
      return { text: 'Queued', icon: 'clock', consent: false }
    case 'running':
      return { text: `Evaluating ${e.progress}/${e.total}`, icon: 'sync~spin', consent: false }
    case 'done':
      return { text: `Measured by AdaptAI${levels}`, icon: 'pass-filled', consent: false }
    case 'failed':
      return { text: `Evaluation failed${e.failure ? ` (${e.failure.replace(/_/g, ' ')})` : ''}`, icon: 'error', consent: false }
    default:
      return { text: e.status, icon: 'question', consent: false }
  }
}

/** What the consent dialog says before a paid evaluation: what is sent, the cost, the ceiling, what declining means. */
export function consentText(entry: Evaluation): string {
  const e = entry.evaluation?.estimate
  const cost = !e ? 'The cost is not known.' : e.free ? 'It is free.' : e.price_known ? `Estimated cost ${e.estimated_usd?.toFixed(4)} USD, never more than ${e.max_usd?.toFixed(4)} USD.` : 'The price of this model is not known, so the cost cannot be estimated.'
  return `Evaluate ${entry.provider} · ${entry.model}?\n\nAdaptAI sends up to ${e?.calls_max ?? 40} synthetic tasks (none of your text) to ${entry.provider} with your key, to measure the model's levels. ${cost}\n\nIf you decline, you can still use the model in the chat; it may just not be recommended until it is measured.`
}

export { destination }
