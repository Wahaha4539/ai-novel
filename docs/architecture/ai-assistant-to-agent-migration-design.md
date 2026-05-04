# AI 助手能力迁移到 Agent 设计文档

> 目标：把当前「创作引导」里的 AI 助手能力迁移到 Agent 体系中。  
> 范围：右侧 AI 助手聊天、当前步骤问答、AI 生成、结构化保存、步骤推进、创意文档导入。  
> 关联专题：`docs/architecture/creative-document-import-agent-design.md`

## 1. 背景

当前系统同时存在两套 AI 交互链路：

1. 「创作引导」页面里的 AI 助手  
   前端主要由 `apps/web/components/guided/AiChatPanel.tsx` 和 `apps/web/hooks/useGuidedSession.ts` 承载；后端走 `apps/api/src/modules/guided/guided.controller.ts` 与 `guided.service.ts`，接口包括 `guided-session/chat`、`generate-step`、`finalize-step`。

2. Agent 工作台  
   前端由 `apps/web/components/agent/*` 和 `apps/web/hooks/useAgentRun.ts` 承载；后端走 `apps/api/src/modules/agent-runs/*`、`agent-tools/*`、`agent-skills/*`，具备 Plan/Act、审批、ToolRegistry、Trace、Artifact、Observation/Replan 等能力。

两套链路能力有重叠：都能围绕小说项目生成设定、大纲、角色、卷纲和章节规划。但 AI 助手目前更像“引导式聊天 + 直接生成/保存”，Agent 更像“计划、审批、执行和审计”。长期应该由 Agent 成为统一 AI 入口，AI 助手能力迁移为 Agent 的任务、工具和上下文。

## 2. 核心结论

AI 助手功能可以迁移到 Agent，但不建议原样搬运 UI 或接口。推荐迁移方式是：

```text
AI 助手的交互体验
  → 保留为用户可见的轻量入口

AI 助手的能力实现
  → 迁移为 Agent taskType + Tool + Artifact + Approval

AI 助手的写入动作
  → 统一进入 Agent Act 阶段，用户审批后执行
```

最终形态：

```text
用户在创作引导页提问或点击 AI 生成
  ↓
前端调用 Agent createPlan
  ↓
Agent 根据当前引导步骤和项目上下文生成计划/预览
  ↓
前端展示预览和风险
  ↓
用户确认
  ↓
Agent Act 写入项目资料、角色、设定、卷纲、章节纲或伏笔
```

## 3. 当前 AI 助手能力清单

| 能力 | 当前入口 | 当前后端 | 迁移目标 |
|---|---|---|---|
| 当前步骤问答 | `AiChatPanel` | `guided-session/chat` | Agent chat message + `guided_step_consultation` |
| 开始引导会话 | `useGuidedSession.startSession` | `guided-session` | Agent 新会话 + 当前步骤上下文 |
| 一键生成当前步骤 | `generateStepData` | `guided-session/generate-step` | Agent Plan 预览 Tool |
| 结构化保存当前步骤 | `confirmGeneratedData` / `finalizeCurrentStep` | `guided-session/finalize-step` | Agent Act 写入 Tool |
| 自动识别步骤完成 | `[STEP_COMPLETE]` marker | `guided-session/chat` | Agent Artifact + 待审批写入 |
| 上一步/下一步 | `goToPrevStep` / `goToNextStep` | `guided-session/step` | 保留 UI 状态，写入动作交给 Agent |
| 基础设定生成 | `guided_setup` | `GuidedService` | `generate_project_profile_preview` / `persist_project_profile` |
| 风格定义生成 | `guided_style` | `GuidedService` | `generate_style_profile_preview` / `persist_style_profile` |
| 核心角色生成 | `guided_characters` | `GuidedService` | `build_import_preview` 或 `generate_characters_preview` / `persist_project_assets` |
| 故事总纲生成 | `guided_outline` | `GuidedService` | `generate_outline_preview` / `persist_outline` 或 project outline tool |
| 卷纲拆分 | `guided_volume` | `GuidedService` | `generate_outline_preview` / `persist_outline` 增强 |
| 章节细纲 | `guided_chapter` | `GuidedService` | `generate_outline_preview` 增强 / `persist_outline` |
| 伏笔设计 | `guided_foreshadow` | `GuidedService` | `generate_foreshadow_preview` / `persist_foreshadow` |
| 创意文档导入 | 新增 | 新增附件读取 Tool | `read_source_document → build_import_preview` |

### 3.1 `useGuidedSession` 方法迁移映射

| 方法 | 当前行为 | 能力类型 | Agent 迁移目标 |
|---|---|---|---|
| `startSession` | 创建 `guided-session`，并调用 `guided-session/chat` 生成开场引导 | 只读会话初始化 | 保留 guided UI 会话状态，同时创建或关联 Agent 会话；开场引导走 `guided_step_consultation`，携带 `context.session.guided.currentStep='guided_setup'` |
| `sendMessage` | 将用户消息、当前 step、聊天历史和项目上下文发送到 `guided-session/chat` | 只读问答；但当前会通过 `[STEP_COMPLETE]` 间接触发写入 | 默认迁移为 `guided_step_consultation` Agent Plan/消息；如果模型返回结构化完成建议，应生成 Artifact 和待审批写入计划，不直接写库 |
| `generateStepData` | 调用 `guided-session/generate-step` 一次性生成当前或指定 step 的结构化数据 | 只读生成预览 | 迁移为 `guided_step_generate`，调用 `generate_guided_step_preview`，输出 `guided_step_preview` Artifact；Plan 阶段不写库 |
| `confirmGeneratedData` | 将生成或编辑后的结构化数据直接提交到 `guided-session/finalize-step` | 写入能力 | 迁移为 `guided_step_finalize` Act 流程，先走 `validate_guided_step_preview`，用户审批后调用 `persist_guided_step_result` |
| `finalizeCurrentStep` | 先调用 `guided-session/chat` 从对话抽取 JSON，再调用 `guided-session/finalize-step` 写库 | 写入能力 | 拆成 `guided_step_generate` 预览和 `guided_step_finalize` 审批写入；抽取结果先作为 Artifact 展示，审批前不得持久化 |
| `goToNextStep` | 先执行 `finalizeCurrentStep`，成功后切换 step，并调用 `guided-session/chat` 生成下一步开场 | 混合能力：步骤状态更新 + 写入 + 只读引导 | 步骤导航状态继续由 guided UI 管理；当前 step 写入必须走 Agent Act，下一步开场走 `guided_step_consultation` 并携带新的 guided context |
| `goToPrevStep` | 本地切换到上一 step，并从 `session.stepData` 恢复聊天 | UI 状态能力 | 保留在 guided UI；不需要 Agent 写入，仅在后续 Agent 调用时提供恢复后的 `guided.currentStep/currentStepData` |
| `autoAdvanceToNextStep` | 自动切换下一 step，并调用 `guided-session/chat` 生成下一步开场 | 混合能力：步骤状态更新 + 只读引导 | 保留自动步骤推进的 UI 状态更新；下一步开场迁移为 `guided_step_consultation`，不得隐式触发写库 |
| `saveStepProgress` | PATCH `guided-session/step` 保存当前 step 和聊天记录 | UI/进度状态写入 | 短期保留为 guided 进度 API；它只保存引导过程状态，不替代 Agent Act 对业务资料的写入 |

能力边界：

- 只读能力：`startSession` 的开场引导、`sendMessage` 普通问答、`generateStepData` 预览生成、下一步开场引导。
- 写入能力：`confirmGeneratedData`、`finalizeCurrentStep`、`sendMessage` 中由 `[STEP_COMPLETE]` 触发的自动保存，以及 `goToNextStep` 隐含的当前步骤保存。
- UI/进度状态能力：`goToPrevStep`、`autoAdvanceToNextStep` 的步骤切换、`saveStepProgress` 的引导进度保存。它们可以保留在 guided 模块，但调用 Agent 时必须同步传入 `guided` 上下文。

## 4. 迁移原则

### 4.1 Agent 是能力主干

AI 助手不再直接调用 `guided-session/chat` 或 `finalize-step` 完成写库。它只负责收集用户输入、展示当前步骤、展示 Agent 的预览和结果。

### 4.2 Plan 阶段生成预览，不写库

当前 `guided-session/generate-step` 生成出的结构化内容，迁移后应变成 Agent Artifact，例如：

- `project_profile_preview`
- `style_profile_preview`
- `characters_preview`
- `outline_preview`
- `foreshadow_preview`
- `guided_step_validation_report`

### 4.3 Act 阶段审批后写入

当前 `guided-session/finalize-step` 直接持久化数据。迁移后必须拆成 Agent 写入 Tool，并声明：

- `allowedModes=['act']`
- `requiresApproval=true`
- `riskLevel='high'` 或至少 `medium`
- `sideEffects` 明确写入哪些业务表

### 4.4 兼容现有创作引导 UI

迁移不要求一次性删除 `GuidedWizard`。首版可以让创作引导页面继续存在，但 AI 动作改为通过 Agent 执行。这样用户仍能按步骤编辑文档，后端能力逐步统一。

## 5. 目标架构

```text
apps/web
  GuidedWizard / DocumentTOC / StructuredPreview
  AgentInputBox / AgentFloatingPanel
  ↓
useAgentRun.createPlan(message, context, attachments)
  ↓
apps/api
  AgentRunsController
  AgentRuntimeService
  AgentContextBuilderService
  AgentPlannerService
  AgentExecutorService
  ToolRegistryService
  ↓
Tools
  read_source_document
  generate_guided_step_preview
  validate_guided_step_preview
  persist_guided_step_result
  generate_outline_preview
  persist_outline
  build_import_preview
  persist_project_assets
```

## 6. AgentContext 扩展

创作引导页面调用 Agent 时，需要传入当前引导上下文：

```ts
context: {
  sourcePage: 'guided_wizard',
  currentProjectId: projectId,
  guided: {
    currentStep: 'guided_setup',
    currentStepLabel: '基础设定',
    currentStepData: {},
    completedSteps: ['guided_setup'],
    documentDraft: {}
  }
}
```

`AgentContextV2.session` 可新增：

```ts
guided?: {
  currentStep?: string;
  currentStepLabel?: string;
  currentStepData?: Record<string, unknown>;
  completedSteps?: string[];
  documentDraft?: Record<string, unknown>;
}
```

创意文档导入则使用 `attachments` 字段，详见 `creative-document-import-agent-design.md`。

## 7. 任务类型设计

新增或明确以下 taskType：

```text
guided_step_consultation
guided_step_generate
guided_step_finalize
guided_project_setup
guided_style_define
guided_character_design
guided_outline_design
guided_volume_split
guided_chapter_outline
guided_foreshadow_design
creative_document_import
```

首版可以先不把每个步骤拆成单独 taskType，而是使用：

```text
guided_step_generate
guided_step_finalize
creative_document_import
```

并通过 `context.session.guided.currentStep` 选择具体 schema 和写入策略。

## 8. Tool 设计

### 8.1 generate_guided_step_preview

只读预览 Tool，替代 `guided-session/generate-step` 的生成部分。

输入：

```ts
{
  stepKey: string;
  userHint?: string;
  projectContext?: Record<string, unknown>;
  chatSummary?: string;
  volumeNo?: number;
  chapterNo?: number;
}
```

输出：

```ts
{
  stepKey: string;
  structuredData: Record<string, unknown>;
  summary: string;
  warnings: string[];
}
```

属性：

```text
allowedModes: ['plan', 'act']
riskLevel: low
requiresApproval: false
sideEffects: []
```

### 8.2 validate_guided_step_preview

只读校验 Tool，检查结构化预览是否可写入。

输入：

```ts
{
  stepKey: string;
  structuredData: Record<string, unknown>;
  volumeNo?: number;
}
```

输出：

```ts
{
  valid: boolean;
  issueCount: number;
  issues: Array<{ severity: 'warning' | 'error'; message: string; path?: string }>;
  writePreview: Record<string, unknown>;
}
```

### 8.3 persist_guided_step_result

审批后写入 Tool，替代 `guided-session/finalize-step` 的写库部分。

输入：

```ts
{
  stepKey: string;
  structuredData: Record<string, unknown>;
  validation?: Record<string, unknown>;
  volumeNo?: number;
}
```

属性：

```text
allowedModes: ['act']
riskLevel: high
requiresApproval: true
sideEffects:
  - update_project_profile
  - create_or_update_characters
  - create_or_update_lorebook
  - create_or_update_volumes
  - create_or_update_planned_chapters
  - create_or_update_foreshadow_tracks
```

首版可以内部复用 `GuidedService.finalizeStep()` 的归一化和写入逻辑，但外部必须经过 Agent approval。

## 9. 分阶段迁移策略

### Phase 0：文档和任务拆解

- 明确 AI 助手能力清单。
- 明确当前 guided 链路和 Agent 链路的边界。
- 拆解可执行任务。

### Phase 1：前端入口统一

- 创作引导页的右侧 AI 助手调用 Agent。
- Agent 请求携带 `guided.currentStep`。
- 保留原 `AiChatPanel` 的视觉位置或逐步替换为 Agent 面板。

### Phase 2：生成能力迁移

- 新增 `generate_guided_step_preview`。
- AI 生成按钮改为创建 Agent Plan。
- Plan 阶段展示结构化预览 Artifact。

### Phase 3：写入能力迁移

- 新增 `validate_guided_step_preview`。
- 新增 `persist_guided_step_result`。
- `finalize-step` 直接写库路径降级为兼容 API，不再作为新入口。

### Phase 4：创意文档导入接入

- 接入「导入创意文档」附件能力。
- 使用 `read_source_document → analyze_source_text → build_import_preview` 链路。
- 作为 Agent 的 `creative_document_import` 场景。

### Phase 5：删除或收缩旧 guided AI 接口

- 前端不再调用 `guided-session/chat`、`generate-step`、`finalize-step`。
- 后端旧接口标记 deprecated。
- 保留非 AI 的引导步骤状态接口，或逐步合并到 Agent/Project API。

## 10. 兼容策略

短期保留：

- `GuidedWizard`
- `DocumentTOC`
- `StructuredPreview`
- 手动编辑表单
- 步骤导航
- `guided-session` 的读取和保存进度能力

逐步迁移：

- AI 聊天问答
- AI 生成
- AI 结构化抽取
- AI 自动保存

最终收敛：

- AI 能力统一走 Agent。
- guided 模块只保留“引导式文档 UI 和状态管理”，不再拥有独立 LLM 编排。

## 11. 风险与应对

| 风险 | 应对 |
|---|---|
| 一次性迁移导致创作引导不可用 | 按步骤迁移，保留旧接口 fallback |
| Agent 计划比原 AI 助手慢 | P0 先复用旧 GuidedService 逻辑，减少重新造轮子 |
| 用户不想看复杂审批 | 对只读问答免审批，对写入显示简洁确认 |
| 结构化 schema 分散 | 先复用 GuidedService 中的 step schema，再抽成共享定义 |
| 旧接口和新 Agent 结果不一致 | 为每个 guided step 增加回归用例 |
| 写入污染项目资料 | 所有 persist Tool 必须审批并输出 writePreview |

## 12. 与「导入创意文档」的关系

「导入创意文档」不是单独孤立功能，而是 AI 助手迁移到 Agent 后的一个重要输入方式。

它解决的是：

```text
用户不想手动粘贴长文案
  ↓
上传 .md/.txt/.docx/.pdf
  ↓
Agent 读取文档正文
  ↓
生成设定、大纲、角色、世界观和伏笔预览
```

因此它的开发文档独立存在，但任务应纳入 AI 助手迁移总计划的 Phase 4。
