import { useRef } from 'react'
import type { Analysis } from './api'
import { AnalysisChanges } from './AnalysisChanges'
import { Card, ProfileCard, TierCard } from './AnalysisResult'
import { TipsCard } from './TipsCard'
import { PromptCoachTips } from './PromptCoachTips'

// The chat's analysis panel (ADR-011): the same result the Assistant page shows, in a panel
// that slides in from the right. Its tab, on the panel's left edge, is part of the panel: it
// stays visible when the panel is closed, widens on hover to say what it does, and opens or
// closes the panel on click (or when dragged left or right).
export function AnalysisDrawer({ open, onToggle, analysis, task, loading, stale, fromHistory }: {
  open: boolean
  onToggle: (open: boolean) => void
  analysis: Analysis | null
  // The draft the analysis was made from; absent for an analysis of a sent message.
  task?: string
  loading: boolean
  stale: boolean
  fromHistory: boolean
}) {
  const start = useRef<number | null>(null)
  const dragged = useRef(false)
  const label = open ? 'Hide analysis' : 'Show analysis'
  return (
    <aside className={`analysis-drawer${open ? ' open' : ''}`} aria-label="Analysis">
      <button type="button" className="drawer-tab" aria-label={label} aria-expanded={open} data-analysis-toggle=""
        onPointerDown={event => { start.current = event.clientX; dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerUp={event => {
          if (start.current === null) return
          const moved = event.clientX - start.current
          start.current = null
          if (Math.abs(moved) > 24) { dragged.current = true; onToggle(moved < 0) }
        }}
        onClick={() => { if (dragged.current) { dragged.current = false; return } onToggle(!open) }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
        </svg>
        <span className="drawer-tab-label">{label}</span>
      </button>
      <div className="drawer-panel" data-analysis-drawer="" aria-hidden={!open}>
        <div className="drawer-head">
          <p className="eyebrow">Analysis</p>
          <h2>{loading ? 'Analysing…' : analysis ? (analysis.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation') : 'No analysis yet'}</h2>
        </div>
        <div className="drawer-body">
          {loading && <p className="drawer-loading" role="status"><span className="spinner" />Assessing complexity, risk and context…</p>}
          {!loading && !analysis && <p className="muted">Write a message and select <strong>Analyse</strong> to see how complete it is and which model tier fits it.</p>}
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
              <TierCard analysis={analysis} />
              <TipsCard analysis={analysis} fromHistory={fromHistory} />
              {task !== undefined && <PromptCoachTips analysis={analysis} task={task} />}
              <ProfileCard analysis={analysis} />
              {analysis.warnings.map(warning => <p className="confidence-note" key={warning}>{warning}</p>)}
              <p className="muted">{analysis.mode} · {analysis.provider} · {analysis.latency_ms} ms · Policy {analysis.policy_version}</p>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
