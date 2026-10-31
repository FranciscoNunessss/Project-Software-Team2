import type { Analysis, Change, DimensionName } from './api'

const labels: Record<DimensionName, string> = {
  reasoning: 'Reasoning depth',
  context: 'Context demand',
  ambiguity: 'Ambiguity',
  domain: 'Domain specificity',
  risk: 'Risk of error',
  tools: 'Tool / integration need',
  modality: 'Required modalities',
}

function show(value: Change['before']) {
  if (value === null) return 'Not determined'
  return Array.isArray(value) ? value.join(', ') : String(value)
}

export function AnalysisChanges({ analysis }: { analysis: Analysis }) {
  if (analysis.completeness === null || analysis.completeness === undefined) return null
  const changes = analysis.changes ?? []
  return (
    <section className="card assessment-advice" data-analysis-changes>
      <h3>Profile completeness</h3>
      <div className="profile-row">
        <div className="bar-track" role="meter" aria-label="Profile completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysis.completeness}>
          <span className="bar-fill" style={{ width: `${analysis.completeness}%` }} />
        </div>
        <p className="muted">{analysis.completeness}/100 · how much of the profile is determined and confident. Uncalibrated.</p>
      </div>
      {analysis.previous_analysis_id && (
        <>
          <h3>What changed since the previous analysis</h3>
          {changes.length === 0 ? <p className="muted">No dimension changed.</p> : (
            <ul>
              {changes.map(change => (
                <li key={change.dimension}>
                  <strong>{labels[change.dimension]}</strong>: {show(change.before)} → {show(change.after)}
                  {change.evidence && <span className="muted"> · {change.evidence}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
