import { useEffect, useState } from 'react'
import { getChatSettings, getFeatures, setChatSettings } from './api'
import './Profile.css'

// "Always analyse before sending" (ADR-011, D4; FR-16): the user's switch in Profile, off by
// default. Shown only when the chat module is installed on the server.
export function AlwaysAnalyseToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    getFeatures(controller.signal)
      .then(features => features.chat ? getChatSettings(controller.signal).then(settings => settings.auto_analyse) : null)
      .then(value => { if (!controller.signal.aborted) setEnabled(value) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(null) })
    return () => controller.abort()
  }, [])

  if (enabled === null) return null
  const change = async (next: boolean) => {
    setBusy(true); setError('')
    try { setEnabled((await setChatSettings({ auto_analyse: next })).auto_analyse) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the setting') }
    finally { setBusy(false) }
  }

  return (
    <section className="card profile-card-settings" data-always-analyse-settings>
      <p className="eyebrow">Chat</p><h2>Analysis before sending</h2>
      <label className="settings-switch"><span><strong>Always analyse before sending</strong><small>Send first analyses the message, then sends it with that analysis attached, so every message shows its recommended model. Each analysed message uses one analysis as well as the answer.</small></span>
        <input type="checkbox" role="switch" aria-label="Always analyse before sending" checked={enabled} disabled={busy} onChange={event => void change(event.target.checked)} /></label>
      <p className="muted">Off: Analyse and Send stay separate buttons, and a message is analysed only when you ask.</p>
      {error && <p className="api-error" role="alert">{error}</p>}
    </section>
  )
}
