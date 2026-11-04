import { useState } from 'react';
import { fmtDate } from '../../../shared/i18n';
import type { Evidence, KRResult, KRStatus, ObjectiveResult } from '../../../shared/types';
import { usePrefs } from '../prefs';
import { Card, fmtValue, pct, ProgressBar, StatusBadge } from './ui';

const ORDER: KRStatus[] = ['behind', 'at-risk', 'on-track', 'done', 'no-data'];

export function StatusSummary({ krs }: { krs: KRResult[] }) {
  const { t } = usePrefs();
  return (
    <div className="flex flex-wrap gap-2" aria-label={t.summaryCounts}>
      {ORDER.map((s) => {
        const n = krs.filter((k) => k.status === s).length;
        return (
          <div key={s} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <span className="tabular text-xl font-semibold">{n}</span>
            <StatusBadge status={s} />
          </div>
        );
      })}
    </div>
  );
}

export function ObjectiveCard({ objective, krs }: { objective: ObjectiveResult; krs: KRResult[] }) {
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono font-semibold text-ink-2">{objective.id}</span>
            {objective.supports?.map((s) => (
              <span key={s} className="font-mono">
                {s}
              </span>
            ))}
          </div>
          <h3 className="text-base leading-snug font-semibold sm:text-lg">{objective.title}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-2xl font-semibold">{pct(objective.progress)}</span>
          <StatusBadge status={objective.status} />
        </div>
      </div>
      <ul className="divide-y divide-line">
        {krs.map((kr) => (
          <KRRow key={kr.id} kr={kr} />
        ))}
      </ul>
    </Card>
  );
}

function KRRow({ kr }: { kr: KRResult }) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  const detailId = `kr-${kr.id.replace(/\W/g, '-')}`;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs font-semibold text-ink-2">{kr.id}</span>
            {kr.proposed && (
              <span className="rounded border border-line px-1 text-[10px] font-semibold tracking-wide text-ink-3" title={t.proposedHint}>
                {t.proposed}
              </span>
            )}
            {kr.owner && <span className="text-xs text-ink-3">· {kr.owner}</span>}
          </div>
          <p className="mt-0.5 text-sm leading-snug">{kr.title}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:pt-4">
          <StatusBadge status={kr.status} />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
        <ProgressBar progress={kr.progress} expected={kr.expected} status={kr.status} label={`${kr.id} ${t.progress}`} />
        <span className="tabular w-12 text-right text-sm font-semibold">{pct(kr.progress)}</span>
        <div className="flex flex-wrap gap-x-3 text-xs text-ink-3">
          <span>
            {t.current}: <span className="tabular text-ink-2">{fmtValue(kr.current, kr.unit)}</span>
          </span>
          <span>
            {t.target}: <span className="tabular text-ink-2">{fmtValue(kr.target, kr.unit)}</span> ({kr.dueMilestone}, S{kr.dueWeek})
          </span>
          <span>
            {t.expected}: <span className="tabular text-ink-2">{pct(kr.expected)}</span>
          </span>
        </div>
        <button
          type="button"
          className="justify-self-end rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t.hideDetails : t.details}
        </button>
      </div>

      {open && <KRDetail kr={kr} id={detailId} />}
    </li>
  );
}

const KIND_ICON: Record<Evidence['kind'], string> = { issue: '◎', pr: '⇄', file: '▤', ci: '⚙', milestone: '⚑', link: '↗', note: '✎' };

function KRDetail({ kr, id }: { kr: KRResult; id: string }) {
  const { t, lang } = usePrefs();
  return (
    <div id={id} className="mt-3 space-y-3 rounded-xl bg-surface-2 p-3 text-sm">
      {kr.error && (
        <p className="text-ink">
          <span style={{ color: 'var(--st-crit)' }}>▼</span> <strong>{t.error}:</strong> {kr.error}
        </p>
      )}
      {kr.note && (
        <p className="text-ink-2">
          <strong className="text-ink">{t.note}:</strong> {kr.note}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-ink-3">{t.baseline}</dt>
          <dd className="tabular">{fmtValue(kr.baseline, kr.unit)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">{t.checkpoints}</dt>
          <dd className="tabular">{kr.checkpoints.map((c) => `${fmtValue(c.target, kr.unit)} @ ${c.milestone}`).join(' → ')}</dd>
        </div>
        {kr.confidence !== undefined && (
          <div>
            <dt className="text-ink-3">{t.confidence}</dt>
            <dd className="tabular">{Math.round(kr.confidence * 100)}%</dd>
          </div>
        )}
        {kr.updated && (
          <div>
            <dt className="text-ink-3">{t.lastValue}</dt>
            <dd>{fmtDate(kr.updated, lang)}</dd>
          </div>
        )}
      </dl>
      <div>
        <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">{t.evidence}</h4>
        {kr.evidence.length === 0 ? (
          <p className="text-xs text-ink-3">{t.noEvidence}</p>
        ) : (
          <ul className="space-y-1">
            {kr.evidence.map((e, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span aria-hidden className="w-4 shrink-0 text-center text-ink-3">
                  {KIND_ICON[e.kind]}
                </span>
                <span className="min-w-0">
                  {e.url ? (
                    <a className="break-words text-accent hover:underline" href={e.url} target="_blank" rel="noreferrer">
                      {e.title}
                    </a>
                  ) : (
                    <span className="break-words">{e.title}</span>
                  )}
                  {e.meta && <span className="text-ink-3"> · {e.meta}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
