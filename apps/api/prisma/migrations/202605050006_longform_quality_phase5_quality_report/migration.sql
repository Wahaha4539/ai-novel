-- Phase 5: quality reports for generation, validation, AI review, repair, and manual quality gates.
CREATE TABLE "QualityReport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "chapterId" UUID,
  "draftId" UUID,
  "agentRunId" UUID,
  "sourceType" VARCHAR(50) NOT NULL,
  "sourceId" UUID,
  "reportType" VARCHAR(80) NOT NULL,
  "scores" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "issues" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "verdict" VARCHAR(20) NOT NULL,
  "summary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "QualityReport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "ChapterDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_agentRunId_fkey"
  FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_json_shape_check"
  CHECK (
    jsonb_typeof("scores") = 'object'
    AND jsonb_typeof("issues") = 'array'
    AND jsonb_typeof("metadata") = 'object'
  );

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_sourceType_check"
  CHECK ("sourceType" IN ('generation', 'validation', 'ai_review', 'auto_repair', 'manual'));

ALTER TABLE "QualityReport"
  ADD CONSTRAINT "QualityReport_verdict_check"
  CHECK ("verdict" IN ('pass', 'warn', 'fail'));

CREATE INDEX "QualityReport_project_created_idx" ON "QualityReport"("projectId", "createdAt");
CREATE INDEX "QualityReport_project_chapter_created_idx" ON "QualityReport"("projectId", "chapterId", "createdAt");
CREATE INDEX "QualityReport_project_draft_idx" ON "QualityReport"("projectId", "draftId");
CREATE INDEX "QualityReport_project_agentRun_idx" ON "QualityReport"("projectId", "agentRunId");
CREATE INDEX "QualityReport_project_type_verdict_idx" ON "QualityReport"("projectId", "sourceType", "reportType", "verdict");
