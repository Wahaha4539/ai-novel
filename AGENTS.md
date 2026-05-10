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

## 程序校验与语义判断边界

进入审批、写入或后续生成链路的小说内容，不得用程序关键词、正则黑名单或简单文本匹配来判定复杂创作语义并阻断或改写结果；例如“角色是否重要/长期”“剧情功能是否主线”“关系是否长期变化”“主题表达是否成立”等。程序做不好这类判断时，不要伪装成确定性质量门禁。

生成类工具的后端校验只应检查可确定的结构事实：JSON 类型、必填字段、枚举值、编号连续性、章节数量、引用是否存在、source 是否在白名单、显式审批字段是否合法等。若确实需要语义判断，应让 LLM 在生成或修复阶段给出显式结构化结论（例如 `approvalPolicy: "needs_approval"`、风险说明或候选角色规划），后端只校验这些显式字段的结构与引用，不用关键词二次猜测。

章节细纲、Chapter.craftBrief、场景卡等生成质量需要语义门禁时，应把判定标准写成 LLM rubric，并让 LLM 返回结构化 `valid/issues`。例如批量章节细纲应在每个 batch 生成后立即由 LLM 判断该批章节是否可直接写正文：outline 是否有可执行场景链，actionBeats 是否有具体人物/可见动作/对象/阻力/结果，sceneBeats 是否能落到地点、参与者、动作、阻力、转折、结果和感官锚点，连续性字段是否能接住前后章节。未通过的 batch 可把 LLM 给出的 failed points 传回去重生成一次；重试仍未通过则失败，不要由程序关键词改判或补写。

关键词或启发式规则只可用于不影响小说内容审批/写入的低风险场景，例如日志分类、诊断提示、检索候选排序、UI 展示标签或测试断言；若可能影响审批、写入、持久化或后续生成输入，必须改为 LLM 语义判断 + 显式结构字段 + 后端结构校验。

## 长章节细纲批次校验位置

长章节细纲、卷细纲或 60 章级别的批次生成链路，不得把全量 `validate_outline` 作为所有批次完成后的末尾兜底闸门。章节数、`chapterCount`、`chapterRange` 覆盖、批次是否连续、merge 引用是否完整、写入步骤是否审批等确定性问题，必须在 PlanValidator 或批次切分步骤中前置失败；不要让用户跑完整个批次后才在最后一关发现计划形状错误。

目标 `chapterCount` 与上下文里目标卷的 `Volume.chapterCount` 不一致时，属于确定性的 Plan 内容一致性问题，应在 PlanValidator 阶段失败。正确计划必须先重建 `generate_volume_outline_preview(chapterCount=N)` 和匹配的 `generate_story_units_preview`，并把上游 `volumeOutline` / `storyUnitPlan` 明确传给后续 `segment_chapter_outline_batches`、每个 `generate_chapter_outline_batch_preview` 和 merge 步骤；不得等到执行到末尾才由写入或最终校验报错。

每个 `generate_chapter_outline_batch_preview` 必须在本批次内完成结构校验、LLM rubric 质量判断和必要的一次重生；`merge_chapter_outline_batch_previews` 只负责合并已经通过的批次，并做章节覆盖、重复编号、craftBrief 完整性、角色引用等确定性结构保护。若每个批次都已通过，且 merge 通过，则后续应直接进入审批写入，不要再追加终局 `validate_outline` 造成不可局部修复的失败点。

如果未来确实需要全卷级质量判断，必须设计为可定位到章节/批次并能只重跑受影响批次的显式流程，不能以“最终 validate 失败”为代价让用户重跑整卷。

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
