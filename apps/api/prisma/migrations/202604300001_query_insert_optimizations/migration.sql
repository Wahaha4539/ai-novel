-- 高频查询索引：覆盖章节草稿当前版本、任务队列、校验问题、提示词模板和 Guided 批量写入相关过滤。
CREATE INDEX IF NOT EXISTS "ChapterDraft_chapter_current_version_idx"
  ON "ChapterDraft"("chapterId", "isCurrent", "versionNo");

-- 写入唯一当前草稿前先修复历史异常数据：同一章节只保留最高版本的 current 草稿。
WITH ranked_current_drafts AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "chapterId" ORDER BY "versionNo" DESC, "createdAt" DESC, id DESC) AS rn
  FROM "ChapterDraft"
  WHERE "isCurrent" = TRUE
)
UPDATE "ChapterDraft" AS draft
   SET "isCurrent" = FALSE
  FROM ranked_current_drafts AS ranked
 WHERE draft.id = ranked.id
   AND ranked.rn > 1;

-- Prisma schema 不能表达 partial unique index；该约束在数据库侧保证每章最多一个当前草稿。
CREATE UNIQUE INDEX IF NOT EXISTS "ChapterDraft_one_current_per_chapter_uidx"
  ON "ChapterDraft"("chapterId")
  WHERE "isCurrent" = TRUE;

CREATE INDEX IF NOT EXISTS "GenerationJob_status_created_idx"
  ON "GenerationJob"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "GenerationJob_active_lookup_idx"
  ON "GenerationJob"("projectId", "jobType", "targetType", "targetId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "ValidationIssue_project_status_created_idx"
  ON "ValidationIssue"("projectId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "ValidationIssue_chapter_status_created_idx"
  ON "ValidationIssue"("chapterId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "PromptTemplate_project_step_default_idx"
  ON "PromptTemplate"("projectId", "stepKey", "isDefault");

CREATE INDEX IF NOT EXISTS "Character_project_source_scope_idx"
  ON "Character"("projectId", "source", "scope");

CREATE INDEX IF NOT EXISTS "ForeshadowTrack_project_source_idx"
  ON "ForeshadowTrack"("projectId", "source");

CREATE INDEX IF NOT EXISTS "StoryEvent_project_chapter_draft_idx"
  ON "StoryEvent"("projectId", "chapterId", "sourceDraftId");

CREATE INDEX IF NOT EXISTS "CharacterStateSnapshot_project_chapter_draft_idx"
  ON "CharacterStateSnapshot"("projectId", "chapterId", "sourceDraftId");

CREATE INDEX IF NOT EXISTS "ForeshadowTrack_project_chapter_draft_idx"
  ON "ForeshadowTrack"("projectId", "chapterId", "sourceDraftId");

CREATE INDEX IF NOT EXISTS "MemoryChunk_project_status_rank_idx"
  ON "MemoryChunk"("projectId", "status", "importanceScore", "recencyScore", "updatedAt");

-- JSON path 条件在事实/记忆替换链路中很高频；表达式索引避免随着自动产物增长退化为全表扫描。
CREATE INDEX IF NOT EXISTS "MemoryChunk_project_source_generatedBy_idx"
  ON "MemoryChunk"("projectId", "sourceType", "sourceId", (("metadata"->>'generatedBy')));

CREATE INDEX IF NOT EXISTS "StoryEvent_project_chapter_draft_generatedBy_idx"
  ON "StoryEvent"("projectId", "chapterId", "sourceDraftId", (("metadata"->>'generatedBy')));

CREATE INDEX IF NOT EXISTS "CharacterStateSnapshot_project_chapter_draft_generatedBy_idx"
  ON "CharacterStateSnapshot"("projectId", "chapterId", "sourceDraftId", (("metadata"->>'generatedBy')));

CREATE INDEX IF NOT EXISTS "ForeshadowTrack_project_chapter_draft_generatedBy_idx"
  ON "ForeshadowTrack"("projectId", "chapterId", "sourceDraftId", (("metadata"->>'generatedBy')));

-- AgentRun 的 clientRequestId 仍存放在 input JSON 中；表达式索引为创建计划幂等查询提供兜底加速。
CREATE INDEX IF NOT EXISTS "AgentRun_project_clientRequestId_idx"
  ON "AgentRun"("projectId", (("input"->>'clientRequestId')))
  WHERE "input" ? 'clientRequestId';