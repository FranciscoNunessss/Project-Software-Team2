// ci: a numeric value read from a JSON file inside a workflow artifact (e.g. coverage).
// manual: a value typed into okrs.yml by the KR owner.

import { unzipSync, strFromU8 } from 'fflate';
import type { CiKR, ManualKR } from '../../shared/types';
import { requireGitHub, type Collector } from './types';

/** Reads "a.b[0].c" (an optional leading "$." is ignored). */
export function getJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+/g) ?? [];
  return parts.reduce<unknown>((node, key) => (node == null ? undefined : (node as Record<string, unknown>)[key]), obj);
}

export const collectCi: Collector<CiKR> = async (kr, ctx) => {
  const gh = requireGitHub(ctx);
  const branch = kr.branch ?? ctx.branch;
  const { data: runs } = await gh.rest.actions.listWorkflowRuns({ ...ctx.ref, workflow_id: kr.workflow, branch, status: 'success', per_page: 1 });
  const run = runs.workflow_runs[0];
  if (!run) return { current: null, evidence: [], note: `No successful run of ${kr.workflow} on ${branch} yet.` };

  const { data: arts } = await gh.rest.actions.listWorkflowRunArtifacts({ ...ctx.ref, run_id: run.id, per_page: 100 });
  const art = arts.artifacts.find((a) => a.name === kr.artifact && !a.expired);
  const runEvidence = { kind: 'ci' as const, title: `${kr.workflow} run #${run.run_number}`, url: run.html_url, meta: run.created_at.slice(0, 10) };
  if (!art) return { current: null, evidence: [runEvidence], note: `Artifact "${kr.artifact}" not found (or expired) in the latest successful run.` };

  const zip = await gh.rest.actions.downloadArtifact({ ...ctx.ref, artifact_id: art.id, archive_format: 'zip' });
  const files = unzipSync(new Uint8Array(zip.data as ArrayBuffer));
  const raw = files[kr.file];
  if (!raw) return { current: null, evidence: [runEvidence], note: `File "${kr.file}" not in artifact (has: ${Object.keys(files).join(', ')}).` };

  const value = Number(getJsonPath(JSON.parse(strFromU8(raw)), kr.json_path));
  if (!Number.isFinite(value)) return { current: null, evidence: [runEvidence], note: `"${kr.json_path}" is not a number in ${kr.file}.` };
  return { current: Math.round(value * 10) / 10, evidence: [runEvidence] };
};

export const collectManual: Collector<ManualKR> = async (kr) => ({
  current: kr.value,
  evidence: [],
  note: kr.note,
  confidence: kr.confidence,
  updated: kr.updated,
});
