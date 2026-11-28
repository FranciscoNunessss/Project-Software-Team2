-- WS3 TL5: the goal a manager picks for a group, one per ISO week. A code only, never text.
-- Numbered 017 because 014 is left for WS4 and 016 for the privacy migration; renumber at merge
-- if those end up elsewhere.
CREATE TABLE group_goals (
    group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
    week TEXT NOT NULL CHECK (week ~ '^[0-9]{4}-W[0-9]{2}$'),
    code TEXT NOT NULL CHECK (code ~ '^[a-z_]+$'),
    PRIMARY KEY (group_id, week)
);
