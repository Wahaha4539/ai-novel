# AI 长篇小说质量保障系统任务文档

> 最后更新：2026-05-05  
> 状态：Phase 6 Agent 工作流增强已完成，已覆盖 Story Bible、关系/时间线闭环与 Agent Eval 长篇质量用例
> 对应设计：`docs/architecture/longform-quality-system-design.md`  
> 明确排除：`apps/worker` 已弃用，所有任务不得把它作为实现目标或验收条件。

## 1. 总目标

围绕长篇小说质量，补齐以下能力：

1. 让世界观、力量体系、势力、地点、物品、禁忌规则成为可编辑、可召回、可审核的 Story Bible。
2. 让角色关系、时间线、人物状态成为生成前后的连续性约束。
3. 让生成链路在写正文前检索这些资料，在写完后更新事实层并检查矛盾。
4. 让用户能在前端看到、编辑和追踪这些资料，而不是只依赖 Prompt 文本。

## 2. 里程碑

| 里程碑 | 范围 | 验收信号 |
|---|---|---|
| LQ-M1 | 设定资产和写作目标最小闭环 | 用户能编辑创作定位、世界设定、势力、地点、物品、规则；生成章节时能召回这些资料 |
| LQ-M2 | 连续性核心 | 用户能编辑角色关系、时间线、写作约束；生成前能发现死亡角色、提前泄密、时间线错误 |
| LQ-M3 | 生成策略接入 | 项目级生成配置能影响生成、事实抽取和新增实体权限 |
| LQ-M4 | 场景/节奏/模板 | 用户能管理场景库、章节模板、情绪曲线，并注入章节生成 |
| LQ-M5 | 质量报告 | 生成后形成可追踪 QualityReport，支持趋势查看和 AI 审稿 |

## 3. Phase 0：准备与边界固化

目标：避免后续开发误接弃用链路，建立统一任务边界。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| LQ-P0-01 | done | 在开发文档和任务文档中明确 `apps/worker` 弃用 | `docs/architecture/*` | 文档已写明不依赖 worker |
| LQ-P0-02 | done | 给现有 `overview.md` 增补一句 worker 弃用说明，避免新开发者误用 | `docs/architecture/overview.md` | 文档说明与当前架构一致 |
| LQ-P0-03 | done | 梳理现有测试命令和验收命令 | `docs/architecture/longform-quality-system-development-plan.md` | 每个 Phase 有构建/测试验收 |

验收命令：

```bash
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
```

## 4. Phase 1：Story Bible 与创作目标层

目标：优先落地世界观、势力、地点、物品、力量体系、禁忌规则的统一管理入口，并补齐项目创作定位。

### 后端

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P1-01 | done | 新增 `ProjectCreativeProfile` Prisma model | `apps/api/prisma/schema.prisma`、migration | 无 | Prisma generate/build 通过；每个 Project 可 upsert profile |
| LQ-P1-02 | done | `LorebookEntry` 新增 `metadata Json @default("{}")` | `apps/api/prisma/schema.prisma`、migration | 无 | 旧数据 migration 后 metadata 默认为 `{}` |
| LQ-P1-03 | done | 新增 `creative-profile` API | `apps/api/src/modules/projects/*` 或新模块 | LQ-P1-01 | `GET/PATCH /projects/:projectId/creative-profile` 可用 |
| LQ-P1-04 | done | 补齐 Lorebook list/update/delete API | `apps/api/src/modules/lorebook/*` | LQ-P1-02 | 支持按 `entryType/status/tag` 查询，更新后清召回缓存 |
| LQ-P1-05 | done | 定义统一 Story Bible entryType 常量和 DTO 校验 | `apps/api/src/modules/lorebook/*`、`packages/shared-types` | LQ-P1-02 | entryType 包含 world_rule/power_system/faction/location/item 等 |
| LQ-P1-06 | done | 更新 `RetrievalService.retrieveLorebook`，metadata 进入召回 hit | `apps/api/src/modules/memory/retrieval.service.ts` | LQ-P1-02 | 召回结果 metadata 带 entryType、priority、custom metadata |
| LQ-P1-07 | done | 更新 `FactExtractorService` 首次出现候选，写入 metadata | `apps/api/src/modules/facts/fact-extractor.service.ts` | LQ-P1-02 | location/item/faction/rule 首次出现保留 firstSeenChapterNo/evidence/significance |
| LQ-P1-08 | done | 写单元/服务级测试覆盖 Lorebook metadata 与缓存失效 | `apps/api/src/modules/agent-runs/agent-services.spec.ts` 或新增测试 | LQ-P1-04 | `pnpm --filter api test:agent` 通过 |

### 前端

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P1-09 | done | 扩展 `ActiveView` 与侧边栏，新增 `Story Bible`、`Generation Config` 初始入口 | `apps/web/app/page.tsx`、`WorkspaceSidebar.tsx` | 无 | 导航可切换，不破坏现有视图 |
| LQ-P1-10 | done | 新增 `StoryBiblePanel`，用 tabs 管理世界观/力量/势力/地点/物品/历史/规则 | `apps/web/components/StoryBiblePanel.tsx` | LQ-P1-04 | 可按 entryType 列表、新增、编辑、删除 |
| LQ-P1-11 | done | 新增 `CreativeProfilePanel` 或集成到项目设置 | `apps/web/components/*`、`hooks/*` | LQ-P1-03 | 可编辑读者定位、平台定位、爽点、节奏、字数、分级、核心冲突 |
| LQ-P1-12 | done | `WorldviewEditor` 从 `Project.synopsis` 迁移为 Story Bible 世界观入口 | `apps/web/components/WorldviewEditor.tsx`、`LorePanel.tsx` | LQ-P1-10 | 旧 synopsis 仍展示，新增世界观写入 Lorebook |
| LQ-P1-13 | done | 前端类型补齐 LorebookEntry metadata 与 CreativeProfile | `apps/web/types/*` | LQ-P1-03/P1-04 | TypeScript build 通过 |

验收命令：

```bash
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
```

完成记录（2026-05-05）：

- 已落地 `ProjectCreativeProfile`、`LorebookEntry.metadata` 与 migration `202605050001_longform_quality_phase1`。
- 已新增 `GET/PATCH /projects/:projectId/creative-profile` 与项目作用域 Lorebook list/update/delete API；Lorebook 写入、更新、删除均会清理项目级召回缓存。
- `ProjectCreativeProfile.chapterWordCount` 已作为章节生成默认字数兜底接入；完整 GenerationProfile 策略仍留到 Phase 3。
- 已让 Lorebook metadata 进入 `RetrievalService` hit，并让首次出现的 location/item/faction/rule 候选写入 firstSeenChapterNo/evidence/significance 等 metadata。
- 已新增 Story Bible 与 Generation Config 前端入口、`StoryBiblePanel`、`CreativeProfilePanel`，并保留 `Project.synopsis` 旧世界观展示，同时支持写入 Story Bible。
- 验证通过：`pnpm db:generate`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`。

## 5. Phase 2：写作约束、角色关系、时间线

目标：补齐长篇最容易出错的三类连续性约束。

### 数据模型与 API

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P2-01 | done | 新增 `WritingRule` model + migration | `apps/api/prisma/schema.prisma` | Phase 1 migration 完成 | 支持 ruleType/severity/chapter range/status/metadata |
| LQ-P2-02 | done | 新增 `RelationshipEdge` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持公开关系、隐藏关系、冲突点、转折章节 |
| LQ-P2-03 | done | 新增 `TimelineEvent` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持 knownBy/unknownBy/isPublic/eventStatus |
| LQ-P2-04 | done | 新增 WritingRulesModule CRUD | `apps/api/src/modules/writing-rules/*` | LQ-P2-01 | create/list/update/delete 可用，写入清召回缓存 |
| LQ-P2-05 | done | 新增 RelationshipsModule CRUD | `apps/api/src/modules/relationships/*` | LQ-P2-02 | 可按角色名/章节范围筛选 |
| LQ-P2-06 | done | 新增 TimelineModule CRUD | `apps/api/src/modules/timeline/*` | LQ-P2-03 | 可按 chapterNo/eventStatus/knownBy 筛选 |
| LQ-P2-07 | done | 更新 `AppModule` 注册新模块 | `apps/api/src/app.module.ts` | P2 modules | API build 通过 |

### 召回与校验

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P2-08 | done | `RetrievalService` 新增 relationship/timeline/rule 结构化召回 | `apps/api/src/modules/memory/retrieval.service.ts` | P2 API/model | `structuredHits` 包含新 sourceType |
| LQ-P2-09 | done | `RetrievalPlannerService` 输出 writingRule/timeline 查询意图 | `apps/api/src/modules/generation/retrieval-planner.service.ts` | LQ-P2-08 | Planner JSON 归一化包含新增 query 类型 |
| LQ-P2-10 | done | `PromptBuilderService` 新增【人物关系网】【时间线】【写作约束】区块 | `apps/api/src/modules/generation/prompt-builder.service.ts` | LQ-P2-08 | 章节 Prompt 注入相关命中并保留 sourceTrace |
| LQ-P2-11 | done | `ValidationService` 增加写作规则硬校验框架 | `apps/api/src/modules/validation/validation.service.ts` | LQ-P2-01 | active error 级规则可生成 ValidationIssue |
| LQ-P2-12 | done | 实现死亡角色/不可出场规则检查 | `ValidationService` | LQ-P2-11 | 已死亡角色正常出场产生 error/warning |
| LQ-P2-13 | done | 实现提前泄密/知情范围检查 | `ValidationService` | LQ-P2-03/P2-11 | 角色知道 unknownBy 事件产生 issue |
| LQ-P2-14 | done | 实现时间线顺序和位置冲突基础检查 | `ValidationService` | LQ-P2-03 | 同角色同时间多地点产生 warning |

### 前端

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P2-15 | done | 新增 `WritingRulesPanel` | `apps/web/components/*` | LQ-P2-04 | 可编辑禁忌规则、严重级别、章节范围 |
| LQ-P2-16 | done | 新增 `RelationshipMapPanel` | `apps/web/components/*` | LQ-P2-05 | 可查看/编辑人物关系边和隐藏关系 |
| LQ-P2-17 | done | 新增 `TimelinePanel` | `apps/web/components/*` | LQ-P2-06 | 可编辑事件、发生时间、地点、知情角色 |
| LQ-P2-18 | done | 新增全局 `CharacterStatePanel` | `apps/web/components/*`、`useDashboardData.ts` | 现有 CharacterStateSnapshot API | 可按角色展示当前状态、历史状态、死亡/失踪 |
| LQ-P2-19 | done | 侧边栏接入 Rules/Relationships/Timeline/State | `WorkspaceSidebar.tsx`、`page.tsx` | P2 panels | 导航和状态持久化正常 |

验收命令：

```bash
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
```

完成记录（2026-05-05）：

- 已完成 `LQ-P2-01 ~ LQ-P2-19`，落地 `WritingRule`、`RelationshipEdge`、`TimelineEvent` 与 migration `202605050002_longform_quality_phase2_core`。
- 新增 API：`GET/POST/PATCH/DELETE /projects/:projectId/writing-rules`、`/projects/:projectId/relationships`、`/projects/:projectId/timeline-events`；所有写入口均按 projectId 隔离，并调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。
- `WritingRule` 增加章节范围校验与 DB check constraint，避免 from/to 倒置导致硬规则静默失效；`RelationshipEdge` 对 `characterAId/characterBId` 做项目内角色校验和 ID/name 一致性校验；`TimelineEvent.chapterNo` 会解析到项目章节，避免跨项目或悬空引用。
- `RetrievalService` 新增 `relationship_edge`、`timeline_event`、`writing_rule` 结构化命中，并按 `chapterNo` 过滤未来 Memory/Relationship/Timeline 信息；`sourceTrace` 保留可追踪来源。
- `RetrievalPlannerService` 输出 timeline/writingRule 查询意图；`PromptBuilderService` 注入【人物关系网】【时间线与知情范围】【写作约束】区块；`ValidationService` 实现写作规则、死亡角色、提前泄密、时间线顺序/位置冲突的确定性校验。
- 前端新增 `WritingRulesPanel`、`RelationshipMapPanel`、`TimelinePanel`、`CharacterStatePanel`，并接入 `ActiveView`、`ACTIVE_VIEWS`、`localStorage` 状态恢复、`WorkspaceSidebar` 和 `page.tsx` 主视图渲染分支。
- Reviewer 发现的倒置章节范围、`entityRef` 误当禁用词、前端 PATCH 无法清空可空字段、关系 ID/name 不一致问题已修复，并补充服务级回归测试。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm --filter api test:agent`（101 项）、`pnpm --filter api build`、`pnpm --filter web build`、`git diff --check`。其中 `web build` 首次因 Next dev server 占用 `.next/trace` 失败，停止该验证进程并清理 `.next` 后重跑通过。

## 6. Phase 3：生成配置与生成链路接入

目标：让项目级生成策略控制 AI 是否能新增实体、是否自动总结、是否自动更新时间线和状态。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P3-01 | done | 新增 `GenerationProfile` model + migration | `apps/api/prisma/schema.prisma` | Phase 1 | 支持新增实体权限、自动流程开关、promptBudget |
| LQ-P3-02 | done | 新增 `generation-profile` API | `apps/api/src/modules/generation-profile/*` | LQ-P3-01 | GET/PATCH 可用 |
| LQ-P3-03 | done | `GenerateChapterService` 读取 GenerationProfile | `apps/api/src/modules/generation/generate-chapter.service.ts` | LQ-P3-02 | generationContext 记录 profile snapshot |
| LQ-P3-04 | done | Preflight 接入 allowNewCharacters/Locations/Foreshadows | `GenerateChapterService`、`ValidationService` | LQ-P3-03 | 禁止新增时，新增候选进入 warning/blocker |
| LQ-P3-05 | done | `FactExtractorService` 按 GenerationProfile 决定 auto/pending_review | `apps/api/src/modules/facts/fact-extractor.service.ts` | LQ-P3-03 | 禁止自动新增角色时只创建 pending_review |
| LQ-P3-06 | done | `runAutoMaintenance` 前端展示项目级自动流程开关 | `apps/web/hooks/useDashboardData.ts`、`GenerationConfigPanel` | LQ-P3-02 | 用户能配置是否自动总结/校验/更新时间线 |
| LQ-P3-07 | done | 更新 PromptBuilder 区分“允许新增候选”和“禁止新增事实” | `PromptBuilderService` | LQ-P3-03 | Prompt 明确新增边界 |
| LQ-P3-08 | done | 服务级测试覆盖生成配置 | `agent-services.spec.ts` | LQ-P3-04 | test:agent 通过 |

验收命令：

```bash
pnpm db:generate
pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

完成记录（2026-05-05）：

- 已完成 `LQ-P3-01 ~ LQ-P3-08`，落地项目一对一 `GenerationProfile` 与 migration `202605050003_longform_quality_phase3_generation_profile`。
- 新增 API：`GET/PATCH /projects/:projectId/generation-profile`；PATCH 采用 upsert 风格，写入后调用 `NovelCacheService.deleteProjectRecallResults(projectId)` 清理项目级召回缓存。
- `GenerateChapterService` 已读取 GenerationProfile 并写入 `generationContext.generationProfile`、`retrievalPayload.generationProfile` 与 `contextPack.generationProfile`；章节目标字数优先级为调用输入、章节期望字数、`ProjectCreativeProfile.chapterWordCount`、`GenerationProfile.defaultChapterWordCount`、默认 3500。
- Preflight 已接入 `allowNewCharacters`、`allowNewLocations`、`allowNewForeshadows` 的确定性新增候选检查；默认给出 warning，`preGenerationChecks` 配置阻断模式时升级为 blocker。
- `FactExtractorService` 已按 GenerationProfile 将被禁止的新角色、地点、伏笔候选降级为 `pending_review`；禁止新增角色时不直接创建 `Character`，保留到待复核记忆/候选链路。
- `PromptBuilderService` 新增【新增事实策略】区块，区分“允许新增候选”和“禁止新增事实”，避免把用户意图或 Planner 未命中查询提升为既有事实。
- 前端 `GenerationConfigPanel` 已接入生成配置 GET/PATCH，支持自动流程开关、新增实体权限、默认字数和 JSON 配置；`generation-config` 已在 `ActiveView`、`ACTIVE_VIEWS`、localStorage 恢复校验、`WorkspaceSidebar` 与 `page.tsx` 主渲染分支中可用。
- Tester 覆盖了 GenerationProfile 默认/upsert/缓存失效、生成字数兜底、Preflight 新实体 warning/blocker、FactExtractor 禁止新增角色、PromptBuilder 新增事实边界；`pnpm --filter api test:agent` 通过 106 项，未发现未修复问题。
- Reviewer 子 Agent 两次超时未返回；主控按高风险清单复核了 projectId 隔离、召回缓存失效、schema/migration 一致性、profile snapshot、pending_review 语义、前端 view 接入和 `apps/worker` 边界，未发现阻断问题。保留后续可扩展项：Phase 4 可继续把场景/节奏/模板纳入同一 profile snapshot 与 prompt budget 策略。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm --filter api test:agent`、`pnpm --filter api build`、`pnpm --filter web build`、`git diff --check`。

## 7. Phase 4：场景库、章节模板、节奏曲线

目标：提升章节正文可执行度和长篇节奏稳定性。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P4-01 | done | 新增 `SceneCard` model + migration | `apps/api/prisma/schema.prisma` | Phase 2 | 支持 chapterId/sceneNo/participants/conflict/result |
| LQ-P4-02 | done | 新增 `ChapterPattern` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持模板类型、结构字段、适用场景 |
| LQ-P4-03 | done | 新增 `PacingBeat` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持每章情绪强度、张力、爆点类型 |
| LQ-P4-04 | done | 新增 Scenes CRUD API | `apps/api/src/modules/scenes/*` | LQ-P4-01 | 可按 volume/chapter 查询 |
| LQ-P4-05 | done | 新增 ChapterPatterns CRUD API | `apps/api/src/modules/chapter-patterns/*` | LQ-P4-02 | 可创建升级章/战斗章/揭秘章等模板 |
| LQ-P4-06 | done | 新增 Pacing CRUD API | `apps/api/src/modules/pacing-beats/*` | LQ-P4-03 | 可批量更新章节节奏 |
| LQ-P4-07 | done | Guided 章节细纲生成读取章节模板和节奏目标 | `GuidedService`、Agent guided tools | LQ-P4-05/P4-06 | 生成章节时 craftBrief 更贴合模板 |
| LQ-P4-08 | done | 正文 Prompt 注入本章场景卡 | `PromptBuilderService` | LQ-P4-04 | 本章 SceneCard 进入【场景执行】区块 |
| LQ-P4-09 | done | 新增 `SceneBankPanel` | `apps/web/components/*` | LQ-P4-04 | 可维护场景库 |
| LQ-P4-10 | done | 新增 `PacingPanel` | `apps/web/components/*` | LQ-P4-06 | 可视化每章情绪强度和爆点类型 |
| LQ-P4-11 | done | 新增 `ChapterPatternPanel` | `apps/web/components/*` | LQ-P4-05 | 可维护模板库 |

验收命令：

```bash
pnpm db:generate
pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

完成记录（2026-05-05）：

- 已完成 `LQ-P4-01`，落地 `SceneCard` 与 migration `202605050004_longform_quality_phase4_scene_card`；字段覆盖 `chapterId`、`volumeId`、`sceneNo`、`participants`、`conflict`、`result`、`relatedForeshadowIds`、`metadata` 等场景执行卡信息。
- `SceneCard` 已挂接 `Project.sceneCards`、`Volume.sceneCards`、`Chapter.sceneCards`；项目删除级联清理场景卡，卷/章节删除时保留场景卡并将引用置空。
- 根据 code_mapper 复核建议，已补充同章节 `sceneNo` 唯一索引与 `sceneNo > 0` 的数据库 check constraint，降低同章场景编号重复和非法编号风险。
- 本任务只完成数据模型与迁移；尚未新增 Scenes CRUD API、召回注入或前端面板，因此无新增 API、无前端入口变化，也暂未触发召回缓存失效逻辑。
- Tester 复核认为 LQ-P4-01 仅 schema/migration 时无需补 `agent-services` 业务测试；后续 `LQ-P4-04` 接入 API 或召回后必须补服务级测试并在写入口调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`、`git diff --check`。
- 额外尝试 `pnpm db:migrate` 与 `pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma`，本地均在 Prisma schema engine 阶段返回空的 `Schema engine error`，DEBUG 输出未给出 P-code；记录为本机 Prisma/DB 迁移环境阻塞，未发现 schema validate 或 build/test 层面的代码问题。
- 已完成 `LQ-P4-02` 与 `LQ-P4-03`，落地 `ChapterPattern`、`PacingBeat` 与 migration `202605050005_longform_quality_phase4_patterns_pacing`；`ChapterPattern` 支持 `patternType`、`name`、`applicableScenes`、`structure`、`pacingAdvice`、`emotionalAdvice`、`conflictAdvice`、`metadata`，`PacingBeat` 支持 `volumeId`、`chapterId`、`chapterNo`、`beatType`、`emotionalTone`、`emotionalIntensity`、`tensionLevel`、`payoffLevel`、`notes`、`metadata`。
- `ChapterPattern` 已挂接 `Project.chapterPatterns`；`PacingBeat` 已挂接 `Project.pacingBeats`、`Volume.pacingBeats`、`Chapter.pacingBeats`。项目删除级联清理，卷/章节删除时保留节奏记录并置空引用。
- migration 已补充 `ChapterPattern` JSON 类型 check（`applicableScenes` 必须为 array，`structure`、advice 与 `metadata` 必须为 object），以及 `PacingBeat.chapterNo > 0`、`emotionalIntensity/tensionLevel/payoffLevel` 取值 `0~100` 的数据库 check；三项强度默认值为 `50`。
- Docker Compose 复核：启动 `docker compose up -d` 后，本地 PostgreSQL 依赖恢复，`pnpm db:migrate` 成功应用 migration `202605050005_longform_quality_phase4_patterns_pacing`，`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 `Database schema is up to date!`；上一轮空 `Schema engine error` 判定为本地依赖未启动导致的环境问题。
- 新增 API：无。本组任务只完成数据模型与 migration，`Scenes`、`ChapterPatterns`、`Pacing` CRUD 仍在 `LQ-P4-04 ~ LQ-P4-06`。
- 前端入口变化：无。`SceneBankPanel`、`PacingPanel`、`ChapterPatternPanel` 仍在 `LQ-P4-09 ~ LQ-P4-11`。
- Tester 复核通过：schema/migration 字段一致，`PacingBeat` 默认值和范围约束符合要求；指出跨项目 `volumeId/chapterId` 一致性与 `chapterNo/chapterId` 一致性需要在后续 CRUD service 校验。
- Reviewer 复核通过：未发现 high/medium 阻塞；提醒后续 `ChapterPattern/PacingBeat` 写入口进入召回或 Prompt 后必须调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。
- 额外 DB smoke test 通过：在事务内验证 `PacingBeat` 三项强度默认值为 `50`、`emotionalIntensity=101` 被 range check 拒绝、`ChapterPattern.applicableScenes` 非 array 被 JSON 类型 check 拒绝，并已 `ROLLBACK`。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm db:migrate`、`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`（106 项）、`git diff --check`（仅 Windows 行尾提示，无 whitespace error）。
- 已完成 `LQ-P4-04 ~ LQ-P4-06`，新增 `ScenesModule`、`ChapterPatternsModule`、`PacingBeatsModule` 并注册到 `AppModule`；三类资源均提供 create/list/update/delete 服务和 DTO 校验。
- 新增 API：`GET/POST /projects/:projectId/scenes`、`PATCH/DELETE /projects/:projectId/scenes/:sceneId`；`GET/POST /projects/:projectId/chapter-patterns`、`PATCH/DELETE /projects/:projectId/chapter-patterns/:patternId`；`GET/POST /projects/:projectId/pacing-beats`、`PATCH/DELETE /projects/:projectId/pacing-beats/:beatId`。
- Scenes CRUD 支持按 `volumeId`、`chapterId`、`chapterNo`、`status` 查询；写入时校验 `volumeId/chapterId` 属于当前项目，且两者同时传入时校验 `chapter.volumeId === volumeId`。ChapterPatterns CRUD 支持按 `patternType/status/q` 查询。PacingBeats CRUD 支持按 `volumeId`、`chapterId`、`chapterNo`、`beatType` 查询，并校验 `chapterId/chapterNo/volumeId` 与当前项目一致。
- 所有 Phase 4 CRUD 写入口 create/update/delete 均调用 `NovelCacheService.deleteProjectRecallResults(projectId)`；本组未新增 Agent Tool，未改变 `requiresApproval` 或 Plan/Act 审批边界。
- Reviewer 发现 JSON object 字段 PATCH `null` 会被 `@IsOptional()` 漏过、数组字段非字符串元素会被静默过滤；已改为 DTO 层 `ValidateIf(value !== undefined)` + `@IsString({ each: true })`，并在 service 层增加 `normalizeJsonObject`/`normalizeStringArray` runtime 防线。后续复核还发现 `GenerationProfile` 存在同类历史问题，也已同步修复。
- Tester 复核最初指出跨项目/错引用负向测试不充分；已补充 `ScenesService`、`ChapterPatternsService`、`PacingBeatsService` 的项目不存在、非法 volume/chapter/chapterNo、JSON null、非字符串数组、强度越界等服务级测试，并新增 `AppModule` compile smoke 验证模块注册。
- 前端入口变化：无。本组仅完成 Phase 4 后端 CRUD；`SceneBankPanel`、`PacingPanel`、`ChapterPatternPanel` 仍在 `LQ-P4-09 ~ LQ-P4-11`。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`（111 项）、`git diff --check`（仅 Windows 行尾提示，无 whitespace error）。
- 已完成 `LQ-P4-07` 与 `LQ-P4-08`。`GuidedService.generateStepData` 与 `chatWithAi` 在 `guided_chapter` 阶段只读读取 active `ChapterPattern` 与相关 `PacingBeat`，作为“章节模板与节奏目标（只读计划资产）”注入章节细纲生成；`GenerateGuidedStepPreviewTool` 同步把这些资产放入 `projectContext.phase4Guidance`，保持 `requiresApproval=false`、无副作用。
- `GenerateChapterService` 在正文生成前读取当前章非 archived `SceneCard`，写入 `ChapterContextPack.planningContext.sceneCards`；`PromptBuilderService` 新增【场景执行】区块，输出 `sourceType=scene_card`、`sourceId`、场景编号、地点、参与者、目的、冲突、情绪、关键信息和结果，并明确 SceneCard 是写作计划资产，不当作已发生事实。
- 新增 API：无。migration：无新增。本组复用既有 `ChapterPattern`、`PacingBeat`、`SceneCard` 数据模型与 `LQ-P4-04 ~ LQ-P4-06` CRUD API。
- 前端入口变化：无。本组只接入生成链路；`SceneBankPanel`、`PacingPanel`、`ChapterPatternPanel` 仍在 `LQ-P4-09 ~ LQ-P4-11`。
- Tester 补充并通过服务级回归：`GenerateGuidedStepPreviewTool` 注入模板/节奏目标、`GuidedService.chatWithAi` 注入同类上下文、`PromptBuilderService` 渲染【场景执行】与 `sceneCardCount` debug。`pnpm --filter api test:agent` 通过 114 项。
- Reviewer/code_mapper 复核指出交互式 guided chat 可能绕过 Phase 4 资产注入；已补齐 `chatWithAi` 路径。保留的非阻塞后续项：SceneCard 覆盖质量门禁尚未实现，`SceneExecutionPlan` 暂未渲染 `relatedForeshadowIds` 与 `metadata`。
- Docker Compose 复核：`docker compose up -d` 可启动本地 PostgreSQL/Redis/MinIO/embedding 等依赖；`pnpm db:migrate` 当前返回 `No pending migrations to apply`，`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 `Database schema is up to date!`，此前空 `Schema engine error` 未复现。
- 验证通过：`docker compose up -d`、`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm db:migrate`、`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`（114 项）、`git diff --check`（仅 Windows 行尾提示，无 whitespace error）。
- 已完成 `LQ-P4-09 ~ LQ-P4-11`。前端新增 `SceneBankPanel`、`PacingPanel`、`ChapterPatternPanel`，并补齐 `SceneCard`、`PacingBeat`、`ChapterPattern` 类型与 `useContinuityActions` CRUD hooks；三个面板均支持列表筛选、刷新、创建、编辑、删除/归档、JSON 字段校验和项目作用域 API 调用。
- 前端入口变化：`scene-bank`、`pacing`、`chapter-patterns` 已加入 `ActiveView`、`ACTIVE_VIEWS`、localStorage 状态恢复校验、`WorkspaceSidebar` 导航和 `page.tsx` 主视图渲染分支。写入路径统一使用 `PATCH/DELETE /projects/:projectId/scenes/:sceneId`、`/projects/:projectId/chapter-patterns/:patternId`、`/projects/:projectId/pacing-beats/:beatId`。
- 本轮 review 修复：Reviewer 发现 Phase 4 CRUD update/delete 原先缺少 URL `projectId` 隔离，已改为 project-scoped 路由并在 service 层用 `id + projectId` 查找；同时修复 Guided/Agent preview 读取 `PacingBeat` 时裸 `{ volumeId }` 会混入同卷其他章节 beat 的问题，改为“章级 + 卷级通用 + 全局通用”匹配，并补充服务级回归断言。`GuidedChatDto` 增加可选 `volumeNo/chapterNo`，交互式 guided chat 与一键生成/Agent preview 读取同一类 Phase 4 资产。
- 新增 API/migration：本组前端闭环无新增 migration；API 未新增资源，仅将 `LQ-P4-04 ~ LQ-P4-06` 的 update/delete 路由收紧为 project-scoped 路径。所有 Phase 4 CRUD 写入口仍调用 `NovelCacheService.deleteProjectRecallResults(projectId)`；本组未新增写入类 Agent Tool，未改变审批边界。
- Tester/reviewer 结果：`pnpm --filter api test:agent` 通过 114 项，覆盖 Phase 4 CRUD projectId 隔离、Guided 模板/节奏注入、PromptBuilder 场景执行区块和 Agent Tool 审批边界；Reviewer 的高/中风险问题均已修复。保留非阻塞测试缺口：SceneCard 多卡排序/截断、GenerateChapterService 读取 SceneCard 的更细端到端断言、只读 preview tool Prisma 写方法 spy 级断言。
- 验证通过：`pnpm db:generate`、`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`、`pnpm db:migrate`、`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma`、`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`（114 项）、`git diff --check`（仅 Windows 行尾提示，无 whitespace error）。

## 8. Phase 5：质量评分与审稿报告

目标：把生成后质量结果从 draft metadata 提升为可查询、可比较、可追踪报告。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P5-01 | done | 新增 `QualityReport` model + migration | `apps/api/prisma/schema.prisma` | Phase 3 | 支持 scores/issues/verdict/sourceType |
| LQ-P5-02 | done | `GenerateChapterService` 写入 QualityReport | `generate-chapter.service.ts` | LQ-P5-01 | 每次生成后形成 draft 级报告 |
| LQ-P5-03 | done | 新增 `quality-reports` API | `apps/api/src/modules/quality-reports/*` | LQ-P5-01 | 可按项目/章节/草稿查询 |
| LQ-P5-04 | done | 新增 AI 审稿 Tool 或 Service | `apps/api/src/modules/agent-tools/tools/*` 或 validation module | LQ-P5-01 | 输出剧情推进、人设、文风、节奏、伏笔等分数 |
| LQ-P5-05 | done | Validation 面板接入 QualityReport | `apps/web/components/ValidationConsolePanel.tsx` 或新 Panel | LQ-P5-03 | 用户能看到评分趋势和问题 |
| LQ-P5-06 | done | 自动修复读取 QualityReport issues | `chapter-auto-repair.service.ts` | LQ-P5-02 | 质量问题可转成修复输入 |
| LQ-P5-07 | done | 测试覆盖低质量报告和通过报告 | `agent-services.spec.ts` | LQ-P5-02 | test:agent 通过 |

验收命令：

```bash
docker compose up -d
pnpm db:generate
pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
pnpm db:migrate
pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

完成记录（2026-05-05）：

- 已完成 `LQ-P5-01 ~ LQ-P5-07`，Phase 5 质量评分、报告、审稿、前端查看、自动修复读取与测试闭环全部完成。
- 新增 `QualityReport` model 与 migration `202605050006_longform_quality_phase5_quality_report`，字段覆盖 `projectId`、`chapterId`、`draftId`、`agentRunId`、`sourceType`、`sourceId`、`reportType`、`scores`、`issues`、`verdict`、`summary`、`metadata`、`createdAt`、`updatedAt`；migration 增加 `scores` object、`issues` array、`metadata` object、`sourceType` 与 `verdict` check constraints，并补充项目/章节/草稿/AgentRun 查询索引。
- `GenerateChapterService` 在成功创建 `ChapterDraft` 的同一事务中写入 `sourceType=generation`、`reportType=generation_quality_gate` 的 draft 级 QualityReport，记录 `scores.overall`、字数/比例指标、warnings/issues、verdict 与 qualityGate metadata；阻断级输出仍在写 draft 前抛错，不改变既有核心生成行为。写入后已补充调用 `NovelCacheService.deleteProjectRecallResults(projectId)` 清理项目召回缓存。
- 新增 API：`GET/POST /projects/:projectId/quality-reports`、`PATCH/DELETE /projects/:projectId/quality-reports/:reportId`；支持按 `chapterId`、`draftId`、`agentRunId`、`sourceType`、`reportType`、`verdict` 查询。写入/更新/删除均按 `projectId` 隔离，并调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。
- 新增 AI 审稿闭环 `LQ-P5-04`：`AiQualityReviewService` 读取当前章节草稿、校验问题、写作规则、关系、时间线、伏笔、SceneCard、PacingBeat 与近期 QualityReport，调用 LLM 生成结构化评分，并通过 `QualityReportsService.create` 写入 `sourceType=ai_review`、`reportType=ai_chapter_review` 的 QualityReport；metadata 记录 `promptVersion`、`sourceTrace`、focus/instruction、LLM usage、strengths 与 normalization warnings。
- 新增写入类 Agent Tool `ai_quality_review`，已注册到 `AgentToolsModule`、`ToolRegistryService`、内置 skill、Planner taskType/guidance 与 Runtime artifact 映射；Tool 固定 `allowedModes=['act']`、`requiresApproval=true`、`sideEffects=['create_quality_report']`，Plan 模式不得执行写入，Runtime 产物映射为 `ai_quality_report`。
- `ChapterAutoRepairService` 在未显式传入 issues 时，会合并打开的 `ValidationIssue`、当前草稿相关 `QualityReport.issues` 与执行卡覆盖问题，作为有界自动修复输入；reviewer 修复后仅读取当前 `draftId` 且 `sourceType=generation`、`reportType=generation_quality_gate` 的报告，显式传入 `issues: []` 时不再回退读取历史报告。
- 前端新增 `QualityReportPanel` 和 `quality-reports` view；已接入 `ActiveView`、`ACTIVE_VIEWS`、localStorage 状态恢复、`WorkspaceSidebar` 导航、`page.tsx` 主视图渲染分支，并在 `useContinuityActions`/`dashboard.ts` 补齐 QualityReport 类型与 GET/CRUD hook。
- Tester 复核后指出初版缺少 fail payload、Planner/Runtime 对 AI 审稿的直接覆盖与完整自动修复 run 级覆盖；已补充 fail 映射断言、`ai_quality_review` planner 审批元数据测试、`ai_quality_report` artifact 测试、AI 审稿 malformed issues 归一化测试、自动修复 generation-only 报告读取和显式 `issues: []` 不回退测试。最终 `pnpm --filter api test:agent` 通过 124 项。
- Reviewer 发现并已修复：自动修复原先会隐式消费 `ai_review/manual` 或 `draftId=null` 的 QualityReport issues；AI 审稿 malformed issues 可能生成默认 warning 或抛错；Tool 外层超时与内部 LLM timeout 相等；`GenerateChapterService` 直接写 QualityReport 后缺少召回缓存失效。修复后无未解决阻塞问题；保留非阻塞后续项：`quality-reports` controller/e2e、前端交互测试、AI 审稿重复执行的幂等/去重策略可继续增强。
- 验证结果：`docker compose up -d` 通过；`pnpm db:generate` 通过；`pnpm exec prisma validate --schema apps/api/prisma/schema.prisma` 通过；`pnpm db:migrate` 返回 `No pending migrations to apply`；`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 `Database schema is up to date!`；`pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`pnpm --filter api test:agent` 通过 124 项；`git diff --check` 通过，仅有 Windows 行尾提示，无 whitespace error。

## 9. Phase 6：Agent 工作流增强

目标：让用户可以让 Agent 批量维护 Story Bible、关系网、时间线和质量报告，但保持预览/校验/审批。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P6-01 | done | 新增 Story Bible preview/validate/persist tools | `apps/api/src/modules/agent-tools/tools/*` | Phase 1 | AI 可预览批量设定，不直接写入 |
| LQ-P6-02 | done | 新增 relationship/timeline persist tools | `agent-tools/tools/*` | Phase 2 | 写入前必须校验和审批 |
| LQ-P6-03 | done | Tool Registry 注册新工具并补 Manifest | `tool-registry.service.ts`、tool files | LQ-P6-01/P6-02 | Planner 能看到使用边界 |
| LQ-P6-04 | done | Skill Playbook 增加 story_bible_expand / continuity_check | `apps/api/src/modules/agent-skills/builtin-skills.ts` | LQ-P6-03 | 相关用户意图能生成正确计划 |
| LQ-P6-05 | done | Agent ArtifactPanel 展示 Story Bible diff、关系变更、时间线变更 | `apps/web/components/agent/AgentArtifactPanel.tsx` | LQ-P6-01/P6-02 | 用户能选择条目并重新规划 |
| LQ-P6-06 | done | Agent Eval 增加长篇质量用例 | `apps/api/test/fixtures/agent-eval-cases.json`、scripts | LQ-P6-04 | eval 覆盖设定扩展/关系检查/时间线修复 |

验收命令：
```bash
docker compose up -d
pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

完成记录（2026-05-05）：

- 已完成 `LQ-P6-01`：新增 Story Bible 三段式 Agent Tool：`generate_story_bible_preview`、`validate_story_bible`、`persist_story_bible`。
- `generate_story_bible_preview` 为只读预览工具，`requiresApproval=false`、`sideEffects=[]`，输出候选、`sourceTrace`、`writePlan` 和 diff-friendly 字段；候选资产标记为 `metadata.sourceKind=planned_story_bible_asset`，避免把计划资产误写成已发生正文事实。
- `validate_story_bible` 为只读校验工具，`requiresApproval=false`、`sideEffects=[]`，校验缺字段、重复 candidate/title、entryType、locked metadata、已有 locked LorebookEntry、跨项目/伪造 `relatedEntityIds`，并输出 approval-ready `writePreview`。
- `persist_story_bible` 为写入工具，`allowedModes=['act']`、`requiresApproval=true`、`sideEffects=['create_lorebook_entries','update_lorebook_entries','fact_layer_story_bible_write']`；运行时再次检查 Act + approved、preview/validation 必备、`validation.valid=true`、selected 候选必须属于本次 `validation.accepted` 和 `writePreview`，并绑定当前 `agentRunId` 的 `sourceTrace`。写入只使用 `context.projectId`，写后调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。
- 已接入 Story Bible 侧 `AgentToolsModule` 和 `ToolRegistryService`，Manifest 补充 `whenToUse/whenNotToUse`、`allowedModes`、`requiresApproval`、`sideEffects`、`idPolicy`；relationship/timeline 完成后的整体注册见下方 `LQ-P6-02 ~ LQ-P6-05` 记录。
- 已为 Planner/Skill/Runtime 打基础：`builtin-skills.ts` 增加 `story_bible_expand`、`continuity_check` 任务类型和 Story Bible 默认工具；Planner guidance 要求 preview -> validate -> persist，persist 等待审批；Runtime 输出 `story_bible_preview`、`story_bible_validation_report`、`story_bible_persist_result` artifact，并把 Plan 阶段 artifact 改为按 tool 名定位输出；relationship/timeline 完成后的 Skill 闭环验收见下方记录。
- migration：无新增 migration，复用既有 `LorebookEntry` schema。
- Tester 验证通过：`pnpm --filter api test:agent` 通过 131 项，覆盖 Story Bible preview 只读、validate locked/重复/跨项目引用、persist Act+审批+缓存失效、Plan/未审批/无效校验/未知选择/跨项目引用拒绝、Planner 审批元数据、Runtime artifact 映射。
- Reviewer 发现并已修复：`persist_story_bible` 原先 selected 候选未强绑定 `validation.accepted/writePreview`；title 匹配原先使用原始标题精确匹配，可能绕过 locked 变体；Plan 阶段 artifact 原先按固定 stepNo 取输出。修复后新增未接受候选、校验标题不一致、跨 run sourceTrace、大小写/空白 locked 标题变体和非固定 stepNo artifact 测试。
- 验证结果：`docker compose up -d` 通过；`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 18 个 migrations 且 `Database schema is up to date!`；`pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`pnpm --filter api test:agent` 通过 131 项；`git diff --check` 通过，仅有 Windows CRLF 提示，无 whitespace error。
- 已完成 `LQ-P6-02 ~ LQ-P6-05`：新增关系/时间线三段式 Agent Tool `generate_continuity_preview`、`validate_continuity_changes`、`persist_continuity_changes`；preview/validate 均为只读工具，`requiresApproval=false`、`sideEffects=[]`；persist 固定 `allowedModes=['act']`、`requiresApproval=true`，副作用显式覆盖 RelationshipEdge/TimelineEvent create/update/delete 与 fact-layer continuity write。
- `persist_continuity_changes` 写入前会要求 Act + approved，只使用 `context.projectId`，只接受来自真实前序 `generate_continuity_preview`/`validate_continuity_changes` step 输出的 whole-object 引用，selected 候选必须属于 `validation.accepted` 与非 reject `writePreview`；候选 `sourceTrace.agentRunId` 必须等于当前 run；`characterAId/characterBId`、timeline `participantIds/knownByIds/unknownByIds`、`chapterId/chapterNo` 均按当前项目复核，ID/name 必须一致，候选不得携带顶层 `projectId`。
- 写入实现按 `projectId` 隔离：create 数据强制写入 `context.projectId`；update/delete 在加载同项目记录后，最终 mutation 也使用 `updateMany/deleteMany({ id, projectId })` 复核项目范围；实际写入后调用 `NovelCacheService.deleteProjectRecallResults(projectId)`，`dryRun=true` 仅做事务内写前校验和 diff 回显，不写业务表、不清缓存。
- `LQ-P6-03` 注册与 Manifest 已完成：`AgentToolsModule`、`ToolRegistryService`、内置 Skill 默认工具、Planner guidance、Runtime artifact 映射均接入 continuity tools；Manifest 补齐 `whenToUse/whenNotToUse`、`allowedModes`、`requiresApproval`、`sideEffects`、`idPolicy`，写入工具明确禁止发明 `projectId/characterId/chapterId/relationshipId/timelineEventId`。
- `LQ-P6-04` Skill Playbook 已完成：`story_bible_expand` 与 `continuity_check` 均进入内置任务类型；Planner 对 `continuity_check` 生成 collect context -> preview -> validate -> persist 链路，并把 persist 步骤放入 `requiredApprovals`；Plan 模式只提升 preview/validate artifacts，Act 模式才可在审批后运行 persist。
- `LQ-P6-05` ArtifactPanel 闭环已完成：`AgentArtifactPanel.tsx` 增加 Story Bible preview/validation/persist 摘要，以及 `continuity_preview`、`continuity_validation_report`、`continuity_persist_result` 摘要，展示关系候选、时间线候选、校验 diff、accepted/rejected 与写入结果；保持既有 Agent artifact 卡片与原始 JSON 回退模式。
- migration：本组无新增 migration，复用 Phase 2 既有 `RelationshipEdge`、`TimelineEvent` schema；迁移环境复核通过，`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 显示 18 个 migrations 且 DB up to date。
- Tester 验证通过：`pnpm --filter api test:agent` 通过 140 项，覆盖 continuity preview 只读、validate happy path/跨项目角色和章节/ID-name mismatch/顶层 projectId 拒绝、persist Plan/未审批/无效校验/未知选择/伪造前序输出/sourceTrace mismatch、persist create relationship+timeline、dryRun 不写入不清缓存、写后清缓存、Planner 审批元数据、Runtime artifact 映射、Registry 注册、无关 existing 不误判重复、真实重复仍拒绝、update/delete mutation 携带 `id + projectId`。
- Reviewer 发现并已修复：`persist_continuity_changes` 原先仅凭形似 preview/validation 对象与 sourceTrace 自洽即可写入，现通过 `ToolContext.stepTools` + 对象引用校验绑定真实前序输出；timeline ID 数组原先只校验 UUID 与项目归属，现与 `participants/knownBy/unknownBy` 名称数组逐项一致；候选顶层 `projectId` 现在即使等于当前项目也拒绝；update/delete 最终 mutation 已补项目条件；关系 update 只传新 ID 不传 name 现在会拒绝，避免写入“新 ID + 旧 name”；关系/时间线重复检测改为用 existing row 自身 key 比较，避免无关 existing row 误拦截合法新增。未遗留阻塞问题。
- 验证结果：`docker compose up -d` 通过；`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 18 个 migrations 且 `Database schema is up to date!`；`pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`pnpm --filter api test:agent` 通过 140 项；`git diff --check` 通过，仅有 Windows CRLF 提示，无 whitespace error。
- 已完成 `LQ-P6-06`：Agent Eval 新增长篇质量用例 `longform_story_bible_expand_013`、`longform_relationship_check_014`、`longform_timeline_repair_015`，覆盖 Story Bible 设定扩展、关系线连续性检查与时间线修复计划。
- `agent-eval-cases.json` 新增用例均要求 `forbidInventedIds=true`；设定扩展断言 `collect_task_context -> generate_story_bible_preview -> validate_story_bible -> persist_story_bible`；关系检查和时间线修复断言 `collect_task_context -> generate_continuity_preview -> validate_continuity_changes -> persist_continuity_changes`，且 persist 链路必须进入审批。
- `eval_agent_planner.ts` 补齐 eval 专用 Tool manifest：Story Bible 与 continuity preview/validate 为只读、无副作用，persist 工具标记 `requiresApproval=true` 并列出 Story Bible、RelationshipEdge、TimelineEvent 写入副作用；可控 LLM mock 新增三类长篇质量意图分支，并为 `story_bible_expand`、`continuity_check` 补 retrieval focus。
- `eval_agent_planner.ts` 与 `eval_agent_replanner.ts` 同步补齐 `AgentContextV2.attachments=[]`，修复 Agent Eval 脚本随上下文类型演进后的编译阻塞；该修复不改变业务计划和 replan 语义。
- 新增 API 或 Agent Tool：无生产新接口/新工具，本任务仅补 Agent Eval fixture 与评测脚本；eval manifest 复刻既有生产工具名与审批/副作用边界用于 Planner 评测。
- migration：无新增 migration，复用 Phase 1/Phase 2/Phase 6 既有 schema 与 Agent Tool 实现。
- Tester 发现并已修复：初次运行 `pnpm --filter api eval:agent` 暴露 `eval_agent_planner.ts` 缺少 `attachments`；初次运行 `pnpm --filter api eval:agent:gate` 暴露 `eval_agent_replanner.ts` 缺少 `attachments`。两处补齐后 `eval:agent:gate` 通过。
- Mapper 只读复核结论：fixture schema、live planner mock registry 与 mock planner 分支必须同步新增 P6 工具，否则新增 case 会在 live eval 失败；已按此建议实现。Tester 复核认为 Planner/Retrieval/Gate 主线已覆盖三类目标，唯一非阻塞缺口是尚未新增 story_bible/continuity 专项 replan case；Reviewer 子 Agent 本轮复核超时未返回，主控按审批边界、ID 幻觉、工具副作用和文档状态做了收尾检查，未发现阻塞问题。
- 验证结果：`docker compose up -d` 通过；`pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma` 返回 18 个 migrations 且 `Database schema is up to date!`；`pnpm --filter api eval:agent` 加载 15 个用例通过；`pnpm --filter api eval:agent:live` 15/15 通过；`pnpm --filter api eval:agent:retrieval` 15/15 通过；`pnpm --filter api eval:agent:replan` 12/12 通过；`pnpm --filter api eval:agent:gate` 通过；`pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`pnpm --filter api test:agent` 通过 140 项；`git diff --check` 通过，仅有 Windows CRLF 提示，无 whitespace error。

## 10. 跨阶段约束

所有任务必须遵守：

- 不改 `apps/worker`。
- 新写入入口必须按 `projectId` 隔离。
- 会影响召回的写入必须清空项目级召回缓存。
- 写入类 Agent Tool 必须 requiresApproval。
- 新增 Prisma migration 后必须运行 Prisma generate。
- 前端新增 view 必须加入 `ACTIVE_VIEWS`、本地状态恢复和侧边栏导航。
- 文档、API、前端类型要同步更新，避免“后端有字段前端不知道”。

## 11. 推荐首批 Sprint

### Sprint 1：最小 Story Bible

范围：

```text
LQ-P1-01 ~ LQ-P1-13
```

交付：

- `ProjectCreativeProfile`
- `LorebookEntry.metadata`
- Story Bible UI
- Lorebook CRUD
- 创作定位编辑

### Sprint 2：连续性核心

范围：

```text
LQ-P2-01 ~ LQ-P2-19
```

交付：

- 写作约束
- 角色关系网
- 时间线
- 人物状态全局页
- 生成前硬规则基础校验

### Sprint 3：生成配置接入

范围：

```text
LQ-P3-01 ~ LQ-P3-08
```

交付：

- GenerationProfile
- 新增实体权限
- PromptBuilder/FactExtractor 接入生成策略

## 12. 验收样例

### 样例 1：禁止提前泄密

准备：

- 创建 WritingRule：`第80章前不能暴露主角真实血脉`，severity=error。
- 第 20 章生成指令包含“揭示主角血脉”。

期望：

- Preflight 产生 blocker。
- 不创建新草稿，除非用户显式关闭阻断。
- `ValidationIssue` 记录规则冲突。

### 样例 2：角色知情范围

准备：

- 创建 TimelineEvent：`宗主参与主角家族灭门`，knownBy=[沈雪]，unknownBy=[林烬]。
- 第 30 章章节大纲写“林烬直接质问宗主灭门真相”。

期望：

- 生成前 warning/error：林烬尚未知情。
- Prompt 中提醒不得让林烬知道未公开真相，除非本章安排可信揭示。

### 样例 3：势力与地点召回

准备：

- Story Bible 中有 `青云宗` faction、`赤焰门` faction、`雨夜破庙` location。
- 第 12 章目标涉及青云宗与赤焰门冲突。

期望：

- Retrieval Planner 生成 faction/location 查询。
- Prompt 中【势力/地点/道具】区块包含这些条目。
- retrievalPayload sourceTrace 可追踪命中来源。

### 样例 4：已死亡角色出场

准备：

- Character `赵玄.isDead=true`。
- Timeline 或章节计划中第 50 章让赵玄正常对话出场。

期望：

- Validation 产生 `dead_character_appearance`。
- 建议改为回忆、传闻、遗物、幻觉或尸体形式。
