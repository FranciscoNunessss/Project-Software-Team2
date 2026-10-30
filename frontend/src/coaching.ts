import { useEffect, useState } from 'react'
import { api } from './api'

export type PatternAdvice = { explanation: string; action: string }
type Content = {
  schema_version?: 3
  summary: string
  patterns?: {
    over_provisioning: PatternAdvice
    under_provisioning: PatternAdvice
    prompting: PatternAdvice & { status: 'not_assessed'|'possible_pattern'|'no_clear_pattern' }
  }
  suggestions: { title: string; explanation: string; action: string }[]
}
type Report = { report: Content; model: string; updated_at: string; stale: boolean; source?:{assessments?:number;conversation_samples?:number} }
type State = { configured: boolean; model: string; saved: Report | null; automatic_enabled: boolean; generating: boolean; error: string | null }

export function useCoaching(revision: unknown) {
  const [state, setState] = useState<State>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const value = await api<State>('progress/coaching', undefined, controller.signal)
        if (controller.signal.aborted) return
        setState(value)
        setError(value.error ? 'Suggestions could not be updated. Check Groq availability and quota. With automatic updates enabled, new analyses or confirmed choices will trigger another attempt.' : '')
        if (value.generating) timer = setTimeout(() => void load(), 2000)
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load coaching')
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [revision])

  // Older cached reports remain in the database but do not fill the new pattern cards.
  const saved = state?.saved?.report.schema_version === 3 && state.saved.report.patterns ? state.saved : undefined
  const waiting = !state ? 'Loading personalised guidance…' : !state.automatic_enabled ? 'Enable automatic learning suggestions in Profile to personalise these insights.' : state.generating ? 'Groq is updating your patterns and learning suggestions…' : !state.configured ? 'Project Groq is unavailable. Your saved history remains accessible.' : error ? 'Suggestions could not be updated. Another attempt follows new analyses or confirmed choices.' : 'Your personalised guidance will appear automatically after your first successful analysis.'
  return { state, saved, error, waiting }
}

export type Coaching = ReturnType<typeof useCoaching>
