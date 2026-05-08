# 时间线生成与章节更新开发计划

> 最后更新：2026-05-08
> 状态：待实现开发计划
> 范围：全书大纲、卷大纲、章节细纲、Chapter.craftBrief、章节生成后事实抽取、TimelineEvent 写入与前端审核闭环
> 核心原则：时间线是后续生成的事实约束，任何进入审批、写入或召回链路的时间线内容都不得使用占位模板、确定性补齐或静默降级。

## 1. 背景与当前状态

当前系统已经具备 `TimelineEvent` 表、时间线面板 CRUD、结构化召回、Prompt 注入和连续性 Agent 工具，但“普通章节生成后自动写入时间线面板”尚未实现。

现有能力：

- 手工维护入口：`TimelinePanel` 调用 `GET/POST/PATCH/DELETE /projects/:projectId/timeline-events`，直接维护 `TimelineEvent`。
- Agent 连续性入口：`generate_continuity_preview -> validate_continuity_changes -> persist_continuity_changes` 可以在审批后写入关系线和时间线。
- 章节生成使用入口：`RetrievalService` 会召回已有 `TimelineEvent`，`PromptBuilderService` 注入【时间线与角色知情范围】区块，辅助章节正文生成。
- 章节生成后事实抽取入口：`FactExtractorService.extractChapterFacts()` 写入 `StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack` 和 `MemoryChunk`，但不写入 `TimelineEvent`。

### 1.1 当前普通章节生成边界

截至本计划建立时，普通章节生成链路的时间线行为如下：

- `GenerationService.generateChapter()` 在正文生成、后处理和润色后，会调用 `FactExtractorService.extractChapterFacts()`、事实校验、章节记忆重建和记忆复核。
- `GenerationService.polishChapter()` 会在润色后同步调用 `FactExtractorService.extractChapterFacts()`、事实校验、章节记忆重建和记忆复核。
- `FactExtractorService.extractChapterFacts()` 的业务写入范围是事实层与记忆层：替换同章节自动抽取的 `StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack`，并写入相关 `MemoryChunk`、首登场角色或设定候选。
- 该链路当前不会创建、更新、删除或归档 `TimelineEvent`。因此，时间线面板不会因为普通章节生成或润色自动出现新事件。
- `autoUpdateTimeline` 目前是 `GenerationProfile` 配置项，但普通章节生成尚未接入“章节后时间线候选预览、校验、审批或安全自动写入”链路，不能把它理解为已经会写 `TimelineEvent`。
- 当前可以写 `TimelineEvent` 的入口是手工时间线 CRUD，以及已审批的 continuity persist 工具；章节删除清理关联 `TimelineEvent` 属于章节资源清理，不代表生成链路会自动沉淀时间线事实。

目标行为不是在普通生成后直接复制 `StoryEvent` 到 `TimelineEvent`。后续实现必须先产出 timeline-only 候选，完成章节引用、来源 trace、重复冲突、知情范围和写入策略校验，再通过审批或明确的 `GenerationProfile` 自动写入策略落库。

需要补齐的核心闭环：

```text
全书/卷/章节规划
  -> 生成计划时间线候选
  -> 校验
  -> 审批或安全自动写入 TimelineEvent(planned)
  -> 章节生成前召回：已确认事实 + 本章计划时间线
  -> 章节生成后抽取 StoryEvent
  -> StoryEvent 与计划 TimelineEvent 对齐
  -> 生成确认/修正/新增/归档候选
  -> 校验
  -> 审批或配置化自动写入 TimelineEvent(active/changed/archived)
```

## 2. 目标与非目标

### 2.1 目标

1. 在全书大纲、卷大纲、章节细纲和 `Chapter.craftBrief` 阶段生成计划时间线。
2. 在章节生成前，把“已确认时间线事实”和“本章计划时间线”分层注入 Prompt。
3. 在章节生成后，从 `StoryEvent` 对齐并更新 `TimelineEvent`，让时间线面板持续沉淀。
4. 让所有时间线写入都具备来源、状态、校验结果和可追踪 metadata。
5. `autoUpdateTimeline` 不再只是触发事实/记忆维护，而是明确控制章节后时间线更新链路。
6. 测试覆盖 LLM 失败、结构缺失、数量不足、章节号错误、重复事件、知情范围不完整、跨项目引用和未审批写入。

### 2.2 非目标

- 不把 `StoryEvent` 和 `TimelineEvent` 合并为同一张表。
- 不让普通章节生成在无校验、无来源、无状态的情况下静默写入时间线。
- 不把当前章节计划时间线当作“已发生事实”注入正文 Prompt。
- 不引入低质量 fallback 来补齐缺失事件、章节号、人物、原因、结果或知情范围。
- 不绕过现有 Agent 审批边界；Agent 写入仍必须走 preview -> validate -> persist。

## 3. 核心语义

### 3.1 TimelineEvent 与 StoryEvent 分工

| 类型 | 来源 | 作用 | 可信状态 |
|---|---|---|---|
| `StoryEvent` | 章节正文抽取 | 记录正文中检测到的剧情事件 | detected，偏“正文证据” |
| `TimelineEvent` | 规划、确认、人工维护、Agent 写入 | 规范时间线，进入召回与校验链路 | planned/active/changed/archived |

`StoryEvent` 是正文证据层，`TimelineEvent` 是规范事实层。章节生成后应通过对齐工具把正文证据转化为候选变更，而不是直接把 `StoryEvent` 原样复制成规范时间线。

### 3.2 建议状态

- `planned`：来自全书大纲、卷纲、章节细纲或 craftBrief，尚未被正文确认。
- `active`：已被正文确认、人工确认或审批写入，可作为后续章节的已发生事实。
- `changed`：计划与正文不一致，或事件字段被后续修正。
- `archived`：废弃计划、被替代事件或不再参与后续召回的旧事件。

### 3.3 Prompt 分层

章节生成前应区分两类时间线：

- 已确认时间线事实：来自 `active` 事件，且章节范围早于当前章；进入 verified context。
- 本章计划时间线：来自当前章 `planned` 事件；进入 planning context，只作为本章执行目标，不得当作已经发生的事实。

### 3.4 TimelineEvent 字段与 metadata 约定

`TimelineEvent` 表的显式字段和 `metadata` 需要分工清楚：

- `eventStatus` 表示事实生命周期，只描述事件是否可作为事实约束参与召回。建议值为 `planned`、`active`、`changed`、`archived`。新增工具不得把未确认的计划事件写成 `active`。
- `sourceType` 表示写入来源或维护通道，不等同于事实生命周期。建议值为 `manual`、`agent_continuity`、`agent_timeline_plan`、`agent_timeline_alignment`、`chapter_generation`、`imported_asset`。旧数据或人工扩展值可以保留，但新自动链路必须使用明确来源。
- `metadata.sourceKind` 表示候选或写入意图，例如 `planned_timeline_event`、`chapter_timeline_alignment`、`planned_continuity_change`。它用于区分同一个 `sourceType` 下的不同生成场景。
- `metadata.sourceTrace` 是生成、校验和写入链路的可追踪凭据。自动生成或 Agent 写入的时间线候选必须带有可信 `sourceTrace`，persist 时必须比对 preview、validate、writePreview 中的 `sourceTrace`，不一致直接报错。
- `metadata.validation` 记录最近一次校验结果，包括 `status`、`issueCount`、`errors`、`warnings`、`validatedAt`。有 error 的候选不得写入；有 warning 的候选必须进入待审或按明确策略失败。

`metadata.sourceTrace` 至少应尽量包含：

- `projectId`：必须是当前项目，跨项目引用直接报错。
- `toolName`、`agentRunId`、`planVersion`：来自 Agent 工具链时用于证明来源。
- `candidateId`、`candidateAction`：用于防止 persist 阶段伪造或串换候选。
- `chapterId` 或 `chapterNo`、`draftId`：用于定位来源章节或草稿。
- `contextSources`：参与生成该候选的上下文来源，元素包含 `sourceType`、`sourceId`、`title`、`chapterId`、`chapterNo` 等。
- `evidence`、`generatedAt`、`validatedAt`：用于面板展示与审计。

不得在 persist 阶段临时拼装缺失的 `sourceTrace` 来掩盖 preview 或 validate 输出不完整；缺失、跨项目、不匹配或无法解释来源时，必须失败并让调用方重试或补充上下文。

## 4. 推荐工具链

### 4.1 新增 timeline-only 工具

新增独立时间线工具，避免继续把“关系线修复”和“时间线规划/确认”耦合在同一个 continuity 工具里。

| 工具 | 模式 | 写入 | 用途 |
|---|---|---|---|
| `generate_timeline_preview` | plan/act | 否 | 从全书大纲、卷纲、章节细纲、craftBrief 或正文事实生成时间线候选 |
| `validate_timeline_preview` | plan/act | 否 | 校验候选字段、章节引用、重复事件、来源 trace、知情范围和动作合法性 |
| `persist_timeline_events` | act | 是，需审批 | 只写入已校验且被选择的候选 |
| `align_chapter_timeline_preview` | plan/act | 否 | 将 `StoryEvent` 与本章计划 `TimelineEvent` 对齐，生成确认/修正/新增/归档候选 |

`generate_continuity_preview` 可继续保留，用于“关系线 + 时间线”混合连续性修复；新增 timeline-only 工具用于规划生成和章节后自动维护。

### 4.2 候选动作

内部候选可使用以下动作，落库时转换为现有 `TimelineEvent` create/update/delete：

- `create_planned`：新增计划事件。
- `confirm_planned`：把计划事件确认成 `active`。
- `update_event`：修正标题、时间、地点、参与者、原因、结果、影响范围、知情范围或状态。
- `archive_event`：归档废弃计划。
- `create_discovered`：正文中出现计划外关键事件，经校验后新增为 `active` 或 `changed`。

如果第一期想少改写入层，可把这些动作归一为 `create/update/delete`，但 candidate metadata 必须保留原始意图。

### 4.3 必填字段

所有会进入审批或写入链路的时间线候选必须包含：

- `candidateId`
- `action`
- `title`
- `chapterNo` 或 `chapterId`
- `eventTime`，允许小说内时间表达，例如“第七日傍晚”
- `participants`
- `cause`
- `result`
- `impactScope`
- `isPublic`
- `knownBy`
- `unknownBy`
- `eventStatus`
- `sourceType`
- `sourceTrace`

字段缺失、结构不完整、章节号不存在、章节号不连续、关键数组不是字符串数组、LLM 返回非 JSON、返回数量不足或超过约束，都必须直接报错。

## 5. 分阶段任务

### Phase 0：现状锁定与边界文档

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P0-01 | done | 补充当前时间线行为说明，明确普通章节生成目前不写 `TimelineEvent` | `docs/architecture/*` | 文档说明当前行为和目标行为，避免误判 |
| TL-P0-02 | done | 增加测试锁定现状：`extract_chapter_facts` 只写 `StoryEvent` 等事实表，不写 `TimelineEvent` | `apps/api/src/modules/agent-runs/agent-services.spec.ts` 或新测试 | 改造前测试通过；后续实现时按计划调整断言 |
| TL-P0-03 | done | 梳理 `TimelineEvent` 字段和 metadata 约定 | `packages/shared-types/src/index.ts`、文档 | 明确 sourceType、eventStatus、sourceTrace 语义 |

完成记录：

- TL-P0-01：补充当前普通章节生成边界，明确生成和润色后只调用事实抽取、校验、记忆重建与复核，当前不会写入 `TimelineEvent`；涉及文件：`docs/architecture/timeline-generation-development-plan.md`；验证命令：`git diff --check`。
- TL-P0-02：在事实抽取成功用例中加入 `timelineEvent` 写方法探针，锁定 `extractChapterFacts` 当前只写事实层、记忆层和首登场候选，不写 `TimelineEvent`；涉及文件：`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/timeline-generation-development-plan.md`；验证命令：`pnpm --filter api test:agent`、`pnpm --filter api build`、`git diff --check`。
- TL-P0-03：补充 `TimelineEventStatus`、`TimelineEventSourceType`、`TimelineEventMetadata`、`TimelineEventSourceTrace`、`TimelineEventValidationTrace` 共享类型，并在文档中明确 `eventStatus`、`sourceType`、`metadata.sourceTrace` 和 `metadata.validation` 的语义与失败边界；涉及文件：`packages/shared-types/src/index.ts`、`docs/architecture/timeline-generation-development-plan.md`；验证命令：`pnpm --filter api test:agent`、`pnpm --filter api build`、`pnpm --filter web build`、`git diff --check`。
- TL-P1-01：新增 timeline-only 候选动作、候选字段、sourceTrace、preview/validate/persist 输入输出与 writePreview 类型契约，API 工具层提供独立 `timeline-preview.types.ts`；涉及文件：`packages/shared-types/src/index.ts`、`apps/api/src/modules/agent-tools/tools/timeline-preview.types.ts`、`docs/architecture/timeline-generation-development-plan.md`；验证命令：`pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`、`git diff --check`。
- TL-P1-02：新增 `timeline-preview.support.ts`，实现 timeline-only 候选 normalize，缺 `candidateId/title/eventTime/cause/result/impactScope/knownBy/sourceTrace` 等关键字段或候选数量不足会直接抛错，不补齐内容；涉及文件：`apps/api/src/modules/agent-tools/tools/timeline-preview.support.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/timeline-generation-development-plan.md`；验证命令：`pnpm --filter api test:agent`、`pnpm --filter api build`、`git diff --check`。
- TL-P1-03：在 timeline helper 中新增章节引用校验，要求候选 `chapterId/chapterNo` 能解析到当前项目同一章节，跨项目章节索引、缺失章节和 id/no 不匹配都会直接报错；涉及文件：`apps/api/src/modules/agent-tools/tools/timeline-preview.support.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/timeline-generation-development-plan.md`；验证命令：`pnpm --filter api test:agent`、`pnpm --filter api build`、`git diff --check`。

### Phase 1：时间线候选契约与校验核心

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P1-01 | done | 定义 timeline candidate/input/output 类型 | `apps/api/src/modules/agent-tools/tools/*`、`packages/shared-types/src/index.ts` | 类型包含必填字段、动作、sourceTrace、writePreview |
| TL-P1-02 | done | 实现通用时间线候选 normalize，但不得补齐关键内容 | 新增 `timeline-preview.support.ts` 或同类 helper | 缺 title/cause/result/impactScope/knownBy 等直接报错 |
| TL-P1-03 | done | 实现章节引用校验 | `timeline-events.service.ts` 或工具 helper | `chapterId/chapterNo` 必须属于当前项目且互相匹配 |
| TL-P1-04 | todo | 实现重复事件和冲突检测 | 新增工具测试 | 同项目同章同标题同时间重复会拒绝 |
| TL-P1-05 | todo | 测试 LLM 失败、JSON 不完整、字段缺失、数量不足直接抛错 | `agent-services.spec.ts` | 不产生可审批候选，不写库 |

### Phase 2：大纲与细纲阶段生成计划时间线

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P2-01 | todo | 新增 `generate_timeline_preview` 工具 | `apps/api/src/modules/agent-tools/tools/generate-timeline-preview.tool.ts` | 只读，无 Prisma 写方法调用，输出 planned 候选 |
| TL-P2-02 | todo | 新增 `validate_timeline_preview` 工具 | `apps/api/src/modules/agent-tools/tools/validate-timeline-preview.tool.ts` | 输出 accepted/rejected/writePreview |
| TL-P2-03 | todo | 新增 `persist_timeline_events` 工具 | `apps/api/src/modules/agent-tools/tools/persist-timeline-events.tool.ts` | Act + approved 才写入；只写当前 projectId |
| TL-P2-04 | todo | 注册工具与 Manifest | `AgentToolsModule`、`ToolRegistryService`、`builtin-skills.ts` | Planner 能看到使用边界、审批和副作用 |
| TL-P2-05 | todo | 接入全书大纲、卷大纲、章节细纲、craftBrief 产物 | outline/guided/agent 相关工具 | 可从规划内容生成 `eventStatus=planned` 的候选 |
| TL-P2-06 | todo | Agent Artifact 展示计划时间线 diff | `AgentArtifactPanel.tsx` | 用户能看 accepted/rejected/diff 和来源 |

### Phase 3：章节生成前召回与 Prompt 分层

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P3-01 | todo | 扩展召回：已确认时间线进入 verified context | `RetrievalService` | 当前章生成时只召回当前章之前的 `active` 事件为事实 |
| TL-P3-02 | todo | 扩展上下文包：本章 planned 时间线进入 planning context | `GenerateChapterService`、`context-pack.types.ts` | 当前章 `planned` 事件不会混入 verified facts |
| TL-P3-03 | todo | PromptBuilder 新增【本章计划时间线】区块 | `PromptBuilderService` | 明确这是计划目标，不是已发生事实 |
| TL-P3-04 | todo | Prompt debug 记录 timeline hit 计数和来源 | `PromptBuilderService` | generationContext 可追踪 active/planned 分层 |
| TL-P3-05 | todo | 测试未来章节不泄露、当前计划不当作事实 | `agent-services.spec.ts` | `chapterNo > current` 不进 Prompt；current planned 只进 planning context |

### Phase 4：章节生成后 StoryEvent 对齐时间线

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P4-01 | todo | 新增 `align_chapter_timeline_preview` 工具 | `apps/api/src/modules/agent-tools/tools/align-chapter-timeline-preview.tool.ts` | 读取本章 `StoryEvent` 与本章 `TimelineEvent(planned/active)`，只产候选 |
| TL-P4-02 | todo | 对齐逻辑支持 confirm/update/create/archive | 工具 helper | 计划事件被正文证实时转 active；不一致时标 changed 或候选更新 |
| TL-P4-03 | todo | `FactExtractorService` 输出足够 sourceTrace | `fact-extractor.service.ts` | `StoryEvent` metadata 能追踪 draftId、generatedBy、summary |
| TL-P4-04 | todo | 普通章节生成后接入对齐预览 | `generation.service.ts`、`generate-chapter.service.ts` | `autoUpdateTimeline=false` 时不运行；true 时运行预览与校验 |
| TL-P4-05 | todo | 明确普通生成的写入策略 | `GenerationProfile` 相关代码 | 第一版建议：校验全通过才可自动写；有 error 直接报错；有 warning 进入待审或失败 |
| TL-P4-06 | todo | 写入后清理召回缓存 | persist 工具、service | 成功写 `TimelineEvent` 后调用 `NovelCacheService.deleteProjectRecallResults(projectId)` |

### Phase 5：前端时间线更新体验

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P5-01 | todo | `TimelinePanel` 展示状态、来源、计划/确认差异 | `apps/web/components/TimelinePanel.tsx` | planned/active/changed/archived 可读 |
| TL-P5-02 | todo | 新增时间线更新预览组件 | `apps/web/components/*` | 展示 create/update/archive/confirm diff |
| TL-P5-03 | todo | Generation Config 文案更新 | `GenerationConfigPanel.tsx` | `autoUpdateTimeline` 明确说明会运行校验和写入策略 |
| TL-P5-04 | todo | Agent Artifact 支持 timeline-only preview/validate/persist 结果 | `AgentArtifactPanel.tsx` | 与 continuity mixed diff 并存 |
| TL-P5-05 | todo | 浏览器真实测试 | Docker Compose + Browser Use/Playwright | 时间线页面能看到生成后的状态变化 |

### Phase 6：测试、评估与回归

| ID | 状态 | 任务 | 主要文件 | 验收标准 |
|---|---|---|---|---|
| TL-P6-01 | todo | 单元测试：preview/validate 只读 | `agent-services.spec.ts` | spy 断言只读工具不调用 create/update/delete |
| TL-P6-02 | todo | 单元测试：persist 审批边界 | `agent-services.spec.ts` | plan 模式、未审批、伪造前序输出全部拒绝 |
| TL-P6-03 | todo | 单元测试：章节后自动更新 | `agent-services.spec.ts` | `autoUpdateTimeline` true/false 行为明确 |
| TL-P6-04 | todo | Agent Eval 增加计划时间线和章节确认用例 | `agent-eval-cases.json`、eval scripts | Planner 使用 timeline-only preview/validate/persist |
| TL-P6-05 | todo | 回归命令 | 根目录 | `pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`、`git diff --check` 通过 |
| TL-P6-06 | todo | Docker Compose 真实验证 | 根目录 | `docker compose up -d --build` 后核心 API/UI 可用 |

## 6. 失败处理要求

所有时间线生成、对齐、校验和写入链路必须遵守以下规则：

- LLM 超时、失败、返回非 JSON、返回结构不完整：直接报错。
- 候选数量不足、章节号不连续、chapterNo/chapterId 不属于当前项目：直接报错。
- `title/eventTime/participants/cause/result/impactScope/knownBy/unknownBy/sourceTrace` 缺失：直接报错。
- 不得在 normalize 阶段自动补标题、补原因、补结果、补知情范围或补章节。
- 不得把“无”或空数组当成成功时间线，除非用户明确要求生成空时间线并且不会写入。
- 只读工具必须有测试证明不写业务表。
- 写入工具必须在 Act + approval 或明确的普通生成自动写策略下执行，并且二次校验当前项目隔离。

## 7. 验收命令

普通服务级验证：

```bash
pnpm db:generate
pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

真实环境验证遵循项目根目录 Docker Compose：

```bash
docker compose ps
docker compose up -d --build
pnpm db:migrate
pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma
```

如果已有容器在运行且需要干净重启：

```bash
docker compose down
docker compose up -d --build
```

## 8. 给自主执行 Agent 的提示词

下面提示词用于让后续 Codex/Agent 按本计划持续开发。它要求每完成一个小任务就 `git add` 并 `git commit`，且不得提交未验证或无关改动。

```text
你在 F:\code\ai-novel 工作。请先阅读 AGENTS.md 和 docs/architecture/timeline-generation-development-plan.md，然后按该开发计划从最小可完成任务开始持续实现。

工作原则：
1. 时间线内容是小说事实约束，任何进入审批、写入或后续生成链路的内容都不得使用占位模板、确定性补齐或静默降级。
2. LLM 调用失败、超时、返回非 JSON、结构不完整、数量不足、关键字段缺失、章节号错误、跨项目引用、sourceTrace 不可信时，必须直接报错。
3. preview/validate 工具必须只读；persist 工具必须 Act + approved 或明确受 GenerationProfile 自动写策略保护。
4. 普通章节生成不得无校验直接写 TimelineEvent。
5. 不要重构无关模块，不要改动与当前小任务无关的文件。
6. 如果工作区已有用户改动，先用 git status --short 识别；不要覆盖或提交无关改动。

执行方式：
1. 选择 docs/architecture/timeline-generation-development-plan.md 中下一个 todo 小任务。
2. 把该任务在文档中标记为 in_progress，并开始实现。
3. 实现时优先沿用现有 Agent Tool、Service、DTO、Prisma、前端面板和测试风格。
4. 为当前小任务补测试；涉及生成内容的测试必须覆盖失败即失败，不允许 fallback。
5. 至少运行与该任务相关的验证命令；后端任务优先运行 pnpm --filter api test:agent 和 pnpm --filter api build；前端任务运行 pnpm --filter web build；通用收尾运行 git diff --check。
6. 验证通过后，把该任务在文档中标记为 done，并补一条简短完成记录，写清测试命令。
7. 执行 git status --short，确认只包含当前小任务相关文件。
8. 使用精确路径暂存，不要使用 git add .：
   git add <当前小任务相关文件>
9. 提交：
   git commit -m "timeline: <简短说明>"
10. 每完成一个小任务都必须独立 git add + git commit。不要把多个任务混在一个提交里。
11. 如果验证失败，先修复再提交；无法修复时停止，说明阻塞原因、已改文件和失败命令，不要提交失败状态。
12. 完成一个小任务并提交后，继续下一个 todo，直到计划完成或遇到无法自行解决的阻塞。

真实 Web/UI 测试必须使用根目录 Docker Compose，不要用单独前端 dev server 代替：
docker compose ps
docker compose up -d --build

每次最终汇报请包含：
- 已完成的任务 ID
- commit hash 和提交说明
- 运行过的验证命令
- 未完成任务或阻塞
```
