// Writes data/latest.json, data/history/YYYY-MM-DD.json and data/history/index.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryPoint, Snapshot } from '../shared/types';
import { mergeHistory, toHistoryPoint } from './snapshot';

export function writeSnapshot(outDir: string, snapshot: Snapshot): { latest: string; history: string } {
  const histDir = join(outDir, 'history');
  mkdirSync(histDir, { recursive: true });
  const latest = join(outDir, 'latest.json');
  const history = join(histDir, `${snapshot.date}.json`);
  writeFileSync(latest, JSON.stringify(snapshot, null, 2) + '\n');
  writeFileSync(history, JSON.stringify(snapshot, null, 2) + '\n');

  const indexPath = join(histDir, 'index.json');
  const index: HistoryPoint[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  writeFileSync(indexPath, JSON.stringify(mergeHistory(index, toHistoryPoint(snapshot)), null, 1) + '\n');
  return { latest, history };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
