# AI Novel

AI Novel 是一个面向长篇小说创作的 Web 工作台。当前主要运行方式是根目录 `docker-compose.yml`：由 Docker Compose 统一启动 Web、API、PostgreSQL(pgvector)、Redis、MinIO 和 Embedding 服务。

## 快速启动

在仓库根目录执行：

```powershell
docker compose up -d --build
```

启动后访问：

- Web：`http://127.0.0.1:3000`
- API：`http://127.0.0.1:3001/api`

查看服务状态：

```powershell
docker compose ps
```

查看日志：

```powershell
docker compose logs -f api web
```

停止服务：

```powershell
docker compose down
```

如果需要干净重启：

```powershell
docker compose down
docker compose up -d --build
```

> 不要随意执行 `docker compose down -v`。该命令会删除 PostgreSQL、Redis、MinIO 等服务的数据卷。

## 环境配置

首次启动前可以复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

最常见需要修改的是 LLM 配置：

```env
LLM_BASE_URL=http://YOUR_LLM_HOST:8318/v1
LLM_API_KEY=YOUR_LLM_API_KEY
LLM_MODEL=gpt-5.4
```

Docker Compose 会为容器内服务注入默认的数据库、Redis、MinIO 和 Embedding 地址。普通本地开发通常不需要手动安装 Node 依赖，也不需要单独执行 `pnpm dev`。

## 服务与端口

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Web | `http://127.0.0.1:3000` | Next.js 前端工作台 |
| API | `http://127.0.0.1:3001/api` | NestJS 后端接口 |
| PostgreSQL(pgvector) | `127.0.0.1:5432` | 主业务数据库和向量检索 |
| Redis | `127.0.0.1:6379` | 缓存、锁和上下文暂存 |
| MinIO API | `http://127.0.0.1:9000` | 对象存储 |
| MinIO Console | `http://127.0.0.1:9001` | MinIO 管理界面 |
| Embedding | `http://127.0.0.1:18319` | 本地 Embedding 服务映射端口 |

端口可以通过 `.env` 中的 `WEB_PORT`、`API_PORT`、`POSTGRES_PORT`、`REDIS_PORT`、`MINIO_API_PORT`、`MINIO_CONSOLE_PORT`、`EMBEDDING_PORT` 调整。

## Compose 启动内容

`docker compose up -d --build` 会启动以下服务：

- `deps`：安装 monorepo 依赖。
- `postgres`：PostgreSQL 17 + pgvector。
- `redis`：Redis 7。
- `minio`：本地对象存储。
- `embedding`：Hugging Face text-embeddings-inference。
- `api`：NestJS API，启动时会执行 Prisma generate 和 migrate。
- `web`：Next.js 开发服务。

代码目录会挂载进容器，修改 `apps/api/src` 或 `apps/web` 后通常会自动热更新。

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 启动全部服务 | `docker compose up -d --build` |
| 查看服务状态 | `docker compose ps` |
| 查看 Web/API 日志 | `docker compose logs -f api web` |
| 查看所有日志 | `docker compose logs -f` |
| 停止服务 | `docker compose down` |
| 干净重启 | `docker compose down && docker compose up -d --build` |
| 重新安装容器内依赖 | `docker compose up deps` |
| 重新构建并启动 | `docker compose up -d --build` |
| 执行 API 容器命令 | `docker compose exec api <command>` |
| 执行 Web 容器命令 | `docker compose exec web <command>` |

## 初始化数据

数据库迁移会在 API 容器启动时自动执行：

```text
pnpm db:generate
pnpm db:migrate
```

如需写入默认 Prompt 模板：

```powershell
docker compose exec api pnpm --dir apps/api run prisma:seed
```

## 自检

检查 API 是否可访问：

```powershell
curl http://127.0.0.1:3001/api/projects
```

如果返回 `[]` 或项目列表，说明 Web/API/数据库链路基本可用。

运行 Agent 轻量测试：

```powershell
docker compose exec api pnpm --dir apps/api run test:agent
```

运行 Agent Eval 门禁：

```powershell
docker compose exec api pnpm --dir apps/api run eval:agent:gate
```

## Web 测试约定

进行 Web、UI 或浏览器端真实测试时，使用根目录 Docker Compose 启动程序：

```powershell
docker compose ps
docker compose up -d --build
```

如果已有旧容器运行且需要干净环境：

```powershell
docker compose down
docker compose up -d --build
```

默认不要用本机 `pnpm --dir apps/web dev` 或单独的前端 dev server 代替 Compose 环境。

## 本地 pnpm 命令

以下命令主要用于调试或在容器内执行，不作为推荐启动方式：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动本机 Web 和 API |
| `pnpm dev:web` | 仅启动本机 Web |
| `pnpm dev:api` | 仅启动本机 API |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:migrate` | 执行 Prisma 迁移 |
| `pnpm db:maintenance` | 执行数据库维护脚本 |

## 常见问题

### Web 打开后请求不到 API

默认 Web 请求 `http://127.0.0.1:3001/api`。如果改了 API 端口或地址，请同步设置：

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001/api
```

然后重新启动：

```powershell
docker compose up -d --build web
```

### LLM 功能不可用

章节生成、润色、Agent Plan/Act 等功能需要可用的 OpenAI-compatible LLM 服务。请检查 `.env`：

```env
LLM_BASE_URL=http://YOUR_LLM_HOST:8318/v1
LLM_API_KEY=YOUR_LLM_API_KEY
LLM_MODEL=gpt-5.4
```

### Embedding 启动较慢

`embedding` 首次启动可能需要下载模型。可以查看日志：

```powershell
docker compose logs -f embedding
```

容器内 API 默认访问：

```env
EMBEDDING_BASE_URL=http://embedding/v1
```

宿主机访问映射端口：

```text
http://127.0.0.1:18319
```

### 数据库连接异常

优先检查：

- `docker compose ps` 中 `postgres` 是否 healthy。
- `.env` 中是否覆盖了数据库相关变量。
- API 日志中是否有 Prisma migrate 或连接错误。

查看 API 日志：

```powershell
docker compose logs -f api
```

## 项目结构

```text
ai-novel/
├── apps/
│   ├── web/        # Next.js 前端
│   └── api/        # NestJS API 与 Agent Runtime
├── packages/       # 共享类型与 Prompt 模板
├── scripts/        # 开发、维护、评测脚本
├── docs/           # 架构、API、数据库等文档
└── docker-compose.yml
```
