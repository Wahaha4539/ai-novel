# AI 长篇小说质量保障系统开发文档

> 最后更新：2026-05-05  
> 状态：开发设计文档，供后续实现拆解使用  
> 范围：`apps/api`、`apps/web`、`apps/api/prisma`、`packages/*`、`docs/*`  
> 明确排除：Python Worker 源码已删除，不作为开发范围、验收范围或架构依赖。

## 1. 背景

当前系统已经不是一个简单的“输入大纲后生成正文”的工具，而是具备：

- 创作引导：基础设定、风格定义、核心角色、总纲、卷纲、章节细纲、伏笔设计。
- 结构化大纲：`Volume.narrativePlan`、`Chapter.craftBrief` 已承载卷级叙事计划与章节执行卡。
- 正文生成链路：`GenerateChapterService` 会执行 preflight、Retrieval Planner、结构化召回、PromptBuilder、生成后质量门禁。
- 事实层与记忆：`StoryEvent`、`CharacterStateSnapshot`、`ForeshadowTrack`、`MemoryChunk` 支持章节生成后的事实沉淀与召回。
- Agent-Centric 后端：`AgentRun`、Tool Registry、Manifest、审批、Replan 与 Eval 已形成主链路。

但要稳定支撑长篇小说，仍缺少一组“创作资产”和“连续性约束”模块。用户提供的 18 类建议里，很多已经有雏形，但仍分散在项目字段、Lorebook、章节事实、引导会话和 Inspector 面板里。后续迭代的核心目标是：把这些模块工程化成可编辑、可召回、可校验、可追踪的长篇小说 Story Bible 与质量保障系统。

## 2. 设计原则

1. **不依赖弃用 Worker**  
   所有新增能力都进入 `apps/api` 同步服务、Agent Tool、Prisma 模型和 `apps/web` UI。旧 Python Worker 源码已删除，不改、不测、不作为文档实现依据。

2. **复用现有事实层，不重复造孤岛**  
   世界观、势力、地点、物品、规则等优先复用 `LorebookEntry` 与召回链路；关系、时间线、规则校验这类需要强结构的模块再新增专用表。

3. **分清“计划资产”和“生成后事实”**  
   - 计划资产：人工/AI 引导/导入创建的设定，如势力、地点、章节模板、写作约束。
   - 生成后事实：从正文抽取出的事件、人物状态、伏笔、首次出现实体。
   二者都可召回，但来源、置信度和写入策略不同。

4. **所有进入正文 Prompt 的内容必须可追踪**  
   新模块必须携带 `projectId`、来源、状态、重要度、触发关键词或引用关系，召回结果继续通过 `sourceTrace` 进入 `retrievalPayload`。

5. **先做长篇最小闭环，再做完整商业化配置**  
   优先落地用户强调的 8 个关键模块：世界观、势力、角色关系、时间线、人物状态、地点、物品、写作约束。读者定位、情绪曲线、章节模板、质量评分等进入后续阶段。

## 3. 现有能力对照

| 建议模块 | 当前承载 | 缺口 | 推荐处理 |
|---|---|---|---|
| 读者与商业定位 | `Project.genre/theme/tone/targetWordCount`、`StyleProfile.pacing` | 平台、爽点、内容分级、单章字数、商业目标缺失 | 新增 `ProjectCreativeProfile` |
| 世界观设定 | `Project.synopsis` 被 `WorldviewEditor` 当世界观文本；`LorebookEntry` 可存设定 | 缺结构化字段、分类、锁定规则、专门页面 | 扩展 LorebookEntry + 新 Story Bible UI |
| 力量/能力体系 | `LorebookEntry(entryType=rule/setting)` | 缺等级、代价、限制、战斗规则结构 | 用 `entryType=power_system/rule` + metadata |
| 势力组织 | `LorebookEntry(entryType=faction)`，FactExtractor 可首次出现 faction | 缺专门字段、势力关系、控制区域 | 用 LorebookEntry + metadata，关系用 RelationshipEdge/FactionRelation |
| 角色关系网 | `StoryEvent(eventType=relationship_shift)`、`RelationshipGraphService` 只读临时图 | 缺持久关系边、隐藏关系、转折节点 | 新增 `RelationshipEdge` |
| 人物成长弧光 | `Character.growthArc` | 缺节点化成长路线和章节绑定 | Phase 2 扩展 `Character.metadata` 或新增 `CharacterArc` |
| 核心冲突与主线悬念 | `Project.outline`、`Volume.narrativePlan` | 缺独立字段和悬念分层 | 放入 `ProjectCreativeProfile.centralConflict` |
| 章节结构模板 | `Chapter.craftBrief` 是单章执行卡 | 缺模板库和模板选择 | 新增 `ChapterPattern` |
| 场景库 | 无专用模型 | 缺场景级计划与章节内场景拆分 | 新增 `SceneCard` |
| 地点与地图 | `LorebookEntry(entryType=location)`，FactExtractor 可首次出现 location | 缺地图层级、危险等级、出现章节 | LorebookEntry metadata + 地点页 |
| 时间线 | `StoryEvent` 绑定章节和正文抽取 | 缺计划时间线、事件公开性、角色知情表 | 新增 `TimelineEvent` |
| 人物状态表 | `CharacterStateSnapshot` | 缺“当前状态”聚合、死亡/失踪/可出场规则 | 做 Character State 全局页 + 可选 CurrentState 聚合 |
| 物品道具库 | `LorebookEntry(entryType=item)`，FactExtractor 可首次出现 item | 缺持有者、使用记录、限制、副作用 | LorebookEntry metadata + 道具页 |
| 伏笔回收计划 | `ForeshadowTrack` + `ForeshadowBoard` | metadata 中已有部分信息，但缺回收计划强字段和编辑 | 扩展看板编辑能力 |
| 禁忌与一致性规则 | `ValidationIssue`、PromptTemplate、硬规则 | 缺项目级可编辑约束和规则执行器 | 新增 `WritingRule` |
| 情绪曲线与节奏规划 | `Volume.narrativePlan`、`Chapter.craftBrief.progressTypes` | 缺可视化曲线和每章强度 | 新增 `PacingBeat` |
| AI 生成规则 | `LlmProvider`、`LlmRouting`、`ModelProfile`、生成请求参数 | 缺项目级自动续写/自动总结/新增实体权限 | 新增 `GenerationProfile` |
| 质量评分标准 | `GenerateChapterService.qualityGate`、`ValidationIssue` | 缺持久评分报告和维度趋势 | 新增 `QualityReport` |

## 4. 目标模块分层

### 4.1 创作目标层

承载“这本书写给谁、怎么卖、怎么读”的高层目标。

建议新增 `ProjectCreativeProfile`，与 `Project` 一对一：

```prisma
model ProjectCreativeProfile {
  id                 String   @id @default(uuid()) @db.Uuid
  projectId          String   @unique @db.Uuid
  audienceType       String?  @db.VarChar(80)
  platformTarget     String?  @db.VarChar(80)
  sellingPoints      Json     @default("[]")
  pacingPreference   String?  @db.VarChar(80)
  targetWordCount    Int?
  chapterWordCount   Int?
  contentRating      String?  @db.VarChar(80)
  centralConflict    Json     @default("{}")
  generationDefaults Json     @default("{}")
  validationDefaults Json     @default("{}")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

说明：

- `Project.targetWordCount` 可继续保留，`ProjectCreativeProfile.targetWordCount` 用作长篇规划配置，后续可同步。
- `centralConflict` 存核心问题、主角目标、反派目标、最大秘密、前中后期悬念。
- `generationDefaults` 存单章字数、是否自动总结、是否允许 AI 新增角色/地点/伏笔等项目级策略。

### 4.2 设定资产层

承载世界观、力量体系、势力、地点、物品、历史、规则。

第一阶段不建议新建 `Worldbuilding/Faction/Location/Item` 多张表，原因是：

- 当前 `LorebookEntry` 已经被召回链路、Agent 世界观工具、导入工具、FactExtractor 首次出现候选复用。
- 多张实体表会立刻要求多套 CRUD、召回、导入、去重和审核逻辑，开发成本高。

建议先扩展 `LorebookEntry`：

```prisma
model LorebookEntry {
  ...
  metadata Json @default("{}")
}
```

统一 entryType：

```text
world_rule
power_system
faction
faction_relation
location
item
history_event
religion
economy
technology
forbidden_rule
setting
```

典型 metadata：

```json
{
  "era": "时代背景",
  "region": "所属区域",
  "dangerLevel": "危险等级",
  "leader": "势力首领",
  "allies": ["盟友势力"],
  "enemies": ["敌对势力"],
  "holder": "当前持有者",
  "limits": ["使用限制"],
  "cost": "能力代价",
  "firstSeenChapterNo": 12,
  "futureUse": "后续用途"
}
```

### 4.3 连续性事实层

承载长篇最容易出错的“关系、时间、状态、知情范围”。

需要新增强结构模型，而不是只靠 Lorebook 文本。

#### RelationshipEdge

```prisma
model RelationshipEdge {
  id                 String   @id @default(uuid()) @db.Uuid
  projectId          String   @db.Uuid
  characterAId       String?  @db.Uuid
  characterBId       String?  @db.Uuid
  characterAName     String   @db.VarChar(100)
  characterBName     String   @db.VarChar(100)
  relationType       String   @db.VarChar(80)
  publicState        String?
  hiddenState        String?
  conflictPoint      String?
  emotionalArc       String?
  turnChapterNos     Json     @default("[]")
  finalState         String?
  status             String   @default("active") @db.VarChar(50)
  sourceType         String   @default("manual") @db.VarChar(50)
  metadata           Json     @default("{}")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

用途：

- 人物关系网编辑页。
- 章节生成前召回“当前关系/隐藏关系/冲突点”。
- 校验人物互动是否越级亲密、忘记敌对、提前知道秘密。

#### TimelineEvent

```prisma
model TimelineEvent {
  id             String   @id @default(uuid()) @db.Uuid
  projectId      String   @db.Uuid
  chapterId      String?  @db.Uuid
  chapterNo      Int?
  title          String   @db.VarChar(255)
  eventTime      String?
  locationName   String?
  participants   Json     @default("[]")
  cause          String?
  result         String?
  impactScope    String?
  isPublic       Boolean  @default(false)
  knownBy        Json     @default("[]")
  unknownBy      Json     @default("[]")
  eventStatus    String   @default("planned") @db.VarChar(50)
  sourceType     String   @default("manual") @db.VarChar(50)
  metadata       Json     @default("{}")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
```

用途：

- 计划时间线与正文抽取事件分离。
- 避免死人复活、角色瞬移、角色知道不该知道的信息。
- 与 `StoryEvent` 的关系：`StoryEvent` 继续作为正文抽取事件；`TimelineEvent` 是计划/确认后的规范时间线。后续可从 `StoryEvent` 审核晋升为 `TimelineEvent`。

#### WritingRule

```prisma
model WritingRule {
  id              String   @id @default(uuid()) @db.Uuid
  projectId       String   @db.Uuid
  ruleType        String   @db.VarChar(80)
  title           String   @db.VarChar(255)
  content         String
  severity        String   @default("warning") @db.VarChar(50)
  appliesFromChapterNo Int?
  appliesToChapterNo   Int?
  entityType      String?  @db.VarChar(80)
  entityRef       String?
  status          String   @default("active") @db.VarChar(50)
  metadata        Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

典型规则：

- 第 80 章前不能暴露主角血脉。
- 已死亡角色只能以回忆/传闻/遗物形式出现。
- 主角能力不能无成本无限使用。
- 反派不能降智。

### 4.4 场景与节奏层

#### SceneCard

场景库用于解决“章节有大纲但正文没有场景抓手”的问题。

```prisma
model SceneCard {
  id              String   @id @default(uuid()) @db.Uuid
  projectId       String   @db.Uuid
  volumeId        String?  @db.Uuid
  chapterId       String?  @db.Uuid
  sceneNo         Int?
  title           String   @db.VarChar(255)
  locationName    String?
  participants    Json     @default("[]")
  purpose         String?
  conflict        String?
  emotionalTone   String?
  keyInformation  String?
  result          String?
  relatedForeshadowIds Json @default("[]")
  status          String   @default("planned") @db.VarChar(50)
  metadata        Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

#### PacingBeat

用于情绪曲线和节奏规划：

```prisma
model PacingBeat {
  id                 String   @id @default(uuid()) @db.Uuid
  projectId          String   @db.Uuid
  volumeId           String?  @db.Uuid
  chapterId          String?  @db.Uuid
  chapterNo          Int?
  beatType           String   @db.VarChar(80)
  emotionalTone      String?
  emotionalIntensity Int      @default(50)
  tensionLevel       Int      @default(50)
  payoffLevel        Int      @default(50)
  notes              String?
  metadata           Json     @default("{}")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

### 4.5 生成与质量层

#### GenerationProfile

项目级生成策略，区别于全局 LLM Provider：

```prisma
model GenerationProfile {
  id                    String   @id @default(uuid()) @db.Uuid
  projectId             String   @unique @db.Uuid
  defaultChapterWordCount Int?
  autoContinue          Boolean  @default(false)
  autoSummarize         Boolean  @default(true)
  autoUpdateCharacterState Boolean @default(true)
  autoUpdateTimeline    Boolean  @default(false)
  autoValidation        Boolean  @default(true)
  allowNewCharacters    Boolean  @default(false)
  allowNewLocations     Boolean  @default(true)
  allowNewForeshadows   Boolean  @default(true)
  preGenerationChecks   Json     @default("[]")
  promptBudget          Json     @default("{}")
  metadata              Json     @default("{}")
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
}
```

#### QualityReport

保留章节生成后的评分和可追踪诊断：

```prisma
model QualityReport {
  id           String   @id @default(uuid()) @db.Uuid
  projectId    String   @db.Uuid
  chapterId    String?  @db.Uuid
  draftId      String?  @db.Uuid
  reportType   String   @db.VarChar(80)
  scores       Json     @default("{}")
  issues       Json     @default("[]")
  verdict      String   @db.VarChar(80)
  sourceType   String   @default("auto") @db.VarChar(50)
  createdAt    DateTime @default(now())
}
```

`GenerateChapterService.qualityGate` 可先写入 `ChapterDraft.generationContext`，后续 Phase 再落 `QualityReport`。

## 5. 前端信息架构

当前左侧菜单不宜一次展开成十几个同级按钮，否则会很挤。建议分两层推进。

### Phase 1 菜单

```text
全局创作
- 剧情大纲 Outline
- 角色与设定 Lore
- 世界设定 Story Bible
- 角色关系 Relationships
- 时间线 Timeline
- 状态表 Character State
- 卷管理 Volumes
- 创作引导 AI Guide
- AI 生成 Generate
- 提示词管理 Prompts
- 伏笔看板 Foreshadow
- 质量检查 Validation
- 生成配置 Generation Config
```

其中 `世界设定 Story Bible` 内部用 tabs 承载：

```text
世界观
力量体系
势力组织
地点地图
物品道具
历史事件
规则禁忌
```

### Phase 2 菜单

新增：

```text
- 场景库 Scenes
- 节奏曲线 Pacing
- 章节模板 Patterns
```

## 6. API 设计

优先新增资源型 API，保持与现有 Nest 模块一致。

```http
GET    /projects/:projectId/creative-profile
PATCH  /projects/:projectId/creative-profile

GET    /projects/:projectId/lorebook?entryType=faction
PATCH  /projects/:projectId/lorebook/:entryId
DELETE /projects/:projectId/lorebook/:entryId

GET    /projects/:projectId/writing-rules
POST   /projects/:projectId/writing-rules
PATCH  /writing-rules/:ruleId
DELETE /writing-rules/:ruleId

GET    /projects/:projectId/relationships
POST   /projects/:projectId/relationships
PATCH  /relationships/:relationshipId
DELETE /relationships/:relationshipId

GET    /projects/:projectId/timeline-events
POST   /projects/:projectId/timeline-events
PATCH  /timeline-events/:eventId
DELETE /timeline-events/:eventId

GET    /projects/:projectId/scenes
POST   /projects/:projectId/scenes
PATCH  /scenes/:sceneId
DELETE /scenes/:sceneId

GET    /projects/:projectId/pacing-beats
POST   /projects/:projectId/pacing-beats
PATCH  /pacing-beats/:beatId
DELETE /pacing-beats/:beatId

GET    /projects/:projectId/generation-profile
PATCH  /projects/:projectId/generation-profile

GET    /projects/:projectId/quality-reports
POST   /projects/:projectId/validation/run-quality-review
```

注意：

- 现有 `LorebookController` 只有 create 与 search，需要补齐 list/update/delete。
- 所有改变召回输入的写入都必须调用 `NovelCacheService.deleteProjectRecallResults(projectId)`。

## 7. 生成链路改造

### 7.1 Retrieval Planner

当前 `RetrievalPlannerService` 已输出：

- `entities.characters`
- `entities.locations`
- `entities.items`
- `entities.factions`
- `lorebookQueries`
- `memoryQueries`
- `relationshipQueries`
- `foreshadowQueries`

后续需要：

1. 把 `WritingRule`、`TimelineEvent`、`RelationshipEdge`、`SceneCard`、`PacingBeat` 纳入结构化召回。
2. 按章节号过滤未来信息，除非该资料是“写作计划”且明确允许进入规划上下文。
3. 在 `retrievalPayload` 中保留新增来源的 `sourceTrace`。

### 7.2 PromptBuilder

新增独立区块：

```text
【创作定位】
【核心冲突与悬念】
【世界规则/力量体系】
【势力/地点/道具】
【人物关系网】
【时间线与角色知情范围】
【写作约束】
【节奏目标】
```

原则：

- 锁定事实、写作禁忌、死亡状态优先级高于普通 Lorebook。
- `userIntent` 仍只代表本章要求，不自动升级为世界事实。
- 新增实体权限由 `GenerationProfile` 控制。

### 7.3 Preflight

生成前检查扩展：

- 本章是否缺少目标/冲突/执行卡。
- 本章涉及角色是否已死亡、失踪或不可出场。
- 章节计划是否违反 `WritingRule`。
- 章节时间线是否早于已发生事件。
- 本章要回收的伏笔是否已经埋设。
- AI 是否试图新增被禁止的新角色/地点/伏笔。

### 7.4 Postprocess / Fact Extraction

当前 `FactExtractorService` 已抽取事件、角色状态、伏笔、首次出现实体、人物关系变化。后续新增：

- 从关系变化写入或建议写入 `RelationshipEdge`。
- 从关键事件写入或建议写入 `TimelineEvent`。
- 从场景明显边界写入 `SceneCard` 候选。
- 按 `GenerationProfile` 决定 auto 或 pending_review。

## 8. 质量检查体系

质量评分维度：

```text
剧情推进
人物一致性
文风一致性
爽点/情绪兑现
冲突强度
节奏
伏笔利用
世界观/能力规则一致性
时间线与知情范围
禁忌规则
```

实现方式：

1. 硬规则先行：死亡角色、时间线顺序、伏笔范围、禁止提前泄露等。
2. LLM 审稿作为辅助：输出结构化 `QualityReport`，不直接覆盖正文。
3. 自动修复只修复本章草稿，不直接修改设定资产；如发现设定冲突，生成 `ValidationIssue` 或 pending review。

## 9. 推荐落地顺序

第一阶段必须先补齐长篇连续性核心：

```text
1. Story Bible 统一设定资产 UI
2. 写作目标 / 生成配置
3. 写作约束
4. 角色关系网
5. 时间线
6. 地点库 / 物品库 / 势力组织
7. 生成链路召回这些资料
8. 校验规则接入这些资料
```

第二阶段再补场景、节奏、模板和质量评分：

```text
1. 场景库
2. 章节模板
3. 情绪曲线
4. QualityReport
5. Agent 辅助生成/审稿/修复工作流
```

## 10. 风险

| 风险 | 应对 |
|---|---|
| 模块过多导致 UI 复杂 | 用 Story Bible tabs 聚合设定资产，关系/时间线/状态单独成页 |
| LorebookEntry 继续膨胀 | 用 `entryType + metadata` 先跑通；当某类资产需要复杂查询时再独立拆表 |
| 新事实污染已确认设定 | 保留 `status=pending_review`、`sourceType`、`locked` 语义 |
| Prompt 过长 | Retrieval Planner 只召回当前章节相关资料，PromptBuilder 分区压缩 |
| 时间线与 StoryEvent 重复 | `StoryEvent` 是正文抽取事实，`TimelineEvent` 是计划/确认事实，允许审核晋升 |
| 写作规则过严误伤创作 | `WritingRule.severity` 支持 info/warning/error，先 warning 后 blocker |
| 生成配置与 LLM 配置混淆 | `LlmProvider/LlmRouting` 管模型连接，`GenerationProfile` 管创作策略 |
