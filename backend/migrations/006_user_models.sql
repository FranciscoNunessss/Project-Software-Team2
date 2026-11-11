-- ADR-014 A8: models a user chose from a provider's catalogue (OpenRouter's picker) besides
-- the one saved in the configuration. They are evaluated and recommended like configured ones.
CREATE TABLE user_models (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    configuration_id TEXT NOT NULL REFERENCES llm_configs(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    PRIMARY KEY (user_id, configuration_id, model)
);
