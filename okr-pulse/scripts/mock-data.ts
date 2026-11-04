// Generates realistic-looking data from the real okrs.yml so the dashboard can be
// developed without GitHub API calls. Output is marked "mock: true" and shown as such.
//
//   npm run mock                       → dashboard/public/data (default)
//   npx tsx scripts/mock-data.ts --out some/dir --date 2026-11-20 --days 30

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDate, toISODate } from '../shared/calendar';
import type { DocHealth, Evidence, OkrConfig } from '../shared/types';
import { loadConfig } from '../collector/config';
import { writeSnapshot } from '../collector/io';
import { buildSnapshot, type MeasurementOrError } from '../collector/snapshot';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

// Deterministic pseudo-random numbers, so every run produces the same mock data.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** How each KR performs relative to its pace (1 = exactly on pace). Cycles through a mix of statuses. */
const PERFORMANCE = [1.15, 0.92, 0.7, 0.05, 1.0, null, 0.85, 1.3, 0.6];

function mockMeasurements(config: OkrConfig, date: string, rand: () => number): Record<string, MeasurementOrError> {
  // First pass with no values gives us the expected % per KR for this date.
  const pace = buildSnapshot(config, date, {}, []);
  const repoUrl = `https://github.com/${config.repo}`;
  return Object.fromEntries(
    pace.keyResults.map((k, i) => {
      const perf = PERFORMANCE[i % PERFORMANCE.length];
      if (perf === null) return [k.id, { current: null, evidence: [], note: 'Mock: no value recorded yet.' }];
      const jitter = 0.9 + rand() * 0.2;
      const frac = Math.min((k.expected / 100) * perf * jitter, 1);
      const raw = k.baseline + (k.target - k.baseline) * frac;
      // Counts (people, patterns, /20) stay whole numbers; percentages keep one decimal.
      const isCount = k.checkpoints.every((c) => Number.isInteger(c.target) && c.target <= 20);
      const current = isCount ? Math.round(raw) : Math.round(raw * 10) / 10;
      const evidence: Evidence[] = [
        { kind: 'pr', title: `#${20 + i} Mock pull request for ${k.id}`, url: `${repoUrl}/pull/${20 + i}`, meta: 'merged' },
        { kind: 'issue', title: `#${40 + i} Mock issue for ${k.id}`, url: `${repoUrl}/issues/${40 + i}`, meta: i % 2 ? 'open' : 'closed' },
      ];
      return [k.id, { current, evidence, confidence: 0.5 + rand() * 0.4, note: 'Mock value.', updated: date }];
    }),
  );
}

function mockDocs(config: OkrConfig, date: string): DocHealth[] {
  const paths = config.docs_health?.length ? config.docs_health : ['README.md', 'docs/architecture.md', 'docs/test-plan.md'];
  const t = parseDate(date);
  return [...paths, 'docs/definition-of-done.md'].map((path, i) => {
    const url = `https://github.com/${config.repo}/blob/${config.branch ?? 'develop'}/${path}`;
    if (i === paths.length) {
      return { path, url, exists: false, checkboxes: { total: 0, checked: 0 }, completion: null, lastModified: null, stale: false };
    }
    const age = [2, 21, 6, 30][i % 4];
    const checkboxes = [{ total: 0, checked: 0 }, { total: 8, checked: 5 }, { total: 12, checked: 12 }, { total: 4, checked: 1 }][i % 4];
    return {
      path,
      url,
      exists: true,
      checkboxes,
      completion: checkboxes.total ? Math.round((checkboxes.checked / checkboxes.total) * 1000) / 10 : 100,
      lastModified: new Date(t - age * DAY).toISOString(),
      stale: age > (config.settings?.docs_stale_days ?? 14),
    };
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: resolve(here, '../../okrs.yml') },
      out: { type: 'string', default: resolve(here, '../dashboard/public/data') },
      date: { type: 'string', default: toISODate(Date.now()) },
      days: { type: 'string', default: '30' },
    },
  });
  const { config } = loadConfig(values.config!);
  const out = resolve(values.out!);
  rmSync(out, { recursive: true, force: true });

  const rand = rng(42);
  const end = parseDate(values.date!);
  const days = Number(values.days);
  for (let d = days - 1; d >= 0; d--) {
    const date = toISODate(end - d * DAY);
    const snapshot = buildSnapshot(config, date, mockMeasurements(config, date, rand), mockDocs(config, date), {
      generatedAt: `${date}T06:17:00.000Z`,
      mock: true,
    });
    writeSnapshot(out, snapshot);
  }
  console.log(`✓ Mock data: ${days} daily snapshots up to ${values.date} in ${out}`);
}

main();
