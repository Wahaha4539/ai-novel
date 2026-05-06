-- AgentRun progress polling and timeout governance.
-- Adds observable step phase/heartbeat/deadline fields and lightweight run lease fields.

ALTER TABLE "AgentRun"
ADD COLUMN IF NOT EXISTS "currentStepNo" INTEGER,
ADD COLUMN IF NOT EXISTS "currentTool" VARCHAR(100),
ADD COLUMN IF NOT EXISTS "currentPhase" VARCHAR(80),
ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deadlineAt" TIMESTAMP(3);

ALTER TABLE "AgentStep"
ADD COLUMN IF NOT EXISTS "phase" VARCHAR(80),
ADD COLUMN IF NOT EXISTS "phaseMessage" TEXT,
ADD COLUMN IF NOT EXISTS "progressCurrent" INTEGER,
ADD COLUMN IF NOT EXISTS "progressTotal" INTEGER,
ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "timeoutAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deadlineAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "errorCode" VARCHAR(80),
ADD COLUMN IF NOT EXISTS "errorDetail" JSONB;

CREATE INDEX IF NOT EXISTS "AgentStep_status_timeoutAt_idx"
ON "AgentStep"("status", "timeoutAt");

CREATE INDEX IF NOT EXISTS "AgentStep_status_heartbeatAt_idx"
ON "AgentStep"("status", "heartbeatAt");

CREATE INDEX IF NOT EXISTS "AgentRun_status_deadlineAt_idx"
ON "AgentRun"("status", "deadlineAt");
