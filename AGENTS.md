# Agent Instructions

## 高质量输出与失败处理

项目以小说内容质量优先。凡是会进入审批、写入或后续生成链路的小说内容与规划输出，包括章节正文、卷/章节细纲、Chapter.craftBrief、场景卡、设定、导入资产预览等，都不得用低质量的确定性模板、占位骨架、简单拼接或“先补齐再人工复核”的 fallback 来掩盖 LLM 失败。

如果 LLM 调用失败、超时、返回 JSON 结构不完整、章节数量不足、编号不连续、关键字段缺失或 craftBrief 不完整，应直接报错并让调用方重试、缩小范围或补充上下文；不要静默降级生成可写入/可审批的内容。

实现或修改生成类工具时，必须把“失败即失败”写入代码和测试：

- 不为小说内容生成确定性占位章节、占位执行卡或模板剧情。
- 不在 normalize/merge 阶段偷偷补齐缺失章节、缺失字段或缺失 craftBrief。
- 对章节数、chapterNo、volumeNo、volume.chapterCount、必要文本字段和 craftBrief 必填字段做显式校验。
- 测试应覆盖超时/失败直接抛错、返回数量不足直接抛错、关键字段缺失直接抛错。

只有不影响小说内容质量、不会进入审批或写入链路的基础设施容错，才可以保留保守 fallback；例如日志、诊断、检索候选退化等，但必须在输出中清楚标记风险。

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

## Bug 修复排查

处理 bug 修复类任务时，优先从日志和代理运行记录中寻找问题线索；日志排查优先查看根目录 Docker Compose 管理的服务日志。

推荐先执行：

```bash
docker compose logs
```

如需聚焦某个服务，再执行：

```bash
docker compose logs <service>
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
