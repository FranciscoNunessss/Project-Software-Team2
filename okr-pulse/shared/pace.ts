// Progress, expected pace and status. Pure functions, covered by test/pace.test.ts.

import { parseDate, weekEnd, weekStart } from './calendar';
import type { CheckpointResult, KRStatus, Pace } from './types';

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Progress from baseline to target, 0–100.
 * Works for both directions: with baseline 100 and target 50 ("lower is better"),
 * a current value of 75 is 50% of the way.
 */
export function progressPct(current: number | null, baseline: number, target: number): number | null {
  if (current === null || Number.isNaN(current)) return null;
  if (target === baseline) return 100;
  return round1(clamp(((current - baseline) / (target - baseline)) * 100, 0, 100));
}

/**
 * Index of the checkpoint being worked towards on `today`:
 * the first one whose week has not ended yet, or the last one after the final week.
 */
export function activeCheckpointIndex(today: string, checkpoints: CheckpointResult[], startDate: string): number {
  const t = parseDate(today);
  const i = checkpoints.findIndex((cp) => t < weekEnd(cp.week, startDate));
  return i === -1 ? checkpoints.length - 1 : i;
}

export interface ExpectedInput {
  today: string;
  startDate: string;
  /** Week in which work on the KR starts; the pace line begins at the start of this week. */
  startWeek: number;
  checkpoints: CheckpointResult[];
  baseline: number;
  pace: Pace;
}

/**
 * Where progress should be today, 0–100 of the active checkpoint's target.
 *
 * linear:   the expected value moves in a straight line from the previous checkpoint's
 *           target (or the baseline) at the start of the window to the active target at
 *           the end of the active checkpoint's week.
 * constant: the target applies in full from start_week on (e.g. "100% every week").
 */
export function expectedPct(input: ExpectedInput): number {
  const { today, startDate, startWeek, checkpoints, baseline, pace } = input;
  const t = parseDate(today);
  const startMs = weekStart(startWeek, startDate);
  if (pace === 'constant') return t >= startMs ? 100 : 0;

  const i = activeCheckpointIndex(today, checkpoints, startDate);
  const next = checkpoints[i];
  const prevTarget = i > 0 ? checkpoints[i - 1].target : baseline;
  const windowStart = i > 0 ? Math.max(weekEnd(checkpoints[i - 1].week, startDate), startMs) : startMs;
  const windowEnd = weekEnd(next.week, startDate);
  const frac = windowEnd > windowStart ? clamp((t - windowStart) / (windowEnd - windowStart), 0, 1) : 1;
  const expectedValue = prevTarget + (next.target - prevTarget) * frac;
  return progressPct(expectedValue, baseline, next.target) ?? 0;
}

export interface Thresholds {
  atRiskGap: number;
  behindGap: number;
}

/** Status from the gap between expected and actual progress, in percentage points. */
export function statusFor(progress: number | null, expected: number, th: Thresholds): KRStatus {
  if (progress === null) return 'no-data';
  if (progress >= 100) return 'done';
  const gap = expected - progress;
  if (gap > th.behindGap) return 'behind';
  if (gap > th.atRiskGap) return 'at-risk';
  return 'on-track';
}

const SEVERITY: Record<KRStatus, number> = { 'no-data': -1, done: 0, 'on-track': 1, 'at-risk': 2, behind: 3 };

/** Objective roll-up: mean progress of measured KRs; worst status among measured KRs. */
export function rollup(krs: { progress: number | null; status: KRStatus }[]): { progress: number | null; status: KRStatus } {
  const measured = krs.filter((k) => k.progress !== null);
  if (measured.length === 0) return { progress: null, status: 'no-data' };
  const progress = round1(measured.reduce((s, k) => s + (k.progress as number), 0) / measured.length);
  const status = measured.reduce<KRStatus>((worst, k) => (SEVERITY[k.status] > SEVERITY[worst] ? k.status : worst), 'done');
  return { progress, status };
}
