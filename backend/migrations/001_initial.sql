-- PostgreSQL baseline corresponding to the former SQLite v7 core schema.
-- Published migrations are immutable. Add a numbered file for each later change.
CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
);
CREATE INDEX auth_user ON auth_sessions(user_id);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX sessions_user ON sessions(user_id, created_at, sequence_id);
CREATE TABLE analyses (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    request_json TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX analysis_session ON analyses(session_id, created_at, sequence_id);
CREATE TABLE decisions (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE user_context (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    save_enabled INTEGER NOT NULL DEFAULT 0 CHECK (save_enabled IN (0,1)),
    use_enabled INTEGER NOT NULL DEFAULT 0 CHECK (use_enabled IN (0,1)),
    coaching_auto_enabled INTEGER NOT NULL DEFAULT 0 CHECK (coaching_auto_enabled IN (0,1)),
    conversation_memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (conversation_memory_enabled IN (0,1))
);
CREATE TABLE memory_entries (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, metadata_json TEXT NOT NULL,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX memory_user ON memory_entries(user_id, sequence_id);
CREATE TABLE llm_configs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, key_ciphertext TEXT,
    responses_api INTEGER NOT NULL DEFAULT 0 CHECK (responses_api IN (0,1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    created_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX llm_user ON llm_configs(user_id);
CREATE UNIQUE INDEX llm_default ON llm_configs(user_id) WHERE is_default=1;
CREATE TABLE coaching_reports (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, model TEXT NOT NULL, report_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    source_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE conversation_content (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    task TEXT NOT NULL, task_context TEXT NOT NULL, response_json TEXT NOT NULL
);
