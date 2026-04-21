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
4. Worker 从 PostgreSQL 读取项目 / 章节 / 角色 / lorebook / memory
5. 调用 OpenAI-compatible 模型网关生成正文
6. 回写 `ChapterDraft` / `ValidationIssue` / `MemoryChunk`

## 后续建议

优先继续补齐以下内容：

1. Worker 队列（Celery / Arq / Dramatiq 三选一）
2. API 到 Worker 的异步任务投递
3. Scenes / Drafts / Rollback / Diff 接口补齐
4. Lorebook / Memory / Validation 面板联调
5. OpenAPI 自动生成与端到端测试
