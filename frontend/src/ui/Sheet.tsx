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
 * - above 1100px it floats over the right edge of the page and stops `--composer-space`
 *   above the bottom of the window, so whatever sits there stays usable;
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

/**
 * How much room, in px, the floating sheet must leave free at the bottom of the window:
 * the distance from the top of `anchor` (or of a sibling matching `above`, if that is
 * higher) to the bottom of the window. Put the result in `--composer-space` on an ancestor
 * of the sheet. Measured after every render, and when the anchor or the window resizes.
 */
export function useSheetClearance(anchor: RefObject<HTMLElement | null>, { active = true, above }: { active?: boolean; above?: string } = {}) {
  const [space, setSpace] = useState(0)
  const measure = () => {
    if (!active) return
    const element = anchor.current
    if (!element) return
    const sibling = above ? element.parentElement?.querySelector<HTMLElement>(`:scope > ${above}`) : null
    const top = Math.min(element.getBoundingClientRect().top, sibling?.getBoundingClientRect().top ?? Infinity)
    setSpace(Math.max(0, Math.round(window.innerHeight - top)))
  }
  // After every render: content under the anchor can move it without resizing it.
  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const element = anchor.current
    if (!element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return space
}
