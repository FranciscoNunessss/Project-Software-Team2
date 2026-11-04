// Loads okrs.yml, validates it against schema/okrs.schema.json, then runs the
// cross-reference checks a JSON Schema cannot express. Every error names the
// KR or objective it belongs to, so students can fix the YAML without guessing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import _Ajv from 'ajv';
import _addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { parseDocument } from 'yaml';
import type { CheckpointResult, KRDef, OkrConfig } from '../shared/types';

// ajv and ajv-formats are CommonJS; normalise the default export under ESM.
const Ajv = ((_Ajv as unknown as { default?: unknown }).default ?? _Ajv) as typeof import('ajv').default;
const addFormats = ((_addFormats as unknown as { default?: unknown }).default ?? _addFormats) as unknown as (a: unknown) => void;

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, '../schema/okrs.schema.json');

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    public readonly problems: string[],
  ) {
    super(`${file} is invalid:\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  config: OkrConfig;
  warnings: string[];
}

export function loadConfig(path: string): LoadedConfig {
  return parseConfig(readFileSync(path, 'utf8'), path);
}

export function parseConfig(text: string, file = 'okrs.yml'): LoadedConfig {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    throw new ConfigError(file, doc.errors.map((e) => `YAML syntax: ${e.message.split('\n')[0]}`));
  }
  const data = doc.toJS() as unknown;

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new ConfigError(file, formatAjvErrors(validate.errors ?? [], data));
  }
  const config = data as OkrConfig;
  const { errors, warnings } = semanticChecks(config);
  if (errors.length) throw new ConfigError(file, errors);
  return { config, warnings };
}

/** "/key_results/3/checkpoints/0" → "key_results[3] (KR2.1).checkpoints[0]" */
function describePath(instancePath: string, data: unknown): string {
  if (!instancePath) return '(root)';
  const parts = instancePath.split('/').slice(1);
  let out = '';
  let node: unknown = data;
  for (const p of parts) {
    const isIndex = /^\d+$/.test(p);
    node = (node as Record<string, unknown> | undefined)?.[p];
    if (isIndex) {
      const id = (node as { id?: unknown } | undefined)?.id;
      out += `[${p}]${typeof id === 'string' ? ` (${id})` : ''}`;
    } else {
      out += out ? `.${p}` : p;
    }
  }
  return out;
}

function formatAjvErrors(errors: ErrorObject[], data: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      out.push(msg);
    }
  };
  const oneOfFailures = new Set(errors.filter((e) => e.keyword === 'oneOf').map((e) => e.instancePath));
  for (const e of errors) {
    const where = describePath(e.instancePath, data);
    // Collapse the noisy sub-errors of the "target+due XOR checkpoints" rule into one line.
    if (e.schemaPath.includes('/oneOf/') || e.keyword === 'oneOf') {
      if (oneOfFailures.has(e.instancePath)) {
        add(`${where}: give either "target" + "due" or a "checkpoints" list (not both, not neither)`);
      }
      continue;
    }
    if (e.keyword === 'if') continue; // the "then" error that follows is the useful one
    if (e.keyword === 'additionalProperties') {
      add(`${where}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`);
    } else if (e.keyword === 'required') {
      add(`${where}: missing required field "${(e.params as { missingProperty: string }).missingProperty}"`);
    } else if (e.keyword === 'enum') {
      add(`${where}: must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}`);
    } else {
      add(`${where}: ${e.message}`);
    }
  }
  return out;
}

export function resolveCheckpoints(kr: KRDef, config: OkrConfig): CheckpointResult[] {
  const weekOf = new Map(config.semester.milestones.map((m) => [m.name, m.week]));
  const raw = kr.checkpoints ?? [{ milestone: kr.due as string, target: kr.target as number }];
  return raw.map((cp) => ({ milestone: cp.milestone, week: weekOf.get(cp.milestone) ?? NaN, target: cp.target }));
}

function semanticChecks(config: OkrConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { semester } = config;
  const milestoneNames = new Set<string>();

  for (const m of semester.milestones) {
    if (milestoneNames.has(m.name)) errors.push(`semester.milestones: duplicate milestone "${m.name}"`);
    milestoneNames.add(m.name);
    if (m.week > semester.weeks) errors.push(`semester.milestones: "${m.name}" is in week ${m.week}, after the last week (${semester.weeks})`);
  }

  const s = config.settings ?? {};
  if ((s.at_risk_gap ?? 10) > (s.behind_gap ?? 25)) errors.push('settings: at_risk_gap must not be larger than behind_gap');

  const objectiveIds = new Set<string>();
  for (const o of config.objectives) {
    if (objectiveIds.has(o.id)) errors.push(`objectives: duplicate id "${o.id}"`);
    objectiveIds.add(o.id);
  }

  const krIds = new Set<string>();
  const used = new Set<string>();
  const known = [...milestoneNames].map((n) => `"${n}"`).join(', ');
  for (const kr of config.key_results) {
    const at = `key_results (${kr.id})`;
    if (krIds.has(kr.id)) errors.push(`${at}: duplicate id "${kr.id}"`);
    krIds.add(kr.id);
    if (!objectiveIds.has(kr.objective_id)) {
      errors.push(`${at}.objective_id: "${kr.objective_id}" is not an objective id (known: ${[...objectiveIds].join(', ')})`);
    }
    used.add(kr.objective_id);

    const cps = resolveCheckpoints(kr, config);
    cps.forEach((cp, i) => {
      if (!milestoneNames.has(cp.milestone)) {
        const field = kr.checkpoints ? `checkpoints[${i}].milestone` : 'due';
        errors.push(`${at}.${field}: "${cp.milestone}" is not a semester milestone (known: ${known})`);
      }
    });
    for (let i = 1; i < cps.length; i++) {
      if (cps[i].week <= cps[i - 1].week) errors.push(`${at}.checkpoints: must be in increasing week order`);
    }
    if (kr.start_week !== undefined && cps[0] && kr.start_week > cps[0].week) {
      errors.push(`${at}.start_week: week ${kr.start_week} is after the first checkpoint (week ${cps[0].week})`);
    }
    const baseline = kr.baseline ?? (kr.direction === 'lower' ? undefined : 0);
    if (kr.direction === 'lower' && kr.baseline === undefined) {
      errors.push(`${at}: "direction: lower" needs a "baseline" (the starting value to reduce from)`);
    }
    if (baseline !== undefined) {
      for (const cp of cps) {
        if (kr.direction === 'lower' ? cp.target >= baseline : cp.target <= baseline) {
          errors.push(`${at}: target ${cp.target} at "${cp.milestone}" does not improve on baseline ${baseline} (direction: ${kr.direction ?? 'higher'})`);
        }
      }
    }
    if (kr.type === 'pr_reviews') {
      const [a, b] = kr.baseline_weeks;
      if (a > b) errors.push(`${at}.baseline_weeks: first week must not be after the second`);
      if (cps[0] && b >= cps[0].week) errors.push(`${at}.baseline_weeks: the baseline must end before the first checkpoint (week ${cps[0].week})`);
    }
    if (kr.type === 'manual' && kr.value !== null && kr.updated === undefined) {
      warnings.push(`${at}: manual value has no "updated" date; the dashboard cannot show how fresh it is`);
    }
  }

  for (const id of objectiveIds) if (!used.has(id)) warnings.push(`objectives (${id}): has no key results`);
  return { errors, warnings };
}
