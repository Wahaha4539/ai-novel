# 历史 Worker 归档说明

`apps/worker` 仅作为旧 Python pipeline 的历史参考保留。当前 Agent-Centric 主链路已经迁入 `apps/api`，包括章节生成、润色、后处理、事实抽取、校验、记忆重建、MemoryWriter 和 embedding/pgvector 召回。

## 当前约束

- 本地开发和验收不需要启动 Python Worker。
- 根目录脚本不再提供 `dev:worker`。
- Docker Compose 不再编排 Worker 服务。
- 新功能不得新增 API → Worker internal route 调用。

如需对照旧实现，请只阅读本目录代码；确认 API 内链路稳定后，可整体移入长期归档目录或从仓库删除。