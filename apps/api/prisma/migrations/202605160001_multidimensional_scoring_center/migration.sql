CREATE TABLE "ScoringRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "chapterId" UUID,
    "draftId" UUID,
    "agentRunId" UUID,
    "targetType" VARCHAR(50) NOT NULL,
    "targetId" VARCHAR(120),
    "targetRef" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "platformProfile" VARCHAR(80) NOT NULL,
    "profileVersion" VARCHAR(80) NOT NULL,
    "promptVersion" VARCHAR(80) NOT NULL,
    "rubricVersion" VARCHAR(80) NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "verdict" VARCHAR(20) NOT NULL,
    "summary" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "issues" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "revisionPriorities" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "extractedElements" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "targetSnapshot" JSONB NOT NULL,
    "sourceTrace" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "llmMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScoringRun_project_created_idx" ON "ScoringRun"("projectId", "createdAt");
CREATE INDEX "ScoringRun_target_profile_created_idx" ON "ScoringRun"("projectId", "targetType", "targetId", "platformProfile", "createdAt");
CREATE INDEX "ScoringRun_chapter_target_profile_idx" ON "ScoringRun"("projectId", "chapterId", "targetType", "platformProfile");
CREATE INDEX "ScoringRun_project_draft_idx" ON "ScoringRun"("projectId", "draftId");
CREATE INDEX "ScoringRun_project_agentRun_idx" ON "ScoringRun"("projectId", "agentRunId");

ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ChapterDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScoringRun" ADD CONSTRAINT "ScoringRun_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
