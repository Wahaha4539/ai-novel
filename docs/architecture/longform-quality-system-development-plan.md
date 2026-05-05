# AI 长篇小说质量保障系统任务文档

> 最后更新：2026-05-05  
> 状态：Phase 1 最小 Story Bible 闭环已完成，Phase 2 待实现  
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
| LQ-P3-01 | todo | 新增 `GenerationProfile` model + migration | `apps/api/prisma/schema.prisma` | Phase 1 | 支持新增实体权限、自动流程开关、promptBudget |
| LQ-P3-02 | todo | 新增 `generation-profile` API | `apps/api/src/modules/generation-profile/*` | LQ-P3-01 | GET/PATCH 可用 |
| LQ-P3-03 | todo | `GenerateChapterService` 读取 GenerationProfile | `apps/api/src/modules/generation/generate-chapter.service.ts` | LQ-P3-02 | generationContext 记录 profile snapshot |
| LQ-P3-04 | todo | Preflight 接入 allowNewCharacters/Locations/Foreshadows | `GenerateChapterService`、`ValidationService` | LQ-P3-03 | 禁止新增时，新增候选进入 warning/blocker |
| LQ-P3-05 | todo | `FactExtractorService` 按 GenerationProfile 决定 auto/pending_review | `apps/api/src/modules/facts/fact-extractor.service.ts` | LQ-P3-03 | 禁止自动新增角色时只创建 pending_review |
| LQ-P3-06 | todo | `runAutoMaintenance` 前端展示项目级自动流程开关 | `apps/web/hooks/useDashboardData.ts`、`GenerationConfigPanel` | LQ-P3-02 | 用户能配置是否自动总结/校验/更新时间线 |
| LQ-P3-07 | todo | 更新 PromptBuilder 区分“允许新增候选”和“禁止新增事实” | `PromptBuilderService` | LQ-P3-03 | Prompt 明确新增边界 |
| LQ-P3-08 | todo | 服务级测试覆盖生成配置 | `agent-services.spec.ts` | LQ-P3-04 | test:agent 通过 |

## 7. Phase 4：场景库、章节模板、节奏曲线

目标：提升章节正文可执行度和长篇节奏稳定性。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P4-01 | todo | 新增 `SceneCard` model + migration | `apps/api/prisma/schema.prisma` | Phase 2 | 支持 chapterId/sceneNo/participants/conflict/result |
| LQ-P4-02 | todo | 新增 `ChapterPattern` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持模板类型、结构字段、适用场景 |
| LQ-P4-03 | todo | 新增 `PacingBeat` model + migration | `apps/api/prisma/schema.prisma` | 无 | 支持每章情绪强度、张力、爆点类型 |
| LQ-P4-04 | todo | 新增 Scenes CRUD API | `apps/api/src/modules/scenes/*` | LQ-P4-01 | 可按 volume/chapter 查询 |
| LQ-P4-05 | todo | 新增 ChapterPatterns CRUD API | `apps/api/src/modules/chapter-patterns/*` | LQ-P4-02 | 可创建升级章/战斗章/揭秘章等模板 |
| LQ-P4-06 | todo | 新增 Pacing CRUD API | `apps/api/src/modules/pacing/*` | LQ-P4-03 | 可批量更新章节节奏 |
| LQ-P4-07 | todo | Guided 章节细纲生成读取章节模板和节奏目标 | `GuidedService`、Agent guided tools | LQ-P4-05/P4-06 | 生成章节时 craftBrief 更贴合模板 |
| LQ-P4-08 | todo | 正文 Prompt 注入本章场景卡 | `PromptBuilderService` | LQ-P4-04 | 本章 SceneCard 进入【场景执行】区块 |
| LQ-P4-09 | todo | 新增 `SceneBankPanel` | `apps/web/components/*` | LQ-P4-04 | 可维护场景库 |
| LQ-P4-10 | todo | 新增 `PacingPanel` | `apps/web/components/*` | LQ-P4-06 | 可视化每章情绪强度和爆点类型 |
| LQ-P4-11 | todo | 新增 `ChapterPatternPanel` | `apps/web/components/*` | LQ-P4-05 | 可维护模板库 |

## 8. Phase 5：质量评分与审稿报告

目标：把生成后质量结果从 draft metadata 提升为可查询、可比较、可追踪报告。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P5-01 | todo | 新增 `QualityReport` model + migration | `apps/api/prisma/schema.prisma` | Phase 3 | 支持 scores/issues/verdict/sourceType |
| LQ-P5-02 | todo | `GenerateChapterService` 写入 QualityReport | `generate-chapter.service.ts` | LQ-P5-01 | 每次生成后形成 draft 级报告 |
| LQ-P5-03 | todo | 新增 `quality-reports` API | `apps/api/src/modules/quality-reports/*` | LQ-P5-01 | 可按项目/章节/草稿查询 |
| LQ-P5-04 | todo | 新增 AI 审稿 Tool 或 Service | `apps/api/src/modules/agent-tools/tools/*` 或 validation module | LQ-P5-01 | 输出剧情推进、人设、文风、节奏、伏笔等分数 |
| LQ-P5-05 | todo | Validation 面板接入 QualityReport | `apps/web/components/ValidationConsolePanel.tsx` 或新 Panel | LQ-P5-03 | 用户能看到评分趋势和问题 |
| LQ-P5-06 | todo | 自动修复读取 QualityReport issues | `chapter-auto-repair.service.ts` | LQ-P5-02 | 质量问题可转成修复输入 |
| LQ-P5-07 | todo | 测试覆盖低质量报告和通过报告 | `agent-services.spec.ts` | LQ-P5-02 | test:agent 通过 |

## 9. Phase 6：Agent 工作流增强

目标：让用户可以让 Agent 批量维护 Story Bible、关系网、时间线和质量报告，但保持预览/校验/审批。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| LQ-P6-01 | todo | 新增 Story Bible preview/validate/persist tools | `apps/api/src/modules/agent-tools/tools/*` | Phase 1 | AI 可预览批量设定，不直接写入 |
| LQ-P6-02 | todo | 新增 relationship/timeline persist tools | `agent-tools/tools/*` | Phase 2 | 写入前必须校验和审批 |
| LQ-P6-03 | todo | Tool Registry 注册新工具并补 Manifest | `tool-registry.service.ts`、tool files | LQ-P6-01/P6-02 | Planner 能看到使用边界 |
| LQ-P6-04 | todo | Skill Playbook 增加 story_bible_expand / continuity_check | `apps/api/src/modules/agent-skills/builtin-skills.ts` | LQ-P6-03 | 相关用户意图能生成正确计划 |
| LQ-P6-05 | todo | Agent ArtifactPanel 展示 Story Bible diff、关系变更、时间线变更 | `apps/web/components/agent/AgentArtifactPanel.tsx` | LQ-P6-01/P6-02 | 用户能选择条目并重新规划 |
| LQ-P6-06 | todo | Agent Eval 增加长篇质量用例 | `apps/api/test/fixtures/agent-eval-cases.json`、scripts | LQ-P6-04 | eval 覆盖设定扩展/关系检查/时间线修复 |

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
