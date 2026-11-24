-- WS4 experience (L5, L9, L11, L17). Scores, codes, counts and flags only, never text.

-- L11: a salted hash of the analysed request, so a dispute can prove its passage comes from
-- that request without the request being stored. Disputes are allowed for 24 hours only.
ALTER TABLE request_quality ADD COLUMN task_salt TEXT;
ALTER TABLE request_quality ADD COLUMN task_hash TEXT;

CREATE TABLE quality_disputes (
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dimension TEXT NOT NULL CHECK (dimension IN ('objective','context','constraints','risks',
        'ambiguity','success_criteria','audience_format')),
    accepted INTEGER NOT NULL CHECK (accepted IN (0,1)),
    score_before SMALLINT NOT NULL CHECK (score_before BETWEEN 0 AND 2),
    score_after SMALLINT NOT NULL CHECK (score_after BETWEEN 0 AND 2),
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    PRIMARY KEY (analysis_id, dimension)
);
CREATE INDEX quality_disputes_user ON quality_disputes(user_id, created_at);

-- L5: an Educator hint the user dismissed stays hidden for the next 3 analyses.
CREATE TABLE learning_hint_dismissals (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hint_key TEXT NOT NULL CHECK (hint_key ~ '^[a-z_]+$'),
    analyses_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, hint_key)
);

-- L9: the weekly goal the user chose (or accepted), one per ISO week.
CREATE TABLE learning_goals (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week TEXT NOT NULL CHECK (week ~ '^[0-9]{4}-W[0-9]{2}$'),
    code TEXT NOT NULL CHECK (code ~ '^[a-z_]+$'),
    target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 10),
    set_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    PRIMARY KEY (user_id, week)
);

-- L17: learning paused (new tasks do not count) and when the user last started over.
CREATE TABLE learning_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
    reset_at TEXT
);
