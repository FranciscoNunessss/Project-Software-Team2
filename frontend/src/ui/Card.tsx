import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from './cx'
import './Card.css'

/** A bordered surface. Renders a <section>; padding is left to the content. */
export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Card({ className, ...rest }, ref) {
  return <section ref={ref} className={cx('card', className)} {...rest} />
})
