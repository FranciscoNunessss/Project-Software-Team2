// Weekly Markdown summary: progress deltas vs ~7 days ago and the KRs that need attention.
//
//   npx tsx collector/weekly-summary.ts --data <dir with latest.json> [--out summary.md]
//                                       [--lang pt-PT|en] [--dashboard-url URL]

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { daysBetween } from '../shared/calendar';
import { STRINGS, type Lang } from '../shared/i18n';
import type { HistoryPoint, KRStatus, Snapshot } from '../shared/types';
import { readJson } from './io';

const ICON: Record<KRStatus, string> = { done: '✅', 'on-track': '🟢', 'at-risk': '🟠', behind: '🔴', 'no-data': '⚪' };

/** Latest history point at least 7 days before `date` (or the oldest available). */
export function previousPoint(history: HistoryPoint[], date: string): HistoryPoint | undefined {
  const older = history.filter((p) => daysBetween(p.date, date) >= 7);
  if (older.length) return older[older.length - 1];
  const before = history.filter((p) => p.date < date);
  return before[0];
}

const fmt = (x: number | null) => (x === null ? '—' : `${x}%`);
function fmtDelta(now: number | null, before: number | null | undefined): string {
  if (now === null || before === null || before === undefined) return '';
  const d = Math.round((now - before) * 10) / 10;
  return d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`;
}

export function renderWeeklySummary(s: Snapshot, history: HistoryPoint[], lang: Lang = 'pt-PT', dashboardUrl?: string): string {
  const t = STRINGS[lang];
  const prev = previousPoint(history, s.date);
  const lines: string[] = [];
  lines.push(`## ${t.weeklyTitle(s.semester.currentWeek)}`, '');
  lines.push(prev ? t.weeklyComparedWith(prev.date) : t.weeklyNoPrevious);
  if (dashboardUrl) lines.push(`[${t.weeklyDashboard}](${dashboardUrl})`);
  lines.push('');

  const attention = s.keyResults.filter((k) => k.status === 'behind' || k.status === 'at-risk');
  lines.push(`### ${t.weeklyNeedsAttention}`, '');
  if (attention.length === 0) lines.push(t.weeklyNone);
  for (const k of attention) {
    lines.push(`- ${ICON[k.status]} **${k.id}** ${k.title} — ${fmt(k.progress)} (${t.expected.toLowerCase()} ${k.expected}%, ${t.due.toLowerCase()}: ${k.dueMilestone})`);
  }
  const noData = s.keyResults.filter((k) => k.status === 'no-data').map((k) => k.id);
  if (noData.length) lines.push('', `${ICON['no-data']} ${t.weeklyNoData}: ${noData.join(', ')}`);
  lines.push('');

  lines.push(`### ${t.weeklyAll}`, '');
  lines.push(`| KR | ${t.progress} | ${t.delta} | ${t.expected} | ${t.statusLabel} | ${t.owner} |`);
  lines.push('|---|---:|---:|---:|---|---|');
  for (const k of s.keyResults) {
    const proposed = k.proposed ? ` _${t.proposed}_` : '';
    lines.push(
      `| ${k.id}${proposed} | ${fmt(k.progress)} | ${fmtDelta(k.progress, prev?.kr[k.id])} | ${k.expected}% | ${ICON[k.status]} ${t.status[k.status]} | ${k.owner ?? ''} |`,
    );
  }
  lines.push('', `<sub>OKR Pulse · ${s.repo}@${s.branch} · ${s.generatedAt}</sub>`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      data: { type: 'string', default: 'out/data' },
      out: { type: 'string' },
      lang: { type: 'string', default: 'pt-PT' },
      'dashboard-url': { type: 'string' },
    },
  });
  const snapshot = readJson<Snapshot>(join(values.data!, 'latest.json'));
  let history: HistoryPoint[] = [];
  try {
    history = readJson<HistoryPoint[]>(join(values.data!, 'history', 'index.json'));
  } catch {
    /* first run */
  }
  const md = renderWeeklySummary(snapshot, history, values.lang as Lang, values['dashboard-url']);
  if (values.out) writeFileSync(values.out, md);
  else process.stdout.write(md);
}
