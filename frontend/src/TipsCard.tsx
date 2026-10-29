import type { Analysis, DimensionName } from './api'

const LABELS: Record<DimensionName, string> = {
  reasoning: 'Reasoning',
  context: 'Context',
  ambiguity: 'Ambiguity',
  domain: 'Domain',
  risk: 'Risk',
  tools: 'Tools',
  modality: 'Modality',
}

// Tips come from the active rubric (AA-019). Clarification questions are listed in the
// "Clarification suggested" card above the results, so this card only points to them.
export function TipsCard({ analysis, fromHistory = false }: { analysis: Analysis; fromHistory?: boolean }) {
  const tips = analysis.tips ?? []
  const questions = analysis.clarification_questions.length
  return (
    <section className="card tips-card">
      <p className="eyebrow">Practical guidance</p>
      <h2>Improve your request</h2>
      <div className="tips-list">
        {questions > 0 ? (
          <div className="tip">
            <span className="tip-number">01</span>
            <div>
              <h3>Clarify first</h3>
              <p>
                Answer the {questions === 1 ? 'clarification question' : `${questions} clarification questions`} above
                and analyse the task again; tips for each dimension follow once the task is clear.
              </p>
            </div>
          </div>
        ) : tips.length === 0 ? (
          <div className="tip">
            <div><p>{fromHistory ? 'Tips are not kept in history; analyse again to see them.' : 'No tips for this analysis.'}</p></div>
          </div>
        ) : (
          tips.map((tip, index) => (
            <div className="tip" key={`${tip.dimension ?? 'general'}-${index}`}>
              <span className="tip-number">0{index + 1}</span>
              <div>
                <h3>{tip.dimension ? LABELS[tip.dimension] : 'General'}</h3>
                <p>{tip.text}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
