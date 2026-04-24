-- CreateTable
CREATE TABLE "LlmProvider" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "providerType" VARCHAR(50) NOT NULL DEFAULT 'openai_compatible',
    "baseUrl" VARCHAR(500) NOT NULL,
    "apiKey" TEXT NOT NULL,
    "defaultModel" VARCHAR(200) NOT NULL,
    "extraConfig" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmRouting" (
    "id" UUID NOT NULL,
    "appStep" VARCHAR(50) NOT NULL,
    "providerId" UUID NOT NULL,
    "modelOverride" VARCHAR(200),
    "paramsOverride" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmRouting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LlmRouting_appStep_key" ON "LlmRouting"("appStep");

-- AddForeignKey
ALTER TABLE "LlmRouting" ADD CONSTRAINT "LlmRouting_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "LlmProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
