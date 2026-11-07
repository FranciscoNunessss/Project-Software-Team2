-- ADR-014 phase 1.1: the model actually used for the task, even without a catalogue card.
-- Identifiers only (provider and model id), never text.
ALTER TABLE task_outcomes ADD COLUMN used_provider TEXT;
ALTER TABLE task_outcomes ADD COLUMN used_model TEXT;
