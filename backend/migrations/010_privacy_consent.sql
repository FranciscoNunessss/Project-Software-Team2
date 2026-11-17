-- Privacy Policy acceptance record (GDPR Art. 7(1): the controller must be able to show consent).
-- Only the policy version and the time are stored. NULL means the user has not accepted any
-- version yet: the app asks before it opens. The column is deleted with the user.
ALTER TABLE users ADD COLUMN policy_version TEXT;
ALTER TABLE users ADD COLUMN policy_accepted_at TEXT;
