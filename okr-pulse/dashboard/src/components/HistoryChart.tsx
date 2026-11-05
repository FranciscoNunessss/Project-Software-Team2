import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDate } from '../../../shared/i18n';
import type { HistoryPoint, Snapshot } from '../../../shared/types';
import { useCssVars, usePrefs } from '../prefs';
import { Card } from './ui';

// At most three series at once (objectives have ≤ 3 KRs; there are 3 objectives):
// categorical slots 1–3 validate all-pairs in light and dark mode.
const SERIES_VARS = ['--series-1', '--series-2', '--series-3'];

export function HistoryChart({ snapshot, history }: { snapshot: Snapshot; history: HistoryPoint[] }) {
  const { t, lang } = usePrefs();
  const [view, setView] = useState<string>('all');
  const [s1, s2, s3, ink3, line, surface] = useCssVars([...SERIES_VARS, '--ink-3', '--border', '--surface']);
  const colors = [s1, s2, s3];

  const series = useMemo(() => {
    if (view === 'all') return snapshot.objectives.map((o) => ({ key: o.id, name: o.id, pick: (p: HistoryPoint) => p.objectives[o.id] }));
    const o = snapshot.objectives.find((x) => x.id === view);
    return (o?.keyResultIds ?? []).map((id) => ({ key: id, name: id, pick: (p: HistoryPoint) => p.kr[id] }));
  }, [view, snapshot]);

  const rows = useMemo(
    () => history.map((p) => ({ date: p.date, ...Object.fromEntries(series.map((s) => [s.key, s.pick(p) ?? null])) })),
    [history, series],
  );

  const selector = (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      {t.historyShow}
      <select
        className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
        value={view}
        onChange={(e) => setView(e.target.value)}
      >
        <option value="all">{t.allObjectives}</option>
        {snapshot.objectives.map((o) => (
          <option key={o.id} value={o.id}>
            {o.id} — {t.keyResults}
          </option>
        ))}
      </select>
    </label>
  );

  if (history.length < 2) {
    return (
      <Card title={t.history} action={selector}>
        <p className="text-sm text-ink-3">{t.historyEmpty}</p>
      </Card>
    );
  }

  const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(lang, { day: 'numeric', month: 'short' });

  return (
    <Card title={t.history} action={selector}>
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={line} strokeDasharray="0" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: ink3, fontSize: 11 }} stroke={line} minTickGap={24} tickLine={false} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: ink3, fontSize: 11 }} stroke={line} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ stroke: ink3, strokeWidth: 1 }}
              contentStyle={{ background: surface, border: `1px solid ${line}`, borderRadius: 10, fontSize: 12 }}
              labelFormatter={(d) => fmtDate(String(d), lang)}
              formatter={(v) => (v === null || v === undefined ? '—' : `${v}%`)}
            />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={colors[i]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: surface, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-ink-3">{t.historyTable}</summary>
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="w-full text-left">
            <thead className="text-ink-3">
              <tr>
                <th className="py-1 pr-2 font-medium">{t.date}</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 pr-2 text-right font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {[...rows].reverse().map((r) => (
                <tr key={r.date} className="border-t border-line">
                  <td className="py-1 pr-2">{r.date}</td>
                  {series.map((s) => {
                    const v = (r as Record<string, unknown>)[s.key] as number | null;
                    return (
                      <td key={s.key} className="py-1 pr-2 text-right">
                        {v === null ? '—' : `${v}%`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
