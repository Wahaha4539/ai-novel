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

## 快速开始

### 1. 启动基础设施

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

### 2. 创建环境变量

先复制环境变量模板：

```bash
copy .env.example .env
copy .env.example apps\api\.env
```

然后将 `.env` 与 `apps/api/.env` 中的数据库密码、模型 key 等改成你自己的真实值。

Redis 默认连接为 `redis://127.0.0.1:6379/0`，如本机地址不同，请同步修改 `REDIS_URL`。
缓存 TTL 也可通过 `CACHE_PROJECT_SNAPSHOT_TTL_SECONDS`、`CACHE_CHAPTER_CONTEXT_TTL_SECONDS`、`CACHE_RECALL_RESULT_TTL_SECONDS` 调整。

> 注意：如果 PostgreSQL 密码包含 `&`、`^` 等特殊字符，必须先做 URL encode 再写进连接串。

### 3. 前端 / API / Worker 安装依赖

```bash
pnpm install
python -m venv .venv
.venv\\Scripts\\activate
pip install -r apps/worker/requirements.txt
```

### 4. 初始化数据库

```bash
python scripts/dev/create_database.py
pnpm db:generate
pnpm db:migrate
```

### 5. 启动服务

```bash
pnpm --filter web dev
pnpm --filter api start:dev
uvicorn main:app --app-dir apps/worker --reload --port 8000
```

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
