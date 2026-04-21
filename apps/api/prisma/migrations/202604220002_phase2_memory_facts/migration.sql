ALTER TABLE "MemoryChunk"
  ADD COLUMN IF NOT EXISTS "sourceTrace" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "freshnessScore" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE "MemoryChunk"
  ALTER COLUMN "status" SET DEFAULT 'auto';

UPDATE "MemoryChunk"
SET
  "status" = CASE WHEN "status" = 'active' THEN 'auto' ELSE "status" END,
  "updatedAt" = COALESCE("updatedAt", "createdAt"),
  "sourceTrace" = COALESCE("sourceTrace", '{}'::jsonb),
  "freshnessScore" = COALESCE("freshnessScore", 50);

CREATE INDEX IF NOT EXISTS "MemoryChunk_projectId_memoryType_status_idx"
  ON "MemoryChunk"("projectId", "memoryType", "status");

CREATE INDEX IF NOT EXISTS "MemoryChunk_projectId_sourceType_sourceId_idx"
  ON "MemoryChunk"("projectId", "sourceType", "sourceId");

CREATE TABLE IF NOT EXISTS "StoryEvent" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "chapterId" UUID NOT NULL REFERENCES "Chapter"("id") ON DELETE CASCADE,
  "chapterNo" INTEGER,
  "sourceDraftId" UUID,
  "title" VARCHAR(255) NOT NULL,
  "eventType" VARCHAR(50) NOT NULL,
  "description" TEXT NOT NULL,
  "participants" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "timelineSeq" INTEGER,
  "status" VARCHAR(50) NOT NULL DEFAULT 'detected',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "StoryEvent_projectId_chapterNo_idx"
  ON "StoryEvent"("projectId", "chapterNo");

CREATE INDEX IF NOT EXISTS "StoryEvent_projectId_eventType_idx"
  ON "StoryEvent"("projectId", "eventType");

CREATE TABLE IF NOT EXISTS "CharacterStateSnapshot" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "chapterId" UUID NOT NULL REFERENCES "Chapter"("id") ON DELETE CASCADE,
  "chapterNo" INTEGER,
  "sourceDraftId" UUID,
  "characterId" UUID,
  "characterName" VARCHAR(100) NOT NULL,
  "stateType" VARCHAR(50) NOT NULL,
  "stateValue" TEXT NOT NULL,
  "summary" TEXT,
  "status" VARCHAR(50) NOT NULL DEFAULT 'auto',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "CharacterStateSnapshot_projectId_characterName_chapterNo_idx"
  ON "CharacterStateSnapshot"("projectId", "characterName", "chapterNo");

CREATE INDEX IF NOT EXISTS "CharacterStateSnapshot_projectId_status_idx"
  ON "CharacterStateSnapshot"("projectId", "status");

CREATE TABLE IF NOT EXISTS "ForeshadowTrack" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "chapterId" UUID NOT NULL REFERENCES "Chapter"("id") ON DELETE CASCADE,
  "chapterNo" INTEGER,
  "sourceDraftId" UUID,
  "title" VARCHAR(255) NOT NULL,
  "detail" TEXT,
  "status" VARCHAR(50) NOT NULL DEFAULT 'planned',
  "firstSeenChapterNo" INTEGER,
  "lastSeenChapterNo" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "ForeshadowTrack_projectId_title_idx"
  ON "ForeshadowTrack"("projectId", "title");

CREATE INDEX IF NOT EXISTS "ForeshadowTrack_projectId_status_idx"
  ON "ForeshadowTrack"("projectId", "status");