// Types shared by the collector (writes the JSON) and the dashboard (reads it).
// Keep this file free of Node-only imports so Vite can bundle it.

// ---------- okrs.yml (after validation) ----------

export type KRType = 'issues' | 'milestone' | 'prs' | 'pr_reviews' | 'docs' | 'ci' | 'manual';
export type Direction = 'higher' | 'lower';
export type Pace = 'linear' | 'constant';

export interface MilestoneDef {
  name: string;
  week: number;
}

export interface CheckpointDef {
  milestone: string;
  target: number;
}

export interface EvidenceDef {
  title: string;
  url?: string;
}

interface KRBase {
  id: string;
  objective_id: string;
  title: string;
  owner?: string;
  proposed?: boolean;
  unit?: string;
  direction?: Direction;
  baseline?: number;
  start_week?: number;
  pace?: Pace;
  /** Shorthand for a single checkpoint: target + due. */
  target?: number;
  due?: string;
  checkpoints?: CheckpointDef[];
  evidence?: EvidenceDef[];
}

export interface IssuesKR extends KRBase {
  type: 'issues';
  label: string;
}
export interface MilestoneKR extends KRBase {
  type: 'milestone';
  name: string;
}
export interface PrsKR extends KRBase {
  type: 'prs';
  label?: string;
  paths?: string[];
  base?: string;
  require_review_by?: string;
}
export interface PrMatch {
  label?: string;
  ai_trailer?: boolean;
}
export interface PrReviewsKR extends KRBase {
  type: 'pr_reviews';
  base?: string;
  match?: PrMatch;
  baseline_weeks: [number, number];
  window_weeks?: number;
}
export interface DocsKR extends KRBase {
  type: 'docs';
  files: string[];
}
export interface CiKR extends KRBase {
  type: 'ci';
  workflow: string;
  artifact: string;
  file: string;
  json_path: string;
  branch?: string;
}
export interface ManualKR extends KRBase {
  type: 'manual';
  value: number | null;
  confidence?: number;
  note?: string;
  updated?: string;
}

export type KRDef = IssuesKR | MilestoneKR | PrsKR | PrReviewsKR | DocsKR | CiKR | ManualKR;

export interface ObjectiveDef {
  id: string;
  title: string;
  description?: string;
  supports?: string[];
}

export interface OkrConfig {
  version: 1;
  repo: string;
  branch?: string;
  semester: {
    start_date: string;
    weeks: number;
    milestones: MilestoneDef[];
  };
  settings?: {
    at_risk_gap?: number;
    behind_gap?: number;
    docs_stale_days?: number;
  };
  docs_health?: string[];
  objectives: ObjectiveDef[];
  key_results: KRDef[];
}

// ---------- Snapshot JSON (collector output) ----------

export type KRStatus = 'done' | 'on-track' | 'at-risk' | 'behind' | 'no-data';

export type EvidenceKind = 'issue' | 'pr' | 'file' | 'ci' | 'milestone' | 'link' | 'note';

export interface Evidence {
  kind: EvidenceKind;
  title: string;
  url?: string;
  meta?: string;
}

export interface CheckpointResult {
  milestone: string;
  week: number;
  target: number;
}

export interface KRResult {
  id: string;
  objectiveId: string;
  title: string;
  type: KRType;
  owner?: string;
  proposed: boolean;
  unit?: string;
  direction: Direction;
  baseline: number;
  /** Measured value in the KR's own unit; null when nothing has been measured. */
  current: number | null;
  /** Target of the checkpoint currently being worked towards. */
  target: number;
  dueMilestone: string;
  dueWeek: number;
  checkpoints: CheckpointResult[];
  /** 0–100, or null when there is no measured value. */
  progress: number | null;
  /** 0–100: where a linear pace says progress should be today. */
  expected: number;
  status: KRStatus;
  confidence?: number;
  note?: string;
  updated?: string;
  error?: string;
  evidence: Evidence[];
}

export interface ObjectiveResult {
  id: string;
  title: string;
  description?: string;
  supports?: string[];
  progress: number | null;
  status: KRStatus;
  keyResultIds: string[];
}

export interface DocHealth {
  path: string;
  url: string;
  exists: boolean;
  checkboxes: { total: number; checked: number };
  /** Checkbox completion 0–100; 100 for an existing file without checkboxes; null when missing. */
  completion: number | null;
  lastModified: string | null;
  stale: boolean;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  date: string;
  repo: string;
  branch: string;
  mock?: boolean;
  semester: {
    startDate: string;
    weeks: number;
    currentWeek: number;
    milestones: MilestoneDef[];
  };
  settings: { atRiskGap: number; behindGap: number; docsStaleDays: number };
  objectives: ObjectiveResult[];
  keyResults: KRResult[];
  docs: DocHealth[];
}

/** One row per snapshot day in data/history/index.json, used by the history chart. */
export interface HistoryPoint {
  date: string;
  week: number;
  kr: Record<string, number | null>;
  objectives: Record<string, number | null>;
}
