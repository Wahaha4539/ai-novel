# 结构化输出 LLM 自修复开发计划
> 状态：待实施开发计划  
> 范围：Agent 生成类工具的结构化 JSON 产物校验失败修复，包括 `generate_story_units_preview`、`generate_volume_outline_preview`、`generate_chapter_outline_preview`、`generate_outline_preview`、`generate_chapter_craft_brief_preview`、导入预览类工具等。  
> 目标：把“LLM 返回了有价值内容但结构不满足契约”时的一次性自修复能力抽象为通用基础设施，让各工具复用同一套日志、进度、LLM usage、重试边界和失败策略，同时继续遵守“小说内容失败即失败，不做确定性占位 fallback”的质量原则。

## 1. 背景

目前 Agent 已经有两类修复能力：

1. `AgentPlannerService.repairLlmPlan`
   - 修复的是 `AgentPlanSpec`，也就是“该调用哪些工具、哪些步骤需要审批”。
   - 它不修复具体小说内容或工具产物。

2. `generate_story_units_preview` 内部原型修复
   - 当 `storyUnitPlan.chapterAllocation` 已存在但 `chapterRoles` 数量不匹配时，会把原始 JSON、校验错误和目标章数交给 LLM 修复器，让 LLM 重新输出完整合法 JSON。
   - 修复后仍走同一套 `assertVolumeStoryUnitPlan` 校验。
   - 修复失败继续报错，不用代码补剧情。

这个原型证明了方向可行，但当前能力仍绑定在单个工具里。后续卷大纲、章节细纲、`craftBrief`、导入资产预览都可能遇到类似问题：字段缺失、枚举值错误、角色引用错误、章节数量不连续、`craftBrief` 缺关键字段等。如果每个工具都复制一套 repair 逻辑，会导致行为不一致、日志难追踪、测试分散，也容易不小心引入低质量 fallback。

## 2. 设计原则

- 修复的是结构化产物，不是绕过质量门禁。
- 修复必须由 LLM 生成完整内容，后端代码不得 deterministic 补小说剧情、章节角色、人物动机、伏笔、执行卡或正文内容。
- 每次修复后必须重新执行原工具的 normalize/assert 契约。
- 修复次数必须有限，默认 1 次；修复后仍非法则直接失败。
- LLM 超时、Provider 失败、上下文不足，不进入内容 fallback。
- JSON 解析失败和契约校验失败可以分别设计修复通道，但都必须有明确白名单和测试。
- 通用层只管调度、日志、进度、usage、错误传播；具体工具自己声明哪些错误可修、怎么修、哪些不变量必须保留。
- 修复产物如果会进入审批、写入或后续生成链路，必须在测试中覆盖失败即失败。

## 3. 非目标

- 不实现无限自动重试。
- 不把所有工具错误都交给 LLM 修复。
- 不在 `normalize`、`merge` 或 `persist` 阶段静默补齐小说内容。
- 不替代 Planner repair；Planner repair 继续只负责计划步骤，工具输出 repair 只负责工具 JSON 产物。
- 不在第一阶段修改数据库 schema。
- 不要求所有工具一次性接入；先从高价值、高失败率的生成类工具迁移。

## 4. 总体方案

新增一个通用 helper，例如：

`apps/api/src/modules/agent-tools/tools/structured-output-repair.ts`

建议接口：

```ts
export interface StructuredOutputRepairOptions<T> {
  toolName: string;
  loggerEventPrefix: string;
  llm: LlmGatewayService;
  context: ToolContext;
  data: unknown;
  normalize: (data: unknown) => T;
  shouldRepair: (input: {
    error: unknown;
    data: unknown;
    attempt: number;
  }) => boolean;
  buildRepairMessages: (input: {
    invalidOutput: unknown;
    validationError: string;
    attempt: number;
  }) => Array<{ role: 'system' | 'user'; content: string }>;
  progress?: {
    phaseMessage: string;
    timeoutMs: number;
  };
  llmOptions?: {
    appStep?: string;
    timeoutMs: number;
    temperature?: number;
  };
  maxRepairAttempts?: number;
}

export async function normalizeWithLlmRepair<T>(
  options: StructuredOutputRepairOptions<T>,
): Promise<T>;
```

调用方模式：

```ts
const normalized = await normalizeWithLlmRepair({
  toolName: this.name,
  loggerEventPrefix: 'story_units_preview',
  llm: this.llm,
  context,
  data: response.data,
  normalize: (data) => this.normalize(data, volumeNo, chapterCount),
  shouldRepair: ({ error, data }) => this.shouldRepairStoryUnitOutput(error, data),
  buildRepairMessages: ({ invalidOutput, validationError }) =>
    this.buildRepairMessages(invalidOutput, validationError, volumeNo, chapterCount),
  progress: {
    phaseMessage: `正在修复第 ${volumeNo} 卷单元故事章节分配`,
    timeoutMs: STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS,
  },
  llmOptions: {
    appStep: 'planner',
    timeoutMs: STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS,
    temperature: 0.1,
  },
  maxRepairAttempts: 1,
});
```

## 5. Repair Profile

通用 helper 不理解小说业务。每个工具需要提供自己的 repair profile。

### 5.1 单元故事 profile

可修复：

- `storyUnitPlan.chapterAllocation[*].chapterRoles` 数量不匹配。
- `chapterAllocation` 范围不连续、超过 `chapterCount`、未覆盖到目标章数。
- `primaryPurpose`、`secondaryPurposes`、`relationToMainline` 枚举值轻微偏离。
- `chapterAllocation[*].unitId` 引用已生成 `units` 时的局部错误。

不建议第一阶段修复：

- 缺整个 `mainlineSegments`。
- 缺整个 `units`。
- 上下文不足导致只有标题、无详情。
- 重要新角色缺失但未进入卷级候选。应返回风险或要求先重跑卷大纲。

### 5.2 卷大纲 profile

可修复：

- `narrativePlan.characterPlan.existingCharacterArcs` 引用未知既有角色时，要求 LLM 判断：
  - 如果是已有角色误名，修正为已知角色名。
  - 如果确实是新重要角色，从 `existingCharacterArcs` 移到 `newCharacterCandidates`，补齐候选字段。
  - 如果只是临时功能角色，移出卷级角色规划或降级为风险说明。
- `foreshadowPlan` 缺 `setup/payoff/recoveryMethod` 等结构字段。
- `chapterCount` 与目标章数不一致。
- `characterPlan.newCharacterCandidates` 缺必要字段。

不可修复：

- LLM 返回非目标卷。
- 卷主线、目标、反转、结尾交接整体缺失。
- 上游项目上下文明显不足。

### 5.3 章节细纲 profile

可修复：

- `craftBrief` 缺局部字段。
- `characterExecution.cast` 引用卷级候选时 `source` 标错。
- `sceneBeats.participants` 与 `characterExecution.cast` 不一致。
- 当前章 `chapterNo/volumeNo` 与目标不一致但内容明显是同一章的结构错误。

不可修复：

- 缺整章。
- 整章内容只有模板标题或空洞占位。
- 新增重要角色但卷级没有候选。
- `craftBrief` 缺失到无法判断本章行动链和后果。

### 5.4 导入预览 profile

可修复：

- JSON 格式轻微损坏。
- 某个资产候选缺非内容性包装字段。
- 枚举值大小写或别名错误。

不可修复：

- 原文解析不足。
- 资产数量不足。
- 关键内容字段缺失。
- LLM 摘要凭空扩展导入范围。

## 6. 日志与观测

统一事件命名：

```text
{prefix}.llm_request.started
{prefix}.llm_request.completed
{prefix}.llm_request.failed
{prefix}.llm_repair.started
{prefix}.llm_repair.completed
{prefix}.llm_repair.failed
```

修复日志必须包含：

- `agentRunId`
- `projectId`
- `mode`
- `toolName`
- `attempt`
- `maxRepairAttempts`
- `validationError`
- `timeoutMs`
- `messageCount`
- `totalMessageChars`
- `initialModel`
- `repairModel`
- `tokenUsage`
- `elapsedMs`

`recordToolLlmUsage` 必须记录修复调用，让运行成本可追踪。

Agent artifact 或 run audit 后续可以展示：

```ts
repairDiagnostics?: {
  attempted: boolean;
  attempts: number;
  repairedFromErrors: string[];
  model?: string;
}
```

第一阶段可只写日志和 usage，不强制改前端展示。

## 7. 阶段任务

### SOR-P0：确认边界与现状清点

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P0-001 | [ ] | 梳理现有生成类工具的 normalize/assert 入口和可修复错误类型。 | `apps/api/src/modules/agent-tools/tools/*` | 文档列出工具、校验函数、可修错误、不修错误。 |
| SOR-P0-002 | [ ] | 明确 `generate_story_units_preview` 当前内联 repair 是原型，后续迁移到通用 helper。 | 本文档 | 文档说明 prototype 与目标架构关系。 |
| SOR-P0-003 | [ ] | 明确失败即失败边界写入任务说明。 | `AGENTS.md` 已有原则，本文档补充 | 所有后续任务不得要求 deterministic 补小说内容。 |

### SOR-P1：抽取通用 Repair Runner

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P1-001 | [ ] | 新增 `structured-output-repair.ts`，实现 `normalizeWithLlmRepair`。 | `apps/api/src/modules/agent-tools/tools/structured-output-repair.ts` | 支持 normalize、shouldRepair、buildRepairMessages、max attempts、progress、日志和 usage。 |
| SOR-P1-002 | [ ] | helper 捕获 normalize 错误后只在 `shouldRepair=true` 时调用 LLM。 | 同上 | 不可修错误保持原错误传播。 |
| SOR-P1-003 | [ ] | helper 修复后再次调用原 normalize。 | 同上 | 修复后仍失败时抛出修复错误，不返回半成品。 |
| SOR-P1-004 | [ ] | helper 日志统一输出 `llm_repair.started/completed/failed`。 | 同上 | 单测断言日志事件或通过 mock logger 验证。 |
| SOR-P1-005 | [ ] | helper 调用 `recordToolLlmUsage`。 | 同上 | 单测断言首轮和修复轮 usage 都被记录。 |

### SOR-P2：迁移单元故事工具

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P2-001 | [ ] | 将 `generate_story_units_preview` 的内联 repair 迁移到 `normalizeWithLlmRepair`。 | `generate-story-units-preview.tool.ts` | 行为不变，代码中不再保留重复 repair runner。 |
| SOR-P2-002 | [ ] | 保留单元故事专属 `shouldRepairStoryUnitOutput` 和 `buildRepairMessages`。 | 同上 | chapterRoles 数量错误仍能触发一次 LLM 修复。 |
| SOR-P2-003 | [ ] | 增加 `chapterRange` 不连续和未覆盖全卷的修复测试。 | `agent-services.spec.ts` | LLM 修复后合法则通过，修复后仍非法则失败。 |
| SOR-P2-004 | [ ] | 保留缺 `mainlineSegments`、缺 `units`、缺整个 `chapterAllocation` 的直接失败测试。 | `agent-services.spec.ts` | 不会因为通用 helper 变成自动补内容。 |

### SOR-P3：接入卷大纲工具

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P3-001 | [ ] | 给 `generate_volume_outline_preview` 加 repair profile。 | `generate-volume-outline-preview.tool.ts` | 已有 normalize 失败可进入白名单修复。 |
| SOR-P3-002 | [ ] | 覆盖未知既有角色引用修复：已有误名改名，新角色移入 `newCharacterCandidates`。 | `agent-services.spec.ts` | `罗嵩` 这类未知角色不再只能失败；LLM 可修成候选人物，修复后仍需校验。 |
| SOR-P3-003 | [ ] | 覆盖 `characterPlan.newCharacterCandidates` 缺必要字段修复。 | `agent-services.spec.ts` | 修复后字段完整；修复失败继续报错。 |
| SOR-P3-004 | [ ] | 覆盖 `foreshadowPlan` 局部字段缺失修复。 | `agent-services.spec.ts` | 只修结构，不重写卷大纲。 |

### SOR-P4：接入章节细纲与 craftBrief 工具

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P4-001 | [ ] | 给 `generate_chapter_outline_preview` 加 repair profile。 | `chapter-outline-preview-tools.tool.ts` | `craftBrief` 局部缺字段、cast/scene 轻微不一致可修。 |
| SOR-P4-002 | [ ] | 给 `generate_outline_preview` 批量章节输出加 repair profile。 | `generate-outline-preview.tool.ts` | 单批章节数量不足仍失败；局部结构错可修。 |
| SOR-P4-003 | [ ] | 给 `generate_chapter_craft_brief_preview` 加 repair profile。 | `chapter-craft-brief-tools.tool.ts` | 缺执行卡字段可由 LLM 修复，不能 deterministic 补卡。 |
| SOR-P4-004 | [ ] | 章节工具修复提示词必须带当前章号、目标卷号、现有角色和卷级候选。 | 相关工具 | 修复不会凭空创造重要角色。 |

### SOR-P5：导入预览与通用 JSON 修复

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P5-001 | [ ] | 评估是否为 `LlmJsonInvalidError` 增加 raw JSON 修复入口。 | `structured-output-repair.ts`、`llm-gateway.service.ts` 调用方 | 仅修 JSON 语法，不补小说内容。 |
| SOR-P5-002 | [ ] | 接入导入 outline/characters/worldbuilding/writingRules/projectProfile 预览。 | `generate-import-*.tool.ts` | 结构包装错误可修，目标资产范围扩大必须失败。 |
| SOR-P5-003 | [ ] | 接入 `build_import_preview` 和 `build_import_brief`。 | `build-import-preview.tool.ts`、`build-import-brief.tool.ts` | 导入目标不被 LLM repair 扩范围。 |

### SOR-P6：Agent 运行态与 UI 可见性

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P6-001 | [ ] | 在 Agent audit 中记录修复尝试摘要。 | `agent-runtime.service.ts` 或 tool output metadata | 用户能看到该步骤经历过自动修复。 |
| SOR-P6-002 | [ ] | Artifact 展示 `repairDiagnostics`，提示“已由 LLM 修复结构错误并重新校验”。 | `apps/web/components/agent/AgentArtifactPanel.tsx` | 前端不只显示成功产物，也能看到修复痕迹。 |
| SOR-P6-003 | [ ] | 失败时将“首轮错误”和“修复轮错误”都写入 observation/audit。 | `agent-executor.service.ts`、helper | 排查日志能定位修复失败原因。 |

### SOR-P7：测试、Eval 与 CI

| ID | 状态 | 任务 | 影响文件 | 验收 |
|---|---|---|---|---|
| SOR-P7-001 | [ ] | 为 helper 写独立单测：可修成功、不可修直接失败、修复仍失败、usage 记录。 | `agent-services.spec.ts` 或独立 spec | 所有核心路径可回归。 |
| SOR-P7-002 | [ ] | 为每个接入工具增加至少 2 个测试：修复成功、修复失败。 | `agent-services.spec.ts` | 不允许只有 happy path。 |
| SOR-P7-003 | [ ] | Agent eval 增加结构修复案例。 | `apps/api/test/fixtures/agent-eval-cases.json`、`scripts/dev/eval_agent_planner.ts` 如适用 | repair 不改变计划工具边界。 |
| SOR-P7-004 | [ ] | CI 或本地 gate 增加 repair 相关测试。 | `apps/api/package.json` 或 CI 配置 | `pnpm --dir apps/api run test:agent` 覆盖 repair。 |

## 8. 推荐实施顺序

1. 先做 SOR-P1，把通用 helper 抽出来。
2. 再做 SOR-P2，把当前单元故事原型迁移过去，确保行为不变。
3. 再做 SOR-P3，解决卷大纲中“未知角色是否应新增候选人物”的高频问题。
4. 再做 SOR-P4，接入章节细纲和 `craftBrief`，降低后续章节生成链路失败率。
5. 再做 SOR-P6，让用户能在前端和 audit 中看到“Agent 自修复过”。
6. 最后做 SOR-P5/SOR-P7，把导入预览和 CI/eval 补全。

## 9. 验收命令

基础验证：

```bash
pnpm --dir apps/api exec tsc --noEmit -p tsconfig.json
pnpm --dir apps/api run test:agent
git diff --check
```

如果涉及前端展示：

```bash
pnpm --dir apps/web exec tsc --noEmit --incremental false -p tsconfig.json
```

真实 Web 验收按项目约定使用 Docker Compose：

```bash
docker compose ps
docker compose up -d --build
```

## 10. 关键验收场景

### 场景 A：单元故事章节角色数不匹配

输入：LLM 返回 `chapterRange: { start: 41, end: 45 }`，但 `chapterRoles` 只有 3 项。  
期望：

- 首轮 normalize 失败。
- repair runner 调用一次 LLM。
- 修复提示词包含 `roleCount = end - start + 1`。
- 修复后有 5 项具体 `chapterRoles`。
- 再次 normalize 通过。
- usage 记录 2 次 LLM 调用。

### 场景 B：卷大纲引用未知既有角色

输入：`existingCharacterArcs[6].characterName = "罗嵩"`，但项目既有角色中没有罗嵩。  
期望：

- repair profile 要求 LLM 判断该人物是否应为新候选。
- 若为新重要人物，移入 `newCharacterCandidates` 并补齐动机、叙事功能、首次出场章、人物弧线。
- `existingCharacterArcs` 不再引用未知角色。
- 修复后仍由 `assertVolumeCharacterPlan` 校验。

### 场景 C：章节细纲缺少 craftBrief 局部字段

输入：章节细纲有具体剧情，但 `craftBrief.irreversibleConsequence` 缺失。  
期望：

- repair runner 调用 LLM 补充完整执行卡。
- 补充内容必须基于本章已有目标、冲突、行动链和结尾状态。
- 不允许代码用固定模板生成“本章产生不可逆后果”。

### 场景 D：重要角色凭空出现在章节细纲

输入：章节细纲新加入长期配角，但卷级没有候选人物。  
期望：

- 不自动修成临时角色。
- 工具失败，并提示应先回到卷大纲补充 `newCharacterCandidates`。
- 不写入 `Chapter.craftBrief`。

### 场景 E：修复后仍非法

输入：首轮和修复轮都缺关键字段。  
期望：

- helper 只尝试 1 次。
- 抛出修复轮错误。
- audit/log 保留首轮错误和修复错误。
- 不返回半成品。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 修复器把内容重写偏了 | 破坏原生成结果 | 修复 prompt 明确“尽量保留原内容，只修结构”；修复后继续原契约校验。 |
| 修复器成为隐性 fallback | 低质量内容进入审批 | 每个工具必须有 `shouldRepair` 白名单；不可修错误直接失败。 |
| LLM 成本增加 | 长工具链成本上升 | 默认最多 1 次；记录 usage；只对可修错误触发。 |
| 所有错误都被 repair 吞掉 | 排查困难 | 统一日志记录首轮错误、修复尝试和修复错误。 |
| 不同工具 repair prompt 风格不一致 | 行为不可预测 | helper 统一系统边界，各工具 profile 只补业务契约。 |
| 修复 JSON 解析失败时缺 raw 数据 | 无法修语法 | 第一阶段先不做 raw JSON repair；P5 单独评估调用层改造。 |

## 12. 当前原型记录

当前 `generate_story_units_preview` 已经具备内联原型能力：

- 首轮生成失败于 `chapterAllocation` 结构时可触发一次 LLM 修复。
- 修复提示词要求 `chapterRoles.length === chapterRange.end - chapterRange.start + 1`。
- 修复后再次执行 `assertVolumeStoryUnitPlan`。
- 修复失败继续抛错。
- 已有测试覆盖 `chapterRoles` 数量不匹配修复成功、修复后仍失败。

后续 SOR-P1/SOR-P2 的目标不是改变行为，而是把这套能力抽成通用 runner，并让更多工具以 profile 方式接入。
