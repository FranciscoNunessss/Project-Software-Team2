-- Identity is bound to the provider subject, never implicitly to an email address.
CREATE TABLE auth_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (issuer, subject)
);
