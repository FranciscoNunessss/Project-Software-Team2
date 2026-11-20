// "My progress" as a Markdown report: what the app shows on its progress screen, from the same endpoints
// (/api/progress, /dashboard, /outcomes, /learning, /coaching). Pure formatting; the view only fetches.

export type ProgressData = {
  progress?: { sessions: number; analyses: number; choices: number; matches: number; agreement: number | null; mean_gap: number | null }
  dashboard?: { over: number; under: number; series: unknown[] }
  outcomes?: {
    tasks: number
    skipped: number
    resolved: number
    resolved_with_refinement: number
    not_resolved: number
    described_poorly: number
    solved_rate_following: number | null
    solved_rate_not_following: number | null
    followed: number
    mean_turns: number | null
    by_model: { model: string | null; tasks: number; solved: number }[]
  }
  learning?: { points: { completeness: number }[]; min_sessions: number; verdict: string; dimensions: { dimension?: string; name?: string; early?: number; recent?: number }[] }
  coaching?: {
    configured: boolean
    model: string
    automatic_enabled: boolean
    generating: boolean
    error: string | null
    saved: null | {
      summary: string
      patterns: Record<string, { explanation: string; action: string; status?: string }>
      suggestions: { title: string; explanation: string; action: string }[]
    }
  }
}

const BARS = '▁▂▃▄▅▆▇█'

/** A sparkline of numbers between 0 and 100 (completeness); empty for no data. */
export function sparkline(values: number[]): string {
  return values.map(value => BARS[Math.min(BARS.length - 1, Math.max(0, Math.round((value / 100) * (BARS.length - 1))))]).join('')
}

const percent = (value: number | null | undefined): string => (value == null ? 'not enough data' : `${Math.round(value * (value <= 1 ? 100 : 1))}%`)

const VERDICT: Record<string, string> = {
  insufficient_history: 'Not enough sessions yet to say whether you describe tasks better over time.',
  improving: 'You describe tasks more completely than at the start.',
  declining: 'Your task descriptions are less complete than at the start.',
  stable: 'Your task descriptions are about as complete as at the start.',
}

export function renderProgress(data: ProgressData): string {
  const out: string[] = ['# My progress', '', '_Computed by the backend from your saved metadata. Agreement measures how often your choice matched the recommendation, not whether the choice was right._', '']
  const p = data.progress
  out.push('## Activity', '')
  out.push(p ? `${p.sessions} sessions · ${p.analyses} analyses · ${p.choices} choices · ${p.matches} matched the recommendation · agreement ${percent(p.agreement)} · mean gap ${p.mean_gap == null ? 'n/a' : p.mean_gap.toFixed(2)}` : 'Not available.', '')
  const d = data.dashboard
  if (d) out.push('## Over- and under-provisioning', '', `Over: ${d.over} · Under: ${d.under}. Over means you chose a model that covers more than the task needed; under, one that covers less.`, '')
  const o = data.outcomes
  out.push('## Your solved tasks', '')
  if (o && o.tasks + o.skipped > 0) {
    out.push(`${o.tasks} answered, ${o.skipped} skipped: ${o.resolved} solved · ${o.resolved_with_refinement} solved after refining · ${o.not_resolved} not solved (${o.described_poorly} because the task was described poorly).`)
    out.push('', `Following the recommendation: solved ${percent(o.solved_rate_following)} of ${o.followed} tasks; not following it: ${percent(o.solved_rate_not_following)}.${o.mean_turns != null ? ` Mean turns per task: ${o.mean_turns}.` : ''}`, '')
    if (o.by_model.length) out.push('| Model used | Tasks | Solved |', '| --- | --- | --- |', ...o.by_model.map(item => `| ${(item.model ?? 'unknown').replace(/\|/g, '\\|')} | ${item.tasks} | ${item.solved} |`), '')
  } else out.push('No answers yet: after an analysis, say whether the model solved the task.', '')
  const l = data.learning
  out.push('## Do you describe tasks better?', '')
  if (l) {
    out.push(VERDICT[l.verdict] ?? l.verdict, '')
    if (l.points.length) out.push(`Completeness of the first analysis of each session (${l.points.length}): ${sparkline(l.points.map(point => point.completeness))}`, '')
    else out.push(`It needs at least ${l.min_sessions} sessions.`, '')
  }
  const c = data.coaching
  out.push('## Suggestions from the Educator', '')
  if (!c) out.push('Not available.', '')
  else if (!c.configured) out.push('The Educator is not configured on this backend (it needs the project model).', '')
  else if (c.saved) {
    out.push(c.saved.summary, '')
    for (const [name, advice] of Object.entries(c.saved.patterns)) out.push(`- **${name.replace(/_/g, ' ')}${advice.status ? ` (${advice.status.replace(/_/g, ' ')})` : ''}:** ${advice.explanation} *Next:* ${advice.action}`)
    out.push('')
    for (const item of c.saved.suggestions) out.push(`- **${item.title}:** ${item.explanation} *Practice:* ${item.action}`)
    out.push('')
  } else out.push(c.generating ? 'Generating…' : c.automatic_enabled ? 'None yet: they appear after more analyses.' : 'Automatic suggestions are off. Switch them on in the AdaptAI Profile view.', '')
  if (c?.error) out.push(`_Last attempt failed: ${c.error}_`, '')
  return out.join('\n') + '\n'
}
