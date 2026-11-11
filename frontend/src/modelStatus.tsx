// One short status per model for the pickers (ADR-014 A12), the same rules as the backend's
// evaluations.label: what the user can expect from a model before choosing it.
import './modelStatus.css'
export type ModelStatus = { state: 'evaluating' | 'consent' | 'measured' | 'public' | 'provisional' | 'failed' | 'none'; text: string }

type Entry = {
  provider: string; model: string
  levels_source: string | null
  evaluation: { status: string; progress: number; total: number } | null
}

export function statusOf(entry: Entry | undefined): ModelStatus {
  const status = entry?.evaluation?.status
  if (status === 'queued' || status === 'running') return { state: 'evaluating', text: `Evaluating ${entry!.evaluation!.progress}/${entry!.evaluation!.total}` }
  if (status === 'awaiting_consent') return { state: 'consent', text: 'Waiting for consent' }
  const source = entry?.levels_source
  if (source === 'calibrated' || source === 'measured') return { state: 'measured', text: 'Measured' }
  if (source === 'arena') return { state: 'public', text: 'Public ranking' }
  if (source === 'benchmark' || source === 'provisional' || source === 'family') return { state: 'provisional', text: 'Provisional' }
  if (status === 'failed') return { state: 'failed', text: 'Evaluation failed' }
  return { state: 'none', text: 'Not evaluated' }
}

export const statusKey = (provider: string, model: string | null | undefined) => `${provider}|${model ?? ''}`

export function StatusBadge({ status }: { status?: ModelStatus }) {
  return status ? <span className={`model-status is-${status.state}`} data-model-status={status.state}>{status.text}</span> : null
}
