import { useEffect, useState } from 'react'
import { api } from './api'
import { Button, Card } from './ui'
import { euros, percent, tokens, type Figures } from './teamFigures'

// Team Scope (WS3 T4): the groups a person runs, side by side on the same figures. A group under
// the minimum size shows no number (ADR-016).

type Overview = {
  source: string; min_group_size: number; weeks: number
  groups: { id: string; name: string; organisation: string; enough_members: boolean; totals: Figures | null }[]
}

const ROWS: { label: string; value: (figures: Figures) => string }[] = [
  { label: 'Tokens', value: f => tokens(f.tokens_in + f.tokens_out) },
  { label: 'Estimated cost', value: f => euros(f.est_cost_eur) },
  { label: 'Tasks', value: f => String(f.tasks) },
  { label: 'Resolved', value: f => percent(f.resolved_rate) },
  { label: 'Took the recommendation', value: f => percent(f.acceptance_rate) },
  { label: 'Over-sized', value: f => percent(f.over_sized_rate) },
  { label: 'Under-sized', value: f => percent(f.under_sized_rate) },
]

export function TeamOverview({ onBack }: { onBack: () => void }) {
  const [weeks, setWeeks] = useState(4)
  const [data, setData] = useState<Overview>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api<Overview>(`teams/overview?weeks=${weeks}`, undefined, controller.signal).then(setData)
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load the comparison') })
    return () => controller.abort()
  }, [weeks])
  return <main className="page team-page">
    <Button variant="ghost" size="sm" onClick={onBack}>← Teams</Button>
    <div className="intro"><div>
      <p className="eyebrow">Compare groups</p>
      <h1>Your groups side by side.</h1>
      <p>The same figures for each group you run. A group with fewer than {data?.min_group_size ?? 5} people using AdaptAI shows no numbers.</p>
    </div>
      <label className="period">Period <select value={weeks} onChange={event => setWeeks(Number(event.target.value))}>
        <option value={4}>Last 4 weeks</option><option value={8}>Last 8 weeks</option><option value={12}>Last 12 weeks</option>
      </select></label>
    </div>
    {error && <p className="api-error" role="alert">{error}</p>}
    {data?.source === 'mock' && <p className="team-mock" role="note">Demo data: these numbers are synthetic until real usage records arrive (WS1 gateway).</p>}
    {data && <Card className="team-table-card">
      <table className="team-table" data-team-overview="">
        <caption className="visually-hidden">Figures by group</caption>
        <thead><tr><th scope="col">Figure</th>{data.groups.map(group => <th scope="col" key={group.id}>{group.name}<br /><span className="muted">{group.organisation}</span></th>)}</tr></thead>
        <tbody>{ROWS.map(row => <tr key={row.label}>
          <th scope="row">{row.label}</th>
          {data.groups.map(group => <td key={group.id}>{group.totals ? row.value(group.totals) : <span className="muted">Not enough members</span>}</td>)}
        </tr>)}</tbody>
      </table>
    </Card>}
  </main>
}
