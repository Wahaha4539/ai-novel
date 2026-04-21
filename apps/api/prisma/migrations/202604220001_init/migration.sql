CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'active', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ChapterStatus" AS ENUM ('planned', 'drafted', 'reviewed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ValidationSeverity" AS ENUM ('error', 'warning', 'info');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "Project" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId" UUID,
  "title" VARCHAR(255) NOT NULL,
  "genre" VARCHAR(100),
  "theme" VARCHAR(255),
  "tone" VARCHAR(100),
  "logline" TEXT,
  "synopsis" TEXT,
  "targetWordCount" INTEGER,
  "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
  "defaultStyleProfileId" UUID,
  "defaultModelProfileId" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "StyleProfile" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name" VARCHAR(100) NOT NULL,
  "pov" VARCHAR(50),
  "tense" VARCHAR(50),
  "proseStyle" VARCHAR(100),
  "pacing" VARCHAR(50),
  "dialogueDensity" INTEGER NOT NULL DEFAULT 50,
  "narrationDensity" INTEGER NOT NULL DEFAULT 50,
  "descriptionDensity" INTEGER NOT NULL DEFAULT 50,
  "darknessLevel" INTEGER NOT NULL DEFAULT 50,
  "humorLevel" INTEGER NOT NULL DEFAULT 10,
  "emotionalIntensity" INTEGER NOT NULL DEFAULT 50,
  "sentenceStyle" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "forbiddenPatterns" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "preferredPatterns" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ModelProfile" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name" VARCHAR(100) NOT NULL,
  "plannerProvider" VARCHAR(50),
  "plannerModel" VARCHAR(100),
  "writerProvider" VARCHAR(50),
  "writerModel" VARCHAR(100),
  "summarizerProvider" VARCHAR(50),
  "summarizerModel" VARCHAR(100),
  "validatorProvider" VARCHAR(50),
  "validatorModel" VARCHAR(100),
  "embeddingProvider" VARCHAR(50),
  "embeddingModel" VARCHAR(100),
  "writerParams" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "plannerParams" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "summarizerParams" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "validatorParams" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Character" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name" VARCHAR(100) NOT NULL,
  "alias" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "roleType" VARCHAR(50),
  "personalityCore" TEXT,
  "motivation" TEXT,
  "speechStyle" TEXT,
  "backstory" TEXT,
  "growthArc" TEXT,
  "isDead" BOOLEAN NOT NULL DEFAULT FALSE,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "Character_projectId_name_idx" ON "Character"("projectId", "name");

CREATE TABLE IF NOT EXISTS "LorebookEntry" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "title" VARCHAR(255) NOT NULL,
  "entryType" VARCHAR(50) NOT NULL,
  "content" TEXT NOT NULL,
  "summary" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "priority" INTEGER NOT NULL DEFAULT 50,
  "triggerKeywords" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "relatedEntityIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "sourceType" VARCHAR(50) NOT NULL DEFAULT 'manual',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "LorebookEntry_projectId_entryType_idx" ON "LorebookEntry"("projectId", "entryType");

CREATE TABLE IF NOT EXISTS "Chapter" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "volumeId" UUID,
  "chapterNo" INTEGER NOT NULL,
  "title" VARCHAR(255),
  "objective" TEXT,
  "conflict" TEXT,
  "revealPoints" TEXT,
  "foreshadowPlan" TEXT,
  "outline" TEXT,
  "status" "ChapterStatus" NOT NULL DEFAULT 'planned',
  "expectedWordCount" INTEGER,
  "actualWordCount" INTEGER,
  "timelineSeq" INTEGER,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("projectId", "chapterNo")
);

CREATE TABLE IF NOT EXISTS "ChapterDraft" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "chapterId" UUID NOT NULL REFERENCES "Chapter"("id") ON DELETE CASCADE,
  "versionNo" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "source" VARCHAR(50) NOT NULL,
  "modelInfo" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "generationContext" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "isCurrent" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("chapterId", "versionNo")
);

CREATE TABLE IF NOT EXISTS "MemoryChunk" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "sourceType" VARCHAR(50) NOT NULL,
  "sourceId" UUID NOT NULL,
  "memoryType" VARCHAR(50) NOT NULL,
  "content" TEXT NOT NULL,
  "summary" TEXT,
  "embedding" JSONB,
  "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "importanceScore" INTEGER NOT NULL DEFAULT 50,
  "recencyScore" INTEGER NOT NULL DEFAULT 50,
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ValidationIssue" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "chapterId" UUID REFERENCES "Chapter"("id") ON DELETE SET NULL,
  "issueType" VARCHAR(100) NOT NULL,
  "severity" "ValidationSeverity" NOT NULL,
  "entityType" VARCHAR(50),
  "entityId" UUID,
  "message" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "suggestion" TEXT,
  "status" VARCHAR(50) NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resolvedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "GenerationJob" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "chapterId" UUID REFERENCES "Chapter"("id") ON DELETE SET NULL,
  "jobType" VARCHAR(50) NOT NULL,
  "targetType" VARCHAR(50) NOT NULL,
  "targetId" UUID NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'queued',
  "requestPayload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "responsePayload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "retrievalPayload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "promptSnapshot" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
