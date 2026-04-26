-- Production trace isolation: keep Plan preview, Act execution, retry and replan traces
-- addressable by explicit mode + plan version + logical step number instead of
-- relying on negative step numbers.

ALTER TABLE "AgentStep" ADD COLUMN IF NOT EXISTS "planVersion" INTEGER NOT NULL DEFAULT 1;

-- Older Plan preview traces used negative step numbers to avoid the original
-- (agentRunId, stepNo) unique key. Normalize them before replacing the key.
UPDATE "AgentStep"
SET "stepNo" = ABS("stepNo")
WHERE "mode" = 'plan' AND "stepNo" < 0;

DROP INDEX IF EXISTS "AgentStep_agentRunId_stepNo_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AgentStep_agentRunId_mode_planVersion_stepNo_key"
ON "AgentStep"("agentRunId", "mode", "planVersion", "stepNo");

CREATE INDEX IF NOT EXISTS "AgentStep_agentRunId_planVersion_mode_idx"
ON "AgentStep"("agentRunId", "planVersion", "mode");