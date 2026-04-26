# generate_chapter 时序草图

> 历史说明：旧版时序曾由 API 调用 Worker `/internal/jobs/generate-chapter`。当前 Agent-Centric Backend Monolith 架构已改为 API 内同步 Service 链路，Worker 只作为参考实现保留。

```text
用户请求生成章节
  ↓
API 创建 generation_job / 或 AgentRun
  ↓
API 内同步调用 GenerateChapterService
  ↓
GenerateChapterService 读取 project / chapter / volumes / characters / lorebook / memory
  ↓
召回 lorebook + memory，并做 rerank/compress
  ↓
precheck：检查章节目标、硬事实是否存在
  ↓
Prompt Builder 读取模板并组装 prompt
  ↓
API 内 LLM Gateway 生成正文
  ↓
摘要 / 事件 / 状态 / 伏笔提取
  ↓
后置校验，生成 validation issues
  ↓
记忆回写对象组装
  ↓
PostProcess / FactExtractor / Validation / MemoryRebuild / MemoryReview 在 API 内继续同步执行
  ↓
返回 draftId + summary + retrievalPayload + validationIssues + memoryReview
```

## 下一步落地建议

1. 继续补齐 Planner schema 修复重试、LLM 调用计数和失败原因结构化回显。
2. 推进 pgvector SQL 检索优化与召回质量评测，减少应用层全量向量扫描。
3. 如果单次同步请求耗时过长，再评估流式响应或分步提交，但不恢复 Worker 主链路依赖。
