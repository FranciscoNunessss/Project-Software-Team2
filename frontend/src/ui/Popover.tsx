import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type RefObject, type SyntheticEvent } from 'react'
import { cx } from './cx'
import './Popover.css'

type PopoverOptions = {
  /** The panel's id: the trigger points at it. */
  id: string
  /** Panel width in px; never wider than the window minus a 12px margin each side. */
  width: number
  /** The tallest the panel may grow, in px, before it scrolls. */
  maxHeight: number
  /** The least height offered when neither side of the trigger has room. */
  minHeight?: number
  /** Element to focus when the panel opens (a CSS selector inside the panel). */
  focusOnOpen?: string
  /** Values that change the panel's size while it is open: it is placed again when they change. */
  watch?: unknown[]
}

export type PopoverHandle = {
  open: boolean
  /** Spread on the trigger button. */
  triggerProps: { ref: RefObject<HTMLButtonElement | null>; popoverTarget: string; 'aria-expanded': boolean; 'aria-controls': string }
  /** Used by <Popover>. */
  panelProps: { ref: RefObject<HTMLDivElement | null>; id: string; width: number; onToggle: (event: SyntheticEvent<HTMLDivElement>) => void }
  /** Closes the panel without moving focus (for example when its page is hidden). */
  hide: () => void
  /** Closes the panel and returns focus to the trigger. */
  close: () => void
}

/**
 * A pop-over anchored to a trigger button, built on the browser's popover="auto": a click
 * outside or Escape closes it and focus returns to the trigger, with no listeners of our own.
 * This hook adds what the platform does not: the open state for aria-expanded, and placing
 * the panel under the trigger, or above it when there is more room, inside the window.
 */
export function usePopover({ id, width, maxHeight, minHeight = 80, focusOnOpen, watch = [] }: PopoverOptions): PopoverHandle {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      if (!trigger.current || !panel.current) return
      const bounds = trigger.current.getBoundingClientRect()
      const panelWidth = Math.min(width, window.innerWidth - 24)
      const below = window.innerHeight - bounds.bottom - 20
      const above = bounds.top - 20
      const height = Math.min(panel.current.scrollHeight + 2, maxHeight)
      const opensAbove = below < height && above > below
    const available = Math.min(maxHeight, Math.max(minHeight, opensAbove ? above : below))
      panel.current.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - panelWidth - 12))}px`
      panel.current.style.top = `${opensAbove ? Math.max(12, bounds.top - Math.min(height, available) - 8) : bounds.bottom + 8}px`
      panel.current.style.maxHeight = `${available}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, width, maxHeight, minHeight, ...watch]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (open && focusOnOpen) panel.current?.querySelector<HTMLElement>(focusOnOpen)?.focus()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const hide = useCallback(() => { panel.current?.hidePopover() }, [])
  const close = useCallback(() => { panel.current?.hidePopover(); trigger.current?.focus() }, [])
  const onToggle = useCallback((event: SyntheticEvent<HTMLDivElement>) => setOpen(event.currentTarget.matches(':popover-open')), [])

  return {
    open, hide, close,
    triggerProps: { ref: trigger, popoverTarget: id, 'aria-expanded': open, 'aria-controls': id },
    panelProps: { ref: panel, id, width, onToggle },
  }
}

/** The floating panel of a pop-over. Pair it with usePopover(). */
export function Popover({ handle, className, style, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'popover'> & { handle: PopoverHandle }) {
  const { ref, id, width, onToggle } = handle.panelProps
  return <div ref={ref} id={id} popover="auto" onToggle={onToggle} className={cx('popover', className)}
    style={{ '--popover-width': `${width}px`, ...style } as CSSProperties} {...rest} />
}
