# 按目标产物拆分导入生成 Tool 开发任务清单

> 来源设计文档：`docs/architecture/targeted-import-preview-tools-design.md`
> 功能入口：Agent 输入区目标产物选择器
> 任务编号前缀：`TIP`，即 Targeted Import Preview
> 任务状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成
> 最后更新：2026-05-06

## 1. 已具备基础

- 前端已有目标产物选择器，能在自然语言中表达“只生成这些目标产物”。
- `build_import_preview` 已支持 `requestedAssetTypes` 并按范围过滤输出。
- `validate_imported_assets` 已支持写作规则和目标产物范围。
- `persist_project_assets` 已支持写作规则写入，并按 `requestedAssetTypes` 阻止未选择资产写入。
- Planner 已有导入计划补齐 `persist_project_assets` 的后端保护。
- 写入确认 UI 已能根据 Plan 展示写入步骤和目标产物范围。

本任务清单从“高质量分目标生成”开始，不重复已经完成的导入附件基础能力。

## 2. 开发原则

- 每个目标产物 Tool 必须只读，不写库。
- 用户选择几个目标产物，就只编排几个目标产物 Tool。
- 目标产物选择必须变成结构化上下文，不能只依赖 prompt 拼接。
- 新链路必须输出现有 `ImportPreviewOutput`，复用校验和写入。
- `build_import_preview` 保留为 fallback，不删除。
- 所有写入仍统一走 `persist_project_assets` 和写入确认。

## 3. P0 结构化目标产物和合并链路

### TIP-P0-001 前端提交结构化 requestedAssetTypes

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentInputBox.tsx`、`apps/web/components/agent/AgentFloatingPanel.tsx`、`apps/web/components/agent/AgentWorkspace.tsx`、`apps/web/hooks/useAgentRun.ts`
- 任务：把目标产物选择从纯文本提示升级为结构化请求字段。
- 验收：
  - `selectedTargetIds` 随 `createPlan` 提交。
  - 请求体 `context.requestedAssetTypes` 包含用户选择。
  - 自然语言提示仍保留，作为 LLM 可读说明。
  - 未选择目标产物时不传该字段，由后端按自然语言兜底推断。
- 验证：`pnpm --dir apps/web run build`
- 完成记录：
  - 2026-05-06：`AgentInputBox` 在提交时把已选择目标产物作为 `requestedAssetTypes` 传给父组件；`AgentFloatingPanel` 和 `AgentWorkspace` 将其并入 `pageContext`；`useAgentRun.createPlan` 过滤合法目标产物并写入请求体 `context.requestedAssetTypes`，未选择时不传，同时把目标产物纳入请求指纹和幂等键。
  - 修改文件：`apps/web/components/agent/AgentInputBox.tsx`、`apps/web/components/agent/AgentFloatingPanel.tsx`、`apps/web/components/agent/AgentWorkspace.tsx`、`apps/web/hooks/useAgentRun.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/web run build` 首次因已有 Next dev server 占用 `.next/trace` 返回 EPERM；停止相关 `next dev -p 3000` 进程后重跑通过。

### TIP-P0-002 后端 DTO 和 Context 接收 requestedAssetTypes

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`
- 任务：校验并注入结构化目标产物范围。
- 验收：
  - 只接受 `projectProfile/outline/characters/worldbuilding/writingRules`。
  - 非法值返回 400 或在归一化时丢弃并记录诊断。
  - Planner 输入能读取 `context.session.requestedAssetTypes` 或等价字段。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：`CreateAgentPlanContextDto` 增加 `requestedAssetTypes` 类型；`AgentRunsService.createPlan` 对请求上下文中的目标产物做枚举校验、去重和空数组省略，非法值返回 400；`AgentContextBuilderService` 将目标产物范围注入 `context.session.requestedAssetTypes`，并对历史脏值做防御性过滤。
  - 修改文件：`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/api/src/modules/agent-runs/agent-runs.service.ts`、`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，154 项测试通过。

### TIP-P0-003 抽离 ImportPreview 类型和过滤工具

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/import-preview.types.ts`
- 任务：把 `ImportAssetType`、`ImportPreviewOutput`、`normalizeImportAssetTypes`、`filterImportPreviewByAssetTypes` 从 `build-import-preview.tool.ts` 抽离。
- 验收：
  - `build_import_preview`、`validate_imported_assets`、`persist_project_assets` 都从新文件引用类型和过滤函数。
  - 没有循环依赖。
  - 现有测试不需要大规模改写。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `import-preview.types.ts`，集中导出 `ImportAssetType`、`IMPORT_ASSET_TYPES`、`ImportPreviewOutput`、`normalizeImportAssetTypes` 和 `filterImportPreviewByAssetTypes`；`build_import_preview`、`validate_imported_assets`、`persist_project_assets` 改为从该文件引用共享类型与过滤函数。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/import-preview.types.ts`、`apps/api/src/modules/agent-tools/tools/build-import-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/validate-imported-assets.tool.ts`、`apps/api/src/modules/agent-tools/tools/persist-project-assets.tool.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，154 项测试通过。

### TIP-P0-004 新增 merge_import_previews Tool

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/merge-import-previews.tool.ts`
- 任务：把多个目标产物预览合并为统一 `ImportPreviewOutput`。
- 验收：
  - `allowedModes=['plan','act']`。
  - `requiresApproval=false`，`sideEffects=[]`。
  - 未选择目标产物输出为空。
  - 角色、世界设定、写作规则同名去重并返回 risks。
  - 大纲只合并 `projectProfile.outline`、`volumes`、`chapters`。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `MergeImportPreviewsTool`，按显式 `requestedAssetTypes` 合并目标预览；未选择目标产物时返回空 `ImportPreviewOutput`；大纲只写 `projectProfile.outline`、`volumes`、`chapters`；角色、世界设定、写作规则按名称/标题去重并写入风险；Tool 元数据为 plan/act 只读、低风险、无需审批、无副作用。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/merge-import-previews.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，158 项测试通过。

### TIP-P0-005 注册 merge_import_previews Tool 和 Manifest

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`merge-import-previews.tool.ts`
- 任务：注册 Tool 并补齐 Planner 可读 Manifest。
- 验收：
  - `ToolRegistryService.list()` 包含 `merge_import_previews`。
  - Manifest 说明它只做合并，不生成、不写库。
  - Planner examples 展示两个目标产物合并的用法。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：将 `MergeImportPreviewsTool` 注册进 `AgentToolsModule` 和 `ToolRegistryService`；补充 Manifest 参数提示和双目标合并示例，明确该 Tool 只合并、不生成、不写库；测试覆盖 manifest 声明和 AppModule 注入后的 registry 查询。
  - 修改文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`apps/api/src/modules/agent-tools/tools/merge-import-previews.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，159 项测试通过。

### TIP-P0-006 Planner 支持分目标链路骨架

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`（实现时同步更新 `agent-runtime.service.ts`，原因见完成记录）
- 任务：更新 Planner prompt 和规范化规则，使其能按 `requestedAssetTypes` 编排目标产物 Tool。
- 验收：
  - 只选 `outline` 时，不生成 characters/worldbuilding/writingRules 相关 Tool。
  - 多目标时，生成对应目标 Tool 后调用 `merge_import_previews`。
  - 合并结果进入 `validate_imported_assets`。
  - `persist_project_assets` 仍为需审批步骤。
  - 专用 Tool 未注册时 fallback 到 `build_import_preview`。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：更新 Planner prompt，明确 `context.session.requestedAssetTypes` 是结构化目标产物范围；导入计划优先走 `read_source_document`、`analyze_source_text`、已注册分目标 preview Tool、`merge_import_previews`、`validate_imported_assets`、需审批 `persist_project_assets`，专用 Tool 不存在时 fallback 到 `build_import_preview` 且不扩大目标范围。
  - 2026-05-06：增强 Planner 规范化层：按结构化目标裁掉未选择的导入目标 Tool；为分目标链路补齐/修正 `merge_import_previews` 后的 `validate_imported_assets` 和需审批 `persist_project_assets`；旧 `build_import_preview` fallback 仍会补齐审批写入步骤。
  - 2026-05-06：同步更新 Runtime artifact 提升逻辑，把 `merge_import_previews` 输出也作为文档导入预览源；这是任务文件原范围外的必要修正，否则新 Planner 骨架生成的预览不会被提升为可见 Artifact。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-runtime.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，162 项测试通过。

## 4. P1 目标产物专用生成 Tool

### TIP-P1-001 新增 generate_import_outline_preview

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-import-outline-preview.tool.ts`
- 任务：根据文档分析和项目上下文生成导入大纲预览。
- 验收：
  - 输入包含 `analysis`、`instruction`、`projectContext?`、`chapterCount?`。
  - 输出包含 `projectProfile.outline`、`volumes`、`chapters`、`risks`。
  - 不输出角色、世界设定、写作规则。
  - Prompt 专注主线、卷章结构、冲突递进、章节钩子。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `GenerateImportOutlinePreviewTool`，输入包含 `analysis`、`instruction`、`projectContext?`、`chapterCount?`；Tool 只输出 `projectProfile.outline`、`volumes`、`chapters`、`risks`，并通过专用 prompt 聚焦主线推进、卷章结构、冲突递进和章节钩子。
  - 2026-05-06：补充归一化防御，处理 LLM 返回的对象/数组/数字/布尔字段，限制章节数，保持 `allowedModes=['plan','act']`、`requiresApproval=false`、`sideEffects=[]`、`riskLevel='low'`，不写库且不输出角色、世界设定、写作规则。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/generate-import-outline-preview.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，163 项测试通过。

### TIP-P1-002 新增 generate_import_characters_preview

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-import-characters-preview.tool.ts`
- 任务：根据文档分析生成角色与人设预览。
- 验收：
  - 输出 `characters` 数组。
  - 每个角色包含 `name/roleType/personalityCore/motivation/backstory`。
  - Prompt 专注角色动机、关系、人物弧光和行为约束。
  - 不把世界设定塞进角色字段。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `GenerateImportCharactersPreviewTool`，输入包含 `analysis`、`instruction?`、`projectContext?`；专用 prompt 聚焦角色动机、关系、人物弧光和行为约束，输出只包含 `characters` 和 `risks`。
  - 2026-05-06：补充归一化防御，处理 LLM 返回的对象/数组/数字/布尔字段，过滤空名角色，保持 `allowedModes=['plan','act']`、`requiresApproval=false`、`sideEffects=[]`、`riskLevel='low'`，不写库且不输出世界设定、写作规则或大纲字段。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/generate-import-characters-preview.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，164 项测试通过。

### TIP-P1-003 新增 generate_import_worldbuilding_preview

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-import-worldbuilding-preview.tool.ts`
- 任务：根据文档分析生成世界设定导入预览。
- 验收：
  - 输出 `lorebookEntries` 数组。
  - 每项包含 `title/entryType/content/summary/tags`。
  - Prompt 专注地点、势力、规则、历史、能力体系。
  - 能读取项目上下文，避免覆盖 locked facts。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `GenerateImportWorldbuildingPreviewTool`，输入包含 `analysis`、`instruction?`、`projectContext?`、`maxEntries?`；专用 prompt 聚焦地点、势力、规则、历史、能力体系，并显式读取项目上下文中的 existing lorebook 和 locked facts。
  - 2026-05-06：输出只包含 `lorebookEntries` 和 `risks`，每项归一化 `title/entryType/content/summary/tags`；处理 LLM 返回的对象/数组/数字/布尔字段，保持 `allowedModes=['plan','act']`、`requiresApproval=false`、`sideEffects=[]`、`riskLevel='low'`，不写库且不输出角色、写作规则或大纲字段。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/generate-import-worldbuilding-preview.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，165 项测试通过。

### TIP-P1-004 新增 generate_import_writing_rules_preview

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-import-writing-rules-preview.tool.ts`
- 任务：根据文档分析生成写作规则预览。
- 验收：
  - 输出 `writingRules` 数组。
  - 每项包含 `title/ruleType/content/severity/appliesFromChapterNo?/appliesToChapterNo?/entityType?/entityRef?/status?`。
  - Prompt 专注文风、视角、人称、禁写、节奏、结构规范。
  - 不把世界观规则误塞进 lorebook。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `GenerateImportWritingRulesPreviewTool`，输入包含 `analysis`、`instruction?`、`projectContext?`、`maxRules?`；专用 prompt 聚焦文风、视角、人称、禁写、节奏、结构规范和一致性约束。
  - 2026-05-06：输出只包含 `writingRules` 和 `risks`，归一化 `title/ruleType/content/severity/appliesFromChapterNo/appliesToChapterNo/entityType/entityRef/status`；处理对象/数组/数字/布尔字段，`warn` 映射为 `warning`，不把世界观规则塞进 lorebook，保持只读低风险元数据。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/generate-import-writing-rules-preview.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，166 项测试通过。

### TIP-P1-005 新增 generate_import_project_profile_preview

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/generate-import-project-profile-preview.tool.ts`
- 任务：根据文档分析生成项目资料预览。
- 验收：
  - 输出 `projectProfile.title/genre/theme/tone/logline/synopsis`。
  - 未选择 `outline` 时不生成 `projectProfile.outline`。
  - Prompt 专注作品定位、卖点、简介和基调。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增 `GenerateImportProjectProfilePreviewTool`，输入包含 `analysis`、`instruction?`、`projectContext?`；专用 prompt 聚焦作品定位、卖点、简介、题材、主题和基调。
  - 2026-05-06：输出只包含 `projectProfile.title/genre/theme/tone/logline/synopsis` 和 `risks`，显式丢弃 `projectProfile.outline`、角色、世界设定、写作规则、卷章字段；处理对象/数组/数字/布尔字段，保持只读低风险元数据。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/generate-import-project-profile-preview.tool.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，167 项测试通过。

### TIP-P1-006 注册所有目标产物 Tool 和 Manifest

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`
- 任务：注册 P1 新增 Tool，并为每个 Tool 提供 Manifest。
- 验收：
  - Planner Available Tools 能看到所有新 Tool。
  - `whenToUse` 明确对应目标产物。
  - `whenNotToUse` 明确不生成未选择目标产物。
  - `parameterHints` 要求使用 `analysis` 和 `instruction`。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：将 `generate_import_project_profile_preview`、`generate_import_outline_preview`、`generate_import_characters_preview`、`generate_import_worldbuilding_preview`、`generate_import_writing_rules_preview` 注册进 `AgentToolsModule` providers 和 `ToolRegistryService`。
  - 2026-05-06：更新 AppModule registry 测试，确认 Planner manifest 能看到五个目标 Tool，且每个 Tool 暴露目标明确的 `whenToUse`、不混用目标的 `whenNotToUse`、`analysis`/`instruction` 参数提示，以及只读低风险元数据。
  - 修改文件：`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，167 项测试通过。

### TIP-P1-007 Planner 单目标和多目标测试

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-services.spec.ts`
- 任务：增加 Planner 规范化和分目标编排测试。
- 验收：
  - 单选大纲只编排大纲 Tool。
  - 双选大纲和写作规则只编排两个对应 Tool。
  - 全套可编排五个 Tool。
  - 所有导入计划都有 `validate_imported_assets` 和需审批 `persist_project_assets`。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：增强 Planner 分目标导入规范化：结构化 `requestedAssetTypes` 存在且对应专用 Tool 已注册时，自动补齐对应 `generate_import_*_preview` 步骤；多目标后补 `merge_import_previews`，再进入 `validate_imported_assets` 和需审批的 `persist_project_assets`。
  - 2026-05-06：当专用目标 Tool 不全时回退到 scoped `build_import_preview`，保持 `requestedAssetTypes` 不扩范围；修正旧 fallback 被替换成专用目标链路时，已有 `persist_project_assets` 必须移动到 validate 之后。
  - 2026-05-06：补充 Planner 单选大纲、双选大纲+写作规则、全套五目标、缺专用 Tool fallback、fallback 替换顺序等服务级测试。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，172 项测试通过。

### TIP-P1-008 Runtime Artifact 提升支持分目标输出

- 状态：`[x]`
- 模块：API
- 文件：`apps/api/src/modules/agent-runs/agent-runtime.service.ts`
- 任务：从目标 Tool 输出和合并输出中生成前端 Artifact。
- 验收：
  - 大纲 Tool 输出提升为 `outline_preview`。
  - 角色 Tool 输出提升为 `characters_preview`。
  - 世界设定 Tool 输出提升为 `lorebook_preview`。
  - 写作规则 Tool 输出提升为 `writing_rules_preview`。
  - 只展示用户选择的目标产物。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：Runtime 在文档导入预览和执行 Artifact 提升时，继续优先使用 `merge_import_previews`/`build_import_preview` 统一输出；统一输出缺失时，会从 `generate_import_*_preview` 目标 Tool 输出合成受限预览。
  - 2026-05-06：目标 Tool 输出只按对应目标投影，防止角色、世界设定、写作规则等未选择内容混入其它 Artifact；`project_profile_preview` 去除 `outline`，`outline_preview` 包含 `projectProfile.outline`、volumes、chapters 和 risks。
  - 2026-05-06：补充 Runtime 测试，覆盖目标 Tool 直接输出提升为 `outline_preview`、`characters_preview`、`lorebook_preview`、`writing_rules_preview`，以及只展示用户选择的目标产物。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-runtime.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，174 项测试通过。

### TIP-P1-009 前端 Plan 和 Artifact 展示目标产物来源

- 状态：`[x]`
- 模块：Web
- 文件：`apps/web/components/agent/AgentPlanPanel.tsx`、`apps/web/components/agent/AgentArtifactPanel.tsx`
- 任务：在计划和产物面板中展示本次目标产物和对应生成 Tool。
- 验收：
  - 用户能看到“剧情大纲由 generate_import_outline_preview 生成”这类来源信息。
  - 未选择目标产物不展示空卡片。
  - 写入确认仍展示最终写入范围。
- 验证：`pnpm --dir apps/web run build`
- 完成记录：
  - 2026-05-06：前端共享映射新增目标产物、专用生成 Tool 和 Artifact 类型的对应关系，计划面板展示“目标产物由 Tool 生成”的来源信息。
  - 2026-05-06：产物卡片展示目标预览、校验报告和写入结果来源；存在明确目标范围时，前端过滤未选择目标类型的预览卡片，保留校验和写入结果。
  - 2026-05-06：写入确认范围识别覆盖 `merge_import_previews` 和 `generate_import_*_preview` 专用链路，避免退回“当前导入预览中的项目资产”。
  - 修改文件：`apps/web/components/agent/AgentSharedWidgets.tsx`、`apps/web/components/agent/AgentPlanPanel.tsx`、`apps/web/components/agent/AgentArtifactPanel.tsx`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/web run build` 通过。

## 5. P2 质量和一致性增强

### TIP-P2-001 新增 build_import_brief

- 状态：`[x]`
- 模块：API
- 文件：新增 `apps/api/src/modules/agent-tools/tools/build-import-brief.tool.ts`
- 任务：在分目标生成前，先生成一份全局导入简报，作为所有目标 Tool 的共同依据。
- 验收：
  - 输出核心设定、主线、主题、关键人物、世界规则、语气和风险。
  - 所有目标 Tool 可选择接收 `importBrief`。
  - Brief 只读，不写库。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增只读 `build_import_brief` Tool，输出 `requestedAssetTypes`、核心设定、主线、主题、关键人物、世界规则、语气和风险，并注册到 Tool 白名单和 Planner manifest。
  - 2026-05-06：分目标导入 Planner 在专用目标 Tool 前插入 `build_import_brief`，并把 `importBrief` 传给 `generate_import_*_preview`；缺少专用目标 Tool 的 fallback 路径仍走 `build_import_preview` 且不扩大目标范围。
  - 2026-05-06：五个目标 Tool 的 input schema、manifest 参数提示和 prompt 均支持可选 `importBrief`，仍只生成各自目标预览且不写库。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/build-import-brief.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-outline-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-characters-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-worldbuilding-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-writing-rules-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-project-profile-preview.tool.ts`、`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，175 项测试通过。

### TIP-P2-002 增加 cross_target_consistency_check

- 状态：`[x]`
- 模块：API
- 文件：新增一致性校验 Tool 或扩展 `validate_imported_assets`
- 任务：校验大纲、角色、世界设定、写作规则之间是否互相冲突。
- 验收：
  - 能发现角色动机和大纲行为冲突。
  - 能发现世界设定和写作规则混放。
  - 校验只读，输出 warning/error。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：新增只读 `cross_target_consistency_check` Tool，基于统一导入预览输出 `valid`、`issues` 和检查摘要，覆盖角色动机与大纲行为冲突、世界设定/写作规则混放等 warning/error。
  - 2026-05-06：Planner 在 `merge_import_previews` 或 fallback `build_import_preview` 后、`validate_imported_assets` 前自动插入跨目标一致性检查；校验和写入仍继续引用同一个受目标范围约束的统一预览。
  - 2026-05-06：补充服务测试覆盖角色“拒绝杀人”与大纲“主动杀死”冲突、世界设定误入写作规则、写作规则误入世界设定，以及 Tool 注册和 Planner 编排。
  - 修改文件：`apps/api/src/modules/agent-tools/tools/cross-target-consistency-check.tool.ts`、`apps/api/src/modules/agent-tools/agent-tools.module.ts`、`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，176 项测试通过。

### TIP-P2-003 支持单目标重新生成

- 状态：`[x]`
- 模块：API/Web
- 文件：`AgentArtifactPanel.tsx`、`AgentRuntimeService`、Planner replan 相关文件
- 任务：用户可以只重生成某一个目标产物，不影响其他预览。
- 验收：
  - 从 Artifact 面板触发“重新生成写作规则”。
  - 新 Plan 只重跑对应目标 Tool、merge、validate。
  - 写入仍需确认。
- 验证：`pnpm --dir apps/api run test:agent`、`pnpm --dir apps/web run build`
- 完成记录：
  - 2026-05-06：Web Artifact 面板对分目标导入预览展示“重新生成X”操作，FloatingPanel/Workspace 通过 `useAgentRun.replan` 传入 `importTargetRegeneration.assetType`，操作后刷新历史并回到详情预览。
  - 2026-05-06：API `ReplanAgentRunDto`、Controller、Service 增加单目标重生成入口和白名单校验；Runtime 新增 `replanImportTargetRegeneration`，复用历史 `analyze_source_text`/`build_import_brief` 输出，只重跑目标 Tool、`merge_import_previews`、可用时的 `cross_target_consistency_check`、`validate_imported_assets`，并保留 `persist_project_assets` 作为唯一审批写入入口。
  - 2026-05-06：单目标重生成会保留其他已选目标旧预览作为 literal input，拒绝重生成当前导入范围外的合法 assetType，不删除 `build_import_preview` fallback 链路。
  - 修改文件：`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/api/src/modules/agent-runs/agent-runs.controller.ts`、`apps/api/src/modules/agent-runs/agent-runs.service.ts`、`apps/api/src/modules/agent-runs/agent-runtime.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`apps/web/hooks/useAgentRun.ts`、`apps/web/components/agent/AgentArtifactPanel.tsx`、`apps/web/components/agent/AgentFloatingPanel.tsx`、`apps/web/components/agent/AgentWorkspace.tsx`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，179 项测试通过；`pnpm --dir apps/web run build` 通过；`git diff --check` 通过。

### TIP-P2-004 增加快速模式和深度模式

- 状态：`[x]`
- 模块：Web/API
- 文件：`AgentInputBox.tsx`、`AgentPlannerService`
- 任务：允许用户在“快速预览”和“深度拆分”之间选择。
- 验收：
  - 快速模式优先 `build_import_preview`。
  - 深度模式优先分目标 Tool。
  - 默认模式可按目标数量决定：单目标或双目标走深度，多目标可提示成本更高。
- 验证：`pnpm --dir apps/api run test:agent`、`pnpm --dir apps/web run build`
- 完成记录：
  - 2026-05-06：Web `AgentInputBox` 在目标产物选择区增加导入预览模式选择（自动/快速/深度），提交时通过 `useAgentRun.createPlan` 将 `importPreviewMode` 纳入请求 context 和幂等指纹。
  - 2026-05-06：API context DTO、Run context 归一化、AgentContextBuilder 增加 `importPreviewMode`，并拒绝非法模式值。
  - 2026-05-06：Planner 支持 quick/deep/auto：quick 优先 `build_import_preview`，deep 优先分目标 Tool，auto 对单目标/双目标走 deep、多目标走 quick；所有模式仍保留 validate 和需审批的 `persist_project_assets`。
  - 修改文件：`apps/api/src/modules/agent-runs/dto/create-agent-plan.dto.ts`、`apps/api/src/modules/agent-runs/agent-runs.service.ts`、`apps/api/src/modules/agent-runs/agent-context-builder.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`apps/web/hooks/useAgentRun.ts`、`apps/web/components/agent/AgentInputBox.tsx`、`apps/web/components/agent/AgentFloatingPanel.tsx`、`apps/web/components/agent/AgentWorkspace.tsx`、`apps/web/app/globals.css`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api run test:agent` 通过，183 项测试通过；`pnpm --dir apps/web run build` 通过；`git diff --check` 通过。

## 6. P3 生产化和监控

### TIP-P3-001 记录分目标生成耗时和 token

- 状态：`[x]`
- 模块：API
- 文件：LLM gateway 调用链路、AgentStep metadata
- 任务：记录每个目标 Tool 的耗时、模型和 token 使用。
- 验收：
  - 审计或日志可看到每个目标产物的生成成本。
  - 全套导入能定位哪个 Tool 最慢。
- 验证：`pnpm --dir apps/api run test:agent`
- 完成记录：
  - 2026-05-06：为 `AgentStep` 增加 `metadata` 审计字段和迁移，Executor 在每个 Tool 成功/失败/等待复核时记录 `executionCost`，包含 `toolName`、`stepNo`、`planVersion`、`mode`、`elapsedMs`、`model`、`tokenUsage` 和 LLM 调用明细；成功日志同步输出成本摘要，便于生产监控定位慢 Tool。
  - 2026-05-06：在 LLM gateway 返回值中补充 `elapsedMs` 并记录 `llm.gateway.chat.completed` 日志；`build_import_preview`、`build_import_brief` 和五个 `generate_import_*_preview` Tool 通过 ToolContext 上报真实 `result.model/result.usage`，不改变 Tool 输出，不写业务库。
  - 2026-05-06：补充 Executor 服务测试，覆盖分目标 Tool 成本记录、全套导入五个目标 Tool 成本可区分、fallback `build_import_preview` 成本记录、Tool 输出不被记录逻辑污染、目标 Tool 仍只读、`persist_project_assets` 仍需审批。
  - 修改文件：`apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/202605060001_agent_step_execution_metadata/migration.sql`、`apps/api/src/modules/agent-runs/agent-executor.service.ts`、`apps/api/src/modules/agent-runs/agent-trace.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`apps/api/src/modules/agent-tools/base-tool.ts`、`apps/api/src/modules/agent-tools/tools/import-preview-llm-usage.ts`、`apps/api/src/modules/agent-tools/tools/build-import-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/build-import-brief.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-project-profile-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-outline-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-characters-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-worldbuilding-preview.tool.ts`、`apps/api/src/modules/agent-tools/tools/generate-import-writing-rules-preview.tool.ts`、`apps/api/src/modules/llm/dto/llm-chat.dto.ts`、`apps/api/src/modules/llm/llm-gateway.service.ts`、`docs/architecture/targeted-import-preview-tools-development-plan.md`。
  - 验证结果：`pnpm --dir apps/api exec prisma generate` 通过；`pnpm --dir apps/api run test:agent` 通过，187 项测试通过；`git diff --check` 通过（仅 Windows 换行提示）。

### TIP-P3-002 增加质量回归 Eval

- 状态：`[ ]`
- 模块：API/Test
- 文件：`apps/api/test/fixtures/agent-eval-cases.json` 或现有 eval 位置
- 任务：增加导入分目标质量评测用例。
- 验收：
  - 单目标不生成未选资产。
  - 双目标输出结构完整。
  - 全套输出不缺写作规则。
  - Planner 不会固定跑全套。
- 验证：项目现有 Agent eval 命令

### TIP-P3-003 文档和操作手册更新

- 状态：`[ ]`
- 模块：Docs
- 文件：`docs/architecture/creative-document-import-agent-design.md`、用户手工测试文档
- 任务：把新分目标链路同步到原导入文档和手工验收流程。
- 验收：
  - 原文档说明 `build_import_preview` 是 fallback。
  - 手工验收包含单目标、双目标、全套三类用例。
  - 写入确认边界清楚。
- 验证：文档审阅

## 7. P0 完成定义

P0 完成后必须满足：

1. 前端会把目标产物作为结构化 `requestedAssetTypes` 提交。
2. 后端 Context 能向 Planner 暴露目标产物范围。
3. `merge_import_previews` 已注册并可把多个目标预览合并成 `ImportPreviewOutput`。
4. Planner 能生成“目标 Tool → merge → validate → persist”的计划骨架。
5. 专用目标 Tool 缺失时，仍可 fallback 到 `build_import_preview`。
6. 现有导入测试全部通过。

## 8. P1 完成定义

P1 完成后必须满足：

1. 五类目标产物都有导入专用生成 Tool。
2. 用户选择单目标时只调用对应 Tool。
3. 用户选择多目标时只调用所选 Tool。
4. Artifact 只展示所选目标产物。
5. 确认写入后只写所选目标产物。
6. `pnpm --dir apps/api run test:agent` 和 `pnpm --dir apps/web run build` 通过。
