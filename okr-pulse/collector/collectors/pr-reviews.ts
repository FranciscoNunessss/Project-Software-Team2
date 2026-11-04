// pr_reviews: % reduction in "changes requested" reviews per matching pull request,
// comparing a baseline window of weeks with the most recent window (KR3.3).

import { weekOf } from '../../shared/calendar';
import type { Evidence, PrReviewsKR } from '../../shared/types';
import { hasAiTrailer, listPullCommitMessages, listPulls, listReviews } from '../github';
import { requireGitHub, type Collector } from './types';

export interface ReviewedPull {
  number: number;
  title: string;
  url: string;
  week: number;
  changesRequested: number;
}

export interface ReductionResult {
  /** % reduction vs baseline (may be negative if it got worse); null if not measurable yet. */
  reduction: number | null;
  baselineAvg: number | null;
  windowAvg: number | null;
  baselinePulls: ReviewedPull[];
  windowPulls: ReviewedPull[];
  window: [number, number] | null;
  reason?: string;
}

const avg = (ps: ReviewedPull[]) => ps.reduce((s, p) => s + p.changesRequested, 0) / ps.length;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure aggregation, unit-tested in test/pr-reviews.test.ts. */
export function computeReduction(
  pulls: ReviewedPull[],
  baselineWeeks: [number, number],
  windowWeeks: number,
  currentWeek: number,
): ReductionResult {
  const [b0, b1] = baselineWeeks;
  const baselinePulls = pulls.filter((p) => p.week >= b0 && p.week <= b1);
  const base: ReductionResult = { reduction: null, baselineAvg: null, windowAvg: null, baselinePulls, windowPulls: [], window: null };

  if (currentWeek <= b1) {
    return { ...base, baselineAvg: baselinePulls.length ? r2(avg(baselinePulls)) : null, reason: `Baseline still being measured (weeks ${b0}–${b1}).` };
  }
  if (baselinePulls.length === 0) return { ...base, reason: `No matching pull requests in the baseline weeks ${b0}–${b1}.` };
  const baselineAvg = r2(avg(baselinePulls));
  if (baselineAvg === 0) {
    return { ...base, baselineAvg, reason: 'The baseline has 0 changes requested per pull request, so a reduction cannot be measured.' };
  }

  const w1 = currentWeek;
  const w0 = Math.max(b1 + 1, w1 - windowWeeks + 1);
  const windowPulls = pulls.filter((p) => p.week >= w0 && p.week <= w1);
  if (windowPulls.length === 0) {
    return { ...base, baselineAvg, window: [w0, w1], reason: `No matching pull requests in weeks ${w0}–${w1} yet.` };
  }
  const windowAvg = r2(avg(windowPulls));
  const reduction = Math.round(((baselineAvg - windowAvg) / baselineAvg) * 1000) / 10;
  return { reduction, baselineAvg, windowAvg, baselinePulls, windowPulls, window: [w0, w1] };
}

export const collectPrReviews: Collector<PrReviewsKR> = async (kr, ctx) => {
  const gh = requireGitHub(ctx);
  const start = ctx.config.semester.start_date;
  const currentWeek = weekOf(ctx.today, start);
  const match = kr.match ?? {};
  const all = await listPulls(gh, ctx.ref, ctx.cache);

  const candidates = all.filter((p) => {
    if (kr.base && p.base !== kr.base) return false;
    const w = weekOf(p.createdAt.slice(0, 10), start);
    return w >= kr.baseline_weeks[0] && w <= currentWeek;
  });

  const reviewed: ReviewedPull[] = [];
  for (const p of candidates) {
    let matches = !match.label && !match.ai_trailer; // no filter → every PR counts
    if (!matches && match.label && p.labels.includes(match.label)) matches = true;
    if (!matches && match.ai_trailer) {
      const msgs = await listPullCommitMessages(gh, ctx.ref, ctx.cache, p.number);
      matches = msgs.some(hasAiTrailer);
    }
    if (!matches) continue;
    const reviews = await listReviews(gh, ctx.ref, ctx.cache, p.number);
    reviewed.push({
      number: p.number,
      title: p.title,
      url: p.url,
      week: weekOf(p.createdAt.slice(0, 10), start),
      changesRequested: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length,
    });
  }

  const r = computeReduction(reviewed, kr.baseline_weeks, kr.window_weeks ?? 2, currentWeek);
  const toEvidence = (tag: string) => (p: ReviewedPull): Evidence => ({
    kind: 'pr',
    title: `#${p.number} ${p.title}`,
    url: p.url,
    meta: `${tag} · week ${p.week} · ${p.changesRequested} changes requested`,
  });
  const summary =
    r.baselineAvg !== null
      ? `Baseline ${r.baselineAvg} per PR (${r.baselinePulls.length} PRs)` +
        (r.windowAvg !== null && r.window ? `; weeks ${r.window[0]}–${r.window[1]}: ${r.windowAvg} per PR (${r.windowPulls.length} PRs)` : '')
      : undefined;

  return {
    current: r.reduction,
    evidence: [...r.windowPulls.map(toEvidence('window')), ...r.baselinePulls.map(toEvidence('baseline'))],
    note: [summary, r.reason].filter(Boolean).join('. ') || undefined,
  };
};
