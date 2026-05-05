-- Phase 4: chapter patterns and pacing beats for longform quality planning.
CREATE TABLE "ChapterPattern" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "patternType" VARCHAR(80) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "applicableScenes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "structure" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "pacingAdvice" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "emotionalAdvice" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "conflictAdvice" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChapterPattern_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PacingBeat" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "volumeId" UUID,
  "chapterId" UUID,
  "chapterNo" INTEGER,
  "beatType" VARCHAR(80) NOT NULL,
  "emotionalTone" TEXT,
  "emotionalIntensity" INTEGER NOT NULL DEFAULT 50,
  "tensionLevel" INTEGER NOT NULL DEFAULT 50,
  "payoffLevel" INTEGER NOT NULL DEFAULT 50,
  "notes" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PacingBeat_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChapterPattern"
  ADD CONSTRAINT "ChapterPattern_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_volumeId_fkey"
  FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChapterPattern"
  ADD CONSTRAINT "ChapterPattern_applicableScenes_array_check"
  CHECK (jsonb_typeof("applicableScenes") = 'array');

ALTER TABLE "ChapterPattern"
  ADD CONSTRAINT "ChapterPattern_structure_object_check"
  CHECK (jsonb_typeof("structure") = 'object');

ALTER TABLE "ChapterPattern"
  ADD CONSTRAINT "ChapterPattern_advice_object_check"
  CHECK (
    jsonb_typeof("pacingAdvice") = 'object'
    AND jsonb_typeof("emotionalAdvice") = 'object'
    AND jsonb_typeof("conflictAdvice") = 'object'
    AND jsonb_typeof("metadata") = 'object'
  );

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_chapterNo_positive_check"
  CHECK ("chapterNo" IS NULL OR "chapterNo" > 0);

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_emotionalIntensity_range_check"
  CHECK ("emotionalIntensity" >= 0 AND "emotionalIntensity" <= 100);

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_tensionLevel_range_check"
  CHECK ("tensionLevel" >= 0 AND "tensionLevel" <= 100);

ALTER TABLE "PacingBeat"
  ADD CONSTRAINT "PacingBeat_payoffLevel_range_check"
  CHECK ("payoffLevel" >= 0 AND "payoffLevel" <= 100);

CREATE INDEX "ChapterPattern_project_status_updated_idx" ON "ChapterPattern"("projectId", "status", "updatedAt");
CREATE INDEX "ChapterPattern_project_pattern_status_idx" ON "ChapterPattern"("projectId", "patternType", "status");

CREATE INDEX "PacingBeat_project_volume_chapter_idx" ON "PacingBeat"("projectId", "volumeId", "chapterId");
CREATE INDEX "PacingBeat_project_chapterNo_idx" ON "PacingBeat"("projectId", "chapterNo");
CREATE INDEX "PacingBeat_project_beatType_idx" ON "PacingBeat"("projectId", "beatType");
