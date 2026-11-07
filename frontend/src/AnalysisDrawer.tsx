import { useEffect } from 'react'
import type { Analysis } from './api'
import { AnalysisChanges } from './AnalysisChanges'
import { Card, ProfileCard, RecommendationCard } from './AnalysisResult'
import { TipsCard } from './TipsCard'
import { PromptCoachTips } from './PromptCoachTips'

// The chat's analysis panel (ADR-011): the same result the Assistant page shows.
// Wide screens: a column docked beside the chat, which narrows to make room (never on top).
// Narrow screens: a bottom sheet over the lower part of the chat, closed by its button,
// the backdrop or Escape. The chat toolbar's "Analysis" button opens and closes it.
/** The "Use recommended" state of the analysis shown (chat only, current draft only). */
export type UseRecommended = { state: 'available'; onUse: () => void } | { state: 'selected' | 'unavailable' | 'illustrative' }

export function AnalysisDrawer({ open, onClose, analysis, task, loading, stale, fromHistory, onSend, useRecommended }: {
  useRecommended?: UseRecommended
  open: boolean
  onClose: () => void
  analysis: Analysis | null
  // The draft the analysis was made from; absent for an analysis of a sent message.
  task?: string
  loading: boolean
  stale: boolean
  fromHistory: boolean
  // Present when the analysis describes the current draft: the panel covers the composer's
  // Send button on most screens, so it offers its own.
  onSend?: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <aside className={`analysis-drawer${open ? ' open' : ''}`} aria-label="Analysis" id="analysis-panel">
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="drawer-panel" data-analysis-drawer="" aria-hidden={!open}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="drawer-head">
          <div>
            <p className="eyebrow">Analysis</p>
            <h2>{loading ? 'Analysing…' : analysis ? (analysis.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation') : 'No analysis yet'}</h2>
          </div>
          <button type="button" className="icon-button drawer-close" aria-label="Close analysis" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          {loading && <p className="drawer-loading" role="status"><span className="spinner" />Assessing complexity, risk and context…</p>}
          {!loading && !analysis && <p className="muted">Write a message and select <strong>Analyse</strong> to see how complete it is and which of your models fits it.</p>}
          {!loading && analysis && (
            <>
              {stale && <p className="drawer-stale" role="status">The message changed since this analysis. Analyse again to update it.</p>}
              <AnalysisChanges analysis={analysis} />
              {analysis.clarification_questions.length > 0 && (
                <Card className="assessment-advice">
                  <h3>Clarification suggested</h3>
                  <p>Add these details to your message and analyse it again.</p>
                  <ul>{analysis.clarification_questions.map(question => <li key={question}>{question}</li>)}</ul>
                </Card>
              )}
              {analysis.guidance.length > 0 && (
                <Card className="assessment-advice">
                  <h3>Assessment guidance</h3>
                  <ul>{analysis.guidance.map(item => <li key={item}>{item}</li>)}</ul>
                </Card>
              )}
              <RecommendationCard analysis={analysis} useRecommended={useRecommended} />
              <TipsCard analysis={analysis} fromHistory={fromHistory} />
              {task !== undefined && <PromptCoachTips analysis={analysis} task={task} />}
              <ProfileCard analysis={analysis} />
              {analysis.warnings.map(warning => <p className="confidence-note" key={warning}>{warning}</p>)}
              <p className="muted">{analysis.mode} · {analysis.provider} · {analysis.latency_ms} ms · Policy {analysis.policy_version}</p>
            </>
          )}
        </div>
        {onSend && (
          <div className="drawer-foot">
            <p>Happy with the analysis?</p>
            <button type="button" className="button button-primary" onClick={onSend} data-drawer-send="">Send this message</button>
          </div>
        )}
      </div>
    </aside>
  )
}
