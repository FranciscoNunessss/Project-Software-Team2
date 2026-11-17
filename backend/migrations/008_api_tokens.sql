-- ADR-013: personal API tokens, so a client that is not a browser (the VS Code extension) can sign
-- in as the user. The secret is shown once and only its SHA-256 is stored; a token expires, can be
-- revoked and is deleted with the user. It adds no text and changes no existing table.
CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    last_used_at BIGINT,
    revoked_at BIGINT,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
