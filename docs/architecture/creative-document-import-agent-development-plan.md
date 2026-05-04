# 导入创意文档开发任务清单

> 来源设计文档：`docs/architecture/creative-document-import-agent-design.md`  
> 上层迁移计划：`docs/architecture/ai-assistant-to-agent-migration-development-plan.md`  
> 功能入口：Agent 输入区「导入创意文档」  
> 任务编号前缀：`CDI`，即 Creative Document Import  
> 任务状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成

## 1. 任务拆解原则

- 每个任务必须能独立提交或独立验证。
- 每个任务必须有明确文件范围、验收标准和验证命令。
- P0 只做最小可用闭环，不扩展照片、OCR、多附件和永久文件库。
- 写入行为必须继续走 Agent Plan/Act 审批链路。
- 如果一个任务需要同时改前端和后端，拆成两个任务。
- 本清单只覆盖「导入创意文档」专题；AI 助手聊天、AI 生成和结构化保存迁移见上层 AAM 任务清单。

## 2. P0 最小可用闭环

### CDI-P0-001 定义前端附件类型

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/hooks/useAgentRun.ts` 或新增 `apps/web/types/agent-attachment.ts`
- 任务：新增 `AgentCreativeDocumentAttachment` 类型，字段包含 `id/kind/provider/fileName/extension/mimeType/size/url/uploadedAt/expiresAt/uploadMeta`。
- 依赖：无
- 验收：
  - 类型只允许 `kind='creative_document'`。
  - `extension` 限制为 `md/txt/docx/pdf`。
  - 后续组件可复用该类型，不使用 `unknown` 传递附件。
- 验证：`pnpm --filter web build`
- 完成记录：
  - 完成内容：新增前端创意文档附件类型，集中定义 `kind='creative_document'`、`provider='tmpfile.link'` 和 `md/txt/docx/pdf` 扩展名白名单，供后续上传、输入框和 `createPlan` 附件参数复用。
  - 修改文件：`apps/web/types/agent-attachment.ts`、`docs/architecture/creative-document-import-agent-development-plan.md`
  - 测试命令：`pnpm --filter web build`
  - 测试结果：通过

### CDI-P0-002 实现临时文件上传工具函数

- 状态：`[x]`
- 模块：Web
- 文件：新增 `apps/web/hooks/useCreativeDocumentUpload.ts` 或 `apps/web/lib/uploadCreativeDocument.ts`
- 任务：实现 `uploadCreativeDocument(file)`，使用 `FormData` 将字段 `file` POST 到 `https://tmpfile.link/api/upload`，并归一化为 `AgentCreativeDocumentAttachment`。
- 依赖：CDI-P0-001
- 验收：
  - 上传成功返回标准附件对象。
  - 上传失败抛出用户可读错误。
  - 只接受 `.md/.txt/.docx/.pdf`。
  - 单文件大小先限制为前端 20MB。
- 验证：`pnpm --filter web build`
- 完成记录：
  - 完成内容：新增 `uploadCreativeDocument(file)` 工具函数，前端校验文档扩展名和 20MB 大小限制，使用 `FormData` 直传 `tmpfile.link`，并将上传响应归一化为标准 `AgentCreativeDocumentAttachment`；上传失败、无下载链接和非 HTTPS 链接会抛出用户可读错误。
  - 修改文件：`apps/web/lib/uploadCreativeDocument.ts`、`docs/architecture/creative-document-import-agent-development-plan.md`
  - 测试命令：`pnpm --filter web build`
  - 测试结果：通过

### CDI-P0-003 在 AgentInputBox 增加「导入创意文档」入口

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentInputBox.tsx`
- 任务：增加文件选择按钮，按钮文案为「导入创意文档」，文件 input 使用文档 accept 白名单。
- 依赖：CDI-P0-001
- 验收：
  - UI 不出现“照片”“图片”文案。
  - 不允许选择图片类型。
  - 按钮在 loading 时禁用。
  - 保留 Enter 发送体验。
- 验证：`pnpm --filter web build`
- 完成记录：
  - 完成内容：在 Agent 输入框底部操作区新增「导入创意文档」按钮和隐藏文件 input，`accept` 复用文档白名单，仅允许 `.md/.txt/.docx/.pdf` 及对应 MIME 类型；按钮在 loading 时禁用，且保持原 Enter 发送与 Shift+Enter 换行行为不变。
  - 修改文件：`apps/web/components/agent/AgentInputBox.tsx`、`docs/architecture/creative-document-import-agent-development-plan.md`
  - 测试命令：`pnpm --filter web build`
  - 测试结果：通过

### CDI-P0-004 渲染附件卡片和删除操作

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentInputBox.tsx`、`apps/web/app/globals.css`
- 任务：在输入框附近显示附件卡片，包含文件名、类型、大小、上传状态和删除按钮。
- 依赖：CDI-P0-003
- 验收：
  - 上传中、成功、失败三种状态可见。
  - 用户可以删除已选附件。
  - 长文件名不会撑破布局。
  - 悬浮面板和全屏工作台内样式都正常。
- 验证：`pnpm --filter web build`
- 完成记录：
  - 完成内容：为 `AgentInputBox` 增加创意文档附件展示 props、删除回调和上传中/上传成功/上传失败三种状态卡片；卡片展示文件名、扩展名、大小、状态和失败原因，长文件名使用省略显示，删除按钮提供可访问标签，样式复用同一组件以覆盖悬浮面板和全屏工作台。
  - 修改文件：`apps/web/components/agent/AgentInputBox.tsx`、`apps/web/app/globals.css`、`docs/architecture/creative-document-import-agent-development-plan.md`
  - 测试命令：`pnpm --filter web build`
  - 测试结果：通过

### CDI-P0-005 将附件状态接入 AgentFloatingPanel

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentFloatingPanel.tsx`
- 任务：在悬浮 Agent 面板中维护附件状态，传给 `AgentInputBox`，提交时传给 `createPlan`。
- 依赖：CDI-P0-004
- 验收：
  - 上传成功后附件随 Agent 请求提交。
  - 新会话会清空附件。
  - 提交后聊天历史能提示“已导入创意文档：文件名”。
- 验证：`pnpm --filter web build`

### CDI-P0-006 将附件状态接入 AgentWorkspace

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentWorkspace.tsx`
- 任务：全屏 Agent 工作台复用同一附件能力。
- 依赖：CDI-P0-004
- 验收：
  - 全屏入口和悬浮入口行为一致。
  - 新会话清空附件。
  - 重新规划不隐式复用已删除附件。
- 验证：`pnpm --filter web build`

### CDI-P0-007 扩展 useAgentRun.createPlan 支持 attachments

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/hooks/useAgentRun.ts`
- 任务：给 `createPlan(projectId, message, pageContext, attachments?)` 或等价参数结构增加附件传递。
- 依赖：CDI-P0-001
- 验收：
  - 请求体包含 `attachments` 数组。
  - `clientRequestId` 指纹包含附件 ID 或 URL，避免同一 message 换文件时复用旧请求。
  - 旧调用点不传附件时保持兼容。
- 验证：`pnpm --filter web build`
- 完成记录：
  - 完成内容：为 `useAgentRun.createPlan` 增加可选 `attachments` 参数，计划请求体顶层携带附件数组；前端幂等指纹和 `clientRequestId` 哈希纳入附件 ID/URL，避免相同 message 更换文件时复用旧请求，同时保持旧调用点不传附件时兼容。
  - 修改文件：`apps/web/hooks/useAgentRun.ts`、`docs/architecture/creative-document-import-agent-development-plan.md`
  - 测试命令：`pnpm --filter web build`
  - 测试结果：通过

### CDI-P0-008 定义后端附件 DTO 和归一化函数

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/api/src/modules/agent-runs/agent-runs.service.ts`
- 任务：将 `attachments?: unknown[]` 收敛为受控结构，校验 `kind/provider/url/extension/fileName/size`。
- 依赖：CDI-P0-001
- 验收：
  - 只接受 `kind='creative_document'`。
  - 只接受 `https` URL。
  - P0 只接受 provider `tmpfile.link`。
  - 非法附件返回 400，不创建 AgentRun。
- 验证：`pnpm --filter api build`

### CDI-P0-009 AgentContextV2 注入附件摘要

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`
- 任务：从 `AgentRun.input.attachments` 读取已归一化附件，写入 `AgentContextV2.attachments`。
- 依赖：CDI-P0-008
- 验收：
  - Planner 输入中可以看到附件文件名、扩展名、URL、大小和 provider。
  - `compactContextSnapshot` 保留附件摘要。
  - 不在 Context 构造阶段下载文件。
- 验证：`pnpm --filter api build`

### CDI-P0-010 新增 read_source_document Tool

- 状态：`[ ]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts`
- 任务：实现只读工具，从附件 URL 下载 `.md/.txt` 并提取正文。
- 依赖：CDI-P0-008、CDI-P0-009
- 验收：
  - `allowedModes=['plan','act']`。
  - `riskLevel='low'`，`requiresApproval=false`，`sideEffects=[]`。
  - 拒绝非 `https` URL。
  - 拒绝非白名单扩展。
  - 正文超过 80,000 字符时截断并返回 `truncated=true`。
  - 输出 `sourceText/length/excerpt/sourceUrl/diagnostics`。
- 验证：`pnpm --filter api build`

### CDI-P0-011 注册 read_source_document Tool

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`
- 任务：把 `ReadSourceDocumentTool` 加入 Nest provider 和 ToolRegistry。
- 依赖：CDI-P0-010
- 验收：
  - `ToolRegistryService.list()` 包含 `read_source_document`。
  - Planner 的 Available Tools 中能看到该工具。
- 验证：`pnpm --filter api build`

### CDI-P0-012 为 read_source_document 补充 Manifest

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts`
- 任务：补充 `manifest.whenToUse/whenNotToUse/parameterHints/examples/failureHints`。
- 依赖：CDI-P0-011
- 验收：
  - Manifest 明确“有 creative_document 附件且需要拆解/导入时使用”。
  - Manifest 明确“不用于图片、照片、OCR、本地路径”。
  - 参数说明要求从 `context.attachments` 获取 URL。
- 验证：`pnpm --filter api build`

### CDI-P0-013 更新 Planner 文档导入规则

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`
- 任务：在 Planner prompt 和 taskType guidance 中加入创意文档附件规则。
- 依赖：CDI-P0-009、CDI-P0-012
- 验收：
  - 有 `creative_document` 附件且用户要求生成设定/大纲/角色时，计划先调用 `read_source_document`。
  - 后续步骤使用 `analyze_source_text`、`build_import_preview`、`validate_imported_assets`。
  - `persist_project_assets` 仍要求审批。
- 验证：`pnpm --filter api test:agent`

### CDI-P0-014 支持 context 数组下标引用

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-executor.service.ts`
- 任务：确认或增强 `{{context.attachments.0.url}}` 这类路径读取能力。
- 依赖：CDI-P0-009
- 验收：
  - `resolveValue` 能读取 `attachments.0.url`、`attachments.0.fileName`、`attachments.0.extension`。
  - 引用不存在时输出可诊断错误，不静默传 undefined 给 Tool。
- 验证：`pnpm --filter api test:agent`

### CDI-P0-015 增加文档导入 Artifact 提升

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-runtime.service.ts`
- 任务：Plan/Act 产物中增加 `source_document_summary` Artifact。
- 依赖：CDI-P0-010
- 验收：
  - Artifact 显示文件名、长度、截断状态、解析诊断和摘录。
  - 现有 `project_profile_preview/characters_preview/lorebook_preview/outline_preview/import_validation_report` 不受影响。
- 验证：`pnpm --filter api build`

### CDI-P0-016 前端 Artifact 面板展示文档摘要

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentArtifactPanel.tsx`
- 任务：为 `source_document_summary` 增加可读展示。
- 依赖：CDI-P0-015
- 验收：
  - 用户能看到 Agent 读取的是哪份文档。
  - 截断和解析警告明确展示。
  - 技术 JSON 仍可在通用视图兜底查看。
- 验证：`pnpm --filter web build`

### CDI-P0-017 增加 Planner Eval 用例

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/test/fixtures/agent-eval-cases.json`
- 任务：新增至少 2 个创意文档导入用例。
- 依赖：CDI-P0-013
- 验收：
  - 用例 1：上传 `.md`，要求生成设定、大纲和角色，必须使用 `read_source_document`。
  - 用例 2：无附件但要求“根据文档生成”，应进入 missingInfo 或要求用户上传。
  - Eval 不允许写入工具免审批。
- 验证：`pnpm --filter api eval:agent`

### CDI-P0-018 增加服务级测试覆盖 read_source_document

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-services.spec.ts`
- 任务：测试 Tool 的 URL 校验、扩展名校验、文本截断和正常输出。
- 依赖：CDI-P0-010
- 验收：
  - 非 https URL 被拒绝。
  - 非白名单扩展被拒绝。
  - `.md/.txt` 正常返回正文。
  - 超长正文设置 `truncated=true`。
- 验证：`pnpm --filter api test:agent`

### CDI-P0-019 端到端手工验收脚本

- 状态：`[ ]`
- 模块：Docs/Test
- 文件：新增 `docs/architecture/creative-document-import-manual-test.md` 或更新本任务文档
- 任务：写清本地手工验收步骤。
- 依赖：CDI-P0-002 至 CDI-P0-016
- 验收：
  - 包含准备 `.md` 文件、上传、提交、查看计划、确认执行、检查写入结果步骤。
  - 包含失败用例：上传图片、上传超大文件、删除附件后提交。
- 验证：人工按文档跑通

### CDI-P0-020 P0 集成验证

- 状态：`[ ]`
- 模块：All
- 文件：无固定文件
- 任务：运行 P0 所有构建和测试。
- 依赖：CDI-P0-001 至 CDI-P0-019
- 验收：
  - `pnpm --filter web build` 通过。
  - `pnpm --filter api build` 通过。
  - `pnpm --filter api test:agent` 通过。
  - `pnpm --filter api eval:agent` 通过。
  - 手工上传 `.md` 能生成导入预览。

## 3. P1 文档类型完善

### CDI-P1-001 选型 docx 文本解析方案

- 状态：`[ ]`
- 模块：API
- 文件：`docs/architecture/creative-document-import-agent-design.md`
- 任务：确定 `.docx` 解析依赖或服务方案。
- 依赖：CDI-P0-010
- 验收：
  - 记录依赖名称、许可证、包大小、维护状态。
  - 记录失败降级策略。
- 验证：文档更新

### CDI-P1-002 实现 docx 文本解析

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts`、`apps/api/package.json`
- 任务：为 `.docx` 提取正文文本。
- 依赖：CDI-P1-001
- 验收：
  - 正常 `.docx` 返回正文。
  - 空文档返回可诊断错误。
  - 解析失败不导致进程崩溃。
- 验证：`pnpm --filter api test:agent`

### CDI-P1-003 选型 pdf 文本解析方案

- 状态：`[ ]`
- 模块：API
- 文件：`docs/architecture/creative-document-import-agent-design.md`
- 任务：确定 `.pdf` 解析依赖或服务方案。
- 依赖：CDI-P0-010
- 验收：
  - 记录文本型 PDF 与扫描型 PDF 的边界。
  - 明确不做 OCR。
  - 记录失败降级策略。
- 验证：文档更新

### CDI-P1-004 实现 pdf 文本解析

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts`、`apps/api/package.json`
- 任务：为文本型 `.pdf` 提取正文文本。
- 依赖：CDI-P1-003
- 验收：
  - 文本型 PDF 返回正文。
  - 扫描型 PDF 返回“无法提取文本”的诊断。
  - 不引入 OCR。
- 验证：`pnpm --filter api test:agent`

### CDI-P1-005 长文档分段和摘要策略

- 状态：`[ ]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts` 或新增 summarizer Tool
- 任务：对超过 80,000 字符的文档提供分段摘要或结构化摘录，避免只截断前文。
- 依赖：CDI-P0-010
- 验收：
  - 输出包含 `sections` 或 `summary`。
  - `build_import_preview` 能使用摘要和正文摘录。
  - Artifact 明确显示“使用了长文档摘要”。
- 验证：`pnpm --filter api test:agent`

### CDI-P1-006 增加 docx/pdf 前端上传提示

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentInputBox.tsx`
- 任务：在上传失败或解析失败时提示用户可转为 `.md/.txt`。
- 依赖：CDI-P1-002、CDI-P1-004
- 验收：
  - 用户能区分“上传失败”和“解析失败”。
  - 扫描型 PDF 提示不支持 OCR。
- 验证：`pnpm --filter web build`

## 4. P2 生产化增强

### CDI-P2-001 设计后端上传代理 API

- 状态：`[ ]`
- 模块：API/Docs
- 文件：`docs/architecture/creative-document-import-agent-design.md`
- 任务：设计 `POST /api/temp-files/creative-document`，由后端校验后上传到临时文件服务。
- 依赖：CDI-P0-002
- 验收：
  - 设计包含鉴权、大小限制、类型限制、错误码和返回结构。
  - 明确是否替代前端直传。
- 验证：文档更新

### CDI-P2-002 实现后端上传代理

- 状态：`[ ]`
- 模块：API
- 文件：新增 temp-files module
- 任务：实现后端代理上传，并返回标准附件对象。
- 依赖：CDI-P2-001
- 验收：
  - 后端拒绝非文档文件。
  - 后端限制大小。
  - 上传失败返回用户可读错误。
- 验证：`pnpm --filter api build`

### CDI-P2-003 前端切换为后端上传代理

- 状态：`[ ]`
- 模块：Web
- 文件：`apps/web/hooks/useCreativeDocumentUpload.ts`
- 任务：上传目标从 `tmpfile.link` 直传改为后端代理，保留直传作为可选 fallback 或删除直传逻辑。
- 依赖：CDI-P2-002
- 验收：
  - 前端不直接依赖第三方响应结构。
  - 错误提示由后端统一返回。
- 验证：`pnpm --filter web build`

### CDI-P2-004 多附件支持

- 状态：`[ ]`
- 模块：Web/API
- 文件：`AgentInputBox.tsx`、`AgentPlannerService`、`read-source-document.tool.ts`
- 任务：支持最多 3 个创意文档附件，并让 Planner 逐个读取或先合并摘要。
- 依赖：CDI-P0 全部
- 验收：
  - 超过数量前端阻止。
  - Planner 不会忽略第二、第三个附件。
  - Artifact 能按文件展示摘要。
- 验证：`pnpm --filter api test:agent`、`pnpm --filter web build`

### CDI-P2-005 附件过期提示

- 状态：`[ ]`
- 模块：Web/API
- 文件：`AgentInputBox.tsx`、`read-source-document.tool.ts`
- 任务：识别临时 URL 过期或下载 404，并提示重新上传。
- 依赖：CDI-P0-010
- 验收：
  - Tool 下载 404 返回结构化 observation。
  - 前端显示“文件链接已过期，请重新导入创意文档”。
- 验证：`pnpm --filter api test:agent`

## 5. 追踪看板建议

建议按以下字段同步到 issue、看板或项目管理工具：

| 字段 | 示例 |
|---|---|
| ID | `CDI-P0-010` |
| 标题 | 新增 read_source_document Tool |
| 状态 | 未开始 / 进行中 / 已完成 / 阻塞 |
| 模块 | API |
| 依赖 | `CDI-P0-008`, `CDI-P0-009` |
| 文件范围 | `apps/api/src/modules/agent-tools/tools/read-source-document.tool.ts` |
| 验收标准 | 输出 sourceText，拒绝非 https URL |
| 验证命令 | `pnpm --filter api test:agent` |

## 6. P0 完成定义

P0 全部完成后，必须满足：

1. 用户可以在 Agent 输入区点击「导入创意文档」。
2. 用户可以选择 `.md` 或 `.txt` 文件并上传到临时文件服务。
3. 附件元数据会随 Agent Plan 请求提交。
4. Planner 会编排 `read_source_document → analyze_source_text → build_import_preview → validate_imported_assets → persist_project_assets`。
5. Plan 阶段会生成创作资产预览，不写库。
6. 用户审批后，Act 阶段写入项目资料、角色、设定、卷和 planned 章节。
7. 上传图片或非文档文件会被阻止。
8. 同一 message 更换附件不会复用旧 AgentRun。
9. API、Web 构建和 Agent 测试全部通过。
