# AI Novel

AI Novel 是一个面向长篇小说创作的 Agent-Centric 创作系统。当前版本已经从“前端按钮 + 固定 Worker Pipeline”收敛为 **Web + API 单体同步执行**：用户可以在 Agent 工作台中用自然语言提出创作目标，API 内的 Agent Runtime 会生成计划、等待确认，并在确认后调用受控 Tool 完成章节写作、大纲生成、文案拆解、事实校验、记忆重建等任务。

> 重点：当前核心功能不再需要启动 Python Worker。`apps/worker` 仅作为历史 pipeline 参考保留。

## 当前架构

```text
apps/web
  ↓ HTTP
apps/api
  - REST API
  - AgentRun / Plan / Approval / Step / Artifact
  - AgentRuntime / Planner / Executor / Policy / Trace
  - ToolRegistry / SkillRegistry / RuleEngine
  - Generation / Validation / Memory / Retrieval / LLM / Embedding Services
  ↓
PostgreSQL(pgvector) / Redis / LLM Provider / Embedding Provider
```

核心约束：

- Agent Runtime、Tools、Skills、Rules、LLM Gateway 均在 `apps/api` 内运行。
- Agent 调用 Tool 是后端进程内函数调用，不再通过 API 调 Worker。
- Plan 阶段只生成计划、预览和校验产物，不写正式业务表。
- Act 阶段必须经过用户确认，并由 Policy / Schema / Approval / Trace 保护写入行为。
- Redis 只保留缓存、锁、上下文暂存等辅助用途，不承担 Agent 任务调度。

## 目录结构

```text
ai-novel/
├─ apps/
│  ├─ web/        # Next.js 前端与 Agent 工作台
│  ├─ api/        # NestJS API、Agent Runtime、业务 Service、Prisma
│  └─ worker/     # 历史 Python pipeline 参考实现，当前无需启动
├─ packages/
│  ├─ shared-types/
│  └─ prompt-templates/
├─ infra/
│  └─ docker/     # PostgreSQL(pgvector)、Redis、MinIO 本地编排
├─ scripts/
│  └─ dev/        # 数据库创建、验证、召回评测等开发脚本
└─ docs/
   └─ architecture/
```

## 本地快速启动

以下命令默认在仓库根目录执行。示例以 **Windows PowerShell** 为主；如果你使用 CMD，请将 `Copy-Item` 替换为 `copy`。

### 1. 准备依赖

需要提前安装：

- Docker / Docker Desktop：启动 PostgreSQL、Redis、MinIO。
- Node.js：建议使用当前 LTS 或项目兼容版本。
- pnpm：仓库声明包管理器为 `pnpm@10.0.0`。
- Python 3：仅用于 `scripts/dev/*.py` 开发脚本；Web + API 主链路不依赖 Python Worker。
- OpenAI-compatible LLM 网关：用于章节生成、Planner JSON Plan、导入/大纲等 LLM 能力。
- OpenAI-compatible Embedding 网关：可选；未配置时 Retrieval 会降级为关键词召回。

如果本机尚未启用 pnpm：

```powershell
corepack enable
```

### 2. 启动基础设施

```powershell
docker compose -f infra/docker/docker-compose.yml up -d
```

默认服务：

| 服务 | 默认地址 | 用途 |
| --- | --- | --- |
| PostgreSQL(pgvector) | `127.0.0.1:5432` | 主业务数据库与向量检索 |
| Redis | `127.0.0.1:6379` | 缓存、锁、上下文暂存 |
| MinIO API | `127.0.0.1:9000` | 预留对象存储 |
| MinIO Console | `http://127.0.0.1:9001` | MinIO 管理后台 |

> Docker Compose 中 PostgreSQL 默认创建的库名是 `novel_system`；应用实际使用的业务库由 `.env` 中的 `DATABASE_NAME` / `DATABASE_URL` 决定，后续通过 `pnpm db:create` 创建。

### 3. 准备环境变量

当前主要读取两份环境文件：

- 根目录 `.env`：供开发脚本和通用本地配置使用。
- `apps/api/.env`：供 NestJS / Prisma 使用。

复制模板：

```powershell
Copy-Item .env.example .env
Copy-Item .env.example apps/api/.env
```

如果使用本仓库 Docker 默认配置，建议把两份文件至少调整为：

```env
DATABASE_NAME=ai_novel_mvp
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ai_novel_mvp
POSTGRES_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres

REDIS_URL=redis://127.0.0.1:6379/0
CACHE_PROJECT_SNAPSHOT_TTL_SECONDS=300
CACHE_CHAPTER_CONTEXT_TTL_SECONDS=300
CACHE_RECALL_RESULT_TTL_SECONDS=120

MINIO_ENDPOINT=127.0.0.1:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

API_PORT=3001
WEB_PORT=3000

LLM_BASE_URL=http://YOUR_LLM_HOST:8318/v1
LLM_API_KEY=YOUR_LLM_API_KEY
LLM_MODEL=gpt-5.4

EMBEDDING_BASE_URL=http://YOUR_EMBEDDING_HOST:18319/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=bge-base-zh
```

说明：

- `DATABASE_URL` 和 `POSTGRES_ADMIN_URL` 如果包含 `&`、`^`、`@` 等特殊字符，密码部分必须先做 URL encode。
- `LLM_*` 是章节生成、Agent Planner、导入/大纲预览等能力的核心配置；未配置时，依赖真实模型的功能会失败或拒绝继续执行。
- `EMBEDDING_*` 由 API 内 MemoryWriter / RetrievalService 使用；未配置或调用失败时会自动降级为关键词召回。
- `MINIO_*` 目前主要是预留配置，当前 MVP 主链路不依赖 MinIO。
- Web 默认访问 `http://127.0.0.1:3001/api`。只有修改 API 地址或端口时，才需要新增 `apps/web/.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001/api
```

### 4. 安装依赖

```powershell
pnpm install
```

### 5. 初始化数据库

```powershell
pnpm db:create
pnpm db:generate
pnpm db:migrate
```

这三步分别会：

1. 根据 `.env` 中的 `DATABASE_NAME` 创建业务数据库，不存在时才创建。
2. 生成 Prisma Client。
3. 执行 `apps/api/prisma/migrations` 下的迁移，创建和更新表结构。

如果你使用的是本仓库 Docker PostgreSQL 镜像，pgvector 已内置。需要手动确认扩展时可执行：

```powershell
docker exec -it novel-postgres psql -U postgres -d ai_novel_mvp -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 6. 启动 Web + API

推荐使用一个终端启动当前核心服务：

```powershell
pnpm dev
```

该命令会并行启动：

- `web`：Next.js，固定监听 `http://127.0.0.1:3000`
- `api`：NestJS，默认监听 `http://127.0.0.1:3001/api`

也可以拆成两个终端分别启动：

```powershell
pnpm dev:web
pnpm dev:api
```

等价的 workspace 命令是：

```powershell
pnpm --filter web dev
pnpm --filter api start:dev
```

> 不要再寻找或启动 `dev:worker`：根 `package.json` 已移除该脚本，Agent、章节生成、润色、校验、记忆回写主链路都在 API 内同步执行。

### 7. 访问地址

- Web：`http://127.0.0.1:3000`
- API Base：`http://127.0.0.1:3001/api`
- MinIO Console：`http://127.0.0.1:9001`

## 常用开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 Web + API |
| `pnpm dev:web` | 只启动 Web |
| `pnpm dev:api` | 只启动 API |
| `pnpm db:create` | 按 `.env` 创建业务数据库 |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:migrate` | 执行 Prisma 迁移 |
| `pnpm --dir apps/api build` | 构建 API |
| `pnpm --dir apps/web build` | 构建 Web |
| `pnpm --dir apps/api run test:agent` | 运行 Agent 服务轻量测试 |
| `pnpm db:maintenance` | 执行数据库维护脚本，如 embedding backfill |

## 最小自检

服务启动后，可以先检查 API 与数据库是否连通：

```powershell
curl http://127.0.0.1:3001/api/projects
```

返回 `[]` 或项目列表即可说明 API + PostgreSQL 基本可用。

Agent-Centric 后端能力可用轻量测试验证：

```powershell
pnpm --dir apps/api run test:agent
```

真实数据上的 embedding 回填与召回质量可用开发脚本验证。默认 dry-run，不会改写数据库；确认后再追加 `--apply-backfill`：

```powershell
python scripts/dev/verify_embedding_retrieval.py --project-id <PROJECT_ID> --query "主角父亲遗物与祠堂线索"
```

如需计算 recall / precision / MRR，可通过 `--expected-memory-ids` 传入逗号分隔的期望 MemoryChunk ID，或用 `--cases` 指向 benchmark JSON 文件。

## 当前主要功能

### Agent 工作台

Web 侧已提供 Agent 工作台入口，支持：

- 输入自然语言创作目标。
- 生成结构化 Plan。
- 展示步骤、风险、预览 Artifact、写入前 Diff 和质量报告。
- 用户确认后执行 Act。
- 展示执行时间线、审计轨迹和最终报告。
- 支持取消、失败重试、重新规划、步骤级审批。

典型目标示例：

```text
帮我写第 12 章正文，压迫感强一点，字数 3500。
这是我的小说文案，帮我拆成角色、世界观和前三卷大纲。
帮我把第一卷拆成 30 章，每章要有目标、冲突和钩子。
帮我检查当前大纲有没有剧情矛盾。
```

### 章节写作主链路

当前章节生成不再依赖 Worker。主链路为：

```text
resolve_chapter
  → collect_chapter_context
  → write_chapter
  → postprocess_chapter
  → fact_validation
  → auto_repair_chapter
  → extract_chapter_facts
  → rebuild_memory
  → review_memory
  → report_result
```

执行内容包括：

- 读取项目、卷、章节、角色、设定、前文、记忆召回上下文。
- 通过 PromptBuilder / Retrieval / LLM Gateway 生成正文。
- 写入 `ChapterDraft`，并维护草稿版本。
- 执行确定性后处理和质量门禁。
- 抽取剧情事件、角色状态、伏笔。
- 运行事实校验与最多一轮有界自动修复。
- 重建章节记忆，并尽量附加 embedding。
- 输出 AgentArtifact、AgentStep、审计轨迹和最终报告。

### 文案导入与大纲设计

Agent 已支持：

- `project_import_preview`：从用户文案生成项目资料、角色、设定、卷和章节预览，确认后写入。
- `outline_design`：生成或拆分卷 / 章节大纲，执行只读校验和写入前 Diff，确认后持久化。

所有批量写入都需要用户确认；Plan 阶段只生成预览和校验 Artifact。

## 关键 API

常用业务接口：

- `POST /api/projects`
- `GET /api/projects/:projectId`
- `POST /api/projects/:projectId/chapters`
- `POST /api/chapters/:chapterId/generate`
- `POST /api/chapters/:chapterId/polish`
- `POST /api/projects/:projectId/memory/rebuild`

Agent 接口：

- `POST /api/agent-runs/plan`
- `GET /api/agent-runs/:id`
- `GET /api/agent-runs/:id/audit`
- `GET /api/projects/:projectId/agent-runs`
- `POST /api/agent-runs/:id/act`
- `POST /api/agent-runs/:id/retry`
- `POST /api/agent-runs/:id/replan`
- `POST /api/agent-runs/:id/cancel`
- `POST /api/agent-runs/:id/approve-step`

## Embedding 与 pgvector

MemoryWriter 会尽量为 MemoryChunk 写入 embedding，用于语义召回。当前支持三层降级：

1. 优先使用 pgvector SQL 检索。
2. pgvector 不可用时，降级为 JSON embedding + 应用层 cosine 相似度。
3. embedding 服务不可用时，降级为关键词召回。

如果你的主 LLM 网关不提供 `/v1/embeddings`，可以单独部署兼容 OpenAI 格式的 embedding 服务，并将 `EMBEDDING_BASE_URL` 指向该服务。

## Worker 状态说明

`apps/worker` 当前只作为历史 Python pipeline 参考实现保留，包含旧的生成、后处理、润色、事实校验、记忆重建等逻辑。当前主链路已经迁入 `apps/api`：

- 根目录不再提供 `dev:worker`。
- `.env.example` 不再包含 `WORKER_PORT` / `WORKER_BASE_URL`。
- API 不再通过 Worker internal route 执行章节生成、润色或 memory rebuild 主流程。

如需对照旧实现，可阅读 `apps/worker/README.md` 和相关 Python 文件，但本地验证核心功能时无需启动 Worker。

## 常见问题

### `pnpm db:migrate` 或 API 启动时报数据库连接错误

优先检查：

- Docker PostgreSQL 是否已启动并监听 `5432`。
- 根目录 `.env` 和 `apps/api/.env` 是否都存在。
- 两份 `.env` 中的 `DATABASE_URL` 是否一致。
- 使用 Docker 默认密码时，连接串是否为 `postgresql://postgres:postgres@127.0.0.1:5432/ai_novel_mvp`。

### 章节生成或 Agent Act 报缺少 LLM 配置

这是预期保护。章节生成、Planner JSON Plan、导入/大纲 LLM 预览需要真实 OpenAI-compatible 网关。请检查：

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`

### Web 页面打开了，但请求不到 API

默认情况下 Web 会请求 `http://127.0.0.1:3001/api`。如果 API 地址或端口不是默认值，请创建或修改 `apps/web/.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://你的API地址/api
```

### 改了 `WEB_PORT` 但 Web 端口没变

当前 `apps/web/package.json` 中 `dev` 脚本固定使用 `3000`：

```text
next dev -p 3000
```

因此 `WEB_PORT` 目前是约定配置，不会自动改变启动端口。需要改端口时，请同步修改 Web 启动脚本和前端 API 地址配置。

### Redis 现在还需要吗

需要保留，但用途已经变化。Redis 当前用于缓存、锁、上下文暂存等辅助能力，不再承担章节生成 Worker 队列调度主链路。

## 相关文档

- `docs/architecture/agent-centric-design.md`：Agent-Centric 创作系统设计。
- `docs/architecture/agent-centric-development-plan.md`：Agent-Centric 同步后端开发计划与当前进度。
- `docs/prompt-template-guide.md`：Prompt 模板指南。
- `docs/api/`：API 相关文档。
- `docs/database/`：数据库相关文档。