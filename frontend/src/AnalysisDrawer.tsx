import type { Analysis } from './api'
import { AnalysisChanges } from './AnalysisChanges'
import { Card, ProfileCard, TierCard } from './AnalysisResult'
import { TipsCard } from './TipsCard'
import { PromptCoachTips } from './PromptCoachTips'

// The chat's analysis panel (ADR-011): the same result the Assistant page shows, in a
// sidebar on the right that the user opens and closes.
export function AnalysisDrawer({ analysis, task, loading, stale, fromHistory, onClose }: {
  analysis: Analysis | null
  // The draft the analysis was made from; absent for an analysis of a sent message.
  task?: string
  loading: boolean
  stale: boolean
  fromHistory: boolean
  onClose: () => void
}) {
  return (
    <aside className="analysis-drawer" aria-label="Analysis" data-analysis-drawer="">
      <div className="drawer-head">
        <div>
          <p className="eyebrow">Analysis</p>
          <h2>{analysis ? (analysis.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation') : 'No analysis yet'}</h2>
        </div>
        <button type="button" className="coach-x" aria-label="Close analysis" onClick={onClose}>×</button>
      </div>
      <div className="drawer-body">
        {loading && <p className="loading-label"><span className="spinner" />Assessing complexity, risk and context…</p>}
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
    </aside>
  )
}
