-- WS3 T1b and T3 (ADR-016). Flags and times only: no task text, no usage numbers.
-- Number 014 is reserved for the WS4 migration (analyses.surface, coach_uses).

-- T1b: an organisation admin can turn "pause learning" and "start over" (WS4 L17) on or off
-- for the people in the organisation's groups. On by default.
ALTER TABLE organisations ADD COLUMN allow_pause BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE organisations ADD COLUMN allow_reset BOOLEAN NOT NULL DEFAULT TRUE;

-- T3: a member's consent to be seen individually by the managers of one group. No row means no
-- consent; revoking deletes the row. Leaving the group, deleting the group or deleting the
-- account removes it (cascade).
CREATE TABLE group_consents (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
);
