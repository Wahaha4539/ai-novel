CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "MemoryChunk"
  ADD COLUMN IF NOT EXISTS "embeddingVector" vector;

-- HNSW 索引要求列必须有固定维度；当前默认 bge-base-zh 输出 768 维。
-- 若失败重跑时曾留下无维度列或非 768 维向量，先清空不兼容值再收敛列类型。
UPDATE "MemoryChunk"
   SET "embeddingVector" = NULL
 WHERE "embeddingVector" IS NOT NULL
   AND vector_dims("embeddingVector") <> 768;

ALTER TABLE "MemoryChunk"
  ALTER COLUMN "embeddingVector" TYPE vector(768)
  USING "embeddingVector"::vector(768);

UPDATE "MemoryChunk"
   SET "embeddingVector" = embedding::text::vector(768)
 WHERE embedding IS NOT NULL
   AND "embeddingVector" IS NULL
   AND jsonb_typeof(embedding::jsonb) = 'array'
   AND jsonb_array_length(embedding::jsonb) = 768;

CREATE INDEX IF NOT EXISTS "MemoryChunk_project_status_idx"
  ON "MemoryChunk" ("projectId", status);

CREATE INDEX IF NOT EXISTS "MemoryChunk_embeddingVector_hnsw_idx"
  ON "MemoryChunk" USING hnsw ("embeddingVector" vector_cosine_ops)
  WHERE "embeddingVector" IS NOT NULL;