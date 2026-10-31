import { useEffect, useRef, useState } from 'react'
import { getFeatures, promptCoach, type Analysis, type CoachResponse, type DimensionName } from './api'

// Optional Prompt Coach module (ADR-009, AA-019 B3). App.tsx mounts this component in one
// line; deleting it (and that line) leaves the deterministic tips in TipsCard untouched.
// The Coach is only ever called when the user selects the button; never automatically.

const LABELS: Record<DimensionName, string> = {
  reasoning: 'Reasoning',
  context: 'Context',
  ambiguity: 'Ambiguity',
  domain: 'Domain',
  risk: 'Risk',
  tools: 'Tools',
  modality: 'Modality',
}

type CoachState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; response: CoachResponse }
  | { kind: 'error'; message: string }

export function PromptCoachTips({ analysis, task }: { analysis: Analysis; task: string }) {
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<CoachState>({ kind: 'idle' })
  const active = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getFeatures(controller.signal)
      .then(features => { if (!controller.signal.aborted) setEnabled(features.prompt_coach === true) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(false) })
    return () => controller.abort()
  }, [])

  // The text this analysis was made from: the Coach only works on that exact text, because
  // its suggestions refer to this analysis's dimensions.
  const [analysedTask, setAnalysedTask] = useState(task)

  // A new analysis invalidates any earlier Coach result or in-flight request.
  useEffect(() => {
    setState({ kind: 'idle' })
    setAnalysedTask(task)
    return () => { active.current?.abort(); active.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the analysis changes
  }, [analysis.id])

  // The Coach needs the analysed task text and the tips. A reopened analysis has the text only
  // when its conversation was saved with the user's consent (PR #12); history stores tips as an
  // empty list, so the empty task is what hides the card. Edited text needs a new analysis.
  const current = Array.isArray(analysis.tips) && task.trim().length > 0 && task === analysedTask
  if (!enabled || !current) return null

  const local = analysis.provider === 'demo'
  const destination = analysis.assessment_model ? `${analysis.provider} · ${analysis.assessment_model}` : analysis.provider

  const improve = async () => {
    const controller = new AbortController()
    active.current?.abort()
    active.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 45000)
    setState({ kind: 'loading' })
    try {
      // Same consent as Analyse: the notice names the destination and selecting the button confirms it.
      const response = await promptCoach(
        { analysis_id: analysis.id, task, mode: 'tips', allow_external: !local },
        controller.signal,
      )
      if (active.current === controller) setState({ kind: 'result', response })
    } catch (failure) {
      if (active.current !== controller) return
      const message = controller.signal.aborted
        ? 'Prompt Coach timed out. Please retry.'
        : failure instanceof Error ? failure.message : 'Prompt Coach failed'
      setState({ kind: 'error', message: `${message} The tips above still apply.` })
    } finally {
      window.clearTimeout(timeout)
      if (active.current === controller) active.current = null
    }
  }

  return (
    <section className="card assessment-advice prompt-coach" aria-labelledby="prompt-coach-title" data-prompt-coach>
      <p className="eyebrow">Optional</p>
      <h3 id="prompt-coach-title">Prompt Coach</h3>
      {local ? (
        <p className="processing-notice">Selecting <strong>Improve with Prompt Coach</strong> uses the demonstration coach; the task text does not leave AdaptAI.</p>
      ) : (
        <p className="processing-notice">Selecting <strong>Improve with Prompt Coach</strong> sends this task to <strong>{destination}</strong>. The Prompt Coach never saves the task it receives or its suggestions.</p>
      )}
      <button type="button" className="button button-secondary" data-prompt-coach-button disabled={state.kind === 'loading'} onClick={improve}>
        {state.kind === 'loading' ? 'Asking Prompt Coach…' : 'Improve with Prompt Coach'}
      </button>
      {state.kind === 'error' && <p className="api-error" role="alert">{state.message}</p>}
      {state.kind === 'result' && (
        <div className="tips-list" aria-live="polite">
          {state.response.status === 'nothing_to_improve' ? (
            <div className="tip"><div><p>Nothing to improve: every dimension of this analysis is already clear.</p></div></div>
          ) : (
            state.response.suggestions.map((suggestion, index) => (
              <div className="tip" key={`${suggestion.dimension}-${index}`}>
                <span className="tip-number">{LABELS[suggestion.dimension] ?? suggestion.dimension}</span>
                <div>
                  <h3>{suggestion.title}</h3>
                  <p>{suggestion.rationale}</p>
                </div>
              </div>
            ))
          )}
          {state.response.fallback && <p className="muted">Fallback: the model was unavailable or its output was unusable, so these are standard questions from the rubric.</p>}
        </div>
      )}
    </section>
  )
}
