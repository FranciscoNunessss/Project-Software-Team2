import type { Analysis } from './api'
import { AnalysisChanges } from './AnalysisChanges'
import { ProfileCard, RecommendationCard } from './AnalysisResult'
import { Button, Card, Eyebrow, Sheet } from './ui'
import './AnalysisDrawer.css'
import { TipsCard } from './TipsCard'
import { PromptCoachTips } from './PromptCoachTips'

// The chat's analysis panel (ADR-011): the same result the Assistant page shows, in a Sheet.
// Wide screens: a panel floating over the right of the chat, stopping above the message box.
// Narrow screens: a bottom sheet over the chat. Closed by its button, the backdrop or Escape.
/** The "Use recommended" state of the analysis shown (chat only, current draft only). */
export type UseRecommended = { state: 'available'; onUse: () => void } | { state: 'selected' | 'unavailable' | 'illustrative' }

export function AnalysisDrawer({ open, onClose, analysis, task, loading, stale, fromHistory, onSend, useRecommended, useSuggestion, error }: {
  useRecommended?: UseRecommended
  useSuggestion?: UseRecommended
  // The last analysis failed: said here, where the user is looking, with what to do.
  error?: string
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
  const title = loading ? 'Analysing…' : error && !analysis ? 'Analysis failed' : analysis ? (analysis.recommendation_provisional ? 'Provisional recommendation' : 'Recommendation') : 'No analysis yet'
  return (
    <Sheet open={open} onClose={onClose} label="Analysis" id="analysis-panel" closeLabel="Close analysis" panelProps={{ 'data-analysis-drawer': '' }}
      heading={<><Eyebrow>Analysis</Eyebrow><h2>{title}</h2></>}
      footer={onSend && <><p>Happy with the analysis?</p><Button onClick={onSend} data-drawer-send="">Send this message</Button></>}>
      {loading && <p className="drawer-loading" role="status"><span className="spinner" />Assessing complexity, risk and context…</p>}
      {!loading && error && <p className="api-error" role="alert" data-analysis-error="">The analysis failed: {error} Select <strong>Analyse</strong> to try again.</p>}
      {!loading && !analysis && !error && <p className="muted">Write a message and select <strong>Analyse</strong> to see how complete it is and which of your models fits it.</p>}
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
          <RecommendationCard analysis={analysis} useRecommended={useRecommended} useSuggestion={useSuggestion} />
          <TipsCard analysis={analysis} fromHistory={fromHistory} />
          {task !== undefined && <PromptCoachTips analysis={analysis} task={task} />}
          <ProfileCard analysis={analysis} />
          {analysis.warnings.map(warning => <p className="confidence-note" key={warning}>{warning}</p>)}
          <p className="muted">{analysis.mode} · {analysis.provider} · {analysis.latency_ms} ms · Policy {analysis.policy_version}</p>
        </>
      )}
    </Sheet>
  )
}
