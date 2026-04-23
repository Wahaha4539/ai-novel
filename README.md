# AI Novel System Scaffold

这是一个面向**长篇小说创作系统**的 monorepo MVP，目标是把设定 / 大纲 / 章节生成链路推进到**本地可跑通、可接真实数据库与真实模型网关**的状态。

当前脚手架包含：

- `apps/web`：Next.js + Tailwind 的最小前端骨架
- `apps/api`：NestJS 风格 API 服务，已切到 Prisma + PostgreSQL
- `apps/worker`：FastAPI + Python pipeline 服务，已切到真实 PostgreSQL + OpenAI-compatible 网关
- `packages/shared-types`：共享 DTO / 类型定义
- `packages/prompt-templates`：Prompt 模板占位
- `infra/docker`：Postgres(pgvector) / Redis / MinIO 本地开发编排
- `docs/`：架构、API、Pipeline、Prompt 规范文档

## 目录概览

```text
novel-system/
├─ apps/
│  ├─ web/
│  ├─ api/
│  └─ worker/
├─ packages/
│  ├─ shared-types/
│  └─ prompt-templates/
├─ infra/
│  └─ docker/
└─ docs/
```

## 当前实现范围

当前仓库仍然是 MVP，不是完整业务系统，但已经具备以下核心能力：

1. monorepo 结构
2. 关键领域对象与核心表模型
3. 章节生成链路的 API / Worker 边界
4. Prompt Builder、召回、校验、摘要、记忆回写的分层
5. `generate_chapter` 的真实数据库读写链路
6. OpenAI-compatible 模型网关接入
7. 基于 Redis 的章节生成任务队列（默认 `127.0.0.1:6379`）
8. Worker 侧对 `project snapshot`、`chapter context`、`lorebook/memory recall result` 的 Redis cache-aside

## 本地启动方案

> 以下命令默认在仓库根目录执行，示例以 **Windows PowerShell** 为主。
> 如果你使用 CMD，请将 `Copy-Item` 替换为 `copy`。

### 1. 启动前准备

本地跑通当前 MVP，建议先准备好以下依赖：

- Docker / Docker Desktop：用于启动 PostgreSQL、Redis、MinIO
- Node.js + pnpm：仓库声明的包管理器为 `pnpm@10.0.0`
- Python 3：用于 Worker 与开发脚本
- 一个可访问的 OpenAI-compatible 模型网关：用于章节生成链路

如果本机尚未启用 pnpm，可先执行：

```powershell
corepack enable
```

### 2. 启动基础设施

```powershell
docker compose -f infra/docker/docker-compose.yml up -d
```

默认会启动以下本地依赖：

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| PostgreSQL (pgvector) | `127.0.0.1:5432` | 主业务数据库 |
| Redis | `127.0.0.1:6379` | 任务队列与缓存 |
| MinIO API | `127.0.0.1:9000` | 预留的本地对象存储 |
| MinIO Console | `http://127.0.0.1:9001` | MinIO 管理后台 |

> `docker-compose.yml` 里的 PostgreSQL 默认库名是 `novel_system`，而应用真正使用的业务库由 `.env` 中的 `DATABASE_NAME` 决定，后续会通过脚本自动创建。

> 当前仓库里的 MinIO **还没有接入现有 MVP 主链路**。现在能看到的只是 Docker 编排与环境变量预留，仓库内 API / Worker / Web 代码目前没有实际读写 MinIO。也就是说，MinIO 更像是为后续对象存储场景预留的基础设施；当前你主要验证“项目 / 章节 / 生成 / 记忆 / 校验”链路时，核心依赖仍然是 PostgreSQL、Redis、LLM 网关。

### 3. 准备环境变量

当前仓库有两套启动时会实际读取的环境文件：

- 根目录 `.env`：给 `apps/worker` 与 `scripts/dev/*.py` 使用
- `apps/api/.env`：给 NestJS / Prisma 使用

先复制模板，再把 API 环境文件同步一份：

```powershell
Copy-Item .env.example .env
Copy-Item .env apps/api/.env
```

如果你使用 `infra/docker/docker-compose.yml` 里的默认本地端口，建议先把两份环境文件至少改成下面这些值：

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
WORKER_BASE_URL=http://127.0.0.1:8000
LLM_BASE_URL=http://YOUR_LLM_HOST:8318/v1
LLM_API_KEY=YOUR_LLM_API_KEY
LLM_MODEL=gpt-5.4
```

补充说明：

- `apps/api/.env` 与根目录 `.env` 中的数据库、Redis、Worker 地址建议保持一致
- `WORKER_BASE_URL` 必须能被 API 访问到，否则章节生成与 memory rebuild 无法回调 Worker
- Redis 默认连接为 `redis://127.0.0.1:6379/0`，如本机地址不同，请同步修改 `REDIS_URL`
- `MINIO_*` 变量目前属于预留配置，当前代码未实际消费；先保留默认值即可
- 如果 PostgreSQL 密码包含 `&`、`^` 等特殊字符，必须先做 URL encode 再写进连接串
- 当前 `web` 默认直接回退到 `http://127.0.0.1:3001/api`，只有在你修改 API 地址或端口时，才需要额外创建 `apps/web/.env.local`

如果你改了 API 地址或端口，可选地新增：

```env
# apps/web/.env.local
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001/api
```

### 4. 安装依赖

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/worker/requirements.txt
```

> 如果你已经手动激活了虚拟环境，那么下面 README 中出现的 `.\.venv\Scripts\python.exe` 都可以直接替换成 `python`。

### 5. 初始化数据库

```powershell
.\.venv\Scripts\python.exe scripts/dev/create_database.py
pnpm db:generate
pnpm db:migrate
```

这一步会完成三件事：

1. `create_database.py` 只负责按 `.env` 中的 `DATABASE_NAME` 创建业务数据库（不存在时才创建），**不会建表**
2. `pnpm db:generate` 生成 Prisma Client
3. `pnpm db:migrate` 执行 `apps/api/prisma/migrations` 下已有迁移，真正创建 / 补齐表结构

当前仓库里，表结构初始化主要由两次迁移共同完成：

- `202604220001_init`：创建第一批核心表与枚举，包括 `Project`、`StyleProfile`、`ModelProfile`、`Character`、`LorebookEntry`、`Chapter`、`ChapterDraft`、`MemoryChunk`、`ValidationIssue`、`GenerationJob`
- `202604220002_phase2_memory_facts`：补充 `MemoryChunk` 的字段 / 索引，并新增 `StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack`

按当前 `schema.prisma` 对照，**现有两次 migration 合起来已覆盖全部 13 个核心业务模型**。也就是说：只要 `pnpm db:migrate` 正常执行完成，当前 Prisma schema 对应的业务表就会完整创建出来。

#### 安装 pgvector 扩展（向量检索，可选）

Worker 的 MemoryChunk 表预留了 `embedding` 字段，用于向量语义检索。如需启用，需要在 PostgreSQL 中安装 pgvector 扩展。

**方式一：Docker 环境（已内置）**

`docker-compose.yml` 使用的 `pgvector/pgvector:pg16` 镜像已内置 pgvector，只需启用：

```powershell
docker exec -it novel-postgres psql -U postgres -d ai_novel_mvp -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

**方式二：远程服务器（Ubuntu + 系统安装的 PostgreSQL）**

SSH 到服务器后执行：

```bash
# 安装 pgvector 包（将 14 替换为你的 PostgreSQL 大版本号）
sudo apt update && sudo apt install -y postgresql-14-pgvector

# 重启 PostgreSQL
sudo systemctl restart postgresql

# 在目标数据库中启用扩展
sudo -u postgres psql -d ai_novel_mvp -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

> 查看 PostgreSQL 版本：`psql --version` 或 `SELECT version();`

**验证安装：**

```bash
sudo -u postgres psql -d ai_novel_mvp -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

输出含 `vector | 0.x.x` 即安装成功。

#### 部署 Embedding 服务（向量检索，可选）

MemoryChunk 的向量语义检索需要 embedding 模型将文本转换为向量。当前 LLM API 不提供 `/v1/embeddings` 端点，需要单独部署一个轻量 embedding 服务。

> 模型 `BAAI/bge-base-zh-v1.5`，约 400MB，**纯 CPU 即可运行**，无需 GPU。

**第 1 步：安装依赖**

```bash
apt install -y python3-pip
pip3 install sentence-transformers fastapi uvicorn
```

**第 2 步：创建服务文件**

```bash
cat > /opt/embedding_server.py << 'EOF'
"""轻量 Embedding API 服务 — 兼容 OpenAI /v1/embeddings 格式"""
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
        "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
    }

@app.get("/healthz")
def health():
    return {"status": "ok", "model": "BAAI/bge-base-zh-v1.5", "dimension": 768}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=18319)
EOF
```

**第 3 步：配置 systemd 开机自启**

```bash
cat > /etc/systemd/system/embedding.service << 'EOF'
[Unit]
Description=Embedding API Server
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/embedding_server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable embedding
systemctl start embedding
```

> 首次启动会自动下载模型（约 400MB），之后使用本地缓存。

**第 4 步：验证**

```bash
curl -X POST http://localhost:8319/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "测试文本"}' | python3 -m json.tool | head -5
```

返回含 768 维的 `embedding` 数组即安装成功。

**第 5 步：配置环境变量**

在项目 `.env` 中添加：

```env
EMBEDDING_BASE_URL=http://YOUR_SERVER_IP:8319/v1
```


如果你想进一步确认是否已经真实落库，可以在数据库启动后执行下面任一方式检查：

```powershell
pnpm --filter api exec prisma migrate status
pnpm --filter api exec prisma studio
```

也可以直接在 PostgreSQL 中确认这些表是否存在：

- `Project`
- `StyleProfile`
- `ModelProfile`
- `Character`
- `LorebookEntry`
- `Chapter`
- `ChapterDraft`
- `MemoryChunk`
- `StoryEvent`
- `CharacterStateSnapshot`
- `ForeshadowTrack`
- `ValidationIssue`
- `GenerationJob`

### 6. 启动本地服务

推荐使用 **2 个终端**：

#### 终端 A：同时启动 Web + API

```powershell
pnpm dev
```

该命令等价于同时执行：

- `pnpm --filter web dev`
- `pnpm --filter api start:dev`

#### 终端 B：启动 Worker

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir apps/worker --reload --host 127.0.0.1 --port 8000
```

如果你更习惯分别启动，也可以使用：

```powershell
pnpm --filter web dev
pnpm --filter api start:dev
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir apps/worker --reload --host 127.0.0.1 --port 8000
```

### 7. 启动后访问地址

- Web：`http://127.0.0.1:3000`
- API Base：`http://127.0.0.1:3001/api`
- Worker 健康检查：`http://127.0.0.1:8000/healthz`
- MinIO Console：`http://127.0.0.1:9001`

### 8. 自检建议

服务都起来后，建议至少做一次最小验证：

```powershell
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:3001/api/projects
```

- `Worker /healthz` 返回 `{"status":"ok"}` 说明 Worker 正常
- `GET /api/projects` 能返回 `[]` 或项目列表，说明 API + 数据库链路基本可用

如果你已经配置了真实的 `LLM_BASE_URL` / `LLM_API_KEY`，还可以继续执行验证脚本：

```powershell
.\.venv\Scripts\python.exe scripts/dev/verify_mvp.py
.\.venv\Scripts\python.exe scripts/dev/verify_idempotency.py
```

建议在 **API / Worker 已经手动启动** 后再运行这两个脚本。因为当 API 未启动时，`verify_mvp.py` 会尝试使用 `apps/api/dist/main.js` 拉起 API，此时需要你额外先执行一次：

```powershell
pnpm --filter api build
```

### 9. 常见问题

#### 1) `pnpm db:migrate` 或 API 启动时报数据库连接错误

优先检查：

- `apps/api/.env` 是否存在
- `apps/api/.env` 里的 `DATABASE_URL` 是否和根目录 `.env` 保持一致
- PostgreSQL 容器是否已经启动并监听 `5432`

#### 2) Worker 启动正常，但一生成章节就报 `缺少 LLM_API_KEY`

这是预期保护逻辑。当前 Worker 接的是**真实 OpenAI-compatible 网关**，没有可用的 `LLM_API_KEY` 时，章节生成链路不会继续执行。

#### 3) Web 页面打开了，但请求打不到 API

如果你没有使用默认 `3001` 端口，请显式创建 `apps/web/.env.local` 并设置：

```env
NEXT_PUBLIC_API_BASE_URL=http://你的API地址/api
```

#### 4) 改了 `.env` 里的 `WEB_PORT` / `WORKER_PORT`，但服务端口没变化

当前仓库的启动命令里：

- `web` 脚本固定使用 `3000`
- `worker` 示例命令固定使用 `8000`

也就是说，这两个环境变量目前更像“约定值”，并不会自动改掉启动命令。若你需要改端口，请同时调整：

- 实际启动命令里的 `--port`
- `WORKER_BASE_URL`
- `apps/web/.env.local` 中的 `NEXT_PUBLIC_API_BASE_URL`（如果 API 地址也变了）

## 关键接口

- `POST /api/projects`
- `GET /api/projects/:projectId`
- `POST /api/projects/:projectId/chapters`
- `POST /api/chapters/:chapterId/generate`
- `GET /api/jobs/:jobId`
- `POST /internal/jobs/generate-chapter`

## 当前 MVP 链路

当前可验证的主链路为：

1. 创建项目
2. 创建章节
3. 调用章节生成接口
4. API 先把生成任务写入 PostgreSQL，并投递到 Redis 队列
5. Worker 优先走 Redis cache-aside 读取 `project snapshot`、`chapter context`、`lorebook/memory recall result`，未命中时回源 PostgreSQL
6. 调用 OpenAI-compatible 模型网关生成正文
7. 回写 `ChapterDraft` / `ValidationIssue` / `MemoryChunk`

缓存更新策略：

- 项目创建后回写 `project snapshot` 缓存
- 章节创建 / drafted 状态更新后回写对应 `chapter context` 缓存
- 角色新增后失效该项目全部 `chapter context` 缓存
- lorebook / memory 更新后失效该项目的 recall result 缓存

## 后续建议

优先继续补齐以下内容：

1. Redis 队列补重试 / 死信 / 可观测性
2. 独立 Worker Consumer（BullMQ / Redis Streams 等）
3. Scenes / Drafts / Rollback / Diff 接口补齐
4. Lorebook / Memory / Validation 面板联调
5. OpenAPI 自动生成与端到端测试
