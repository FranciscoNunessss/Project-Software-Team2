import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, NEED_LABELS, type NeedName } from './api'

// Model evaluations (ADR-014): what was measured for each model you can use, where the levels
// come from, and the consent for a paid evaluation with its estimated and maximum cost.

type Rating = { level: number | null; status: string; source: string; observed_on?: string }
type Estimate = { calls_max: number; input_tokens_max: number; output_tokens_max: number; price_known: boolean; free: boolean; estimated_usd: number | null; max_usd: number | null }
type Evaluation = {
  id: string; status: 'awaiting_consent' | 'declined' | 'queued' | 'running' | 'done' | 'failed'
  progress: number; total: number; errors: number; failure: string | null; estimate: Estimate | null; spent_usd: number
  finished_at: string | null
  levels: Record<NeedName, { level: number; below_level_1: boolean; pass_rates: Record<string, number> }> | null
  examples: { id: string; capability: string; level: number; passed: boolean; answer: string }[]
}
type ModelEntry = {
  provider: string; model: string; configuration_id: string; shared: boolean; paid_by_you: boolean
  levels_source: 'calibrated' | 'measured' | 'provisional' | 'arena' | 'benchmark' | 'family' | null
  levels: Record<NeedName, Rating> | null; evaluation: Evaluation | null; picked?: boolean
}

const SOURCE: Record<string, string> = {
  calibrated: 'Calibrated by the team', measured: 'Measured by AdaptAI', provisional: 'Provisional (catalogue)',
  arena: 'Provisional (LMArena public ranking, CC BY 4.0)', benchmark: 'Provisional (Artificial Analysis overall index)', family: 'Provisional (same family)',
}
const FAILURE: Record<string, string> = {
  cost_limit_reached: 'Stopped at the maximum cost.', too_many_failed_calls: 'Too many calls failed; it will be retried.',
  provider_refused: 'The provider refused the calls (no credit, a daily limit or the model withdrawn).',
  configuration_gone: 'The configuration was removed or disabled.',
  interrupted: 'Interrupted by a restart. Re-evaluate when you want; nothing more was charged.',
}
const usd = (value: number | null | undefined) => value == null ? 'unknown' : value < 0.01 ? `${(value * 100).toFixed(2)} cents (USD)` : `${value.toFixed(2)} USD`

function Consent({ entry, onDone }: { entry: ModelEntry; onDone: () => void }) {
  const evaluation = entry.evaluation!
  const cost = evaluation.estimate
  const [second, setSecond] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const answer = async (accept: boolean) => {
    if (accept && cost && !cost.price_known && !second) { setSecond(true); return }
    setBusy(true); setError('')
    try { await api(`evaluations/${evaluation.id}/consent`, { accept, confirm_unknown_price: second }); onDone() }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'Could not save your answer.') }
    finally { setBusy(false) }
  }
  return (
    <div className="evaluation-consent" data-evaluation-consent="">
      <p><strong>Evaluate {entry.model} with your key?</strong></p>
      <ul>
        <li><strong>What:</strong> up to {cost?.calls_max ?? 40} synthetic tasks (reasoning, context, domain knowledge, reliability, tools). None of your data is sent.</li>
        <li><strong>How:</strong> answers are graded automatically; level 2 first, then 3 or 1. {entry.shared ? 'The result is shared with other users of this model.' : 'The result is only for you.'}</li>
        {cost?.price_known
          ? <li data-evaluation-cost=""><strong>Cost:</strong> about {usd(cost.estimated_usd)}, never more than <strong>{usd(cost.max_usd)}</strong> (charged by your provider).</li>
          : <li data-evaluation-cost=""><strong>Cost:</strong> price unknown. At most {cost?.input_tokens_max.toLocaleString()} input and {cost?.output_tokens_max.toLocaleString()} output tokens; check your provider's prices.</li>}
        <li><strong>Time:</strong> 5 to 15 minutes in the background. You can keep using the chat.</li>
        <li><strong>If you decline:</strong> the model still works in the chat but is not recommended.</li>
      </ul>
      {second && <p className="api-error" role="alert">The price is unknown. Confirm again only if you checked it with your provider.</p>}
      {error && <p className="api-error" role="alert">{error}</p>}
      <div className="history-actions">
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void answer(true)} data-evaluation-accept="">{second ? 'Yes, I checked the price' : 'Evaluate'}</button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void answer(false)}>Not now</button>
      </div>
    </div>
  )
}

function Entry({ entry, reload }: { entry: ModelEntry; reload: () => void }) {
  const evaluation = entry.evaluation
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const reevaluate = async () => { await api('evaluations/reevaluate', { configuration_id: entry.configuration_id }); reload() }
  const disagree = async (capability: NeedName) => {
    if (!evaluation) return
    await api(`evaluations/${evaluation.id}/disagree`, { capability })
    setNote(`Noted: you disagree with ${NEED_LABELS[capability].toLowerCase()}. The team reviews these reports.`)
  }
  const status = evaluation?.status
  return (
    <section className="card evaluation-entry" data-evaluation-model={entry.model}>
      <div className="card-heading">
        <div><h3>{entry.model}</h3><p className="muted">{entry.provider}{entry.shared ? ' · shared result' : ' · only for you'}</p></div>
        <span className="period" data-evaluation-status={status ?? 'none'}>
          {status === 'running' || status === 'queued' ? `Evaluating… ${evaluation!.progress}/${evaluation!.total}`
            : status === 'awaiting_consent' ? 'Waiting for your consent'
            : status === 'declined' ? 'Not evaluated'
            : status === 'failed' ? 'Evaluation failed'
            : entry.levels_source ? SOURCE[entry.levels_source] : 'Not evaluated'}
        </span>
      </div>
      {(status === 'awaiting_consent' || status === 'declined') && <Consent entry={entry} onDone={reload} />}
      {status === 'failed' && evaluation?.failure && <p className="muted">{FAILURE[evaluation.failure] ?? evaluation.failure}</p>}
      {entry.levels && (
        <table className="coverage-table evaluation-levels">
          <caption className="sr-only">Levels of {entry.model}</caption>
          <thead><tr><th scope="col">Capability</th><th scope="col">Level</th><th scope="col">Source</th><th scope="col"><span className="sr-only">Disagree</span></th></tr></thead>
          <tbody>{(Object.keys(NEED_LABELS) as NeedName[]).map(name => (
            <tr key={name}>
              <th scope="row">{NEED_LABELS[name]}</th>
              <td>{entry.levels![name]?.level ?? '–'}</td>
              <td className="muted">{entry.levels![name]?.source}</td>
              <td><button type="button" className="chat-link" onClick={() => void disagree(name)}>Disagree</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {note && <p role="status" className="muted">{note}</p>}
      <div className="history-actions">
        {evaluation?.examples?.length ? <button type="button" className="button button-secondary" onClick={() => setOpen(!open)}>{open ? 'Hide examples' : 'Show examples'}</button> : null}
        {(status === 'done' || status === 'failed') && <button type="button" className="button button-secondary" onClick={() => void reevaluate()}>Re-evaluate</button>}
        {entry.picked && <button type="button" className="button button-secondary" onClick={() => void api(`evaluations/models?configuration_id=${encodeURIComponent(entry.configuration_id)}&model=${encodeURIComponent(entry.model)}`, undefined, undefined, 'DELETE').then(reload)}>Remove from my models</button>}
      </div>
      {open && evaluation && (
        <ul className="evaluation-examples">{evaluation.examples.map(item => (
          <li key={item.id}><strong>{item.passed ? '✓' : '✗'} {NEED_LABELS[item.capability as NeedName]} {item.level}</strong><pre>{item.answer}</pre></li>
        ))}</ul>
      )}
    </section>
  )
}

type Config = { id: string; provider: string; label: string; model: string; enabled: boolean }

/** OpenRouter: add a model from its catalogue to be evaluated and recommended (ADR-014). */
function AddRouterModel({ configs, onAdded }: { configs: Config[]; onAdded: () => void }) {
  const [picked, setConfig] = useState('')
  // The list loads after the first render: default to the first configuration then.
  const config = configs.some(item => item.id === picked) ? picked : configs[0]?.id ?? ''
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!configs.length) return null
  const add = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await api('evaluations/models', { configuration_id: config, model: model.trim() }); setModel(''); onAdded() }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'Could not add the model.') }
    finally { setBusy(false) }
  }
  return (
    <form className="card evaluation-add" onSubmit={add} data-add-router-model="">
      <p><strong>Add an OpenRouter model</strong> <span className="muted">Models you pick in the chat are added on first use; you can also add them here to have them evaluated first.</span></p>
      <div className="history-actions">
        {configs.length > 1 && <select aria-label="OpenRouter configuration" value={config} onChange={event => setConfig(event.target.value)}>{configs.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
        <input aria-label="OpenRouter model id" placeholder="e.g. google/gemma-4-31b-it:free" value={model} onChange={event => setModel(event.target.value)} />
        <button className="button button-secondary" disabled={busy || !model.trim()}>Add and evaluate</button>
      </div>
      {error && <p className="api-error" role="alert">{error}</p>}
    </form>
  )
}

export function ModelEvaluations() {
  const [models, setModels] = useState<ModelEntry[]>()
  const [error, setError] = useState('')
  const [routers, setRouters] = useState<Config[]>([])
  const load = useCallback(() => {
    api<{ models: ModelEntry[] }>('evaluations').then(data => { setModels(data.models); setError('') }).catch(() => setError('Could not load the model evaluations.'))
    api<Config[]>('llm-configs').then(items => setRouters(items.filter(item => item.provider === 'openrouter' && item.enabled))).catch(() => undefined)
  }, [])
  useEffect(() => { load() }, [load])
  const running = models?.some(item => item.evaluation && ['queued', 'running'].includes(item.evaluation.status))
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [running, load])
  return (
    <section className="model-evaluations" aria-labelledby="evaluations-title" data-model-evaluations="">
      <p className="eyebrow">Recommendations</p>
      <h2 id="evaluations-title">How your models were evaluated</h2>
      <p className="muted">Only models you can use are evaluated, once, with synthetic tasks graded automatically. A model without levels still works in the chat but is never recommended.</p>
      {error && <p className="api-error" role="alert">{error}</p>}
      {!models && !error && <p role="status">Loading evaluations…</p>}
      {models?.length === 0 && <p className="muted">No models configured yet.</p>}
      <AddRouterModel configs={routers} onAdded={load} />
      {models?.map(item => <Entry key={`${item.provider}:${item.model}`} entry={item} reload={load} />)}
    </section>
  )
}
