import { describe, expect, it } from 'vitest';
import { weekEnd, weekOf, weekStart, toISODate, daysBetween } from '../shared/calendar';
import { activeCheckpointIndex, expectedPct, progressPct, rollup, statusFor } from '../shared/pace';

const START = '2026-09-14'; // Monday of week 1
const th = { atRiskGap: 10, behindGap: 25 };

describe('calendar', () => {
  it('maps dates to semester weeks', () => {
    expect(weekOf('2026-09-14', START)).toBe(1);
    expect(weekOf('2026-09-20', START)).toBe(1); // Sunday still week 1
    expect(weekOf('2026-09-21', START)).toBe(2);
    expect(weekOf('2026-11-04', START)).toBe(8); // charter: "4 November 2026, in week 8"
    expect(weekOf('2026-09-13', START)).toBe(0);
  });
  it('gives week boundaries', () => {
    expect(toISODate(weekStart(11, START))).toBe('2026-11-23');
    expect(toISODate(weekEnd(11, START))).toBe('2026-11-30');
    expect(daysBetween('2026-10-21', '2026-11-04')).toBe(14);
  });
});

describe('progressPct', () => {
  it('is null without a measured value', () => {
    expect(progressPct(null, 0, 16)).toBeNull();
  });
  it('measures towards a higher target', () => {
    expect(progressPct(8, 0, 16)).toBe(50);
    expect(progressPct(20, 0, 16)).toBe(100); // clamped
    expect(progressPct(-1, 0, 16)).toBe(0);
  });
  it('measures towards a lower target from a baseline', () => {
    // KR1.2: from 100% of top-tier cost down to 50%
    expect(progressPct(75, 100, 50)).toBe(50);
    expect(progressPct(50, 100, 50)).toBe(100);
    expect(progressPct(120, 100, 50)).toBe(0);
  });
});

describe('expectedPct (linear pace)', () => {
  const single = [{ milestone: 'MVP', week: 11, target: 16 }];
  const base = { startDate: START, startWeek: 7, checkpoints: single, baseline: 0, pace: 'linear' as const };

  it('is 0 before work starts and at the start of start_week', () => {
    expect(expectedPct({ ...base, today: '2026-10-01' })).toBe(0);
    expect(expectedPct({ ...base, today: '2026-10-26' })).toBe(0); // Monday of week 7
  });
  it('rises linearly to 100 at the end of the due week', () => {
    // window: start of week 7 (26 Oct) to end of week 11 (30 Nov) = 35 days
    expect(expectedPct({ ...base, today: '2026-11-12' })).toBeCloseTo(48.6, 1); // 17/35
    expect(expectedPct({ ...base, today: '2026-11-30' })).toBe(100);
    expect(expectedPct({ ...base, today: '2026-12-20' })).toBe(100);
  });
  it('carries on from the previous checkpoint target', () => {
    // KR2.1: 1 pattern at MVP (wk 11), 3 at Final (wk 15)
    const cps = [
      { milestone: 'MVP', week: 11, target: 1 },
      { milestone: 'Final Delivery', week: 15, target: 3 },
    ];
    expect(activeCheckpointIndex('2026-11-29', cps, START)).toBe(0);
    expect(activeCheckpointIndex('2026-11-30', cps, START)).toBe(1);
    // right after MVP the expected value is still 1 of 3
    expect(expectedPct({ ...base, checkpoints: cps, today: '2026-11-30' })).toBeCloseTo(33.3, 1);
    // halfway through weeks 12–15 the expected value is 2 of 3
    expect(expectedPct({ ...base, checkpoints: cps, today: '2026-12-14' })).toBeCloseTo(66.7, 1);
  });
  it('works for a lower-is-better KR', () => {
    const cps = [{ milestone: 'MVP', week: 11, target: 50 }];
    expect(expectedPct({ ...base, baseline: 100, checkpoints: cps, today: '2026-11-30' })).toBe(100);
  });
});

describe('expectedPct (constant pace)', () => {
  const cps = [{ milestone: 'Final Delivery', week: 15, target: 100 }];
  it('expects the full target from start_week on', () => {
    const input = { startDate: START, startWeek: 7, checkpoints: cps, baseline: 0, pace: 'constant' as const };
    expect(expectedPct({ ...input, today: '2026-10-25' })).toBe(0);
    expect(expectedPct({ ...input, today: '2026-10-26' })).toBe(100);
  });
});

describe('statusFor', () => {
  it('uses the gap between expected and actual progress', () => {
    expect(statusFor(null, 50, th)).toBe('no-data');
    expect(statusFor(100, 50, th)).toBe('done');
    expect(statusFor(45, 50, th)).toBe('on-track');
    expect(statusFor(40, 50, th)).toBe('on-track'); // gap 10 is not > 10
    expect(statusFor(39, 50, th)).toBe('at-risk');
    expect(statusFor(25, 50, th)).toBe('at-risk'); // gap 25 is not > 25
    expect(statusFor(24, 50, th)).toBe('behind');
    expect(statusFor(60, 50, th)).toBe('on-track');
  });
});

describe('rollup', () => {
  it('averages measured KRs and takes the worst status', () => {
    expect(
      rollup([
        { progress: 80, status: 'on-track' },
        { progress: 20, status: 'behind' },
        { progress: null, status: 'no-data' },
      ]),
    ).toEqual({ progress: 50, status: 'behind' });
  });
  it('is no-data when nothing is measured', () => {
    expect(rollup([{ progress: null, status: 'no-data' }])).toEqual({ progress: null, status: 'no-data' });
  });
});
