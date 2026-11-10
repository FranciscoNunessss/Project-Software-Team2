// The shapes of the AdaptAI API the extension reads (backend/app/models.py, llm_config.py and
// outcomes.py on develop). Only what the extension shows or sends is listed; extra fields are ignored.

export type LlmOption = {
  id: string
  provider: string
  label: string
  model: string | null
  external: boolean
  source: string
}

export type LlmOptions = {
  options: LlmOption[]
  auto_configuration_id: string | null
  /** ADR-014 A11: the project's assessor, which analyses every task. Null when none is configured. */
  assessment?: LlmOption | null
  assessment_chain?: string[]
  auto_policy?: string
}

export type Dimension = { score: number | null; confidence: string; evidence: string }
export type Profile = Record<'reasoning' | 'context' | 'ambiguity' | 'domain' | 'risk' | 'tools', Dimension> & {
  modality: { required: string[] | null; confidence: string; evidence: string }
  explanation: string
}

export type Need = 'reasoning' | 'context' | 'domain' | 'reliability' | 'tools'
export type CoverageState = 'covers' | 'covers_as_described' | 'short'
export type Coverage = { need: Need; estimated: number; top: number; capability: number | null; state: CoverageState; provisional: boolean }

export type Candidate = {
  id: string
  name: string
  capabilities?: string[]
  // Legacy tier fields (analyses stored before ADR-014).
  capacity?: number | null
  fit?: number | null
  // Card fields (needs-capabilities-1).
  provider?: string | null
  model?: string | null
  configuration_id?: string | null
  label?: string | null
  status?: CoverageState | null
  shortfalls?: string[]
  coverage?: Coverage[]
  blended_price?: number | null
  cost_band?: 'low' | 'medium' | 'high' | null
  free?: boolean
  local?: boolean
  illustrative?: boolean
  calibrated?: boolean
  levels_from?: string | null
  gap?: number | null
}

export type Tip = { dimension: string | null; text: string }
export type Change = { dimension: string; before: unknown; after: unknown; evidence?: string }

export type TaskNeeds = {
  needs: Record<Need, { estimated: number; top: number; determined: boolean }>
  modalities: string[]
  capabilities: string[]
  length_tokens: number
  ambiguous: boolean
}

export type Analysis = {
  id: string
  session_id: string
  configuration_id?: string | null
  selection_mode?: 'auto' | 'manual'
  mode: 'demonstration' | 'semantic'
  provider: string
  assessment_model: string | null
  profile: Profile
  profile_version: string
  rubric_version?: string
  recommendation_provisional: boolean
  clarification_questions: string[]
  guidance: string[]
  tips: Tip[]
  recommendation: Candidate
  alternatives: Candidate[]
  rationale: string
  warnings: string[]
  catalogue_version: string
  policy_version: string
  latency_ms: number
  completeness?: number | null
  previous_analysis_id?: string | null
  changes?: Change[]
  needs?: TaskNeeds | null
  notes?: string[]
  suggestion?: Candidate | null
  suggestion_reason?: string | null
  observed_cost?: number | null
}

export type Suggestion = { dimension: string; kind: 'question' | 'tip' | 'edit'; title: string; rationale: string; quote: string | null; replacement: string | null }
export type Coach = { status: 'ok' | 'nothing_to_improve'; suggestions: Suggestion[]; rewrite: string | null; open_questions: string[]; fallback: boolean; dropped: number }
export type CoachMode = 'tips' | 'edits' | 'rewrite'

export type OutcomeValue = 'resolved' | 'resolved_with_refinement' | 'not_resolved' | 'skipped'
export type OutcomeReason = 'quality' | 'instructions' | 'description' | 'other'
