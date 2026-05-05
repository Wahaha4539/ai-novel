-- Phase 3: project-level generation profile for longform quality controls.
CREATE TABLE "GenerationProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "defaultChapterWordCount" INTEGER,
  "autoContinue" BOOLEAN NOT NULL DEFAULT false,
  "autoSummarize" BOOLEAN NOT NULL DEFAULT true,
  "autoUpdateCharacterState" BOOLEAN NOT NULL DEFAULT true,
  "autoUpdateTimeline" BOOLEAN NOT NULL DEFAULT false,
  "autoValidation" BOOLEAN NOT NULL DEFAULT true,
  "allowNewCharacters" BOOLEAN NOT NULL DEFAULT false,
  "allowNewLocations" BOOLEAN NOT NULL DEFAULT true,
  "allowNewForeshadows" BOOLEAN NOT NULL DEFAULT true,
  "preGenerationChecks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "promptBudget" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GenerationProfile_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GenerationProfile"
  ADD CONSTRAINT "GenerationProfile_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GenerationProfile_projectId_key" ON "GenerationProfile"("projectId");
