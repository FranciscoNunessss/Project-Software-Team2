// docs: each file exists and its Markdown checkboxes are ticked. Also used for the
// "docs health" panel (docs_health in okrs.yml).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daysBetween } from '../../shared/calendar';
import type { DocHealth, DocsKR } from '../../shared/types';
import type { CollectContext, Collector } from './types';

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/gm;

export function countCheckboxes(markdown: string): { total: number; checked: number } {
  let total = 0;
  let checked = 0;
  for (const m of markdown.matchAll(CHECKBOX)) {
    total++;
    if (m[1] !== ' ') checked++;
  }
  return { total, checked };
}

/** 100 for a file without checkboxes (it exists, nothing left to tick). */
export function checkboxCompletion(c: { total: number; checked: number }): number {
  return c.total === 0 ? 100 : Math.round((c.checked / c.total) * 1000) / 10;
}

async function lastModified(path: string, ctx: CollectContext): Promise<string | null> {
  if (ctx.gh) {
    try {
      const { data } = await ctx.gh.rest.repos.listCommits({ ...ctx.ref, path, sha: ctx.branch, per_page: 1 });
      const d = data[0]?.commit.committer?.date ?? data[0]?.commit.author?.date;
      if (d) return d;
    } catch {
      /* fall back to local git below */
    }
  }
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { cwd: ctx.repoRoot, encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function docHealth(path: string, ctx: CollectContext): Promise<DocHealth> {
  const abs = join(ctx.repoRoot, path);
  const url = `https://github.com/${ctx.repoFull}/blob/${ctx.branch}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const staleDays = ctx.config.settings?.docs_stale_days ?? 14;
  if (!existsSync(abs)) {
    return { path, url, exists: false, checkboxes: { total: 0, checked: 0 }, completion: null, lastModified: null, stale: false };
  }
  const checkboxes = countCheckboxes(readFileSync(abs, 'utf8'));
  const modified = await lastModified(path, ctx);
  return {
    path,
    url,
    exists: true,
    checkboxes,
    completion: checkboxCompletion(checkboxes),
    lastModified: modified,
    stale: modified ? daysBetween(modified.slice(0, 10), ctx.today) > staleDays : false,
  };
}

export const collectDocs: Collector<DocsKR> = async (kr, ctx) => {
  const docs = await Promise.all(kr.files.map((f) => docHealth(f, ctx)));
  const current = Math.round((docs.reduce((s, d) => s + (d.completion ?? 0), 0) / docs.length) * 10) / 10;
  const missing = docs.filter((d) => !d.exists).map((d) => d.path);
  return {
    current,
    evidence: docs.map((d) => ({
      kind: 'file' as const,
      title: d.path,
      url: d.exists ? d.url : undefined,
      meta: d.exists ? `${d.checkboxes.checked}/${d.checkboxes.total} checkboxes${d.stale ? ' · stale' : ''}` : 'missing',
    })),
    note: missing.length ? `Missing: ${missing.join(', ')}` : undefined,
  };
};
