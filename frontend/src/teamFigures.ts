// The group figures of the Team Scope and how they are written (dashboard and comparison).
export type Figures = {
  calls: number; tokens_in: number; tokens_out: number; est_cost_eur: number; tasks: number
  acceptance_rate: number | null; over_sized_rate: number | null; under_sized_rate: number | null
  feedback: number | null; resolved_rate: number | null; partly_rate: number | null
  // Real groups only (stored data); null when fewer than 5 people stand behind a figure.
  clear_rate?: number | null; web_tasks?: number | null; ide_tasks?: number | null
}

export const percent = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}%`
export const tokens = (value: number | undefined) => value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
export const euros = (value: number | undefined) => value === undefined ? '—' : `€${value.toFixed(value < 1 ? 4 : 2)}`
