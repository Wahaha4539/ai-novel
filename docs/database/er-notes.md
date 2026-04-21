# 数据库说明（MVP）

当前 Prisma schema 已覆盖以下核心对象：

- `projects`
- `style_profiles`
- `model_profiles`
- `characters`
- `lorebook_entries`
- `chapters`
- `chapter_drafts`
- `memory_chunks`
- `validation_issues`
- `generation_jobs`

## 说明

1. `memory_chunks.embedding` 在 Prisma 中以 `Unsupported("vector")` 表示，真正 migration 时建议用 SQL 手动创建。
2. `volumes / scenes / foreshadows / story_events` 暂未进入这版最小 schema，可在下一轮补齐。
3. 当前 API 使用内存 store；Prisma schema 主要作为后续真实存储的开发锚点。
