# AI 助手能力迁移到 Agent 开发任务清单

> 来源设计文档：`docs/architecture/ai-assistant-to-agent-migration-design.md`  
> 关联专题：`docs/architecture/creative-document-import-agent-development-plan.md`  
> 任务编号前缀：`AAM`，即 AI Assistant Migration  
> 任务状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成

## 1. 任务拆解原则

- 每个任务必须能独立验证。
- 每个任务必须标明文件范围、依赖、验收标准和验证命令。
- 不一次性删除旧 guided 链路。
- 新增写入能力必须通过 Agent Act 和审批。
- UI 迁移和后端能力迁移分开做。

## 2. P0 盘点与上下文打通

### AAM-P0-001 盘点 guided AI 助手现有能力

- 状态：`[x]`
- 模块：Docs
- 文件：`docs/architecture/ai-assistant-to-agent-migration-design.md`
- 任务：把 `useGuidedSession` 中的 `startSession/sendMessage/generateStepData/confirmGeneratedData/finalizeCurrentStep/goToNextStep` 映射到 Agent 能力。
- 依赖：无
- 验收：
  - 文档中每个 guided AI 能力都有迁移目标。
  - 区分只读能力和写入能力。
- 验证：人工审阅
- 完成记录：
  - 完成内容：新增 `useGuidedSession` 方法级迁移映射，覆盖会话初始化、问答、生成预览、确认保存、步骤完成、前后步骤导航和进度保存，并明确只读、写入、UI/进度状态能力边界。
  - 修改文件：`docs/architecture/ai-assistant-to-agent-migration-design.md`、`docs/architecture/ai-assistant-to-agent-migration-development-plan.md`
  - 测试命令：人工审阅
  - 测试结果：通过

### AAM-P0-002 定义 Guided Agent 上下文类型

- 状态：`[x]`
- 模块：API/Web
- 文件：`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`、`apps/web/hooks/useAgentRun.ts`
- 任务：定义 `guided.currentStep/currentStepLabel/currentStepData/completedSteps/documentDraft` 上下文结构。
- 依赖：AAM-P0-001
- 验收：
  - 前端可以在创建 Agent Plan 时传 `context.guided`。
  - 后端 `AgentContextV2.session.guided` 可读取该结构。
  - 旧 Agent 调用不受影响。
- 验证：`pnpm --filter api build`、`pnpm --filter web build`
- 完成记录：
  - 完成内容：新增前端 `GuidedAgentPageContext` 和后端 `GuidedAgentContext`，允许 `createPlan` 传入 `context.guided`，并由 `AgentContextBuilderService` 安全归一化到 `AgentContextV2.session.guided`。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`、`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/web/hooks/useAgentRun.ts`、`docs/architecture/ai-assistant-to-agent-migration-development-plan.md`
  - 测试命令：`pnpm --filter api build`、`pnpm --filter web build`
  - 测试结果：通过

### AAM-P0-003 创作引导页创建 Agent Plan 时传 guided context

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/guided/GuidedWizard.tsx`、`apps/web/hooks/useGuidedSession.ts` 或接入 `useAgentRun`
- 任务：在创作引导页调用 Agent 时传入当前 step、step label、项目 ID 和已有 stepData。
- 依赖：AAM-P0-002
- 验收：
  - Agent Planner 能看到当前是 `guided_setup/guided_style/...`。
  - 当前步骤标签能进入 Agent 计划理解。
  - 不影响原有手动编辑和步骤导航。
- 验证：`pnpm --filter web build`

### AAM-P0-004 Agent Planner 增加 guided 场景识别

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-skills/builtin-skills.ts`
- 任务：新增或扩展 `guided_step_generate/guided_step_consultation/guided_step_finalize` 任务类型说明。
- 依赖：AAM-P0-002
- 验收：
  - 有 `context.session.guided.currentStep` 时，Planner 不误判为普通章节写作。
  - 用户问当前步骤问题时可生成只读咨询计划。
  - 用户要求生成当前步骤时可生成预览计划。
- 验证：`pnpm --filter api test:agent`

## 3. P1 前端入口迁移

### AAM-P1-001 抽象 AI 助手发送接口

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`
- 任务：把当前 `sendMessage` 对 `guided-session/chat` 的直接调用抽象成可切换实现。
- 依赖：AAM-P0-003
- 验收：
  - 默认仍可走旧 guided chat。
  - 可通过配置或参数切换为 Agent createPlan。
  - UI 行为不变。
- 验证：`pnpm --filter web build`

### AAM-P1-002 AI 助手问答接入 Agent consultation

- 状态：`[ ]`
- 模块：Web/API
- 文件：`apps/web/hooks/useGuidedSession.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`
- 任务：当用户在 AI 助手中提问当前步骤时，创建 `guided_step_consultation` AgentRun。
- 依赖：AAM-P1-001、AAM-P0-004
- 验收：
  - 用户问“这个步骤该怎么填？”时不写库。
  - Agent 返回当前步骤建议 Artifact 或聊天回复。
  - AgentRun 历史可追踪该问答。
- 验证：`pnpm --filter api test:agent`、`pnpm --filter web build`

### AAM-P1-003 右侧 AI 助手面板显示 Agent 状态

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/guided/AiChatPanel.tsx`
- 任务：让右侧面板能显示 Agent loading、计划生成、失败和结果摘要。
- 依赖：AAM-P1-002
- 验收：
  - 用户能看到“正在生成计划/预览”。
  - 失败时显示用户可读错误。
  - 不暴露内部 Tool 参数作为主信息。
- 验证：`pnpm --filter web build`

### AAM-P1-004 新增 guided AgentRun 历史入口

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/guided/GuidedWizard.tsx` 或 Agent 浮动面板
- 任务：在创作引导页能查看当前项目相关 AgentRun 历史。
- 依赖：AAM-P1-002
- 验收：
  - 能查看最近 AI 助手问答/生成记录。
  - 点击历史能打开对应 Agent 详情或 Artifact。
- 验证：`pnpm --filter web build`

## 4. P2 生成能力迁移

### AAM-P2-001 抽取 guided step schema

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/guided/guided.service.ts` 或新增 `apps/api/src/modules/guided/guided-step-schemas.ts`
- 任务：把 `guided_setup/guided_style/guided_characters/guided_outline/guided_volume/guided_chapter/guided_foreshadow` 的输出 schema 抽成可复用定义。
- 依赖：AAM-P0-001
- 验收：
  - GuidedService 和 Agent Tool 可共享 schema。
  - 不改变当前 guided 生成结果格式。
- 验证：`pnpm --filter api build`

### AAM-P2-002 新增 generate_guided_step_preview Tool

- 状态：`[ ]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-guided-step-preview.tool.ts`
- 任务：实现只读 Tool，根据 stepKey、项目上下文、用户提示和聊天摘要生成结构化步骤预览。
- 依赖：AAM-P2-001
- 验收：
  - 支持至少 `guided_setup` 和 `guided_style`。
  - 输出 `stepKey/structuredData/summary/warnings`。
  - 无写库副作用。
- 验证：`pnpm --filter api test:agent`

### AAM-P2-003 注册 generate_guided_step_preview Tool

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`
- 任务：加入 provider 和 ToolRegistry。
- 依赖：AAM-P2-002
- 验收：
  - Planner Available Tools 中能看到 `generate_guided_step_preview`。
  - Manifest 说明每个 guided step 的使用方式。
- 验证：`pnpm --filter api build`

### AAM-P2-004 AI 生成按钮改走 Agent Plan

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`、相关 guided step 组件
- 任务：将当前 `generateStepData` 调用替换或可切换为 Agent `guided_step_generate` Plan。
- 依赖：AAM-P2-003
- 验收：
  - 点击 AI 生成后生成 AgentRun。
  - Plan 阶段返回结构化预览。
  - 预览不自动写入业务表。
- 验证：`pnpm --filter web build`

### AAM-P2-005 Agent Artifact 展示 guided step preview

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentArtifactPanel.tsx`
- 任务：新增 `guided_step_preview` Artifact 展示。
- 依赖：AAM-P2-002
- 验收：
  - 基础设定、风格定义等预览能以用户可读方式展示。
  - JSON 兜底仍可查看。
- 验证：`pnpm --filter web build`

### AAM-P2-006 扩展 generate_guided_step_preview 到全部步骤

- 状态：`[ ]`
- 模块：API
- 文件：`generate-guided-step-preview.tool.ts`
- 任务：支持 `guided_characters/guided_outline/guided_volume/guided_chapter/guided_foreshadow`。
- 依赖：AAM-P2-002
- 验收：
  - 每个 stepKey 都有 schema、提示和输出归一化。
  - 缺少前置上下文时返回 warnings 或 missingInfo。
- 验证：`pnpm --filter api test:agent`

## 5. P3 写入能力迁移

### AAM-P3-001 新增 validate_guided_step_preview Tool

- 状态：`[ ]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/validate-guided-step-preview.tool.ts`
- 任务：检查 guided step 预览是否可写入，并生成写入前 diff。
- 依赖：AAM-P2-006
- 验收：
  - 输出 `valid/issueCount/issues/writePreview`。
  - 能识别缺字段、重复卷号、重复章节号、角色缺名称等问题。
  - 无写库副作用。
- 验证：`pnpm --filter api test:agent`

### AAM-P3-002 新增 persist_guided_step_result Tool

- 状态：`[ ]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/persist-guided-step-result.tool.ts`
- 任务：审批后写入 guided step 结构化结果。
- 依赖：AAM-P3-001
- 验收：
  - `allowedModes=['act']`。
  - `requiresApproval=true`。
  - `riskLevel='high'`。
  - 写入前检查 validation 或执行内部兜底校验。
  - 可复用 `GuidedService.finalizeStep` 的归一化逻辑，但入口必须是 Agent Tool。
- 验证：`pnpm --filter api test:agent`

### AAM-P3-003 注册 validate/persist guided Tools

- 状态：`[ ]`
- 模块：API
- 文件：`agent-tools.module.ts`、`tool-registry.service.ts`
- 任务：注册 `validate_guided_step_preview` 和 `persist_guided_step_result`。
- 依赖：AAM-P3-001、AAM-P3-002
- 验收：
  - Planner 能看到校验和持久化工具。
  - `persist_guided_step_result` 在 Plan previewOnly 中不会执行。
- 验证：`pnpm --filter api build`

### AAM-P3-004 confirmGeneratedData 改走 Agent Act

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`
- 任务：将确认保存动作改为审批并执行对应 AgentRun，而不是直接调用 `guided-session/finalize-step`。
- 依赖：AAM-P3-003
- 验收：
  - 用户确认前不写库。
  - 用户确认后执行 Agent Act。
  - 成功后刷新 guided session/project 数据。
- 验证：`pnpm --filter web build`

### AAM-P3-005 标记旧 finalize-step 为兼容路径

- 状态：`[ ]`
- 模块：API/Docs
- 文件：`apps/api/src/modules/guided/guided.controller.ts`、迁移文档
- 任务：标记 `guided-session/finalize-step` 为兼容接口，新功能不再直接调用。
- 依赖：AAM-P3-004
- 验收：
  - 文档说明新写入入口是 Agent Tool。
  - 旧接口保留，避免破坏未迁移页面。
- 验证：`pnpm --filter api build`

## 6. P4 创意文档导入接入

> P4 任务详见 `docs/architecture/creative-document-import-agent-development-plan.md`，本节只保留总计划依赖。

### AAM-P4-001 接入「导入创意文档」入口

- 状态：`[ ]`
- 模块：Web/API
- 文件：见 `CDI-P0-001` 至 `CDI-P0-020`
- 任务：完成创意文档附件上传、读取、预览和审批写入闭环。
- 依赖：AAM-P0-002、AAM-P1-002
- 验收：
  - 在 Agent 输入区能导入 `.md/.txt`。
  - Agent 能生成风格、设定、大纲、角色等预览。
  - 写入仍需审批。
- 验证：见 CDI P0 完成定义

## 7. P5 旧 AI 助手链路收缩

### AAM-P5-001 前端移除 guided-session/chat 新调用

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`
- 任务：所有新 AI 问答入口改走 Agent，旧 chat 仅 fallback。
- 依赖：AAM-P1-002
- 验收：
  - 搜索不到新增代码直接调用 `guided-session/chat`。
  - fallback 有明确注释和开关。
- 验证：`rg "guided-session/chat" apps/web`

### AAM-P5-002 前端移除 guided-session/generate-step 新调用

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`
- 任务：所有新 AI 生成入口改走 Agent，旧 generate-step 仅 fallback。
- 依赖：AAM-P2-004
- 验收：
  - 新 UI 不直接调用 `guided-session/generate-step`。
  - 旧接口保留兼容说明。
- 验证：`rg "guided-session/generate-step" apps/web`

### AAM-P5-003 前端移除 guided-session/finalize-step 新调用

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useGuidedSession.ts`
- 任务：所有新保存入口改走 Agent Act。
- 依赖：AAM-P3-004
- 验收：
  - 新 UI 不直接调用 `guided-session/finalize-step`。
  - 用户确认保存时能看到 Agent 审批计划或简洁确认。
- 验证：`rg "guided-session/finalize-step" apps/web`

### AAM-P5-004 后端旧 guided AI 接口标记 deprecated

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/guided/guided.controller.ts`
- 任务：为 `chat/generate-step/finalize-step` 增加 deprecated 注释和日志标签。
- 依赖：AAM-P5-001、AAM-P5-002、AAM-P5-003
- 验收：
  - 代码注释说明新入口。
  - 日志能区分旧接口调用。
- 验证：`pnpm --filter api build`

## 8. 评测与回归

### AAM-QA-001 增加 guided step Planner Eval

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/test/fixtures/agent-eval-cases.json`
- 任务：增加每类 guided step 的 Planner 用例。
- 依赖：AAM-P2-003
- 验收：
  - 至少覆盖基础设定、风格、角色、大纲、伏笔。
  - 写入类计划必须要求审批。
- 验证：`pnpm --filter api eval:agent`

### AAM-QA-002 增加 guided persist 服务级测试

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-services.spec.ts`
- 任务：覆盖 `persist_guided_step_result` 写入行为。
- 依赖：AAM-P3-002
- 验收：
  - 未审批不会执行。
  - 校验失败不会写入。
  - 审批后按 stepKey 写入正确业务表。
- 验证：`pnpm --filter api test:agent`

### AAM-QA-003 增加前端手工验收清单

- 状态：`[ ]`
- 模块：Docs
- 文件：新增 `docs/architecture/ai-assistant-to-agent-migration-manual-test.md`
- 任务：写清创作引导页 AI 助手迁移的手工验收步骤。
- 依赖：AAM-P1 至 AAM-P3
- 验收：
  - 覆盖问答、AI 生成、确认保存、取消、不支持/缺上下文。
  - 覆盖悬浮 Agent 与创作引导页面协同。
- 验证：人工执行

## 9. 完成定义

当以下条件满足时，可认为 AI 助手能力完成迁移：

1. 创作引导页右侧 AI 助手的问答和生成走 Agent。
2. AI 生成只在 Plan 阶段生成预览，不直接写库。
3. 保存结构化数据必须走 Agent Act 和审批。
4. `guided_setup/guided_style/guided_characters/guided_outline/guided_volume/guided_chapter/guided_foreshadow` 均有 Agent 计划链路。
5. 「导入创意文档」作为 Agent 输入能力接入，能生成设定、大纲和角色预览。
6. 旧 `guided-session/chat/generate-step/finalize-step` 不再作为新功能入口。
7. AgentRun 历史、Artifact、Timeline 能追踪 AI 助手的每次生成和写入。
8. API、Web 构建和 Agent Eval 通过。
