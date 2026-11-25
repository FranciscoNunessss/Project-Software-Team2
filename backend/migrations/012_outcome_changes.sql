-- WS4 L6/L16 (ADR-014 revision of 24 Nov 2026): feedback can be changed while the analysis
-- exists. Counts the changes; the row keeps only the latest answer. No text.
ALTER TABLE task_outcomes ADD COLUMN changes INTEGER NOT NULL DEFAULT 0;
