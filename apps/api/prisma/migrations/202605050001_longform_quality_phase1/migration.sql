-- Phase 1: Story Bible metadata and project-level creative profile.
CREATE TABLE "ProjectCreativeProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "audienceType" VARCHAR(80),
  "platformTarget" VARCHAR(80),
  "sellingPoints" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "pacingPreference" VARCHAR(80),
  "targetWordCount" INTEGER,
  "chapterWordCount" INTEGER,
  "contentRating" VARCHAR(80),
  "centralConflict" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "generationDefaults" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "validationDefaults" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectCreativeProfile_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProjectCreativeProfile"
  ADD CONSTRAINT "ProjectCreativeProfile_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProjectCreativeProfile_projectId_key" ON "ProjectCreativeProfile"("projectId");

ALTER TABLE "LorebookEntry"
  ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX "LorebookEntry_project_status_idx" ON "LorebookEntry"("projectId", "status");
