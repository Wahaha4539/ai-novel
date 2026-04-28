# 小说 Agent 智能化改造设计文档（完善版）

> 建议放置路径：`docs/architecture/agent-intelligence-upgrade.md`  
> 适用仓库：`Wahaha4539/ai-novel`  
> 文档目标：在现有 Agent-Centric 架构基础上，把 Agent 从“会生成计划和调用工具”升级为“能理解自然语言、主动取上下文、自动解析参数、可失败修复、可评测迭代”的智能创作 Agent。

---

## 0. 文档定位

当前仓库已经具备 Agent-Centric 的基础框架：Web 侧提供 Agent 工作台，API 侧包含 `AgentRun / Plan / Approval / Step / Artifact`、`AgentRuntime / Planner / Executor / Policy / Trace`、`ToolRegistry / SkillRegistry / RuleEngine`，章节写作链路也已经工具化。

本设计不是推翻现有架构，也不是新增一个独立 Worker 或外部 Agent 服务，而是在现有 `apps/api` 内继续增强：

```text
已有能力：Agent Runtime + Tool Registry + Plan/Act + Approval + Trace
需要补齐：上下文构造 + Tool Manifest 语义说明 + Resolver + 参数补全 + Observation/Replan + 评测集
```

最终目标是让用户只用自然语言表达创作意图，Agent 自动完成理解、上下文收集、工具选择、参数解析、执行计划、质量校验和错误恢复。

---

## 1. 一句话目标

> 让 LLM 负责理解和规划，让程序负责上下文、工具、约束、校验、执行和审计。

不要把智能做成大量关键词规则：

```ts
// 不推荐
if (message.includes('写第')) {
  taskType = 'chapter_write';
}
```

应该把智能做成“LLM 可理解的运行环境”：

```text
高质量 AgentContext
+ 高质量 Tool Manifest
+ Resolver Tools
+ Schema / Policy / Approval
+ Observation / Replan 循环
+ 可回放 Trace
+ 可评测用例集
```

---

## 2. 当前问题总结

用户希望输入：

```text
帮我写第十二章，压迫感强一点。
这一章节奏太慢，帮我改得更紧张，但别改结局。
帮我检查男主的人设有没有崩。
把这个世界观扩展一下，但不要影响已有剧情。
根据前三章，继续写下一章。
```

Agent 当前“不够聪明”的根因通常不是模型不会写，而是运行时没有给模型足够的上下文、工具说明和修复机制。

| 问题 | 表现 | 根因 | 改造方向 |
|---|---|---|---|
| 意图识别弱 | 用户说得很清楚，但 Agent 不知道该用哪个工具 | Planner 只看用户目标和有限工具描述，缺少当前项目、章节、角色状态 | 增加 AgentContext Builder 和 task playbook |
| 参数补全弱 | 选择了工具，但缺 `chapterId` / `projectId` / `characterId` | 自然语言引用没有 resolver | 增加 `resolve_*` 工具族 |
| ID 幻觉 | 把“第十二章”“男主”直接当真实 ID | 缺少 ID policy | Tool Manifest 声明 ID 来源，Executor 校验 |
| 上下文不足 | 不知道“这一章”“当前项目”“已有剧情” | Session 和项目上下文没有统一注入 | AgentContext V2 |
| 失败后不会修 | Tool 报错后直接返回用户 | 错误没有作为 observation 进入 LLM 重新规划 | Observation/Replan 循环 |
| 工具对 LLM 不友好 | 工具有 schema，但缺“什么时候用/别用/怎么补参” | Tool Manifest 信息不足 | Tool Manifest V2 |
| 智能不可评估 | 改 Prompt 不知道有没有变好 | 没有智能化测试集 | 建立 Agent Eval 场景集 |

---

## 3. 设计原则

### 3.1 LLM-first，Runtime-guarded

LLM 负责：

- 理解用户真实意图。
- 判断任务类型。
- 判断需要哪些上下文。
- 选择工具和编排步骤。
- 根据工具说明补全参数。
- 在缺参数时调用 resolver。
- 根据工具结果继续推理。
- 对失败进行修复或重新规划。

Runtime 负责：

- 构造上下文。
- 暴露工具白名单。
- 执行 schema 校验。
- 执行权限、风险、审批检查。
- 防止 LLM 编造工具和内部 ID。
- 记录 trace。
- 管理 Plan / Act 状态机。
- 控制成本、轮数、并发和幂等。

### 3.2 不让 LLM 编造内部 ID

LLM 可以理解“第十二章”“下一章”“男主”“当前项目”，但不能直接编造：

```text
projectId
volumeId
chapterId
characterId
lorebookEntryId
memoryChunkId
```

凡是涉及真实实体 ID，必须来自：

1. `AgentContext.session` 已有字段；
2. 前序 resolver 工具输出；
3. 前序上下文收集工具输出；
4. 用户显式选择。

### 3.3 Plan 阶段可预览，不写正式业务表

Plan 阶段可以做：

- 解析用户目标。
- 读取项目上下文。
- 生成执行计划。
- 生成只读预览 artifact。
- 暴露风险、假设和待确认项。

Plan 阶段不能做：

- 覆盖章节正文。
- 写角色、设定、事实库。
- 删除或批量修改业务数据。
- 自动批准高风险写入。

### 3.4 Act 阶段必须可追踪、可暂停、可恢复

Act 阶段必须满足：

- 所有写入来自已批准计划。
- 每一步都有 `AgentStep` trace。
- 高风险操作可以进入 `waiting_review`。
- 用户取消后后续步骤停止。
- 失败后能复用已成功步骤输出，避免重复写入或重复调用 LLM。

### 3.5 工具定义要面向 LLM，而不只是面向 TypeScript

仅有 `name / description / inputSchema` 不够。工具还需要告诉 LLM：

- 什么时候使用。
- 什么时候不要使用。
- 参数从哪里来。
- 自然语言引用要先调用哪个 resolver。
- 输出结果能供后续哪个工具使用。
- 失败时如何修复。
- 风险和审批要求是什么。

---

## 4. 目标架构

### 4.1 总体流程

```text
User Message
  ↓
AgentRunsController
  ↓
AgentRunsService
  ↓
AgentContextBuilder
  ↓
AgentPlanner
  ↓
Plan Validator / Policy Preview
  ↓
AgentArtifact: Plan Preview
  ↓
User Approval
  ↓
AgentExecutor
  ↓
ToolRegistry → Tool.run()
  ↓
Observation / Step Output / Error
  ↓
Need Replan?
  ├─ yes → AgentReplanner → continue
  └─ no  → Artifact Presenter → Final Report
```

### 4.2 核心模块边界

```text
apps/api/src/modules/agent-runs/
  agent-runtime.service.ts          # 状态机：plan / act / replan / retry / cancel
  agent-planner.service.ts          # 生成 AgentPlan
  agent-replanner.service.ts        # 根据 Observation 修复计划，新增
  agent-context-builder.service.ts  # 构造 AgentContext，新增
  agent-executor.service.ts         # 执行 Tool，解析变量，记录步骤
  agent-policy.service.ts           # 风险、审批、写入边界
  agent-trace.service.ts            # 决策、步骤、失败、复核记录

apps/api/src/modules/agent-tools/
  base-tool.ts                      # Tool 接口，扩展 Manifest V2
  tool-registry.service.ts          # 工具白名单
  tool-manifest.types.ts            # Manifest 类型，新增
  tools/
    resolve-project.tool.ts         # 新增
    resolve-volume.tool.ts          # 新增
    resolve-chapter.tool.ts         # 已有，增强
    resolve-character.tool.ts       # 新增
    collect-task-context.tool.ts    # 新增或增强 collect_chapter_context
    write-chapter.tool.ts
    polish-chapter.tool.ts
    fact-validation.tool.ts
    auto-repair-chapter.tool.ts
    ...

apps/api/src/modules/agent-skills/
  builtin-skills.ts                 # 任务 playbook，增强
  skill-registry.service.ts

apps/web/components/agent/
  AgentPlanView.tsx                 # 展示理解、假设、风险、步骤
  AgentArtifactPreview.tsx
  AgentTimeline.tsx
  AgentApprovalDialog.tsx
```

---

## 5. 智能化能力矩阵

| 用户自然语言 | Agent 理解 | 需要解析 | 推荐工具链 | 是否需确认 |
|---|---|---|---|---|
| “帮我写第十二章，压迫感强一点” | 写指定章节正文 | `projectId`、第十二章 → `chapterId` | `resolve_chapter → collect_task_context → write_chapter → polish_chapter → fact_validation → auto_repair_chapter → extract_chapter_facts → rebuild_memory → review_memory` | 需要 |
| “这一章太平了，改得紧张点，别改结局” | 修改当前章节草稿，增强节奏并保留结局 | 当前章、当前草稿、结局约束 | `collect_task_context → revise_chapter / polish_chapter → fact_validation → auto_repair_chapter` | 需要 |
| “检查男主有没有崩” | 检查角色一致性 | 男主 → `characterId`，相关章节和事实 | `resolve_character → collect_task_context → consistency_check` | 只读可不需要 |
| “扩展世界观，但不要影响已有剧情” | 世界观增量设计，不覆盖已确认事实 | 项目、相关设定、剧情事实 | `inspect_project_context → generate_worldbuilding_preview → fact_validation / validate_worldbuilding` | 写入需要 |
| “根据前三章，继续写下一章” | 解析下一章并读取前三章上下文后写作 | 下一章、前三章范围 | `resolve_chapter → collect_task_context → write_chapter...` | 需要 |
| “把第一卷拆成 30 章” | 大纲设计或重构 | 第一卷 → `volumeId` | `resolve_volume → inspect_project_context → generate_outline_preview → validate_outline → persist_outline` | 写入需要 |
| “这段文案帮我拆成角色、设定和前三卷大纲” | 文案导入预览 | 无 ID 或当前项目可选 | `analyze_source_text → build_import_preview → validate_imported_assets → persist_project_assets` | 写入需要 |

---

## 6. AgentContext V2

### 6.1 设计目标

`AgentContext` 不是让程序替 LLM 判断用户意图，而是让 LLM 有足够背景做正确判断。

它应该回答：

- 当前用户在哪个项目中？
- 当前选中了哪一章、哪一卷？
- 当前章的标题、序号、状态、摘要、草稿是什么？
- 最近章节发生了什么？
- 主要角色是谁，当前状态是什么？
- 世界观、事实库、伏笔有哪些不可破坏？
- 可用工具有哪些，怎么调用？
- 当前运行模式是 Plan 还是 Act？
- 哪些操作需要审批？

### 6.2 TypeScript 草案

```ts
export interface AgentContextV2 {
  schemaVersion: 2;

  userMessage: string;

  runtime: {
    mode: 'plan' | 'act';
    agentRunId?: string;
    planVersion?: number;
    locale: 'zh-CN' | 'en-US' | string;
    timezone?: string;
    maxSteps: number;
    maxLlmCalls: number;
  };

  session: {
    currentProjectId?: string;
    currentProjectTitle?: string;
    currentVolumeId?: string;
    currentVolumeTitle?: string;
    currentChapterId?: string;
    currentChapterTitle?: string;
    currentChapterIndex?: number;
    currentDraftId?: string;
    selectedText?: string;
    selectedRange?: { start: number; end: number };
  };

  project?: {
    id: string;
    title: string;
    genre?: string;
    style?: string;
    synopsis?: string;
    defaultWordCount?: number;
    status?: string;
  };

  currentChapter?: {
    id: string;
    title: string;
    index: number;
    status: string;
    outline?: string;
    summary?: string;
    draftId?: string;
    draftVersion?: number;
    endingSummary?: string;
  };

  recentChapters: Array<{
    id: string;
    title: string;
    index: number;
    summary: string;
    keyEvents?: string[];
  }>;

  knownCharacters: Array<{
    id: string;
    name: string;
    aliases: string[];
    role?: string;
    currentState?: string;
    relationshipHints?: string[];
  }>;

  worldFacts: Array<{
    id: string;
    type: 'setting' | 'rule' | 'location' | 'faction' | 'timeline' | 'foreshadowing';
    title: string;
    content: string;
    locked?: boolean;
  }>;

  memoryHints: Array<{
    id: string;
    type: string;
    content: string;
    relevance: number;
    source?: string;
  }>;

  constraints: {
    hardRules: string[];
    styleRules: string[];
    approvalRules: string[];
    idPolicy: string[];
  };

  availableTools: ToolManifestV2[];
}
```

### 6.3 上下文分层

为避免 Prompt 过长，Context 分三层：

```text
Hot Context：每次 Planner 必带
  - userMessage
  - session
  - project digest
  - current chapter pointer
  - available tools manifest summary
  - hard rules / id policy

Warm Context：按任务类型或当前选择补充
  - recent chapters summaries
  - current chapter outline / summary / draft pointer
  - known characters compact state
  - key world facts

Cold Context：由工具按需召回
  - full chapter content
  - full project facts
  - long memory chunks
  - historical drafts
  - related lorebook entries
```

### 6.4 Context Builder 流程

```text
AgentRuntime.plan(agentRunId)
  ↓
读取 AgentRun：goal、projectId、chapterId、createdBy
  ↓
读取 session hints：currentProjectId、currentChapterId、selectedText
  ↓
读取 project digest
  ↓
读取 current chapter digest
  ↓
读取 recent chapter summaries
  ↓
读取 known characters compact state
  ↓
读取 locked facts / memory hints
  ↓
注入 Tool Manifest V2
  ↓
生成 AgentContextV2
```

### 6.5 Context Builder 不做的事

它不应该：

- 用关键词判断 `taskType`。
- 擅自决定调用哪个工具。
- 猜测“男主”是谁。
- 猜测“第十二章”的真实 ID。
- 替 LLM 做创作判断。

它只负责把 LLM 需要看的信息准备好。

---

## 7. Tool Manifest V2

### 7.1 为什么要升级

当前工具主要服务于程序执行：有名称、schema、风险和副作用。要让 LLM 更聪明，还需要给工具增加语义说明。

### 7.2 类型草案

```ts
export interface ToolManifestV2 {
  name: string;
  displayName: string;
  description: string;

  whenToUse: string[];
  whenNotToUse: string[];

  inputSchema: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;

  parameterHints?: Record<string, {
    source:
      | 'context'
      | 'resolver'
      | 'previous_step'
      | 'user_message'
      | 'literal'
      | 'runtime';
    description: string;
    resolverTool?: string;
    examples?: string[];
  }>;

  examples?: Array<{
    user: string;
    context?: Record<string, unknown>;
    plan: Array<{
      tool: string;
      args: Record<string, unknown>;
    }>;
  }>;

  preconditions?: string[];
  postconditions?: string[];
  failureHints?: Array<{
    code: string;
    meaning: string;
    suggestedRepair: string;
  }>;

  allowedModes: Array<'plan' | 'act'>;
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  sideEffects: string[];

  idPolicy?: {
    forbiddenToInvent: string[];
    allowedSources: string[];
  };

  artifactMapping?: Array<{
    outputPath: string;
    artifactType: string;
    title: string;
  }>;
}
```

### 7.3 示例：`write_chapter`

```ts
export const writeChapterManifest: ToolManifestV2 = {
  name: 'write_chapter',
  displayName: '生成章节正文',
  description: '根据章节大纲、项目设定、角色状态、前文上下文和用户要求生成章节正文草稿。',

  whenToUse: [
    '用户要求写新章节正文',
    '用户要求根据章节大纲生成正文',
    '用户要求继续写下一章',
    '用户要求补写某一章内容',
  ],

  whenNotToUse: [
    '用户只是询问创作建议',
    '用户只是检查设定矛盾',
    '用户只是要修改已有章节，应优先使用 revise_chapter 或 polish_chapter',
    '缺少真实 chapterId 且尚未调用 resolve_chapter',
  ],

  inputSchema: {
    type: 'object',
    required: ['chapterId', 'instruction'],
    additionalProperties: false,
    properties: {
      chapterId: {
        type: 'string',
        description: '真实章节 ID。不能编造。用户说“第十二章”“下一章”“当前章”时，先调用 resolve_chapter。',
      },
      instruction: {
        type: 'string',
        description: '用户对本次写作的自然语言要求，保留风格、氛围、限制和目标。',
      },
      targetWordCount: {
        type: 'number',
        description: '目标字数。用户未指定时使用项目默认字数。',
      },
    },
  },

  parameterHints: {
    chapterId: {
      source: 'resolver',
      resolverTool: 'resolve_chapter',
      description: '从 session.currentChapterId 或 resolve_chapter 输出获得。',
      examples: ['当前章', '下一章', '第十二章'],
    },
    instruction: {
      source: 'user_message',
      description: '直接保留用户需求，不要过度压缩导致创作约束丢失。',
    },
  },

  examples: [
    {
      user: '帮我写第十二章，压迫感强一点，3500 字。',
      plan: [
        { tool: 'resolve_chapter', args: { chapterRef: '第十二章' } },
        { tool: 'collect_task_context', args: { taskType: 'chapter_write', chapterId: '{{steps.1.output.chapterId}}' } },
        { tool: 'write_chapter', args: { chapterId: '{{steps.1.output.chapterId}}', instruction: '压迫感强一点', targetWordCount: 3500 } },
      ],
    },
  ],

  allowedModes: ['act'],
  riskLevel: 'medium',
  requiresApproval: true,
  sideEffects: ['create_chapter_draft', 'update_runtime_current_draft'],
  idPolicy: {
    forbiddenToInvent: ['chapterId'],
    allowedSources: ['context.session.currentChapterId', 'resolve_chapter.output.chapterId'],
  },
};
```

### 7.4 示例：`resolve_chapter`

```ts
export const resolveChapterManifest: ToolManifestV2 = {
  name: 'resolve_chapter',
  displayName: '解析章节引用',
  description: '把用户自然语言中的章节引用解析为真实 chapterId。',

  whenToUse: [
    '用户提到“当前章”“这一章”“下一章”“上一章”',
    '用户提到“第十二章”“第 12 章”“第一卷第三章”',
    '目标工具需要 chapterId 但上下文没有明确 ID',
  ],

  whenNotToUse: [
    'AgentContext.session.currentChapterId 已经明确且用户没有提到其他章节',
    '用户没有涉及章节级操作',
  ],

  inputSchema: {
    type: 'object',
    required: ['chapterRef'],
    properties: {
      projectId: {
        type: 'string',
        description: '真实项目 ID。通常来自 AgentContext.session.currentProjectId。',
      },
      chapterRef: {
        type: 'string',
        description: '用户的自然语言章节引用，例如“第十二章”“当前章”“下一章”。',
      },
      currentChapterId: {
        type: ['string', 'null'],
        description: '如果有当前章，用于解析“上一章/下一章/这一章”。',
      },
    },
  },

  outputSchema: {
    type: 'object',
    required: ['chapterId', 'confidence'],
    properties: {
      chapterId: { type: 'string' },
      title: { type: 'string' },
      index: { type: 'number' },
      confidence: { type: 'number' },
      alternatives: { type: 'array' },
      needsUserChoice: { type: 'boolean' },
    },
  },

  allowedModes: ['plan', 'act'],
  riskLevel: 'low',
  requiresApproval: false,
  sideEffects: [],
};
```

---

## 8. Resolver 工具族

Resolver 是智能化的关键。它们不负责创作，只负责把自然语言引用转成系统实体。

### 8.1 推荐工具清单

```text
resolve_project
resolve_volume
resolve_chapter
resolve_character
resolve_location
resolve_world_setting
resolve_memory_query
collect_task_context
```

### 8.2 解析置信度策略

| 置信度 | 行为 |
|---|---|
| `confidence >= 0.85` | 自动使用解析结果 |
| `0.55 <= confidence < 0.85` | 生成 Plan 时展示假设或让用户选择 |
| `confidence < 0.55` | 不执行写入，写入 `missingInfo` |
| 多个候选很接近 | 进入 `waiting_review` 或要求用户选择 |

### 8.3 `resolve_character` 示例

输入：

```json
{
  "projectId": "project_123",
  "characterRef": "男主"
}
```

输出：

```json
{
  "characterId": "character_456",
  "name": "林烬",
  "aliases": ["男主", "林少爷"],
  "role": "protagonist",
  "confidence": 0.94,
  "alternatives": []
}
```

### 8.4 `collect_task_context` 示例

`collect_task_context` 是比 `collect_chapter_context` 更通用的上下文收集工具。它根据任务类型拉取所需上下文。

输入：

```json
{
  "projectId": "project_123",
  "taskType": "character_consistency_check",
  "entityRefs": {
    "characterId": "character_456",
    "chapterRange": "前三章到当前章"
  },
  "focus": ["character_arc", "dialogue_style", "known_facts"]
}
```

输出：

```json
{
  "projectDigest": {},
  "chapters": [],
  "characters": [],
  "worldFacts": [],
  "memoryChunks": [],
  "constraints": [],
  "diagnostics": {
    "retrievalMode": "hybrid",
    "missingContext": []
  }
}
```

---

## 9. Planner V2

### 9.1 Planner 职责

Planner 不只是输出工具列表，而是输出它对用户需求的理解、假设、缺失信息、上下文需求、执行计划和风险。

### 9.2 输出结构

```ts
export interface AgentPlanV2 {
  schemaVersion: 2;
  understanding: string;
  userGoal: string;
  taskType: string;
  confidence: number;

  assumptions: string[];
  missingInfo: Array<{
    field: string;
    reason: string;
    canResolveByTool: boolean;
    resolverTool?: string;
  }>;

  requiredContext: Array<{
    name: string;
    reason: string;
    source: 'agent_context' | 'resolver' | 'tool' | 'user';
  }>;

  steps: AgentPlanStepV2[];

  riskReview: {
    riskLevel: 'low' | 'medium' | 'high';
    reasons: string[];
    requiresApproval: boolean;
    approvalMessage: string;
  };

  userVisiblePlan: {
    summary: string;
    bullets: string[];
    hiddenTechnicalSteps?: boolean;
  };
}

export interface AgentPlanStepV2 {
  id: string;
  stepNo: number;
  purpose: string;
  tool: string;
  mode: 'act';
  args: Record<string, unknown>;
  dependsOn?: string[];
  runIf?: AgentStepCondition;
  produces?: string[];
  onFailure?: {
    strategy: 'replan' | 'ask_user' | 'fail_fast' | 'skip';
    reason: string;
  };
}
```

### 9.3 Planner 流程

```text
1. 读取 AgentContextV2
2. 理解用户目标
3. 判断 taskType
4. 判断哪些参数已在上下文中
5. 判断哪些自然语言引用需要 resolver
6. 编排只读上下文步骤
7. 编排写入或生成步骤
8. 根据工具 manifest 标记风险和审批
9. 输出 AgentPlanV2
10. Runtime 校验工具白名单、schema、引用边界、审批边界
```

### 9.4 示例 Plan

用户：

```text
这一章太平了，帮我改得更有压迫感，但别改结局。
```

输出：

```json
{
  "schemaVersion": 2,
  "understanding": "用户想修改当前章节草稿，增强压迫感和紧张感，同时保留原章节结局和既有剧情事实。",
  "userGoal": "这一章太平了，帮我改得更有压迫感，但别改结局。",
  "taskType": "chapter_revision",
  "confidence": 0.92,
  "assumptions": [
    "“这一章”指 session.currentChapterId",
    "“别改结局”表示保留当前草稿最后一个关键剧情节点和结果"
  ],
  "missingInfo": [],
  "requiredContext": [
    {
      "name": "current_chapter_draft",
      "reason": "需要知道原章节内容和结局",
      "source": "tool"
    },
    {
      "name": "plot_facts",
      "reason": "避免修改时破坏已有剧情事实",
      "source": "tool"
    }
  ],
  "steps": [
    {
      "id": "collect_context",
      "stepNo": 1,
      "purpose": "收集当前章节、前文、角色状态和事实约束",
      "tool": "collect_task_context",
      "mode": "act",
      "args": {
        "taskType": "chapter_revision",
        "chapterId": "{{context.session.currentChapterId}}",
        "focus": ["current_draft", "ending", "tension", "plot_facts", "character_state"]
      },
      "produces": ["chapterContext"]
    },
    {
      "id": "revise_chapter",
      "stepNo": 2,
      "purpose": "在保留结局的前提下重写章节草稿",
      "tool": "polish_chapter",
      "mode": "act",
      "args": {
        "chapterId": "{{context.session.currentChapterId}}",
        "draftId": "{{context.session.currentDraftId}}",
        "instruction": "增强压迫感和紧张感；保留原结局；不改变已确认剧情事实和角色状态。"
      },
      "dependsOn": ["collect_context"],
      "onFailure": {
        "strategy": "replan",
        "reason": "如果缺少 draftId 或章节上下文，应先解析或收集上下文。"
      }
    },
    {
      "id": "fact_validation",
      "stepNo": 3,
      "purpose": "校验修改后草稿是否破坏事实一致性",
      "tool": "fact_validation",
      "mode": "act",
      "args": {
        "chapterId": "{{context.session.currentChapterId}}"
      },
      "dependsOn": ["revise_chapter"]
    }
  ],
  "riskReview": {
    "riskLevel": "medium",
    "reasons": ["会生成新的章节草稿", "需要保留原结局和事实一致性"],
    "requiresApproval": true,
    "approvalMessage": "确认后将生成一个新的修改草稿，不会直接覆盖已确认正文。"
  },
  "userVisiblePlan": {
    "summary": "我会先读取当前章节和事实约束，再生成一个更有压迫感但保留结局的修改草稿，并做一致性校验。",
    "bullets": [
      "读取当前章节和前文上下文",
      "识别原结局和不可改动事实",
      "生成更紧张的修改草稿",
      "检查是否破坏角色和剧情事实"
    ],
    "hiddenTechnicalSteps": true
  }
}
```

---

## 10. 变量引用规范

当前执行器已经支持类似：

```text
{{steps.1.output.chapterId}}
{{steps.1.output}}
{{runtime.currentDraftId}}
{{runtime.currentChapterId}}
```

建议扩展为兼容两类引用：

```text
{{context.session.currentProjectId}}
{{context.session.currentChapterId}}
{{steps.resolve_chapter.output.chapterId}}
{{steps.1.output.chapterId}}
{{runtime.currentDraftId}}
```

### 10.1 引用规则

| 引用 | 用途 | 是否允许 |
|---|---|---|
| `{{context.session.currentProjectId}}` | 从上下文取当前项目 | 允许 |
| `{{context.session.currentChapterId}}` | 从上下文取当前章节 | 允许 |
| `{{steps.1.output.chapterId}}` | 从前序步骤取字段 | 允许 |
| `{{steps.current.output.xxx}}` | 引用当前或未来步骤 | 禁止 |
| `project_123_fake` | LLM 自造 ID | 禁止 |
| `第十二章` 直接传给 `chapterId` | 自然语言引用冒充 ID | 禁止 |

### 10.2 Executor 校验

Executor 在执行前应检查：

1. 所有 `*.Id` 参数是否来自允许来源。
2. 是否引用了未来步骤。
3. 是否把自然语言引用传给 ID 字段。
4. schema 是否通过。
5. 该工具是否允许当前 mode 执行。
6. 该步骤是否已审批。

---

## 11. Observation / Replan 机制

### 11.1 设计目标

工具失败不应该直接暴露给用户，而应该先作为 observation 返回给 LLM，让 LLM 尝试修复计划。

### 11.2 错误结构

```ts
export interface AgentObservation {
  stepId: string;
  stepNo: number;
  tool: string;
  mode: 'plan' | 'act';
  args: Record<string, unknown>;
  error: {
    code:
      | 'MISSING_REQUIRED_ARGUMENT'
      | 'SCHEMA_VALIDATION_FAILED'
      | 'ENTITY_NOT_FOUND'
      | 'AMBIGUOUS_ENTITY'
      | 'POLICY_BLOCKED'
      | 'APPROVAL_REQUIRED'
      | 'LLM_JSON_INVALID'
      | 'TOOL_TIMEOUT'
      | 'TOOL_INTERNAL_ERROR'
      | 'VALIDATION_FAILED';
    message: string;
    missing?: string[];
    candidates?: unknown[];
    retryable: boolean;
  };
  previousOutputs: Record<string, unknown>;
}
```

### 11.3 Replan 输入

```json
{
  "userGoal": "帮我写第十二章，压迫感强一点",
  "currentPlan": {},
  "executedSteps": [],
  "failedObservation": {
    "tool": "write_chapter",
    "error": {
      "code": "MISSING_REQUIRED_ARGUMENT",
      "missing": ["chapterId"]
    }
  },
  "agentContext": {},
  "availableTools": []
}
```

### 11.4 Replan 输出

```json
{
  "action": "patch_plan",
  "reason": "write_chapter 缺少真实 chapterId，需要先解析用户的章节引用。",
  "insertStepsBeforeFailedStep": [
    {
      "id": "resolve_chapter",
      "purpose": "解析第十二章为真实章节 ID",
      "tool": "resolve_chapter",
      "args": {
        "projectId": "{{context.session.currentProjectId}}",
        "chapterRef": "第十二章"
      }
    }
  ],
  "replaceFailedStepArgs": {
    "chapterId": "{{steps.resolve_chapter.output.chapterId}}"
  }
}
```

### 11.5 Replan 边界

为了避免自动循环失控：

- 单次 AgentRun 最多 replan 2 次。
- 同一个 step 同类错误最多修复 1 次。
- 高风险写入错误不自动绕过审批。
- Resolver 低置信度不自动选择。
- 已成功且有副作用的步骤默认不重跑，除非工具声明幂等。

---

## 12. Skill / Task Playbook 设计

Skill 不是硬规则，而是给 Planner 的专业方法论。

### 12.1 推荐 taskType

当前可保留已有任务：

```text
chapter_write
chapter_polish
outline_design
project_import_preview
general
```

建议逐步新增：

```text
chapter_revision
character_consistency_check
worldbuilding_expand
plot_consistency_check
memory_review
```

### 12.2 `chapter_write` Playbook

```text
适用：写新章节、继续写下一章、按大纲写正文。

推荐步骤：
1. resolve_chapter（当章节引用不是明确 ID）
2. collect_task_context
3. write_chapter
4. polish_chapter
5. fact_validation
6. auto_repair_chapter（最多一轮或两轮有界）
7. extract_chapter_facts
8. rebuild_memory
9. review_memory
10. report_result

关键约束：
- 不得改变已确认事实。
- 不得绕过章节大纲的核心事件。
- 不得编造角色长期状态。
- 自动修复只能做最小必要修改。
```

### 12.3 `chapter_revision` Playbook

```text
适用：用户要求“改这一章”“节奏太慢”“压迫感更强”“别改结局”。

推荐步骤：
1. collect_task_context，必须包含 current draft、ending、facts、character states
2. revise_chapter 或 polish_chapter
3. fact_validation
4. auto_repair_chapter
5. report_result

关键约束：
- 明确保留用户说不能改的内容。
- 如果用户说“别改结局”，需要先识别原结局摘要。
- 输出最好包含“改动说明”和“保留项”。
```

### 12.4 `character_consistency_check` Playbook

```text
适用：检查人设有没有崩、角色动机是否合理、对话是否符合角色。

推荐步骤：
1. resolve_character
2. collect_task_context
3. character_consistency_check
4. report_result

输出：
- 人设基线
- 当前章节表现
- 可疑偏差
- 是否真的崩
- 修改建议
- 可选修稿计划
```

### 12.5 `worldbuilding_expand` Playbook

```text
适用：扩展世界观、门派、城市、能力体系、历史背景。

推荐步骤：
1. inspect_project_context
2. collect_task_context
3. generate_worldbuilding_preview
4. validate_worldbuilding
5. persist_worldbuilding（需审批）

关键约束：
- 只能增量扩展，不覆盖 locked facts。
- 与已有剧情冲突时必须标红提示。
- 写入前展示 diff。
```

---

## 13. 审批与风险控制

### 13.1 风险等级

| 风险等级 | 示例 | 处理方式 |
|---|---|---|
| low | 解析章节、读取上下文、只读检查 | 可在 Plan 阶段执行 |
| medium | 生成章节草稿、润色草稿、生成大纲预览 | 需要用户确认后执行写入 |
| high | 覆盖已确认正文、批量写角色设定、删除数据、覆盖事实库 | 需要显式二次确认 |

### 13.2 写入保护

所有写入工具必须声明：

```text
sideEffects
requiresApproval
riskLevel
idempotencyKey 支持情况
rollback 或补偿策略
```

推荐策略：

- 章节生成只写 `ChapterDraft`，不直接覆盖正式正文。
- 修改章节生成新草稿版本，保留旧版本。
- 事实库写入默认新增，不覆盖 locked facts。
- 批量导入必须先生成 preview artifact。
- 删除和覆盖必须二次确认。

### 13.3 用户可见审批文案

不要展示底层工具名作为主要内容。用户应该看到：

```text
我理解你要：重写当前章节，让压迫感更强，但保留结局。

我会做：
1. 读取当前章节和前文
2. 找出原结局和不能改的事实
3. 生成一个新草稿版本
4. 做事实一致性检查

确认后会新建草稿，不会覆盖正式正文。
```

技术细节可折叠展示：

```text
collect_task_context → polish_chapter → fact_validation → auto_repair_chapter
```

---

## 14. 前端体验设计

### 14.1 AgentPlanView 展示结构

```text
Agent 的理解
  - 用户想做什么
  - 目标对象是什么
  - 关键限制是什么

需要确认的假设
  - “这一章”= 第 12 章《雨夜审判》
  - “男主”= 林烬

执行计划
  - 人类可读步骤
  - 风险和审批说明

预览产物
  - 大纲预览 / 角色预览 / 章节上下文预览 / 校验报告

技术细节（可折叠）
  - Tool calls
  - Args
  - Step output
  - Trace
```

### 14.2 不确定性 UX

当 resolver 有多个候选时：

```text
我不确定你说的“男主”指哪一个：
A. 林烬（主角，出现 12 章）
B. 沈怀舟（第一卷视角角色，出现 5 章）

请选择后我继续。
```

当缺少上下文时：

```text
当前没有选中项目。我可以：
1. 使用最近编辑的项目《长夜余火》
2. 让你选择项目
```

### 14.3 结果报告

最终输出不仅给结果，还要给可验证信息：

```text
已完成：
- 新建章节草稿 v3
- 保留原结局：是
- 事实一致性问题：0 个严重，1 个轻微
- 已抽取事实：6 条
- 已重建记忆：8 条

你可以：
- 查看新草稿
- 对比旧版本
- 接受为正式正文
- 继续要求修改
```

---

## 15. API 与数据模型建议

### 15.1 `POST /api/agent-runs/plan`

请求建议增强：

```json
{
  "projectId": "project-id",
  "chapterId": "chapter-id",
  "message": "这一章太平了，改得更有压迫感，但别改结局。",
  "context": {
    "currentVolumeId": "volume-id",
    "currentDraftId": "draft-id",
    "selectedText": "可选中的段落",
    "selectedRange": { "start": 120, "end": 860 }
  },
  "attachments": []
}
```

### 15.2 AgentRun 可扩展字段

如果不想新增表，可以先继续使用 JSON 字段：

```prisma
model AgentRun {
  id        String @id @default(uuid())
  projectId String
  chapterId String?
  goal      String
  input     Json
  output    Json?
  error     String?
  // 建议 input 中保存 contextSnapshotDigest
  // 建议 output 中保存 latestObservation / plannerDiagnostics
}
```

中期可新增：

```prisma
model AgentContextSnapshot {
  id          String   @id @default(uuid())
  agentRunId  String
  schemaVersion Int
  content     Json
  digest      String
  createdAt   DateTime @default(now())
}
```

### 15.3 AgentStep 错误结构

`AgentStep.error` 建议统一存结构化 JSON：

```json
{
  "code": "MISSING_REQUIRED_ARGUMENT",
  "message": "chapterId is required",
  "retryable": true,
  "repairSuggestion": "call resolve_chapter before write_chapter"
}
```

---

## 16. 在当前仓库中的落地改造点

### 16.1 新增 `AgentContextBuilderService`

路径：

```text
apps/api/src/modules/agent-runs/agent-context-builder.service.ts
```

职责：

- 从 `AgentRun`、请求 DTO、项目、章节、角色、设定、记忆中构造 `AgentContextV2`。
- 只做上下文聚合，不做 taskType 判断。
- 输出可序列化 JSON，保存 digest 便于 trace。

`AgentRuntimeService.plan()` 从：

```ts
const plan = await this.planner.createPlan(run.goal);
```

改为：

```ts
const context = await this.contextBuilder.buildForPlan(run);
const plan = await this.planner.createPlan(run.goal, context);
```

### 16.2 扩展 `BaseTool`

路径：

```text
apps/api/src/modules/agent-tools/base-tool.ts
```

新增字段：

```ts
whenToUse?: string[];
whenNotToUse?: string[];
parameterHints?: Record<string, ToolParameterHint>;
examples?: ToolManifestExample[];
failureHints?: ToolFailureHint[];
idPolicy?: ToolIdPolicy;
```

为了兼容现有工具，可以先做可选字段，再逐步补齐。

### 16.3 `ToolRegistryService` 暴露 LLM 友好 manifest

路径：

```text
apps/api/src/modules/agent-tools/tool-registry.service.ts
```

新增：

```ts
listManifestsForPlanner(): ToolManifestForPlanner[]
```

返回给 Planner 的内容应压缩，但必须包含：

```text
name
description
whenToUse
whenNotToUse
inputSchema + parameter descriptions
outputSchema
riskLevel
requiresApproval
sideEffects
examples
idPolicy
```

### 16.4 增强 `AgentPlannerService`

路径：

```text
apps/api/src/modules/agent-runs/agent-planner.service.ts
```

改造点：

- `createPlan(goal: string, context: AgentContextV2)`。
- Prompt 中注入 `AgentContextV2`，而不只是 `userGoal`。
- 输出 `understanding / missingInfo / requiredContext / riskReview / userVisiblePlan`。
- 继续保留工具白名单校验和 steps 数量限制。
- 保留章节写作质量门禁的后端兜底，但把原因写进 planner diagnostics。

### 16.5 增加 Resolver Tools

优先级：

```text
P0: resolve_chapter 增强
P0: resolve_character
P1: resolve_project
P1: resolve_volume
P1: collect_task_context
P2: resolve_location
P2: resolve_world_setting
P2: resolve_memory_query
```

### 16.6 增加 `AgentReplannerService`

路径：

```text
apps/api/src/modules/agent-runs/agent-replanner.service.ts
```

职责：

- 接收 `AgentObservation`。
- 判断能否自动修复。
- 输出 patch plan。
- 不绕过 Policy 和 Approval。

### 16.7 Executor 支持 context 引用

路径：

```text
apps/api/src/modules/agent-runs/agent-executor.service.ts
```

增强 `resolveValue()`：

```text
{{context.session.currentProjectId}}
{{context.session.currentChapterId}}
{{context.project.defaultWordCount}}
{{steps.step_id.output.xxx}}
```

同时保留现有：

```text
{{steps.1.output.xxx}}
{{runtime.currentDraftId}}
```

### 16.8 前端展示理解和假设

路径：

```text
apps/web/components/agent/AgentPlanView.tsx
apps/web/components/agent/AgentApprovalDialog.tsx
```

新增展示：

```text
understanding
assumptions
missingInfo
requiredContext
riskReview
userVisiblePlan
resolver alternatives
```

---

## 17. 最小可行改造方案

### Phase 1：让 Planner 看见上下文和更好的工具说明

目标：不大改执行链路，先显著提升计划质量。

任务：

1. 新增 `AgentContextBuilderService`。
2. `AgentPlannerService.createPlan(goal, context)`。
3. Tool Manifest 补充 `whenToUse / whenNotToUse / parameterHints / examples`。
4. Planner 输出 `understanding / assumptions / missingInfo`。
5. 前端展示 Agent 理解和假设。

验收：

- 用户说“这一章”，Plan 能引用当前章。
- 用户说“第十二章”，Plan 能先调用 `resolve_chapter`。
- 用户说“别改结局”，Plan 的 instruction 能保留该约束。

### Phase 2：补齐 Resolver 和通用上下文收集

目标：解决 ID 和自然语言引用问题。

任务：

1. 增强 `resolve_chapter`。
2. 新增 `resolve_character`。
3. 新增或增强 `collect_task_context`。
4. Executor 校验 ID 来源。
5. 低置信度解析进入用户确认。

验收：

- “男主”“女主”“反派”能解析到角色或要求用户选择。
- “下一章”“上一章”“第十二章”能解析为真实章节。
- 不能把自然语言字符串传给 `chapterId`。

### Phase 3：Observation/Replan

目标：工具失败后自动修复常见问题。

任务：

1. 定义 `AgentObservation`。
2. 新增 `AgentReplannerService`。
3. Executor 捕获 retryable 错误并触发 replan。
4. 限制 replan 次数和风险边界。

验收：

- `MISSING_REQUIRED_ARGUMENT chapterId` 能自动插入 `resolve_chapter`。
- `AMBIGUOUS_ENTITY` 能让用户选择。
- `SCHEMA_VALIDATION_FAILED` 能修正参数结构。

### Phase 4：评测与持续优化

目标：让 Agent 智能化可度量。

任务：

1. 建立 `scripts/dev/eval_agent_planner.ts`。
2. 建立测试用例 JSON。
3. 对 Plan 质量、resolver 准确率、失败恢复率打分。
4. CI 或本地命令输出 regression report。

验收：

- 每次改 Prompt / Tool Manifest / Resolver 后能看到指标变化。
- 智能化不再靠主观感觉判断。

---

## 18. 评测体系

### 18.1 指标

| 指标 | 含义 | 目标 |
|---|---|---|
| Intent Accuracy | taskType 是否正确 | ≥ 90% |
| Tool Plan Accuracy | 工具链是否合理 | ≥ 85% |
| Required Param Completion | required 参数是否完整 | ≥ 90% |
| ID Hallucination Rate | 是否编造内部 ID | 0 |
| Resolver Usage Rate | 自然语言引用是否调用 resolver | ≥ 95% |
| First Plan Success Rate | 初次 Plan 通过校验率 | ≥ 85% |
| Auto Repair Success Rate | 可修复错误自动修复率 | ≥ 70% |
| Approval Safety | 写入类工具是否正确要求审批 | 100% |
| User Visible Clarity | 用户能否理解计划 | 人工评分 ≥ 4/5 |

### 18.2 测试用例格式

```json
{
  "id": "chapter_write_001",
  "message": "帮我写第十二章，压迫感强一点，3500字。",
  "context": {
    "session": {
      "currentProjectId": "project_1",
      "currentChapterId": "chapter_11"
    }
  },
  "expected": {
    "taskType": "chapter_write",
    "mustUseTools": ["resolve_chapter", "collect_task_context", "write_chapter"],
    "mustNotUseTools": ["persist_project_assets"],
    "mustContainInstruction": ["压迫感", "3500"],
    "mustRequireApproval": true,
    "forbidInventedIds": true
  }
}
```

### 18.3 推荐测试集

```text
1. 写指定章节：帮我写第十二章，压迫感强一点。
2. 写下一章：根据前三章继续写下一章。
3. 修改当前章：这一章太平了，改紧张点，别改结局。
4. 润色选中文本：把这段去 AI 味。
5. 检查角色：男主这里是不是人设崩了？
6. 检查剧情：当前大纲有没有矛盾？
7. 扩展世界观：补充宗门体系，但不要影响已有剧情。
8. 拆大纲：把第一卷拆成 30 章。
9. 文案导入：把这段文案拆成角色、世界观和三卷大纲。
10. 模糊引用：帮我改一下他和师姐对峙那章。
11. 多候选：帮我检查小林的人设。
12. 缺项目：帮我写下一章，但 session 无 currentProjectId。
```

---

## 19. Planner Prompt 建议

```text
你是 AI Novel 的 CreativeAgent Planner。

你的任务是理解用户的自然语言创作意图，并基于 AgentContext 和 Available Tools 生成可执行、可审批、可追踪的 JSON Plan。

你必须遵守：
1. 先理解用户真实意图，不要机械匹配关键词。
2. taskType 必须根据语义判断，并从 availableTaskTypes 中选择。
3. 只能使用 Available Tools 中的工具。
4. 不要编造 projectId、chapterId、volumeId、characterId、lorebookEntryId、memoryChunkId。
5. 如果用户使用自然语言引用，如“第十二章”“当前章”“下一章”“男主”“师姐”，必须先使用合适的 resolver，除非 AgentContext 已有明确 ID 且无歧义。
6. 如果目标工具 required 参数可以从 AgentContext 获得，使用 context 引用。
7. 如果参数来自前序步骤，使用 steps 引用。
8. 如果无法通过上下文或 resolver 获得必要信息，写入 missingInfo，不要硬猜。
9. Plan 阶段不得写正式业务表。
10. 会产生写入、副作用或覆盖风险的工具必须要求用户确认。
11. 对章节写作和修改，必须保留用户给出的风格、氛围、字数、禁改项和剧情约束。
12. 输出严格 JSON，不要 Markdown，不要额外解释。

输出字段：
- schemaVersion
- understanding
- userGoal
- taskType
- confidence
- assumptions
- missingInfo
- requiredContext
- steps
- riskReview
- userVisiblePlan
```

---

## 20. Replanner Prompt 建议

```text
你是 AI Novel 的 Agent Replanner。

你会收到：
- 用户原始目标
- 当前 AgentContext
- 当前 Plan
- 已成功步骤输出
- 失败步骤 Observation
- Available Tools

你的任务是判断失败是否可自动修复。

你必须遵守：
1. 不要绕过 Policy、Approval 或 Tool Schema。
2. 不要重跑已成功且有副作用的步骤，除非工具声明幂等。
3. 如果缺少 ID，优先插入 resolver。
4. 如果实体有歧义，输出 ask_user。
5. 如果错误不可修复，输出 fail_with_reason。
6. 最多输出一个最小 patch，不要重写整个计划。
7. 输出严格 JSON。
```

输出：

```ts
interface ReplanPatch {
  action: 'patch_plan' | 'ask_user' | 'fail_with_reason';
  reason: string;
  insertStepsBeforeFailedStep?: AgentPlanStepV2[];
  replaceFailedStepArgs?: Record<string, unknown>;
  questionForUser?: string;
  choices?: Array<{ id: string; label: string; payload: unknown }>;
}
```

---

## 21. 验收标准

### 21.1 用户体验验收

用户不需要知道：

```text
projectId
chapterId
characterId
Tool 名称
数据库结构
内部 pipeline
```

用户应该看到：

```text
Agent 理解了什么
有哪些假设
需要哪些确认
会做哪些步骤
会不会写入数据
结果在哪里
失败后怎么处理
```

### 21.2 技术验收

必须满足：

- Planner 不使用后端关键词规则决定 taskType。
- Tool 白名单校验始终开启。
- Tool input/output schema 校验始终开启。
- 写入类工具必须审批。
- 内部 ID 不允许由 LLM 编造。
- Resolver 低置信度不自动写入。
- Tool 失败以结构化 observation 记录。
- 可修复错误至少尝试一次 replan。
- 所有步骤可在 Agent Timeline 回看。
- 智能化测试集可本地运行。

---

## 22. 推荐开发顺序

```text
1. 补 Tool Manifest V2 字段，但保持兼容现有工具。
2. 新增 AgentContextBuilderService，让 Planner 看见 session/project/chapter/characters/tools。
3. 改 Planner 输出 AgentPlanV2：understanding / assumptions / missingInfo / requiredContext。
4. 增强 resolve_chapter，新增 resolve_character。
5. 新增 collect_task_context。
6. Executor 支持 context 引用和 ID 来源校验。
7. 前端展示 Agent 理解、假设、风险和用户可读计划。
8. 新增 Observation/Replan。
9. 建立 Agent Eval 测试集。
10. 扩展 worldbuilding / consistency / revision 等 skill。
```

---

## 23. 最终效果示例

用户：

```text
这一章太平了，帮我改得有压迫感一点，但是别改结局。
```

Agent 展示：

```text
我理解你想修改当前章节：
- 增强压迫感和紧张感
- 保留原结局
- 不破坏已有剧情事实和角色状态

我会执行：
1. 读取当前章节草稿、前文摘要和角色状态
2. 识别原章节结局和不可改动事实
3. 生成一个新的修改草稿版本
4. 做事实一致性检查
5. 如果有轻微矛盾，进行一次最小修复

确认后只会新建草稿，不会覆盖正式正文。
```

技术计划：

```text
collect_task_context
  → polish_chapter / revise_chapter
  → fact_validation
  → auto_repair_chapter
  → report_result
```

用户确认后，Agent 执行并输出：

```text
已生成新草稿 v4。
- 压迫感增强：通过环境压迫、对话停顿、倒计时和角色身体反应实现
- 原结局：已保留
- 事实一致性：无严重问题
- 建议：第 3 段可继续压缩，以进一步提升节奏
```

---

## 24. 总结

Agent 变聪明，不靠堆关键词规则，而靠构造一个让 LLM 能正确工作的环境。

这个环境包括：

```text
AgentContext：让 LLM 看见当前项目、章节、角色、事实和记忆
Tool Manifest：让 LLM 理解工具什么时候用、怎么补参、有什么风险
Resolver：让 LLM 把自然语言引用转换为真实实体 ID
Executor：让计划安全、可审批、可追踪地执行
Observation/Replan：让失败变成可修复的反馈
Eval：让智能化质量可度量、可回归
```

最终用户只需要说创作意图，Agent 就能自动理解、规划、取上下文、解析参数、调用工具、校验质量并给出可审计结果。
