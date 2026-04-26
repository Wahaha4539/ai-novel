-- Agent trace tables for Plan / Act runtime.
-- These tables mirror the Prisma schema and are required for agent execution traces,
-- artifacts and approvals. They are intentionally separate from LLM routing config.

CREATE TABLE IF NOT EXISTS "AgentRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "chapterId" UUID,
    "agentType" VARCHAR(80) NOT NULL,
    "taskType" VARCHAR(80),
    "status" VARCHAR(50) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "goal" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "policy" JSONB,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentPlan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(50) NOT NULL,
    "taskType" VARCHAR(80) NOT NULL,
    "summary" TEXT NOT NULL,
    "assumptions" JSONB,
    "risks" JSONB,
    "steps" JSONB NOT NULL,
    "requiredApprovals" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentStep" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "stepType" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "toolName" VARCHAR(100),
    "status" VARCHAR(50) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentArtifact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "artifactType" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "content" JSONB NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "sourceStepNo" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentApproval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentRunId" UUID NOT NULL,
    "approvalType" VARCHAR(80) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "target" JSONB NOT NULL,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentRun_projectId_status_createdAt_idx" ON "AgentRun"("projectId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentPlan_agentRunId_version_idx" ON "AgentPlan"("agentRunId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentStep_agentRunId_stepNo_key" ON "AgentStep"("agentRunId", "stepNo");
CREATE INDEX IF NOT EXISTS "AgentArtifact_agentRunId_artifactType_idx" ON "AgentArtifact"("agentRunId", "artifactType");
CREATE INDEX IF NOT EXISTS "AgentApproval_agentRunId_status_idx" ON "AgentApproval"("agentRunId", "status");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentArtifact" ADD CONSTRAINT "AgentArtifact_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;