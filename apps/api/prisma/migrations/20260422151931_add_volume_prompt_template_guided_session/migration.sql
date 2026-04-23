-- AlterTable
ALTER TABLE "Character" ADD COLUMN     "activeFromChapter" INTEGER,
ADD COLUMN     "activeToChapter" INTEGER,
ADD COLUMN     "scope" VARCHAR(20),
ADD COLUMN     "source" VARCHAR(30) NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "ForeshadowTrack" ADD COLUMN     "scope" VARCHAR(20) NOT NULL DEFAULT 'chapter',
ADD COLUMN     "source" VARCHAR(30) NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "Volume" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "volumeNo" INTEGER NOT NULL,
    "title" VARCHAR(255),
    "synopsis" TEXT,
    "objective" TEXT,
    "chapterCount" INTEGER,
    "status" VARCHAR(50) NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "stepKey" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "userTemplate" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "effectPreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidedSession" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "currentStep" VARCHAR(50) NOT NULL,
    "stepData" JSONB NOT NULL DEFAULT '{}',
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidedSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Volume_projectId_volumeNo_key" ON "Volume"("projectId", "volumeNo");

-- CreateIndex
CREATE INDEX "PromptTemplate_stepKey_isDefault_idx" ON "PromptTemplate"("stepKey", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_projectId_stepKey_name_key" ON "PromptTemplate"("projectId", "stepKey", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GuidedSession_projectId_key" ON "GuidedSession"("projectId");

-- AddForeignKey
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidedSession" ADD CONSTRAINT "GuidedSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
