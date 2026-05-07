# Agent 章节细纲质量对齐开发计划

> 状态：待实现开发计划  
> 范围：`generate_outline_preview`、`validate_outline`、`persist_outline`、Agent 大纲 Artifact、卷管理/正文生成前章节细纲可见性  
> 目标：把 Agent 工作台生成的卷/章节大纲预览升级到接近 AI 引导 `guided_chapter` 的信息密度，让写入后的章节可直接支撑正文生成。  
> 约束：不引入新队列技术栈；继续复用 AgentRun 异步执行、Step phase 轮询、Tool 内层 LLM timeout 和 watchdog 治理。

## 1. 背景

当前项目里存在两套章节细纲生成链路：

1. **AI 引导 `guided_chapter`**
   - 以创作引导步骤为中心。
   - 按卷生成章节细纲和本卷配角。
   - 结果包含 `craftBrief`，可写入 `Chapter.craftBrief`。
   - 提示词要求每章有主线任务、支线推进、行动链、线索、潜台词、人物变化和不可逆后果。

2. **Agent 工作台 `generate_outline_preview`**
   - 以 Agent Plan/Act 产物为中心。
   - 当前输出 `volume + chapters + risks`。
   - 每章只有 `chapterNo/title/objective/conflict/hook/outline/expectedWordCount`。
   - `persist_outline` 写入 `Chapter.title/objective/conflict/revealPoints/outline/expectedWordCount`，不写 `craftBrief`。

近期真实数据也暴露出差异：Agent 生成的 60 章可以写入业务表，但所有章节的 `craftBrief` 为空；正文生成虽然会读取 `objective/conflict/outline`，但缺少“本章执行卡”，生成质量更容易变成泛化推进。

本计划把 Agent 的章节细纲产物升级为“可审批、可写库、可用于正文生成”的高密度结构，同时保留当前 AgentRun 进度轮询与超时治理能力。

## 2. 目标

- Agent 工作台生成章节细纲时，输出接近 `guided_chapter` 的结构化字段。
- `OutlinePreviewOutput.chapters[]` 增加可选 `craftBrief`，并保持旧字段兼容。
- `persist_outline` 在审批后写入 `Chapter.craftBrief`，同时继续保护已起草章节不被覆盖。
- `validate_outline` 能检查 `craftBrief` 质量和缺失风险。
- 60 章这类长细纲不再一次性塞给单个 LLM 请求，而是按卷/批次生成并合并。
- Agent Artifact 能展示 `craftBrief` 摘要，卷管理页能看到写入后的章节执行卡摘要。
- 任何 LLM 超时仍由 Tool 内部 timeout/fallback 处理，不退回外层“工具执行超时”。

## 3. 非目标

- 不把 Agent `outline_design` 变成正文生成工具；本专项只生成规划。
- 不替代 AI 引导流程；AI 引导仍是结构化创作向导入口。
- 不在本轮引入 BullMQ/Redis worker 或新的 DB-backed job runner。
- 不强制修改已有 `Chapter` schema；优先复用现有 `Chapter.craftBrief`。
- 不覆盖已 `drafted` 或已有正文的章节细纲，除非后续用户明确选择重写。

## 4. 当前差异

| 维度 | AI 引导 `guided_chapter` | Agent `generate_outline_preview` 当前状态 | 目标状态 |
|---|---|---|---|
| 输出用途 | 引导文档/业务写入 | Agent Plan Artifact/审批后写入 | Agent Plan Artifact/审批后写入 |
| 章节基础字段 | 有 | 有 | 保留 |
| `craftBrief` | 有，强约束 | 无 | 有，强约束 |
| 本卷配角 | 有 `supportingCharacters` | 无 | 可作为 P3 扩展 |
| 提示词强度 | 高 | 低 | 对齐 guided 质量要求 |
| 长章节策略 | 按卷生成，UI 范围通常 8-30 | 单次请求最多 80 章 | 按卷/批次生成 |
| 写库字段 | `Chapter.craftBrief` | 不写 `craftBrief` | 写 `craftBrief` |
| fallback | 无明确骨架策略 | 有确定性 fallback | fallback 也补齐基础 `craftBrief` |

## 5. 目标数据契约

### 5.1 兼容增强 `OutlinePreviewOutput`

保持现有字段不破坏：

```ts
export interface OutlinePreviewOutput {
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
    title: string;
    objective: string;
    conflict: string;
    hook: string;
    outline: string;
    expectedWordCount: number;
    volumeNo?: number;
    craftBrief?: ChapterCraftBrief;
  }>;
  risks: string[];
}
```

### 5.2 `ChapterCraftBrief`

复用前端/引导已有结构：

```ts
type ChapterCraftBrief = {
  visibleGoal?: string;
  hiddenEmotion?: string;
  coreConflict?: string;
  mainlineTask?: string;
  subplotTasks?: string[];
  actionBeats?: string[];
  concreteClues?: Array<{
    name: string;
    sensoryDetail?: string;
    laterUse?: string;
  }>;
  dialogueSubtext?: string;
  characterShift?: string;
  irreversibleConsequence?: string;
  progressTypes?: string[];
};
```

### 5.3 写库映射

| Preview 字段 | 写入位置 |
|---|---|
| `volume.title` | `Volume.title` |
| `volume.synopsis` | `Volume.synopsis` |
| `volume.objective` | `Volume.objective` |
| `volume.chapterCount` | `Volume.chapterCount` |
| `volume.narrativePlan` | `Volume.narrativePlan`，如果已存在 schema 字段 |
| `chapter.title` | `Chapter.title` |
| `chapter.objective` | `Chapter.objective` |
| `chapter.conflict` | `Chapter.conflict` |
| `chapter.hook` | `Chapter.revealPoints` |
| `chapter.outline` | `Chapter.outline` |
| `chapter.expectedWordCount` | `Chapter.expectedWordCount` |
| `chapter.craftBrief` | `Chapter.craftBrief` |

写入保护保持不变：不存在则创建，`planned` 可更新，已有正文/非 planned 章节跳过。

## 6. 生成策略

### 6.1 不再一次性生成 60 章

当 `chapterCount` 较大时，将一次 Agent 大纲请求拆成多个批次：

```text
第 1 卷 60 章
  batch 1: chapters 1-12
  batch 2: chapters 13-24
  batch 3: chapters 25-36
  batch 4: chapters 37-48
  batch 5: chapters 49-60
```

建议默认批次大小：`10-12` 章。后续可按模型能力和 `maxTokens` 动态调整。

### 6.2 批次上下文

每个批次请求至少带：

- 项目概览。
- 目标卷 `volumeNo/title/objective/synopsis/narrativePlan`。
- 全卷章节目标数量和当前批次范围。
- 前一批末尾 1-2 章摘要，避免断裂。
- 已生成章节标题/目标短表，避免重复。
- 角色和设定摘要。

### 6.3 Prompt 要求

Agent `generate_outline_preview` 的章节 prompt 应吸收 `guided_chapter` 的核心规则：

- 每章至少领到 1 个本卷主线任务。
- 每章至少推进 1 条卷内支线。
- `objective` 必须具体可检验，不能只写“推进主线”。
- `conflict` 必须写清阻力来源和阻力方式。
- `outline` 必须包含具体场景、关键行动和阶段结果。
- 每章必须输出 `craftBrief`。
- `craftBrief.actionBeats` 至少 3 个节点。
- `craftBrief.concreteClues` 至少 1 个具象线索或物证。
- `craftBrief.irreversibleConsequence` 必须能改变事实、关系、资源、地位、规则或危险等级之一。
- 每 3-4 章至少有一次信息揭示、关系反转、资源得失、地位变化或规则升级。
- 卷末章节必须收束本卷主线，并留下下一卷交接。

### 6.4 fallback 也要补齐 `craftBrief`

LLM timeout/provider error 时仍允许确定性 fallback，但 fallback 不能只返回空洞骨架。

最低 fallback 标准：

- 保证章节数完整。
- 保证 `objective/conflict/hook/outline` 非空。
- 生成基础 `craftBrief`：
  - `visibleGoal` 从 `objective` 派生。
  - `coreConflict` 从 `conflict` 派生。
  - `mainlineTask` 从卷目标派生。
  - `actionBeats` 生成 3 段式行动链。
  - `concreteClues` 生成 1 个待复核线索。
  - `irreversibleConsequence` 随章节阶段派生。
- `risks` 明确标记 `LLM_TIMEOUT` 或 `LLM_PROVIDER_FALLBACK`，提醒用户复核。

## 7. 分阶段实施计划

### P0：契约与写库兼容

目标：在不改变生成策略的前提下，让 Agent 大纲产物和写库链路支持 `craftBrief`。

任务：

1. 扩展 `OutlinePreviewOutput.chapters[]` 类型，增加可选 `craftBrief` 和 `volumeNo`。
2. 新增本地 `ChapterCraftBrief` 类型或复用共享类型，避免前后端重复漂移。
3. 修改 `GenerateOutlinePreviewTool.normalize()`：
   - 接收 LLM 返回的 `craftBrief`。
   - 对非对象或空对象做安全归一化。
   - 缺失时生成基础 fallback `craftBrief`。
4. 修改 `GenerateOutlinePreviewTool.fallback()`：
   - 每章补基础 `craftBrief`。
   - `risks` 中明确“fallback craftBrief 需要人工复核”。
5. 修改 `PersistOutlineTool`：
   - `create/update planned` 时写入 `craftBrief`。
   - 已起草章节继续跳过，避免覆盖正文。
6. 修改 `ValidateOutlineTool`：
   - `craftBrief` 缺失为 warning，不阻塞旧产物。
   - 检查 `visibleGoal/coreConflict/actionBeats/irreversibleConsequence`。
7. 前端 Artifact 展示：
   - `outline_preview` 展示 `craftBrief` 摘要和缺失数。
   - 卷管理页已具备章节细纲展开入口，补充显示执行卡字段即可。

测试：

- `generate_outline_preview` fallback 返回 60 章且每章有基础 `craftBrief`。
- `validate_outline` 对无 `craftBrief` 旧产物只 warning。
- `persist_outline` 写入 `Chapter.craftBrief`。
- 已 `drafted` 章节不会被新 `craftBrief` 覆盖。

验证命令：

```bash
pnpm --dir apps/api test:agent
pnpm --dir apps/api build
pnpm --dir apps/web build
```

### P1：Prompt 质量对齐

目标：让单批 LLM 输出质量接近 `guided_chapter`。

任务：

1. 重写 `generate_outline_preview` system prompt：
   - 明确“章节细纲，不是正文”。
   - 引入主线任务、支线推进、行动链、具体线索、人物变化、不可逆后果规则。
   - 输出必须包含 `craftBrief`。
2. 增强 user prompt：
   - 带 `volume.narrativePlan`。
   - 带已有卷纲 Markdown。
   - 带角色/设定摘要。
   - 带目标章节数和章节范围。
3. 调整 `maxTokens` 估算：
   - 从 `chapterCount * 220 + 1000` 提升为按 `craftBrief` 估算。
   - 防止超模型上下文时自动切批。
4. 保持 `timeoutMs: 90_000`、`retries: 0` 或明确策略，避免外层 timeout 抢先截断。
5. 记录 LLM usage 和 fallback 风险。

测试：

- LLM mock 返回含 `craftBrief` 的章节，normalize 后字段保留。
- LLM mock 返回缺字段，normalize 补齐并输出 warning/risk。
- LLM timeout 时仍返回完整章节和基础执行卡。

### P2：按卷/批次生成

目标：60 章不再走单次大请求。

任务：

1. 在 `GenerateOutlinePreviewTool` 中引入批次策略：
   - `chapterCount <= 15`：单批。
   - `chapterCount > 15`：按 `batchSize=10-12` 拆分。
2. 每批调用 LLM 前更新进度：
   - `phase='calling_llm'`
   - `phaseMessage='正在生成第 X-Y 章细纲'`
   - `progressCurrent=batchIndex`
   - `progressTotal=batchCount`
   - `timeoutMs=90_000`
3. 每批成功后 heartbeat：
   - `phase='merging_preview'`
   - 写入已生成章节数量。
4. 批次失败策略：
   - 单批 LLM timeout 只 fallback 当前批。
   - 其他批继续执行。
   - 总产物 `risks` 汇总每批风险。
5. 合并时校验：
   - 章节号连续。
   - 不重复。
   - 不超过目标章节数。
   - 每章 `volumeNo` 正确。
6. 可选新增内部 helper：
   - `buildOutlineBatchPrompt()`
   - `normalizeOutlineBatch()`
   - `createFallbackBatch()`

测试：

- 60 章拆成多次 LLM 调用。
- 第 2 批超时只 fallback 第 2 批，其余批保留 LLM 输出。
- 最终章节数仍为 60。
- progress 能看到批次进度。
- 不出现外层“工具执行超时”。

### P3：Agent 计划与审批体验

目标：让用户知道这次生成的是“高密度章节执行卡”，并能在写入前审阅风险。

任务：

1. 更新 Tool Manifest：
   - `generate_outline_preview` 描述从“章节大纲预览”升级为“卷/章节细纲与执行卡预览”。
   - 参数提示中说明大章节数会自动分批。
2. 更新 Planner task guidance：
   - 用户要求“卷细纲/章节细纲/60章细纲”时仍选择 `outline_design`。
   - 不误判为 `write_chapter`。
3. Agent Artifact 展示：
   - 总览：章节数、带执行卡章节数、fallback 章节数、风险数。
   - 章节行：目标、冲突、行动链、线索、不可逆后果。
4. 审批文案：
   - 写入会创建/更新 planned 章节。
   - 已起草章节会跳过。
   - fallback 章节建议人工复核。
5. 文档更新：
   - `docs/architecture/outline-generation-upgrade-design.md`
   - `docs/architecture/agent-centric-design.md` 或相关 Agent 执行模型说明。

测试：

- `/api/agent-runs/plan` 快速返回 `agentRunId`。
- 轮询能看到批次 phase。
- 产物区展示 `craftBrief` 摘要。
- 审批后写入，卷管理页展开能看到执行卡摘要。

### P4：章节推进卡独立 Agent Tool

目标：让用户不必进入 AI 引导页，也能在 Agent 工作台用自然语言为某一章或一组章节创建/补齐 `Chapter.craftBrief`。

自然语言触发示例：

- “给第 3 章生成章节推进卡。”
- “把当前章细化成 craftBrief。”
- “为第 12 章补行动链、线索、潜台词和不可逆后果。”
- “把第 1 卷所有 planned 章节补齐推进卡。”
- “这个章节细纲太粗了，帮我补成本章执行卡。”

推荐工具链：

```text
resolve_chapter / list target chapters
  -> collect_chapter_context / collect_task_context
  -> generate_chapter_craft_brief_preview
  -> validate_chapter_craft_brief
  -> persist_chapter_craft_brief
```

拟新增 Tool：

| Tool | 模式 | 风险 | 作用 |
|---|---|---|---|
| `generate_chapter_craft_brief_preview` | `plan/act` | low | 只读生成单章或多章推进卡预览，不写库。 |
| `validate_chapter_craft_brief` | `plan/act` | low | 校验推进卡字段完整性、行动链密度、线索和不可逆后果。 |
| `persist_chapter_craft_brief` | `act` | high | 用户审批后写入 `Chapter.craftBrief`，可选同步更新 `objective/conflict/outline`。 |

建议输出契约：

```ts
type ChapterCraftBriefPreview = {
  chapterId: string;
  chapterNo: number;
  title: string;
  proposedFields: {
    objective?: string;
    conflict?: string;
    outline?: string;
    craftBrief: ChapterCraftBrief;
  };
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    target: 'Chapter.craftBrief';
    requiresValidation: true;
    requiresApprovalBeforePersist: true;
  };
};
```

Planner guidance：

1. 新增或扩展 taskType：`chapter_craft_brief` / `chapter_progress_card`。
2. 触发词包括：
   - “章节推进卡”
   - “推进卡”
   - “执行卡”
   - “craftBrief”
   - “行动链”
   - “本章执行卡”
   - “补齐章节细纲”
   - “细化当前章”
   - “细化第 N 章”
   - “给第 N 章补线索/潜台词/不可逆后果”
3. 如果用户说“写正文/生成正文”，仍走 `write_chapter`，不要误选推进卡工具。
4. 如果用户说“拆成场景/场景卡/SceneCard”，走现有 `generate_scene_cards_preview`，不要误选推进卡工具。

和 SceneCard 的边界：

| 能力 | 数据位置 | 粒度 | 典型用户说法 |
|---|---|---|---|
| 章节推进卡 / `craftBrief` | `Chapter.craftBrief` | 单章规划 | “给第 3 章补执行卡/推进卡/行动链。” |
| SceneCard | `SceneCard` 表 | 章内场景 | “把第 3 章拆成 5 个场景。” |

写入策略：

1. `planned` 章节：
   - 审批后允许写入 `craftBrief`。
   - 可同步更新更具体的 `objective/conflict/outline`。
2. `drafted` 或已有正文章节：
   - 默认只预览，不自动覆盖。
   - 如果用户明确要求更新已写章节推进卡，必须在审批文案中说明不会改正文，只改规划字段。
3. 单章写入后清理章节上下文缓存，让后续正文生成读取最新 `craftBrief`。
4. 批量补齐时逐章记录 `created/updated/skipped` 审计。

Agent Artifact：

- 新增 `chapter_craft_brief_preview`。
- 新增 `chapter_craft_brief_validation_report`。
- 新增 `chapter_craft_brief_persist_result`。
- 展示字段：
  - 目标章节。
  - `visibleGoal/coreConflict/mainlineTask`。
  - `actionBeats`。
  - `concreteClues`。
  - `dialogueSubtext`。
  - `characterShift`。
  - `irreversibleConsequence`。
  - 写入前风险和已起草章节跳过说明。

测试：

- 自然语言“给第 3 章生成推进卡”生成计划：`resolve_chapter -> collect_chapter_context -> generate_chapter_craft_brief_preview -> validate_chapter_craft_brief`。
- 审批后 `persist_chapter_craft_brief` 写入 `Chapter.craftBrief`。
- `drafted` 章节默认跳过或需要明确审批语义，不覆盖正文。
- “把第 3 章拆成 5 个场景”仍走 SceneCard 链路。
- 正文生成读取该章时 `hasCraftBrief=true`，`craftBriefSource='chapter.craftBrief'`。

## 8. 验收标准

- 用户在 Agent 工作台输入“为第 1 卷生成 60 章细纲”后：
  - `/plan` 快速返回，不阻塞数百秒。
  - Timeline 显示 `inspect_project_context succeeded`，再显示 `generate_outline_preview calling_llm`，且 phaseMessage 包含批次范围。
  - 60 章不会一次性走单个 LLM 请求。
  - LLM 成功时产物中每章包含 `craftBrief`。
  - 某批 LLM 超时时，仅该批 fallback，最终仍返回 60 章。
  - 风险中明确标记 fallback 批次和原因。
  - 审批写入后，`Chapter.craftBrief` 有内容。
  - 正文生成 prompt debug 中 `hasCraftBrief=true`，`craftBriefSource='chapter.craftBrief'`。
- 用户在 Agent 工作台输入“给第 3 章生成章节推进卡”后：
  - Planner 不误判为正文写作。
  - Plan 中包含章节解析、上下文收集、推进卡预览和校验。
  - 审批写入后目标章 `Chapter.craftBrief` 有内容。
  - 如果目标章已 `drafted`，默认不覆盖正文，写入计划必须明确风险和范围。
- 用户取消 Run 后，后台迟到批次结果不能覆盖 cancelled。
- 已 drafted 章节不会被 outline 写入覆盖。

## 9. 回归风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 输出结构变大导致 LLM 更容易超时 | 长细纲生成失败率上升 | 分批、单批 fallback、风险提示 |
| `craftBrief` 质量仍空泛 | 正文生成提升有限 | validate warning、Artifact 显示缺陷、后续可加质量门禁 |
| 旧 `outline_preview` 不含 `craftBrief` | 老产物写入兼容风险 | `craftBrief` 可选，缺失只 warning |
| 批次之间重复或断裂 | 章节连续性变差 | 每批带前序摘要，合并后校验重复/连续 |
| 写入覆盖用户正文计划 | 破坏已有内容 | 保留 `planned` 才更新策略 |
| Planner 误选正文写作工具 | 用户意图偏移 | 更新 Manifest 和 task guidance，补 planner eval |
| 推进卡与 SceneCard 边界混淆 | 用户得到错误粒度的规划产物 | Planner guidance 明确“推进卡=章级，SceneCard=场景级”，补意图回归测试 |
| 批量补卡覆盖已写章节规划 | 影响既有正文一致性 | 默认跳过 drafted，除非用户明确要求且审批文案说明只改规划字段 |

## 10. 推荐实现顺序

1. 先做 P0：契约、fallback、写库、校验和测试。
2. 再做 P1：Prompt 对齐 guided 质量要求。
3. 再做 P2：批次生成和进度展示。
4. 再做 P3：Artifact/审批体验和文档补充。
5. 最后做 P4：章节推进卡独立 Agent Tool，自然语言触发单章/批量补卡。

这样每一步都可独立验证，不需要一次性大重构。

## 11. 参考文件

| 文件 | 作用 |
|---|---|
| `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts` | Agent 大纲预览生成主工具 |
| `apps/api/src/modules/agent-tools/tools/validate-outline.tool.ts` | Agent 大纲写入前校验 |
| `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts` | Agent 大纲审批后写库 |
| `apps/api/src/modules/guided/guided.service.ts` | AI 引导 `guided_chapter` 高质量提示词和写库逻辑 |
| `apps/api/src/modules/guided/guided-step-schemas.ts` | guided step JSON schema |
| `apps/api/src/modules/generation/prompt-builder.service.ts` | 正文生成读取 `Chapter.craftBrief` 的 prompt 拼装 |
| `apps/api/src/modules/agent-tools/tools/scene-card-tools.tool.ts` | SceneCard 链路参考，用于区分章级推进卡和场景级卡片 |
| `apps/api/src/modules/agent-tools/tool-registry.service.ts` | 新增推进卡 Tool 注册入口 |
| `apps/api/src/modules/agent-tools/agent-tools.module.ts` | 新增推进卡 Tool provider 入口 |
| `apps/api/src/modules/agent-runs/agent-planner.service.ts` | Planner taskType guidance 与自然语言触发规则 |
| `apps/web/components/agent/AgentArtifactPanel.tsx` | Agent Artifact 展示 |
| `apps/web/components/VolumePanel.tsx` | 写入后章节细纲展示 |
| `apps/web/components/EditorPanel.tsx` | 当前章正文编辑与细纲摘要展示 |
