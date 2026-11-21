-- WS3 T1 (ADR-016): organisations, groups, roles and membership for the Team Scope.
-- Only ids, names chosen by the admin, roles and times: no task text, no usage numbers.
-- Deleting a user deletes their memberships and invites (cascade). An invite stores only the
-- SHA-256 of its link token; an email, when given, restricts who can accept it.
CREATE TABLE organisations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE TABLE organisation_members (
    organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (organisation_id, user_id)
);
CREATE INDEX organisation_members_user ON organisation_members(user_id);
CREATE TABLE team_groups (
    id TEXT PRIMARY KEY,
    organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    UNIQUE (organisation_id, name)
);
CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('manager', 'member')),
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);
CREATE TABLE group_invites (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('manager', 'member')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_at BIGINT,
    sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX group_invites_group ON group_invites(group_id);
