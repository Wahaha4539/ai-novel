-- Store production execution cost telemetry without changing Tool outputs.

ALTER TABLE "AgentStep"
ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';
