# Agent 导入创意文档开发设计

> 功能名：导入创意文档  
> 目标入口：Agent 输入区  
> 支持文件：`.md`、`.txt`、`.docx`、`.pdf`  
> 明确不做：照片上传、图片识别、任意本地路径读取  
> 外部临时文件服务参考：`https://tmpfile.link/index-zh`  
> 上层迁移方案：`docs/architecture/ai-assistant-to-agent-migration-design.md`

## 1. 背景

用户希望在 Agent 工作台中点击「导入创意文档」，选择一份本地创意文档，例如主线一句话、故事梗概、人物设定草稿或世界观说明。前端先把文件上传到临时文件服务，再把临时文件 URL 和文件元数据随 Agent 请求提交。Agent 根据文档内容生成可审阅的创作资产预览，包括基础设定、风格定义、角色、世界观、故事总纲、卷纲、章节细纲和伏笔建议。

本功能是「AI 助手能力迁移到 Agent」的一项子能力：它解决的是 AI 助手/Agent 如何接收长文档输入，而不是替代整体 AI 助手迁移方案。整体迁移包括右侧 AI 助手聊天、当前步骤问答、AI 生成、结构化保存和创作引导步骤写入，详见上层迁移方案。

当前系统已经具备 Agent Plan/Act、ToolRegistry、`project_import_preview`、`analyze_source_text`、`build_import_preview`、`validate_imported_assets`、`persist_project_assets` 等基础能力。缺口在于：Agent 还不能从用户上传的文档 URL 中稳定读取正文，也没有前端「导入创意文档」附件入口。

## 2. 目标

1. 在 Agent 输入区新增「导入创意文档」按钮，只接受文档文件。
2. 前端上传文件到临时文件服务，拿到下载 URL。
3. Agent 请求携带结构化附件元数据，不把附件塞进普通文本。
4. 后端把附件注入 AgentContext，并提供只读 Tool 读取文档正文。
5. Planner 在有创意文档附件时，优先编排文档导入链路。
6. Plan 阶段只生成预览和校验报告，不写正式业务表。
7. 用户确认后，Act 阶段才写入项目资料、角色、设定、卷和章节规划。

## 3. 非目标

- 不支持图片、照片或 OCR。
- 不让 LLM 直接读取本地磁盘路径。
- 不把临时文件 URL 当成唯一信息源。
- 不绕过 Agent 的 Plan/Act 审批机制。
- 不在首版实现永久文件库、版本化附件管理或用户云盘同步。

## 4. 用户流程

```text
用户点击「导入创意文档」
  ↓
选择 .md / .txt / .docx / .pdf
  ↓
前端上传到临时文件服务
  ↓
拿到临时下载 URL 与文件元数据
  ↓
附件卡片显示在 Agent 输入框上方或下方
  ↓
用户输入：根据这份文档生成设定、大纲和角色
  ↓
POST /api/agent-runs/plan，携带 message + attachments
  ↓
Agent Planner 编排：
  read_source_document
  → analyze_source_text
  → build_import_preview
  → validate_imported_assets
  → persist_project_assets
  → report_result
  ↓
Plan 阶段执行只读步骤，生成预览 Artifact
  ↓
用户确认
  ↓
Act 阶段复用 Plan 预览输出并写入项目
```

## 5. 临时文件服务约定

参考 `tmpfile.link` 中文页说明，匿名上传可使用：

```http
POST https://tmpfile.link/api/upload
Content-Type: multipart/form-data
field: file
```

匿名上传文件默认短期保存，页面说明为 7 天；单文件最大 100MB。返回 JSON 中包含文件名、下载链接、编码下载链接、大小、类型和上传目标等信息。

首版推荐前端直传临时文件服务。如果遇到浏览器 CORS、网络失败或需要隐藏第三方服务细节，再增加后端代理接口。

## 6. 附件数据契约

前端上传成功后，将结果归一化为 Agent 附件对象：

```ts
export interface AgentCreativeDocumentAttachment {
  id: string;
  kind: 'creative_document';
  provider: 'tmpfile.link';
  fileName: string;
  extension: 'md' | 'txt' | 'docx' | 'pdf';
  mimeType?: string;
  size?: number;
  url: string;
  uploadedAt: string;
  expiresAt?: string;
  uploadMeta?: Record<string, unknown>;
}
```

`POST /api/agent-runs/plan` 请求：

```json
{
  "projectId": "project-id",
  "message": "根据导入的创意文档生成风格、设定、大纲和角色。",
  "context": {
    "currentProjectId": "project-id",
    "sourcePage": "agent_floating_panel"
  },
  "attachments": [
    {
      "id": "att_...",
      "kind": "creative_document",
      "provider": "tmpfile.link",
      "fileName": "TOP-01-1. 主线一句话概括.md",
      "extension": "md",
      "mimeType": "text/markdown",
      "size": 12345,
      "url": "https://tmpfile.link/..."
    }
  ]
}
```

## 7. 后端 AgentContext 扩展

`AgentContextV2` 增加附件摘要：

```ts
attachments: Array<{
  id: string;
  kind: 'creative_document';
  fileName: string;
  extension: string;
  mimeType?: string;
  size?: number;
  url: string;
  provider?: string;
}>;
```

`AgentContextBuilderService` 只注入附件元数据，不在 Context 构造阶段下载正文。正文读取通过 Tool 完成，这样每次下载、解析和失败都能进入 AgentStep trace。

## 8. 新增 Tool：read_source_document

### 8.1 作用

`read_source_document` 是只读低风险工具，负责从附件 URL 下载并提取文本，输出给 `analyze_source_text` 和 `build_import_preview` 使用。

### 8.2 输入

```ts
interface ReadSourceDocumentInput {
  attachment?: AgentCreativeDocumentAttachment;
  url?: string;
  fileName?: string;
  extension?: 'md' | 'txt' | 'docx' | 'pdf';
}
```

Planner 优先传完整 attachment：

```json
{
  "attachment": "{{context.attachments.0}}"
}
```

如果 Executor 暂不支持数组下标上下文引用，首版可以让 Planner 显式传：

```json
{
  "url": "{{context.attachments.0.url}}",
  "fileName": "{{context.attachments.0.fileName}}",
  "extension": "{{context.attachments.0.extension}}"
}
```

### 8.3 输出

```ts
interface ReadSourceDocumentOutput {
  sourceText: string;
  title?: string;
  fileName?: string;
  extension: string;
  length: number;
  truncated: boolean;
  excerpt: string;
  sourceUrl: string;
  diagnostics: {
    fetchStatus: 'succeeded' | 'failed';
    parseStatus: 'succeeded' | 'unsupported' | 'failed';
    warnings: string[];
  };
}
```

### 8.4 解析策略

P0：

- `.md`：按 UTF-8 文本读取。
- `.txt`：按 UTF-8 文本读取。
- 最大正文长度先限制为 80,000 字符，超出则截断并写入 `truncated=true`。

P1：

- `.docx`：引入文档解析依赖或服务，提取正文文本。
- `.pdf`：引入 PDF 文本解析依赖或服务，提取正文文本。
- 如果解析失败，输出结构化诊断，让 Agent 要求用户转为 `.md/.txt` 或粘贴正文。

## 9. Planner 编排规则

当 `AgentContext.attachments` 中存在 `kind='creative_document'` 的附件时，Planner 应遵守：

1. 如果用户目标是导入、拆解、生成设定、大纲、角色、风格，优先选择 `project_import_preview`。
2. 第一步必须使用 `read_source_document` 读取附件正文。
3. 第二步使用 `analyze_source_text` 分析 `{{steps.read_source_document.output.sourceText}}`。
4. 第三步使用 `build_import_preview` 生成项目资料、角色、设定、卷和章节预览。
5. 第四步使用 `validate_imported_assets` 生成写入前校验和 diff。
6. 写入类步骤 `persist_project_assets` 必须等待用户审批后执行。

推荐计划：

```text
1. read_source_document
2. analyze_source_text
3. build_import_preview
4. validate_imported_assets
5. persist_project_assets
6. report_result
```

## 10. 前端交互设计

### 10.1 入口

按钮文案固定为：

```text
导入创意文档
```

文件选择限制：

```tsx
<input
  type="file"
  accept=".md,.txt,.docx,.pdf,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
/>
```

### 10.2 附件状态

每个附件显示：

- 文件名
- 文件类型
- 文件大小
- 上传中 / 上传成功 / 上传失败
- 删除按钮

首版限制单次只上传 1 个创意文档，避免 Planner 同时处理多份文档时上下文不明确。后续可扩展多附件。

### 10.3 提交行为

提交 Agent 任务时：

- `message` 保持用户自然语言。
- `attachments` 单独进入请求体。
- `clientRequestId` 指纹必须包含附件 URL 或附件 ID，避免同一 message 换文件时误复用旧请求。
- 提交成功后可以保留附件卡片直到新会话开始，便于用户看到本轮任务来源。

## 11. 安全与隐私

1. 上传按钮旁或错误提示中说明：文件会上传到临时文件服务，链接短期有效。
2. 后端只接受 `https` URL。
3. P0 只允许 `tmpfile.link` 作为 provider。
4. 后端按扩展名和响应大小做限制，拒绝非文档文件。
5. 后端不读取本地路径，也不接受 `file://`。
6. 临时 URL 不作为长期项目资产保存，只保存在 AgentRun.input 与审计上下文中。
7. LLM 可以看到 URL 和摘要，但业务逻辑不能依赖模型自动访问 URL。

## 12. Artifact 展示

Plan 阶段应至少生成：

- `source_document_summary`：文档名、长度、截断状态、开头摘录、解析诊断。
- `project_profile_preview`：标题、类型、主题、基调、一句话概括、简介。
- `characters_preview`：角色列表、动机、背景、关系线索。
- `lorebook_preview`：世界观、地点、组织、规则、能力体系。
- `outline_preview`：卷纲和章节纲预览。
- `import_validation_report`：重复项、缺字段、写入前 diff、风险。

## 13. 验收用例

| 用例 | 输入 | 期望 |
|---|---|---|
| Markdown 创意导入 | 上传 `.md`，输入“根据这份文档生成设定、大纲和角色” | Plan 包含 `read_source_document → analyze_source_text → build_import_preview → validate_imported_assets → persist_project_assets`。 |
| 文本文件导入 | 上传 `.txt`，输入“拆成角色和前三卷大纲” | 生成项目资料、角色、世界观、卷与章节预览，不直接写库。 |
| 未审批 | 生成预览后不点确认 | 不调用 `persist_project_assets`，业务表不变。 |
| 审批执行 | 用户确认计划 | Act 复用预览并写入项目资料、角色、设定、卷和 planned 章节。 |
| 不支持类型 | 上传 `.png` 或 `.zip` | 前端阻止选择或后端拒绝，提示仅支持创意文档。 |
| 同消息换文件 | 两次输入相同 message，但上传不同文档 | 创建不同 AgentRun，不复用旧 clientRequestId。 |

## 14. 分阶段落地

### P0：最小可用闭环

- 前端「导入创意文档」按钮。
- 直传临时文件服务。
- 附件元数据随 Agent 请求传入。
- 后端 Context 注入附件。
- `read_source_document` 支持 `.md/.txt`。
- Planner 能稳定编排文档导入预览链路。
- Plan 阶段展示预览，Act 阶段审批后写入。

### P1：文档类型完善

- 支持 `.docx` 文本提取。
- 支持 `.pdf` 文本提取。
- 长文档分段、摘要和截断策略优化。
- Artifact 展示文档读取诊断。

### P2：生产化增强

- 增加后端上传代理，统一校验、限流和错误处理。
- 多附件支持。
- 附件过期检测与重新上传提示。
- 可选切换临时文件服务 provider。
