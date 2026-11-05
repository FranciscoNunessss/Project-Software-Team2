// Turns validated config + raw measurements into the Snapshot JSON. Pure (no I/O),
// so the mock-data script and the tests build snapshots exactly like the real run.

import { displayWeek, weekOf } from '../shared/calendar';
import { activeCheckpointIndex, expectedPct, progressPct, rollup, statusFor } from '../shared/pace';
import type { DocHealth, HistoryPoint, KRResult, OkrConfig, Snapshot } from '../shared/types';
import { resolveCheckpoints } from './config';
import type { Measurement } from './collectors/types';

export interface MeasurementOrError extends Partial<Measurement> {
  error?: string;
}

export function buildSnapshot(
  config: OkrConfig,
  today: string,
  measurements: Record<string, MeasurementOrError>,
  docs: DocHealth[],
  opts: { generatedAt?: string; mock?: boolean } = {},
): Snapshot {
  const start = config.semester.start_date;
  const th = {
    atRiskGap: config.settings?.at_risk_gap ?? 10,
    behindGap: config.settings?.behind_gap ?? 25,
  };

  const keyResults: KRResult[] = config.key_results.map((kr) => {
    const m = measurements[kr.id] ?? {};
    const checkpoints = resolveCheckpoints(kr, config);
    const direction = kr.direction ?? 'higher';
    const baseline = kr.baseline ?? 0;
    const active = checkpoints[activeCheckpointIndex(today, checkpoints, start)];
    const current = m.current ?? null;
    const progress = progressPct(current, baseline, active.target);
    const expected = expectedPct({
      today,
      startDate: start,
      startWeek: kr.start_week ?? 1,
      checkpoints,
      baseline,
      pace: kr.pace ?? 'linear',
    });
    const configEvidence = (kr.evidence ?? []).map((e) => ({ kind: 'link' as const, title: e.title, url: e.url }));
    return {
      id: kr.id,
      objectiveId: kr.objective_id,
      title: kr.title,
      type: kr.type,
      owner: kr.owner,
      proposed: kr.proposed ?? false,
      unit: kr.unit,
      direction,
      baseline,
      current,
      target: active.target,
      dueMilestone: active.milestone,
      dueWeek: active.week,
      checkpoints,
      progress,
      expected,
      status: m.error ? 'no-data' : statusFor(progress, expected, th),
      confidence: m.confidence,
      note: m.note,
      updated: m.updated,
      error: m.error,
      evidence: [...(m.evidence ?? []), ...configEvidence],
    };
  });

  const objectives = config.objectives.map((o) => {
    const krs = keyResults.filter((k) => k.objectiveId === o.id);
    return {
      id: o.id,
      title: o.title,
      description: o.description,
      supports: o.supports,
      ...rollup(krs),
      keyResultIds: krs.map((k) => k.id),
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    date: today,
    repo: config.repo,
    branch: config.branch ?? 'develop',
    ...(opts.mock ? { mock: true } : {}),
    semester: {
      startDate: start,
      weeks: config.semester.weeks,
      currentWeek: displayWeek(today, start, config.semester.weeks),
      milestones: [...config.semester.milestones].sort((a, b) => a.week - b.week),
    },
    settings: { ...th, docsStaleDays: config.settings?.docs_stale_days ?? 14 },
    objectives,
    keyResults,
    docs,
  };
}

export function toHistoryPoint(s: Snapshot): HistoryPoint {
  return {
    date: s.date,
    week: weekOf(s.date, s.semester.startDate),
    kr: Object.fromEntries(s.keyResults.map((k) => [k.id, k.progress])),
    objectives: Object.fromEntries(s.objectives.map((o) => [o.id, o.progress])),
  };
}

/** Replaces the point for the same date (re-runs on one day) and keeps dates sorted. */
export function mergeHistory(index: HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  return [...index.filter((p) => p.date !== point.date), point].sort((a, b) => a.date.localeCompare(b.date));
}
