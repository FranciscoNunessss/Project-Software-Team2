// Collectors for KR types backed by GitHub issues, milestones and pull requests.

import { globToRegExp, listPullFiles, listPulls, listReviews } from '../github';
import type { Evidence, IssuesKR, MilestoneKR, PrsKR } from '../../shared/types';
import { requireGitHub, type Collector } from './types';

const pct = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;

/** issues: % of issues with the label that are closed. */
export const collectIssues: Collector<IssuesKR> = async (kr, ctx) => {
  const gh = requireGitHub(ctx);
  const items = await gh.paginate(gh.rest.issues.listForRepo, { ...ctx.ref, labels: kr.label, state: 'all', per_page: 100 });
  const issues = items.filter((i) => !i.pull_request);
  if (issues.length === 0) {
    return { current: null, evidence: [], note: `No issues with the label "${kr.label}" yet.` };
  }
  const closed = issues.filter((i) => i.state === 'closed').length;
  const evidence: Evidence[] = [...issues]
    .sort((a, b) => (a.state === b.state ? b.number - a.number : a.state === 'open' ? -1 : 1))
    .slice(0, 30)
    .map((i) => ({ kind: 'issue', title: `#${i.number} ${i.title}`, url: i.html_url, meta: i.state }));
  return { current: pct(closed, issues.length), evidence, note: `${closed} of ${issues.length} issues closed` };
};

/** milestone: GitHub milestone completion (closed / all issues and PRs in it). */
export const collectMilestone: Collector<MilestoneKR> = async (kr, ctx) => {
  const gh = requireGitHub(ctx);
  const all = await ctx.cache.get('milestones', () =>
    gh.paginate(gh.rest.issues.listMilestones, { ...ctx.ref, state: 'all', per_page: 100 }),
  );
  const m = all.find((x) => x.title === kr.name);
  if (!m) {
    const known = all.map((x) => `"${x.title}"`).join(', ') || 'none';
    return { current: null, evidence: [], note: `GitHub milestone "${kr.name}" not found (existing: ${known}).` };
  }
  const total = m.open_issues + m.closed_issues;
  return {
    current: total ? pct(m.closed_issues, total) : null,
    evidence: [{ kind: 'milestone', title: m.title, url: m.html_url, meta: `${m.closed_issues}/${total} closed` }],
    note: total ? undefined : 'Milestone has no issues yet.',
  };
};

/** prs: number of merged PRs matching label / base / paths / reviewer. */
export const collectPrs: Collector<PrsKR> = async (kr, ctx) => {
  const gh = requireGitHub(ctx);
  const pulls = await listPulls(gh, ctx.ref, ctx.cache);
  const pathRes = (kr.paths ?? []).map(globToRegExp);
  const reviewer = kr.require_review_by?.toLowerCase();
  const matched: Evidence[] = [];

  for (const p of pulls) {
    if (!p.mergedAt) continue;
    if (kr.base && p.base !== kr.base) continue;
    if (kr.label && !p.labels.includes(kr.label)) continue;
    if (pathRes.length) {
      const files = await listPullFiles(gh, ctx.ref, ctx.cache, p.number);
      if (!files.some((f) => pathRes.some((re) => re.test(f)))) continue;
    }
    if (reviewer) {
      const reviews = await listReviews(gh, ctx.ref, ctx.cache, p.number);
      if (!reviews.some((r) => r.state === 'APPROVED' && r.login.toLowerCase() === reviewer)) continue;
    }
    matched.push({ kind: 'pr', title: `#${p.number} ${p.title}`, url: p.url, meta: `merged ${p.mergedAt.slice(0, 10)}` });
  }
  return { current: matched.length, evidence: matched.slice(0, 50) };
};
