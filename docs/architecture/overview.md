# 架构概览

> 历史说明：本文已按 Agent-Centric Backend Monolith 同步执行架构更新。早期“API 投递任务到 Python Worker”的设计只作为迁移参考，不再代表当前主链路。

当前脚手架采用单仓多应用（monorepo）结构：

- `apps/web`：面向用户的管理后台与编辑器 UI
- `apps/api`：资源型 API、Agent Runtime、ToolRegistry、LLM Gateway、生成 / 校验 / 记忆等同步业务 Service
- `apps/worker`：历史 Python pipeline 参考实现；当前核心生成、召回、校验、摘要、回写主链路已迁入 `apps/api`
- `packages/shared-types`：跨端共享类型
- `packages/prompt-templates`：Prompt 模板目录

## 设计原则

1. **结构化优先**：章节、角色、设定、问题、记忆都优先落结构化模型。
2. **生成与记忆解耦**：生成结果先入草稿与待审核区，不直接覆盖事实库。
3. **Agent-Centric 同步执行**：复杂生成链路由 API 内 Agent Runtime / Tool / Service 同步编排。
4. **可追踪**：生成任务、召回、校验、回写都保留 job / issue / audit 边界。

## 当前代码边界

- API 层已接入 Prisma + PostgreSQL，AgentRun / AgentPlan / AgentStep / AgentArtifact / AgentApproval 用于追踪自然语言任务。
- 章节生成、润色、事实校验、记忆重建和 embedding 召回均以 API 内 Service 为主链路。
- Worker 仅保留为历史迁移参考，验证脚本和启动脚本不应再依赖 Worker 健康检查或 internal route。
