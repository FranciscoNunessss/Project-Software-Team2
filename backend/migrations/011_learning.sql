-- WS4 (L0, L1, L17): learning data. Scores, codes and flags only, never text.
-- Numbered 011 because the WS3 branch adds 010_team_scope.sql; the two are independent.

-- L1: how the user framed each analysed task, 0 missing, 1 partial, 2 clear, NULL not applicable.
CREATE TABLE request_quality (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    objective SMALLINT CHECK (objective BETWEEN 0 AND 2),
    context SMALLINT CHECK (context BETWEEN 0 AND 2),
    constraints SMALLINT CHECK (constraints BETWEEN 0 AND 2),
    risks SMALLINT CHECK (risks BETWEEN 0 AND 2),
    ambiguity SMALLINT CHECK (ambiguity BETWEEN 0 AND 2),
    success_criteria SMALLINT CHECK (success_criteria BETWEEN 0 AND 2),
    audience_format SMALLINT CHECK (audience_format BETWEEN 0 AND 2),
    -- L10: one reason code per dimension, from a closed list (lower case and underscores).
    reason_codes TEXT NOT NULL DEFAULT '{}' CHECK (reason_codes ~ '^\{[a-z_":, ]*\}$'),
    prompt_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX request_quality_user ON request_quality(user_id);

-- L17: tasks the user removed from their learning (excluded) or analysed while learning was
-- paused. Either way the engine skips them.
CREATE TABLE learning_exclusions (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('excluded','paused')),
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX learning_exclusions_user ON learning_exclusions(user_id);
