import { useEffect, useLayoutEffect, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { cx } from './cx'
import { IconButton } from './IconButton'
import './Sheet.css'

type SheetProps = {
  open: boolean
  onClose: () => void
  /** Accessible name of the panel. */
  label: string
  id?: string
  /** Title area, to the left of the close button. */
  heading: ReactNode
  /** Accessible name of the close button. */
  closeLabel?: string
  /** Fixed strip under the scrolling body, for the panel's own action. */
  footer?: ReactNode
  /** Extra attributes for the panel itself (data-* hooks, for example). */
  panelProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>
  className?: string
  children: ReactNode
}

/**
 * A side panel with two modes, chosen by the window width:
 * - above 1100px it floats over the right edge of the page, from the top of the window to
 *   the bottom (see useSheetRoom for keeping something beside it usable);
 * - at 1100px and below it is a nearly full-height bottom sheet with a backdrop.
 * Closes with its × button, the backdrop or Escape.
 */
export function Sheet({ open, onClose, label, id, heading, closeLabel = 'Close', footer, panelProps, className, children }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <aside className={cx('sheet', open && 'open', className)} aria-label={label} id={id}>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet-panel" aria-hidden={!open} {...panelProps}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="sheet-head">
          <div>{heading}</div>
          <IconButton className="sheet-close" aria-label={closeLabel} onClick={onClose}>×</IconButton>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </aside>
  )
}

// Where the floating sheet sits; keep in step with .sheet in Sheet.css.
const EDGE = 16
const WIDTH = 400
const GAP = 16
const BOTTOM_SHEET = '(max-width: 1100px)'

/**
 * How much horizontal room, in px, an element has before the floating sheet: the distance
 * from the left edge of `container` to just left of the open sheet (with a 16px gap), or
 * null while the sheet is closed or shown as a bottom sheet. Use it to narrow something
 * the sheet would otherwise cover. Measured when the sheet opens and on every resize.
 */
export function useSheetRoom(container: RefObject<HTMLElement | null>, open: boolean) {
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const element = container.current
      if (!open || !element || window.matchMedia(BOTTOM_SHEET).matches) { setRoom(null); return }
      const sheetLeft = window.innerWidth - EDGE - Math.min(WIDTH, window.innerWidth - 2 * EDGE)
      setRoom(Math.max(0, Math.round(sheetLeft - GAP - element.getBoundingClientRect().left)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (container.current) observer.observe(container.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [open, container])
  return room
}
