# AI 小说大纲与细纲生成升级设计

> 最后更新：2026-05-03  
> 状态：设计落地文档，尚未进入实现  
> 范围：引导式总纲、卷纲、章节细纲、单章细化细纲与正文生成前质量门禁  
> 核心目标：把“不空洞”从一句写作要求，工程化为可生成、可保存、可拼装、可校验、可追踪的结构化创作链路。

## 1. 当前会话共识

本次设计来自当前会话中对“AI 写小说为什么空洞”以及“如何改造现有引导式创作流程”的讨论，已形成以下共识：

1. AI 写小说空洞的根因不只在正文 Prompt，而在上游细纲缺少可执行信息。
2. 章节细纲不能只是剧情摘要，需要包含目标、冲突、行动链、物证/线索、对话潜台词、人物变化与不可逆后果。
3. 当前“生成本章”应明确为“生成/细化本章细纲”，不是生成正文；正文生成继续走 `write_chapter` / `generation` 链路。
4. 整卷生成仍有价值：它负责铺设卷内节奏、章节序列、支线分布和卷末钩子。
5. 单章细化负责把某一章从粗略摘要扩展为可执行场景卡，解决单章空洞问题。
6. 卷生成也需要升级：每卷不仅有概要，还应包含全书主线阶段、本卷主线、卷内支线、小故事线、伏笔分配和卷末交接。
7. 正确分层应是：全书主线 -> 本卷主线 -> 卷内支线 -> 章节粗细纲 -> 单章细化细纲 -> 正文生成。
8. 工程上应把“不空洞”拆成可填写、可保存、可拼装、可校验的字段，而不是只写一句“写得有画面感”。

## 2. 背景与问题

当前系统已经有完整的引导式创作流程：

- `guided_setup`：基础设定
- `guided_style`：风格定义
- `guided_characters`：核心角色
- `guided_outline`：总纲生成
- `guided_volume`：卷纲拆分
- `guided_chapter`：章节细纲
- `guided_foreshadow`：伏笔设计

现有 `guided_chapter` 支持按卷生成章节细纲，并能写入 `Chapter.objective`、`Chapter.conflict`、`Chapter.outline`。但当前结构仍偏“章节摘要”，后续正文生成容易出现以下问题：

- 有气氛但无行动链，段落只在描写“不安”“诡异”“复杂”。
- 有事件但无阻力，角色像被剧情推着走。
- 有冲突标签但没有具体对抗方式。
- 有线索名词但没有物证的感官细节、用途和后续回收。
- 对话负责解释设定，而不是试探、隐瞒、逼问、威胁、安抚或误导。
- 章节结尾只是情绪升级，没有不可逆局面变化。
- 卷纲只有“本卷发生什么”，没有主线阶段、支线编排和卷末交接。

## 3. 目标与非目标

### 3.1 目标

- 让卷纲表达全书主线阶段、本卷主线和卷内支线。
- 让整卷章节生成能把本卷主线和支线分配到具体章节。
- 让单章细化能把粗细纲扩展为可执行场景卡。
- 让正文生成能读取细化后的结构，减少空洞、流水账和 AI 味。
- 在生成前后提供可解释的质量提示，告诉用户“哪里支撑不住正文”。
- 用可追踪任务清单把改造拆为 Phase 1/2/3，便于逐项验收。

### 3.2 非目标

- Phase 1 不改数据库 schema。
- Phase 1 不引入复杂图谱、完整多 Agent 规划或异步队列。
- “细化本章”不生成正文。
- 本设计不替代已有事实召回、记忆重建、正文生成、润色和校验链路，只增强其上游输入。

## 4. 核心术语

### 4.1 全书主线

整本书最终要解决的大问题。

示例：

```text
主角调查弟弟失踪，逐步发现村中井、祠堂和“名字禁忌”之间的真相，最终决定要不要把弟弟从井里叫回来。
```

### 4.2 本卷主线

全书主线在当前卷的阶段性问题。它属于全书主线的一段，但必须具备本卷独立的戏剧问题和阶段结果。

示例：

```text
第 1 卷主线：确认弟弟失踪是否与祠堂后院那口井有关。
第 2 卷主线：查清是谁把弟弟的名字交给了井，以及“名字被井认住”意味着什么。
```

### 4.3 卷内支线

围绕本卷主线展开的小故事线、人物线、物证线、关系线、反派线或规则线。

示例：

```text
弟弟遗物线：用木珠、湿红线、旧衣角等物证逐步证明弟弟来过井边。
王德顺遮掩线：用封井、改口供、压制村民制造人为阻力。
井的规则线：逐步展示井会模仿、记忆、呼唤名字。
```

### 4.4 章节粗细纲

整卷生成时产出的章节级基础规划，通常包含：

- `chapterNo`
- `volumeNo`
- `title`
- `objective`
- `conflict`
- `outline`

### 4.5 单章细化细纲

针对某一章生成的详细执行卡，不生成正文。它把粗细纲扩展为：

- 表层目标
- 隐藏情绪
- 核心冲突
- 行动链
- 物证/线索
- 对话潜台词
- 人物变化
- 不可逆后果

### 4.6 正文生成

根据项目设定、角色、卷纲、章节细纲、上下文召回、记忆和伏笔生成章节正文。它属于 `write_chapter` / `generation` 链路，不属于 `guided_chapter`。

## 5. 当前系统现状

### 5.1 可复用文件

| 模块 | 文件 | 当前能力 |
|---|---|---|
| 引导式步骤 hook | `apps/web/hooks/useGuidedSession.ts` | 定义 `GUIDED_STEPS`，提供 `generateStepData`、`confirmGeneratedData` |
| 引导式主界面 | `apps/web/components/guided/GuidedWizard.tsx` | 已有 `handleGenerateForVolume`，可按卷生成章节细纲 |
| 章节细纲 UI | `apps/web/components/guided/ChapterFields.tsx` | 展示按卷章节卡，支持生成本卷、保存本卷、编辑章节 |
| 步骤区容器 | `apps/web/components/guided/StepSection.tsx` | 将 `guided_chapter` 渲染为 `ChapterFields` |
| 后端引导服务 | `apps/api/src/modules/guided/guided.service.ts` | `generateStepData` 支持 `guided_volume`、`guided_chapter`；`guided_chapter` 已支持 `volumeNo` |
| 引导生成 DTO | `apps/api/src/modules/guided/dto/generate-step.dto.ts` | 当前有 `volumeNo`，尚无 `chapterNo` |
| Prisma Schema | `apps/api/prisma/schema.prisma` | `Volume` 有 `synopsis/objective`；`Chapter` 有 `objective/conflict/revealPoints/foreshadowPlan/outline` |
| 正文 Prompt 拼装 | `apps/api/src/modules/generation/prompt-builder.service.ts` | 拼装项目、卷、角色、章节、伏笔、召回和前文 |
| 正文生成服务 | `apps/api/src/modules/generation/generate-chapter.service.ts` | 有生成前 preflight 与生成后质量门禁 |
| Prompt 模板指南 | `docs/prompt-template-guide.md` | 记录各引导步骤推荐模板，但当前未包含本设计的新字段 |

### 5.2 当前痛点

- `guided_volume` 的目标结构不足以表达“全书主线阶段 -> 本卷主线 -> 支线”的分层。
- `guided_chapter` 的 JSON schema 只有基础字段，无法承载行动链、物证、潜台词等信息。
- 前端按钮“生成本卷”容易让用户理解为正文生成或不清楚生成的是细纲。
- 后端 `generate-step` 没有单章细化参数。
- 正文生成 Prompt 目前只读取 `Chapter.outline`，无法稳定识别“本章执行卡”。

### 5.3 Agent 工作台章节细纲落地约定

Agent 工作台的 `generate_outline_preview` 与引导式 `guided_chapter` 保持同一章级规划方向，但它的产物先作为可审批 Artifact 展示，再由 `persist_outline` 写入业务表：

- `outline_preview.chapters[]` 保留旧字段，并新增可选 `craftBrief`，字段对齐章级执行卡。
- `generate_outline_preview` 应生成“卷/章节细纲与执行卡预览”，不是正文；超过 15 章时按批次生成，默认批次大小为 12。
- 每批 LLM 调用使用 Tool 内部 `timeoutMs`，批次失败只 fallback 当前批，最终仍返回完整章节数，并在 `risks` 标明批次范围和原因。
- AgentRun Timeline 通过 `phase/progressCurrent/progressTotal/heartbeat` 展示当前批次、合并和校验进度。
- `persist_outline` 只创建或更新 `planned` 章节的规划字段与 `Chapter.craftBrief`；已 `drafted` 或非 planned 章节默认跳过。
- Planner guidance 明确：用户说“卷细纲 / 章节细纲 / 60 章细纲 / 等长细纲”走 `outline_design`；用户说“写正文 / 生成正文”才走正文写作；用户说“拆成场景 / SceneCard”走场景卡链路。

## 6. 目标生成流程

```text
故事总纲
  ↓
全书故事线表
  ↓
卷纲生成
  - 全书主线阶段
  - 本卷主线
  - 本卷戏剧问题
  - 卷内支线
  - 伏笔分配
  - 卷末交接
  ↓
整卷章节细纲生成
  - 为每章分配主线任务
  - 为每章分配 1-2 条支线任务
  - 形成章节序列和卷内节奏
  ↓
单章细化细纲
  - 行动链
  - 物证/线索
  - 对话潜台词
  - 人物变化
  - 不可逆后果
  ↓
正文生成
  - 严格执行本章细纲
  - 使用召回事实与角色设定
  - 生成后质量门禁
```

## 7. 数据结构设计

### 7.1 Phase 1：不改 schema 的 Markdown 承载

Phase 1 只增强 Prompt 与 UI 文案，不迁移数据库。新增内容先写入现有字段：

- 卷纲增强内容写入 `Volume.synopsis`。
- 章节粗细纲写入 `Chapter.objective/conflict/outline`。
- 单章细化内容写入 `Chapter.outline` 的 Markdown 执行卡段落。

建议 `Volume.synopsis` 格式：

```md
## 全书主线阶段
本卷推进全书核心问题的哪一阶段。

## 本卷主线
本卷独立要解决的阶段性问题。

## 本卷戏剧问题
读者读这一卷时最想知道的问题。

## 开局状态
本卷开始时角色、线索、危险的状态。

## 结尾状态
本卷结束时不可逆的新局面。

## 主线里程碑
1. ...
2. ...

## 卷内支线
1. 支线名：起点 -> 推进 -> 阶段结果。
2. 支线名：起点 -> 推进 -> 阶段结果。

## 伏笔分配
- ...

## 卷末交接
已解决：...
已升级：...
移交下一卷：...
```

建议 `Chapter.outline` 的单章执行卡格式：

```md
## 本章执行卡

表层目标：
...

隐藏情绪：
...

核心冲突：
...

行动链：
1. ...
2. ...

物证/线索：
- 名称：感官细节；后续用途。

对话潜台词：
...

人物变化：
...

不可逆后果：
...
```

### 7.2 Phase 3：结构化字段

Phase 3 已新增 JSON 字段，避免长期依赖 Markdown 解析；Markdown 仍作为旧项目兼容与人工编辑入口保留。

实际扩展：

```prisma
model Volume {
  ...
  narrativePlan Json @default("{}")
}

model Chapter {
  ...
  craftBrief Json @default("{}")
}
```

实际约定类型：

```ts
type VolumeNarrativePlan = {
  globalMainlineStage: string;
  volumeMainline: string;
  dramaticQuestion: string;
  startState: string;
  endState: string;
  mainlineMilestones: string[];
  subStoryLines: Array<{
    name: string;
    type: 'mystery' | 'relationship' | 'clue' | 'antagonist' | 'emotion' | 'world_rule' | 'resource';
    function: string;
    startState: string;
    progress: string;
    endState: string;
    relatedCharacters: string[];
    chapterNodes: number[];
  }>;
  foreshadowPlan: string[];
  endingHook: string;
  handoffToNextVolume: string;
};

type ChapterCraftBrief = {
  visibleGoal: string;
  hiddenEmotion: string;
  coreConflict: string;
  mainlineTask: string;
  subplotTasks: string[];
  actionBeats: string[];
  concreteClues: Array<{
    name: string;
    sensoryDetail: string;
    laterUse: string;
  }>;
  dialogueSubtext: string;
  characterShift: string;
  irreversibleConsequence: string;
  progressTypes: Array<'info' | 'relationship' | 'resource' | 'status' | 'foreshadow' | 'rule' | 'emotion'>;
};
```

落库与兼容约定：

- `Volume.narrativePlan` 为 `Json @default("{}")`，数据库中是 `JSONB NOT NULL DEFAULT '{}'::jsonb`。
- `Chapter.craftBrief` 为 `Json @default("{}")`，数据库中是 `JSONB NOT NULL DEFAULT '{}'::jsonb`。
- 引导式卷纲生成同时写 `Volume.synopsis` Markdown 和 `Volume.narrativePlan`。
- 引导式整卷章节细纲与单章细化同时写 `Chapter.outline` Markdown 和 `Chapter.craftBrief`。
- 旧项目字段为空 `{}` 时，正文 PromptBuilder 回退读取 `Chapter.outline` 中的 Markdown「本章执行卡」；若也没有执行卡，则仍允许生成正文，但生成前返回细纲密度 warning。

## 8. Prompt 改造方案

### 8.1 `guided_volume` 规则

卷纲生成必须输出：

1. 全书主线阶段：本卷推进全书核心问题的哪一步。
2. 本卷主线：本卷独立要解决的阶段性问题。
3. 本卷戏剧问题：读者读这一卷时最想知道的悬念。
4. 开局状态与结尾状态：结尾必须改变局面。
5. 主线里程碑：5-8 个必须发生的关键节点。
6. 卷内支线：2-4 条，每条说明作用、起点、推进和阶段结果。
7. 支线交叉点：至少 1 个物证、事件或对话同时推进两条线。
8. 伏笔分配：本卷埋设、推进、回收哪些伏笔。
9. 卷末交接：哪些问题解决，哪些升级，哪些移交下一卷。

反模式：

- 禁止只写“推进主线”“主角成长”“遭遇困难”。
- 禁止每卷只是总纲的一段流水账。
- 禁止所有卷都采用相同节奏模板。
- 禁止卷末只以情绪悬念收尾，必须有事实、关系、资源、地位、规则或危险的变化。

### 8.2 `guided_chapter` 整卷章节细纲规则

整卷章节细纲必须输出：

1. 每章至少领取 1 个本卷主线任务。
2. 每章至少推进 1 条卷内支线。
3. 每章 `objective` 必须具体可检验。
4. 每章 `conflict` 必须写清阻力来源和阻力方式。
5. 每章 `outline` 必须包含具体场景、关键行动和阶段结果。
6. 每 3-4 章至少发生一次信息揭示、关系反转、资源得失、地位变化或规则升级。
7. 卷末章节必须收束本卷主线并留下下一卷交接。

反模式：

- 禁止“主角调查线索”“发生怪事”“关系变化”这类空泛表达。
- 禁止章节全部只推进主线，不安排支线交错。
- 禁止每章都是“发现异常 -> 感到不安 -> 留下悬念”。

### 8.3 单章细化规则

单章细化是 `guided_chapter + volumeNo + chapterNo` 的特殊模式。

硬性要求：

1. 只生成当前章细纲，不生成正文。
2. 只返回 1 个 chapter 对象。
3. 不重排整卷章节。
4. 不改其他章节。
5. 保留当前章节标题、目标和冲突的核心意图，除非它们明显空泛。
6. 输出本章执行卡：目标、隐藏情绪、冲突、行动链、物证、潜台词、人物变化、不可逆后果。

建议 JSON：

```json
{
  "chapters": [
    {
      "chapterNo": 1,
      "volumeNo": 1,
      "title": "井里学会叫我名字",
      "objective": "确认弟弟失踪前最后一次出现的位置，并找到能指向祠堂后院的物证。",
      "conflict": "王德顺的人封住祠堂后院，村里人统一把井里的声音说成风声。",
      "outline": "## 本章执行卡\n\n表层目标：...\n\n行动链：\n1. ...",
      "craftBrief": {
        "visibleGoal": "确认弟弟失踪前最后一次出现的位置。",
        "hiddenEmotion": "害怕弟弟已经死在井里，但不敢承认。",
        "coreConflict": "王德顺的人阻止任何人靠近祠堂后院。",
        "mainlineTask": "证明弟弟失踪与井有关。",
        "subplotTasks": ["弟弟遗物线启动", "王德顺遮掩线启动"],
        "actionBeats": ["主角听见井边有人叫自己的名字"],
        "concreteClues": [
          {
            "name": "湿红线",
            "sensoryDetail": "冰凉、沾井水、有泥腥味",
            "laterUse": "证明弟弟来过井边"
          }
        ],
        "dialogueSubtext": "王德顺的人知道井的规则，但不能明说。",
        "characterShift": "主角从找人转向怀疑井本身有问题。",
        "irreversibleConsequence": "主角拿走木珠后，井开始叫他的名字。",
        "progressTypes": ["info", "foreshadow", "rule"]
      }
    }
  ]
}
```

Phase 1/2 已先要求 `outline` 写入 Markdown 执行卡；Phase 3 已将 `craftBrief` 落库到 `Chapter.craftBrief`，并继续保留 Markdown 作为人工可读与旧数据兼容格式。

## 9. 前端交互方案

### 9.1 文案调整

当前文案：

```text
生成本卷
```

建议改为：

```text
生成本卷细纲
```

章节卡新增：

```text
细化本章
```

保留：

```text
保存本卷
```

正文生成按钮应出现在正文编辑/章节生成区域，避免与引导式细纲混淆。

### 9.2 交互行为

```text
点击「生成本卷细纲」
  -> 调用 guided-session/generate-step
  -> body: { currentStep: 'guided_chapter', volumeNo }
  -> 返回本卷多个 chapter
  -> 替换当前卷章节列表

点击「细化本章」
  -> 调用 guided-session/generate-step
  -> body: { currentStep: 'guided_chapter', volumeNo, chapterNo }
  -> 返回 1 个 chapter
  -> 只替换当前卷对应 chapter
```

### 9.3 状态合并原则

- 单章细化不得清空本卷其他章节。
- 单章细化不得修改其他卷。
- 如果返回的 `chapterNo` 与请求不一致，前端应优先使用请求的 `chapterNo` 进行替换，并记录 warning。
- 如果返回多个 chapter，前端应只取第一个，并提示后端响应异常。

## 10. 后端接口方案

### 10.1 复用现有接口

```http
POST /projects/:projectId/guided-session/generate-step
```

整卷章节细纲：

```json
{
  "currentStep": "guided_chapter",
  "volumeNo": 1,
  "userHint": "为第 1 卷生成章节细纲，请生成 15-20 章"
}
```

单章细化细纲：

```json
{
  "currentStep": "guided_chapter",
  "volumeNo": 1,
  "chapterNo": 3,
  "userHint": "细化第 1 卷第 3 章细纲"
}
```

### 10.2 后端分支逻辑

```text
if currentStep !== 'guided_chapter':
  走原步骤生成

if currentStep === 'guided_chapter' && volumeNo && !chapterNo:
  生成整卷章节细纲

if currentStep === 'guided_chapter' && volumeNo && chapterNo:
  单章细化细纲
```

### 10.3 上下文注入

整卷章节细纲应注入：

- 项目设定
- 核心角色
- 故事总纲
- 当前卷信息
- 当前卷主线/支线结构
- 已有用户偏好

单章细化还应注入：

- 当前章已有标题、目标、冲突、outline
- 同卷前后 2-3 章摘要
- 当前卷支线列表
- 本章在卷内的位置和节奏功能

## 11. 正文生成衔接方案

正文生成仍由 `GenerateChapterService` 和 `PromptBuilderService` 负责。

Phase 3 实际实现：

- `PromptBuilderService.buildChapterSection()` 继续注入 `Chapter.outline`，保证旧编辑流程不变。
- `PromptBuilderService.buildCraftBriefSection()` 新增独立【本章执行卡】区块。
- 【本章执行卡】优先读取 `Chapter.craftBrief`，旧项目无结构化字段时回退读取 `Chapter.outline` 中的 Markdown 执行卡。
- `write_chapter` 默认 Prompt 已增加执行卡执行规则，明确要求覆盖行动链、物证/线索、潜台词、人物变化与不可逆后果。
- `GenerateChapterService` 会把执行卡覆盖检查结果写入 `qualityGate.executionCardCoverage`，供后续自动修复读取。

## 12. 校验与质量门禁

### 12.1 生成前检查

卷纲检查：

- 缺少全书主线阶段：warning
- 缺少本卷主线：warning
- 缺少本卷戏剧问题：warning
- 卷内支线少于 2 条：warning
- 缺少卷末交接：warning

章节细纲检查：

- 章节目标为空：warning
- 章节冲突为空：warning
- outline 少于 50 字：warning
- 未提及主线任务或支线任务：warning

正文生成前检查：

- 既无章节目标，也无 outline，也无用户指令：blocker
- 当前章节存在 error 级校验问题：blocker
- 章节冲突为空：warning
- 单章细纲过短：warning
- 缺少行动链、物证或不可逆后果：默认 warning；可通过生成请求 `outlineQualityGate: "blocker"` 或环境变量 `OUTLINE_QUALITY_GATE=blocker` 升级为 blocker

### 12.2 生成后检查

正文生成后可增加：

- 关键物证是否出现。
- 行动链关键节点是否覆盖。
- 不可逆后果是否落地。
- 是否包含高频空泛表达。
- 是否出现连续大段总结性内心独白。

Phase 3 已实现：

- `assessOutlineDensity()` 检查目标、冲突、细纲密度、行动链、物证/线索、不可逆后果。
- `assessGeneratedDraftQuality()` 在原有长度、重复、拒答、占位符检查之外，追加执行卡覆盖 warning。
- 覆盖检查先只对关键物证/线索名称与不可逆后果做确定性检查，避免过度阻断文学化表达。
- 覆盖 warning 会进入草稿 `generationContext.qualityGate.executionCardCoverage`，`ChapterAutoRepairService` 可读取为修复问题输入。

## 13. 可追踪任务列表

任务状态枚举：

- `todo`：未开始
- `doing`：进行中
- `blocked`：被依赖或问题阻塞
- `done`：已完成并验证

### Phase 1：Prompt 与交互最小升级

目标：不改数据库，先通过 Prompt 规则和按钮文案让生成质量明显改善。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| OGU-P1-01 | done | 增强 `guided_volume` 硬编码生成规则 | `apps/api/src/modules/guided/guided.service.ts` | 无 | 一键生成卷纲时，每卷包含全书主线阶段、本卷主线、戏剧问题、支线、卷末交接 |
| OGU-P1-02 | done | 更新 DB/种子 Prompt 中的卷纲模板 | `apps/api/prisma/seed-prompts/outline.ts` 或相关 seed prompt | OGU-P1-01 | 新建/重置默认模板后仍包含卷纲新规则 |
| OGU-P1-03 | done | 更新 Prompt 模板指南中的 `guided_volume` 推荐模板 | `docs/prompt-template-guide.md` | OGU-P1-01 | 文档模板与代码规则一致 |
| OGU-P1-04 | done | 增强 `guided_chapter` 整卷章节细纲规则 | `apps/api/src/modules/guided/guided.service.ts` | 无 | 生成章节时每章包含主线任务、支线任务、具体目标、具体冲突和具体场景行动 |
| OGU-P1-05 | done | 更新 Prompt 模板指南中的 `guided_chapter` 推荐模板 | `docs/prompt-template-guide.md` | OGU-P1-04 | 文档说明整卷章节细纲与单章细化区别 |
| OGU-P1-06 | done | 调整章节细纲按钮文案 | `apps/web/components/guided/ChapterFields.tsx` | 无 | “生成本卷”改为“生成本卷细纲”，用户能区分细纲与正文 |
| OGU-P1-07 | done | 调整空状态提示文案 | `apps/web/components/guided/ChapterFields.tsx` | OGU-P1-06 | 无章节时提示“点击生成本卷细纲” |
| OGU-P1-08 | done | 手动验证整卷生成结果 | 不涉及代码 | OGU-P1-01, OGU-P1-04 | 使用同一项目生成一卷，抽查至少 5 章，确认每章不只是一句摘要 |
| OGU-P1-09 | done | 类型检查与基础构建 | `apps/api`, `apps/web` | OGU-P1-01..OGU-P1-07 | `pnpm --filter api build` 与 `pnpm --filter web build` 通过，或记录阻塞原因 |

#### Phase 1 实施记录（2026-05-03）

| ID | 改动文件 | 改动摘要 | 验收结果 |
|---|---|---|---|
| OGU-P1-01 | `apps/api/src/modules/guided/guided.service.ts` | 在 `guided_volume` 对话提示与一键生成提示中要求把增强卷纲写入 `Volume.synopsis` Markdown 段落，覆盖全书主线阶段、本卷主线、戏剧问题、开局/结尾状态、里程碑、卷内支线、支线交叉点、伏笔分配和卷末交接。 | `pnpm --filter api build` 通过；手动检查 prompt 包含目标字段。 |
| OGU-P1-02 | `apps/api/prisma/seed-prompts/outline.ts` | 更新默认大纲 seed prompt 的卷级规划要求，使 `synopsis/summary` 包含增强卷纲段落与卷末交接规则。 | `pnpm --filter api build` 通过；模板文本与 OGU-P1-01 的承载规则一致。 |
| OGU-P1-03 | `docs/prompt-template-guide.md` | 更新 `guided_volume` 推荐模板，补充 `synopsis` Markdown 承载格式和反空泛规则。 | 文档模板与后端硬编码规则一致。 |
| OGU-P1-04 | `apps/api/src/modules/guided/guided.service.ts` | 在 `guided_chapter` 对话提示与一键生成提示中要求整卷章节细纲逐章包含主线任务、支线任务、可检验目标、具体阻力、具体场景行动和阶段结果。 | `pnpm --filter api build` 通过；OGU-P1-08 生成样例抽查通过。 |
| OGU-P1-05 | `docs/prompt-template-guide.md` | 更新 `guided_chapter` 推荐模板，明确整卷章节细纲是 `guided_chapter + volumeNo`，不生成正文，单章细化需 `chapterNo` 且属于后续能力。 | 文档说明已区分整卷章节细纲与单章细化。 |
| OGU-P1-06 | `apps/web/components/guided/ChapterFields.tsx` | 将卷面板按钮从“生成本卷”改为“生成本卷细纲”。 | `pnpm --filter web build` 通过。 |
| OGU-P1-07 | `apps/web/components/guided/ChapterFields.tsx` | 将无章节提示改为“暂无章节，点击「生成本卷细纲」自动生成章节细纲”。 | `pnpm --filter web build` 通过。 |
| OGU-P1-08 | 不涉及代码 | 使用本地临时 API（3101）对既有项目 `c2da9491-1d4e-4a50-82a7-136c0c73ef78` 调用 `generate-step`，请求第 1 卷生成 5 章；未调用 `finalize-step`，未写入数据库。 | 返回 5 章，5 章均有 `objective/conflict/outline`；outline 长度分别为 245、260、278、291、319 字，抽样内容包含主线任务、支线任务、具体场景行动和阶段结果。 |
| OGU-P1-09 | `apps/api`, `apps/web` | 运行要求的构建与 diff 检查。Web 构建首次被现有 dev server 锁住 `.next/trace`，临时停止 dev server 后重跑通过，并已恢复 3000 dev server。 | `pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`git diff --check` 通过（仅 CRLF 提示）。 |

### Phase 2：单章细化细纲

目标：新增“细化本章”能力，只更新单章细纲，不生成正文，不重排整卷。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| OGU-P2-01 | done | `GenerateStepDto` 增加 `chapterNo` | `apps/api/src/modules/guided/dto/generate-step.dto.ts` | 无 | API 能接收可选 `chapterNo`，验证不报错 |
| OGU-P2-02 | done | 后端识别单章细化模式 | `apps/api/src/modules/guided/guided.service.ts` | OGU-P2-01 | `guided_chapter + volumeNo + chapterNo` 进入单章细化分支 |
| OGU-P2-03 | done | 单章细化 Prompt 注入当前章上下文 | `apps/api/src/modules/guided/guided.service.ts` | OGU-P2-02 | Prompt 中包含当前卷信息、当前章信息、前后章摘要 |
| OGU-P2-04 | done | 单章细化输出限制为 1 个 chapter | `apps/api/src/modules/guided/guided.service.ts` | OGU-P2-02 | 返回 `chapters.length === 1`；若模型返回多个，程序侧截断或报 warning |
| OGU-P2-05 | done | 单章细化生成 Markdown 执行卡 | `apps/api/src/modules/guided/guided.service.ts` | OGU-P2-03 | 返回章节 `outline` 包含“本章执行卡/行动链/物证/潜台词/不可逆后果” |
| OGU-P2-06 | done | 前端 hook 支持传 `chapterNo` | `apps/web/hooks/useGuidedSession.ts` | OGU-P2-01 | 请求体可携带 `chapterNo` |
| OGU-P2-07 | done | `StepSection` 增加 `onGenerateForChapter` 透传 | `apps/web/components/guided/StepSection.tsx` | OGU-P2-06 | `ChapterFields` 能接收到单章细化回调 |
| OGU-P2-08 | done | `GuidedWizard` 新增 `handleGenerateForChapter` | `apps/web/components/guided/GuidedWizard.tsx` | OGU-P2-06 | 调用单章细化接口，并只更新目标章节 |
| OGU-P2-09 | done | 章节卡新增“细化本章”按钮 | `apps/web/components/guided/ChapterFields.tsx` | OGU-P2-07, OGU-P2-08 | 每个章节卡可点击细化本章；loading 时禁用 |
| OGU-P2-10 | done | 单章细化状态合并保护 | `apps/web/components/guided/GuidedWizard.tsx` | OGU-P2-08 | 细化第 N 章后，同卷其他章节与其他卷不变 |
| OGU-P2-11 | done | 单章细化保存路径验证 | `apps/web/components/guided/GuidedWizard.tsx`, `apps/api/src/modules/guided/guided.service.ts` | OGU-P2-08 | 细化后点击保存本卷，数据库中对应章节 outline 更新 |
| OGU-P2-12 | done | 单章细化 API 手工测试 | API 调用或前端操作 | OGU-P2-02..OGU-P2-05 | 请求第 1 卷第 3 章，只返回并更新第 3 章 |
| OGU-P2-13 | done | 前端交互测试 | 浏览器手工验证 | OGU-P2-06..OGU-P2-10 | 点击“细化本章”后 UI 只刷新目标章节内容 |
| OGU-P2-14 | done | 构建验证 | `apps/api`, `apps/web` | OGU-P2-01..OGU-P2-10 | API/Web build 通过，或记录阻塞原因 |

#### Phase 2 实施记录（2026-05-03）

| ID | 改动文件 | 改动摘要 | 验收结果 |
|---|---|---|---|
| OGU-P2-01 | `apps/api/src/modules/guided/dto/generate-step.dto.ts` | 在 `GenerateStepDto` 中新增可选整数 `chapterNo`，用于 `guided_chapter + volumeNo + chapterNo` 单章细化请求。 | `pnpm --filter api build` 通过；单章 mock 请求可携带 `chapterNo`。 |
| OGU-P2-02 | `apps/api/src/modules/guided/guided.service.ts` | 增加 `isSingleChapterRefinement` 分支，只有 `currentStep === guided_chapter` 且同时传入 `volumeNo/chapterNo` 时进入单章细化模式。 | mock 服务调用确认进入单章分支，并使用单章 schema。 |
| OGU-P2-03 | `apps/api/src/modules/guided/guided.service.ts` | 新增单章上下文拼装，优先从引导会话 `guided_volume_result/guided_chapter_result` 读取当前卷、当前章和同卷前后 3 章摘要，缺失时回退数据库。 | mock 验证 prompt 包含“当前卷信息”“当前章已有细纲”“同卷前后章摘要”。 |
| OGU-P2-04 | `apps/api/src/modules/guided/guided.service.ts` | 单章生成返回后统一规范化：只保留第一个 chapter，并强制写回请求的 `volumeNo/chapterNo`；异常情况写入 `warnings`。 | mock 模型返回 2 个 chapter 时，结果 `chapters.length === 1`，并记录截断 warning。 |
| OGU-P2-05 | `apps/api/src/modules/guided/guided.service.ts` | 单章 prompt 要求 `outline` 以 `## 本章执行卡` 开头；程序侧兜底补齐行动链、物证/线索、对话潜台词、人物变化和不可逆后果。 | mock 返回普通 outline 时，最终 outline 含“本章执行卡/行动链/物证/潜台词/不可逆后果”。 |
| OGU-P2-06 | `apps/web/hooks/useGuidedSession.ts` | `generateStepData` 增加可选 `chapterNo` 参数，请求体在存在时携带 `chapterNo`，聊天提示标题显示卷章定位。 | 浏览器 mock 点击捕获请求体包含 `{ currentStep: guided_chapter, volumeNo: 1, chapterNo: 1 }`。 |
| OGU-P2-07 | `apps/web/components/guided/StepSection.tsx` | 为章节细纲区域新增 `onGenerateForChapter` prop，并透传给 `ChapterFields`。 | `pnpm --filter web build` 通过；浏览器页面章节卡收到回调按钮。 |
| OGU-P2-08 | `apps/web/components/guided/GuidedWizard.tsx` | 新增 `handleGenerateForChapter`，构造包含当前章和邻近章摘要的 userHint，调用单章接口后仅替换目标章节。 | 浏览器 mock 返回错号 chapter 时，前端按请求卷章替换目标章。 |
| OGU-P2-09 | `apps/web/components/guided/ChapterFields.tsx` | 每个章节卡标题栏新增“细化本章”按钮，点击时阻止折叠事件冒泡，loading 时禁用。 | 浏览器确认章节卡出现多个“细化本章”按钮且非 loading 时可用。 |
| OGU-P2-10 | `apps/web/components/guided/GuidedWizard.tsx` | 单章结果合并时复制当前 `volumeChapters`，只替换目标卷目标 `chapterNo`，保留同卷其他章和其他卷。 | 浏览器 mock 点击第 1 卷第 1 章后，仅第 1 章标题变为 mock 标题，第 2/3 章保持不变。 |
| OGU-P2-11 | `apps/api/src/modules/guided/guided.service.ts`, `apps/web/components/guided/GuidedWizard.tsx` | 修正 Phase 2 必需的最小前置问题：按卷保存不再删除本卷后按全局最大章节号重建，而是按本卷现有顺序更新已有章节，避免细化后保存导致章节重排。 | mock 保存本卷时，只有变化章节触发 1 次 update，create/delete 均为 0；session 同步更新。 |
| OGU-P2-12 | `apps/api/src/modules/guided/guided.service.ts` | 使用 mock LLM/Prisma 对第 1 卷第 3 章单章细化进行手工服务级验证。 | 返回 1 个 chapter，`volumeNo=1/chapterNo=3`，prompt 上下文和执行卡字段均通过。 |
| OGU-P2-13 | 浏览器手工验证 | 启动本地 API/Web，在章节细纲页面用浏览器 mock `generate-step` 响应后点击“细化本章”。 | 捕获请求携带 `chapterNo`；UI 只刷新目标章节，第 2/3 章保持原内容。 |
| OGU-P2-14 | `apps/api`, `apps/web` | 运行要求的构建与 diff 检查；Web build 前临时停止占用 `.next/trace` 的旧 dev server，构建后重新启动本地 API/Web dev server。 | `pnpm --filter api build` 通过；`pnpm --filter web build` 通过；`git diff --check` 通过。 |

### Phase 3：结构化数据与质量门禁

目标：把 Markdown 执行卡升级为结构化数据，并让正文生成前后可检查覆盖情况。

| ID | 状态 | 任务 | 影响文件 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| OGU-P3-01 | done | 设计 `Volume.narrativePlan` 与 `Chapter.craftBrief` schema | `apps/api/prisma/schema.prisma` | Phase 2 验证通过 | schema 设计明确，包含默认 `{}` |
| OGU-P3-02 | done | 创建 Prisma migration | `apps/api/prisma/migrations/*` | OGU-P3-01 | migration 可在本地数据库应用 |
| OGU-P3-03 | done | 更新 Chapter/Volume 写入逻辑 | `apps/api/src/modules/guided/guided.service.ts` | OGU-P3-02 | 引导式生成能写入结构化字段 |
| OGU-P3-04 | done | 更新前端数据类型 | `apps/web/components/guided/ChapterFields.tsx`, `apps/web/types/*` | OGU-P3-03 | 前端可展示/编辑关键结构化字段 |
| OGU-P3-05 | done | `PromptBuilderService` 增加执行卡拼装区块 | `apps/api/src/modules/generation/prompt-builder.service.ts` | OGU-P3-03 | 正文 Prompt 中有独立【本章执行卡】区块 |
| OGU-P3-06 | done | `write_chapter` Prompt 增加执行卡执行规则 | `apps/api/prisma/seed-prompts/write-chapter.ts`, DB PromptTemplate | OGU-P3-05 | 正文生成明确要求覆盖行动链、物证、潜台词、不可逆后果 |
| OGU-P3-07 | done | 生成前细纲密度检查 | `apps/api/src/modules/generation/generate-chapter.service.ts` | OGU-P3-03 | 缺目标/冲突/行动链/物证/后果时返回 warning |
| OGU-P3-08 | done | 可配置 blocker 策略 | `apps/api/src/modules/generation/generate-chapter.service.ts` | OGU-P3-07 | 可通过配置决定细纲不足是 warning 还是阻断 |
| OGU-P3-09 | done | 生成后执行卡覆盖检查 | `apps/api/src/modules/generation/generate-chapter.service.ts` | OGU-P3-05 | 正文漏写关键物证或不可逆后果时产生 warning |
| OGU-P3-10 | done | 自动修复接入点设计 | `apps/api/src/modules/generation/chapter-auto-repair.service.ts` | OGU-P3-09 | 覆盖失败的问题能作为自动修复输入 |
| OGU-P3-11 | done | 测试用例补充 | `apps/api/test/*` 或现有测试目录 | OGU-P3-07..OGU-P3-10 | 覆盖细纲缺失、执行卡完整、正文漏写关键项 |
| OGU-P3-12 | done | 迁移兼容旧数据 | `apps/api/src/modules/guided/guided.service.ts`, migration notes | OGU-P3-02 | 旧项目无 `craftBrief` 时仍能生成正文 |
| OGU-P3-13 | done | 文档更新 | `docs/prompt-template-guide.md`, 本文档 | OGU-P3-01..OGU-P3-12 | 文档说明结构化字段已落库与使用方式 |
| OGU-P3-14 | done | 端到端验收 | 前端 + API + 数据库 | Phase 3 全部实现 | 从卷纲到单章细化到正文生成完整跑通，能追踪每一步输入输出 |

#### Phase 3 实施记录（2026-05-03）

| ID | 改动文件 | 改动摘要 | 验收结果 |
|---|---|---|---|
| OGU-P3-01 | `apps/api/prisma/schema.prisma` | 新增 `Volume.narrativePlan Json @default("{}")` 与 `Chapter.craftBrief Json @default("{}")`。 | `pnpm --filter api exec prisma generate` 通过；Prisma Client 已生成。 |
| OGU-P3-02 | `apps/api/prisma/migrations/202605030001_structured_outline_quality/migration.sql` | 新增 JSONB 字段，并为既有 `write_chapter` PromptTemplate 追加执行卡规则。 | `pnpm --filter api exec prisma migrate deploy` 通过，migration 已应用到本地配置数据库。 |
| OGU-P3-03 | `apps/api/src/modules/guided/guided.service.ts` | `guided_volume` schema/prompt 要求输出 `narrativePlan`；`guided_chapter` 与单章细化要求输出 `craftBrief`；finalize 写入结构化字段。 | API build 通过；旧 Markdown 执行卡可被兜底解析为最小 `craftBrief`。 |
| OGU-P3-04 | `apps/web/components/guided/ChapterFields.tsx`, `apps/web/hooks/useGuidedSession.ts`, `apps/web/types/guided.ts`, `apps/web/types/dashboard.ts` | 新增前端 `ChapterCraftBrief` 类型；章节卡保留并可编辑表层目标、主线任务、行动链、物证/线索、不可逆后果；聊天式 finalize schema 同步包含结构化字段。 | `pnpm --filter web build` 通过；旧 `outline` 编辑流程未改变。 |
| OGU-P3-05 | `apps/api/src/modules/generation/prompt-builder.service.ts` | 新增独立【本章执行卡】区块，优先读取 `Chapter.craftBrief`，缺失时回退 Markdown 执行卡。 | API build 通过；Prompt debug 标记 `hasCraftBrief/craftBriefSource`。 |
| OGU-P3-06 | `apps/api/prisma/seed-prompts/write-chapter.ts`, migration SQL | 默认 `write_chapter` system prompt 增加执行卡执行规则，要求覆盖行动链、物证/线索、潜台词、人物变化、不可逆后果。 | seed prompt 与 DB PromptTemplate 迁移均已更新。 |
| OGU-P3-07 | `apps/api/src/modules/generation/generate-chapter.service.ts` | 新增 `assessOutlineDensity()`，检查目标、冲突、细纲密度、行动链、物证/线索、不可逆后果。 | `pnpm --filter api test:agent` 覆盖细纲缺失 warning。 |
| OGU-P3-08 | `apps/api/src/modules/generation/generate-chapter.service.ts`, `apps/api/src/modules/generation/dto/generate-chapter.dto.ts`, `apps/api/src/modules/generation/generation.service.ts` | 新增 `outlineQualityGate: "warning" | "blocker"`；默认 warning，也支持 `OUTLINE_QUALITY_GATE=blocker`。 | API build 通过；缺失项默认不阻断。 |
| OGU-P3-09 | `apps/api/src/modules/generation/generate-chapter.service.ts` | 生成后质量门禁追加执行卡覆盖检查，当前检查关键物证/线索与不可逆后果。 | `pnpm --filter api test:agent` 覆盖正文漏写关键项 warning。 |
| OGU-P3-10 | `apps/api/src/modules/generation/chapter-auto-repair.service.ts` | 自动修复读取 `generationContext.qualityGate.executionCardCoverage` 或显式 `executionCardCoverage`，转换为 warning 级修复问题。 | `pnpm --filter api test:agent` 覆盖覆盖失败问题提取。 |
| OGU-P3-11 | `apps/api/src/modules/agent-runs/agent-services.spec.ts` | 补充细纲缺失、执行卡完整、正文漏写关键项、自动修复覆盖输入测试。 | `pnpm --filter api test:agent` 通过 74 项。 |
| OGU-P3-12 | schema/migration, `guided.service.ts`, `prompt-builder.service.ts`, `generate-chapter.service.ts` | JSON 字段默认 `{}`；正文生成在结构化字段缺失时回退旧 Markdown 或普通目标/大纲，并只给 warning。 | 旧项目无 `craftBrief` 时不阻断正文生成；缺失执行卡只产生 warning。 |
| OGU-P3-13 | `docs/prompt-template-guide.md`, 本文档 | 更新结构化字段说明、正文衔接方案、质量门禁策略和任务状态。 | 文档与当前实现一致。 |
| OGU-P3-14 | API/Web build、Prisma migration、agent 服务测试 | 完成数据库迁移、API 构建、Web 构建、质量门禁测试；真实 LLM 写作链路因外部模型不可确定，按服务级链路验收。 | `pnpm --filter api build`、`pnpm --filter web build`、`pnpm --filter api test:agent`、`prisma migrate deploy` 均通过。 |

## 14. 验收样例

### 14.1 卷纲样例

```md
## 全书主线阶段
第一阶段：确认弟弟失踪与祠堂后院那口井有关。

## 本卷主线
主角调查弟弟最后出现的位置，逐步证明村里人隐瞒了祠堂后院的真相。

## 本卷戏剧问题
弟弟到底是被人藏起来，还是被井里的东西带走了？

## 卷内支线
1. 弟弟遗物线：木珠、湿红线、旧衣角逐步出现，证明弟弟来过井边。
2. 王德顺遮掩线：封井、改口供、压村民，说明有人知道井的规则。
3. 井的规则线：井从模仿声音到叫准名字，危险逐章升级。

## 卷末交接
已解决：弟弟失踪与井有关。
已升级：井已经记住主角的小名。
移交下一卷：追查是谁把弟弟的名字交给井。
```

### 14.2 单章细化样例

```md
## 本章执行卡

表层目标：
主角想确认弟弟失踪前最后一次出现的位置。

隐藏情绪：
他害怕弟弟已经死在井里，但不敢承认。

核心冲突：
王德顺的人封住祠堂后院，村里人统一说井里的声音只是风声。

行动链：
1. 主角夜里听见井边有人用弟弟的语气叫自己的名字。
2. 他摸到祠堂后院，发现新鲜泥脚印。
3. 井口被木板临时封死。
4. 门缝里塞出一截湿红线。
5. 红线上缠着弟弟常戴的木珠。
6. 王德顺的人返回，主角被迫躲进柴堆。
7. 主角听见他们说“名字叫顺了，井就认人了”。
8. 井底第一次叫出主角自己的小名。

物证/线索：
- 湿红线：冰凉，带井水泥腥味；后续证明弟弟来过井边。
- 木珠：木纹里卡着黑泥，多一道新刻痕；后续对应弟弟留下的求救标记。

对话潜台词：
王德顺的人知道井的规则，但不能直说，只能用“风声”和“旧规矩”压主角。

人物变化：
主角从“弟弟可能被人藏起来”转向“井本身可能认识弟弟”。

不可逆后果：
主角拿走木珠后，井开始叫他的名字。
```

## 15. 风险与开放问题

1. Markdown 执行卡短期成本低，但长期解析不稳定，Phase 3 应结构化落库。
2. 单章细化可能与整卷节奏冲突，因此必须注入前后章上下文，并禁止重排整卷。
3. Prompt 增强可能增加 token 消耗，需要观察一键生成耗时与模型上下文压力。
4. 结构化字段增加后，要处理旧项目兼容和空字段默认值。
5. 生成后覆盖检查如果过严，可能误伤文学性表达；Phase 3 应先 warning，再考虑 configurable blocker。
6. 当前任务列表不包含完整自动化评测体系；如果后续需要量化“空洞程度”，可另起评测任务。

## 16. 推荐实施顺序

推荐先做 Phase 1 + Phase 2：

```text
OGU-P1-01 ~ OGU-P1-09
  ↓
OGU-P2-01 ~ OGU-P2-14
  ↓
实际试写 1 个项目、1 卷、3 个单章细化
  ↓
确认细纲质量提升后，再进入 Phase 3
```

Phase 3 涉及数据库迁移和正文生成质量门禁，建议在 Phase 1/2 的交互与 Prompt 效果稳定后再做。

