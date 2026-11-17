// Turns an analysis into Markdown for an editor tab. Pure: no VS Code import, so it is unit tested.
// The wording follows the app (frontend/src/AnalysisResult.tsx): needs, coverage, alternatives, why.
import type { Analysis, Candidate, Coverage, CoverageState, Need } from './api'

const LEVEL = ['', 'Low', 'Medium', 'High'] as const
export const level = (value: number | null | undefined): string => (value ? LEVEL[value] ?? String(value) : 'Not determined')

const NEED_LABEL: Record<Need, string> = {
  reasoning: 'Reasoning',
  context: 'Context',
  domain: 'Domain',
  reliability: 'Reliability',
  tools: 'Tools',
}
const DIMENSION_LABEL: Record<string, string> = {
  reasoning: 'Reasoning depth',
  context: 'Context demand',
  ambiguity: 'Ambiguity',
  domain: 'Domain specificity',
  risk: 'Risk of error',
  tools: 'Tool / integration need',
  modality: 'Modality',
}
const STATE: Record<CoverageState, string> = {
  covers: 'Covers every need',
  covers_as_described: 'Covers the task as described',
  short: 'Falls short',
}

/** Table cells and inline text cannot hold a pipe or a line break. */
const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function modelName(candidate: Candidate): string {
  return candidate.label || (candidate.model ? `${candidate.provider ?? ''} ${candidate.model}`.trim() : candidate.name)
}

export function price(candidate: Candidate): string {
  if (candidate.free) return 'free'
  if (candidate.local) return 'local, no cost'
  const band = candidate.cost_band ? `${candidate.cost_band} cost band` : 'cost not known'
  return candidate.blended_price != null ? `${band} (${candidate.blended_price.toFixed(2)} USD per million tokens, blended)` : band
}

const legacyTier = (candidate: Candidate): string | undefined => (candidate.capacity ? ['', 'Small', 'Medium', 'Large'][candidate.capacity] : undefined)

function coverageTable(coverage: Coverage[]): string {
  if (!coverage.length) return ''
  const rows = coverage.map(item => `| ${NEED_LABEL[item.need] ?? item.need} | ${level(item.estimated)}${item.top !== item.estimated ? ` to ${level(item.top)}` : ''} | ${level(item.capability)} | ${STATE[item.state]}${item.provisional ? ' (provisional level)' : ''} |`)
  return ['| Need | Task needs | Model level | Result |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

function alternativesTable(alternatives: Candidate[], recommended: Candidate): string {
  if (!alternatives.length) return ''
  const rows = alternatives.map(item => {
    const vs = item.gap == null ? '' : item.gap > 0 ? 'covers more than needed' : item.gap < 0 ? 'covers less' : 'as recommended'
    return `| ${cell(modelName(item))} | ${item.status ? STATE[item.status] : legacyTier(item) ?? ''} | ${cell(price(item))} | ${cell(item.shortfalls?.length ? item.shortfalls.join(', ') : '')} | ${vs} |`
  })
  return ['| Model | Result | Cost | Short on | Compared with the recommendation |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

function needsTable(analysis: Analysis): string {
  const needs = analysis.needs?.needs
  if (!needs) return ''
  const rows = (Object.keys(NEED_LABEL) as Need[]).filter(name => needs[name]).map(name => {
    const need = needs[name]
    return `| ${NEED_LABEL[name]} | ${need.determined ? level(need.estimated) + (need.top !== need.estimated ? ` to ${level(need.top)}` : '') : 'Not determined (assumed Medium to High)'} |`
  })
  return ['| Need | Level the task needs |', '| --- | --- |', ...rows].join('\n')
}

function profileTable(analysis: Analysis): string {
  const rows = ['reasoning', 'context', 'ambiguity', 'domain', 'risk', 'tools'].map(key => {
    const item = analysis.profile[key as 'reasoning']
    return `| ${DIMENSION_LABEL[key]} | ${level(item.score)} | ${item.confidence} | ${cell(item.evidence)} |`
  })
  const modality = analysis.profile.modality
  rows.push(`| ${DIMENSION_LABEL.modality} | ${cell(modality.required?.join(', ') ?? 'Not determined')} | ${modality.confidence} | ${cell(modality.evidence)} |`)
  return ['| Dimension | Level | Confidence | Evidence |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

export function assessedBy(analysis: Analysis): string {
  return analysis.mode === 'demonstration' ? 'the demonstration heuristic (no model; a fixed example, not a real assessment)' : `${analysis.provider}${analysis.assessment_model ? ` · ${analysis.assessment_model}` : ''}`
}

export function summaryLine(analysis: Analysis): string {
  const model = analysis.recommendation
  const tier = legacyTier(model)
  return `${modelName(model)}${tier ? ` (${tier} tier, stored before ADR-014)` : ''}${analysis.recommendation_provisional ? ' · provisional' : ''}`
}

export function renderAnalysis(analysis: Analysis, extra: { task?: string; source?: string; truncated?: boolean; at?: string } = {}): string {
  const model = analysis.recommendation
  const out: string[] = []
  out.push(`# AdaptAI · ${summaryLine(analysis)}`)
  out.push('')
  out.push(`_Assessed by ${assessedBy(analysis)}${extra.at ? ` at ${extra.at}` : ''}.${extra.source ? ` Source: ${extra.source}.` : ''}${extra.truncated ? ' The text was cut to 8000 characters.' : ''}_`)
  out.push('')
  if (analysis.mode === 'demonstration') out.push('> **Demonstration mode.** No model assessed this task; the profile below is a fixed example.', '')
  if (analysis.recommendation_provisional) out.push('> **Provisional.** Some needs are undetermined or the evidence is weak, so the recommendation may change once the task is clearer.', '')
  out.push('## Recommended model', '')
  out.push(`**${modelName(model)}**${model.status ? ` · ${STATE[model.status]}` : ''}`, '')
  const facts = [price(model), model.levels_from ? `levels from ${model.levels_from}` : '', model.calibrated ? 'calibrated by the team' : 'not calibrated', model.illustrative ? 'illustrative catalogue entry, not a real model' : ''].filter(Boolean)
  out.push(facts.join(' · '), '')
  if (model.shortfalls?.length) out.push(`Falls short on: ${model.shortfalls.join(', ')}.`, '')
  const coverage = coverageTable(model.coverage ?? [])
  if (coverage) out.push(coverage, '')
  out.push('## Why', '', analysis.rationale, '')
  for (const note of analysis.notes ?? []) out.push(`- ${note}`)
  for (const warning of analysis.warnings) out.push(`- **Warning:** ${warning}`)
  if ((analysis.notes?.length ?? 0) + analysis.warnings.length) out.push('')
  const needs = needsTable(analysis)
  if (needs) {
    out.push('## What the task needs', '', needs, '')
    const bits = [analysis.needs?.modalities?.length ? `modalities: ${analysis.needs.modalities.join(', ')}` : '', analysis.needs ? `about ${analysis.needs.length_tokens} tokens long` : '', analysis.needs?.ambiguous ? 'ambiguous: see the questions below' : '']
    out.push(bits.filter(Boolean).join(' · '), '')
  }
  const alternatives = alternativesTable(analysis.alternatives, model)
  if (alternatives) out.push('## Alternatives', '', alternatives, '')
  if (analysis.suggestion) {
    out.push('## Also on OpenRouter', '', `**${modelName(analysis.suggestion)}**: ${analysis.suggestion_reason ?? ''} (${price(analysis.suggestion)}${analysis.suggestion.levels_from ? `, levels from ${analysis.suggestion.levels_from}` : ''})`, '')
  }
  if (analysis.clarification_questions.length) out.push('## Questions that would sharpen the result', '', ...analysis.clarification_questions.map(item => `- ${item}`), '')
  if (analysis.tips.length || analysis.guidance.length) {
    out.push('## Improve your request', '')
    for (const tip of analysis.tips) out.push(`- **${tip.dimension ? DIMENSION_LABEL[tip.dimension] ?? tip.dimension : 'General'}:** ${tip.text}`)
    for (const line of analysis.guidance) out.push(`- ${line}`)
    out.push('')
  }
  if (analysis.changes?.length) {
    out.push('## Changes since the previous analysis', '')
    for (const change of analysis.changes) out.push(`- ${DIMENSION_LABEL[change.dimension] ?? change.dimension}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`)
    out.push('')
  }
  out.push('## Task profile', '', profileTable(analysis), '', analysis.profile.explanation, '')
  out.push(`Completeness: ${analysis.completeness ?? 'n/a'}/100 · profile ${analysis.profile_version} · policy ${analysis.policy_version} · catalogue ${analysis.catalogue_version}${analysis.rubric_version ? ` · rubric ${analysis.rubric_version}` : ''}. Levels are uncalibrated unless marked calibrated.`)
  return out.join('\n') + '\n'
}

/** One paragraph for the clipboard or a message. */
export function textSummary(analysis: Analysis): string {
  const model = analysis.recommendation
  const lines = [`AdaptAI recommends: ${summaryLine(analysis)} (${price(model)})`, '', analysis.rationale, '', `Assessed by ${assessedBy(analysis)}.`]
  if (analysis.alternatives.length) lines.push('', `Alternatives: ${analysis.alternatives.map(modelName).join(', ')}`)
  for (const warning of analysis.warnings) lines.push(`! ${warning}`)
  return lines.join('\n')
}
