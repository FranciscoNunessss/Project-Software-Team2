import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, formatContext, formatPrice, OPENROUTER_AUTO, type OpenRouterCatalogue, type OpenRouterModel } from './api'

type Props = {
  /** The OpenRouter model id that will be sent to the backend. */
  value: string
  disabled: boolean
  onChange: (id: string) => void
}
type Filter = 'all' | 'free' | 'paid'

const AUTO_LABEL = 'Auto — Free model'

/** Second picker shown only for OpenRouter: Auto, or any model from the live catalogue. */
export function OpenRouterModelPicker({ value, disabled, onChange }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
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
  // Models are fetched when the list is first opened, never from a built-in list.
  useEffect(() => { if (open && !catalogue && !loading && !error) void load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = catalogue?.models.find(model => model.id === value)
  const title = value === OPENROUTER_AUTO ? AUTO_LABEL : selected?.name ?? value

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = (catalogue?.models ?? []).filter(model =>
      (filter === 'all' || (filter === 'free') === model.free) &&
      (!needle || [model.id, model.name, model.organisation].some(text => text.toLowerCase().includes(needle))))
    const byOrganisation = new Map<string, OpenRouterModel[]>()
    for (const model of visible) byOrganisation.set(model.organisation, [...(byOrganisation.get(model.organisation) ?? []), model])
    return { count: visible.length, groups: [...byOrganisation.entries()] }
  }, [catalogue, query, filter])

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      if (!trigger.current || !panel.current) return
      const bounds = trigger.current.getBoundingClientRect()
      const width = Math.min(460, window.innerWidth - 24)
      const below = window.innerHeight - bounds.bottom - 20
      const above = bounds.top - 20
      const height = Math.min(panel.current.scrollHeight + 2, 560)
      const opensAbove = below < height && above > below
      const available = Math.max(120, opensAbove ? above : below)
      panel.current.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`
      panel.current.style.top = `${opensAbove ? Math.max(12, bounds.top - Math.min(height, available) - 8) : bounds.bottom + 8}px`
      panel.current.style.maxHeight = `${available}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, catalogue, groups.count, error, loading])

  const close = () => { panel.current?.hidePopover(); trigger.current?.focus() }
  const choose = (id: string) => { onChange(id); close() }

  return <div className="model-picker openrouter-picker">
    <button ref={trigger} className="model-picker-trigger" type="button" popoverTarget="openrouter-model-picker" aria-label={`OpenRouter model: ${title}`} aria-expanded={open} aria-controls="openrouter-model-picker" disabled={disabled}>
      <span className="model-picker-brand">OpenRouter</span><span className="model-picker-current">{title}</span>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    <div ref={panel} id="openrouter-model-picker" className="model-picker-panel openrouter-panel" popover="auto" role="dialog" aria-label="Choose OpenRouter model" onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
      <p className="model-picker-heading">OpenRouter model</p>
      <button className="model-picker-option" type="button" aria-pressed={value === OPENROUTER_AUTO} disabled={disabled} onClick={() => choose(OPENROUTER_AUTO)}>
        <span className="model-picker-symbol" aria-hidden="true">✦</span>
        <span><strong>{AUTO_LABEL}</strong><small>OpenRouter picks a compatible free model for you.</small><small className="model-picker-id">{OPENROUTER_AUTO}</small></span>
        <span className="model-picker-check" aria-hidden="true">{value === OPENROUTER_AUTO ? '✓' : ''}</span>
      </button>
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
          {models.map(model => <button key={model.id} type="button" className="model-picker-option" aria-pressed={value === model.id} disabled={disabled || !model.selectable} title={model.unavailable_reason ?? model.description} onClick={() => choose(model.id)}>
            <span className="model-picker-symbol" aria-hidden="true">{organisation.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{model.name} <span className={`openrouter-badge${model.free ? '' : ' is-paid'}`}>{model.free ? 'FREE' : 'PAID'}</span></strong>
              <small className="model-picker-id">{model.id}</small>
              <small>Input {formatPrice(model.price_input_per_million)} · Output {formatPrice(model.price_output_per_million)} · Context {formatContext(model.context_length)}</small>
              {!model.selectable && <small>{model.unavailable_reason}</small>}
            </span>
            <span className="model-picker-check" aria-hidden="true">{value === model.id ? '✓' : ''}</span>
          </button>)}
        </div>)}
      </div>
      <div className="model-picker-footer"><button type="button" disabled={loading} onClick={() => void load(true)}>Reload models <span aria-hidden="true">↻</span></button><p>The list is fetched live from OpenRouter.</p></div>
    </div>
  </div>
}
