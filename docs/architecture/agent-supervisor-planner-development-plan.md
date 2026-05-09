# Agent Supervisor Planner 开发计划

> 来源设计文档：`docs/architecture/agent-supervisor-planner-design.md`
> 任务编号前缀：`ASP`，即 Agent Supervisor Planner
> 任务状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成
> 目标：按可回归、可灰度、可扩展的方式落地 LangGraph TS supervisor planner。

## 1. 开发原则

1. 先改 Planner 编排层，不替换执行、审批和写入链路。
2. 子 Agent 和 supervisor 只产出 `AgentPlanSpec`，不能直接执行工具。
3. Planner prompt 只能看到 selected tools，不能在 repair 阶段回到全量工具。
4. 低置信度或工具包缺失时澄清或失败，不扩大权限。
5. 任何小说内容生成失败都必须失败，不生成占位内容进入审批或写入链路。
6. 每个阶段必须有可运行测试或 eval 证明收益。

## 2. P0 文档与基线

### ASP-P0-001 落地 supervisor planner 设计文档

- 状态：`[x]`
- 模块：Docs
- 文件：`docs/architecture/agent-supervisor-planner-design.md`
- 任务：说明 LangGraph TS、多层 supervisor、ToolBundle、PlanValidator、可观测性和迁移策略。
- 依赖：无
- 验收：
  - 明确 RootSupervisor 只路由，不执行工具。
  - 明确 ToolBundle 过滤是首要收益点。
  - 明确现有 Executor、审批、写入链路不被替换。
  - 明确 `AGENTS.md` 的生成失败处理要求。
- 验证：人工审阅

### ASP-P0-002 落地开发计划文档

- 状态：`[x]`
- 模块：Docs
- 文件：`docs/architecture/agent-supervisor-planner-development-plan.md`
- 任务：把设计拆成可验收的阶段任务，标明文件范围、依赖、验收和验证命令。
- 依赖：ASP-P0-001
- 验收：
  - 任务覆盖 dependency、graph scaffold、ToolBundle、routing、validator、eval、灰度。
  - 每个实现任务都有至少一个验证方式。
- 验证：人工审阅

### ASP-P0-003 记录当前 Planner prompt 基线

- 状态：`[x]`
- 模块：API / Scripts
- 文件：
  - `scripts/dev/eval_agent_planner.ts`
  - `tmp/agent-planner-prompt-baseline.json` 或报告输出
- 任务：在不执行真实写入的情况下统计全量 tools prompt 基线。
- 依赖：无
- 验收：
  - 报告包含 `allToolCount`、`availableToolsChars`、`userPayloadChars`、`systemChars`、`totalChars`。
  - 报告可重复生成，不依赖真实 LLM。
  - 不把 tmp 报告强制纳入源码，除非团队决定保留基线快照。
- 验证：
  - `pnpm --dir apps/api run eval:agent:live`
  - 人工检查报告字段
- 完成记录（2026-05-09）：
  - 新增 `--prompt-baseline` eval 模式，使用可控 mock LLM 捕获首轮 Planner prompt，并输出 `allToolCount`、`availableToolsChars`、`userPayloadChars`、`systemChars`、`totalChars`。
  - 补齐 eval 专用工具清单中的卷大纲/章节细纲 manifest，使当前全量工具基线和 `outline_split_008` live eval 一致。
  - 修改文件：`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 生成但不提交：`tmp/agent-planner-prompt-baseline.json`。
  - 测试：`pnpm --dir apps/api run eval:agent -- --prompt-baseline --report ../../tmp/agent-planner-prompt-baseline.json`，通过，报告字段人工检查通过（`allToolCount=48`、`availableToolsChars=24281`、`userPayloadChars=49777`、`systemChars=2971`、`totalChars=52748`）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（21/21）。

## 3. P1 LangGraph 壳与兼容入口

### ASP-P1-001 增加 LangGraph TS 依赖

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/package.json`
  - `pnpm-lock.yaml`
- 任务：安装 `@langchain/langgraph` 和 `@langchain/core`。
- 依赖：ASP-P0-001
- 验收：
  - API build 能通过。
  - 没有引入 Python LangGraph 或独立 worker。
- 验证：
  - `pnpm --filter api build`
- 完成记录（2026-05-09）：
  - 使用 pnpm 为 API 包新增 `@langchain/langgraph` 与 `@langchain/core` 依赖，锁定到当前解析版本 `@langchain/langgraph@1.3.0`、`@langchain/core@1.1.45`。
  - 未引入 Python LangGraph、独立 worker 或执行链路替换。
  - 修改文件：`apps/api/package.json`、`pnpm-lock.yaml`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P1-002 新增 planner graph 目录和状态类型

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/planner-graph.state.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/agent-planner.graph.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/nodes/*.ts`
- 任务：建立 graph state、节点接口和最小可编译 graph。
- 依赖：ASP-P1-001
- 验收：
  - 有 `AgentPlannerGraphState`、`RouteDecision`、`SelectedToolBundle` 类型。
  - graph 可在测试中 invoke，但暂时可以只返回 legacy plan。
  - 不改变现有运行行为。
- 验证：
  - `pnpm --filter api build`
- 完成记录（2026-05-09）：
  - 新增 `planner-graph` scaffold：graph state 类型、`RouteDecision`、`SelectedToolBundle`、diagnostics 类型、legacy pass-through node 和最小 `StateGraph` 构建/调用入口。
  - 当前 graph 仅在显式调用时返回输入的 legacy plan，不注册到 Nest module，不改变现有 Planner 运行行为。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/planner-graph.state.ts`、`apps/api/src/modules/agent-runs/planner-graph/agent-planner.graph.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/legacy-planner.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/index.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`pnpm --filter api build`，通过。
  - 测试：`pnpm --dir apps/api exec ts-node --project tsconfig.json -e "<planner graph smoke invoke>"`，通过。

### ASP-P1-003 给 AgentPlannerService 增加 graph feature flag

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/src/modules/agent-runs/agent-runs.module.ts`
- 任务：新增 `AGENT_PLANNER_GRAPH_ENABLED` 控制 graph planner 是否启用。
- 依赖：ASP-P1-002
- 验收：
  - 默认行为与当前 Planner 一致。
  - 开启 flag 后走 graph wrapper。
  - diagnostics 能标明 planner source。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --filter api build`
- 完成记录（2026-05-09）：
  - 新增 `AGENT_PLANNER_GRAPH_ENABLED` feature flag，默认关闭时保持原 legacy Planner 路径；开启时先生成 legacy plan，再进入 LangGraph wrapper pass-through。
  - `plannerDiagnostics.source` 在 graph 路径标记为 `langgraph_supervisor`，并保留 `legacySource` 与 graph node diagnostics。
  - 新增薄封装 `AgentPlannerGraphService` 并注册到 `AgentRunsModule`，不替换 Executor、Runtime、审批、写入或 Tool 实现。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-runs.module.ts`、`apps/api/src/modules/agent-runs/planner-graph/agent-planner-graph.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="Planner graph feature flag" pnpm --dir apps/api run test:agent`，通过（1/329 targeted）。
  - 测试：`pnpm --filter api build`，通过。

## 4. P2 ToolBundle Registry

### ASP-P2-001 新增 ToolBundleRegistry

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/tool-bundle.registry.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/*.tool-bundle.ts`
- 任务：把领域意图映射到工具包定义。
- 依赖：ASP-P1-002
- 验收：
  - 至少包含 `outline.volume`、`outline.chapter`、`writing.chapter`、`revision.chapter`、`import.project_assets`、`guided.step`。
  - 工具名全部来自 `ToolRegistryService` 已注册工具。
  - 缺失工具时报错，不静默忽略关键工具。
- 验证：
  - 新增服务级测试覆盖 bundle 工具存在性。
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `ToolBundleRegistry` 和按领域拆分的 bundle 定义，覆盖 `outline.volume`、`outline.chapter`、`writing.chapter`、`revision.chapter`、`import.project_assets`、`guided.step`，并预置 timeline/quality/worldbuilding 基础 bundle。
  - registry 在 resolve 时校验 strict/optional/denied 工具名全部来自 `ToolRegistryService.list()`；缺失工具直接抛错，不静默扩大到全量工具。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/*`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ToolBundleRegistry" pnpm --dir apps/api run test:agent`，通过（1/330 targeted）。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P2-002 支持按工具名过滤 manifests

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-tools/tool-registry.service.ts`
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
- 任务：让 Planner 可以拿 selected manifests，而不是每次调用 `listManifestsForPlanner()` 全量结果。
- 依赖：ASP-P2-001
- 验收：
  - 新增类似 `listManifestsForPlanner(toolNames?: string[])` 或独立过滤方法。
  - 顺序稳定，方便快照和 eval。
  - 未注册工具直接抛错。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --filter api build`
- 完成记录（2026-05-09）：
  - `ToolRegistryService.listManifestsForPlanner(toolNames?)` 支持按工具名过滤，按传入顺序稳定输出并去重。
  - 未注册工具名会直接抛错；`AgentPlannerService.toolManifestsForPrompt(toolNames?)` 透传过滤参数，为后续 selected tools prompt 链路做准备。
  - 修改文件：`apps/api/src/modules/agent-tools/tool-registry.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="Tool manifest filtering" pnpm --dir apps/api run test:agent`，通过（1/331 targeted）。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P2-003 重构 Planner repair 使用 selected tools

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
- 任务：确保 create 和 repair 两次 LLM 调用使用同一组 selected tools。
- 依赖：ASP-P2-002
- 验收：
  - repair prompt 不再调用全量 `toolManifestsForPrompt()`。
  - 单测覆盖 repair 阶段看不到 bundle 外工具。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - scoped Planner 的 repair prompt 复用同一组 `selectedTools`，不再回退到全量 `toolManifestsForPrompt()`。
  - repair prompt 同步注入 `routeDecision` 与 `toolBundle`，diagnostics 保留 route/bundle 摘要。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="Planner repair selected tools" pnpm --dir apps/api run test:agent`，通过（1/335 targeted）。
  - 测试：`pnpm --filter api build`，通过。

## 5. P3 RootSupervisor 路由

### ASP-P3-001 实现 classifyIntentNode

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/nodes/classify-intent.node.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor.ts`
- 任务：根据用户目标和上下文输出结构化 `RouteDecision`。
- 依赖：ASP-P1-002
- 验收：
  - 不接收 tools。
  - 输出经过 schema 校验。
  - 支持 outline、writing、revision、import、quality、guided、timeline、worldbuilding、general。
  - 低置信度输出 clarification，不进入全工具 Planner。
- 验证：
  - 新增路由单测。
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `RootSupervisor` 和 `classifyIntentNode`，输出结构化 `RouteDecision` 并做本地 schema 校验。
  - 路由不接收 tools，不生成 `AgentPlanSpec` 或小说内容；低置信度返回 `general:clarify` 和 clarification questions。
  - 支持 outline、writing、revision、import、quality、guided、timeline、worldbuilding、general 路由。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/classify-intent.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/index.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="RootSupervisor" pnpm --dir apps/api run test:agent`，通过（1/332 targeted）。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P3-002 实现 selectToolBundleNode

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/nodes/select-tool-bundle.node.ts`
- 任务：根据 route 选择 bundle 并生成 selected manifests。
- 依赖：ASP-P2-001，ASP-P3-001
- 验收：
  - “卷大纲”只选择 `outline.volume`。
  - “章节细纲 / 拆成 N 章”选择 `outline.chapter`。
  - guided context 存在时优先选择 `guided.step`。
  - diagnostics 记录 selected tool count。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `createSelectToolBundleNode`，根据 `RouteDecision` 选择 bundle 并生成 selected manifests；guided context 存在时优先选择 `guided.step`。
  - `ToolBundleRegistry` 增加按 bundle strict tools 输出 manifests 和 registered tool count 的方法，diagnostics 记录 selected/all tool count。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/nodes/select-tool-bundle.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/index.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/tool-bundle.registry.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="selectToolBundleNode" pnpm --dir apps/api run test:agent`，通过（1/333 targeted）。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P3-003 将 route 注入 DomainPlanner prompt

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/nodes/domain-planner.node.ts`
- 任务：在 user payload 中加入 `routeDecision` 和 `toolBundle`。
- 依赖：ASP-P3-002
- 验收：
  - Planner 可读取 route，但不能修改 route。
  - `availableTools` 只包含 selected manifests。
  - `plannerDiagnostics` 记录 route 和 bundle。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `AgentPlannerService.createPlanWithTools()` 和 `createDomainPlannerNode`，DomainPlanner prompt 注入 `routeDecision` 与 `toolBundle`。
  - scoped Planner 的 `availableTools` 仅使用 selected manifests；默认 legacy `createPlan()` 不变。
  - `plannerDiagnostics` 记录 route 和 bundle 摘要，便于后续前端/debug 展示。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/domain-planner.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/index.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="DomainPlanner route" pnpm --dir apps/api run test:agent`，通过（1/334 targeted）。
  - 测试：`pnpm --filter api build`，通过。

## 6. P4 PlanValidator

### ASP-P4-001 新增 PlanValidatorService

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/plan-validator.service.ts`
- 任务：从 `AgentPlannerService.validateAndNormalizeLlmPlan()` 中抽出可复用校验，新增 bundle 级约束。
- 依赖：ASP-P3-003
- 验收：
  - bundle 外工具被拒绝。
  - 写入工具必须保留审批。
  - route 与工具链不匹配时报错。
  - 不生成任何 fallback plan。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `PlanValidatorService`，统一校验 selected bundle 外工具、写入/持久化工具审批、outline route 边界、guided 误路由、timeline 预览持久化和导入目标范围扩大。
  - `AgentPlannerService.createPlanWithTools()` 在首轮与 repair 归一化后调用同一 validator；校验失败继续走 LLM repair，repair 后仍失败则直接抛错，不生成 fallback plan。
  - 在 `AgentRunsModule` 注册 `PlanValidatorService`，保持 legacy `createPlan()` 默认路径不变。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/plan-validator.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-runs.module.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="PlanValidatorService" pnpm --dir apps/api run test:agent`，通过（5/340 targeted）。
  - 测试：`pnpm --filter api build`，通过。

### ASP-P4-002 增加大纲领域硬约束测试

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-services.spec.ts`
  - `apps/api/test/fixtures/agent-eval-cases.json`
- 任务：覆盖卷大纲和章节细纲分流。
- 依赖：ASP-P4-001
- 验收：
  - “生成第一卷大纲”不能出现 `generate_chapter_outline_preview`。
  - “把第一卷拆成 30 章”必须出现章节细纲链路。
  - “生成卷大纲”不能被 repair 成章节细纲。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --dir apps/api run eval:agent:live`
- 完成记录（2026-05-09）：
  - 新增 `ASP-P4-002` scoped Planner 测试：卷大纲 route 不出现章节细纲工具、30 章拆分保留章节细纲链路、卷大纲 repair 不能改成章节细纲。
  - 新增 `outline_volume_only_022` live eval case，并补充 eval mock 的 volume-only outline 分支，覆盖“只生成第一卷大纲”不得走章节细纲。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`apps/api/test/fixtures/agent-eval-cases.json`、`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P4-002" pnpm --dir apps/api run test:agent`，通过（3/343 targeted）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（22/22）。

### ASP-P4-003 增加导入、guided、timeline 边界测试

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-services.spec.ts`
  - `apps/api/test/fixtures/agent-eval-cases.json`
- 任务：覆盖非大纲领域的工具隔离边界。
- 依赖：ASP-P4-001
- 验收：
  - 导入只要 outline 时不能生成 characters/worldbuilding/writingRules。
  - guided 当前步骤问答不能走 `chapter_write`。
  - timeline 候选生成不能默认加入 `persist_timeline_events`。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --dir apps/api run eval:agent:live`
- 完成记录（2026-05-09）：
  - 新增 `ASP-P4-003` scoped Planner 测试：导入 outline-only 时 raw plan 扩大到 characters 会失败，guided 当前步骤不能走 `write_chapter`，timeline 只预览时不能带 `persist_timeline_events`。
  - `PlanValidatorService` 增加 raw plan 边界校验，并在 scoped Planner normalize 前调用，避免导入范围扩大先被 normalize 静默收窄后进入审批链路。
  - 新增 `guided_step_consultation_023` live eval case；eval mock 和 eval context 支持 guided session，并注册 guided 工具 manifest。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/plan-validator.service.ts`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`apps/api/test/fixtures/agent-eval-cases.json`、`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P4-003" pnpm --dir apps/api run test:agent`，通过（3/346 targeted）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（23/23）。
  - 测试：`pnpm --filter api build`，通过。

## 7. P5 Eval 与 Prompt 体积门禁

### ASP-P5-001 扩展 Agent Eval 指标

- 状态：`[x]`
- 模块：API / Scripts
- 文件：
  - `scripts/dev/eval_agent_planner.ts`
  - `apps/api/test/fixtures/agent-eval-cases.json`
- 任务：新增 route 和 tool bundle 相关指标。
- 依赖：ASP-P3-003
- 验收：
  - 报告包含 `routeAccuracy`、`bundleAccuracy`、`bundleToolLeakRate`、`promptReductionRate`。
  - Eval 能分别展示 legacy 和 graph planner 结果。
- 验证：
  - `pnpm --dir apps/api run eval:agent:live`
- 完成记录（2026-05-09）：
  - 扩展 Agent Eval 报告指标，新增 `routeAccuracy`、`bundleAccuracy`、`bundleToolLeakRate`、`promptReductionRate`，并支持不适用于 legacy 的指标显示为 n/a。
  - `eval:agent:live` 现在分别输出 legacy planner 与 graph planner 子集结果；graph 子集通过 RootSupervisor、ToolBundleRegistry 和 `createPlanWithTools` 评估 route/bundle/prompt 隔离。
  - 为 8 个 eval case 标注 route/bundle 期望，并新增 `outline_volume_cn_024` legacy eval case，为后续 prompt size gate 保留中文卷大纲样本。
  - 修改文件：`scripts/dev/eval_agent_planner.ts`、`apps/api/test/fixtures/agent-eval-cases.json`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`node -e "JSON.parse(require('fs').readFileSync('apps/api/test/fixtures/agent-eval-cases.json','utf8')); console.log('json ok')"`，通过。
  - 测试：`pnpm --dir apps/api exec tsc --noEmit --pretty false --project tsconfig.json`，通过。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（legacy 24/24，graph 8/8）。

### ASP-P5-002 加入 prompt size 回归保护

- 状态：`[x]`
- 模块：API / Scripts
- 文件：
  - `scripts/dev/eval_agent_planner.ts`
- 任务：对 selected tools prompt size 设置回归阈值。
- 依赖：ASP-P5-001
- 验收：
  - outline.volume 的 selected tools 字符数明显小于全量 tools。
  - 发生 bundle 外扩导致 prompt size 大幅增长时 eval 失败。
- 验证：
  - `pnpm --dir apps/api run eval:agent:live:report`
- 完成记录（2026-05-09）：
  - 在 live eval report 中新增 `promptSizeGates`，对 `outline.volume` 计算 selected tools 与全量 tools 的 prompt 字符比例。
  - 增加 `outline.volume.selected-tools` 门禁，阈值为 selected tools 不超过全量 tools 字符量的 35%；bundle 外扩或 manifest 过滤失效导致比例超限时 eval 失败。
  - 修改文件：`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`pnpm --dir apps/api run eval:agent:live:report`，通过（legacy 24/24，graph 8/8，`outline.volume.selected-tools` 为 1549/34214 chars，4.5% < 35%）。

### ASP-P5-003 更新 CI gate

- 状态：`[x]`
- 模块：CI / API
- 文件：
  - `apps/api/package.json`
  - `.github/workflows/agent-eval.yml`
- 任务：把 route/bundle 指标纳入 `eval:agent:gate`。
- 依赖：ASP-P5-001，ASP-P5-002
- 验收：
  - 本地 gate 通过。
  - CI 能展示失败 case。
- 验证：
  - `pnpm run eval:agent:gate`
- 完成记录（2026-05-09）：
  - 将 `eval:agent:gate` 切换为 report 版 live/retrieval/replan eval，确保 route/bundle/prompt 指标和失败 case 进入本地与 CI 报告。
  - CI workflow 新增 deterministic Agent Eval artifact 上传，gate 失败时也能查看 live、retrieval、replan report 和 history。
  - 修改文件：`apps/api/package.json`、`.github/workflows/agent-eval.yml`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`pnpm run eval:agent:gate`，通过（live legacy 24/24、graph 8/8；retrieval 24/24；replan 16/16）。

## 8. P6 Outline Subgraph

### ASP-P6-001 新增 OutlineSupervisor

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/supervisors/outline-supervisor.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/subgraphs/outline.subgraph.ts`
- 任务：把 outline 领域从 RootSupervisor 中拆出二级 supervisor。
- 依赖：ASP-P5-001
- 验收：
  - 支持 `volume_outline`、`chapter_outline`、`craft_brief`、`scene_card` 四类意图。
  - 输出仍是 `RouteDecision` 或其领域细化结果。
  - 不直接调用工具。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - 新增 `OutlineSupervisor`，将 outline 子意图分类为 `volume_outline`、`chapter_outline`、`craft_brief`、`scene_card`，输出仍保留 bundle 兼容的 `RouteDecision.intent`。
  - 新增 `outline.subgraph`，只调用 OutlineSupervisor 并写入节点 diagnostics，不选择工具、不生成 plan、不执行工具。
  - 新增 `ASP-P6-001` targeted 测试覆盖四类 outline 子意图和 subgraph diagnostics 边界。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/supervisors/outline-supervisor.ts`、`apps/api/src/modules/agent-runs/planner-graph/subgraphs/outline.subgraph.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P6-001" pnpm --dir apps/api run test:agent`，通过（2/348 targeted）。

### ASP-P6-002 将 outline tool bundles 迁移到 outline subgraph

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/outline.tool-bundle.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/subgraphs/outline.subgraph.ts`
- 任务：让 outline subgraph 负责选取 outline 子领域 bundle。
- 依赖：ASP-P6-001
- 验收：
  - RootSupervisor 只判断 domain=outline。
  - OutlineSupervisor 判断 volume/chapter/craftBrief/sceneCard。
  - 既有大纲测试全部通过。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --dir apps/api run eval:agent:live`
- 完成记录（2026-05-09）：
  - RootSupervisor 对 outline 请求改为只输出粗粒度 `domain=outline`、`intent=outline`，不再直接判断卷纲/章纲/craftBrief/场景卡。
  - `selectToolBundleNode` 在 outline 粗路由下调用 `outline.subgraph` 精化 RouteDecision，再由 ToolBundleRegistry 选择 `outline.volume` 或 `outline.chapter` 等子 bundle。
  - eval graph 路径和 prompt size gate 同步使用 outline subgraph 精化逻辑，保持 route/bundle 指标稳定。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/select-tool-bundle.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/subgraphs/outline.subgraph.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P6-002" pnpm --dir apps/api run test:agent`，通过（1/349 targeted）。
  - 测试：`AGENT_TEST_FILTER="ASP-P4-002" pnpm --dir apps/api run test:agent`，通过（3/349 targeted）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（legacy 24/24，graph 8/8）。

## 9. P7 扩展领域 ToolBundle

### ASP-P7-001 完善 Writing / Revision bundle

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/writing.tool-bundle.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/revision.tool-bundle.ts`
- 任务：把正文写作、续写、重写、润色严格分包。
- 依赖：ASP-P5-001
- 验收：
  - “写正文”优先 `write_chapter` 或 `write_chapter_series`。
  - “重写，不沿用旧稿”优先 `rewrite_chapter`。
  - “润色”不误用 `rewrite_chapter`。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - `writing.chapter` 只保留单章正文写作链路，新增 `writing.series` 专门处理多章连续正文。
  - 将原 revision 包拆为 `revision.polish` 与 `revision.rewrite`，润色/局部修改只暴露 `polish_chapter`，重写只暴露 `rewrite_chapter`，并互相加入 denied tools。
  - 新增 `ASP-P7-001` targeted 测试覆盖写正文、多章正文、重写、不误用 rewrite 的润色 bundle 选择。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/writing.tool-bundle.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/revision.tool-bundle.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P7-001" pnpm --dir apps/api run test:agent`，通过（1/350 targeted）。

### ASP-P7-002 完善 Import bundle

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/import.tool-bundle.ts`
- 任务：支持 quick/deep/auto 和 requestedAssetTypes 的工具可见性。
- 依赖：ASP-P5-001
- 验收：
  - deep 单目标可见对应 `generate_import_*_preview`。
  - quick 多目标可见 `build_import_preview`。
  - 目标工具缺失时明确失败或使用受控 fallback，不扩大资产范围。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm --dir apps/api run eval:agent:live`
- 完成记录（2026-05-09）：
  - `import.project_assets` strict tools 改为按 `importPreviewMode` 和 `requestedAssetTypes` 动态裁剪：quick 只暴露聚合 `build_import_preview` 链路，deep/auto 少目标只暴露对应 `generate_import_*_preview`。
  - ToolBundleRegistry 支持带 context 解析 import bundle，并在目标工具缺失时显式失败，不扩大资产范围。
  - 新增 `ASP-P7-002` targeted 测试覆盖 deep 单目标、quick 多目标、auto 双目标和缺目标工具失败。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/import.tool-bundle.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/tool-bundle.registry.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/select-tool-bundle.node.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`scripts/dev/eval_agent_planner.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P7-002" pnpm --dir apps/api run test:agent`，通过（1/351 targeted）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（legacy 24/24，graph 8/8）。

### ASP-P7-003 完善 Quality / Timeline / Worldbuilding bundle

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/quality.tool-bundle.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/timeline.tool-bundle.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/tool-bundles/worldbuilding.tool-bundle.ts`
- 任务：把检查类、时间线和设定扩展类任务与写作任务隔离。
- 依赖：ASP-P5-001
- 验收：
  - 角色检查不看到正文写作工具。
  - 时间线候选默认不看到 `persist_timeline_events`，除非 intent 明确保存。
  - 世界观扩展保留 preview -> validate -> approved persist 链路。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - Quality bundle 补充 denied 写作/改写工具，角色检查等只读检查不暴露正文写作链路。
  - Timeline bundle 按 `route.needsPersistence` 动态选择 `persist_timeline_events`，默认预览不进入 selected tools，明确保存时才进入 strict tools。
  - Worldbuilding bundle 拆分为 `worldbuilding.expand` 与 `worldbuilding.story_bible`，分别保留 preview -> validate -> approved persist 链路，避免互相暴露无关设定写入工具。
  - 修改文件：`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/quality.tool-bundle.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/timeline.tool-bundle.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/worldbuilding.tool-bundle.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/tool-bundle.registry.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P7-003" pnpm --dir apps/api run test:agent`，通过（1/352 targeted）。
  - 测试：`pnpm --dir apps/api run eval:agent:live`，通过（legacy 24/24，graph 8/8）。

## 10. P8 可观测性与前端调试

### ASP-P8-001 扩展 plannerDiagnostics

- 状态：`[x]`
- 模块：API
- 文件：
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
  - `apps/api/src/modules/agent-runs/planner-graph/*.ts`
- 任务：记录 graph route、bundle、prompt size 和节点执行结果。
- 依赖：ASP-P3-003
- 验收：
  - `AgentPlan.plannerDiagnostics` 能看到 route 和 selected tools。
  - 出错时能定位是 classify、bundle、planner 还是 validator。
- 验证：
  - `pnpm --dir apps/api run test:agent`
- 完成记录（2026-05-09）：
  - `plannerDiagnostics` 扩展 route、toolBundle、selected/allowed tool names、promptBudget 和 graphNodes 摘要，不暴露完整 manifest。
  - `selectToolBundleNode` 记录 graph route、bundle、selected tools、allowed tools、selected/all tools prompt 字符数和节点执行结果。
  - scoped planner 校验失败会记录 `validator` / `repair_validator` 阶段，便于定位失败来自 validator。
  - 修改文件：`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/planner-graph/planner-graph.state.ts`、`apps/api/src/modules/agent-runs/planner-graph/nodes/select-tool-bundle.node.ts`、`apps/api/src/modules/agent-runs/planner-graph/tool-bundles/tool-bundle.registry.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P8-001" pnpm --dir apps/api run test:agent`，通过（3/355 targeted）。

### ASP-P8-002 前端展示 planner debug 信息

- 状态：`[x]`
- 模块：Web
- 文件：
  - `apps/web/components/agent/AgentPlanPanel.tsx`
  - `apps/web/components/agent/AgentArtifactPanel.tsx`
- 任务：在调试区域展示 route、bundle、selected tools。
- 依赖：ASP-P8-001
- 验收：
  - 普通用户视图不被技术信息打扰。
  - 调试信息可展开查看。
  - 不显示冗长 manifest。
- 验证：
  - `pnpm --filter web build`
  - 如做真实 UI 测试，按 Docker Compose 流程启动
- 完成记录（2026-05-09）：
  - 计划简报底部新增折叠式 `Planner debug`，展示 route、bundle、selected/allowed tools、promptBudget 和 graph node 摘要。
  - `agent_plan_preview` 产物新增专用摘要视图，并复用同一折叠调试区域；普通视图默认不展开技术细节，且不显示完整 manifest。
  - 前端 plan 类型与 normalize 逻辑保留 `plannerDiagnostics`，避免仅依赖原始 JSON。
  - 修改文件：`apps/web/components/agent/AgentPlanPanel.tsx`、`apps/web/components/agent/AgentArtifactPanel.tsx`、`apps/web/components/agent/AgentSharedWidgets.tsx`、`apps/web/hooks/useAgentRun.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`pnpm --filter web build`，通过。

## 11. P9 灰度与默认启用

### ASP-P9-001 本地默认启用 graph planner

- 状态：`[x]`
- 模块：Config / API
- 文件：
  - `.env.example` 或项目配置文档
  - `apps/api/src/modules/agent-runs/agent-planner.service.ts`
- 任务：本地和测试环境默认启用 graph planner。
- 依赖：ASP-P5-003
- 验收：
  - 本地开发默认走 graph。
  - 生产环境仍可关闭。
- 验证：
  - `pnpm --dir apps/api run test:agent`
  - `pnpm run eval:agent:gate`
- 完成记录（2026-05-09）：
  - `AGENT_PLANNER_GRAPH_ENABLED` 未设置时，本地/测试环境默认启用 graph planner；生产环境未设置时仍走 legacy。
  - 显式设置 `AGENT_PLANNER_GRAPH_ENABLED=false` 可在本地/测试/生产强制关闭 graph planner。
  - `.env.example` 增加本地默认启用配置说明。
  - 修改文件：`.env.example`、`apps/api/src/modules/agent-runs/agent-planner.service.ts`、`apps/api/src/modules/agent-runs/agent-services.spec.ts`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`AGENT_TEST_FILTER="ASP-P9-001" pnpm --dir apps/api run test:agent`，通过（1/356 targeted）。
  - 测试：`pnpm run eval:agent:gate`，通过（live legacy 24/24、live graph 8/8、retrieval 24/24、replan 16/16）。

### ASP-P9-002 生产灰度策略

- 状态：`[x]`
- 模块：API / Ops Docs
- 文件：
  - `docs/architecture/agent-supervisor-planner-design.md`
  - 配置说明文档
- 任务：定义从关闭到部分启用再到默认启用的灰度步骤。
- 依赖：ASP-P9-001
- 验收：
  - 有可回滚开关。
  - legacy fallback 默认关闭。
  - diagnostics 能确认每个 run 是否走 graph。
- 验证：人工审阅和生产前演练
- 完成记录（2026-05-09）：
  - 设计文档补充 graph planner 当前默认、生产灰度、扩大比例、回滚步骤和 diagnostics 抽查字段。
  - 明确生产可通过 `AGENT_PLANNER_GRAPH_ENABLED=false` 回滚，legacy fallback 默认关闭且当前实现不做静默 fallback。
  - `.env.example` 补充生产 canary/full rollout 配置说明，并记录保留的 `AGENT_PLANNER_LEGACY_FALLBACK=false`。
  - 修改文件：`docs/architecture/agent-supervisor-planner-design.md`、`.env.example`、`docs/architecture/agent-supervisor-planner-development-plan.md`。
  - 测试：`git diff --check -- .env.example docs/architecture/agent-supervisor-planner-design.md docs/architecture/agent-supervisor-planner-development-plan.md`，通过。

## 12. 总体验收

完成 P1 到 P5 后，必须满足：

1. Planner Graph 可通过 feature flag 启用。
2. 常见任务只看到对应 ToolBundle。
3. repair 阶段不回到全量 tools。
4. 大纲、导入、guided、timeline 的关键误判有测试。
5. eval 报告能展示 route/bundle/prompt size 指标。
6. `AgentExecutorService`、审批和写入链路未被替换。

完成 P6 到 P9 后，必须满足：

1. outline 领域有独立子图。
2. writing、revision、import、quality、timeline、worldbuilding 有稳定工具包。
3. 前端能查看 route/bundle 调试信息。
4. CI gate 能防止工具泄漏和 prompt 体积回退。
5. graph planner 可以作为默认 Planner 路径。

最终验证记录（2026-05-09）：

- `pnpm --dir apps/api run test:agent`，通过（356/356）。
- `pnpm --dir apps/api run eval:agent:live`，通过（legacy 24/24，graph 8/8，prompt size gate 通过）。
- `pnpm --dir apps/api run eval:agent:retrieval`，通过（24/24）。
- `pnpm --dir apps/api run eval:agent:replan`，通过（16/16）。
- `pnpm --filter api build`，通过。
- `pnpm --filter web build`，通过。
- 未执行真实 Web/UI 测试；本轮未启动 Docker Compose。

## 13. 推荐执行顺序

```text
ASP-P0-003
ASP-P1-001
ASP-P1-002
ASP-P2-001
ASP-P2-002
ASP-P3-001
ASP-P3-002
ASP-P3-003
ASP-P2-003
ASP-P4-001
ASP-P4-002
ASP-P4-003
ASP-P5-001
ASP-P5-002
ASP-P5-003
ASP-P6-001
ASP-P6-002
ASP-P7-001
ASP-P7-002
ASP-P7-003
ASP-P8-001
ASP-P8-002
ASP-P9-001
ASP-P9-002
```

优先级说明：

- P1 到 P5 是第一版必须完成的最小闭环。
- P6 是针对当前“卷大纲 vs 章节细纲”问题的高价值增强。
- P7 到 P9 属于扩展和灰度，不阻塞第一版工具隔离收益。
