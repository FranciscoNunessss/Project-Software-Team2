import { useEffect, useState } from 'react'
import { api } from './api'
import { DIMENSION_LABELS, Radar } from './MyLearning'
import { Button, Card } from './ui'

// Team Scope (WS3 T3, ADR-016): the member view with consent, and the policy and comparison
// screens' shared pieces. The member reads the same component their managers read.

type MemberViewData = {
  tasks: number
  overall_level: number | null
  dimensions: Record<string, { level: number | null; tasks: number; confidence: 'high' | 'medium' | 'low' | null }>
  patterns: { code: string; kind: 'improve' | 'positive'; hits: number; window: number; dimension: string | null; caveat: string | null }[]
}
type Consent = { enabled: boolean; consented: boolean; granted_at: number | null }
type Shared = { enabled: boolean; members: { user_id: string; email: string }[] }

const LEVEL_NAMES = ['', 'Starting', 'Developing', 'Proficient', 'Expert']
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback

// Neutral wording: the member and the manager read the same sentences.
function patternLine(p: MemberViewData['patterns'][number]): string {
  const dimension = (DIMENSION_LABELS[p.dimension ?? ''] ?? p.dimension ?? '').toLowerCase()
  const of = `${p.hits} of the last ${p.window}`
  switch (p.code) {
    case 'missing_dimension': return `Left out ${dimension} in ${of} tasks where it mattered.`
    case 'improving_dimension': return `Improved in ${dimension}.`
    case 'over_sizing': return `Chose a bigger model than recommended, and it worked, in ${of} tasks (a possible saving, not a proven one).`
    case 'under_sizing': return `Chose a smaller model than recommended and did not solve the task in ${of} tasks.` + (p.caveat === 'model_or_request' ? ' The description of the task may also have played a part.' : '')
    case 'good_model_choice': return `Followed the recommendation and solved the task in ${of} tasks.`
    case 'coach_ignored': return `Turned down the Coach's rewrite in ${of} tasks with at least 2 gaps.`
    case 'coach_pays_off': return `Accepting the Coach's rewrite went together with solving more tasks (a correlation, not proof).`
    case 'long_chats': return `${of} solved chats needed more than twice the usual number of answers.`
    case 'model_switching': return `Switched model in the middle of the chat in ${of} chats.`
    default: return p.code
  }
}

export function MemberViewPanel({ path }: { path: string }) {
  const [data, setData] = useState<MemberViewData>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setData(undefined); setError('')
    api<MemberViewData>(path, undefined, controller.signal).then(setData)
      .catch(failure => { if (!controller.signal.aborted) setError(message(failure, 'Could not load this view')) })
    return () => controller.abort()
  }, [path])
  if (error) return <p className="api-error" role="alert">{error}</p>
  if (!data) return <div className="spinner" aria-label="Loading" />
  const radar = Object.fromEntries(Object.entries(data.dimensions).map(([name, item]) => [name, { ...item, level_raw: item.level, confidence_reasons: [] }]))
  return <div data-member-view="">
    <p className="muted">{data.tasks} counted task{data.tasks === 1 ? '' : 's'} · level {data.overall_level ? LEVEL_NAMES[data.overall_level] : 'not available yet'}</p>
    <div className="team-member-body">
      <Radar dimensions={radar} />
      <table className="team-table">
        <caption className="visually-hidden">Level on each dimension</caption>
        <thead><tr><th scope="col">Dimension</th><th scope="col">Level</th><th scope="col">Based on</th></tr></thead>
        <tbody>{Object.keys(DIMENSION_LABELS).map(name => <tr key={name}>
          <th scope="row">{DIMENSION_LABELS[name]}</th>
          <td>{data.dimensions[name]?.level ? LEVEL_NAMES[data.dimensions[name].level as number] : '—'}</td>
          <td>{data.dimensions[name]?.tasks ? `${data.dimensions[name].tasks} tasks` : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {data.patterns.length > 0
      ? <ul className="team-patterns">{data.patterns.map(p => <li key={`${p.code}-${p.dimension}`}>{p.kind === 'improve' ? 'To work on: ' : 'Going well: '}{patternLine(p)}</li>)}</ul>
      : <p className="muted">No patterns yet.</p>}
  </div>
}

/** A member's switch for one group, with the exact view their managers get. */
export function SharingScreen({ group, onBack }: { group: { id: string; name: string }; onBack: () => void }) {
  const [consent, setConsent] = useState<Consent>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<Consent>(`groups/${group.id}/consent`, undefined, controller.signal).then(setConsent)
      .catch(failure => { if (!controller.signal.aborted) setError(message(failure, 'Could not load your sharing setting')) })
    return () => controller.abort()
  }, [group.id])
  const change = async (consented: boolean) => {
    setBusy(true); setError('')
    try { setConsent(await api<Consent>(`groups/${group.id}/consent`, { consented }, undefined, 'PUT')) }
    catch (failure) { setError(message(failure, 'Could not change your sharing setting')) }
    finally { setBusy(false) }
  }
  return <main className="page team-page">
    <Button variant="ghost" size="sm" onClick={onBack}>← Teams</Button>
    <div className="intro"><div>
      <p className="eyebrow">Sharing</p>
      <h1>{group.name}</h1>
      <p>You decide whether the managers of this group see your levels, radar and patterns. They never see your tasks or anything you wrote. Off unless you turn it on; turning it off hides it at once.</p>
    </div></div>
    {error && <p className="api-error" role="alert">{error}</p>}
    {consent && !consent.enabled && <Card className="team-card"><p>The individual view is not switched on in this version: managers see group totals only.</p></Card>}
    {consent && (consent.enabled || consent.consented) && <Card className="team-card">
      <label className="team-check"><input type="checkbox" checked={consent.consented} disabled={busy} onChange={event => void change(event.target.checked)} data-consent="" /> Share my learning with the managers of {group.name}</label>
      <p className="muted" role="status">{consent.consented && consent.granted_at ? `Shared since ${new Date(consent.granted_at * 1000).toLocaleDateString()}.` : 'Not shared. Managers cannot see you individually.'}</p>
    </Card>}
    {consent?.enabled && <Card className="team-card">
      <h2>{consent.consented ? 'What your managers see' : 'What your managers would see'}</h2>
      <MemberViewPanel path={`groups/${group.id}/consent/view`} />
    </Card>}
  </main>
}

/** On the manager's dashboard: only the members who opted in. */
export function SharedMembers({ groupId }: { groupId: string }) {
  const [data, setData] = useState<Shared>()
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api<Shared>(`groups/${groupId}/member-views`, undefined, controller.signal).then(setData).catch(() => undefined)
    return () => controller.abort()
  }, [groupId])
  if (!data?.enabled) return null
  return <section data-shared-members="">
    <div className="section-heading"><h2>Members who share their learning</h2></div>
    <Card className="team-card">
      {data.members.length === 0 ? <p className="muted">Nobody has opted in. Each member decides from their own Team page.</p> :
        <ul className="team-groups">{data.members.map(member => <li key={member.user_id}>
          <div className="team-group-line">
            <div><strong>{member.email}</strong></div>
            <Button size="sm" variant="secondary" aria-expanded={open === member.user_id} onClick={() => setOpen(open === member.user_id ? null : member.user_id)}>{open === member.user_id ? 'Hide' : 'View'}</Button>
          </div>
          {open === member.user_id && <MemberViewPanel path={`groups/${groupId}/member-views/${member.user_id}`} />}
        </li>)}</ul>}
    </Card>
  </section>
}
