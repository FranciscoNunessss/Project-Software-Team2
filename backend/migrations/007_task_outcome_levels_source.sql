-- ADR-014 A10: where the levels of the model used came from when the task was answered
-- (calibrated, measured, provisional, arena, benchmark, family), so the calibration report
-- can tell which source predicts outcomes badly. A name, never text.
ALTER TABLE task_outcomes ADD COLUMN levels_source TEXT;
