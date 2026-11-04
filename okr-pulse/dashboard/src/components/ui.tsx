import type { ReactNode } from 'react';
import type { KRStatus } from '../../../shared/types';
import { usePrefs } from '../prefs';

export const STATUS_COLOR: Record<KRStatus, string> = {
  done: 'var(--st-done)',
  'on-track': 'var(--st-good)',
  'at-risk': 'var(--st-warn)',
  behind: 'var(--st-crit)',
  'no-data': 'var(--st-none)',
};

const STATUS_ICON: Record<KRStatus, string> = {
  done: '✓',
  'on-track': '●',
  'at-risk': '▲',
  behind: '▼',
  'no-data': '○',
};

export function StatusBadge({ status, compact = false }: { status: KRStatus; compact?: boolean }) {
  const { t } = usePrefs();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink-2"
      title={t.status[status]}
    >
      <span aria-hidden style={{ color: STATUS_COLOR[status] }}>
        {STATUS_ICON[status]}
      </span>
      {compact ? <span className="sr-only">{t.status[status]}</span> : t.status[status]}
    </span>
  );
}

/** Progress bar with a marker at the expected pace. */
export function ProgressBar({ progress, expected, status, label }: { progress: number | null; expected: number; status: KRStatus; label: string }) {
  const { t } = usePrefs();
  const value = progress ?? 0;
  return (
    <div className="relative h-3 w-full" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
      <div className="absolute inset-x-0 top-0.5 h-2 rounded-full bg-track" />
      {progress !== null && value > 0 && (
        <div
          className="absolute top-0.5 left-0 h-2 rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(value, 1.5)}%`, background: STATUS_COLOR[status] }}
        />
      )}
      <div
        className="absolute top-0 h-3 w-0.5 -translate-x-1/2 rounded-full"
        style={{ left: `${expected}%`, background: 'var(--marker)', boxShadow: '0 0 0 2px var(--surface)' }}
        title={`${t.expectedPace}: ${expected}%`}
      />
    </div>
  );
}

export function Card({ title, action, children, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x)}%`);

export function fmtValue(v: number | null, unit?: string): string {
  if (v === null) return '—';
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (!unit) return n;
  return /^[/%]/.test(unit) ? `${n}${unit}` : `${n} ${unit}`;
}
