import type { Coaching } from './coaching'

export function CoachingPanel({ coaching, analyses }: { coaching: Coaching; analyses: number }) {
  const { state, saved, error } = coaching
  const upToDate = !!saved && !saved.stale && !error
  const status = !state ? 'Loading suggestions…' : !state.automatic_enabled ? 'Automatic suggestions off' : !state.configured ? 'Provider unavailable' : state.generating ? 'Updating automatically…' : error ? 'Update unavailable' : !analyses ? 'Waiting for your first analysis' : upToDate ? 'Suggestions up to date' : 'Waiting for automatic update'
  return <section className="card personal-coaching" aria-labelledby="coaching-title">
    <div className="card-heading"><div><p className="eyebrow">Personalised learning</p><h2 id="coaching-title">Guidance from your history</h2></div><span className="period">Groq</span></div>
    <p>Groq writes your pattern insights, next steps and learning suggestions from up to 50 recent assessment profiles and model choices. Up to 5 saved conversation excerpts are included only with the text-saving and Use memory permissions in Profile. Saved preferences and provider keys are excluded.</p>
    <p className="muted">{!state ? 'Loading your settings…' : state.automatic_enabled ? 'New analyses and confirmed choices update your suggestions automatically. No action is needed here.' : 'Automatic updates are off. Enable Automatic learning suggestions in Profile to receive personalised suggestions.'}</p>
    {!analyses && <p className="muted">Your suggestions start automatically after your first successful analysis, when enabled in Profile.</p>}
    {state && !state.configured && <p className="api-error">Project Groq is not configured. Your dashboard and history remain available.</p>}
    {error && <p role="alert" className="api-error">{error}</p>}
    {saved && <div className={saved.stale ? 'coaching-report is-stale' : 'coaching-report'}><p className="eyebrow">{saved.stale ? 'Earlier AI guidance · update available' : 'AI guidance based on your saved history'} · {new Date(saved.updated_at).toLocaleString()}</p><p className="muted">Based on {saved.source?.assessments??'saved'} assessment profiles and {saved.source?.conversation_samples??0} opted-in conversation excerpts. Prompt analysis is provisional.</p><p>{saved.report.summary}</p></div>}
    <span className={`coaching-status${state?.automatic_enabled && upToDate && !state.generating ? ' is-current' : ''}`} role="status">{status}</span>
    <p className="muted">Automatic updates follow your Profile permissions and may use Groq quota. Saved suggestions are reused until history or permissions change.</p>
  </section>
}
