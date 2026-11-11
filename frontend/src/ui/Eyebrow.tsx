import type { HTMLAttributes } from 'react'
import { cx } from './cx'
import './Eyebrow.css'

/** The small upper-case label above a title. */
export function Eyebrow({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('eyebrow', className)} {...rest} />
}
