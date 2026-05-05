-- Phase 2: longform quality core facts for writing rules, relationships, and timeline.
CREATE TABLE "WritingRule" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "ruleType" VARCHAR(80) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "content" TEXT NOT NULL,
  "severity" "ValidationSeverity" NOT NULL DEFAULT 'info',
  "appliesFromChapterNo" INTEGER,
  "appliesToChapterNo" INTEGER,
  "entityType" VARCHAR(50),
  "entityRef" VARCHAR(255),
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WritingRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RelationshipEdge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "characterAId" UUID,
  "characterBId" UUID,
  "characterAName" VARCHAR(100) NOT NULL,
  "characterBName" VARCHAR(100) NOT NULL,
  "relationType" VARCHAR(80) NOT NULL,
  "publicState" TEXT,
  "hiddenState" TEXT,
  "conflictPoint" TEXT,
  "emotionalArc" TEXT,
  "turnChapterNos" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "finalState" TEXT,
  "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  "sourceType" VARCHAR(50) NOT NULL DEFAULT 'manual',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RelationshipEdge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TimelineEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "chapterId" UUID,
  "chapterNo" INTEGER,
  "title" VARCHAR(255) NOT NULL,
  "eventTime" VARCHAR(120),
  "locationName" VARCHAR(255),
  "participants" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "cause" TEXT,
  "result" TEXT,
  "impactScope" VARCHAR(80),
  "isPublic" BOOLEAN NOT NULL DEFAULT false,
  "knownBy" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "unknownBy" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "eventStatus" VARCHAR(50) NOT NULL DEFAULT 'active',
  "sourceType" VARCHAR(50) NOT NULL DEFAULT 'manual',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WritingRule"
  ADD CONSTRAINT "WritingRule_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WritingRule"
  ADD CONSTRAINT "WritingRule_chapter_range_check"
  CHECK ("appliesFromChapterNo" IS NULL OR "appliesToChapterNo" IS NULL OR "appliesFromChapterNo" <= "appliesToChapterNo");

ALTER TABLE "RelationshipEdge"
  ADD CONSTRAINT "RelationshipEdge_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RelationshipEdge"
  ADD CONSTRAINT "RelationshipEdge_characterAId_fkey"
  FOREIGN KEY ("characterAId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RelationshipEdge"
  ADD CONSTRAINT "RelationshipEdge_characterBId_fkey"
  FOREIGN KEY ("characterBId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TimelineEvent"
  ADD CONSTRAINT "TimelineEvent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimelineEvent"
  ADD CONSTRAINT "TimelineEvent_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WritingRule_project_ruleType_status_idx" ON "WritingRule"("projectId", "ruleType", "status");
CREATE INDEX "WritingRule_project_severity_status_idx" ON "WritingRule"("projectId", "severity", "status");
CREATE INDEX "WritingRule_project_entity_idx" ON "WritingRule"("projectId", "entityType", "entityRef");
CREATE INDEX "WritingRule_project_chapter_range_idx" ON "WritingRule"("projectId", "appliesFromChapterNo", "appliesToChapterNo");

CREATE INDEX "RelationshipEdge_project_status_updated_idx" ON "RelationshipEdge"("projectId", "status", "updatedAt");
CREATE INDEX "RelationshipEdge_project_relation_status_idx" ON "RelationshipEdge"("projectId", "relationType", "status");
CREATE INDEX "RelationshipEdge_project_characterAName_idx" ON "RelationshipEdge"("projectId", "characterAName");
CREATE INDEX "RelationshipEdge_project_characterBName_idx" ON "RelationshipEdge"("projectId", "characterBName");
CREATE INDEX "RelationshipEdge_project_characterIds_idx" ON "RelationshipEdge"("projectId", "characterAId", "characterBId");

CREATE INDEX "TimelineEvent_project_chapter_status_idx" ON "TimelineEvent"("projectId", "chapterNo", "eventStatus");
CREATE INDEX "TimelineEvent_project_status_updated_idx" ON "TimelineEvent"("projectId", "eventStatus", "updatedAt");
CREATE INDEX "TimelineEvent_project_eventTime_idx" ON "TimelineEvent"("projectId", "eventTime");
CREATE INDEX "TimelineEvent_project_chapterId_idx" ON "TimelineEvent"("projectId", "chapterId");
CREATE INDEX "TimelineEvent_project_location_idx" ON "TimelineEvent"("projectId", "locationName");
