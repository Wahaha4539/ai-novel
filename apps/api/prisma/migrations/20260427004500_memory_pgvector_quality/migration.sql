CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "MemoryChunk"
  ADD COLUMN IF NOT EXISTS "embeddingVector" vector;

UPDATE "MemoryChunk"
   SET "embeddingVector" = embedding::text::vector
 WHERE embedding IS NOT NULL
   AND "embeddingVector" IS NULL;

CREATE INDEX IF NOT EXISTS "MemoryChunk_project_status_idx"
  ON "MemoryChunk" ("projectId", status);

CREATE INDEX IF NOT EXISTS "MemoryChunk_embeddingVector_hnsw_idx"
  ON "MemoryChunk" USING hnsw ("embeddingVector" vector_cosine_ops)
  WHERE "embeddingVector" IS NOT NULL;