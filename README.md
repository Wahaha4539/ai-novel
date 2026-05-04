# AI Novel

AI Novel 是一个面向长篇小说创作的 **Agent-Centric 创作工作台**。当前主链路已经收敛为 **Web + API 单体同步执行**：前端提供项目、卷章、大纲、设定、LLM 配置与 Agent 工作台；后端 NestJS API 内置 Agent Runtime、Planner、Tool、章节生成、事实校验、记忆重建与 pgvector 召回能力。

> 当前核心功能 **不需要启动 Python Worker**。`apps/worker` 仅保留为历史 pipeline 参考。

---

## 1. 项目结构速览

```text
ai-novel/
├─ apps/
│  ├─ web/        # Next.js 前端：创作工作台、Agent 悬浮入口、项目/卷章/设定管理
│  ├─ api/        # NestJS API：业务接口、Agent Runtime、Prisma、LLM/Embedding 网关
│  └─ worker/     # 历史 Python pipeline 参考，当前无需启动
├─ docker-compose.yml # 本地全量开发编排：Web、API、PostgreSQL、Redis、MinIO、Embedding
├─ packages/
│  ├─ shared-types/
│  └─ prompt-templates/
├─ scripts/dev/   # 数据库创建、Agent Eval、Embedding 检索验证等开发脚本
└─ docs/          # 架构、API、数据库、Prompt 文档
```

当前运行链路：

```text
浏览器 Web(3000)
  ↓ HTTP
NestJS API(3001/api)
  ├─ REST API
  ├─ AgentRun / Plan / Approval / Step / Artifact
  ├─ AgentRuntime / Planner / Executor / Replanner / Policy / Trace
  ├─ ToolRegistry / Resolver Tools / Collect Task Context
  └─ Generation / Validation / Memory / Retrieval / LLM / Embedding
  ↓
PostgreSQL(pgvector) + Redis + LLM Provider + Embedding Provider(可选)
```

---

## 2. 依赖层：启动前需要准备什么

### 2.1 本机软件依赖

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js | 必需 | 建议使用当前 LTS 版本。 |
| pnpm | 必需 | 仓库声明包管理器为 `pnpm@10.0.0`。 |
| Docker / Docker Desktop | 必需 | 用于本地启动 PostgreSQL(pgvector)、Redis、MinIO、Embedding service。 |
| Python 3 | 必需 | 根脚本 `pnpm db:create` 会调用 `scripts/dev/create_database.py` 创建业务库。 |
| OpenAI-compatible LLM 服务 | 生成类功能必需 | Agent 规划、章节生成、润色、导入/大纲预览等依赖 `LLM_*` 配置。 |
| OpenAI-compatible Embedding 服务 | 可选但建议启动 | 根目录 Docker Compose 内置 `embedding` service；配置后可启用语义召回。 |

如果 pnpm 尚未启用：

```powershell
corepack enable
```

`db:create` 使用 Python 包 `psycopg` 与 `python-dotenv`。如果执行时报 `ModuleNotFoundError`，请先安装：

```powershell
python -m pip install "psycopg[binary]" python-dotenv
```

### 2.2 基础设施依赖

本地基础设施由 Docker Compose 管理：

```powershell
docker compose up -d postgres redis minio embedding
```

默认服务如下：

| 服务 | 默认地址 | 容器名 | 用途 |
| --- | --- | --- | --- |
| PostgreSQL + pgvector | `127.0.0.1:5432` | `novel-postgres` | 主业务数据库、向量检索。 |
| Redis | `127.0.0.1:6379` | `novel-redis` | 缓存、锁、上下文暂存。 |
| MinIO API | `127.0.0.1:9000` | `novel-minio` | 预留对象存储。 |
| MinIO Console | `http://127.0.0.1:9001` | `novel-minio` | MinIO 管理后台。 |

Docker Compose 中 PostgreSQL 默认创建库名由 `.env` 中的 `DATABASE_NAME` 决定，通常为 `ai_novel_mvp`。如果业务库不存在，可通过后续建库脚本创建。

### 2.3 环境变量

项目统一读取根目录 `.env`：

| 文件 | 使用者 | 说明 |
| --- | --- | --- |
| `.env` | 根目录脚本、NestJS API、Prisma、Docker Compose | API 运行、Prisma 迁移、LLM/Embedding 网关、`db:create`、开发脚本等读取。 |

复制模板：

```powershell
Copy-Item .env.example .env
```

> [!IMPORTANT]
> 本 README 只展示不含敏感信息的占位 / 脱敏示例，不记录任何真实数据库地址、密码或 API Key。
> 实际运行配置以根目录 `.env` 中填写的值为准；排查连接问题时也应优先检查这份环境文件，而不是下面的示例值。

建议至少补齐以下配置，具体值请按你的本地或远程环境替换：

```env
DATABASE_NAME=ai_novel_mvp
DATABASE_URL=postgresql://DB_USER:DB_PASSWORD@DB_HOST:5432/ai_novel_mvp
POSTGRES_ADMIN_URL=postgresql://DB_USER:DB_PASSWORD@DB_HOST:5432/postgres

REDIS_URL=redis://REDIS_HOST:6379/0
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

EMBEDDING_BASE_URL=http://embedding:18319/v1
EMBEDDING_PORT=18319
EMBEDDING_DIM=768
EMBEDDING_API_KEY=
EMBEDDING_MODEL=local-hash-zh-768
```

配置说明：

- `DATABASE_URL`：API / Prisma 连接业务库使用。
- `POSTGRES_ADMIN_URL`：`db:create` 连接管理库使用，用来创建 `DATABASE_NAME` 指定的业务库。
- `DATABASE_URL` / `POSTGRES_ADMIN_URL` 中密码包含 `&`、`^`、`@` 等特殊字符时，请先 URL encode。
- `LLM_*`：Agent 规划、章节生成、润色、导入/大纲预览的核心配置；未配置时相关功能会失败或拒绝执行。
- `EMBEDDING_*`：指向 Docker Compose 里的 `embedding` service API，用于 MemoryChunk 语义向量写入与 pgvector 召回；不可用时系统会降级为 JSON embedding 或关键词召回。
- `MINIO_*`：当前主链路预留，普通本地开发可保持默认。

Web 默认请求 `http://127.0.0.1:3001/api`。只有 API 地址或端口变化时，才需要创建 `apps/web/.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001/api
```

### 2.4 Embedding 服务

Embedding 不在 LLM 配置页面里维护。它是根目录 Docker Compose 里的 `embedding` service，API 容器通过 `.env` 中的 `EMBEDDING_BASE_URL=http://embedding:18319/v1` 调用这个服务。

如果你有外部 OpenAI-compatible embedding API，也可以把 `.env` 中的 `EMBEDDING_BASE_URL` 指向外部服务；默认开发环境使用 Compose 内置服务。

仓库历史文档中记录的启动方式是：创建一个独立的 Python 脚本 `/opt/embedding_server.py`，再用 systemd 启动 `embedding.service`。核心启动脚本如下：

```python
"""轻量 Embedding API 服务：兼容 OpenAI /v1/embeddings 格式。"""
from sentence_transformers import SentenceTransformer
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

model = SentenceTransformer("BAAI/bge-base-zh-v1.5")
app = FastAPI(title="Embedding Server")

class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str = "bge-base-zh"

@app.post("/v1/embeddings")
def create_embedding(req: EmbeddingRequest):
    texts = [req.input] if isinstance(req.input, str) else req.input
    vectors = model.encode(texts, normalize_embeddings=True).tolist()
    return {
        "object": "list",
        "model": "bge-base-zh-v1.5",
        "data": [
            {"object": "embedding", "embedding": vec, "index": i}
            for i, vec in enumerate(vectors)
        ],
        "usage": {
            "prompt_tokens": sum(len(t) for t in texts),
            "total_tokens": sum(len(t) for t in texts),
        },
    }

@app.get("/healthz")
def health():
    return {"status": "ok", "model": "BAAI/bge-base-zh-v1.5", "dimension": 768}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=18319)
```

如果需要重新部署这个服务，可按下面步骤操作：

```bash
apt install -y python3-pip
pip3 install sentence-transformers fastapi uvicorn
```

将上面的脚本保存为 `/opt/embedding_server.py`，然后创建 systemd 服务：

```ini
# /etc/systemd/system/embedding.service
[Unit]
Description=Embedding API Server
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/embedding_server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable embedding
systemctl start embedding
```

> 说明：历史文档中曾出现过 `8319` 示例端口，但当前代码与 `.env.example` 默认使用 `18319`。请以 `EMBEDDING_BASE_URL` 为准，脚本端口和环境变量必须保持一致。

API 容器默认按以下配置调用 Compose 内的 `embedding` service：

```env
EMBEDDING_BASE_URL=http://embedding:18319/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=local-hash-zh-768
```

启动要求：

1. 先启动 Compose 的 `embedding` service，并确保 API 容器内可访问 `EMBEDDING_BASE_URL`。
2. 服务必须提供 OpenAI-compatible 接口：`POST /v1/embeddings`。
3. 请求体需要支持 `{ "model": "local-hash-zh-768", "input": ["文本"] }`。这里的 `model` 是 embedding API 兼容参数，不是 LLM Provider 路由里的模型。
4. 返回体需要包含 `data[].embedding`，且当前 pgvector 迁移默认按 **768 维向量** 建索引。

可以用下面的请求确认宿主机是否能访问 Compose 暴露出来的 Embedding service：

```powershell
curl.exe http://127.0.0.1:18319/v1/embeddings `
  -H "Content-Type: application/json" `
  -d '{"model":"local-hash-zh-768","input":["测试文本"]}'
```

宿主机 curl 测试使用映射端口 `127.0.0.1:18319`；API 容器内部调用使用 Compose service 地址 `http://embedding:18319/v1`。如果服务启用了鉴权，再填写 `EMBEDDING_API_KEY`；本地 Compose 服务通常可以留空。

### 2.5 数据库建表脚本在哪里

数据库结构由 Prisma 管理：

| 类型 | 位置 | 作用 |
| --- | --- | --- |
| Prisma Schema | `apps/api/prisma/schema.prisma` | 数据模型定义。 |
| 建表/迁移 SQL | `apps/api/prisma/migrations/*/migration.sql` | 实际建表、改表、索引、扩展脚本。 |
| 建库脚本 | `scripts/dev/create_database.py` | 根据 `.env` 中 `DATABASE_NAME` 创建业务库。 |
| 默认 Prompt 种子 | `apps/api/prisma/seed.ts` | 写入默认大纲、章节生成、润色、写作风格 Prompt 模板。 |

重要迁移示例：

- `202604220001_init/migration.sql`：初始化核心表、枚举和 `pgcrypto` 扩展。
- `20260427004500_memory_pgvector_quality/migration.sql`：启用 `vector` 扩展、增加 `MemoryChunk.embeddingVector`、创建 HNSW 向量索引。
- `20260427002100_add_agent_trace_tables/migration.sql`：Agent Run / Plan / Step / Artifact / Approval 等追踪表。

---

## 3. 初始化：安装依赖与创建表结构

以下命令默认在仓库根目录执行。

### 3.1 安装 Node 依赖

```powershell
pnpm install
```

### 3.2 创建业务库并执行迁移

```powershell
pnpm db:create
pnpm db:generate
pnpm db:migrate
```

三条命令分别做什么：

1. `pnpm db:create`：读取根目录 `.env`，使用 `POSTGRES_ADMIN_URL` 连接 PostgreSQL，并创建 `DATABASE_NAME` 指定的业务库。
2. `pnpm db:generate`：根据 `schema.prisma` 生成 Prisma Client。
3. `pnpm db:migrate`：执行 `apps/api/prisma/migrations` 下的建表与迁移 SQL。

### 3.3 可选：写入默认 Prompt 模板

首次使用“提示词管理”“章节生成”“大纲生成”等能力时，建议执行一次种子脚本：

```powershell
pnpm --dir apps/api run prisma:seed
```

### 3.4 可选：确认 pgvector 扩展

如果使用本仓库 Docker 镜像 `pgvector/pgvector:pg16`，迁移会自动执行 `CREATE EXTENSION IF NOT EXISTS vector;`。如需手动确认：

```powershell
docker exec -it novel-postgres psql -U postgres -d ai_novel_mvp -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## 4. 服务层启动：命令、端口、配置

### 4.1 推荐启动方式

一个终端启动 Web + API：

```powershell
pnpm dev
```

该命令会并行启动：

| 服务 | 命令来源 | 默认地址 |
| --- | --- | --- |
| Web / Next.js | `apps/web/package.json` | `http://127.0.0.1:3000` |
| API / NestJS | `apps/api/package.json` | `http://127.0.0.1:3001/api` |

### 4.2 Docker Compose 全量开发启动

如果希望 Web、API、PostgreSQL、Redis、MinIO、Embedding 都由根目录 `docker-compose.yml` 编排，从仓库根目录运行：

```powershell
docker compose up
```

后台运行并查看 Web / API 日志：

```powershell
docker compose up -d
docker compose logs -f api web
```

根目录代码会挂载到容器内 `/workspace`。修改 `apps/api/src`、`apps/web` 等业务代码时，通常不需要重新 build；API 使用 Nest watch，Web 使用 Next dev，会按开发模式热更新。

修改依赖文件，例如 `package.json` 或 `pnpm-lock.yaml` 后，重新安装依赖并启动服务：

```powershell
docker compose up deps
docker compose up -d api web
```

修改 `docker-compose.yml`、内联 Dockerfile 或镜像构建相关内容后，重新构建启动：

```powershell
docker compose up --build -d
```

停止服务：

```powershell
docker compose down
```

不要随意执行 `docker compose down -v`；它会删除 PostgreSQL、Redis、MinIO 等数据卷。

### 4.3 分开启动

也可以用两个终端分别启动：

```powershell
pnpm dev:web
pnpm dev:api
```

等价 workspace 命令：

```powershell
pnpm --filter web dev
pnpm --filter api start:dev
```

### 4.4 端口与配置速查

| 端口 | 服务 | 配置来源 | 是否默认必用 |
| --- | --- | --- | --- |
| `3000` | Web | `apps/web/package.json` 中 `next dev -p 3000` 固定指定 | 是 |
| `3001` | API | `API_PORT`，未配置时 `apps/api/src/main.ts` 默认 `3001` | 是 |
| `5432` | PostgreSQL(pgvector) | 根目录 `docker-compose.yml` / `POSTGRES_PORT` | 是 |
| `6379` | Redis | 根目录 `docker-compose.yml` / `REDIS_PORT` | 是 |
| `9000` | MinIO API | 根目录 `docker-compose.yml` / `MINIO_API_PORT` | 否，当前预留 |
| `9001` | MinIO Console | 根目录 `docker-compose.yml` / `MINIO_CONSOLE_PORT` | 否，当前预留 |
| `8318` | LLM 示例端口 | `.env.example` 示例 | 按你的模型服务实际端口填写 |
| `18319` | Embedding 示例端口 | `.env.example` 示例 | 可选，按你的服务实际端口填写 |

注意：

- `WEB_PORT` 目前只是约定配置，Web dev 脚本固定 `3000`。如果要改 Web 端口，需要同步修改 `apps/web/package.json` 与 `NEXT_PUBLIC_API_BASE_URL`。
- API 启动时会设置全局前缀 `/api`，所以接口地址形如 `http://127.0.0.1:3001/api/projects`。
- Windows 开发模式下，API 启动逻辑会尝试释放占用 `API_PORT` 的旧进程，避免 watch 重启后端口残留。
- Embedding 是独立 Compose service；如果需要语义召回和向量写入，请在启动 API 前确认 `EMBEDDING_BASE_URL` 对应服务已经可访问。

### 4.5 Worker 是否需要启动

不需要。当前章节生成、润色、事实抽取、校验、记忆重建、MemoryWriter、Embedding/pgvector 召回和 Agent 执行都在 `apps/api` 内完成。

`apps/worker` 状态：

- 根目录不再提供 `dev:worker`。
- Docker Compose 不编排 Worker。
- API 不再通过 Worker internal route 执行主流程。
- 该目录仅用于对照旧 Python pipeline。

---

## 5. 最小自检

服务启动后，可先检查 API 与数据库是否连通：

```powershell
curl http://127.0.0.1:3001/api/projects
```

返回 `[]` 或项目列表，说明 API + PostgreSQL 基本可用。

Agent 服务轻量测试：

```powershell
pnpm --dir apps/api run test:agent
```

Agent Eval 门禁，包括 Planner、Retrieval、Replan：

```powershell
pnpm --dir apps/api run eval:agent:gate
```

真实数据上的 embedding 回填与召回验证，默认 dry-run，不会改写数据库：

```powershell
python scripts/dev/verify_embedding_retrieval.py --project-id <PROJECT_ID> --query "主角父亲遗物与祠堂线索"
```

确认需要回填时再追加 `--apply-backfill`。

---

## 6. 如何使用：从 0 到完成一章的教程

### 6.1 打开工作台

浏览器访问：

```text
http://127.0.0.1:3000
```

第一次进入默认是“项目”页。左侧栏底部的 **LLM 配置** 是全局入口，即使还没有项目也可以进入。

### 6.2 配置 LLM Provider

推荐先配置模型服务：

1. 点击左侧栏底部 **🔧 LLM 配置**。
2. 新增 OpenAI-compatible Provider。
3. 填写 `Base URL`、`API Key`、默认模型名。
4. 点击测试连接。
5. 按需配置 `guided`、`generate`、`polish` 等路由。

如果没有在页面配置 Provider，后端会尝试使用 `.env` 中的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 作为兜底配置。

### 6.3 创建项目

1. 点击左侧顶部 **项目**。
2. 在项目管理面板中创建新项目。
3. 填写小说标题、题材、主题、语气、简介等基础信息。
4. 创建成功后，选择该项目进入工作台。

### 6.4 使用创作引导生成项目基础资料

适合从一句话文案或粗略设定开始：

1. 进入左侧 **✨ 创作引导 (AI)**。
2. 输入故事文案、题材偏好、主角设定、世界观方向等。
3. 按步骤生成并确认项目资料、角色、世界观、卷纲、章节规划。
4. 确认写入后，可在 **剧情大纲 (Outline)**、**角色与设定 (Lore)**、**卷管理 (Volumes)** 中继续编辑。

### 6.5 手动维护大纲、角色与设定

常用入口：

- **剧情大纲 (Outline)**：维护项目主线、大纲、章节目标。
- **角色与设定 (Lore)**：维护角色、设定条目、世界观资料。
- **卷管理 (Volumes)**：维护卷、章节结构、章节顺序。
- **提示词管理 (Prompts)**：查看和调整默认 Prompt 模板。
- **伏笔看板 (Foreshadow)**：查看和追踪伏笔状态。

### 6.6 生成章节正文

有两种主要方式。

方式一：章节级直接生成

1. 在左侧章节树中选择目标章节。
2. 进入 **🤖 AI 生成 (Generate)**。
3. 选择生成范围和参数。
4. 执行生成后，系统会写入章节草稿。

方式二：Agent 工作台自然语言生成

1. 选中项目，必要时选中目标章节。
2. 点击页面右下角 **Agent 悬浮圆球**。
3. 输入自然语言目标，例如：

```text
帮我写第 12 章正文，压迫感强一点，字数 3500。
```

4. 系统先生成 Plan，展示理解、假设、风险、步骤和预览 Artifact。
5. 人工确认后进入 Act 执行。
6. 执行完成后查看时间线、Artifact、审计轨迹与最终报告。

### 6.7 审核事实层与记忆

章节生成后，右侧情报辅助台会展示事实层数据：

- 剧情事件。
- 角色状态快照。
- 伏笔轨迹。
- 记忆审核队列。
- 结构化事实校验问题。

常见操作：

1. 点击重建记忆，先 dry-run 查看 diff，再正式 rebuild。
2. 对记忆审核队列执行确认或拒绝。
3. 运行硬规则事实校验。
4. 对可修复问题使用 AI 一键修复，再重新 rebuild 与复检。

### 6.8 常用 Agent 目标示例

```text
帮我把第一卷拆成 30 章，每章要有目标、冲突和钩子。
这是我的小说文案，帮我拆成角色、世界观和前三卷大纲。
帮我检查当前大纲有没有剧情矛盾。
男主这里是不是人设崩了？
补充宗门体系，但不要影响已有剧情。
帮我重建当前章节记忆，并指出需要人工确认的条目。
```

Agent 执行约束：

- Plan 阶段只生成计划、预览和校验产物，不写正式业务表。
- Act 阶段必须经过用户确认。
- 内部 ID 不允许由 LLM 编造；章节、角色等引用会通过 Resolver 工具解析。
- Tool 失败会记录结构化 Observation，并由 Replanner 尝试最小修复或要求用户澄清。

---

## 7. 常用命令

| 命令 | 说明 |
| --- | --- |
| `docker compose up -d postgres redis minio embedding` | 只启动 PostgreSQL、Redis、MinIO、Embedding 等依赖服务。 |
| `docker compose up` | 使用根目录 Compose 前台启动全量开发环境。 |
| `docker compose up -d` | 使用根目录 Compose 后台启动全量开发环境。 |
| `docker compose logs -f api web` | 查看容器化 Web / API 开发日志。 |
| `docker compose up deps` | 依赖文件变化后，重新安装容器内 Node 依赖。 |
| `docker compose up --build -d` | Compose 镜像或构建配置变化后重新构建启动。 |
| `docker compose down` | 停止根目录 Compose 服务，保留数据卷。 |
| `pnpm install` | 安装 monorepo Node 依赖。 |
| `pnpm db:create` | 按 `.env` 创建业务数据库。 |
| `pnpm db:generate` | 生成 Prisma Client。 |
| `pnpm db:migrate` | 执行 Prisma 迁移建表。 |
| `pnpm --dir apps/api run prisma:seed` | 写入默认 Prompt 模板。 |
| `pnpm dev` | 同时启动 Web + API。 |
| `pnpm dev:web` | 只启动 Web。 |
| `pnpm dev:api` | 只启动 API。 |
| `pnpm --dir apps/api build` | 构建 API。 |
| `pnpm --dir apps/web build` | 构建 Web。 |
| `pnpm --dir apps/api run test:agent` | 运行 Agent 服务轻量测试。 |
| `pnpm --dir apps/api run eval:agent:gate` | 运行 Planner / Retrieval / Replan 评测门禁。 |
| `pnpm db:maintenance` | 执行数据库维护脚本，如 embedding backfill。 |

---

## 8. 常见问题

### 8.1 `pnpm db:create` 报 Python 模块缺失

安装脚本依赖：

```powershell
python -m pip install "psycopg[binary]" python-dotenv
```

然后重新执行：

```powershell
pnpm db:create
```

### 8.2 `pnpm db:migrate` 或 API 启动时报数据库连接错误

优先检查：

- 当前实际生效的根目录 `.env` 是否存在；README 中的连接串只是不含敏感信息的占位示例。
- `.env` 中的 `DATABASE_URL` 是否指向你实际使用的本地或远程 PostgreSQL。
- `POSTGRES_ADMIN_URL` 是否指向有建库权限的管理库连接，且密码中的 `&`、`^`、`@` 等特殊字符已经 URL encode。
- 如果连接远程 PostgreSQL，确认当前用户拥有目标数据库的 `CONNECT` 权限、`public` schema 的 `USAGE` 权限，以及迁移所需的建表 / 建索引权限。
- 如果连接本地 Docker PostgreSQL，再检查容器是否已启动并监听 `5432`，以及 `DATABASE_NAME` 指定的业务库是否已通过 `pnpm db:create` 创建。

### 8.3 章节生成或 Agent Act 报缺少 LLM 配置

这是预期保护。请至少完成一种配置方式：

1. 在 Web 的 **LLM 配置** 页面创建 Provider；或
2. 在 `.env` 中配置：

```env
LLM_BASE_URL=http://YOUR_LLM_HOST:8318/v1
LLM_API_KEY=YOUR_LLM_API_KEY
LLM_MODEL=gpt-5.4
```

### 8.4 Web 页面打开了，但请求不到 API

默认情况下 Web 请求 `http://127.0.0.1:3001/api`。如果 API 地址不是默认值，请创建或修改 `apps/web/.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://你的API地址/api
```

修改后重启 Web 服务。

### 8.5 改了 `WEB_PORT` 但 Web 端口没变

当前 Web dev 脚本固定使用 `3000`：

```text
next dev -p 3000
```

需要改端口时，请同步修改 `apps/web/package.json` 和前端 API 地址配置。

### 8.6 Redis 现在还需要吗

需要。Redis 当前用于缓存、锁、上下文暂存等辅助能力，不再承担 Worker 队列调度。

### 8.7 Embedding 服务没有启动会怎样

Embedding 服务是独立进程。如果没有启动，或 `EMBEDDING_BASE_URL` 配错，API 在写入章节记忆、回填向量或做语义召回时会请求失败，并进入降级路径。

请优先检查：

- Compose 的 `embedding` service 是否已启动。
- 端口是否与 `EMBEDDING_BASE_URL` 一致，默认示例是 `18319`。
- 接口是否兼容 `POST /v1/embeddings`。
- 向量维度是否与当前 pgvector 索引一致，默认 `EMBEDDING_DIM=768`。

当前降级路径：

1. 优先使用 pgvector SQL 检索。
2. pgvector 不可用时，降级为 JSON embedding + 应用层 cosine 相似度。
3. embedding 服务不可用时，降级为关键词召回。

---

## 9. 相关文档

- `docs/architecture/ai-novel-agent-intelligence-upgrade.md`：小说 Agent 智能化改造设计。
- `docs/architecture/agent-intelligence-upgrade-development-plan.md`：Agent 智能化改造开发计划。
- `docs/prompt-template-guide.md`：Prompt 模板指南。
- `docs/api/`：API 相关文档。
- `docs/database/`：数据库相关文档。
- `apps/worker/README.md`：历史 Worker 归档说明。
