# 多小说并行与召回链路改造 Task

> 最后更新：2026-05-01  
> 当前执行范围：P0（修稳现有召回链路）、P1（LLM Retrieval Planner）、P2（写入层增强）与 P4（召回缓存）已完成；P3 保持为后续计划。  
> 总原则：LLM 只规划召回需求，程序只注入数据库真实资料；召回层负责旧内容不丢，写入层负责新内容沉淀。

## 1. 目标与边界

### 目标

- 让章节写作 Prompt 中的 Lorebook 与 Memory 语义清晰，避免设定/记忆混排导致重复或误解。
- 建立 `ContextPack` 分层：`verifiedContext`、`userIntent`、`retrievalDiagnostics`。
- 为每条进入 Prompt 的召回内容保留来源追踪，便于排查“为什么塞进 Prompt”。
- 增强结构化日志，记录召回输入、命中数量、诊断、模型与 token 使用情况。

### 当前不做

- 不实现按 `projectId + chapterId` 的粗粒度召回缓存：已直接采用 `querySpec` hash，避免召回开关、Planner 查询或章节语义变化时误命中。
- 不实现完整异步队列：当前只保留同步链路日志与 job 追踪。
- 不直接让 LLM 决定 Prompt 事实：Planner 只输出查询意图，程序负责真实查询、校验、过滤和排序。
- 不扩展数据库 schema：P0 仅在服务层和 Prompt 构建层补齐语义与追踪。

## 2. 可追踪任务清单

### P0：修稳当前召回链路（本次执行）

- [x] P0-1 修正 Prompt 中 Lorebook / Memory 混用
  - 文件：`apps/api/src/modules/generation/generate-chapter.service.ts`
  - 验收：Prompt 的 `Lorebook` 区只使用 `retrievalBundle.lorebookHits`，`记忆召回` 区只使用 `retrievalBundle.memoryHits`。

- [x] P0-2 建立 `ContextPack` 概念
  - 文件：`apps/api/src/modules/generation/context-pack.types.ts`
  - 验收：上下文分为 `verifiedContext`、`userIntent`、`retrievalDiagnostics`；诊断默认不进入正文事实区。

- [x] P0-3 给召回结果加来源信息
  - 文件：`apps/api/src/modules/memory/retrieval.service.ts`
  - 验收：每条 `RetrievalHit` 包含 `projectId`、`searchMethod`、`reason`、`sourceTrace`；Memory 命中尽量携带来源章节信息。

- [x] P0-4 增强结构化日志
  - 文件：`apps/api/src/modules/memory/retrieval.service.ts`、`apps/api/src/modules/generation/generate-chapter.service.ts`
  - 验收：记录 `requestId`、`jobId`、`projectId`、`chapterId`、`stage`、`queryText`、召回开关、命中数量、诊断、耗时、模型与 token 使用情况。

- [x] P0-5 类型检查/构建验证
  - 命令：`pnpm --filter api build`
  - 验收：API TypeScript 构建通过。

### P1：LLM Retrieval Planner（本次执行）

- [x] 新增 `RetrievalPlannerService`，输入章节目标/冲突/大纲/用户指令/角色列表，输出严格 JSON。
- [x] 增加程序侧校验、数量限制、去重、空 query 过滤和 importance 校验。
- [x] 程序按 `projectId` 与 `chapterNo <= 当前章节号` 执行真实查询，防止串书与未来剧透。
- [x] 保留传统关键词/向量召回作为兜底，并合并重排。

### P2：写入层增强（后续）

- [x] 增强事实抽取：新人物、地点、道具、组织、规则、事件、伏笔、人物状态和关系变化。
- [x] 首次出现判断：已有则关联/更新，不存在则进入首次出现候选。
- [x] 重大设定、新势力、关键道具默认 `pending_review`，普通事件可 `auto`。
- [x] 写入 `MemoryChunk`、`StoryEvent`、`LorebookEntry` 候选和 `sourceTrace`。

### P3：异步队列与多小说并行（后续）

- [ ] API 创建 `GenerationJob` 后立即返回 `jobId`。
- [ ] 后台 runner 阶段化执行生成、后处理、润色、事实抽取、校验、记忆重建和复核。
- [ ] 支持全局并发、项目级并发、同章节互斥、优先级、失败重试和阶段恢复。
- [ ] 前端支持进度轮询或订阅。

### P4：召回缓存（本次执行）

- [x] 跳过简单版本：不落地 `projectId + chapterId` 粗粒度缓存，直接实现更安全的精确版本。
- [x] 精确版本：基于 `querySpec` hash 缓存，hash 输入包含章节目标、冲突、用户指令、Planner queries、召回开关和检索版本。
- [x] 明确禁止基于召回结果生成 hash，避免死循环设计。
- [x] 按 `projectId` 隔离缓存 key，并在召回日志、生成元数据中记录 `querySpecHash` 与 cache hit/miss。
- [x] Lorebook、Memory、结构化事实、引导写入和项目资料导入变化后清空项目级召回缓存。

## 3. P0 实施记录

- 新增 `ChapterContextPack`，明确 `verifiedContext` 才是可作为旧事实使用的资料。
- PromptBuilder 改为从 `contextPack.verifiedContext.lorebookHits/memoryHits` 构建区块，并加入上下文分层说明。
- `GenerateChapterService` 不再把 `rankedHits` 塞进 `memoryHits`，综合混排结果只保留在 `retrievalPayload.rankedHits` 便于排查。
- `RetrievalService` 为命中项补充 `searchMethod`、`reason` 和 `sourceTrace`，同时写入结构化召回日志。
- 章节生成链路补充召回阶段、LLM 阶段和草稿落库阶段日志。
- 已执行 `pnpm --filter api build`，API TypeScript 构建通过。

## 4. P1 实施记录

- 新增 `apps/api/src/modules/generation/retrieval-planner.service.ts`，由 LLM 生成章节级召回计划。
- 新增 `apps/api/src/modules/memory/retrieval-plan.types.ts`，定义 `RetrievalPlan`、`RetrievalPlanQuery`、`RetrievalPlannerDiagnostics`。
- Planner 输出只表达查询意图，程序侧会做截断、限流、去重、importance 合法性校验和失败兜底。
- `GenerateChapterService` 在召回前调用 Planner，并把 Planner 查询合并进传统召回 queryText、角色列表与 `plannerQueries`。
- `RetrievalService` 支持 Planner 查询加权，同时新增结构化事实召回：`StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack`。
- 结构化事实召回全部绑定 `projectId`，且涉及前文事实时使用 `chapterNo <= 当前章节号`，避免跨项目串书和未来剧透。
- Prompt 增加【结构化事实召回】区块；`retrievalDiagnostics` 记录 `retrievalPlan` 与 `plannerDiagnostics`，但未命中查询仍不作为事实进入正文区。
- 已执行 `pnpm --filter api build` 与 `git diff --check`，均通过。

## 5. P2 实施记录

- `FactExtractorService` 增加首次出现实体抽取与人物关系变化抽取：首次出现覆盖人物、地点、道具、组织、规则、设定；关系变化会转换为 `relationship_shift` 类型的 `StoryEvent`。
- 首次出现候选按 `projectId` 查询既有 `Character` 与 `LorebookEntry`：已有人物只补齐更早的 `activeFromChapter` 元数据，不存在的人物自动登记为 `auto_extracted`；非人物实体不存在时创建 Lorebook 候选。
- 写入策略已区分状态：普通首次出现可进入 `auto`，重大设定、新势力、关键规则/地点等进入 `pending_review`，避免未经确认污染硬事实。
- `MemoryWriterService` 支持 `firstAppearances`，统一写入 `first_appearance_*` 类型 `MemoryChunk`，并保留 `sourceTrace`、`entityType`、`significance`、`evidence`、`firstSeenChapterNo` 等元数据。
- 事实层批量写入使用 `createMany`，降低 interactive transaction 时间；测试 mock 已同步覆盖 `createMany` 与首次出现写入路径。
- 已执行 `pnpm --dir apps/api run test:agent`、`pnpm --filter api build` 与 `git diff --check`，均通过。

## 6. P4 实施记录

- `NovelCacheService` 新增 Redis-backed recall result 读写接口，缓存 key 形如 `ai_novel:project:{projectId}:recall:{querySpecHash}`，天然按项目隔离。
- `RetrievalService` 新增 `retrieveBundleWithCacheMeta`：先由章节语义、召回开关、角色、Planner queries 和检索版本构造 `querySpec`，再用稳定序列化 + SHA-256 生成 hash；`requestId/jobId` 不进入 hash，避免同一请求语义重复召回。
- 召回缓存只缓存真实查询后的 `RetrievalBundle`，命中时记录 `retrieval.bundle.cache_hit`，未命中写回时记录 `retrieval.bundle.completed` 中的 `cacheHit/cacheEnabled/querySpecHash/cacheError`。
- `GenerateChapterService` 将 `retrievalCache` 写入生成日志与 `retrievalPayload`，便于排查本次写作是否使用缓存以及对应 hash。
- 写入层失效已覆盖 `MemoryWriterService`、`MemoryReviewService`、`GuidedService`、`PersistWorldbuildingTool`、`PersistProjectAssetsTool`，确保 MemoryChunk、Lorebook、结构化项目资料或引导式写入变化后删除项目级召回缓存。
- 新增测试覆盖：相同语义但不同 `requestId` 命中同一缓存；召回开关或 Planner query 变化会生成不同 hash；世界观写入会触发项目级召回缓存失效。
- 已执行 `pnpm --dir apps/api run test:agent`、`pnpm --filter api build` 与 `git diff --check`，均通过；`git diff --check` 仅提示 `guided.service.ts` 未来可能 LF/CRLF 转换，无空白错误。

## 7. 风险与注意事项

- Prompt 中加入来源标签会增加少量 token，但换来可追踪性；如果后续发现影响正文风格，可改为仅写入 `promptDebug/retrievalPayload`。
- P0 没有改变数据库 schema；如果后续需要持久化更完整的来源追踪，可以新增专用审计表或扩展 `GenerationJob.retrievalPayload` 查询视图。
- 当前同步链路仍不适合大规模并行，P3 队列化前应限制批量生成规模。
- P1 的 Planner 已有确定性兜底；当 LLM 不可用时不会阻断生成，但召回规划质量会退回章节目标/冲突驱动。
- 当前 Planner 校验为手写结构归一化与限流，未引入第三方 JSON Schema 库；如后续需要更严格 schema，可增加轻量校验器或使用现有 validation 工具链。
- P2 的首次出现来自 LLM 抽取，仍需依赖 `pending_review` 与后续人工/自动复核；不要把重大候选直接视为已确认硬事实。
- P4 召回缓存依赖写入路径主动失效；后续新增任何会改变 Lorebook、MemoryChunk、StoryEvent、CharacterStateSnapshot、ForeshadowTrack 或章节语义的写入入口，都必须同步调用项目级召回缓存失效。