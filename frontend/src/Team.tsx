import { useEffect, useState, type FormEvent } from 'react'
import { api } from './api'
import { Button, Card } from './ui'
import { TeamOverview } from './TeamOverview'
import { SharedMembers, SharingScreen } from './TeamSharing'
import { euros, percent, tokens, type Figures } from './teamFigures'
import './Team.css'

// Team Scope (WS3, ADR-016): organisations, groups, invites, the group dashboard, the comparison
// of groups (T4), the member view with consent (T3) and the learning policy (T1b).
// Managers and admins see group aggregates, and individually only the members who opted in.

type Role = 'admin' | 'manager' | 'member'
type Group = { id: string; name: string; role: Role; size: number | null; member?: boolean }
type Organisation = { id: string; name: string; demo: boolean; role: 'admin' | 'member'; allow_pause: boolean; allow_reset: boolean; groups: Group[] }
type Member = { user_id: string; email: string; role: 'manager' | 'member'; joined_at: number }
type PendingInvite = { id: string; email: string | null; role: string; expires_at: number }
type Week = { week: string; open: boolean; enough_members: boolean } & Partial<Figures>
type Dashboard = {
  group: { id: string; name: string }; source: string; min_group_size: number; enough_members: boolean
  weeks: Week[]; totals: Figures | null; price_catalog_date: string | null
}

const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback

// An invite link opens the app with ?invite=…. The token is taken from the address once and its
// acceptance is shared, so a second mount (React StrictMode, or the page remounting) waits for it
// instead of loading the teams before the new membership exists.
type InviteResult = { joined: { group: string; role: string } } | { failure: string }
let pendingInvite: Promise<InviteResult> | null = null

function inviteFromAddress(): Promise<InviteResult> | null {
  const url = new URL(window.location.href)
  const token = url.searchParams.get('invite')
  if (token) {
    url.searchParams.delete('invite')
    window.history.replaceState(null, '', url.toString())
    pendingInvite = api<{ group: string; role: string }>('invites/accept', { token })
      .then(joined => ({ joined }), failure => ({ failure: message(failure, 'Could not accept the invite') }))
  }
  return pendingInvite
}

export function TeamScreen() {
  const [organisations, setOrganisations] = useState<Organisation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<{ group: Group; view: 'dashboard' | 'members' | 'sharing' } | null>(null)
  const [comparing, setComparing] = useState(false)
  const [orgName, setOrgName] = useState('')

  const load = async (signal?: AbortSignal) => setOrganisations(await api<Organisation[]>('organisations', undefined, signal))

  useEffect(() => {
    const controller = new AbortController()
    const run = async () => {
      const invite = inviteFromAddress()
      if (invite) {
        const result = await invite
        if (controller.signal.aborted) return
        pendingInvite = null
        if ('joined' in result) setNotice(`You joined ${result.joined.group} as ${result.joined.role}.`)
        else setError(result.failure)
      }
      await load(controller.signal)
    }
    run().catch(failure => { if (!controller.signal.aborted) setError(message(failure, 'Could not load your teams')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  const createOrganisation = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('')
    try { await api('organisations', { name: orgName }); setOrgName(''); await load() }
    catch (failure) { setError(message(failure, 'Could not create the organisation')) }
  }

  const managed = organisations.flatMap(organisation => organisation.groups).filter(group => group.role === 'admin' || group.role === 'manager')
  if (comparing) return <TeamOverview onBack={() => setComparing(false)} />
  if (open?.view === 'sharing') return <SharingScreen group={open.group} onBack={() => setOpen(null)} />
  if (open?.view === 'dashboard') return <GroupDashboard group={open.group} onBack={() => setOpen(null)} />
  if (open?.view === 'members') return <GroupMembers group={open.group} onBack={() => { setOpen(null); load().catch(() => undefined) }} />

  return <main className="page team-page">
    <div className="intro"><div>
      <p className="eyebrow">Team Scope</p>
      <h1>Your teams.</h1>
      <p>Groups, invites and how each group uses AI. Managers see group totals, and a person only when they opt in; never what anyone wrote.</p>
    </div>
      {managed.length > 1 && <Button variant="secondary" onClick={() => setComparing(true)}>Compare groups</Button>}
    </div>
    {error && <p className="api-error" role="alert">{error}</p>}
    {notice && <p className="team-notice" role="status">{notice}</p>}
    {loading ? <div className="spinner" aria-label="Loading" /> : <>
      {organisations.map(organisation => <OrganisationCard key={organisation.id} organisation={organisation}
        onChanged={() => load().catch(failure => setError(message(failure, 'Could not reload')))}
        onOpen={(group, view) => setOpen({ group, view })} onError={setError} />)}
      <Card className="team-card">
        <h2>{organisations.length ? 'Another organisation' : 'Start an organisation'}</h2>
        <p className="muted">You become its admin: you create groups and invite people.</p>
        <form className="team-inline-form" onSubmit={createOrganisation}>
          <label className="visually-hidden" htmlFor="org-name">Organisation name</label>
          <input id="org-name" value={orgName} maxLength={60} placeholder="Organisation name" onChange={event => setOrgName(event.target.value)} />
          <Button type="submit" disabled={!orgName.trim()}>Create</Button>
        </form>
      </Card>
    </>}
  </main>
}

function OrganisationCard({ organisation, onChanged, onOpen, onError }: {
  organisation: Organisation
  onChanged: () => void
  onOpen: (group: Group, view: 'dashboard' | 'members' | 'sharing') => void
  onError: (text: string) => void
}) {
  const admin = organisation.role === 'admin'
  const [name, setName] = useState('')
  const [inviting, setInviting] = useState<string | null>(null)
  const [link, setLink] = useState<{ group: string; url: string } | null>(null)
  const [role, setRole] = useState<'member' | 'manager'>('member')
  const [email, setEmail] = useState('')

  const createGroup = async (event: FormEvent) => {
    event.preventDefault()
    try { await api(`organisations/${organisation.id}/groups`, { name }); setName(''); onChanged() }
    catch (failure) { onError(message(failure, 'Could not create the group')) }
  }
  const invite = async (event: FormEvent, group: Group) => {
    event.preventDefault()
    try {
      const created = await api<{ token: string }>(`groups/${group.id}/invites`, { role, ...(email.trim() ? { email: email.trim() } : {}) })
      const url = new URL(window.location.href)
      url.search = `?invite=${encodeURIComponent(created.token)}`
      setLink({ group: group.id, url: url.toString() }); setInviting(null); setEmail('')
    } catch (failure) { onError(message(failure, 'Could not create the invite')) }
  }
  const setPolicy = async (policy: { allow_pause: boolean; allow_reset: boolean }) => {
    try { await api(`organisations/${organisation.id}/learning-policy`, policy, undefined, 'PUT'); onChanged() }
    catch (failure) { onError(message(failure, 'Could not change the policy')) }
  }
  const leave = async (group: Group) => {
    if (!window.confirm(`Leave ${group.name}?`)) return
    try {
      const me = await api<{ id: string }>('auth/me')
      await api(`groups/${group.id}/members/${me.id}`, undefined, undefined, 'DELETE'); onChanged()
    } catch (failure) { onError(message(failure, 'Could not leave the group')) }
  }

  return <Card className="team-card">
    <div className="team-card-head">
      <h2>{organisation.name}</h2>
      <span className="team-role">{organisation.demo ? 'Demo · ' : ''}{admin ? 'Admin' : 'Member'}</span>
    </div>
    {organisation.groups.length === 0 && <p className="muted">{admin ? 'No groups yet.' : 'You are in no group of this organisation.'}</p>}
    <ul className="team-groups">
      {organisation.groups.map(group => <li key={group.id}>
        <div className="team-group-line">
          <div><strong>{group.name}</strong><span className="muted">{group.role === 'admin' ? 'You run this organisation' : group.role === 'manager' ? 'Manager' : 'Member'}{group.size !== null ? ` · ${group.size} member${group.size === 1 ? '' : 's'}` : ''}</span></div>
          <div className="team-actions">
            {(group.role === 'admin' || group.role === 'manager') && <Button size="sm" onClick={() => onOpen(group, 'dashboard')}>Dashboard</Button>}
            {group.role === 'admin' && <Button size="sm" variant="secondary" onClick={() => onOpen(group, 'members')}>Members</Button>}
            {group.role === 'admin' && <Button size="sm" variant="secondary" onClick={() => { setInviting(inviting === group.id ? null : group.id); setLink(null) }}>Invite</Button>}
            {(group.member ?? group.role !== 'admin') && <Button size="sm" variant="secondary" onClick={() => onOpen(group, 'sharing')}>Sharing</Button>}
            {group.role !== 'admin' && <Button size="sm" variant="ghost" onClick={() => void leave(group)}>Leave</Button>}
          </div>
        </div>
        {inviting === group.id && <form className="team-inline-form" onSubmit={event => void invite(event, group)}>
          <label>Role <select value={role} onChange={event => setRole(event.target.value as 'member' | 'manager')}><option value="member">Member</option><option value="manager">Manager</option></select></label>
          <label className="visually-hidden" htmlFor={`invite-email-${group.id}`}>Only for this email (optional)</label>
          <input id={`invite-email-${group.id}`} type="email" value={email} placeholder="Only for this email (optional)" onChange={event => setEmail(event.target.value)} />
          <Button type="submit" size="sm">Create link</Button>
        </form>}
        {link?.group === group.id && <div className="team-link">
          <p>Share this link. It works once, expires in 7 days and is shown only now.</p>
          <code>{link.url}</code>
          <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link.url)}>Copy</Button>
        </div>}
      </li>)}
    </ul>
    {admin && <form className="team-inline-form" onSubmit={createGroup}>
      <label className="visually-hidden" htmlFor={`group-name-${organisation.id}`}>New group name</label>
      <input id={`group-name-${organisation.id}`} value={name} maxLength={60} placeholder="New group name" onChange={event => setName(event.target.value)} />
      <Button type="submit" size="sm" variant="secondary" disabled={!name.trim()}>Add group</Button>
    </form>}
    {admin && <fieldset className="team-policy">
      <legend>Learning controls for people in these groups</legend>
      <label className="team-check"><input type="checkbox" checked={organisation.allow_pause} onChange={event => void setPolicy({ allow_pause: event.target.checked, allow_reset: organisation.allow_reset })} data-policy-pause="" /> They can pause learning</label>
      <label className="team-check"><input type="checkbox" checked={organisation.allow_reset} onChange={event => void setPolicy({ allow_pause: organisation.allow_pause, allow_reset: event.target.checked })} data-policy-reset="" /> They can start over</label>
    </fieldset>}
  </Card>
}

function GroupMembers({ group, onBack }: { group: Group; onBack: () => void }) {
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<PendingInvite[]>([])
  const [error, setError] = useState('')
  const load = async (signal?: AbortSignal) => {
    const body = await api<{ members: Member[]; invites: PendingInvite[] }>(`groups/${group.id}/members`, undefined, signal)
    setMembers(body.members); setInvites(body.invites)
  }
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(message(failure, 'Could not load the members')) })
    return () => controller.abort()
  }, [group.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (member: Member) => {
    if (!window.confirm(`Remove ${member.email} from ${group.name}? Their data leaves the group's totals from now on.`)) return
    try { await api(`groups/${group.id}/members/${member.user_id}`, undefined, undefined, 'DELETE'); await load() }
    catch (failure) { setError(message(failure, 'Could not remove the member')) }
  }
  const revoke = async (invite: PendingInvite) => {
    try { await api(`groups/${group.id}/invites/${invite.id}`, undefined, undefined, 'DELETE'); await load() }
    catch (failure) { setError(message(failure, 'Could not revoke the invite')) }
  }
  return <main className="page team-page">
    <Button variant="ghost" size="sm" onClick={onBack}>← Teams</Button>
    <div className="intro"><div><p className="eyebrow">Members</p><h1>{group.name}</h1></div></div>
    {error && <p className="api-error" role="alert">{error}</p>}
    <Card className="team-card">
      {members.length === 0 ? <p className="muted">Nobody yet. Create an invite link from Teams.</p> :
        <ul className="team-groups">{members.map(member => <li key={member.user_id}><div className="team-group-line">
          <div><strong>{member.email}</strong><span className="muted">{member.role === 'manager' ? 'Manager' : 'Member'}</span></div>
          <Button size="sm" variant="danger" onClick={() => void remove(member)}>Remove</Button>
        </div></li>)}</ul>}
    </Card>
    {invites.length > 0 && <Card className="team-card"><h2>Open invites</h2>
      <ul className="team-groups">{invites.map(invite => <li key={invite.id}><div className="team-group-line">
        <div><strong>{invite.email ?? 'Anyone with the link'}</strong><span className="muted">{invite.role} · expires {new Date(invite.expires_at * 1000).toLocaleDateString()}</span></div>
        <Button size="sm" variant="secondary" onClick={() => void revoke(invite)}>Revoke</Button>
      </div></li>)}</ul>
    </Card>}
  </main>
}

function GroupDashboard({ group, onBack }: { group: Group; onBack: () => void }) {
  const [weeks, setWeeks] = useState(4)
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api<Dashboard>(`groups/${group.id}/dashboard?weeks=${weeks}`, undefined, controller.signal).then(setData)
      .catch(failure => { if (!controller.signal.aborted) setError(message(failure, 'Could not load the dashboard')) })
    return () => controller.abort()
  }, [group.id, weeks])
  const totals = data?.totals
  return <main className="page team-page">
    <Button variant="ghost" size="sm" onClick={onBack}>← Teams</Button>
    <div className="intro"><div>
      <p className="eyebrow">Group dashboard</p>
      <h1>{group.name}</h1>
      <p>Totals for the group, by week. A week with fewer than {data?.min_group_size ?? 5} people using AdaptAI shows no numbers, so nobody can be singled out.</p>
    </div>
      <label className="period">Period <select value={weeks} onChange={event => setWeeks(Number(event.target.value))}>
        <option value={4}>Last 4 weeks</option><option value={8}>Last 8 weeks</option><option value={12}>Last 12 weeks</option>
      </select></label>
    </div>
    {error && <p className="api-error" role="alert">{error}</p>}
    {data?.source === 'mock' && <p className="team-mock" role="note">Demo data: these numbers are synthetic until real usage records arrive (WS1 gateway).</p>}
    {data && !data.enough_members && <Card className="dashboard-empty"><p>Not enough members yet. Numbers appear once at least {data.min_group_size} people in this group use AdaptAI in the same week.</p></Card>}
    {totals && <>
      <div className="team-tiles">
        <Tile label="Tokens" value={tokens(totals.tokens_in + totals.tokens_out)} detail={`${tokens(totals.tokens_in)} in · ${tokens(totals.tokens_out)} out`} />
        <Tile label="Estimated cost" value={euros(totals.est_cost_eur)} detail={data?.price_catalog_date ? `Estimated at catalog prices of ${data.price_catalog_date}` : 'Estimated'} />
        <Tile label="Resolved" value={percent(totals.resolved_rate)} detail={`${totals.feedback} answers to "Did it solve it?"`} />
        <Tile label="Took the recommendation" value={percent(totals.acceptance_rate)} detail={`Over-sized ${percent(totals.over_sized_rate)} · under-sized ${percent(totals.under_sized_rate)}`} />
      </div>
      <div className="section-heading"><h2>By week</h2></div>
      <Card className="team-table-card">
        <table className="team-table">
          <thead><tr><th scope="col">Week of</th><th scope="col">Tokens</th><th scope="col">Est. cost</th><th scope="col">Resolved</th><th scope="col">Took recommendation</th><th scope="col">Over / under</th></tr></thead>
          <tbody>{data!.weeks.map(week => <tr key={week.week}>
            <th scope="row">{week.week}{week.open ? ' (so far)' : ''}</th>
            {week.enough_members ? <>
              <td>{tokens((week.tokens_in ?? 0) + (week.tokens_out ?? 0))}</td>
              <td>{euros(week.est_cost_eur)}</td>
              <td>{percent(week.resolved_rate)}</td>
              <td>{percent(week.acceptance_rate)}</td>
              <td>{percent(week.over_sized_rate)} / {percent(week.under_sized_rate)}</td>
            </> : <td colSpan={5} className="muted">Not enough members this week</td>}
          </tr>)}</tbody>
        </table>
      </Card>
    </>}
    <SharedMembers groupId={group.id} />
  </main>
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Card className="team-tile"><p className="team-tile-label">{label}</p><p className="team-tile-value">{value}</p><p className="team-tile-detail">{detail}</p></Card>
}
