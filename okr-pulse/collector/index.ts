// OKR Pulse collector.
//
//   npx tsx collector/index.ts [--config ../okrs.yml] [--repo-root ..] [--out ./out/data]
//                              [--date YYYY-MM-DD] [--offline] [--validate-only]
//
// Reads okrs.yml, measures every KR (GitHub API + repo files), and writes
// latest.json + history/<date>.json + history/index.json into --out.
// Uses GITHUB_TOKEN (or GH_TOKEN) when set; that is all a private repo needs.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { toISODate } from '../shared/calendar';
import type { KRDef } from '../shared/types';
import { ConfigError, loadConfig } from './config';
import { collectCi, collectManual } from './collectors/ci-manual';
import { collectDocs, docHealth } from './collectors/docs';
import { collectIssues, collectMilestone, collectPrs } from './collectors/github-items';
import { collectPrReviews } from './collectors/pr-reviews';
import type { CollectContext, Collector, Measurement } from './collectors/types';
import { createClient, RunCache } from './github';
import { writeSnapshot } from './io';
import { buildSnapshot, type MeasurementOrError } from './snapshot';

const here = dirname(fileURLToPath(import.meta.url));

const COLLECTORS: { [T in KRDef['type']]: Collector<Extract<KRDef, { type: T }>> } = {
  issues: collectIssues,
  milestone: collectMilestone,
  prs: collectPrs,
  pr_reviews: collectPrReviews,
  docs: collectDocs,
  ci: collectCi,
  manual: collectManual,
};

async function main() {
  const { values: args } = parseArgs({
    options: {
      config: { type: 'string', default: resolve(here, '../../okrs.yml') },
      'repo-root': { type: 'string' },
      out: { type: 'string', default: resolve(here, '../out/data') },
      date: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'validate-only': { type: 'boolean', default: false },
    },
  });

  const configPath = resolve(args.config!);
  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { config, warnings } = loaded;
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.log(`✓ ${configPath}: ${config.objectives.length} objectives, ${config.key_results.length} key results`);
  if (args['validate-only']) return;

  const today = args.date ?? toISODate(Date.now());
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token && !args.offline) console.warn('  ! No GITHUB_TOKEN: using unauthenticated API (public repos only, 60 requests/hour)');
  const [owner, repo] = config.repo.split('/');
  const ctx: CollectContext = {
    gh: args.offline ? null : createClient(token),
    ref: { owner, repo },
    repoFull: config.repo,
    branch: config.branch ?? 'develop',
    today,
    config,
    repoRoot: resolve(args['repo-root'] ?? dirname(configPath)),
    cache: new RunCache(),
  };

  const measurements: Record<string, MeasurementOrError> = {};
  for (const kr of config.key_results) {
    try {
      const collect = COLLECTORS[kr.type] as Collector;
      const m: Measurement = await collect(kr, ctx);
      measurements[kr.id] = m;
      console.log(`  ${kr.id.padEnd(8)} ${kr.type.padEnd(10)} ${m.current ?? '—'}${m.note ? `  (${m.note})` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      measurements[kr.id] = { error: msg };
      console.error(`  ✗ ${kr.id}: ${msg}`);
    }
  }

  const docs = await Promise.all((config.docs_health ?? []).map((p) => docHealth(p, ctx)));
  const snapshot = buildSnapshot(config, today, measurements, docs);
  const written = writeSnapshot(resolve(args.out!), snapshot);
  console.log(`✓ Week ${snapshot.semester.currentWeek}: wrote ${written.latest} and ${written.history}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
