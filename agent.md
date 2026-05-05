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
