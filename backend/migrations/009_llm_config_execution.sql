-- ADR-015: where a personal model runs. 'server' (the default, as before): the backend calls the model.
-- 'client': the backend hands each request to the owner's VS Code extension (the relay), which calls the
-- model on the owner's machine (LM Studio on localhost). Additive and optional: existing rows stay 'server'.
ALTER TABLE llm_configs
    ADD COLUMN execution TEXT NOT NULL DEFAULT 'server' CHECK (execution IN ('server', 'client'));
