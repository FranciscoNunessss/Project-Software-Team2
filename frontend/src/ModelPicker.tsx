import { StatusBadge, statusKey, type ModelStatus } from './modelStatus'
import { useLayoutEffect } from 'react'
import { usePageActive } from './PagePanel'
import type { LLMOption } from './api'
import { Popover, usePopover } from './ui'
import './ModelPicker.css'

type Props = {
  options: LLMOption[]
  /** ADR-014 A12: the evaluation state of each model, keyed by statusKey(provider, model). */
  statuses?: Record<string, ModelStatus>
  value: string
  autoId: string | null
  loading: boolean
  disabled: boolean
  onChange: (value: string) => void
  onConfigure: () => void
}

export function ModelPicker({ options, value, autoId, loading, disabled, onChange, onConfigure, statuses }: Props) {
  const active = usePageActive()
  const popover = usePopover({ id: 'assessment-model-picker', width: 360, maxHeight: 480, focusOnOpen: 'button[aria-pressed="true"]' })
  // A pop-over left open on a page that is now hidden would float over the visible one.
  useLayoutEffect(() => { if (!active) popover.hide() }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = options.find(option => option.id === value)
  const automatic = options.find(option => option.id === autoId)
  const title = loading ? 'Loading models…' : value === 'auto' ? 'Auto' : selected?.model || selected?.label || 'Choose model'

  const { close } = popover
  const choose = (id: string) => { onChange(id); close() }

  return <div className="model-picker">
    <button {...popover.triggerProps} className="model-picker-trigger" type="button" aria-label={`Chat model: ${title}`} disabled={loading || disabled}>
      <span className="model-picker-brand">Model</span><span className="model-picker-current">{title}</span><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    <Popover handle={popover} className="model-picker-panel" role="dialog" aria-label="Choose assessment model">
      <p className="model-picker-heading">Chat model</p>
      <button className="model-picker-option" type="button" aria-pressed={value === 'auto'} disabled={disabled || !automatic} onClick={() => choose('auto')}>
        <span className="model-picker-symbol" aria-hidden="true">✦</span><span><strong>Auto <em>Default</em></strong><small>{automatic ? `Uses the project ${automatic.provider === 'groq' ? 'Groq' : automatic.label} model` : 'Project model is unavailable'}</small>{automatic?.model && <small className="model-picker-id">{automatic.model}</small>}</span><span className="model-picker-check" aria-hidden="true">{value === 'auto' ? '✓' : ''}</span>
      </button>
      {(['personal', 'server'] as const).map(source => {
        const items = options.filter(option => option.source === source)
        return items.length > 0 && <div className="model-picker-group" key={source}><p>{source === 'personal' ? 'Your models' : 'Project models'}</p>{items.map(option => <button type="button" className="model-picker-option" key={option.id} aria-pressed={value === option.id} disabled={disabled} onClick={() => choose(option.id)}>
          <span className="model-picker-symbol" aria-hidden="true">{option.provider === 'demo' ? 'D' : option.provider === 'openrouter' ? 'R' : option.provider === 'lmstudio' ? 'S' : option.provider.slice(0, 1).toUpperCase()}</span><span><strong>{option.model || option.label} {option.model && <StatusBadge status={statuses?.[statusKey(option.provider, option.model)]} />}</strong><small>{option.provider === 'demo' ? 'Local demonstration · illustrative results' : `${option.label} · ${option.external ? 'Cloud' : 'Local'}`}</small></span><span className="model-picker-check" aria-hidden="true">{value === option.id ? '✓' : ''}</span>
        </button>)}</div>
      })}
      <div className="model-picker-footer"><button type="button" disabled={disabled} onClick={() => { close(); onConfigure() }}>Manage models <span aria-hidden="true">↗</span></button><p>Add your own providers in LLM config.</p></div>
    </Popover>
  </div>
}
