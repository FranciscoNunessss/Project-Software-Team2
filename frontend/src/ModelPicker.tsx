import { useLayoutEffect, useRef, useState } from 'react'
import type { LLMOption } from './api'

type Props = {
  options: LLMOption[]
  value: string
  autoId: string | null
  loading: boolean
  disabled: boolean
  onChange: (value: string) => void
  onConfigure: () => void
}

export function ModelPicker({ options, value, autoId, loading, disabled, onChange, onConfigure }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.id === value)
  const automatic = options.find(option => option.id === autoId)
  const title = loading ? 'Loading models…' : value === 'auto' ? 'Auto' : selected?.model || selected?.label || 'Choose model'

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      if (!trigger.current || !panel.current) return
      const bounds = trigger.current.getBoundingClientRect()
      const width = Math.min(360, window.innerWidth - 24)
      const below = window.innerHeight - bounds.bottom - 20
      const above = bounds.top - 20
      const height = Math.min(panel.current.scrollHeight + 2, 480)
      const opensAbove = below < height && above > below
      const available = Math.max(80, opensAbove ? above : below)
      panel.current.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`
      panel.current.style.top = `${opensAbove ? Math.max(12, bounds.top - Math.min(height, available) - 8) : bounds.bottom + 8}px`
      panel.current.style.maxHeight = `${available}px`
    }
    position()
    panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  const close = () => {
    panel.current?.hidePopover()
    trigger.current?.focus()
  }
  const choose = (id: string) => { onChange(id); close() }

  return <div className="model-picker">
    <button ref={trigger} className="model-picker-trigger" type="button" popoverTarget="assessment-model-picker" aria-label={`Assessment model: ${title}`} aria-expanded={open} aria-controls="assessment-model-picker" disabled={loading || disabled}>
      <span className="model-picker-brand">Model</span><span className="model-picker-current">{title}</span><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    <div ref={panel} id="assessment-model-picker" className="model-picker-panel" popover="auto" role="dialog" aria-label="Choose assessment model" onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
      <p className="model-picker-heading">Assessment model</p>
      <button className="model-picker-option" type="button" aria-pressed={value === 'auto'} disabled={disabled || !automatic} onClick={() => choose('auto')}>
        <span className="model-picker-symbol" aria-hidden="true">✦</span><span><strong>Auto <em>Default</em></strong><small>{automatic ? `Uses the project ${automatic.provider === 'groq' ? 'Groq' : automatic.label} model` : 'Project model is unavailable'}</small>{automatic?.model && <small className="model-picker-id">{automatic.model}</small>}</span><span className="model-picker-check" aria-hidden="true">{value === 'auto' ? '✓' : ''}</span>
      </button>
      {(['personal', 'server'] as const).map(source => {
        const items = options.filter(option => option.source === source)
        return items.length > 0 && <div className="model-picker-group" key={source}><p>{source === 'personal' ? 'Your models' : 'Project models'}</p>{items.map(option => <button type="button" className="model-picker-option" key={option.id} aria-pressed={value === option.id} disabled={disabled} onClick={() => choose(option.id)}>
          <span className="model-picker-symbol" aria-hidden="true">{option.provider === 'demo' ? 'D' : option.provider.slice(0, 1).toUpperCase()}</span><span><strong>{option.model || option.label}</strong><small>{option.provider === 'demo' ? 'Local demonstration · illustrative results' : `${option.label} · ${option.external ? 'Cloud' : 'Local'}`}</small></span><span className="model-picker-check" aria-hidden="true">{value === option.id ? '✓' : ''}</span>
        </button>)}</div>
      })}
      <div className="model-picker-footer"><button type="button" disabled={disabled} onClick={() => { close(); onConfigure() }}>Manage models <span aria-hidden="true">↗</span></button><p>Add your own providers in LLM config.</p></div>
    </div>
  </div>
}
