import { useEffect, useState } from 'react'
import { getCoachSettings, getFeatures, setCoachSettings } from './api'
import './Profile.css'

// Optional Prompt Coach module (ADR-009): the user's on/off switch in Profile. Shown only when
// the module is installed on the server; Profile.tsx mounts it in one line.
export function PromptCoachToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    getFeatures(controller.signal)
      .then(features => features.prompt_coach ? getCoachSettings(controller.signal).then(settings => settings.enabled) : null)
      .then(value => { if (!controller.signal.aborted) setEnabled(value) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(null) })
    return () => controller.abort()
  }, [])

  if (enabled === null) return null
  const change = async (next: boolean) => {
    setBusy(true); setError('')
    try { setEnabled((await setCoachSettings({ enabled: next })).enabled) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the setting') }
    finally { setBusy(false) }
  }

  return (
    <section className="card profile-card-settings" data-prompt-coach-settings>
      <p className="eyebrow">Optional</p><h2>Prompt Coach</h2>
      <label className="settings-switch"><span><strong>Use the Prompt Coach</strong><small>Shows a bubble on the task field that counts what the last analysis left uncertain and, only when you ask, suggests how to describe the task better. Each request sends the task to the model of that analysis; the Prompt Coach never saves the task or its suggestions.</small></span>
        <input type="checkbox" role="switch" aria-label="Use the Prompt Coach" checked={enabled} disabled={busy} onChange={event => void change(event.target.checked)} /></label>
      <p className="muted">Off: the bubble only runs quick checks on your text (very short text, emails, phone numbers) and nothing is sent.</p>
      {error && <p className="api-error" role="alert">{error}</p>}
    </section>
  )
}
