# Agent Instructions

## 启动方式

项目使用 Docker Compose 启动：

```bash
docker compose up -d --build
```

## 真实测试

如果要做真实测试，先检查 Docker Compose 是否已有容器在运行：

```bash
docker compose ps
```

如果已有容器在运行，先关闭现有容器：

```bash
docker compose down
```

然后重新构建并后台启动服务：

```bash
docker compose up -d --build
```

## Web 测试

进行 Web、UI 或浏览器端真实测试时，必须使用根目录 Docker Compose 启动程序；默认不要用本机 `pnpm --dir apps/web dev` 或单独的前端 dev server 代替。

推荐流程：

```bash
docker compose ps
docker compose up -d --build
```

如果需要干净重启，再执行：

```bash
docker compose down
docker compose up -d --build
```
