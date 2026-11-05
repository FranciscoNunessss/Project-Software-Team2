// Semester calendar helpers. All dates are calendar days in UTC (YYYY-MM-DD),
// so results do not change with the runner's time zone.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function parseDate(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Invalid date "${iso}" (expected YYYY-MM-DD)`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First instant of semester week n (week 1 starts on start_date). */
export function weekStart(week: number, startDate: string): number {
  return parseDate(startDate) + (week - 1) * WEEK_MS;
}

/** First instant after semester week n ends (exclusive end). */
export function weekEnd(week: number, startDate: string): number {
  return parseDate(startDate) + week * WEEK_MS;
}

/** Semester week that contains the instant; 0 or negative before the semester starts. */
export function weekOf(instant: number | string, startDate: string): number {
  const t = typeof instant === 'string' ? parseDate(instant) : instant;
  return Math.floor((t - parseDate(startDate)) / WEEK_MS) + 1;
}

/** Current week clamped to [1, weeks] for display. */
export function displayWeek(instant: number | string, startDate: string, weeks: number): number {
  return Math.min(Math.max(weekOf(instant, startDate), 1), weeks);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseDate(toIso) - parseDate(fromIso)) / DAY_MS);
}
