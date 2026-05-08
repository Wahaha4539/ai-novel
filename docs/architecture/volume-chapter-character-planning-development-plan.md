# 卷纲与章节细纲角色规划开发计划

> 状态：实施中  
> 范围：`generate_volume_outline_preview`、`generate_outline_preview`、`generate_chapter_outline_preview`、`validate_outline`、`persist_outline`、引导式 `guided_volume/guided_chapter`、Agent Artifact 展示与角色写入审批  
> 目标：让卷纲负责“本卷角色规划与重要新增角色候选”，让章节细纲负责“本章角色执行、关系推进和人物弧线落点”，并确保所有会进入审批、写入或后续生成链路的角色内容都遵守失败即失败原则。

## 1. 背景与结论

当前系统已经有结构化卷纲、章节细纲和 `Chapter.craftBrief`：

- `Volume.narrativePlan` 承载卷级主线、支线、单元故事和交接。
- `Chapter.craftBrief` 承载章级执行卡、行动链、场景段、线索、人物变化和连续状态。
- `Character` 表已经支持 `scope`、`activeFromChapter`、`activeToChapter`、`source` 和 `metadata`。
- `guided_chapter` 现有输出里已有 `supportingCharacters` 概念，但 Agent 侧卷纲/章节细纲还没有统一角色规划契约。

本次开发采用以下分层：

```text
既有 Character / Relationship / Lorebook
  ↓
卷纲：生成本卷角色规划、重要新增角色候选、人物弧线和关系弧
  ↓
审批：允许将重要新增角色候选写入 Character / RelationshipEdge
  ↓
章节细纲：引用既有角色或卷纲候选，生成本章出场、目标、压力、关系变化和人物弧线落点
  ↓
Chapter.craftBrief / 正文生成
```

核心边界：

- 卷纲可以生成“重要新增角色候选”，但写入正式角色库必须经过审批。
- 章节细纲不能自由发明重要角色；它只能引用既有角色或卷纲候选。
- 章节细纲可以生成临时功能角色，但必须标记为 `minor_temporary`，不得自动写入正式角色库。
- LLM 失败、超时、返回结构不完整、角色引用不合法或关键字段缺失时直接报错，不生成占位角色或模板人物。

## 2. 目标

- 卷纲输出 `Volume.narrativePlan.characterPlan`，覆盖本卷角色清单、重要新增角色候选、人物弧线和关系弧。
- 章节细纲输出 `Chapter.craftBrief.characterExecution`，覆盖本章出场角色、POV、角色目标、隐藏目标、压力、行动引用、场景参与和关系变化。
- `validate_outline` 在写入前拦截未知角色引用、缺失角色执行、章节级重要新角色、角色计划与章节执行不一致等问题。
- `persist_outline` 继续写入 `Volume.narrativePlan` 与 `Chapter.craftBrief`，不自动创建正式角色。
- 新增独立高风险写入工具，把已审批的卷级角色候选写入 `Character` 和可选 `RelationshipEdge`。
- Agent Artifact 和前端面板能展示角色规划覆盖率、候选角色、章节角色执行摘要和写入风险。

## 3. 非目标

- 不把章节细纲变成角色设定主入口。
- 不让章节细纲自动创建正式 `Character`。
- 不在 normalize、merge 或 persist 阶段补齐缺失角色、缺失动机、缺失关系弧。
- 不为 LLM 超时或失败生成确定性占位人物。
- 不重构现有 `Character` 表结构；第一阶段优先使用 `Volume.narrativePlan`、`Chapter.craftBrief` 和 `Character.metadata`。
- 不覆盖已起草章节正文，也不自动改写已确认的角色设定。

## 4. 数据契约

### 4.1 卷级角色规划

建议写入 `Volume.narrativePlan.characterPlan`：

```ts
type VolumeCharacterPlan = {
  existingCharacterArcs: Array<{
    characterId?: string;
    characterName: string;
    roleInVolume: string;
    entryState: string;
    volumeGoal: string;
    hiddenNeed?: string;
    pressure: string;
    keyChoices: string[];
    firstActiveChapter: number;
    lastActiveChapter?: number;
    endState: string;
  }>;
  newCharacterCandidates: Array<{
    candidateId: string;
    name: string;
    roleType: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
    scope: 'volume';
    narrativeFunction: string;
    personalityCore: string;
    motivation: string;
    backstorySeed: string;
    conflictWith: string[];
    relationshipAnchors: string[];
    firstAppearChapter: number;
    expectedArc: string;
    approvalStatus: 'candidate';
  }>;
  relationshipArcs: Array<{
    participants: string[];
    startState: string;
    hiddenTension?: string;
    turnChapterNos: number[];
    endState: string;
  }>;
  roleCoverage: {
    mainlineDrivers: string[];
    antagonistPressure: string[];
    emotionalCounterweights: string[];
    expositionCarriers: string[];
  };
};
```

校验原则：

- `existingCharacterArcs` 可为空，但如果项目已有核心角色，提示词应优先规划其本卷弧线。
- `newCharacterCandidates` 可以为空；如果不需要新角色，不强制编造。
- 每个候选角色必须有 `candidateId/name/roleType/narrativeFunction/personalityCore/motivation/firstAppearChapter/expectedArc`。
- `firstAppearChapter` 必须在本卷章节范围内。
- `relationshipArcs.participants` 只能引用既有角色名或 `newCharacterCandidates.name`。

### 4.2 章级角色执行

建议写入 `Chapter.craftBrief.characterExecution`：

```ts
type ChapterCharacterExecution = {
  povCharacter?: string;
  cast: Array<{
    characterName: string;
    characterId?: string;
    source: 'existing' | 'volume_candidate' | 'minor_temporary';
    functionInChapter: string;
    visibleGoal: string;
    hiddenGoal?: string;
    pressure: string;
    actionBeatRefs: number[];
    sceneBeatRefs: string[];
    entryState: string;
    exitState: string;
    dialogueJob?: string;
  }>;
  relationshipBeats: Array<{
    participants: string[];
    publicStateBefore: string;
    hiddenStateBefore?: string;
    trigger: string;
    shift: string;
    publicStateAfter: string;
    hiddenStateAfter?: string;
  }>;
  newMinorCharacters: Array<{
    nameOrLabel: string;
    narrativeFunction: string;
    interactionScope: string;
    firstAndOnlyUse: boolean;
    approvalPolicy: 'preview_only' | 'needs_approval';
  }>;
};
```

校验原则：

- 每章 `characterExecution.cast` 至少 1 人。
- `cast.source = existing` 时，角色名必须能在项目角色列表中解析到，或通过别名解析。
- `cast.source = volume_candidate` 时，角色名必须来自 `Volume.narrativePlan.characterPlan.newCharacterCandidates`。
- `cast.source = minor_temporary` 只能用于临时功能角色，且必须出现在 `newMinorCharacters`。
- `minor_temporary` 不得承担本卷主线核心功能、反派主压力或长期人物弧。
- `sceneBeats.participants` 应能被 `characterExecution.cast.characterName` 覆盖；缺失即 error。
- 章节不得直接新增 `supporting/protagonist/antagonist` 等重要角色；这类角色必须先进入卷级候选。

## 5. 阶段任务

### P0：契约与边界落定

目标：在不改数据库 schema 的前提下，确定角色规划字段、失败策略和审批边界。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P0-01 | done | 在开发文档和 Prompt 指南中记录“卷纲生成角色规划，章节细纲生成角色执行”的分层。 | `docs/prompt-template-guide.md`, 本文档 | 文档明确章节细纲不得自由生成重要角色。 |
| VCC-P0-02 | done | 扩展本地 TS 类型：`VolumeCharacterPlan`、`ChapterCharacterExecution`。 | `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts` 或新增共享类型文件 | 已新增共享契约与基础校验 helper；字段可被 `narrativePlan` 和 `craftBrief` 引用。 |
| VCC-P0-03 | done | 明确失败即失败策略，不允许角色 fallback。 | 相关 Tool 注释、测试用例 | LLM 超时、候选角色字段缺失、章节角色引用未知时均抛错。 |

### P1：卷纲角色规划生成

目标：卷纲产物生成本卷角色规划和重要新增角色候选。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P1-01 | done | 更新 `generate_volume_outline_preview` system prompt，要求输出 `narrativePlan.characterPlan`。 | `apps/api/src/modules/agent-tools/tools/generate-volume-outline-preview.tool.ts` | LLM mock 返回完整 `characterPlan` 时 normalize 保留字段。 |
| VCC-P1-02 | done | 更新 `generate_outline_preview` system prompt，在整卷细纲模式下也要求 `volume.narrativePlan.characterPlan`。 | `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts` | outline preview 中卷级角色规划完整。 |
| VCC-P1-03 | done | `buildUserPrompt` 注入既有角色、关系边和角色状态摘要，避免重复造人。 | `generate-volume-outline-preview.tool.ts`, `generate-outline-preview.tool.ts`, `generate_chapter_outline_preview`, `inspect_project_context` 相关工具 | Prompt 中包含既有角色名、别名、角色 scope、关系摘要。 |
| VCC-P1-04 | done | 增加卷级角色规划 normalize 校验。 | `generate-volume-outline-preview.tool.ts`, `generate-outline-preview.tool.ts` | 缺 `name/motivation/narrativeFunction/firstAppearChapter` 直接抛错。 |
| VCC-P1-05 | done | 校验候选角色首次出场章号与本卷 chapterCount 一致。 | 同上 | `firstAppearChapter` 越界直接抛错。 |

### P2：章节细纲角色执行生成

目标：章节细纲不再只写 `characterShift`，而是输出可执行的本章角色调度。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P2-01 | done | 扩展 `ChapterCraftBrief`，新增 `characterExecution`。 | `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts`, `chapter-outline-preview-tools.tool.ts` | 类型编译通过。 |
| VCC-P2-02 | done | 更新 `generate_chapter_outline_preview` prompt，要求引用既有角色或卷级候选。 | `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts` | LLM mock 生成的本章角色均有 `source` 和目标/压力/入场/离场状态。 |
| VCC-P2-03 | done | 更新 `generate_outline_preview` 的逐章 prompt，要求每章输出 `craftBrief.characterExecution`。 | `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts` | 每章 normalize 后均含角色执行。 |
| VCC-P2-04 | done | 增加角色引用解析：既有角色、卷级候选、临时角色三类来源。 | `generate-outline-preview.tool.ts`, `chapter-outline-preview-tools.tool.ts` | 引用未知角色、错误 source、候选名不匹配均抛错。 |
| VCC-P2-05 | done | 校验 `sceneBeats.participants` 与 `characterExecution.cast` 一致。 | 同上 | 场景参与者不在 cast 中时抛错。 |
| VCC-P2-06 | done | 校验章节级临时角色不能承担重要长线功能。 | 同上 | `minor_temporary` 出现在主线驱动或长期人物弧时抛错。 |
| VCC-P2-07 | done | 合并多章预览时保留角色执行并做完整性检查。 | `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts` | `merge_chapter_outline_previews` 遇到缺失 `characterExecution` 的章节直接失败。 |

### P3：校验、写入和角色候选入库

目标：写入前能拦截角色质量问题；重要新增角色需要单独审批后入库。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P3-01 | done | 扩展 `validate_outline` 统计：卷级角色候选数、章节角色执行覆盖数、未知角色引用数、临时角色数。 | `apps/api/src/modules/agent-tools/tools/validate-outline.tool.ts` | validation report 输出新增 stats。 |
| VCC-P3-02 | done | `validate_outline` 对缺失 `characterPlan`、缺失 `characterExecution`、未知角色引用给 error。 | 同上 | 有问题的 preview `valid=false`。 |
| VCC-P3-03 | done | `persist_outline` 保持只写 `Volume.narrativePlan` 和 `Chapter.craftBrief`，不自动创建 `Character`。 | `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts` | 审批写入后 Character 表无自动新增。 |
| VCC-P3-04 | done | 新增 `persist_volume_character_candidates` Tool，审批后把卷级候选写入 `Character`。 | 新增 Tool、`tool-registry.service.ts`, `agent-tools.module.ts` | 只写入被批准的候选；`scope='volume'`，`source='agent_outline'`，`activeFromChapter` 正确。 |
| VCC-P3-05 | done | 可选写入关系弧到 `RelationshipEdge`。 | 新增 Tool 或扩展 VCC-P3-04 | 关系两端角色能解析时写入；不能解析时直接失败，不创建半截关系。 |
| VCC-P3-06 | done | 写入审批文案明确区分“写入卷/章节规划”和“写入正式角色”。 | Agent approval 相关文案 | 用户能看到会创建哪些角色、哪些关系、哪些章节只保留 JSON 规划。 |

### P4：引导式流程对齐

目标：`guided_volume` 与 `guided_chapter` 和 Agent 工具采用同一角色规划语义。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P4-01 | done | 更新 `guided_volume` 提示词，要求输出卷级 `characterPlan`。 | `apps/api/src/modules/guided/guided.service.ts` | guided 卷纲生成结果包含角色规划。 |
| VCC-P4-02 | done | 更新 `guided_chapter` 提示词，要求输出 `craftBrief.characterExecution`。 | `apps/api/src/modules/guided/guided.service.ts` | guided 章节细纲生成结果包含章级角色执行。 |
| VCC-P4-03 | done | 处理现有 `supportingCharacters`：继续兼容读取，但新链路以 `characterPlan.newCharacterCandidates` 为主。 | `guided.service.ts` | 旧项目不报错，新项目使用新结构。 |
| VCC-P4-04 | done | 保存本卷时不把章节级临时角色写入正式角色库。 | `guided.service.ts` | `minor_temporary` 只保存在 `craftBrief`，不会 create Character。 |

### P5：Agent 计划、Artifact 与前端展示

目标：用户能在审批前看到角色规划和章节角色执行，不需要打开原始 JSON 才能判断风险。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P5-01 | done | 更新 Tool Manifest 示例和 Planner guidance。 | `generate-outline-preview.tool.ts`, `generate-volume-outline-preview.tool.ts`, `chapter-outline-preview-tools.tool.ts`, `agent-planner.service.ts` | 用户说“卷纲/章节细纲/角色安排”时走 outline 链路，不误走正文生成。 |
| VCC-P5-02 | done | `OutlinePreviewSummary` 增加角色规划指标。 | `apps/web/components/agent/AgentArtifactPanel.tsx` | 展示候选角色数、章节角色执行覆盖、未知角色风险。 |
| VCC-P5-03 | done | 章节摘要展示本章 cast、POV、角色目标和关系变化。 | `AgentArtifactPanel.tsx` | 前 5 章摘要能看到角色执行，不只看到行动链。 |
| VCC-P5-04 | done | 卷管理或章节详情展示 `craftBrief.characterExecution` 摘要。 | `apps/web/components/VolumePanel.tsx`, `EditorPanel.tsx` | 写入后用户能查看本章角色执行。 |
| VCC-P5-05 | done | 角色候选入库审批结果提供专用 Artifact。 | `AgentArtifactPanel.tsx`、新增 persist Tool | 展示 created/updated/skipped 角色数和关系数。 |

### P6：测试与验收

目标：把失败即失败写进自动化测试，避免以后被 fallback 或 normalize 静默破坏。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| VCC-P6-01 | done | LLM timeout 直接抛错，不生成角色占位。 | API 单测 | timeout mock 断言 reject。 |
| VCC-P6-02 | done | 卷级候选角色字段缺失直接抛错。 | API 单测 | 缺 `motivation`、`narrativeFunction`、`firstAppearChapter` 均失败。 |
| VCC-P6-03 | done | 章节引用未知角色直接抛错。 | API 单测 | `characterExecution.cast` 引用不存在角色且非候选/临时时失败。 |
| VCC-P6-04 | done | 章节级重要新角色直接抛错。 | API 单测 | 章节新增 `supporting` 但卷级无候选时失败。 |
| VCC-P6-05 | done | `sceneBeats.participants` 与 cast 不一致直接抛错。 | API 单测 | 参与者漏列时失败。 |
| VCC-P6-06 | done | `validate_outline` 拦截角色执行缺失。 | API 单测 | 缺 `craftBrief.characterExecution` 时 `valid=false`。 |
| VCC-P6-07 | done | 角色候选入库需要审批，并且不覆盖用户手工角色。 | API 单测 | 同名手工角色默认 skip 或需要明确 update intent。 |
| VCC-P6-08 | done | Web Artifact 展示角色规划指标。 | Web 构建验证 | 页面显示角色候选数与章节角色执行覆盖。 |

建议验证命令：

```bash
pnpm --filter api test:agent
pnpm --filter api build
pnpm --filter web build
```

真实 Web 验收按项目约定使用 Docker Compose：

```bash
docker compose ps
docker compose up -d --build
```

## 6. 关键验收场景

### 场景 A：卷纲生成新角色候选

输入：“为第 1 卷生成 20 章细纲，需要补充反派阵营角色。”

期望：

- `volume.narrativePlan.characterPlan.newCharacterCandidates` 包含反派阵营候选。
- 每个候选角色有明确叙事功能、动机、首次出场章和本卷弧线。
- `validate_outline` 能统计候选角色数量。
- `persist_outline` 只写入规划 JSON，不自动创建正式角色。
- 用户审批 `persist_volume_character_candidates` 后，候选才进入 `Character` 表。

### 场景 B：章节细纲引用卷级候选

输入：“继续生成第 3 章细纲。”

期望：

- 第 3 章 `craftBrief.characterExecution.cast` 可以引用卷级候选。
- `source` 必须为 `volume_candidate`。
- 角色在本章有目标、压力、入场状态和离场状态。
- `sceneBeats.participants` 与 cast 一致。

### 场景 C：章节细纲试图发明重要角色

输入或 LLM 返回：第 8 章突然新增长期配角，但卷纲没有候选。

期望：

- normalize 或 validate 直接失败。
- 错误信息提示“重要角色必须先进入卷级角色候选”。
- 不写入 `Chapter.craftBrief`，不进入审批。

### 场景 D：章节临时角色

输入或 LLM 返回：第 5 章出现只服务一次审讯场景的门卫。

期望：

- `cast.source = minor_temporary`。
- `newMinorCharacters` 写清叙事功能、互动范围和是否一次性使用。
- 不写入 `Character` 表。
- 如果该角色承担长期关系弧或主线核心压力，校验失败。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 角色规划字段过多导致 LLM 更容易漏字段 | 生成失败率上升 | 卷级和章级分层生成；缺字段直接报错，提示缩小范围或重试。 |
| 章节细纲继续发明角色 | 设定库污染、正文不连续 | 章节角色引用必须解析到既有角色、卷级候选或临时角色。 |
| 候选角色自动入库过早 | 用户设定被污染 | 候选只进 `narrativePlan`；正式入库使用独立高风险审批 Tool。 |
| 同名角色与已有角色冲突 | 关系和召回混乱 | 写入候选前做名称/别名冲突检查，默认 skip 手工角色。 |
| 临时角色被滥用为重要角色 | 角色资产不可追踪 | 校验 `minor_temporary` 的功能范围和关系弧长度。 |
| 前端只展示 JSON，用户难审批 | 审批质量低 | Artifact 摘要展示候选角色、cast、关系变化和风险。 |

## 8. 推荐实施顺序

1. 先做 P0-P1：完成卷级角色规划契约、Prompt 和 normalize 校验。
2. 再做 P2：给章节细纲补 `characterExecution`，并强校验角色引用。
3. 再做 P3：扩展 `validate_outline`，保持 `persist_outline` 不自动入库，新增角色候选审批写入 Tool。
4. 再做 P4-P5：对齐 guided 流程和前端展示。
5. 最后做 P6 的完整回归与 Docker Compose 真实验收。

每个阶段都应保持一个原则：角色内容一旦可能进入审批、写入或后续生成链路，就不能用占位、模板或静默补齐掩盖 LLM 失败。

## 9. 参考文件

| 文件 | 作用 |
|---|---|
| `apps/api/src/modules/agent-tools/tools/generate-volume-outline-preview.tool.ts` | 单独卷纲预览生成，适合加入 `narrativePlan.characterPlan`。 |
| `apps/api/src/modules/agent-tools/tools/generate-outline-preview.tool.ts` | 整体卷/章节细纲预览生成，需扩展卷级角色规划和章级角色执行。 |
| `apps/api/src/modules/agent-tools/tools/chapter-outline-preview-tools.tool.ts` | 单章细纲预览与合并，需校验角色引用和 `characterExecution`。 |
| `apps/api/src/modules/agent-tools/tools/validate-outline.tool.ts` | 写入前校验，需新增角色规划和角色执行问题。 |
| `apps/api/src/modules/agent-tools/tools/persist-outline.tool.ts` | 写入卷/章节规划，保持不自动创建正式角色。 |
| `apps/api/src/modules/guided/guided.service.ts` | 引导式卷纲/章节细纲生成与保存，需与 Agent 契约对齐。 |
| `apps/api/prisma/schema.prisma` | `Character`、`RelationshipEdge`、`Volume.narrativePlan`、`Chapter.craftBrief` 数据承载。 |
| `apps/web/components/agent/AgentArtifactPanel.tsx` | Agent Artifact 预览，需展示角色规划摘要。 |
| `apps/web/components/VolumePanel.tsx` | 写入后的卷/章节规划展示入口。 |
| `docs/prompt-template-guide.md` | Prompt 模板说明，需要更新角色规划规则。 |

## 10. 实施记录

| 日期 | 小任务 | 改动摘要 | 验证 |
|---|---|---|---|
| 2026-05-08 | VCC-P0-02 | 新增 `outline-character-contracts.ts`，定义 `VolumeCharacterPlan`、`ChapterCharacterExecution`、角色来源枚举和基础失败即失败校验 helper；新增 `AGENT_TEST_FILTER` 支持，便于小任务阶段只运行新增 agent 测试。 | `AGENT_TEST_FILTER='VCC character contract' pnpm --filter api test:agent` 通过 5/276 项。 |
| 2026-05-08 | VCC-P1-01/P1-02/P1-04/P1-05 | `generate_volume_outline_preview` 与 `generate_outline_preview` prompt 要求输出 `narrativePlan.characterPlan`；normalize 阶段调用共享契约校验，候选关键字段缺失、`firstAppearChapter` 越界或关系参与者非法时直接失败，不生成角色 fallback。 | `AGENT_TEST_FILTER='VCC volume outline preview' pnpm --filter api test:agent` 通过 2/279 项；`AGENT_TEST_FILTER='VCC outline preview requires' pnpm --filter api test:agent` 通过 1/279 项。 |
| 2026-05-08 | VCC-P2-01..P2-07 | `generate_outline_preview` 与 `generate_chapter_outline_preview` 要求并校验 `craftBrief.characterExecution`；校验 cast/source、卷级候选引用、临时角色边界、relationship/scene participants 覆盖，并在 `merge_chapter_outline_previews` 拦截缺失角色执行的章节。 | `AGENT_TEST_FILTER='VCC chapter outline preview' pnpm --filter api test:agent` 通过 2/283 项；`AGENT_TEST_FILTER='VCC chapter outline preview rejects important' pnpm --filter api test:agent` 通过 1/284 项；`AGENT_TEST_FILTER='VCC outline preview rejects scene' pnpm --filter api test:agent` 通过 1/283 项；`AGENT_TEST_FILTER='VCC merge chapter' pnpm --filter api test:agent` 通过 1/283 项。 |
| 2026-05-08 | VCC-P3-01..P3-03 | `validate_outline` 增加角色规划 stats 与错误拦截，复用角色契约检查缺失 `characterPlan`、缺失/非法 `characterExecution`、未知角色和 scene participants 未覆盖；`persist_outline` 在写入前要求有效校验结果并重新执行角色规划安全检查，只写 `Volume.narrativePlan` 与 `Chapter.craftBrief`，不创建 `Character`。 | `AGENT_TEST_FILTER='VCC validate_outline' pnpm --filter api test:agent` 通过 3/290 项；`AGENT_TEST_FILTER='VCC persist_outline' pnpm --filter api test:agent` 通过 3/290 项；`AGENT_TEST_FILTER='PersistOutlineTool 写入新建' pnpm --filter api test:agent` 通过 1/290 项；`AGENT_TEST_FILTER='PersistOutlineTool 拒绝旧 outline_preview' pnpm --filter api test:agent` 通过 1/290 项；`AGENT_TEST_FILTER='ValidateOutlineTool 生成写入前 diff' pnpm --filter api test:agent` 通过 1/290 项；`AGENT_TEST_FILTER='ValidateOutlineTool 容忍 LLM' pnpm --filter api test:agent` 通过 1/290 项。 |
| 2026-05-08 | VCC-P3-04..P3-06 | 新增高风险审批 Tool `persist_volume_character_candidates`，审批后把卷级候选写入正式 `Character`，跳过手工/非 agent 角色，允许更新 `source='agent_outline'` 的候选；可选写入可解析两端的 `RelationshipEdge`，并在 description/manifest/output 中区分正式角色写入、卷/章节 JSON 规划和章节临时角色。 | `AGENT_TEST_FILTER='VCC persist_volume_character_candidates' pnpm --filter api test:agent` 通过 3/293 项；`AGENT_TEST_FILTER='AppModule compiles' pnpm --filter api test:agent` 通过 1/293 项。 |
| 2026-05-08 | VCC-P4-01..P4-04 | `guided_volume`/`guided_chapter` prompt 与 schema 对齐角色规划契约；生成与写入前显式校验 `narrativePlan.characterPlan` 和 `craftBrief.characterExecution`；单章细化遇到卷号/章号错配直接失败；旧 `supportingCharacters` 仅保存在 guided session 兼容展示，不再自动创建正式 `Character`。 | `AGENT_TEST_FILTER='VCC guided_' pnpm --filter api test:agent` 通过 4/297 项。 |
| 2026-05-08 | VCC-P5-01 | 将 `generate_volume_outline_preview` 接入生产 `ToolRegistryService`，并把卷纲/章节细纲 outline 工具组加入默认 skill tools；AppModule 测试断言 registry、planner manifest 与默认工具列表都包含新 outline 链路。 | `AGENT_TEST_FILTER='AppModule compiles' pnpm --filter api test:agent` 通过 1/297 项。 |
| 2026-05-08 | VCC-P5-02/P5-03/P5-05 | Agent Artifact 的 `outline_preview` 增加角色候选、角色执行覆盖、临时角色与角色风险指标；章节摘要展示 POV、cast、角色目标、关系变化和临时角色；新增 `volume_character_candidates_persist_result` 专用展示，并补齐前端 tool 说明与 guided 类型。 | `pnpm --dir apps/web build` 通过。 |
| 2026-05-08 | VCC-P5-04 | 卷管理章节展开行与章节详情顶部规划卡展示 `craftBrief.characterExecution` 摘要，包含 POV、cast 来源与目标/功能、关系变化以及临时角色数量和名称。 | `pnpm --dir apps/web build` 通过。 |
| 2026-05-08 | VCC-P0-01/P0-03/P1-03 | `inspect_project_context` 读取并输出角色别名、scope、关系锚点、RelationshipEdge 摘要和近期 CharacterStateSnapshot；卷纲、整卷细纲和默认单章细纲 prompt 均注入角色/关系/状态摘要；角色契约校验接收既有角色别名，避免 prompt 允许别名但 normalize 判未知；Prompt 指南记录卷纲角色规划、章节角色执行与失败即失败边界。 | `AGENT_TEST_FILTER='VCC context injection' pnpm --filter api test:agent` 通过 2/300 项。 |
| 2026-05-08 | VCC-P6-01..P6-08 | 回归测试覆盖 LLM timeout 直接抛错、卷级候选关键字段缺失、未知角色引用、章节级重要临时角色、scene participants 与 cast 不一致、`validate_outline` 缺失角色执行、角色候选入库审批/手工角色 skip，以及 Agent Artifact 角色规划指标展示构建验证。 | `AGENT_TEST_FILTER='VCC character contract rejects missing volume candidate required field' pnpm --filter api test:agent` 通过 1/300 项；相关 VCC 定向测试与 `pnpm --dir apps/web build` 已在对应实施记录中通过。 |
| 2026-05-08 | Review fixes | 根据最终只读审查修复高/中风险：卷级 `conflictWith`、`relationshipAnchors`、`roleCoverage` 引用未知角色直接失败；`newMinorCharacters` 自身字段不得承载重要/长期临时角色；`persist_volume_character_candidates` 必须显式选择候选或 `approveAll=true`；`guided_volume` 必须显式 `volumeNo/chapterCount`，`validate_guided_step_preview` 同步校验 `characterPlan` 与 `characterExecution`。 | `AGENT_TEST_FILTER='VCC character contract' pnpm --filter api test:agent` 通过 7/302 项；`AGENT_TEST_FILTER='VCC persist_volume_character_candidates' pnpm --filter api test:agent` 通过 4/303 项；`AGENT_TEST_FILTER='VCC guided_' pnpm --filter api test:agent` 通过 5/306 项；`AGENT_TEST_FILTER='VCC validate_guided_step_preview' pnpm --filter api test:agent` 通过 2/306 项；`AGENT_TEST_FILTER='ValidateGuidedStepPreviewTool' pnpm --filter api test:agent` 通过 2/306 项。 |
| 2026-05-08 | Final review hardening | 根据最终复审继续收紧：`existingCharacterArcs` 只能引用真实角色目录，不能由本次卷纲自证；`validate_outline`、`persist_outline` 与 `merge_chapter_outline_previews` 不再用卷纲 arcs 反向扩充 existing 角色；旧 guided finalize 对 `{}`/空 `volumes`/空 `chapters` 直接失败且不保存 session；`generate_guided_step_preview` 对非对象 LLM 输出直接失败；前端 guided 卷纲类型补齐 `chapterCount`。 | `AGENT_TEST_FILTER='VCC character contract' pnpm --filter api test:agent` 通过 8/309 项；`AGENT_TEST_FILTER='VCC validate_outline' pnpm --filter api test:agent` 通过 4/309 项；`AGENT_TEST_FILTER='VCC persist_outline' pnpm --filter api test:agent` 通过 4/309 项；`AGENT_TEST_FILTER='merge_chapter_outline_previews' pnpm --filter api test:agent` 通过 1/309 项；`AGENT_TEST_FILTER='VCC guided finalize' pnpm --filter api test:agent` 通过 1/310 项；`AGENT_TEST_FILTER='VCC generate_guided_step_preview' pnpm --filter api test:agent` 通过 1/311 项；`AGENT_TEST_FILTER='VCC guided_' pnpm --filter api test:agent` 通过 5/311 项。 |
| 2026-05-08 | Final reviewer fixes | 根据最终 reviewer 的高/中风险结论继续修复：停用旧 `/guided-session/finalize-step` 直写入口，前端 `[STEP_COMPLETE]` 只保存引导草稿、不自动写库；抽出共享 `assertVolumeNarrativePlan`，让 `generate_volume_outline_preview`、`generate_outline_preview`、`validate_outline`、`persist_outline`、`validate_guided_step_preview` 与 `GuidedService.finalizeStep` 统一要求完整卷级 `narrativePlan`；`persist_guided_step_result` 在不完整 guided_volume 上阻止调用写入服务；Agent Artifact 将历史 fallback 风险展示为异常风险章节，提示重新生成并通过校验。 | `AGENT_TEST_FILTER='VCC legacy guided finalize-step endpoint' pnpm --filter api test:agent` 通过 1/312 项；`pnpm --filter web build` 通过；`AGENT_TEST_FILTER='VCC outline preview rejects incomplete volume narrativePlan' pnpm --filter api test:agent` 通过 1/317 项；`AGENT_TEST_FILTER='VCC validate_guided_step_preview rejects incomplete volume narrativePlan' pnpm --filter api test:agent` 通过 1/317 项；`AGENT_TEST_FILTER='VCC guided_volume rejects incomplete narrativePlan before writes' pnpm --filter api test:agent` 通过 1/317 项；`AGENT_TEST_FILTER='VCC validate_outline and persist_outline reject incomplete volume narrativePlan' pnpm --filter api test:agent` 通过 1/317 项；`AGENT_TEST_FILTER='VCC persist_guided_step_result rejects incomplete guided_volume before service write' pnpm --filter api test:agent` 通过 1/317 项；`pnpm --filter web build` 通过。 |
