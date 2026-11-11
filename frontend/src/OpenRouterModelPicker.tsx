import { Fragment, useEffect, useMemo, useState } from 'react'
import { StatusBadge, type ModelStatus } from './modelStatus'
import { api, formatContext, formatPrice, type OpenRouterCatalogue, type OpenRouterModel } from './api'
import { Popover, usePopover } from './ui'
import './ModelPicker.css'

type Props = {
  /** The OpenRouter model id that will be sent to the backend. */
  value: string
  disabled: boolean
  onChange: (id: string) => void
  /** The user's OpenRouter configuration: "Evaluate" adds a model to their models (A12). */
  configurationId?: string
}
type Filter = 'all' | 'free' | 'paid'

/** Second picker shown only for the user's own OpenRouter configuration: a model of the live catalogue. */
export function OpenRouterModelPicker({ value, disabled, onChange, configurationId }: Props) {
  const [catalogue, setCatalogue] = useState<OpenRouterCatalogue>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const load = async (refresh = false) => {
    setLoading(true); setError('')
    try { setCatalogue(await api<OpenRouterCatalogue>(`openrouter/models${refresh ? '?refresh=true' : ''}`)) }
    catch (failure) { setCatalogue(undefined); setError(failure instanceof Error ? failure.message : 'Could not load the OpenRouter models') }
    finally { setLoading(false) }
  }
  const selected = catalogue?.models.find(model => model.id === value)
  const title = selected?.name ?? (value || 'Choose a model')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = (catalogue?.models ?? []).filter(model =>
      (filter === 'all' || (filter === 'free') === model.free) &&
      (!needle || [model.id, model.name, model.organisation].some(text => text.toLowerCase().includes(needle))))
    const byOrganisation = new Map<string, OpenRouterModel[]>()
    for (const model of visible) byOrganisation.set(model.organisation, [...(byOrganisation.get(model.organisation) ?? []), model])
    return { count: visible.length, groups: [...byOrganisation.entries()] }
  }, [catalogue, query, filter])

  // The list grows and shrinks as it loads and is filtered: place the panel again each time.
  const popover = usePopover({ id: 'openrouter-model-picker', width: 460, maxHeight: 560, minHeight: 120, watch: [catalogue, groups.count, error, loading] })
  const { open, close } = popover
  // Models are fetched when the list is first opened, never from a built-in list.
  useEffect(() => { if (open && !catalogue && !loading && !error) void load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const [queued, setQueued] = useState<Record<string, string>>({})
  // ADR-014 A12: evaluate a model without sending anything; it joins the user's models.
  const evaluate = async (id: string) => {
    if (!configurationId) return
    setQueued(current => ({ ...current, [id]: 'Adding…' }))
    try { await api('evaluations/models', { configuration_id: configurationId, model: id }); setQueued(current => ({ ...current, [id]: 'Added: see LLM config' })); window.dispatchEvent(new Event('adaptai-models-updated')) }
    catch (failure) { setQueued(current => ({ ...current, [id]: failure instanceof Error ? failure.message : 'Could not add' })) }
  }
  const choose = (id: string) => { onChange(id); close() }

  return <div className="model-picker openrouter-picker">
    <button {...popover.triggerProps} className="model-picker-trigger" type="button" aria-label={`OpenRouter model: ${title}`} disabled={disabled}>
      <span className="model-picker-brand">OpenRouter</span><span className="model-picker-current">{title}</span>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    <Popover handle={popover} className="model-picker-panel openrouter-panel" role="dialog" aria-label="Choose OpenRouter model">
      <p className="model-picker-heading">OpenRouter model</p>
      <div className="model-picker-group">
        <p>All models{catalogue ? ` · ${catalogue.models.length}` : ''}</p>
        <input className="openrouter-search" type="search" aria-label="Search OpenRouter models" placeholder="Search by name, organisation or id" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="openrouter-filters" role="group" aria-label="Filter by price">
          {(['all', 'free', 'paid'] as const).map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'all' ? 'All' : item === 'free' ? 'Free' : 'Paid'}</button>)}
        </div>
        <p className="openrouter-note">Prices are USD per 1M tokens. Paid models need credit on the API key; if it has none, the request is refused with a clear message.</p>
        {loading && <p className="openrouter-status" role="status">Loading models from OpenRouter…</p>}
        {!loading && error && <div className="openrouter-status" role="alert"><p>{error}</p><button type="button" onClick={() => void load(true)}>Try again</button></div>}
        {!loading && !error && catalogue && catalogue.models.length === 0 && <p className="openrouter-status" role="status">OpenRouter returned no models.</p>}
        {!loading && !error && catalogue && catalogue.models.length > 0 && groups.count === 0 && <p className="openrouter-status" role="status">No models match your search or filter.</p>}
        {!loading && !error && groups.groups.map(([organisation, models]) => <div key={organisation}>
          <p className="openrouter-note"><strong>{organisation}</strong> · {models.length}</p>
          {models.map(model => <Fragment key={model.id}><button type="button" className="model-picker-option" aria-pressed={value === model.id} disabled={disabled || !model.selectable} title={model.unavailable_reason ?? model.description} onClick={() => choose(model.id)}>
            <span className="model-picker-symbol" aria-hidden="true">{organisation.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{model.name} <span className={`openrouter-badge${model.free ? '' : ' is-paid'}`}>{model.free ? 'FREE' : 'PAID'}</span> <StatusBadge status={model.status as ModelStatus | undefined} /></strong>
              <small className="model-picker-id">{model.id}</small>
              <small>Input {formatPrice(model.price_input_per_million)} · Output {formatPrice(model.price_output_per_million)} · Context {formatContext(model.context_length)}</small>
              {!model.selectable && <small>{model.unavailable_reason}</small>}
            </span>
            <span className="model-picker-check" aria-hidden="true">{value === model.id ? '✓' : ''}</span>
          </button>
          {model.selectable && configurationId && (model.status?.state === 'none' || model.status?.state === 'failed') && <div className="model-evaluate-row">
            {queued[model.id] ? <small role="status">{queued[model.id]}</small> : <button type="button" data-evaluate-model={model.id} aria-label={`Evaluate model ${model.id}`} disabled={disabled} onClick={() => void evaluate(model.id)}>Evaluate</button>}
          </div>}</Fragment>)}
        </div>)}
      </div>
      <div className="model-picker-footer"><button type="button" disabled={loading} onClick={() => void load(true)}>Reload models <span aria-hidden="true">↻</span></button><p>The list is fetched live from OpenRouter.</p></div>
    </Popover>
  </div>
}
