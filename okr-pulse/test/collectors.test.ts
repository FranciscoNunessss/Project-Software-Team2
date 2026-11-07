import { describe, expect, it } from 'vitest';
import { checkboxCompletion, countCheckboxes } from '../collector/collectors/docs';
import { getJsonPath } from '../collector/collectors/ci-manual';
import { computeReduction, type ReviewedPull } from '../collector/collectors/pr-reviews';
import { globToRegExp, hasAiTrailer } from '../collector/github';

const pr = (number: number, week: number, changesRequested: number): ReviewedPull => ({
  number,
  title: `PR ${number}`,
  url: `https://example.test/${number}`,
  week,
  changesRequested,
});

describe('computeReduction (KR3.3)', () => {
  const pulls = [pr(1, 7, 2), pr(2, 8, 1), pr(3, 8, 3), pr(4, 9, 1), pr(5, 10, 1), pr(6, 11, 0)];

  it('waits while the baseline is being measured', () => {
    const r = computeReduction(pulls, [7, 8], 2, 8);
    expect(r.reduction).toBeNull();
    expect(r.baselineAvg).toBe(2);
    expect(r.reason).toMatch(/Baseline still being measured/);
  });
  it('compares the latest window with the baseline', () => {
    const r = computeReduction(pulls, [7, 8], 2, 11); // weeks 10–11: (1 + 0) / 2
    expect(r.window).toEqual([10, 11]);
    expect(r.windowAvg).toBe(0.5);
    expect(r.reduction).toBe(75);
  });
  it('never lets the window overlap the baseline', () => {
    const r = computeReduction(pulls, [7, 8], 3, 9);
    expect(r.window).toEqual([9, 9]);
    expect(r.reduction).toBe(50);
  });
  it('reports a negative reduction when it got worse', () => {
    const r = computeReduction([pr(1, 7, 1), pr(2, 9, 2)], [7, 8], 2, 9);
    expect(r.reduction).toBe(-100);
  });
  it('cannot measure a reduction from a zero baseline', () => {
    const r = computeReduction([pr(1, 7, 0), pr(2, 9, 0)], [7, 8], 2, 9);
    expect(r.reduction).toBeNull();
    expect(r.reason).toMatch(/0 changes requested/);
  });
  it('needs PRs in both windows', () => {
    expect(computeReduction([pr(2, 9, 1)], [7, 8], 2, 9).reason).toMatch(/No matching pull requests in the baseline/);
    expect(computeReduction([pr(1, 7, 1)], [7, 8], 2, 9).reason).toMatch(/weeks 9–9/);
  });
});

describe('docs checkboxes', () => {
  it('counts ticked and unticked Markdown task items', () => {
    const md = ['# DoD', '- [x] tests', '- [ ] docs', '* [X] review', '1. [ ] demo', 'not [x] a task', '  - [x] nested'].join('\n');
    expect(countCheckboxes(md)).toEqual({ total: 5, checked: 3 });
    expect(checkboxCompletion({ total: 5, checked: 3 })).toBe(60);
    expect(checkboxCompletion({ total: 0, checked: 0 })).toBe(100);
  });
});

describe('helpers', () => {
  it('reads JSON paths', () => {
    const json = { totals: { percent_covered: 81.25 }, files: [{ pct: 3 }] };
    expect(getJsonPath(json, 'totals.percent_covered')).toBe(81.25);
    expect(getJsonPath(json, '$.files[0].pct')).toBe(3);
    expect(getJsonPath(json, 'nope.x')).toBeUndefined();
  });
  it('matches path globs', () => {
    expect(globToRegExp('backend/**').test('backend/app/main.py')).toBe(true);
    expect(globToRegExp('backend/*.py').test('backend/app/main.py')).toBe(false);
    expect(globToRegExp('docs/**/*.md').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('docs/**/*.md').test('docs/b.md')).toBe(true);
  });
  it('detects AI co-author trailers', () => {
    expect(hasAiTrailer('feat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>')).toBe(true);
    expect(hasAiTrailer('fix: y\n\nCo-authored-by: Rita <rita@example.com>')).toBe(false);
    expect(hasAiTrailer('mention claude in body only')).toBe(false);
  });
});
