-- ADR-014: per-task feedback, containing only identifiers and derived metadata.
CREATE TABLE task_outcomes (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN
        ('resolved','resolved_with_refinement','not_resolved','skipped')),
    reason TEXT CHECK (reason IN ('quality','instructions','description','other')),
    model_card_id TEXT, catalogue_version TEXT,
    recommended_card_id TEXT, followed_recommendation INTEGER,
    needs_json TEXT, capabilities_json TEXT,
    completeness INTEGER, turns INTEGER, switched_model INTEGER, retries INTEGER, stops INTEGER,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX task_outcome_user ON task_outcomes(user_id);
