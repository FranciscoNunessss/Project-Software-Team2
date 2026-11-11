import { useEffect, type HTMLAttributes, type ReactNode } from 'react'
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
 *   the bottom, on top of whatever is there;
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
