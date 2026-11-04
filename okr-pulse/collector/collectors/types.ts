import type { GH, RepoRef, RunCache } from '../github';
import type { Evidence, KRDef, OkrConfig } from '../../shared/types';

export interface CollectContext {
  /** Null when running with --offline; GitHub-backed collectors then report an error. */
  gh: GH | null;
  ref: RepoRef;
  repoFull: string;
  branch: string;
  today: string;
  config: OkrConfig;
  repoRoot: string;
  cache: RunCache;
}

export interface Measurement {
  current: number | null;
  evidence: Evidence[];
  note?: string;
  confidence?: number;
  updated?: string;
}

export type Collector<K extends KRDef = KRDef> = (kr: K, ctx: CollectContext) => Promise<Measurement>;

export function requireGitHub(ctx: CollectContext): GH {
  if (!ctx.gh) throw new Error('GitHub access disabled (--offline)');
  return ctx.gh;
}
