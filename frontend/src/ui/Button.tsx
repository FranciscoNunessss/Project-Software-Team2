import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'
import './Button.css'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

/** A text button. Every native button prop (including data-* and aria-*) is passed through. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref,
) {
  return <button ref={ref} type={type} className={cx('button', `button-${variant}`, size === 'sm' && 'button-sm', className)} {...rest} />
})
