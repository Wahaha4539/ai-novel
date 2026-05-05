-- Phase 4: scene cards for chapter-level execution planning.
CREATE TABLE "SceneCard" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "volumeId" UUID,
  "chapterId" UUID,
  "sceneNo" INTEGER,
  "title" VARCHAR(255) NOT NULL,
  "locationName" TEXT,
  "participants" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "purpose" TEXT,
  "conflict" TEXT,
  "emotionalTone" TEXT,
  "keyInformation" TEXT,
  "result" TEXT,
  "relatedForeshadowIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" VARCHAR(50) NOT NULL DEFAULT 'planned',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SceneCard_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SceneCard"
  ADD CONSTRAINT "SceneCard_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SceneCard"
  ADD CONSTRAINT "SceneCard_volumeId_fkey"
  FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SceneCard"
  ADD CONSTRAINT "SceneCard_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SceneCard"
  ADD CONSTRAINT "SceneCard_sceneNo_positive_check"
  CHECK ("sceneNo" IS NULL OR "sceneNo" > 0);

CREATE INDEX "SceneCard_project_status_updated_idx" ON "SceneCard"("projectId", "status", "updatedAt");
CREATE INDEX "SceneCard_project_volume_chapter_idx" ON "SceneCard"("projectId", "volumeId", "chapterId");
CREATE INDEX "SceneCard_project_chapter_scene_idx" ON "SceneCard"("projectId", "chapterId", "sceneNo");
CREATE INDEX "SceneCard_project_location_idx" ON "SceneCard"("projectId", "locationName");
CREATE UNIQUE INDEX "SceneCard_chapter_sceneNo_key" ON "SceneCard"("chapterId", "sceneNo");
