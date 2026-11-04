import { daysBetween } from '../../../shared/calendar';
import { fmtDate } from '../../../shared/i18n';
import type { DocHealth, KRStatus } from '../../../shared/types';
import { usePrefs } from '../prefs';
import { Card, pct, STATUS_COLOR } from './ui';

export function DocsHealthPanel({ docs, today, staleDays }: { docs: DocHealth[]; today: string; staleDays: number }) {
  const { t, lang } = usePrefs();
  if (docs.length === 0) return null;
  return (
    <Card title={t.docsHealth} action={<span className="text-xs text-ink-3">{t.staleHint(staleDays)}</span>}>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <thead>
            <tr className="text-xs text-ink-3">
              <th className="px-1 pb-2 font-medium">{t.document}</th>
              <th className="px-1 pb-2 font-medium">{t.completion}</th>
              <th className="px-1 pb-2 font-medium">{t.lastModified}</th>
              <th className="px-1 pb-2 font-medium">{t.statusLabel}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {docs.map((d) => {
              const state: { s: KRStatus; label: string; icon: string } = !d.exists
                ? { s: 'behind', label: t.missing, icon: '▼' }
                : d.stale
                  ? { s: 'at-risk', label: t.stale, icon: '▲' }
                  : { s: 'on-track', label: t.fresh, icon: '●' };
              const age = d.lastModified ? daysBetween(d.lastModified.slice(0, 10), today) : null;
              return (
                <tr key={d.path}>
                  <td className="px-1 py-2 font-mono text-xs">
                    {d.exists ? (
                      <a className="text-accent hover:underline" href={d.url} target="_blank" rel="noreferrer">
                        {d.path}
                      </a>
                    ) : (
                      <span className="text-ink-2">{d.path}</span>
                    )}
                  </td>
                  <td className="px-1 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-track">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${d.completion ?? 0}%` }} />
                      </div>
                      <span className="tabular text-xs text-ink-2">
                        {pct(d.completion)}
                        {d.checkboxes.total > 0 && ` (${d.checkboxes.checked}/${d.checkboxes.total})`}
                      </span>
                    </div>
                  </td>
                  <td className="px-1 py-2 text-xs text-ink-2">
                    {d.lastModified ? (
                      <>
                        {fmtDate(d.lastModified, lang)} <span className="tabular text-ink-3">({age} d)</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-1 py-2 text-xs whitespace-nowrap">
                    <span aria-hidden style={{ color: STATUS_COLOR[state.s] }}>
                      {state.icon}
                    </span>{' '}
                    {state.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
