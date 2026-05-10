# 章节细纲上下文驱动流程开发设计文档

> 状态：新流程设计草案
> 日期：2026-05-11
> 范围：Agent 工作台章节细纲计划、章数来源、storyUnitPlan 承接、批次生成、质量校验、审批写入
> 目标：让章节细纲默认承接已审批卷大纲的 `Volume.chapterCount` 和 `Volume.narrativePlan.storyUnitPlan`，同时禁止程序用自然语言正则猜测目标章数或静默补内容。

## 1. 背景

项目的推荐创作顺序是：

```text
先生成并审批卷大纲
再基于卷大纲生成章节细纲
再基于章节细纲 / Chapter.craftBrief 写正文
```

因此，用户说：

```text
帮我生成第一卷的章节细纲。
```

时，系统不应该要求用户再次指定“多少章”。目标章数应来自已经确定的卷级规划：

- `Volume.chapterCount`
- `Volume.narrativePlan.storyUnitPlan.chapterAllocation`
- `Volume.narrativePlan.characterPlan`

只有用户明确提出“重拆成 N 章 / 改成 N 章 / 这一卷做 N 章 / 重新规划章数”时，才进入改变目标章数的流程。这个改变必须由 LLM Planner 在结构化 JSON 中表达，而不是由后端正则从自然语言中猜。

## 2. 非目标

- 不让用户在普通章节细纲请求中手工输入章数。
- 不用程序关键词或正则判断“第 N 章”到底是 `chapterNo` 还是 `chapterCount`。
- 不在章节细纲、storyUnitPlan、craftBrief 缺失时生成占位骨架。
- 不把长卷批次的全量 `validate_outline` 放在所有 batch 完成之后作为终局兜底。
- 不把 `Volume.chapterCount` 当成永远不可变的事实；它是已审批卷纲的默认目标，只在用户未明确要求改章数时生效。

## 3. 核心原则

### 3.1 默认章数来源是卷大纲

章节细纲默认使用目标卷上下文中的 `Volume.chapterCount`。这是正常流程，不是错误 fallback。

示例：

```text
用户：帮我生成第一卷的章节细纲。
上下文：Volume 1.chapterCount = 60，storyUnitPlan 覆盖 1..60
计划：按 60 章生成章节细纲
```

这里的 `chapterCount=60` 来自已审批卷大纲，不来自用户自然语言数字解析。

### 3.2 用户明确改章数时，必须重建上游规划

示例：

```text
用户：把第一卷重拆成 45 章细纲。
上下文：Volume 1.chapterCount = 60
```

正确计划必须先生成新的上游规划：

```text
inspect_project_context
generate_volume_outline_preview(chapterCount=45)
generate_story_units_preview(volumeOutline={{steps.2.output.volume}}, chapterCount=45)
segment_chapter_outline_batches(volumeOutline={{steps.2.output.volume}}, storyUnitPlan={{steps.3.output.storyUnitPlan}}, chapterCount=45)
generate_chapter_outline_batch_preview(...)
merge_chapter_outline_batch_previews(volumeOutline={{steps.2.output.volume}}, chapterCount=45)
persist_outline
```

如果计划直接拿旧 `Volume.chapterCount=60` 生成 45 章，或直接拿旧 storyUnitPlan 拆 45 章，应在 PlanValidator 阶段失败。

### 3.3 数字语义由 LLM Planner 输出结构化字段

程序可以解析 LLM 返回的 JSON 字段：

```json
{
  "target": {
    "volumeNo": 1,
    "chapterNo": null,
    "chapterCount": 45,
    "chapterCountSource": "user_explicit"
  }
}
```

程序不应该从下面这类自然语言里用正则判断数字含义：

```text
第 3 章细纲
3 章细纲
拆成 3 章
第 3 卷 60 章细纲
```

LLM Planner 负责把自然语言意图转成 `chapterNo`、`chapterCount`、`volumeNo` 和具体工具参数；后端只校验这些结构化字段是否一致、合法、覆盖完整。

### 3.4 程序校验只做确定性结构判断

后端可校验：

- JSON 类型和必填字段。
- `volumeNo`、`chapterNo`、`chapterCount` 为正整数。
- 章节编号连续覆盖目标范围。
- `chapterRange` 不缺章、不重叠、不越界。
- `Volume.chapterCount` 与计划目标一致。
- `storyUnitPlan.chapterAllocation` 覆盖 `1..chapterCount`。
- `craftBrief` 必填字段存在。
- 角色引用来源在白名单内。
- 写入工具必须审批。

后端不做：

- “这个角色是否长期重要”的关键词判断。
- “这个剧情功能是否主线”的正则判断。
- “这段 outline 是否有文学质量”的程序关键词判断。
- 自然语言数字含义推断。

需要语义质量判断时，应交给 LLM rubric，并返回结构化 `valid/issues`。

## 4. 章数来源契约

### 4.1 推荐字段

后续 Planner JSON 可逐步引入显式目标字段：

```ts
interface OutlineChapterTarget {
  volumeNo: number;
  chapterNo?: number;
  chapterCount?: number;
  chapterCountSource:
    | 'context_volume'
    | 'generated_volume'
    | 'user_explicit'
    | 'planner_unspecified';
}
```

其中：

- `context_volume`：用户没有要求改章数，使用已审批 `Volume.chapterCount`。
- `generated_volume`：当前计划先生成或重建了卷大纲，使用该预览中的 `volume.chapterCount`。
- `user_explicit`：用户明确要求 N 章，LLM Planner 在结构化计划中输出了 N。
- `planner_unspecified`：Planner 未能明确章数来源，应失败或要求补上下文。

### 4.2 PlanValidator 目标章数解析顺序

PlanValidator 应按以下顺序确定目标章数：

1. 当前计划中 `generate_volume_outline_preview.args.chapterCount` 或 `generate_story_units_preview.args.chapterCount` 明确给出的目标章数。
2. 章节细纲步骤中的一致 `args.chapterCount`。
3. 若计划没有明确章数，并且目标卷上下文存在 `Volume.chapterCount`，使用 `Volume.chapterCount` 作为 `context_volume`。
4. 若仍无法确定，失败；不要放行到工具执行阶段。

注意：上下文 `Volume.chapterCount` 是默认来源，但不能掩盖同一计划中明确给出的不同 `chapterCount`。如果二者不一致，计划必须包含匹配的上游重建步骤。

### 4.3 route 字段只做路由提示

Supervisor 可以判断“这是章节细纲目标”，但不应把正则或上下文猜出的数字作为权威 `route.chapterCount` 压过计划。

建议把当前 `route.chapterCount` 语义改为以下之一：

- `route.contextChapterCountHint`
- `route.fallbackChapterCount`
- `routeHints.chapterCount`

Planner 和 PlanValidator 可以读取它作为上下文提示，但最终工具参数以 LLM Planner 的结构化计划和目标卷上下文一致性为准。

## 5. 标准流程

### 5.1 基于已审批卷大纲生成整卷章节细纲

适用场景：

```text
帮我生成第一卷的章节细纲。
生成本卷章节规划。
按第一卷卷纲出章节细纲。
```

前置条件：

- 目标卷存在。
- `Volume.chapterCount` 存在。
- `Volume.narrativePlan.characterPlan` 完整。
- `Volume.narrativePlan.storyUnitPlan.chapterAllocation` 覆盖 `1..chapterCount`。

长卷推荐计划：

```text
inspect_project_context
segment_chapter_outline_batches(context={{steps.1.output}}, volumeNo=1, chapterCount=<Volume.chapterCount>)
generate_chapter_outline_batch_preview(...每个 chapterRange...)
merge_chapter_outline_batch_previews(...)
persist_outline
```

如果没有 `storyUnitPlan.chapterAllocation`，不要盲切 batch。Planner 应先生成可审批的 `generate_story_units_preview`，并把输出显式传给后续步骤；如果当前写入链路无法把新 storyUnitPlan 合并进最终 `volume.narrativePlan`，则应先实现该传递能力，或失败提示先补齐单元故事。

### 5.2 改变章数的重规划流程

适用场景：

```text
把第一卷改成 45 章细纲。
第一卷重新拆成 30 章。
```

必需步骤：

```text
inspect_project_context
generate_volume_outline_preview(chapterCount=N)
generate_story_units_preview(volumeOutline={{steps.2.output.volume}}, chapterCount=N)
segment_chapter_outline_batches(volumeOutline={{steps.2.output.volume}}, storyUnitPlan={{steps.3.output.storyUnitPlan}}, chapterCount=N)
generate_chapter_outline_batch_preview(volumeOutline={{steps.2.output.volume}}, storyUnitPlan={{steps.3.output.storyUnitPlan}}, ...)
merge_chapter_outline_batch_previews(volumeOutline={{steps.2.output.volume}}, chapterCount=N)
persist_outline
```

确定性失败条件：

- N 与上下文 `Volume.chapterCount` 不一致，但没有 `generate_volume_outline_preview(chapterCount=N)`。
- 有重建卷纲，但没有匹配的 `generate_story_units_preview(chapterCount=N)`。
- 下游 segment、batch、merge 没有传入新 `volumeOutline` 或 `storyUnitPlan`。
- batch ranges 未覆盖 `1..N`。

### 5.3 单章细纲流程

适用场景：

```text
生成第 3 章细纲。
细化第 8 章。
```

LLM Planner 应输出 `chapterNo=3`，而不是 `chapterCount=3`。

计划应：

- 使用目标卷 `Volume.chapterCount` 作为范围上限和上下文。
- 只生成目标章节。
- 不把单章请求扩展成整卷章节细纲。

推荐流程：

```text
inspect_project_context
generate_chapter_outline_preview(chapterNo=3, chapterCount=<Volume.chapterCount>)
```

若用户明确要求保存，则后续必须走审批写入；否则只产出预览。

## 6. LLM 结构化解析要求

### 6.1 Planner 输出

Planner 必须在 JSON 中显式表达目标：

```json
{
  "taskType": "outline_design",
  "target": {
    "volumeNo": 1,
    "chapterNo": null,
    "chapterCount": 60,
    "chapterCountSource": "context_volume"
  },
  "steps": []
}
```

如果用户目标含数字但语义不清，Planner 不应猜测，应输出澄清需求或失败让用户补充。

### 6.2 Tool 输入

生成类工具只接受结构化参数：

- `volumeNo`
- `chapterNo`
- `chapterCount`
- `chapterRange`
- `volumeOutline`
- `storyUnitPlan`

工具内部不得从 `instruction`、`objective`、`synopsis` 等自然语言字段中正则推断 `chapterCount`。

### 6.3 Tool 输出

LLM 返回的 JSON 必须完整：

- `generate_story_units_preview` 输出 `chapterCount` 时必须与目标一致。
- `storyUnitPlan.chapterAllocation` 必须连续覆盖目标章数。
- `generate_chapter_outline_batch_preview` 返回章节数必须等于当前 `chapterRange` 大小。
- 每章必须有完整 `craftBrief`。
- 质量复核必须返回结构化 `valid/issues`。

任何字段缺失、数量不足、编号不连续、质量复核失败后重试仍失败，都应直接报错。

## 7. 质量门禁

长章节细纲 batch 已具备局部质量门禁：

```text
LLM 生成 batch
结构 normalize / repair
LLM rubric 质量复核
必要时重生一次
仍失败则当前 batch 失败
```

后续应把同样的 LLM rubric 复用到单章和短章节链路，避免只有长卷 batch 有语义质量判断。

rubric 应判断：

- outline 是否能直接拆成正文场景链。
- actionBeats 是否有人物、动作、对象、阻力、结果。
- sceneBeats 是否包含地点、参与者、动作、阻力、转折、结果、感官锚点。
- continuityState 是否能承接前后章。
- storyUnit 是否承接上游单元故事。
- characterExecution 是否只引用允许来源。

## 8. 审批与写入

`persist_outline` 只应接收已通过本地结构校验和 LLM 质量复核的 preview。

写入前仍要做最终确定性保护：

- `context.mode === 'act'`
- `context.approved === true`
- `volume.chapterCount === chapters.length`
- 章节编号连续且无重复
- `craftBrief` 必填字段完整
- `volume.narrativePlan` 完整
- `characterExecution` 来源合法

`validate_outline` 可以作为人工检查或旧链路兼容工具，但长卷 batch 链路不应把它放在全部 batch 完成后的终局兜底闸门。

## 9. 迁移口径

新流程优先级高于旧文档中的以下口径：

- `generate_outline_preview -> validate_outline -> persist_outline` 作为章节细纲主链路。
- 长卷 batch 合并后再追加终局 `validate_outline`。
- 通过 `instruction` 正则推断 `chapterCount`。
- 在路由阶段把上下文章数作为权威 `route.chapterCount`。

旧链路可以保留为兼容读路径，但不应继续作为新章节细纲计划的推荐路径。
