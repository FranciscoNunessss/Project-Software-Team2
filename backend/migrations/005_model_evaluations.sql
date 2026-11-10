-- ADR-014: automatic evaluation of the models configured in the app (measure-suite-1).
-- A row is one evaluation run of one model. scope = 'shared' for official cloud endpoints
-- (the result serves every user), or the user id for local models (Ollama, LM Studio).
-- Synthetic tasks only: no user text is ever stored here.
CREATE TABLE model_evaluations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    scope TEXT NOT NULL,
    suite_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
        ('awaiting_consent','declined','queued','running','done','failed')),
    requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    configuration_id TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    estimate_json TEXT,
    facts_json TEXT,
    levels_json TEXT,
    results_json TEXT,
    spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    failure TEXT,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    finished_at TEXT,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX model_evaluation_lookup ON model_evaluations(provider, model, scope, suite_version);
CREATE INDEX model_evaluation_queue ON model_evaluations(status, sequence_id);
-- At most one open run (waiting, queued or running) per model, scope and suite.
CREATE UNIQUE INDEX model_evaluation_open ON model_evaluations(provider, model, scope, suite_version)
    WHERE status IN ('awaiting_consent','declined','queued','running');

-- "I disagree with this level": feeds the calibration report, never changes a level.
CREATE TABLE evaluation_disagreements (
    evaluation_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (capability IN
        ('reasoning','context','domain','reliability','tools')),
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    PRIMARY KEY (evaluation_id, user_id, capability)
);
