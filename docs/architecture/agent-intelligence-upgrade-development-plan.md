# Agent 智能化改造专项开发计划（基于 `ai-novel-agent-intelligence-upgrade.md`）

> 来源设计文档：`docs/architecture/ai-novel-agent-intelligence-upgrade.md`
> 目标：把设计方案拆解为可执行、可验收、可回归的开发计划。

## 开发进度同步（2026-04-28）

当前已完成第一批最小闭环中的 P0 主干改造，并补上 Observation/Replan、Agent Eval、角色一致性、剧情一致性和世界观扩展的首批 P1 基线。本轮继续把 Retrieval Eval 从 fixture 口径推进为真实 `collect_task_context` 工具驱动，补齐世界观实体类型、关系边权重和完整草稿召回控制的确定性基线，并完成关系图服务化、关系图 Artifact 可解释展示、世界观设定对比视图、条目级审计展示、剧情一致性 deterministic 证据增强、角色一致性 deterministic 证据增强、Retrieval Eval 扩展指标回归、前端实体选择专用 API 和多轮澄清状态保留。剩余工作主要是 LLM 实验开关及其 CI 可选报告。

| 模块 | 状态 | 本次落地内容 |
|---|---|---|
| AgentContext V2 | 已完成 P0 | 新增 `AgentContextBuilderService`，从 Run 输入、项目、当前章节、近期章节、角色、设定、记忆和 Tool Manifest 构造 Hot Context，并把裁剪快照/digest 写入 `AgentRun.input`。 |
| Planner V2 | 已完成 P0 | `AgentPlannerService.createPlan(goal, context)` 注入 AgentContext 与 Manifest V2，输出 `understanding/missingInfo/requiredContext/riskReview/userVisiblePlan`，支持 context 与 step_id 引用约束。 |
| Tool Manifest V2 | 已完成 P0 | 新增 Manifest 类型与 `ToolRegistryService.listManifestsForPlanner()`；为 `resolve_chapter/collect_chapter_context/write_chapter/polish_chapter/fact_validation` 补充首批 LLM 友好说明、参数来源和 ID policy。 |
| Resolver | 已完成 P0 | 增强 `resolve_chapter` 支持“当前章/上一章/下一章/第十二章”；新增 `resolve_character` 支持“男主/女主/反派/别名/姓名”解析和低置信度候选输出。 |
| Executor 安全 | 已完成 P0 | 支持 `{{context.*}}`、`{{steps.step_id.output.*}}` 引用；新增 ID 来源兜底校验，拦截自然语言冒充 `*.Id`。 |
| 前端 Plan 体验 | 已完成 P0 + P2 实体选择入口 | `AgentPlanPanel` 展示 Agent 理解、置信度、缺失信息、所需上下文、风险说明和用户可读步骤；创建计划时传递页面上下文；澄清卡片候选选择已升级为专用 API/DTO 链路，选择后只生成待审批计划。 |
| Skill Playbook | 部分完成 | 扩展任务类型白名单到 `chapter_revision/character_consistency_check/worldbuilding_expand/plot_consistency_check/memory_review`，并把 `collect_task_context`、`character_consistency_check`、`plot_consistency_check`、`generate_worldbuilding_preview`、`validate_worldbuilding`、`persist_worldbuilding` 纳入默认工具；角色一致性、剧情一致性只读检查与世界观预览/校验/审批后追加写入已有确定性基线；本轮补齐世界观实体类型识别、关系边权重/证据/时间范围、完整草稿白名单/长度裁剪、关系图服务化、世界观条目级审计输出、剧情一致性非 LLM 证据增强与角色一致性非 LLM 证据增强。 |
| Observation/Replan | 已完成 P1 基线 | 新增 `AgentObservation`、`AgentExecutionObservationError` 与 `AgentReplannerService`；Executor 将 schema/缺参/实体/Policy 等失败结构化，Runtime 写入 `agent_observation` Artifact，并对缺 `chapterId/characterId` 生成插入 resolver 的新 Plan version，歧义实体进入 `waiting_review`。 |
| Agent Eval | 已完成 P1 增强 | 新增 12 个固定 Planner eval cases 与 `scripts/dev/eval_agent_planner.ts`，支持读取离线/导出的真实 Plan JSON、`--live-planner` 可控真实 Planner 调用、`--retrieval-eval` 真实 `collect_task_context` 工具驱动评测，以及不阻断 CI 的 `--real-llm-sample` 真实 LLM 抽样和 artifact 留档；Replan Eval 已扩展到 12 个固定 Observation 用例；`eval:agent:gate` 与 GitHub Actions 门禁串联 Live Planner、Retrieval 和 Replan 回归。 |

### 本轮新增进度（2026-04-28 04:43）

- 新增 `apps/api/src/modules/agent-runs/agent-observation.types.ts`，统一 `AgentObservation` 错误码、retryable 标记和 `ReplanPatch` 结构。
- 新增 `apps/api/src/modules/agent-runs/agent-replanner.service.ts`，先用确定性最小 patch 覆盖缺 `chapterId`、缺 `characterId`、歧义实体三类高频失败，避免引入新的 LLM 循环风险。
- `AgentExecutorService` 在 Tool/Schema/ID Policy 失败时不再只抛裸异常，而是记录结构化 Observation 到 `AgentStep.output` 并抛出 `AgentExecutionObservationError`。
- `AgentRuntimeService.act()` 捕获 Observation 后创建 `agent_observation` Artifact；可修复场景创建新 `AgentPlan.version` 并回到 `waiting_approval`，不可自动选择的歧义场景进入 `waiting_review`。
- 新增首批 Agent Eval 固定用例：章节写作、下一章、当前章修改、选中文本润色、角色检查、剧情检查、世界观扩展、拆大纲、文案导入、模糊章节引用、多候选角色、缺项目。
- 新增服务级测试覆盖 Observation 包装与 Replanner 缺 `chapterId` patch，确保失败修复链路有回归保护。

### 本轮新增进度（2026-04-28 04:52）

- 前端新增 `AgentObservationPanel`，从 `agent_observation` Artifact 或 `AgentRun.output.latestObservation/replanPatch` 中提取结构化失败观察，展示失败步骤、工具、错误码、Replan 动作和原因。
- `patch_plan` 场景会明确提示“已生成修复后的新计划版本，需重新审批”，避免用户误以为系统已绕过审批继续执行。
- `ask_user` 场景会把 resolver 多候选展示成 A/B/C 自然语言澄清卡片，降低用户接触内部 ID 和技术错误的概率。
- `useAgentRun.act()` 与 `useAgentRun.retry()` 在执行后会重新读取完整 Run，确保自动 Replan 后的最新 Plan、Observation Artifact、审计事件能立即同步到工作台。
- 全屏工作台与悬浮工作台均接入 Observation/Replan 面板，补齐 P1 前端可见性基线。

### 本轮新增进度（2026-04-28 05:00）

- Observation/Replan 补齐有界自动修复统计：Runtime 会从历史 `agent_observation` Artifact 计算 `previousAutoPatchCount` 与 `sameStepErrorPatchCount`，并写回新的 Observation Artifact 与 `AgentRun.output`。
- `AgentReplannerService` 增加硬上限：单个 AgentRun 最多自动生成 2 次 `patch_plan`；同一 `step/tool/errorCode` 同类错误最多自动修复 1 次，超过后转为 `fail_with_reason`，避免循环重规划扩大风险。
- 新增服务级回归测试覆盖“总自动修复次数达到上限”和“同一步骤同类错误重复出现”两类场景，确保 Replan 有界策略不会退化。

### 本轮新增进度（2026-04-28 05:08）

- Executor 将“自然语言/伪造 ID 直接进入 `*.Id` 参数”的 ID Policy 失败归类为可修复的 `SCHEMA_VALIDATION_FAILED` Observation，而不是不可重试的策略阻断。
- `AgentReplannerService` 补齐自然语言 `characterId` 修复路径：当 `characterId: '男主'` 这类参数被拦截时，会插入 `resolve_character` 并用 resolver 输出替换失败步骤参数。
- 新增服务级测试覆盖自然语言 `chapterId` 被包装为可修复 Observation，以及自然语言 `characterId` 自动生成 `resolve_character` patch，防止 ID Policy 与 Replan 断链。

### 本轮新增进度（2026-04-28 05:16）

- 新增 `apps/api/src/modules/agent-tools/tools/collect-task-context.tool.ts`，落地设计文档中的通用 `collect_task_context` 只读工具，覆盖角色一致性、世界观扩展、剧情一致性等非纯章节写作任务的上下文收集基线。
- `collect_task_context` 支持 `taskType/chapterId/characterId/entityRefs/focus` 输入，输出 `projectDigest/chapters/characters/worldFacts/memoryChunks/constraints/diagnostics`，并通过 Manifest V2 声明 resolver 参数来源、适用/禁用场景和 ID policy。
- 工具注册表与 `AgentToolsModule` 已接入 `CollectTaskContextTool`，`Skill Playbook` 默认工具列表同步加入 `resolve_character` 与 `collect_task_context`，让 Planner 能在角色检查、世界观扩展、剧情检查计划中看到通用上下文工具。
- 新增服务级回归测试覆盖 `collect_task_context` 的角色一致性上下文、跨项目读取拦截、locked facts 世界观约束；`pnpm --filter api test:agent` 通过 35 项测试。

### 本轮新增进度（2026-04-28 05:17）

- 新增 `apps/api/src/modules/agent-tools/tools/character-consistency-check.tool.ts`，落地 `character_consistency_check` 专用只读检查工具的首个确定性基线。
- `character_consistency_check` 基于 `collect_task_context` 输出的角色基线、近期状态、章节摘录、选中文本和未关闭校验问题，返回 `baseline/currentEvidence/deviations/verdict/suggestions`，用于回答“男主有没有崩”等检查类问题。
- 工具 Manifest V2 已声明 `resolve_character` 参数来源、适用/禁用场景、只读低风险和免审批属性，避免检查类任务误走写作/润色工具链。
- `ToolRegistryService`、`AgentToolsModule` 与 `Skill Playbook` 默认工具列表已接入 `character_consistency_check`，Planner 现在能看到角色检查的专用工具链：`resolve_character → collect_task_context → character_consistency_check`。
- 新增服务级回归测试覆盖角色偏差诊断输出与 Manifest resolver 参数说明；`pnpm --filter api test:agent` 通过 37 项测试。

### 本轮新增进度（2026-04-28 05:20）

- 新增 `apps/api/src/modules/agent-tools/tools/generate-worldbuilding-preview.tool.ts`，落地 `generate_worldbuilding_preview` 世界观扩展预览工具；通过 LLM 生成 `entries/assumptions/risks/writePlan`，并强制归一化为“只预览、需校验、写入前需审批”的安全结构。
- 新增 `apps/api/src/modules/agent-tools/tools/validate-worldbuilding.tool.ts`，落地 `validate_worldbuilding` 只读校验工具；校验缺字段、预览内重复标题、已有设定重复和 locked facts 覆盖风险，并输出世界观写入前 diff 与审批提示。
- `ToolRegistryService` 与 `AgentToolsModule` 已注册 `generate_worldbuilding_preview`、`validate_worldbuilding`；`Skill Playbook` 默认工具列表同步加入世界观预览/校验链路，让 Planner 能看到 `inspect_project_context → collect_task_context → generate_worldbuilding_preview → validate_worldbuilding`。
- 新增服务级回归测试覆盖世界观预览字段归一化、Manifest 后续校验链路声明、locked facts 冲突拦截和重复设定 diff；`pnpm --filter api test:agent` 通过 39 项测试。

### 本轮新增进度（2026-04-28 05:27）

- 新增 `apps/api/src/modules/agent-tools/tools/persist-worldbuilding.tool.ts`，落地 `persist_worldbuilding` 审批后世界观持久化工具；只追加新 `LorebookEntry`，同名设定跳过，不覆盖已有设定或 locked facts。
- `persist_worldbuilding` 要求输入 `generate_worldbuilding_preview` 的预览和 `validate_worldbuilding` 的校验结果，并在写入前再次校验 `validation.valid=true`、预览声明写入前审批、条目标题/内容非空，避免绕过预览/校验链路直接写库。
- `ToolRegistryService`、`AgentToolsModule` 与 `Skill Playbook` 已注册 `persist_worldbuilding`，世界观扩展链路补齐为 `inspect_project_context → collect_task_context → generate_worldbuilding_preview → validate_worldbuilding → persist_worldbuilding`。
- `inspect_project_context` 补充 Manifest V2，明确其在大纲设计、世界观扩展和导入预览前的只读项目巡检用途，便于 Planner 在世界观场景中稳定选择。
- 新增服务级回归测试覆盖 `persist_worldbuilding` 只新增/跳过同名设定、阻止未通过校验预览写入；`pnpm --filter api test:agent` 通过 41 项测试。

### 本轮新增进度（2026-04-28 05:33）

- `scripts/dev/eval_agent_planner.ts` 从“离线 Plan JSON 简单校验”增强为指标化评测脚本，覆盖 `intentAccuracy/toolPlanAccuracy/requiredParamCompletion/idHallucinationRate/resolverUsageRate/approvalSafety/firstPlanSuccessRate/userVisibleClarity`。
- Eval 读取逻辑兼容纯 Plan、`createPlan` API 响应、完整 `AgentRun` 响应和 `agent_plan_preview` Artifact，便于把真实 Planner 导出结果直接放入 plans 目录评测。
- 新增 `--report` 与 `--history` 输出能力，可生成单次指标快照和历史趋势；`--fail-on-regression` 可在历史指标回退时置失败码，作为后续 CI 门禁基础。
- 新增 `pnpm --filter api eval:agent:report` 脚本，约定从 `tmp/agent-eval-plans` 读取导出的真实/离线 Plan，并把报告写入 `tmp/agent-eval-report.json` 与 `tmp/agent-eval-history.json`。
- 验证结果：`pnpm --filter api eval:agent` 成功加载 12 个 Eval 用例；`pnpm --filter api test:agent` 通过 41 项服务级测试。

### 本轮新增进度（2026-04-28 05:49）

- 前端澄清卡片从“只展示候选”升级为“可选择候选并重新规划”：`AgentObservationPanel` 支持给 `ask_user` 候选渲染可点击按钮，用户无需复制内部 ID 或手写 resolver 结果。
- `useAgentRun` 新增 `answerClarification()`，复用现有 `/agent-runs/:id/replan` 安全入口，把用户显式选择的候选 label/payload 写回 Planner 输入，并要求重新生成可审批计划，不绕过审批继续执行。
- 全屏工作台 `AgentWorkspace` 和悬浮工作台 `AgentFloatingPanel` 均接入 `onAnswerClarification`，选择候选后会刷新 Run 历史和最新 Plan/Artifact，让 `waiting_review → replan → waiting_approval` 的用户路径形成闭环。
- 澄清卡片保留无回调降级提示：如果某个入口未接入选择处理，仍提示用户在输入框补充说明，避免出现不可操作的静态候选。

### 本轮新增进度（2026-04-28 05:52）

- `AgentRuntimeService.buildExecutionArtifacts()` 补齐 `worldbuilding_expand` 与 `character_consistency_check` 的业务产物提升：执行后会生成 `worldbuilding_preview`、`worldbuilding_validation_report`、`worldbuilding_persist_result`、`task_context_preview`、`character_consistency_report` 等 Artifact。
- 世界观扩展链路现在能把预览候选、校验/写入前 diff、审批后写入结果从原始 step output 提升到前端产物区，方便用户核对“新增/跳过同名/不覆盖 locked facts”。
- 角色一致性检查链路现在能把上下文召回摘要和最终检查报告提升为 Artifact，前端可直接看到角色结论、偏差数量和建议，不必只查看底层 JSON。
- `AgentArtifactPanel` 新增世界观预览、世界观写入结果、角色一致性报告和通用任务上下文摘要视图；`worldbuilding_validation_report` 复用校验视图并展示写入前 entries diff。

### 本轮新增进度（2026-04-28 06:07）

- `collect_task_context` 补齐首批专用检索维度增强：除项目、章节、角色、世界事实、记忆和校验问题外，新增 `plotEvents` 剧情事件召回，供剧情一致性与角色关系分析复用。
- 新增轻量 `relationshipGraph` 输出，基于 `StoryEvent.participants` 两两构建角色关系边，并把 `CharacterStateSnapshot` 作为状态证据节点纳入，先满足角色/剧情检查的确定性证据需求，后续再服务化为专用关系图能力。
- 新增完整草稿按需召回开关：Planner 可通过 `focus: ['full_draft']` 或 `entityRefs.includeFullDrafts=true` 显式请求 `latestDraftContent`；默认仍只返回 `latestDraftExcerpt`，符合 Hot/Warm/Cold Context 成本控制原则。
- `collect_task_context` 诊断信息新增 `diagnostics.retrievalDimensions` 与 `fullDraftIncluded`，让前端 Artifact、Trace 和 Eval 能判断本次是否使用章节范围、剧情事件、关系图或完整草稿等检索维度。
- 服务级测试新增/更新 `storyEvent` mock、剧情事件断言、关系图断言、完整草稿召回断言和诊断维度断言；`pnpm --filter api test:agent` 已通过 44 项服务级测试。

### 本轮新增进度（2026-04-28 06:10）

- `persist_worldbuilding` 新增 `selectedTitles` 输入，支持用户在世界观预览/校验后只选择部分设定条目写入，未选择条目会记录为 `skippedUnselectedTitles`，不再被默认全部持久化。
- 局部写入仍保留原安全边界：必须有 `generate_worldbuilding_preview` 预览、`validate_worldbuilding.valid=true`、预览声明写入前审批；同名设定继续跳过，不覆盖 existing 或 locked facts。
- 写入前新增选择校验：`selectedTitles` 必须命中预览中的标题，未知标题会被阻止，避免审批阶段传入不存在条目导致误写或静默漏写。
- 服务级测试新增局部写入覆盖：验证“选择旧宗门+新戒律”时只创建新戒律、跳过同名旧宗门、记录未选择的山门制度，并阻止未知标题写入。

### 本轮新增进度（2026-04-28 06:14）

- `AgentArtifactPanel` 的 `worldbuilding_preview` 从静态候选摘要升级为可勾选条目列表，默认全选候选设定，支持用户清空、全选或按标题选择要写入的世界观条目。
- 世界观预览新增“按选择写入”入口：按钮不会直接写库，而是把用户选择的标题作为 `selectedTitles` 显式写回 `/agent-runs/:id/replan`，要求 Planner 基于当前预览/校验结果重新生成可审批计划。
- 全屏工作台 `AgentWorkspace` 与悬浮工作台 `AgentFloatingPanel` 均已接入世界观选择回调，选择结果会进入聊天历史并刷新 Run 历史，保持“用户选择 → 重新规划 → 重新审批 → 执行写入”的安全闭环。
- `worldbuilding_persist_result` 前端摘要补齐 `skippedUnselectedCount/skippedUnselectedTitles` 展示，用户可以在写入结果中看到哪些候选因未选择而被跳过。

### 本轮新增进度（2026-04-28 06:28）

- `/agent-runs/:id/replan` 新增 `worldbuildingSelection.selectedTitles` 专用输入，前端世界观勾选写入不再只依赖自然语言提示让 Planner 重新理解选择。
- `AgentRuntimeService.replanWorldbuildingSelection()` 新增世界观局部重规划能力：直接 patch 最新 `worldbuilding_expand` 计划中的 `persist_worldbuilding.args.selectedTitles`，生成新的 `AgentPlan.version` 并回到 `waiting_approval`。
- 局部 patch 仍保留安全边界：仅支持已有 `persist_worldbuilding` 步骤的世界观扩展计划，不直接执行写入；用户仍需审批新计划后才会持久化。
- 全屏工作台与悬浮工作台的世界观条目勾选入口已改为传递结构化 `worldbuildingSelection`，同时保留用户可读 message 进入审计上下文。
- 服务级回归测试新增 `AgentRuntime 世界观 selectedTitles 局部重规划只 patch 持久化步骤并回到审批态`，覆盖新计划版本、审批态和 `selectedTitles` 参数注入。

### 本轮新增进度（2026-04-28 06:35）

- `AgentArtifactPanel` 的 `task_context_preview` 从基础数量摘要升级为检索维度化视图，新增展示剧情事件数、关系图边数、记忆片段数、完整草稿是否召回和缺失上下文数量。
- 前端会直接展示 `collect_task_context.diagnostics.retrievalDimensions` 标签，用户和调试者可以判断本次上下文是否启用了章节范围、剧情事件、关系图、完整草稿等 Warm/Cold Context 检索维度。
- 任务上下文预览补充章节范围、缺失上下文和约束列表，方便角色一致性、剧情一致性、世界观扩展等任务在前端产物区快速核对“取了哪些证据、还有哪些缺口”。

### 本轮新增进度（2026-04-28 06:38）

- `scripts/dev/eval_agent_planner.ts` 新增 `--live-planner` 模式，不再只依赖外部导出的 Plan JSON，而是通过 Nest `TestingModule` 直接构造真实 `AgentPlannerService` 并批量调用 `createPlan()`。
- Live Planner Eval 使用 `EvalLlmGatewayMock` 提供可重复的 LLM JSON 草案，同时用 `EvalToolRegistry` 暴露压缩 Tool Manifest，隔离数据库、网络和工具副作用，专门验证真实 Planner 的规范化、工具白名单、审批归一化和章节写作质量管线。
- Eval 上下文已对齐 `AgentContextV2` 的 `runtime/session/project/currentChapter/constraints/availableTools` 结构，覆盖当前项目、当前章节、当前草稿、选中文本、角色别名和世界观事实等基础输入。
- Eval 报告新增 `sourceMode`，区分 `offline_plans` 与 `live_planner_mock_llm`，便于后续把离线导出评测和真实 Planner 基线趋势分开观察。
- `apps/api/package.json` 新增 `eval:agent:live` 与 `eval:agent:live:report`，并为既有 eval 脚本显式指定 `ts-node --project tsconfig.json`，避免 Nest 装饰器在非项目 tsconfig 下编译失败。
- 验证结果：`pnpm --dir apps/api run eval:agent:live` 通过 12/12，`intentAccuracy/toolPlanAccuracy/requiredParamCompletion/idHallucinationRate/resolverUsageRate/approvalSafety/firstPlanSuccessRate/userVisibleClarity` 均为 100%；`pnpm --dir apps/api run eval:agent` 可正常加载 12 个 Eval 用例。

### 本轮新增进度（2026-04-28 07:20）

- 新增 `apps/api/test/fixtures/agent-replan-eval-cases.json`，用 7 个固定 Observation 场景评测 Replanner：缺 `chapterId`、自然语言 `chapterId`、自然语言 `characterId`、歧义实体澄清、不可重试 Policy 阻断、总自动修复次数上限、同一步同类错误防循环。
- 新增 `scripts/dev/eval_agent_replanner.ts`，直接驱动真实 `AgentReplannerService.createPatch()`，输出 `actionAccuracy/resolverPatchAccuracy/clarificationAccuracy/loopGuardAccuracy/approvalBoundarySafety/reasonClarity` 六类指标。
- Replan Eval 只使用 Eval 专用 ToolRegistry 元数据，不执行真实 Tool；重点校验 Replanner 是否只插入 resolver、是否用 resolver 输出替换失败参数、是否对歧义候选进入 `ask_user`、是否在不可重试或超上限场景安全失败。
- `apps/api/package.json` 新增 `eval:agent:replan`、`eval:agent:replan:report` 与 `eval:agent:gate`；根 `package.json` 新增 `eval:agent:gate`，用于一条命令串联 Live Planner Eval 与 Replan Eval。
- 新增 `.github/workflows/agent-eval.yml`，在 push main 与 pull_request 时执行 Agent Eval Gate，先安装依赖，再运行根目录 `eval:agent:gate`，把 Planner 规划质量和 Replan 修复质量纳入 CI 门禁。
- 验证结果：`pnpm --dir apps/api run eval:agent:replan` 通过 7/7，六类 Replan 指标均为 100%；`pnpm run eval:agent:gate` 通过，其中 Live Planner Eval 12/12 通过、Replan Eval 7/7 通过。

### 本轮新增进度（2026-04-28 07:45）

- Replan Eval 从 7 个固定 Observation 场景扩展到 12 个，新增覆盖 schema 数值类型安全转换、前序步骤引用错误、resolver 低置信度、上游工具输出缺字段、`validation failed` 最小修复五类失败恢复场景。
- `AgentReplannerService` 补齐对应确定性策略：安全数值字段仅做最小类型转换；未来/不存在步骤引用会回退到最近前序上下文步骤；低置信度 resolver 与缺字段但有候选的场景进入 `ask_user`；无候选缺字段场景安全失败；`auto_repair_chapter` 的 validation failed 会收紧为 1 轮最小必要修复且禁止新增重大剧情、角色长期状态或世界观设定。
- `scripts/dev/eval_agent_replanner.ts` 新增 `schemaRepairAccuracy/referenceRepairAccuracy/outputFieldSafety/validationRepairAccuracy` 指标，并把具体 `replaceArgs` 断言失败归因到对应修复能力，避免总用例失败与分项指标脱节。
- `scripts/dev/eval_agent_planner.ts` 新增 `--real-llm-sample` 模式：通过真实 `AgentPlannerService` 和真实 `LlmGatewayService` 调用项目 LLM 配置链路（`llmRouting(agent_planner)` → 默认 Provider → 环境变量兜底），默认抽样 3 条用例；该模式只输出/留档漂移观察，发现失败时仅 `console.warn`，不设置失败码。
- Planner Eval 新增 `--retrieval-eval` 与 `retrievalDimensionCoverage` 指标，先用确定性夹具把 `collect_task_context` 的世界观事实、剧情事件、关系图、完整草稿按需召回、记忆片段和缺失上下文纳入 Eval 口径。
- `apps/api/test/fixtures/agent-eval-cases.json` 已为当前章修改、角色一致性、剧情一致性、世界观扩展、模糊章节修改、多候选角色检查等场景补充 `expected.retrieval`，明确期望使用的检索维度和最小召回数量。
- `apps/api/package.json` 新增 `eval:agent:real-sample`、`eval:agent:retrieval`、`eval:agent:retrieval:report`；`eval:agent:gate` 已串联 Live Planner Eval、Retrieval Eval 与 Replan Eval，但不包含真实 LLM 抽样，避免 CI 依赖 API Key 或被模型漂移阻断。
- 验证结果：`pnpm --dir apps/api run eval:agent:replan` 通过 12/12；`pnpm --dir apps/api run eval:agent:live` 通过 12/12；`pnpm --dir apps/api run eval:agent:retrieval` 通过 12/12；`pnpm --dir apps/api run eval:agent:gate` 通过；`pnpm --dir apps/api run test:agent` 通过 46 项服务级测试。

### 本轮新增进度（2026-04-28 07:55）

- 新增 `apps/api/src/modules/agent-tools/tools/plot-consistency-check.tool.ts`，落地 `plot_consistency_check` 剧情一致性专用只读工具的确定性基线。
- `plot_consistency_check` 基于 `collect_task_context` 输出的章节大纲、剧情事件、角色动机、关系图和约束，输出 `scope/evidence/deviations/verdict/suggestions`，覆盖大纲证据不足、事件顺序倒置、伏笔证据缺失、角色动机证据不足和 locked facts/未关闭校验问题提示。
- 工具 Manifest V2 已声明 `collect_task_context` 前序输出来源、适用/禁用场景、只读低风险和免审批属性；`ToolRegistryService`、`AgentToolsModule` 与 `Skill Playbook` 默认工具列表已接入剧情检查专用链路。
- `AgentRuntimeService.buildExecutionArtifacts()` 新增 `plot_consistency_check` 产物提升，执行后会生成“剧情一致性上下文预览”和 `plot_consistency_report`；前端 `AgentArtifactPanel` 新增剧情一致性报告摘要视图。
- Planner Eval 的剧情一致性用例从单纯 `inspect_project_context` 升级为 `collect_task_context → plot_consistency_check`，并把关系图维度纳入 retrieval 期望。
- 新增服务级回归测试覆盖剧情一致性诊断输出、Manifest 前序上下文来源、Runtime Artifact 提升。

### 本轮新增进度（2026-04-28 08:00）

- `.github/workflows/agent-eval.yml` 新增真实 LLM 抽样评测留档步骤：当仓库变量 `AGENT_EVAL_REAL_LLM_SAMPLE=true` 时，CI 会在门禁通过后可选运行 `eval:agent:real-sample`。
- `--real-llm-sample` 已改为复用项目中的 `LlmProvidersService.resolveForStep('agent_planner')` 配置链路，优先读取 `llmRouting(agent_planner)`、默认 Provider，再走环境变量兜底，不再在 Eval 脚本或 CI 中单独硬编码 `LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`。
- 真实 LLM 抽样步骤保留 `continue-on-error: true`，脚本本身也只对漂移 `console.warn`，因此不会阻断 PR/主干门禁，符合“真实模型漂移只观察不阻断”的边界。
- CI 会通过 `actions/upload-artifact@v4` 上传 `tmp/agent-eval-real-sample-report.json` 与 `tmp/agent-eval-real-sample-history.json`，artifact 名称为 `agent-eval-real-llm-sample`，便于后续对比真实 LLM Planner 漂移。

### 本轮新增进度（2026-04-28 08:08）

- `--retrieval-eval` 从确定性 fixture 口径升级为真实 `CollectTaskContextTool.run()` 驱动：Eval 脚本使用确定性 Prisma Mock 调用真实工具，直接评测 `diagnostics.retrievalDimensions`、剧情事件、关系图、世界观事实、记忆片段和完整草稿召回结果。
- `collect_task_context` 对世界观事实新增 `entityType` 与 `matchedKeywords` 输出，按 `entryType` 强信号优先归一宗门/势力、地点、规则、物品、历史事件、势力关系等实体类型，避免泛词误分类。
- 关系图轻量基线增强为带 `relationType/weight/evidenceSources/timeRange/conflict` 的边结构，仍保持只读和确定性，作为后续关系图服务化/权重化的过渡形态。
- 完整草稿召回新增任务类型白名单与长度裁剪：仅 `chapter_revision/chapter_polish/character_consistency_check/plot_consistency_check` 可显式召回完整草稿，默认裁剪 6000 字、可收紧但最高不超过 12000 字；非白名单任务会在 `missingContext` 标记 `full_draft_blocked_by_task_type`。
- `apps/api/test/fixtures/agent-eval-cases.json` 的世界观扩展 retrieval 期望升级为检查 `faction/rule/location/item/history_event/relationship` 六类实体召回；模糊章节修改补齐关系图维度期望。
- 服务级测试新增完整草稿白名单/长度裁剪、世界观实体类型和权重化关系边断言；验证结果：`pnpm --dir apps/api run test:agent` 通过 51 项，`pnpm --dir apps/api run eval:agent:retrieval` 12/12 通过，`pnpm --dir apps/api run eval:agent:gate` 全部通过。

### 本轮新增进度（2026-04-28 08:18）

- 新增 `apps/api/src/modules/agent-tools/relationship-graph.service.ts`，将 `collect_task_context` 内部关系边构建逻辑抽出为只读 `RelationshipGraphService`，统一生成 `relationType/weight/evidenceSources/timeRange/conflict`，不新增关系图写入表。
- `CollectTaskContextTool` 改为复用 `RelationshipGraphService.buildGraph()` 与 `extractParticipantNames()`，继续输出原有 `relationshipGraph` 与 `plotEvents.participants` 字段，保持下游 `plot_consistency_check`、角色检查和 Retrieval Eval 兼容。
- `AgentArtifactPanel.task_context_preview` 新增关系图可解释展示：展示关系类型、强度、证据来源、时间范围、冲突边；当没有关系边时显示空状态提示，避免用户只看到原始 JSON。
- `validate_worldbuilding` 输出补充 `relatedLockedFacts`，前端 `worldbuilding_validation_report` 展示新增/跳过/相关 locked facts 对比，帮助用户理解“为什么冲突/为什么跳过”。
- `persist_worldbuilding` 输出新增 `perEntryAudit`，前端 `worldbuilding_persist_result` 展示每个条目的选择状态、写入/跳过动作、跳过原因和来源步骤；不新增审批路径，不改变“只新增不覆盖”的写入边界。
- 新增服务级回归测试覆盖 `RelationshipGraphService` 独立构建关系边、世界观 locked facts 对比输出和条目级审计输出；验证结果：`pnpm --dir apps/api run test:agent` 通过 52 项，`pnpm --dir apps/api run build` 通过，`pnpm --dir apps/api run eval:agent:retrieval` 12/12 通过。`pnpm --dir apps/web run build` 已启动但超过 30 秒转后台，日志目前停留在 Next.js 启动阶段，尚未返回最终结果。

### 本轮新增进度（2026-04-28 08:30）

- `plot_consistency_check` 完成剧情一致性证据增强（非 LLM）：新增 `lockedFactEvidence`，从 `collect_task_context.worldFacts` 中提取 locked facts，并与约束一起进入事实冲突说明。
- 剧情事件时间线展示补充参与者信息，继续优先使用 `timelineSeq`，缺失时回退 `chapterNo`；相邻事件只有具备数值顺序时才判断倒置，避免缺字段误报。
- 伏笔检查从“是否有伏笔关键词”细化为“铺设/回收”双态判断，能识别“已埋下但缺少回收/揭示”的证据不足场景。
- 动机检查复用关系图：冲突剧情事件若缺少关系边或近期状态支撑，会提示动机证据不足；若存在 `conflict=true` 或 `relationType='conflict'` 的关系边，则作为角色转折支撑证据，减少误报。
- locked facts 冲突采用保守启发式：只有剧情文本明确提及锁定事实标题，且出现“覆盖/推翻/改写/废除/不再成立”等意图时才升级为 `fact_conflict` error；普通引用只作为边界提示。
- 新增服务级回归测试覆盖伏笔未回收、动机证据不足、locked facts 冲突和冲突关系边支撑动机；验证结果：`pnpm --dir apps/api run test:agent` 通过 54 项，`pnpm --dir apps/api run build` 通过。

### 本轮新增进度（2026-04-28 08:32）

- `character_consistency_check` 完成角色一致性证据增强（非 LLM）：在原有角色基线、近期状态和章节摘录基础上，新增复用 `relationshipGraph`、`plotEvents` 与 locked facts 边界证据。
- 当前证据输出新增关系证据、剧情事件证据和锁定事实边界说明；关系边优先筛选目标角色作为 source/target 的边，剧情事件优先匹配参与者、标题或描述中出现目标角色的事件。
- 新增证据画像 `CharacterEvidenceProfile`，拆分当前文本、近期状态、关系图、剧情事件和压力支撑，避免只凭“怒吼/冲上”等强烈行为就误判为人设崩坏。
- 对克制/冷静/隐忍/谨慎型角色的强烈行为判断改为分层：若存在压抑状态、冲突事件或冲突关系边，则报告“轻微张力但有转折支撑”；若缺少关系/状态证据，则提示行为偏差风险并建议补过渡。
- 动机和关系检查新增证据不足提示：缺少主要动机基线时标记 `motivation` warning；存在相关剧情事件但缺少关系边时标记 `relationship` warning，引导召回 `relationship_graph` 或补充近期状态。
- locked facts 在角色检查中作为 `fact_boundary` info 提示，提醒修稿时不得为解释人设转折覆盖既有事实；工具仍保持只读、免审批、不接 LLM、不写库。
- 新增服务级回归测试覆盖“关系边+近期状态支撑角色转折”和“关系证据不足+动机基线缺失”；验证结果：`pnpm --dir apps/api run test:agent` 通过 56 项，`pnpm --dir apps/api run build` 通过。

### 本轮新增进度（2026-04-28 08:41）

- `scripts/dev/eval_agent_planner.ts` 的 `--retrieval-eval` 指标从基础召回数量扩展为证据维度回归：新增关系图冲突边数量、关系边字段完整性、locked facts 数量、剧情一致性 evidence 字段、角色一致性证据关键词、世界观校验对比和持久化条目级审计检查。
- Retrieval Eval 在真实 `CollectTaskContextTool.run()` 输出之上按需串联 deterministic 工具：`plot_consistency_check`、`character_consistency_check`、`validate_worldbuilding` 与基于内存 Prisma mock 的 `persist_worldbuilding`，确保新增证据维度可回归且不依赖真实数据库、不写业务数据。
- `apps/api/test/fixtures/agent-eval-cases.json` 的角色一致性、剧情一致性、世界观扩展、模糊章节引用和别名角色检查用例已补齐新期望，覆盖 `relationType/weight/evidenceSources/timeRange/conflict`、`relatedLockedFacts/writePreview`、`perEntryAudit`、`lockedFactEvidence/motivationEvidence/eventTimeline` 和角色关系/剧情/锁定事实边界证据。
- Eval 专用世界观预览保持“只预览、需校验、审批后写入”的安全边界，并通过确定性预览避免误触 locked facts 覆盖风险；持久化测试仍只在内存 mock 事务中生成审计结果。
- 验证结果：`pnpm --dir apps/api run eval:agent:retrieval` 通过 12/12，`retrievalDimensionCoverage` 为 100%；`pnpm --dir apps/api run test:agent` 通过 56 项；`pnpm --dir apps/api run build` 通过。

### 本轮新增进度（2026-04-28 08:53）

- 新增 `SubmitAgentClarificationChoiceDto` 与 `/agent-runs/:id/clarification-choice` 专用接口，澄清卡片候选选择不再复用通用自然语言 `/replan` 拼接提示。
- `AgentRunsService.submitClarificationChoice()` 只允许 `waiting_review` / `failed` 状态提交结构化候选，并校验候选至少包含 `id`、`label` 或 `payload`，避免在 `acting` 或既有审批态中绕过流程。
- `AgentRuntimeService.answerClarificationChoice()` 会把用户显式选择写入 `AgentRun.input.context.clarificationChoice` 与 `clarificationChoices` 历史，再调用安全 replan 生成新 `AgentPlan.version`；Plan 阶段仍仅以 `previewOnly` 执行只读预览，最终回到 `waiting_approval`，不直接执行写入 Tool。
- 前端 `useAgentRun.answerClarification()` 已改为调用专用接口，`AgentObservationPanel` 文案同步为“选择并生成待审批计划”，强调用户选择候选后仍需重新审批。
- 新增服务级回归测试覆盖 Service 专用入口与 Runtime 写入上下文后重新规划的审批边界；验证结果：`pnpm --dir apps/api run test:agent` 通过 58 项，`pnpm --dir apps/api run build` 通过。

### 本轮新增进度（2026-04-28 08:59）

- `AgentRuntimeService.answerClarificationChoice()` 新增 `clarificationState` 结构化状态：每次候选选择都会保存 `latestChoice` 与 `history`，历史条目包含轮次、问题、候选、用户选择、补充说明、来源 Observation 和回答时间。
- Runtime 会从最近一次 `agent_observation` Artifact 中提取 `ask_user` 的 `questionForUser/choices`，将“问题 + 候选 + 用户选择”一起纳入澄清历史；该过程只做上下文和审计保存，不触发 Tool、不自动选择实体、不扩大写入范围。
- `AgentContextBuilderService` 将 `clarificationState` 注入 `AgentContextV2.session.clarification`，让 Planner 在后续连续补充项目/章节/角色时能读取最新明确选择与多轮历史，而不是只依赖重新拼接的自然语言 goal。
- 前端 `AgentObservationPanel` 新增澄清历史展示，回放最近澄清轮次、问题、候选数量、已选候选和用户补充说明，帮助用户确认 Planner 将使用哪些明确上下文。
- 新增服务级回归测试覆盖多轮澄清状态累积与 ContextBuilder 注入 Planner session；验证结果：`pnpm --dir apps/api run test:agent` 通过 60 项，`pnpm --dir apps/api run build` 通过，`pnpm --dir apps/web exec tsc --noEmit` 通过。

### 未完成任务同步（截至 2026-04-28 08:59）

> 说明：下列清单刻意收敛为“可按顺序执行”的工程任务。已完成项不再反复拆成新待办；每完成一项再决定是否拆下一层细节，避免未完成列表持续膨胀。

| 顺序 | 优先级 | 任务 | 范围边界 | 验收标准 |
|---:|---|---|---|---|
| 1 | P2 | LLM 证据归纳实验开关 | 仅用于 `character_consistency_check` / `plot_consistency_check` 的只读摘要；默认关闭。 | 开关关闭时行为完全 deterministic；开启时不写库、不需审批、不改变 resolver ID 来源；失败自动降级 deterministic。 |
| 2 | P2 | LLM Replanner 实验开关 | 只在确定性 Replanner 无法处理时尝试；默认关闭。 | 保留最多 2 次 replan、同类错误 1 次、防循环、不绕过审批、不自动选择低置信度候选、不扩大写入范围；Replan Eval 继续通过。 |
| 3 | P2 | 将实验能力纳入 CI 可选报告 | LLM 类能力只做可选留档，不阻断门禁。 | CI artifact 包含实验报告；无 API Key 时自动跳过或 continue-on-error；主门禁仍由 deterministic eval 阻断。 |

### 下一步建议执行顺序

1. **先做任务 1：LLM 证据归纳实验开关**。多轮澄清状态保留已完成，下一步可在角色/剧情只读检查中加入默认关闭的 LLM 摘要实验，失败必须自动降级 deterministic，不改变写入和审批边界。
2. **再做任务 2：LLM Replanner 实验开关**。只在确定性 Replanner 无法处理时尝试，继续保留次数上限、防循环、低置信度不自动选择和审批边界。
3. **最后做任务 3：将实验能力纳入 CI 可选报告**。LLM 类能力只做 artifact 留档，不阻断 deterministic 主门禁；无 API Key 时跳过或 continue-on-error。


本专项计划用于承接《小说 Agent 智能化改造设计文档（完善版）》中的目标：在现有 Agent-Centric 架构上，不新增独立 Worker 或外部 Agent 服务，而是在 `apps/api` 内补齐上下文构造、LLM 友好 Tool Manifest、Resolver、参数补全、Observation/Replan 和评测体系，让 Agent 从“能生成计划和调用工具”升级为“能理解自然语言、主动取上下文、自动解析参数、失败可修复、质量可评测”的智能创作 Agent。

## 1. 改造目标与边界

| 目标 | 说明 | 非目标 |
|---|---|---|
| 自然语言可用 | 用户只表达“这一章”“第十二章”“男主”“别改结局”等创作意图，系统自动理解目标、约束和上下文。 | 不要求用户输入 `projectId/chapterId/characterId`、Tool 名称或 Pipeline 名称。 |
| 上下文充分 | Planner 每次拿到统一的 `AgentContextV2`，包含 session、项目摘要、当前章节、近期章节、角色、世界事实、记忆提示和可用工具。 | Context Builder 不做关键词意图判断，不替 LLM 猜“男主”或“第十二章”的真实 ID。 |
| 工具可理解 | Tool 不只暴露 schema，还暴露使用时机、禁用场景、参数来源、失败修复、风险和审批要求。 | 不把 Tool 手册直接展示给普通用户。 |
| ID 不幻觉 | 内部 ID 必须来自 session、resolver、前序工具输出或用户显式选择。 | 禁止 LLM 直接编造 `chapterId/characterId/lorebookEntryId/memoryChunkId`。 |
| 失败可修复 | 可恢复错误先形成结构化 observation，再由 Replanner/Repairer 生成最小 patch。 | 不自动绕过 Policy、审批或低置信度 resolver 结果。 |
| 智能可回归 | 用固定 eval cases 评估意图、工具链、参数补全、resolver、审批安全和失败恢复。 | 不再只靠人工体验判断 Prompt 是否变好。 |

## 2. 总体架构调整

专项落地后，计划链路调整为：

```text
User Message + Page Context
  ↓
AgentRunsController / AgentRunsService
  ↓
AgentContextBuilderService          # 新增：构造 AgentContextV2
  ↓
AgentPlannerService V2              # 增强：输出理解、假设、缺失信息、风险和用户可读计划
  ↓
PlanValidator / AgentPolicyService  # 增强：校验工具白名单、schema、ID 来源、审批边界
  ↓
AgentArtifact: Plan Preview / Diagnostics
  ↓
User Approval / Clarification
  ↓
AgentExecutorService                # 增强：context 引用、ID 来源校验、observation 生成
  ↓
ToolRegistry → Tool.run()
  ↓
Observation / Step Output / Error
  ↓
AgentReplannerService               # 新增：失败后最小 patch 或要求用户选择
  ↓
Final Artifacts / Result Report / Eval Trace
```

关键工程原则：

- LLM 负责理解、规划、开放式创作判断；Runtime 负责上下文、工具白名单、schema、权限、审批、trace、预算和幂等。
- Plan 阶段允许只读预览和风险说明，不写正式业务表；Act 阶段只执行已批准计划。
- Resolver 只负责把自然语言引用转成系统实体，不承担创作判断。
- Replan 只输出最小修复 patch，不重写整个计划，不重跑已成功且有副作用的步骤。

## 3. Phase 1：AgentContext V2 与 Planner 可见上下文（P0）

目标：先让 Planner “看得见当前项目、章节、角色、事实、记忆和工具”，显著提升计划质量，但不大改执行链路。

后端工作项：

1. 新增 `apps/api/src/modules/agent-runs/agent-context-builder.service.ts`：
   - 从 `AgentRun.input`、请求 DTO、session hints、项目、章节、角色、设定、记忆和 ToolRegistry 聚合 `AgentContextV2`。
   - 输出 `schemaVersion=2`、`runtime`、`session`、`project`、`currentChapter`、`recentChapters`、`knownCharacters`、`worldFacts`、`memoryHints`、`constraints`、`availableTools`。
   - 只做上下文聚合和项目隔离校验，不做 taskType 判断，不猜真实实体 ID。
2. 扩展 `CreateAgentPlanDto.context`：
   - 增加 `currentVolumeId/currentVolumeTitle/currentChapterTitle/currentChapterIndex/currentDraftId/currentDraftVersion/selectedText/selectedRange/sourcePage`。
   - 与现有 `clientRequestId` 幂等逻辑兼容。
3. 调整 `AgentRuntimeService.plan()`：
   - 从 `planner.createPlan(run.goal)` 改为 `contextBuilder.buildForPlan(run)` 后调用 `planner.createPlan(run.goal, context)`。
   - 将 context digest 或裁剪后的 context snapshot 写入 `AgentRun.input` / `AgentArtifact.agent_diagnostics`，便于 trace 和复盘。
4. 增强 `AgentPlannerService`：
   - Prompt 注入 `AgentContextV2` 的 Hot Context 与压缩后的 Tool Manifest。
   - 输出 `understanding`、`assumptions`、`missingInfo`、`requiredContext`、`riskReview`、`userVisiblePlan`。
   - 对“别改结局”“压迫感强一点”“根据前三章”等用户约束，必须保留到 instruction 或 requiredContext 中。

前端工作项：

1. 创建 Plan 时传入当前页面上下文，章节页至少传 `currentProjectId/currentChapterId/currentDraftId/currentChapterIndex/currentChapterTitle`。
2. Agent Workspace 展示“当前上下文”提示，让用户知道 Agent 当前理解的项目、章节和选中文本。

验收标准：

| 用例 | 期望 |
|---|---|
| 章节页输入“这一章太平了，改紧张点，别改结局” | Plan 的 `understanding/assumptions` 明确“这一章”来自 `context.session.currentChapterId`，instruction 保留“别改结局”。 |
| 项目页输入“帮我写第十二章，压迫感强一点” | Plan 不把“第十二章”当成 `chapterId`，而是准备调用 `resolve_chapter`。 |
| 无当前项目输入“根据前三章继续写下一章” | `missingInfo` 标记缺 project 或目标范围，并生成用户可读澄清，不执行写入。 |

## 4. Phase 2：Tool Manifest V2 与 ToolRegistry 手册化（P0/P1）

目标：让 Planner 理解每个工具什么时候用、什么时候不用、参数从哪里来、输出给谁用、失败如何修复、是否需要审批。

后端工作项：

1. 新增或完善 `apps/api/src/modules/agent-tools/tool-manifest.types.ts`：
   - 定义 `ToolManifestV2`、`ToolParameterHint`、`ToolManifestExample`、`ToolFailureHint`、`ToolIdPolicy`。
   - 字段覆盖 `displayName/description/whenToUse/whenNotToUse/inputSchema/outputSchema/parameterHints/examples/preconditions/postconditions/failureHints/allowedModes/riskLevel/requiresApproval/sideEffects/idPolicy/artifactMapping`。
2. 扩展 `BaseTool`：
   - 在现有轻量 `inputSchema/outputSchema` 基础上增加可选 `manifest` 或直接兼容 Manifest V2 字段。
   - 保持现有工具可编译运行，先把 Manifest 字段设为可选，逐步补齐。
3. 增强 `ToolRegistryService`：
   - 新增 `listManifestsForPlanner(taskType?: string): ToolManifestForPlanner[]`。
   - 对 Planner 输出压缩版 manifest：保留 name、description、whenToUse、whenNotToUse、参数说明、输出说明、风险、审批、sideEffects、idPolicy 和少量 examples。
4. 首批补齐章节主链路工具 Manifest：
   - P0：`resolve_chapter`、`collect_chapter_context`、`write_chapter`、`polish_chapter`、`fact_validation`、`auto_repair_chapter`、`report_result`。
   - P1：`extract_chapter_facts`、`rebuild_memory`、`review_memory`、大纲和导入相关 Tool。
5. 在 Manifest 中声明 ID 策略：
   - `write_chapter.chapterId`、`polish_chapter.chapterId`、`fact_validation.chapterId` 等必须声明 `forbiddenToInvent` 和 `allowedSources`。

验收标准：

- Planner prompt 中不再只包含 Tool `name/description/schema`，而是包含压缩后的 LLM 友好手册。
- `write_chapter` Manifest 明确：缺真实 `chapterId` 时必须先 `resolve_chapter`。
- `polish_chapter` Manifest 明确：用户只检查不修改时不要使用；会创建新草稿，需审批。
- 所有章节写入/事实/记忆工具都声明 `sideEffects`、`riskLevel`、`requiresApproval`。

## 5. Phase 3：Resolver 工具族与参数补全（P0）

目标：解决自然语言引用到内部实体 ID 的转换问题，禁止 ID 幻觉。

后端工作项：

1. 增强 `resolve_chapter`：
   - 支持 `chapterRef`：`当前章/这一章/上一章/下一章/第十二章/第 12 章/第一卷第三章`。
   - 支持输入 `projectId/currentChapterId/currentChapterIndex/currentVolumeId`。
   - 输出 `chapterId/title/index/confidence/alternatives/needsUserChoice`。
   - 置信度低或候选接近时进入用户选择，不自动写入。
2. 新增 `resolve_character`：
   - 支持 `男主/女主/反派/师姐/角色别名/角色名`。
   - 结合 `knownCharacters.aliases/role/currentState` 与数据库记录输出候选。
   - `confidence >= 0.85` 自动使用；`0.55~0.85` 展示假设；低于阈值要求用户选择。
3. P1 新增 `resolve_project`、`resolve_volume`，P2 再扩展 `resolve_location`、`resolve_world_setting`、`resolve_memory_query`。
4. 新增或增强 `collect_task_context`：
   - 比 `collect_chapter_context` 更通用，输入 `taskType/entityRefs/focus`。
   - 支持章节写作、章节修改、角色一致性检查、世界观扩展、剧情一致性检查等任务。
   - 输出 `projectDigest/chapters/characters/worldFacts/memoryChunks/constraints/diagnostics`。
5. 参数补全规则：
   - Planner 可以使用 `{{context.session.currentChapterId}}`、`{{steps.resolve_chapter.output.chapterId}}`、`{{steps.1.output.chapterId}}`。
   - `*.Id` 字段只允许来自 context、resolver、前序步骤或用户显式选择。

前端工作项：

1. Resolver 多候选时展示自然语言选择，例如“你说的男主是林烬还是沈怀舟？”。
2. 低置信度时进入 `waiting_review` 或澄清卡片，不展示内部 ID。

验收标准：

| 用例 | 期望 |
|---|---|
| “帮我写第十二章” | 计划先调用 `resolve_chapter({ chapterRef: '第十二章' })`，后续使用 resolver 输出的 `chapterId`。 |
| “检查男主有没有崩” | 计划先调用 `resolve_character({ characterRef: '男主' })`，再收集角色上下文。 |
| “下一章继续写” | 有当前章时能解析下一章；无当前章时进入澄清。 |
| 自然语言直接传入 `chapterId: '第十二章'` | PlanValidator/Executor 拦截，修复为 resolver 或拒绝执行。 |

## 6. Phase 4：Planner V2、变量引用与 ID Policy 校验（P0）

目标：让计划不仅包含工具步骤，还包含理解、假设、缺失信息、上下文需求、风险和用户可读计划；执行前强校验引用与 ID 来源。

后端工作项：

1. 定义 `AgentPlanV2` / `AgentPlanStepV2` 类型：
   - 包含 `schemaVersion/understanding/userGoal/taskType/confidence/assumptions/missingInfo/requiredContext/steps/riskReview/userVisiblePlan`。
   - Step 包含 `id/stepNo/purpose/tool/mode/args/dependsOn/runIf/produces/onFailure`。
2. `AgentPlannerService.createPlan(goal, context)` 输出 V2 计划：
   - taskType 从语义理解和上下文判断，避免后端硬编码关键词规则替代 LLM。
   - 写入类步骤必须进入 `riskReview.requiresApproval=true`。
3. 增强变量引用解析：
   - `{{context.session.currentProjectId}}`
   - `{{context.session.currentChapterId}}`
   - `{{context.project.defaultWordCount}}`
   - `{{steps.step_id.output.xxx}}`
   - 兼容现有 `{{steps.1.output.xxx}}`、`{{runtime.currentDraftId}}`。
4. 增强 `AgentExecutorService.resolveValue()`：
   - 禁止引用当前或未来步骤。
   - 引用不存在时返回结构化 observation，不直接裸异常。
5. 新增 ID 来源校验：
   - 执行前检查所有 `*.Id` 参数是否来自 Manifest `idPolicy.allowedSources`。
   - 拦截自然语言引用冒充 ID、伪造 ID、跨项目 ID。
6. `AgentPolicyService` 与 `PlanValidator` 合作：
   - 校验 Tool 允许当前 mode 执行。
   - 校验审批范围、riskLevel、sideEffects、Plan 禁写、Act 只执行已批准计划。

验收标准：

- Plan Preview 能展示 Agent 理解、关键假设、缺失信息、用户可读步骤和风险说明。
- `{{steps.resolve_chapter.output.chapterId}}` 和 `{{context.session.currentChapterId}}` 均可解析。
- 引用未来步骤、自然语言冒充 ID、未审批写入都会被拦截并形成诊断。

## 7. Phase 5：Observation / Replan 失败修复机制（P1）

目标：工具失败后先转成结构化 observation，让 Agent 有机会自动修复常见问题，而不是直接把错误扔给用户。

后端工作项：

1. 定义 `AgentObservation`：
   - 包含 `stepId/stepNo/tool/mode/args/error/previousOutputs`。
   - 错误码覆盖 `MISSING_REQUIRED_ARGUMENT`、`SCHEMA_VALIDATION_FAILED`、`ENTITY_NOT_FOUND`、`AMBIGUOUS_ENTITY`、`POLICY_BLOCKED`、`APPROVAL_REQUIRED`、`LLM_JSON_INVALID`、`TOOL_TIMEOUT`、`TOOL_INTERNAL_ERROR`、`VALIDATION_FAILED`。
2. 新增 `apps/api/src/modules/agent-runs/agent-replanner.service.ts`：
   - 输入用户目标、当前 Plan、已执行步骤、失败 observation、AgentContext、availableTools。
   - 输出 `patch_plan`、`ask_user` 或 `fail_with_reason`。
   - 只输出最小 patch，例如在失败步骤前插入 `resolve_chapter`，或替换失败步骤 args。
3. Runtime 接入 replan：
   - retryable 错误触发最多 2 次 replan。
   - 同一 step 同类错误最多修复 1 次。
   - 已成功且有副作用的步骤默认不重跑，除非工具声明幂等。
4. Policy 边界：
   - Replanner 不得绕过审批、不得自动选择低置信度 resolver 候选、不得扩大写入范围。
5. Trace 与 Artifact：
   - 将 observation、replan patch、最终选择写入 `AgentStep.error`、`AgentRun.output.latestObservation` 或 `agent_diagnostics` Artifact。

验收标准：

| 失败场景 | 期望 |
|---|---|
| `write_chapter` 缺 `chapterId` | 自动插入 `resolve_chapter` 或回到用户澄清。 |
| `resolve_character` 返回多个候选 | 不自动写入，前端展示用户选择。 |
| Tool schema 类型错误 | 可安全转换则 patch args，不安全则 ask_user。 |
| 高风险写入被 Policy 拦截 | 进入 `waiting_review`，不通过 replan 绕过审批。 |

## 8. Phase 6：Skill / Task Playbook 扩展（P1）

目标：把常见创作任务的方法论沉淀为 Playbook，指导 Planner 生成稳定计划，同时保留 LLM 的开放式判断空间。

后端工作项：

1. 增强 `apps/api/src/modules/agent-skills/builtin-skills.ts`：
   - 保留 `chapter_write/chapter_polish/outline_design/project_import_preview/general`。
   - 新增 `chapter_revision/character_consistency_check/worldbuilding_expand/plot_consistency_check/memory_review`。
2. 每个 Playbook 声明：
   - 适用场景、推荐工具链、关键约束、默认审批策略、输出报告结构。
3. 首批新增三条任务链：
   - `chapter_revision`：`collect_task_context → polish_chapter/revise_chapter → fact_validation → auto_repair_chapter → report_result`。
   - `character_consistency_check`：`resolve_character → collect_task_context → consistency_check → report_result`。
   - `worldbuilding_expand`：`inspect_project_context → collect_task_context → generate_worldbuilding_preview → validate_worldbuilding → persist_worldbuilding`。
4. 缺失工具按优先级补齐：
   - P1：`character_consistency_check` 只读工具、`generate_worldbuilding_preview`、`validate_worldbuilding`。
   - P2：`persist_worldbuilding`，写入前必须 diff 和审批。

验收标准：

- “这一章太平了，改紧张点，别改结局”路由到 `chapter_revision`，保留禁改约束。
- “检查男主有没有崩”路由到 `character_consistency_check`，只读检查默认不要求审批。
- “扩展世界观，但不要影响已有剧情”先生成预览和冲突校验，写入前必须审批。

## 9. Phase 7：前端 Plan 理解、假设、澄清与结果体验（P1）

目标：把 Agent Workspace 从工具控制台进一步升级为普通用户可理解的创作助理。

前端工作项：

1. 拆分或增强组件：
   - `AgentPlanView.tsx`：展示 `understanding/assumptions/missingInfo/requiredContext/riskReview/userVisiblePlan`。
   - `AgentApprovalDialog.tsx`：按业务影响展示草稿、事实层、记忆、项目资产风险。
   - `AgentTimeline.tsx`：展示 observation、replan、retry、waiting_review。
   - `AgentArtifactPreview.tsx`：展示上下文预览、resolver 候选、校验报告、写入前 diff。
2. 不确定性 UX：
   - Resolver 多候选时提供 A/B/C 选择。
   - 缺项目、缺章节、缺角色时提供自然语言选项。
3. 结果报告：
   - 展示“生成了什么、保留了什么、事实一致性结果、自动修复结果、下一步可做什么”。
   - 技术 Tool 调用和 args 只放入折叠高级详情。

验收标准：

- 用户默认看到“我理解你要做什么”“我会做什么”“会不会写入数据”“需要你确认什么”。
- 缺信息和多候选时，前端展示可行动选项，而不是技术错误。
- 最终报告能说明新草稿版本、保留项、严重/轻微问题数、事实/记忆更新摘要。

## 10. Phase 8：Agent Eval 与持续优化门禁（P1/P2）

目标：让 Agent 智能化质量可度量、可回归，避免 Prompt 和 Manifest 改动后只靠主观判断。

后端与脚本工作项：

1. 新增 `scripts/dev/eval_agent_planner.ts`：
   - 读取 eval cases JSON。
   - 调用 Planner 或 Planner 的测试入口生成 Plan。
   - 输出指标报告和失败原因。
2. 新增 `scripts/dev/agent-eval-cases.json` 或 `apps/api/test/fixtures/agent-eval-cases.json`：
   - 覆盖章节写作、下一章、当前章修改、选中文本润色、角色检查、剧情检查、世界观扩展、拆大纲、文案导入、模糊引用、多候选、缺项目。
3. 指标：
   - `Intent Accuracy >= 90%`
   - `Tool Plan Accuracy >= 85%`
   - `Required Param Completion >= 90%`
   - `ID Hallucination Rate = 0`
   - `Resolver Usage Rate >= 95%`
   - `First Plan Success Rate >= 85%`
   - `Auto Repair Success Rate >= 70%`
   - `Approval Safety = 100%`
4. 将 eval 结果写入控制台报告；短期本地运行，稳定后再进入 CI。

首批固定用例：

```text
1. 帮我写第十二章，压迫感强一点。
2. 根据前三章继续写下一章。
3. 这一章太平了，改紧张点，别改结局。
4. 把这段去 AI 味。
5. 男主这里是不是人设崩了？
6. 当前大纲有没有矛盾？
7. 补充宗门体系，但不要影响已有剧情。
8. 把第一卷拆成 30 章。
9. 把这段文案拆成角色、世界观和三卷大纲。
10. 帮我改一下他和师姐对峙那章。
11. 帮我检查小林的人设。
12. 帮我写下一章，但 session 无 currentProjectId。
```

验收标准：

- 每次修改 Planner Prompt、Tool Manifest、Resolver 或 Replanner 后，都能运行 eval 并看到指标变化。
- 任何 eval case 出现内部 ID 幻觉、高风险无审批、自然语言冒充 ID，均视为阻断级失败。

## 11. 推荐 Sprint 拆分

| Sprint | 范围 | 主要交付物 | 验收信号 |
|---|---|---|---|
| Sprint 1 | Context V2 基础 | `AgentContextBuilderService`、DTO context 扩展、Planner 输入 context | “这一章”“别改结局”能进入 Plan 理解和 instruction。 |
| Sprint 2 | Manifest V2 基础 | `tool-manifest.types.ts`、`BaseTool` 可选 Manifest、`listManifestsForPlanner()`、章节主工具 Manifest | Planner 能看到 whenToUse、参数来源、ID policy。 |
| Sprint 3 | Resolver P0 | 增强 `resolve_chapter`、新增 `resolve_character`、resolver 置信度策略 | “第十二章”“男主”“下一章”可解析或进入用户选择。 |
| Sprint 4 | Planner/Executor 安全 | `AgentPlanV2`、context/step_id 引用、ID 来源校验、PlanValidator 增强 | 自然语言不能冒充 ID，未来步骤引用被拦截。 |
| Sprint 5 | Observation/Replan | `AgentObservation`、`AgentReplannerService`、retryable 错误 patch plan | 缺 `chapterId` 可自动补 resolver，歧义实体要求用户选择。 |
| Sprint 6 | 前端体验 | Plan 理解/假设/风险展示、澄清卡片、结果报告升级 | 普通用户无需看 Tool 名称也能理解计划和风险。 |
| Sprint 7 | Eval 门禁 | eval cases、`eval_agent_planner.ts`、指标报告 | 能量化 Plan 准确率、ID 幻觉率、审批安全和修复率。 |

## 12. 第一批最小闭环实施清单

如果按最小可行改造推进，第一批只做以下 12 项：

```text
1. 新增 AgentContextBuilderService，构造 Hot Context：userMessage、runtime、session、project digest、current chapter、constraints、availableTools。
2. 扩展 CreateAgentPlanDto.context，前端章节入口传当前项目、章节、草稿和选中文本。
3. AgentPlannerService.createPlan(goal, context)，输出 understanding、assumptions、missingInfo、riskReview、userVisiblePlan。
4. 新增 ToolManifestV2 类型，并让 BaseTool 兼容可选 manifest 字段。
5. ToolRegistryService 新增 listManifestsForPlanner()。
6. 为 resolve_chapter、collect_chapter_context、write_chapter、polish_chapter、fact_validation 补齐首批 Manifest。
7. 增强 resolve_chapter，支持 chapterRef 和 confidence/alternatives/needsUserChoice。
8. 新增 resolve_character，支持“男主/女主/反派/别名”解析。
9. Executor 支持 {{context.session.*}} 和 {{steps.step_id.output.*}} 引用。
10. PlanValidator/Executor 增加 ID 来源校验，禁止自然语言直接传给 *.Id 字段。
11. 前端 AgentPlanView 展示理解、假设、缺失信息、风险和用户可读计划。
12. 新增 12 个 Agent Eval 用例，先覆盖章节写作、当前章修改、角色检查、世界观扩展和缺上下文。
```

完成这 12 项后，应达到以下可见效果：用户输入“帮我写第十二章，压迫感强一点”时，Agent 会先展示自己理解的目标和风险，计划中自动解析第十二章为真实章节；用户输入“这一章太平了，改得紧张点，但别改结局”时，Agent 能识别当前章节、保留结局约束、生成新草稿审批说明，并在执行失败时给出可恢复建议。

## 13. 里程碑验收

1. **M1：Planner 看见上下文**  
   完成 Phase 1。Plan 能稳定引用当前项目/章节/草稿，输出理解、假设、缺失信息和用户可读计划。
2. **M2：Tool 对 LLM 友好**  
   完成 Phase 2。章节主链路工具都有 Manifest V2，Planner 能知道何时调用 resolver、何时要求审批。
3. **M3：自然语言引用不再变成假 ID**  
   完成 Phase 3 + Phase 4。`第十二章/下一章/男主` 均通过 resolver 或用户选择转换，ID 幻觉率为 0。
4. **M4：失败可修复**  
   完成 Phase 5。缺参、schema 错误、歧义实体等可恢复错误进入 observation/replan，而不是裸失败。
5. **M5：体验可理解、质量可回归**  
   完成 Phase 7 + Phase 8。前端展示用户语言计划和结果报告；eval 能持续衡量 Agent 智能化质量。

## 14. 风险与应对

| 风险 | 应对 |
|---|---|
| Context 过长导致 Planner 成本和稳定性下降 | 分 Hot/Warm/Cold 三层；Planner 默认只注入 Hot + 必要 Warm，长文本通过 `collect_task_context` 按需召回。 |
| Manifest 太大影响 Prompt | `compactManifest()` 按 taskType 和候选工具裁剪，只保留 Planner 必需字段。 |
| Resolver 低置信度误选导致误写 | 置信度阈值和候选差距策略硬编码在 Runtime/Policy，低置信度必须用户选择。 |
| LLM 继续编造 ID | PlanValidator 与 Executor 双层 ID 来源校验；eval 中把 ID 幻觉设为阻断指标。 |
| Replan 无限循环或扩大风险 | 限制单 Run 最多 replan 2 次，同 step 同类错误最多修复 1 次，不绕过审批，不重跑有副作用步骤。 |
| 前端暴露过多技术细节 | 默认展示用户可读计划、风险和结果；Tool calls、args、trace 放在高级详情折叠区。 |
| 改造与现有生产化计划重叠 | 以 `AgentContextBuilder + Manifest V2 + Resolver + Validator/Replanner + Eval` 为专项边界，复用已落地的 Runtime、Policy、Trace、Artifact、质量门禁和审计能力。 |
