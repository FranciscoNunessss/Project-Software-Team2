import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../collector/config';
import { buildSnapshot, mergeHistory, toHistoryPoint } from '../collector/snapshot';

const BASE = `
version: 1
repo: team/repo
semester:
  start_date: 2026-09-14
  weeks: 15
  milestones:
    - { name: MVP, week: 11 }
    - { name: Final Delivery, week: 15 }
objectives:
  - { id: T1, title: Objective one }
key_results:
`;

const problems = (yaml: string): string[] => {
  try {
    parseConfig(BASE + yaml);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
};

describe('okrs.yml validation', () => {
  it('accepts the repository okrs.yml', () => {
    const { config } = loadConfig(resolve(__dirname, '../../okrs.yml'));
    expect(config.key_results.length).toBeGreaterThan(0);
  });

  it('accepts a minimal manual KR', () => {
    expect(problems(`  - { id: KR1.1, objective_id: T1, title: t, type: manual, value: 3, target: 16, due: MVP, updated: 2026-11-01 }`)).toEqual([]);
  });

  it('names the KR and field for an unknown milestone', () => {
    expect(problems(`  - { id: KR1.1, objective_id: T1, title: t, type: manual, value: null, target: 16, due: MVPP }`)).toEqual([
      'key_results (KR1.1).due: "MVPP" is not a semester milestone (known: "MVP", "Final Delivery")',
    ]);
  });

  it('requires type-specific fields', () => {
    expect(problems(`  - { id: KR1.1, objective_id: T1, title: t, type: issues, target: 100, due: MVP }`)).toContain(
      'key_results[0] (KR1.1): missing required field "label"',
    );
  });

  it('rejects both target/due and checkpoints', () => {
    const p = problems(`  - { id: KR1.1, objective_id: T1, title: t, type: manual, value: 1, target: 1, due: MVP, checkpoints: [{ milestone: MVP, target: 1 }] }`);
    expect(p.some((x) => x.includes('either "target" + "due" or a "checkpoints" list'))).toBe(true);
  });

  it('rejects unknown fields, types and objectives', () => {
    const p = problems(`  - { id: KR1.1, objective_id: T9, title: t, type: manual, value: 1, target: 1, due: MVP, colour: red }`);
    expect(p).toContain('key_results[0] (KR1.1): unknown field "colour"');
    const q = problems(`  - { id: KR1.1, objective_id: T1, title: t, type: magic, target: 1, due: MVP }`);
    expect(q.some((x) => x.includes('.type: must be one of'))).toBe(true);
  });

  it('checks cross references and ordering', () => {
    const p = problems(`
  - { id: KR1.1, objective_id: T9, title: t, type: manual, value: 1, checkpoints: [{ milestone: Final Delivery, target: 3 }, { milestone: MVP, target: 1 }] }
  - { id: KR1.1, objective_id: T1, title: t, type: manual, value: 1, direction: lower, target: 50, due: MVP }`);
    expect(p).toEqual(
      expect.arrayContaining([
        'key_results (KR1.1).objective_id: "T9" is not an objective id (known: T1)',
        'key_results (KR1.1).checkpoints: must be in increasing week order',
        'key_results (KR1.1): duplicate id "KR1.1"',
        'key_results (KR1.1): "direction: lower" needs a "baseline" (the starting value to reduce from)',
      ]),
    );
  });

  it('reports YAML syntax errors', () => {
    expect(problems('  - { id: KR1.1, title: [unclosed')[0]).toMatch(/^YAML syntax/);
  });
});

describe('buildSnapshot', () => {
  const { config } = parseConfig(
    BASE +
      `  - { id: KR1.1, objective_id: T1, title: a, type: manual, value: 4, start_week: 7, target: 16, due: MVP }
  - { id: KR1.2, objective_id: T1, title: b, type: manual, value: null, target: 1, due: MVP }`,
  );

  it('computes progress, pace and status per KR and objective', () => {
    // 2026-11-12: 17 of 35 days into weeks 7–11 → expected 48.6%
    const s = buildSnapshot(config, '2026-11-12', { 'KR1.1': { current: 4, evidence: [] }, 'KR1.2': { current: null, evidence: [] } }, [], {
      generatedAt: 'x',
    });
    const [a, b] = s.keyResults;
    expect(s.semester.currentWeek).toBe(9);
    expect(a.progress).toBe(25);
    expect(a.expected).toBeCloseTo(48.6, 1);
    expect(a.status).toBe('at-risk');
    expect(b.status).toBe('no-data');
    expect(s.objectives[0]).toMatchObject({ progress: 25, status: 'at-risk', keyResultIds: ['KR1.1', 'KR1.2'] });
  });

  it('marks a KR whose collector failed as no-data with the error', () => {
    const s = buildSnapshot(config, '2026-11-12', { 'KR1.1': { error: 'boom' } }, []);
    expect(s.keyResults[0]).toMatchObject({ status: 'no-data', error: 'boom', progress: null });
  });

  it('keeps one history point per day, sorted', () => {
    const s1 = buildSnapshot(config, '2026-11-12', {}, []);
    const s0 = buildSnapshot(config, '2026-11-05', {}, []);
    const h = mergeHistory(mergeHistory([toHistoryPoint(s1)], toHistoryPoint(s0)), toHistoryPoint(s1));
    expect(h.map((p) => p.date)).toEqual(['2026-11-05', '2026-11-12']);
  });
});
