import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'
import './IconButton.css'

/** A square, borderless button for one icon or glyph. Give it an aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function IconButton(
  { className, type = 'button', ...rest }, ref,
) {
  return <button ref={ref} type={type} className={cx('icon-button', className)} {...rest} />
})
