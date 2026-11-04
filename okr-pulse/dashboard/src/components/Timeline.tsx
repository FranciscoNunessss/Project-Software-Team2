import { toISODate, weekStart } from '../../../shared/calendar';
import { fmtDate } from '../../../shared/i18n';
import type { Snapshot } from '../../../shared/types';
import { usePrefs } from '../prefs';
import { Card } from './ui';

export function MilestoneTimeline({ semester }: { semester: Snapshot['semester'] }) {
  const { t, lang } = usePrefs();
  const { weeks, currentWeek, milestones, startDate } = semester;
  const byWeek = new Map<number, string[]>();
  for (const m of milestones) byWeek.set(m.week, [...(byWeek.get(m.week) ?? []), m.name]);

  return (
    <Card title={t.timeline} action={<span className="text-sm text-ink-2">{t.weekOf(currentWeek, weeks)}</span>}>
      <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }} aria-label={t.timeline}>
        {Array.from({ length: weeks }, (_, i) => i + 1).map((w) => {
          const isNow = w === currentWeek;
          const past = w < currentWeek;
          const ms = byWeek.get(w);
          return (
            <li
              key={w}
              className={`relative flex h-12 flex-col items-center justify-center rounded-lg text-xs sm:h-14 ${
                isNow ? 'bg-accent font-semibold text-white' : past ? 'bg-surface-2 text-ink-2' : 'border border-line text-ink-3'
              }`}
              title={`${t.week} ${w} · ${fmtDate(toISODate(weekStart(w, startDate)), lang)}${ms ? ` · ${ms.join(', ')}` : ''}`}
              aria-current={isNow ? 'step' : undefined}
            >
              <span className="tabular">{w}</span>
              {ms && (
                <span aria-hidden className={`mt-0.5 text-[10px] leading-none ${isNow ? 'text-white' : 'text-accent'}`}>
                  ⚑
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <ul className="mt-4 flex flex-wrap gap-2 text-xs">
        {milestones.map((m) => {
          const state = m.week < currentWeek ? 'past' : m.week === currentWeek ? 'now' : 'future';
          return (
            <li
              key={m.name}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                state === 'now' ? 'border-accent text-ink' : state === 'past' ? 'border-line text-ink-3' : 'border-line text-ink-2'
              }`}
            >
              <span className="tabular font-mono font-semibold">S{m.week}</span>
              <span className={state === 'past' ? 'line-through decoration-ink-3/50' : ''}>{m.name}</span>
              {state === 'now' && <span className="font-semibold text-accent">· {t.today}</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
