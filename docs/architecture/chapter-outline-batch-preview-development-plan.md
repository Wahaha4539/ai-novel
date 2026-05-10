# 章节细纲分段批次生成开发任务文档

> 更新说明（2026-05-11）：本文件记录早期 batch 方案背景。关于“章节细纲默认承接卷大纲 `Volume.chapterCount` / `storyUnitPlan`、自然语言数字只由 LLM Planner 结构化输出、长卷 batch 不追加终局 `validate_outline`”的新口径，以 `docs/architecture/chapter-outline-context-driven-flow-design.md` 和 `docs/architecture/chapter-outline-context-driven-flow-development-plan.md` 为准。

> 状态：待实现开发计划
> 任务前缀：`COB`，即 Chapter Outline Batch
> 范围：Agent 工作台整卷章节细纲生成、Planner 编排、章节细纲批次工具、合并校验、Artifact/UI 展示、端到端验证
> 目标：把“第一卷 60 章章节细纲”这类长任务从 60 次单章 LLM 调用优化为按 story unit/连续章节段生成，同时保持 60 章可见、可校验、可审批、可写入，并严格遵守失败即失败原则。

## 1. 背景

当前 Agent 工作台已经能正确识别用户指令：

```text
帮我生成第一卷的章节细纲。
```

并生成完整计划：

```text
inspect_project_context: 1
generate_chapter_outline_preview: 60
merge_chapter_outline_previews: 1
persist_outline: 1
```

这解决了“执行计划没有展现 60 章细纲”的问题，但真实端到端测试暴露出新的运行问题：

1. 60 章逐章生成耗时过长。
2. 每章都可能触发结构化输出 repair，调用成本进一步放大。
3. 用户在 Plan 阶段需要看到完整 60 章，但不一定需要后端真的用 60 次独立 LLM 调用完成。
4. 第一卷已有 `Volume.narrativePlan` 和 `storyUnitPlan`，适合按连续叙事单元生成，而不是孤立单章生成。

因此本计划引入“分段批次生成”：

```text
用户仍看到 60 章章节细纲
LLM 按 3-5 章或 1 个 story unit 一批生成
后端只负责切分、传上下文、校验、合并和失败上抛
后端不得生成剧情占位、不得补章、不得补 craftBrief 内容
```

## 2. 核心原则

1. 批次只是 LLM 调用粒度，不是内容 fallback。
2. 所有章节内容、章节目标、冲突、outline、craftBrief、角色执行、线索和关系变化必须来自 LLM 输出。
3. 后端可以做结构化切分、引用解析、校验、合并和错误报告。
4. 后端不得在 normalize、merge、persist 阶段补齐缺失章节、缺失 craftBrief、缺失角色执行或模板剧情。
5. LLM 输出章节数不足、章号不连续、字段缺失、角色来源非法、storyUnit 不匹配时，允许进入 LLM repair；repair 后仍不合法则失败。
6. Plan/UI 必须继续让用户看到完整 60 章目标，不得把整卷细纲隐藏成一个含糊的“批量生成”步骤。
7. 写入仍由 `persist_outline` 审批后执行，Plan 模式只生成预览和校验结果。

## 3. 非目标

- 不重写正文生成链路。
- 不改写 `Chapter` / `Volume` 数据库 schema。
- 不引入 Worker、队列或新的独立运行时。
- 不用 deterministic fallback 生成小说内容。
- 不把章节细纲任务误导为正文写作。
- 不让章节级工具创建正式 `Character`；重要新角色仍必须来自卷级 `characterPlan.newCharacterCandidates`。

## 4. 目标流程

### 4.1 分层规划

整卷章节细纲任务应分为三层：

```text
parse goal
  -> 只解析用户目标、卷号、章数、是否复用已有卷纲/单元故事

select context
  -> 根据目标加载第一卷 narrativePlan、storyUnitPlan、角色、关系、状态、已有章节

generate batches
  -> 按 storyUnit/连续章节段生成批次预览，合并成 60 章完整细纲
```

第一层只允许使用轻量上下文，例如：

```json
{
  "userGoal": "帮我生成第一卷的章节细纲。",
  "volumes": [
    {
      "volumeNo": 1,
      "title": "黑脊罪桥",
      "chapterCount": 60,
      "hasNarrativePlan": true,
      "hasStoryUnitPlan": true
    }
  ]
}
```

目标解析输出应类似：

```json
{
  "intent": "split_volume_to_chapters",
  "volumeNo": 1,
  "chapterCount": 60,
  "reuseVolumeNarrativePlan": true,
  "reuseStoryUnitPlan": true,
  "contextNeeds": [
    "targetVolume.narrativePlan",
    "targetVolume.storyUnitPlan",
    "characters",
    "relationships",
    "characterStates",
    "existingChapters"
  ]
}
```

### 4.2 推荐 Agent Plan

批次方案落地后，整卷 60 章细纲计划应类似：

```text
1. inspect_project_context
2. segment_chapter_outline_batches
3. generate_chapter_outline_batch_preview 第 1-4 章
4. generate_chapter_outline_batch_preview 第 5-8 章
...
N. merge_chapter_outline_batch_previews
N+1. persist_outline
```

如果第一卷 storyUnit 范围为：

```text
v1_unit_01: 第 1-4 章
v1_unit_02: 第 5-8 章
v1_unit_03: 第 9-13 章
```

则优先按这些边界切分。若某个 storyUnit 超过 5 章，再在其内部按连续章节段切分。

### 4.3 UI 展示

计划视图需要展示两层：

```text
生成第 1-4 章细纲预览
  第 1 章
  第 2 章
  第 3 章
  第 4 章

生成第 5-8 章细纲预览
  第 5 章
  第 6 章
  第 7 章
  第 8 章
```

总摘要需要明确：

```text
第一卷共 60 章，将按 15 个连续叙事段生成，每段 3-5 章；最终合并为 60 章完整细纲后再审批写入。
```

审批面板只允许在全部 batch、merge、validate 成功后出现。

## 5. 批次切分规则

新增内部切分规则或工具：

```text
segment_chapter_outline_batches
```

### 输入

```ts
type SegmentChapterOutlineBatchesInput = {
  context: InspectProjectContextOutput;
  volumeNo: number;
  chapterCount: number;
  preferredBatchSize?: number;
  maxBatchSize?: number;
};
```

### 输出

```ts
type ChapterOutlineBatchPlan = {
  volumeNo: number;
  chapterCount: number;
  batches: Array<{
    batchNo: number;
    chapterRange: { start: number; end: number };
    storyUnitIds: string[];
    reason: string;
  }>;
  risks: string[];
};
```

### 切分策略

| 规则 | 要求 |
|---|---|
| storyUnit 优先 | 若 `storyUnitPlan.chapterAllocation` 存在，优先按单元边界切分。 |
| 最小批次 | 通常不少于 3 章，除非 storyUnit 本身更短或处在卷末。 |
| 理想批次 | 4 章左右。 |
| 最大批次 | 默认不超过 5 章。 |
| 边界保护 | 不跨越 storyUnit 边界，除非上游 storyUnitPlan 缺失。 |
| 覆盖要求 | batches 必须覆盖 `1..chapterCount`，不得缺章、重叠或越界。 |

若无法从上游卷纲或 storyUnitPlan 推出连续章节范围，应失败或要求用户补充上下文，不得默认生成 60 个空批次。

## 6. 新增工具设计

### 6.1 `generate_chapter_outline_batch_preview`

用途：一次生成连续 3-5 章章节细纲与完整 `Chapter.craftBrief`。

风险等级：low。

是否写入：否。

### 输入契约

```ts
type GenerateChapterOutlineBatchPreviewInput = {
  context: InspectProjectContextOutput;
  volumeNo: number;
  chapterCount: number;
  chapterRange: { start: number; end: number };
  instruction: string;
  storyUnitSlice?: Record<string, unknown>;
  previousBatchTail?: {
    chapterNo: number;
    title: string;
    hook: string;
    craftBrief?: {
      exitState?: string;
      handoffToNextChapter?: string;
      openLoops?: string[];
      continuityState?: Record<string, unknown>;
    };
  };
  characterSourceWhitelist?: {
    existing: string[];
    volume_candidate: string[];
  };
};
```

### 输出契约

```ts
type ChapterOutlineBatchPreviewOutput = {
  batch: {
    volumeNo: number;
    chapterRange: { start: number; end: number };
    storyUnitIds: string[];
    continuityBridgeIn: string;
    continuityBridgeOut: string;
  };
  chapters: OutlinePreviewOutput["chapters"];
  risks: string[];
  repairDiagnostics?: Array<{
    attempted: boolean;
    attempts: number;
    repairedFromErrors: string[];
    model?: string;
  }>;
};
```

### 强校验

`generate_chapter_outline_batch_preview` 必须校验：

1. `chapters.length === chapterRange.end - chapterRange.start + 1`
2. `chapterNo` 连续且等于目标范围。
3. 每章 `volumeNo` 正确。
4. 每章 `title/objective/conflict/hook/outline/expectedWordCount` 完整。
5. 每章 `craftBrief` 完整。
6. 每章 `craftBrief.storyUnit` 承接目标 storyUnit。
7. 每章 `craftBrief.characterExecution` 完整。
8. `characterExecution.cast.source` 只能是 `existing`、`volume_candidate`、`minor_temporary`。
9. `existing` 必须来自角色摘要。
10. `volume_candidate` 必须来自卷级 `characterPlan.newCharacterCandidates`。
11. `minor_temporary` 必须出现在 `newMinorCharacters`，且 `firstAndOnlyUse === true`。
12. `sceneBeats.participants` 和 `relationshipBeats.participants` 必须全部被 `cast.characterName` 覆盖。
13. `previousBatchTail` 存在时，第一章必须承接上一批的压力、open loops 或 handoff。
14. 批次最后一章必须提供下一批可承接的 `handoffToNextChapter` 和 `continuityState.nextImmediatePressure`。

局部结构错误允许进入 LLM repair。数量不足、缺整章、缺整张 `craftBrief`、重要角色来源非法且卷级无候选时，不允许后端补齐。

### 6.2 `merge_chapter_outline_batch_previews`

用途：把多个 batch preview 合并为标准 `OutlinePreviewOutput`。

风险等级：low。

是否写入：否。

### 输入契约

```ts
type MergeChapterOutlineBatchPreviewsInput = {
  context?: InspectProjectContextOutput;
  volumeNo: number;
  chapterCount: number;
  batchPreviews: ChapterOutlineBatchPreviewOutput[];
};
```

### 输出契约

沿用：

```ts
type OutlinePreviewOutput = {
  volume: {
    volumeNo: number;
    title: string;
    synopsis: string;
    objective: string;
    chapterCount: number;
    narrativePlan?: Record<string, unknown>;
  };
  chapters: Array<{
    chapterNo: number;
    volumeNo?: number;
    title: string;
    objective: string;
    conflict: string;
    hook: string;
    outline: string;
    expectedWordCount: number;
    craftBrief?: ChapterCraftBrief;
  }>;
  risks: string[];
};
```

### 合并校验

1. batch 范围必须覆盖 `1..chapterCount`。
2. batch 之间不得重叠。
3. 章节不得缺失。
4. 章节不得重复。
5. 全部章节必须通过单章 `craftBrief` 和角色执行校验。
6. 跨 batch 的 `handoffToNextChapter`、`entryState`、`openLoops`、`continuityState.nextImmediatePressure` 应连续。
7. 如果合并后章节数不足，例如 `59/60`，直接失败。

## 7. Planner 改造

### 7.1 触发条件

当满足以下条件时使用批次链路：

```text
route.domain === "outline"
route.intent === "split_volume_to_chapters"
chapterCount > 12
用户目标是整卷章节细纲、卷细纲、章节规划或拆成 N 章
```

当用户只要求单章细纲，例如“生成第 3 章细纲”，继续使用 `generate_chapter_outline_preview`。

### 7.2 ToolBundle

`outline.chapter` bundle 需要加入：

```text
segment_chapter_outline_batches
generate_chapter_outline_batch_preview
merge_chapter_outline_batch_previews
```

并保留现有：

```text
inspect_project_context
generate_chapter_outline_preview
merge_chapter_outline_previews
persist_outline
```

`validate_outline` 只作为人工诊断或旧链路兼容工具；长卷 batch 主链路不在所有 batch 合并后追加终局 `validate_outline`。

### 7.3 PlanValidator

PlanValidator 需要支持两种合法形态：

单章或少量章节：

```text
generate_chapter_outline_preview x N
merge_chapter_outline_previews
```

长整卷：

```text
segment_chapter_outline_batches
generate_chapter_outline_batch_preview x M
merge_chapter_outline_batch_previews
```

校验规则：

1. 若 route 能确定 `chapterCount=N`，计划必须覆盖 `1..N`。
2. 批次计划必须能从 `chapterRange` 推导出完整覆盖。
3. 不允许只返回一个含糊的 `inspect_project_context` 或单个批量描述步骤。
4. `persist_outline` 必须 `requiresApproval=true`。
5. Plan 模式不得执行写入。

## 8. 前端改造

### 8.1 Agent 任务窗口

影响文件：

```text
apps/web/components/agent/AgentMissionWindow.tsx
apps/web/components/agent/AgentTimelinePanel.tsx
apps/web/components/agent/AgentArtifactPanel.tsx
apps/web/components/agent/AgentSharedWidgets.tsx
```

需求：

1. 识别 batch preview artifact。
2. 在计划中显示批次步骤，同时展开章节子项。
3. 执行进度显示为 `已生成章节数 / 目标章节数`，而不是只显示 batch 数。
4. 审批面板只在 `waiting_approval` 或 `waiting_review` 出现。
5. Artifact 中显示：
   - batch 数
   - 章节数
   - repair 次数
   - 每章标题、目标、冲突、hook
   - craftBrief 摘要
   - 风险

### 8.2 用户可见文案

推荐文案：

```text
将按第一卷已有单元故事，把 60 章拆成 15 个连续叙事段生成。每段生成 3-5 章，最终合并为完整 60 章细纲，校验通过后再等待审批写入。
```

避免文案：

```text
批量生成章节
自动补齐章节
后端生成缺失章节
```

## 9. 任务拆解

### COB-P0：契约与文档落地

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P0-001 | [x] | 新增本开发任务文档。 | `docs/architecture/chapter-outline-batch-preview-development-plan.md` | 文档覆盖背景、目标、非目标、工具契约、任务拆解和测试计划。 |
| COB-P0-002 | [ ] | 梳理现有章节细纲工具契约，确认可复用校验函数。 | `chapter-outline-preview-tools.tool.ts`, `outline-character-contracts.ts`, `story-unit-contracts.ts` | 列出可复用函数和需要抽出的 shared helper。 |
| COB-P0-003 | [ ] | 明确 batch 输出不可 fallback 的质量边界。 | `AGENTS.md`, 本文档或相关 architecture 文档 | 文档明确后端不得补章节内容。 |

### COB-P1：批次切分能力

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P1-001 | [ ] | 新增 `segment_chapter_outline_batches` Tool 或内部 planner helper。 | `apps/api/src/modules/agent-tools/tools/*` | 输入第一卷 60 章 storyUnitPlan，输出连续无重叠 batch。 |
| COB-P1-002 | [ ] | 支持按 `storyUnitPlan.chapterAllocation` 切分。 | 同上 | storyUnit 边界不会被跨越。 |
| COB-P1-003 | [ ] | 支持超长 storyUnit 内部再切分。 | 同上 | 10 章 storyUnit 可切为 2-3 个 batch。 |
| COB-P1-004 | [ ] | 增加切分校验：覆盖、连续、不重叠、不越界。 | 同上 | 缺章/重叠直接失败。 |

### COB-P2：批次生成工具

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P2-001 | [ ] | 新增 `GenerateChapterOutlineBatchPreviewTool`。 | `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts` 或新文件 | 工具注册到 `ToolRegistryService`。 |
| COB-P2-002 | [ ] | 设计 batch system/user prompt。 | 同上 | prompt 明确输出连续章节数组和完整 craftBrief。 |
| COB-P2-003 | [ ] | 注入角色来源白名单。 | 同上 | prompt 包含 `existing` 和 `volume_candidate` 名单。 |
| COB-P2-004 | [ ] | 实现 batch normalize。 | 同上 | 返回数量不足、章号不连续、缺 craftBrief 直接失败。 |
| COB-P2-005 | [ ] | 接入 `normalizeWithLlmRepair`。 | 同上 | 局部字段错误可 repair，缺整章不可 repair。 |
| COB-P2-006 | [ ] | 记录 LLM usage、repair diagnostics 和进度。 | 同上 | Agent step 可显示 batch range 和 repair 状态。 |

### COB-P3：批次合并工具

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P3-001 | [ ] | 新增 `MergeChapterOutlineBatchPreviewsTool`。 | `chapter-outline-preview-tools.tool.ts` 或新文件 | 多个 batch 合并成标准 `OutlinePreviewOutput`。 |
| COB-P3-002 | [ ] | 复用单章 craftBrief / characterExecution 校验。 | `outline-character-contracts.ts` | 合并时能拦截角色来源错误。 |
| COB-P3-003 | [ ] | 增加跨 batch continuity 校验。 | 同上 | 上一批 handoff 与下一批 entryState 断裂时输出 issue 或失败。 |
| COB-P3-004 | [ ] | 保持 `persist_outline` 下游兼容；`validate_outline` 仅保留为人工诊断或旧链路兼容。 | `persist-outline.tool.ts`, `validate-outline.tool.ts` | 合并产物可直接进入审批写入，长卷 batch 主链路不追加终局 `validate_outline`。 |

### COB-P4：Planner 与 PlanValidator

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P4-001 | [ ] | 更新 `outline.chapter` ToolBundle。 | `planner-graph/tool-bundles/outline.tool-bundle.ts` | selected tools 包含 batch 工具。 |
| COB-P4-002 | [ ] | 更新 Planner prompt guidance。 | `agent-planner.service.ts` | `chapterCount > 12` 时优先 batch。 |
| COB-P4-003 | [ ] | 更新 `PlanValidatorService` 支持 batch 覆盖校验。 | `plan-validator.service.ts` | 不完整 batch plan 被拒绝。 |
| COB-P4-004 | [ ] | 保留单章/少量章节走单章工具。 | Planner 和 validator | “生成第 3 章细纲”不走 batch。 |
| COB-P4-005 | [ ] | 更新 planner eval case。 | `apps/api/test/fixtures/agent-eval-cases.json`, `scripts/dev/eval_agent_planner.ts` | 第一卷 60 章细纲输出 batch plan，并覆盖 1..60。 |

### COB-P5：Agent Artifact 与前端展示

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P5-001 | [ ] | Runtime 识别 batch preview artifact。 | `agent-runtime.service.ts` | Plan 预览产物包含 batch 摘要。 |
| COB-P5-002 | [ ] | ArtifactPanel 展示 batch 和章节子项。 | `AgentArtifactPanel.tsx` | 用户可看到 60 章。 |
| COB-P5-003 | [ ] | MissionWindow/Todo 展示批次展开子项。 | `AgentMissionWindow.tsx` | 计划不是含糊的“批量生成”。 |
| COB-P5-004 | [ ] | 进度显示章节覆盖数量。 | `AgentTimelinePanel.tsx`, `AgentMissionWindow.tsx` | 显示 `12/60`、`24/60` 等章节进度。 |
| COB-P5-005 | [ ] | 审批面板只在预览完成后出现。 | `AgentMissionWindow.tsx` | planning/running 时不出现确认写入。 |

### COB-P6：端到端验证

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| COB-P6-001 | [ ] | 单元测试覆盖 batch 切分。 | `agent-services.spec.ts` | 60 章切分覆盖完整。 |
| COB-P6-002 | [ ] | 单元测试覆盖 batch 生成结构错误 repair。 | `agent-services.spec.ts` | 局部字段错误可修，缺整章失败。 |
| COB-P6-003 | [ ] | 单元测试覆盖 merge 缺章/重叠/错序失败。 | `agent-services.spec.ts` | 不合法合并直接失败。 |
| COB-P6-004 | [ ] | Planner 测试覆盖整卷 batch plan。 | `agent-services.spec.ts` | 60 章 plan 由 batch 覆盖，不是 60 次单章调用。 |
| COB-P6-005 | [ ] | Docker Compose 端到端测试。 | 本地环境 | 输入“帮我生成第一卷的章节细纲。”，计划显示 batch 和 60 章，预览执行不提前出现审批写入。 |

## 10. 测试计划

### 后端测试

```bash
pnpm --dir apps/api test:agent
pnpm --dir apps/api build
```

建议新增 targeted filter：

```bash
AGENT_TEST_FILTER="COB" pnpm --dir apps/api test:agent
```

覆盖场景：

1. 第一卷 60 章按 storyUnit 切分。
2. batch 生成 1-4 章成功。
3. batch 返回 3/4 章失败。
4. batch 返回章号 `1,2,4` 失败。
5. batch 某章缺 `craftBrief.characterExecution` 失败或进入 repair。
6. repair 后仍缺字段失败。
7. 合并 batch 缺第 37 章失败。
8. 合并 batch 重叠第 8 章失败。
9. 合并后直接进入审批写入链路；不追加终局 `validate_outline` 作为整卷兜底。
10. `persist_outline` 仍要求审批。

### 前端测试

```bash
pnpm --dir apps/web build
```

浏览器手工检查：

1. 打开 `http://localhost:3002/`。
2. 进入 Agent 工作台。
3. 输入 `帮我生成第一卷的章节细纲。`
4. 计划摘要显示第一卷 60 章。
5. 计划步骤显示批次，并能展开看到第 1-60 章。
6. planning/running 阶段不显示“确认写入”。
7. 全部预览、合并、校验完成后才显示审批。

### Docker Compose 验证

按照项目约束，端到端测试使用：

```bash
docker compose ps
docker compose down
docker compose up -d --build
```

然后访问：

```text
http://localhost:3002/
```

## 11. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 单批 5 章仍然过长 | LLM 输出超时或截断 | 默认 4 章，最大 5 章；按模型能力可配置。 |
| batch 内章节质量不均 | 中间章节可能摘要化 | prompt 要求每章完整 craftBrief；normalize 严格校验。 |
| storyUnitPlan 缺失 | 无法合理切分 | 失败并要求先生成/修复单元故事；不默认瞎切。 |
| 跨 batch 连续性断裂 | 情节接力不顺 | 使用 previousBatchTail，merge 阶段做 continuity 校验。 |
| UI 看起来少于 60 章 | 用户误以为缩水 | 批次步骤必须展开章节子项，总摘要明确 60 章。 |
| repair 仍然耗时 | 速度收益下降 | 白名单、storyUnitSlice、角色名单在 prompt 里前置，降低初稿结构错误率。 |
| 后端误补内容 | 违反质量原则 | 所有补齐类逻辑禁止写入；测试覆盖缺章/缺字段直接失败。 |

## 12. 推荐实现顺序

1. COB-P1：先做批次切分，验证能稳定覆盖 60 章。
2. COB-P2：实现 batch preview 工具，先用 mock LLM 测结构。
3. COB-P3：实现 batch merge，确保输出可直接进入审批后的 `persist_outline`，`validate_outline` 仅保留为旧链路兼容或人工诊断。
4. COB-P4：接入 Planner 和 PlanValidator。
5. COB-P5：补前端展示。
6. COB-P6：Docker Compose 端到端测试。

第一批可交付最小闭环：

```text
segment_chapter_outline_batches
generate_chapter_outline_batch_preview
merge_chapter_outline_batch_previews
Planner 长整卷细纲走 batch
Artifact 能看到 60 章
```

## 13. 完成定义

本专项完成时应满足：

1. 用户输入 `帮我生成第一卷的章节细纲。` 后，Planner 能生成覆盖第一卷 60 章的 batch plan。
2. Plan UI 能清楚展示 60 章目标和每个章节子项。
3. LLM 调用次数从 60 次单章调用降低到约 12-18 次 batch 调用。
4. 任意 batch 输出缺章、错章、缺关键字段时不会被后端补齐。
5. LLM repair 只修复局部结构错误，repair 失败则整个 run 明确失败。
6. 合并产物仍是标准 `OutlinePreviewOutput`，可被审批后的 `persist_outline` 复用；`validate_outline` 不作为 batch 主链路终局门禁。
7. Plan 模式不写库，审批后才允许 `persist_outline`。
8. `pnpm --dir apps/api test:agent`、`pnpm --dir apps/api build`、`pnpm --dir apps/web build` 通过。
9. Docker Compose 端到端测试通过。

