import type { ReactNode } from 'react'
import type { UseRecommended } from './AnalysisDrawer'
import { Card } from './ui'
import { COST_BAND_LABELS, NEED_LABELS, STATUS_LABELS, fitPercent, isLegacy, tierOf, type Analysis, type Candidate, type Coverage } from './api'

// Result cards shared by the Assistant page and the chat's analysis panel.
export function Icon({
  name,
  size = 18,
}: {
  name: 'spark' | 'upload' | 'arrow' | 'check' | 'info' | 'book' | 'download' | 'trash' | 'eye' | 'users'
  size?: number
}) {
  const paths: Record<typeof name, ReactNode> = {
    spark: <path d="M12 2l1.35 4.65L18 8l-4.65 1.35L12 14l-1.35-4.65L6 8l4.65-1.35L12 2ZM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z" />,
    upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 15v4h14v-4" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" /></>,
    download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5" /><path d="M4 19h16" /></>,
    trash: <><path d="M4 7h16M9 3h6l1 4H8l1-4Zm-2 4 1 14h8l1-14M10 11v6m4-6v6" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="4" /><path d="M16 4.5a4 4 0 0 1 0 7.5m2 2.5a4 4 0 0 1 4 4V20" /></>,
  }
  const filled = name === 'spark'
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

export function ProfileCard({ analysis }: { analysis: Analysis }) {
  const profile = [
    { label: 'Reasoning depth', value: analysis.profile.reasoning },
    { label: 'Context demand', value: analysis.profile.context },
    { label: 'Ambiguity', value: analysis.profile.ambiguity },
    { label: 'Domain specificity', value: analysis.profile.domain },
    { label: 'Risk of error', value: analysis.profile.risk },
    { label: 'Tool / integration need', value: analysis.profile.tools },
  ]
  return (
    <Card className="profile-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Task analysis</p>
          <h2>Complexity profile</h2>
        </div>
        <span className="confidence confidence-low">
          {analysis.mode === 'demonstration' ? 'Heuristic demo' : 'Uncalibrated'}
        </span>
      </div>
      <div className="profile-list">
        {profile.map((item) => (
          <div className="profile-row" key={item.label}>
            <div className="profile-label">
              <span>{item.label}</span>
              <span className="info-tip" tabIndex={0} aria-label={`${item.label}: ${item.value.evidence}`}>
                <Icon name="info" size={14} />
                <span role="tooltip">{item.value.evidence}</span>
              </span>
            </div>
            {item.value.score === null ? <span className="muted">Not determined</span> : (
              <div className="bar-track" role="meter" aria-label={item.label} aria-valuemin={1} aria-valuemax={3} aria-valuenow={item.value.score} aria-valuetext={['Low', 'Medium', 'High'][item.value.score - 1]}>
                <span className="bar-fill" style={{ width: `${item.value.score / 3 * 100}%` }} />
              </div>
            )}
            <p className="muted">{item.value.score === null ? '' : `${['Low', 'Medium', 'High'][item.value.score - 1]} · `}Confidence: {item.value.confidence}</p>
            <p className="muted">{item.value.evidence}</p>
          </div>
        ))}
      </div>
      <p className="confidence-note">{analysis.profile.explanation}</p>
      <div className="profile-row">
        <strong>Required modalities</strong>
        <span>{analysis.profile.modality.required?.join(', ') ?? 'Not determined'}</span>
        <p className="muted">Confidence: {analysis.profile.modality.confidence}</p>
        <p className="muted">{analysis.profile.modality.evidence}</p>
      </div>
      <p className="muted">Scale: 1 low · 2 medium · 3 high. Modality describes execution requirements; this form accepts text only.</p>
      <p className="muted">Confidence labels are qualitative and uncalibrated.</p>
    </Card>
  )
}

function FitBars({ analysis }: { analysis: Analysis }) {
  const candidates = [analysis.recommendation, ...analysis.alternatives]
  if (candidates.every(candidate => fitPercent(candidate) === null)) return null
  return (
    <div className="fit-bars">
      <h3>Estimated fit per tier</h3>
      {([1, 2, 3] as const).map(capacity => {
        const candidate = candidates.find(item => item.capacity === capacity)
        const tier = capacity === 1 ? 'Small' : capacity === 2 ? 'Medium' : 'Large'
        const percent = candidate ? fitPercent(candidate) : null
        const recommended = candidate?.id === analysis.recommendation.id
        return (
          <div className={`fit-row${recommended ? ' recommended' : ''}${candidate ? '' : ' ineligible'}`} key={capacity}>
            <span>{tier}{recommended && <span className="sr-only"> (recommended)</span>}</span>
            <div className="fit-track" role="meter" aria-label={`${tier} estimated fit`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0} aria-valuetext={candidate ? `${percent}%` : 'Not eligible'}>
              <div className="fit-fill" style={{ width: `${percent ?? 0}%` }} />
            </div>
            <strong>{candidate ? `${percent}%` : 'N/A'}</strong>
          </div>
        )
      })}
      <p className="muted">Estimated fit — uncalibrated, not a probability</p>
    </div>
  )
}

function needText(entry: Coverage) {
  return entry.estimated === entry.top ? String(entry.top) : `${entry.estimated}–${entry.top}`
}

function costText(candidate: Candidate) {
  const parts = []
  if (candidate.cost_band) parts.push(COST_BAND_LABELS[candidate.cost_band])
  if (candidate.local) parts.push('local')
  else if (candidate.free) parts.push('free, rate-limited')
  if (candidate.illustrative) parts.push('illustrative')
  return parts.join(' · ')
}

function shortText(candidate: Candidate) {
  if (candidate.status === 'short') return `Falls short in ${(candidate.shortfalls ?? []).map(need => NEED_LABELS[need].toLowerCase()).join(', ')}`
  return STATUS_LABELS[candidate.status ?? 'short']
}

/** The recommended model, how it covers each need of the task, and the alternatives (ADR-014). */
function UseButton({ use }: { use?: UseRecommended }) {
  if (!use) return null
  if (use.state === 'available') return <button type="button" className="button button-primary use-recommended" onClick={use.onUse} data-use-recommended="">Use this model</button>
  const text = { selected: '✓ Selected for Send', unavailable: 'Not among your models', illustrative: 'Illustrative: not a real model' }[use.state]
  return <p className="use-recommended-state muted" data-use-recommended-state={use.state}>{text}</p>
}

export function ModelRecommendationCard({ analysis, useRecommended }: { analysis: Analysis; useRecommended?: UseRecommended }) {
  const best = analysis.recommendation
  const coverage = best.coverage ?? []
  return (
    <Card className="tier-card model-card">
      <p className="eyebrow">Recommended model</p>
      <div className="model-title-row">
        <div>
          <h2>{best.name}</h2>
          <p className="muted">{[best.label && best.label !== best.name ? best.label : null, costText(best)].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`status-pill status-${best.status}`}>{STATUS_LABELS[best.status ?? 'short']}</span>
      </div>
      <UseButton use={useRecommended} />
      {coverage.length > 0 && (
        <table className="coverage-table">
          <caption className="sr-only">How the recommended model covers each need of the task</caption>
          <thead><tr><th scope="col">Need</th><th scope="col">Task</th><th scope="col">Model</th><th scope="col">Covers</th></tr></thead>
          <tbody>
            {coverage.map(entry => (
              <tr key={entry.need} className={`coverage-${entry.state}`}>
                <th scope="row">{NEED_LABELS[entry.need]}</th>
                <td>{needText(entry)}</td>
                <td>{entry.capability ?? 'n/a'}{entry.provisional && <span className="provisional-mark" title="Not reviewed by the team yet"> *</span>}</td>
                <td>{entry.state === 'covers' ? 'Yes' : entry.state === 'covers_as_described' ? 'As described' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {coverage.some(entry => entry.provisional) && <p className="muted">{best.illustrative ? '* Illustrative level of a demo model, not a real measurement.' : '* Level from public benchmarks or the automatic measurement, not reviewed by the team yet.'}</p>}
      {best.levels_from && <p className="muted" data-levels-from="">Levels from: {best.levels_from}</p>}
      {analysis.assessment_model && <p className="muted" data-assessed-by="">Task assessed by {analysis.assessment_model} (the project's assessor; your chat model answers)</p>}
      {(analysis.notes ?? []).length > 0 && (
        <ul className="recommendation-notes">{(analysis.notes ?? []).map(note => <li key={note}>{note}</li>)}</ul>
      )}
      <div className="why">
        <h3>Why this model</h3>
        <p>{analysis.rationale}</p>
      </div>
      {analysis.alternatives.length > 0 && (
        <div className="alternatives">
          <h3>Other models you can use</h3>
          <ul>
            {analysis.alternatives.map(item => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>{shortText(item)}{item.status !== 'short' && item.gap === 1 ? ', more than needed' : ''}</span>
                <span className="muted">{costText(item)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

/** The recommendation card for any analysis: a model, or a tier for analyses stored before ADR-014. */
/** ADR-014 A12: one rated OpenRouter model the user does not have, that does this task better. */
function SuggestionCard({ analysis, use }: { analysis: Analysis; use?: UseRecommended }) {
  const item = analysis.suggestion!
  return <section className="openrouter-suggestion" data-openrouter-suggestion="">
    <p className="eyebrow">Also on OpenRouter</p>
    <p><strong>{item.name}</strong> {analysis.suggestion_reason}.</p>
    <p className="muted">{item.model}{item.cost_band ? ` · ${item.cost_band} cost` : ''}{item.levels_from ? ` · Levels from: ${item.levels_from}` : ''}</p>
    <UseButton use={use} />
  </section>
}

export function RecommendationCard({ analysis, useRecommended, useSuggestion }: { analysis: Analysis; useRecommended?: UseRecommended; useSuggestion?: UseRecommended }) {
  return isLegacy(analysis.recommendation) ? <TierCard analysis={analysis} /> : <>
    <ModelRecommendationCard analysis={analysis} useRecommended={useRecommended} />
    {analysis.suggestion && <SuggestionCard analysis={analysis} use={useSuggestion} />}
  </>
}

export function TierCard({ analysis }: { analysis: Analysis }) {
  const tier = tierOf(analysis.recommendation)
  return (
    <Card className="tier-card">
      <p className="eyebrow">Recommended tier</p>
      <div className="tier-title-row">
        <div className="tier-orb"><span>{tier.slice(0, 1)}</span></div>
        <div>
          <h2>{tier}</h2>
          <p className="muted">{analysis.recommendation.name}</p>
        </div>
      </div>
      <div className="cost-row">
        <span>Observed cost</span><strong>Unavailable</strong>
      </div>
      <FitBars analysis={analysis} />
      <div className="why">
        <h3>Why this tier</h3>
        <p>{analysis.rationale}</p>
        <p className="muted">Capabilities: {analysis.recommendation.capabilities.join(', ')}</p>
      </div>
    </Card>
  )
}

