# 章节细纲上下文驱动流程任务计划文档

> 状态：P0/P1/P2 已完成
> 日期：2026-05-11
> 任务前缀：`COCF`，即 Chapter Outline Context Flow
> 关联设计：`docs/architecture/chapter-outline-context-driven-flow-design.md`
> 目标：把章节细纲链路调整为“默认承接卷大纲章数和 storyUnitPlan，用户明确改章数时才重建上游规划；所有自然语言数字语义由 LLM Planner 结构化输出，后端只解析 JSON 并做确定性校验”。

## 1. 总体验收标准

1. 用户说“帮我生成第一卷的章节细纲”时，系统使用第一卷 `Volume.chapterCount` 和 `storyUnitPlan` 作为目标上下文，不要求用户指定章数。
2. 用户说“把第一卷重拆成 45 章”时，Planner 在结构化 JSON 中输出 `chapterCount=45`，并计划重建卷纲和 storyUnitPlan。
3. 后端不再从 `instruction`、`objective`、`synopsis` 等自然语言字段正则推断 `chapterCount`。
4. PlanValidator 不允许缺目标章数的章节细纲计划进入执行阶段。
5. 长卷 batch 链路不追加终局 `validate_outline`。
6. 每个 batch 内完成结构校验、LLM rubric 质量复核和一次重生；仍失败则失败。
7. 单章和短章节链路也有与 batch 同级的 LLM rubric 质量复核。
8. `persist_outline` 写入前有最终 craftBrief 完整性保护。

## 2. P0：章数来源与结构化解析

> 状态：已完成（2026-05-11）

### COCF-P0-001：定义章节细纲目标章数来源契约（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/planner-graph.state.ts`
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - 相关类型定义文件
- 任务：
  - 引入或等价表达 `chapterCountSource`：
    - `context_volume`
    - `generated_volume`
    - `user_explicit`
    - `planner_unspecified`
  - 明确 `route` 中的章数只可作为上下文提示，不作为压过计划的权威值。
- 验收：
  - Planner prompt 中能看到“默认使用 Volume.chapterCount；用户明确改章数时重建上游规划”的规则。
  - 单元测试覆盖 `context_volume` 和 `user_explicit` 两类目标。

### COCF-P0-002：调整 Supervisor 的数字字段语义（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/outline-supervisor.ts`
- 任务：
  - 不把自然语言正则提取出的数字作为权威 `chapterCount`。
  - 若保留数字提取，只能命名为 `routeHints` 或 `fallbackChapterCount`，并在 Planner/Validator 中按提示处理。
  - 优先让 LLM Planner 输出结构化 `chapterNo/chapterCount/volumeNo`。
- 验收：
  - “第 3 章细纲”不会被当成 `chapterCount=3`。
  - “生成第一卷章节细纲”可使用上下文 `Volume.chapterCount`。
  - “拆成 45 章”只有在 Planner JSON 明确输出 `chapterCount=45` 时才生效。

### COCF-P0-003：移除工具内自然语言章数正则推断（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/generate-story-units-preview.tool.ts`
- 任务：
  - 删除或停用 `inferChapterCountFromText(instruction/objective/synopsis)`。
  - `generate_story_units_preview` 只接受：
    - 显式 `args.chapterCount`
    - 或结构化 `volumeOutline.chapterCount`
  - 如果两者都没有，且本次需要 `chapterAllocation`，直接失败。
- 验收：
  - 测试覆盖：`instruction='拆成45章'` 但 `args.chapterCount` 缺失时，不应推断 45，必须失败。
  - 测试覆盖：`volumeOutline.chapterCount=60` 时可生成 60 章 storyUnitPlan。
  - 测试覆盖：`args.chapterCount=45` 与 `volumeOutline.chapterCount=60` 不一致时失败，除非 volumeOutline 来自同计划重建且自身 chapterCount 已为 45。

### COCF-P0-004：重写 PlanValidator 的目标章数解析顺序（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/plan-validator.service.ts`
- 任务：
  - 目标章数解析顺序改为：
    1. 计划步骤中的显式 `chapterCount`。
    2. 当前计划重建的 `generate_volume_outline_preview.args.chapterCount`。
    3. 上下文目标卷 `Volume.chapterCount` 作为默认来源。
    4. 仍缺失则失败。
  - 当计划章数与上下文 `Volume.chapterCount` 不一致时，必须要求重建卷纲和 storyUnitPlan，并把输出传给后续步骤。
  - 不再因上下文章数存在而压过计划中一致出现的不同目标章数。
- 验收：
  - 旧卷 60 章，用户明确重拆 45 章，计划包含重建上游时通过。
  - 旧卷 60 章，计划直接生成 45 章但未重建上游时失败。
  - 用户未明确章数，计划未填 chapterCount，但上下文 Volume 为 60 章时，Validator 以 60 章补足目标并要求后续步骤覆盖 1..60。
  - 没有上下文章数也没有计划章数时失败。

### COCF-P0-005：确保生成的 storyUnitPlan 能进入下游 merge/persist（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-batch-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts`
  - 可能需要调整 `OutlinePreviewOutput` 构造逻辑
- 任务：
  - 当计划使用 `generate_story_units_preview.output.storyUnitPlan` 作为章节细纲上游时，最终 `merge_*` 输出的 `volume.narrativePlan` 应包含同一份 storyUnitPlan，或写入前明确要求先持久化 storyUnitPlan。
  - 不允许 batch 使用一份临时 storyUnitPlan 生成章节，但最终持久化的 Volume.narrativePlan 仍缺失该 storyUnitPlan。
- 验收：
  - 测试覆盖：上下文 Volume 有 chapterCount 和 characterPlan，但缺 storyUnitPlan；计划生成 storyUnitPlan 后，merge 输出 volume.narrativePlan.storyUnitPlan 存在且与 batch 使用一致。
  - 如果无法合并 storyUnitPlan，PlanValidator 或工具应失败，不进入 persist。

### P0 实施记录

- 实现摘要：
  - 引入 `chapterCountSource` / `routeHints` 契约；Supervisor 不再把上下文或正则数字写成权威 `route.chapterCount`。
  - outline 路由不再把“拆成 N 章”的数字写成 `chapterNo`；单章细纲由 Planner 计划步骤中的结构化 `args.chapterNo` 放行。
  - `generate_story_units_preview` 和 `persist_story_units` 只使用结构化 `args.chapterCount`、`volumeOutline.chapterCount` 或数据库 `Volume.chapterCount`，不再从 `instruction`、`objective`、`synopsis` 推断章数。
  - `PlanValidator` 优先使用计划步骤里的结构化 `chapterCount`，否则使用目标卷 `Volume.chapterCount`，无来源时前置失败；章数与上下文不一致时要求重建并传递 `volumeOutline` / `storyUnitPlan`。
  - `merge_chapter_outline_batch_previews` 接受并校验 `storyUnitPlan` 参数，将本次生成的 `storyUnitPlan` 合入输出 `volume.narrativePlan`，避免后续 persist 丢失上游单元故事。
- 关键文件：
  - `apps/api/src/modules/agent-runs/planner-graph/planner-graph.state.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/outline-supervisor.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/plan-validator.service.ts`
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/src/modules/agent-tools/tools/generate-story-units-preview.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-batch-tools.tool.ts`
  - `apps/api/src/modules/agent-runs/agent-services.spec.ts`
  - `apps/api/src/modules/agent-runs/chapter-outline-batch.spec.ts`
- 测试结果：
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/chapter-outline-batch.spec.ts COCF-P0`：通过，4/38 项。
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/agent-services.spec.ts generate_story_units_preview`：通过；该 runner 实际执行全量 agent-services，426/426 项。
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/chapter-outline-batch.spec.ts`：通过，38/38 项。
- 暂缓项 / 风险：
  - 无 P0 暂缓项。P1 仍需将单章链路接入 LLM rubric，并统一 craftBrief 完整性保护。

## 3. P1：质量门禁一致性

> 状态：已完成（2026-05-11）

### COCF-P1-001：抽取章节细纲 LLM 质量复核 helper（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-batch-tools.tool.ts`
  - 新增共享 helper，或放入独立 support 文件
- 任务：
  - 将 batch quality review 的 rubric、JSON schema、normalize 逻辑抽为可复用模块。
  - 保持“不用关键词/正则做语义判断”的系统提示。
- 验收：
  - batch 工具继续通过现有质量复核测试。
  - helper 可被单章工具调用。

### COCF-P1-002：单章与短章节链路接入 LLM rubric（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts`
- 任务：
  - `generate_chapter_outline_preview` 结构校验通过后，调用 LLM quality review。
  - 若 `valid=false`，允许按 issues 重生一次；仍失败则失败。
  - `merge_chapter_outline_previews` 只合并已通过质量复核的单章预览。
- 验收：
  - 测试覆盖：单章质量 review 首次失败、重生后通过。
  - 测试覆盖：单章质量 review 重试后仍失败，工具抛错。
  - 测试覆盖：review LLM timeout 直接抛错，不生成 fallback。

### COCF-P1-003：统一 craftBrief 完整性校验（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-batch-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/validate-outline.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts`
- 任务：
  - 抽出共享 `assertCompleteChapterCraftBrief` 或等价 helper。
  - 覆盖：
    - `visibleGoal`
    - `hiddenEmotion`
    - `coreConflict`
    - `mainlineTask`
    - `subplotTasks`
    - `storyUnit`
    - `actionBeats`
    - `sceneBeats`
    - `concreteClues`
    - `dialogueSubtext`
    - `characterShift`
    - `irreversibleConsequence`
    - `progressTypes`
    - `entryState`
    - `exitState`
    - `openLoops`
    - `closedLoops`
    - `handoffToNextChapter`
    - `continuityState`
    - `characterExecution`
  - `persist_outline` 写入前复用同一校验。
- 验收：
  - 缺任意关键 craftBrief 字段时，preview/merge/persist 任一入口都不能写入。
  - 旧测试继续通过，新增测试覆盖 `persist_outline` 直接接收缺字段 preview 时失败。

### COCF-P1-004：显式检查 persist_outline 模式和审批（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts`
- 任务：
  - 在工具内部增加：
    - `context.mode === 'act'`
    - `context.approved === true`
  - 与 Executor/Policy 形成双保险。
- 验收：
  - 直接调用工具且 `approved=false` 时失败。
  - act 审批路径不受影响。

### P1 实施记录

- 实现摘要：
  - 抽取 `chapter-outline-quality-review` 共享 LLM rubric helper，batch 质量复核继续使用同一 schema/normalize 逻辑，单章链路复用该 helper。
  - `generate_chapter_outline_preview` 在结构校验和必要修复后执行 LLM quality review；`valid=false` 时按 LLM issues 重生一次，重试仍失败或 review timeout 时直接抛错，不生成 fallback。
  - 多个单章组成的短链路由 `merge_chapter_outline_previews` 合并已通过单章质量门禁的 preview，并在 merge 阶段继续做 craftBrief 完整性保护。
  - 抽取 `assertCompleteChapterCraftBrief`，在 batch preview、single preview、merge、`validate_outline`、`persist_outline` 中复用；缺关键 craftBrief 字段会显式失败，不补字段。
  - `persist_outline` 内部增加 `mode === 'act'` 与 `approved === true` 双保险，并在写库事务前执行 craftBrief 完整性校验。
- 关键文件：
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-quality-review.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-craft-brief-contracts.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-batch-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/validate-outline.tool.ts`
  - `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts`
  - `apps/api/src/modules/agent-runs/agent-services.spec.ts`
- 测试结果：
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/agent-services.spec.ts`：通过，431/431 项。
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/chapter-outline-batch.spec.ts`：通过，38/38 项。
- 暂缓项 / 风险：
  - 无 P1 暂缓项。P2 已清理旧 `generate_outline_preview` 推荐链路、eval 口径和审批展示。

## 4. P2：旧链路清理与文档同步

### COCF-P2-001：收紧 outline.chapter 工具包（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/outline.tool-bundle.ts`
- 任务：
  - 从章节细纲推荐链路移除旧 `generate_outline_preview`。
  - 若必须保留为兼容工具，应标记为 legacy，不进入 `outline.chapter` optional 工具。
- 验收：
  - 新 Planner 测试中整卷章节细纲不再使用 `generate_outline_preview`。
  - 旧 volume outline 或兼容场景不受影响。

### COCF-P2-002：修正旧 generate_outline_preview 的静默截断（已完成）

- 文件：
  - `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts`
- 任务：
  - 将 `Math.min(80, numeric)` 改为显式范围校验。
  - 超过上限时失败，提示用户缩小范围或先改卷纲，不静默改目标章数。
- 验收：
  - `chapterCount=100` 时直接抛错，不生成 80 章。
  - 现有 60 章测试不受影响。

### COCF-P2-003：清理 Planner prompt、eval、架构文档旧口径（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/test/fixtures/agent-eval-cases.json`
  - `scripts/dev/eval_agent_planner.ts`
  - `docs/architecture/chapter-outline-batch-preview-development-plan.md`
  - 其他提到 `generate_outline_preview -> validate_outline -> persist_outline` 作为章节细纲主链路的文档
- 任务：
  - 长卷 batch 链路文档统一为：
    `inspect_project_context -> segment_chapter_outline_batches -> generate_chapter_outline_batch_preview x M -> merge_chapter_outline_batch_previews -> persist_outline`
  - 移除 batch 后终局 `validate_outline` 的推荐。
  - 更新 eval 期望，不再要求章节细纲使用 `validate_outline`。
- 验收：
  - `rg "merge_chapter_outline_batch_previews -> validate_outline"` 无章节细纲主链路命中。
  - eval mock 与真实 Planner guidance 一致。

### COCF-P2-004：Artifact 与审批面板展示章数来源（已完成）

- 文件：
  - `apps/api/src/modules/agent-runs/agent-runtime.service.ts`
  - 前端 Agent Artifact 展示组件
- 任务：
  - 在章节细纲 preview artifact 中展示章数来源：
    - 来自已审批卷纲
    - 来自本次重建卷纲
    - 来自用户明确改章数
  - 批次预览显示 storyUnitPlan 来源和覆盖范围。
- 验收：
  - 用户能在审批前看到“本次将按第一卷卷纲的 60 章生成”。
  - 改章数流程能看到“本次先重建为 45 章卷纲，再生成章节细纲”。

### P2 实施记录

- 实现摘要：
  - `outline.chapter` 工具包不再把旧 `generate_outline_preview` 放入章节细纲推荐链路，并将其列入该 bundle 的 denied tools，避免新章节细纲计划回退到旧聚合工具。
  - 旧 `generate_outline_preview` 保留兼容能力，但 `chapterCount > 80` 时显式报错，不再用 `Math.min(80, N)` 静默截断用户目标章数；manifest 示例也移除了 `validate_outline` 终局门禁。
  - Planner guidance、eval fixture、mock planner 和旧 batch 开发文档统一到长卷 batch 主链路：`inspect_project_context -> segment_chapter_outline_batches -> generate_chapter_outline_batch_preview x M -> merge_chapter_outline_batch_previews -> persist_outline`，不追加终局 `validate_outline`。
  - Agent Runtime 为章节细纲 preview artifact 增加 `chapterOutlineContext`，记录章数来源、storyUnitPlan 来源、batch 数量、batch 覆盖范围和审批提示；前端 Artifact 面板展示这些信息，帮助用户在审批前确认默认承接卷纲或本次重建来源。
  - eval mock 工具列表补齐 `persist_volume_character_candidates`，避免 tool bundle registry 在可控 live eval 中因缺 mock 工具提前失败。
- 关键文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/outline.tool-bundle.ts`
  - `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts`
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/src/modules/agent-runs/agent-runtime.service.ts`
  - `apps/web/components/agent/AgentArtifactPanel.tsx`
  - `apps/api/test/fixtures/agent-eval-cases.json`
  - `scripts/dev/eval_agent_planner.ts`
  - `docs/architecture/chapter-outline-batch-preview-development-plan.md`
- 测试结果：
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/agent-services.spec.ts COCF-P2`：通过；该 runner 实际执行全量 agent-services，433/433 项。
  - `pnpm --dir apps/api exec ts-node src/modules/agent-runs/chapter-outline-batch.spec.ts`：通过，38/38 项。
  - `pnpm --dir apps/api run eval:agent`：通过；默认模式加载 25 个 Agent Eval 用例，不生成指标报告。
  - `pnpm --dir apps/api run eval:agent -- --live-planner`：graph planner 子集通过，8/8 项，`outline_split_008` 使用新 batch 链路；命令整体因 legacy planner 既有全量用例 18/25 通过而退出 1，失败项集中在旧 legacy mock 对写作/continuity/缺项目等非 COCF 路由的既有口径。
  - `pnpm --dir apps/api run build`：通过。
  - `pnpm --dir apps/web run build`：通过。
- 暂缓项 / 风险：
  - P2 无 COCF 暂缓项。`eval:agent -- --live-planner` 的 legacy planner 子集仍有既有失败，不属于本次 COCF 章节细纲链路；graph planner 与本次改动相关的 eval 已通过。

## 5. 测试计划

### 5.1 单元测试

- `PlanValidatorService`
  - 使用上下文 `Volume.chapterCount` 作为默认目标。
  - 计划明确章数与上下文不一致但未重建上游时失败。
  - 计划明确章数与上下文不一致且正确重建上游时通过。
  - 无章数且无上下文时失败。
  - batch range 覆盖、重复、缺口、越界失败。

- `GenerateStoryUnitsPreviewTool`
  - 不从自然语言 instruction 推断章数。
  - `volumeOutline.chapterCount` 可作为结构化章数来源。
  - `args.chapterCount` 与输出 `chapterCount` 不一致失败。
  - `chapterAllocation` 不连续失败。

- `GenerateChapterOutlineBatchPreviewTool`
  - LLM timeout 失败。
  - 数量不足失败。
  - 缺整张 craftBrief 失败。
  - LLM quality review 失败后重生一次。
  - 重生后仍失败则失败。

- `GenerateChapterOutlinePreviewTool`
  - 单章 quality review 失败后重生一次。
  - 单章 review timeout 失败。
  - “第 3 章细纲”只生成 chapterNo=3。

- `PersistOutlineTool`
  - 缺 craftBrief 必填字段失败。
  - `approved=false` 失败。
  - 已起草章节跳过逻辑保持不变。

### 5.2 Planner / Eval 测试

- “帮我生成第一卷章节细纲”
  - 使用 `context_volume` 章数。
  - 若 60 章，使用 batch 链路。
  - 不使用 `validate_outline` 作为 terminal gate。

- “把第一卷重拆成 45 章”
  - 输出 `chapterCount=45`。
  - 先 `generate_volume_outline_preview`，再 `generate_story_units_preview`，再 batch。

- “生成第 3 章细纲”
  - 输出 `chapterNo=3`。
  - 不把 3 当作整卷 `chapterCount`。

- “只生成第一卷卷大纲”
  - 不生成章节细纲。

### 5.3 Docker Compose 验证

按项目要求使用根目录 Docker Compose：

```bash
docker compose ps
docker compose down
docker compose up -d --build
```

验证场景：

1. 先生成并审批第一卷卷大纲。
2. 再输入“帮我生成第一卷的章节细纲”。
3. 确认计划使用卷大纲章数和 storyUnitPlan。
4. 确认 batch 覆盖所有章节。
5. 确认某一 batch 质量失败时只需重跑该 batch，不要求整卷重跑。
6. 确认审批前不写库，审批后 `persist_outline` 写入 planned 章节并跳过 drafted 章节。

## 6. 实施顺序

建议按以下顺序推进：

1. COCF-P0-003：先移除工具内自然语言章数正则推断，降低错误章数来源。
2. COCF-P0-004：调整 PlanValidator 章数来源和重建上游规则。
3. COCF-P0-001 / P0-002：补 Planner/Supervisor 契约和 prompt。
4. COCF-P0-005：确保临时生成的 storyUnitPlan 能进入最终 merge/persist。
5. COCF-P1-001 / P1-002：统一质量复核到单章链路。
6. COCF-P1-003 / P1-004：增强 persist 最终保护。
7. COCF-P2-001 / P2-002 / P2-003：清理旧链路、eval 和文档。
8. COCF-P2-004：补 UX 展示。

## 7. 风险与回滚

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Planner 暂时不输出 `chapterCountSource` | Validator 无法区分用户明确改章数与上下文默认章数 | 先从工具参数和上下文一致性推导，字段作为增量增强 |
| 移除正则推断后旧用例失败 | 部分旧调用依赖 instruction 文本 | 修旧调用，让 Planner 或调用方传结构化 `chapterCount` |
| 临时 storyUnitPlan 未能写入 volume.narrativePlan | 后续正文生成缺上游单元故事 | P0-005 必须先解决，或强制先 persist_story_units |
| 单章质量 review 增加 LLM 调用 | 成本增加 | 仅对会进入审批/写入/后续生成链路的 preview 启用；纯诊断可跳过 |
| 旧 `generate_outline_preview` 仍被 eval/mock 使用 | Planner 行为回退 | P2 同步更新 eval 和 mock |

## 8. 完成定义

本专项完成时，应满足：

- 章节细纲默认从卷大纲取章数和 storyUnitPlan。
- 用户明确改章数时，计划必须重建卷纲和 storyUnitPlan。
- 程序不从自然语言字段推断章数。
- PlanValidator 前置发现章数、批次、引用和审批问题。
- batch 与单章都有 LLM rubric 质量门禁。
- merge 和 persist 都有完整 craftBrief 结构保护。
- 文档、eval、Planner guidance 不再推荐长卷终局 `validate_outline`。
