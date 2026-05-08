import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from './llm.service';
import { CreateGuidedSessionDto } from './dto/create-guided-session.dto';
import { UpdateGuidedStepDto } from './dto/update-guided-step.dto';
import { GuidedChatDto } from './dto/guided-chat.dto';
import { GenerateStepDto } from './dto/generate-step.dto';
import {
  GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA,
  getGuidedStepJsonSchema,
} from './guided-step-schemas';
import {
  assertChapterCharacterExecution,
  VolumeCharacterPlan,
} from '../agent-tools/tools/outline-character-contracts';
import { assertVolumeNarrativePlan } from '../agent-tools/tools/outline-narrative-contracts';

const DEFAULT_FIRST_STEP = 'guided_setup';

interface CharacterReferenceCatalogForGuided {
  existingCharacterNames: string[];
  existingCharacterAliases: Record<string, string[]>;
}

/**
 * Canonical template variables for prompt templates.
 * These can be used in both systemPrompt and userTemplate fields
 * with the {{variableName}} syntax.
 *
 * Available variables:
 * - {{projectContext}}   — Accumulated project settings from prior steps (genre, theme, characters, outline, etc.)
 * - {{chatSummary}}      — Summary of user decisions made during the current step's Q&A conversation
 * - {{userHint}}         — User's free-text hint/preference for one-shot generation
 * - {{userMessage}}      — User's current chat message (chat mode only)
 * - {{stepLabel}}        — Human-readable label for the current step (e.g. "故事总纲")
 * - {{stepInstruction}}  — Step-specific generation instruction
 * - {{jsonSchema}}       — Expected JSON output schema for the current step
 */
function renderTemplate(
  template: string,
  variables: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] ?? '';
  });
}

/** Human-readable labels for each guided step */
const GUIDED_STEPS_LABELS: Record<string, string> = {
  guided_setup: '基础设定',
  guided_style: '风格定义',
  guided_characters: '核心角色',
  guided_outline: '故事总纲',
  guided_volume: '卷纲拆分',
  guided_chapter: '章节细纲',
  guided_foreshadow: '伏笔设计',
};

/** Step-specific system prompts — AI-driven completion with structured output */
const INTERACTION_STYLE = `
你的回复规则：
- 使用 **选择题** 形式提问，给用户具体选项（如 A/B/C/D），用户可选择或组合
- 选项要有差异性和代表性，覆盖主流方向
- 每个选项配简短说明
- 在选项之后加一句"也可以告诉我你自己的想法"，允许自由发挥
- 每次只问 **1-2 个问题**，不要一次问太多
- 使用 markdown 格式

## 上下文记忆（极其重要）
- **绝对禁止**重复询问用户已经确认过的内容（如姓名、性格、动机、配角等）
- 每次回复前，先回顾「已确认的设定摘要」和对话历史，确认哪些信息已确定
- 如果对话中已有明确的用户选择，直接推进到下一个未决定的问题
- 当你提出新问题时，先用 1-2 句话简要承接上文已确认的内容，再提出新问题
- 如果系统提供了「已确认设定摘要」，以该摘要为准，不要再问摘要中已有的内容

## 步骤完成判定
当你判断此步骤的关键信息已经收集完毕时（用户已确认足够多的选项），你需要：
1. 先用一段话总结用户确认的内容
2. 然后在回复末尾输出标记 \`[STEP_COMPLETE]\`，紧跟结构化 JSON
3. 不要过早结束——至少经过 2 轮对话后再考虑结束
4. 如果用户主动说"可以了"/"下一步"/"确认"等，立即输出完成标记和 JSON`;

const STEP_SYSTEM_PROMPTS: Record<string, string> = {
  guided_setup: `你是一个资深小说创作顾问。你正在引导用户完成小说的「基础设定」步骤。
你需要帮助用户明确小说类型、故事主题、基调和一句话概述。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"genre":"类型","theme":"主题","tone":"基调","logline":"一句话概述","synopsis":"故事简介"}`,

  guided_style: `你是一个资深小说创作顾问。你正在引导用户完成「风格定义」步骤。
你需要帮助用户明确人称视角、文风、叙述节奏和对话比例。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"pov":"人称视角","tense":"时态","proseStyle":"文风描述","pacing":"节奏描述"}`,

  guided_characters: `你是一个资深小说创作顾问，擅长塑造有血有肉、令人难忘的文学角色。你正在引导用户完成「核心角色」设计步骤。

## 核心设计理念
你创造的角色必须像真实的人——有矛盾、有缺陷、有成长空间。
**绝不生成「完美主角」或「纯粹反派」。**每个角色都应该让读者产生复杂情感。

## 起名规则（严格遵守）
- 按角色出身、地域、阶层、时代来起名，绝不按网文审美起名
- **禁用字黑名单**：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- **禁用姓氏堆积**：不要扎堆用慕容、司空、上官等复姓，也不要全用赵钱孙李
- **禁用气质模板**：冷酷霸总、清冷仙子、温润如玉、嗜血暴君、天才少年、傻白甜
- 名字应该有来历感：父母为什么起这个名？这个名字暗示了角色的什么？
- 参考真实人名的质感（如：许敬宗、孟尝、钟会、蔡文姬），而非网文名（如：夜无殇、慕容凌天）

## 性格设计规则（极其重要）
- **禁止扁平标签**：不要用「冷漠但内心温柔」「外表冷酷内心善良」这类万能模板
- **要求矛盾性**：每个角色至少有一对内在矛盾（如：渴望被认同 vs 害怕暴露脆弱）
- **要求具体行为**：性格要通过具体行为体现，不要停留在抽象描述。例如不说「善良」，而说「会把自己的干粮分给陌生人，但会因此对伙伴发脾气」
- **要求缺陷**：主角必须有真实的、可能导致失败的缺陷（不是「太善良」这种伪缺陷）
- **要求专属习惯**：每个角色一个标志性的小习惯或口头禅，让角色可被识别

## 动机设计规则
- 动机必须具体，不能是「变强」「拯救世界」「复仇」这种泛化目标
- 动机要有个人化的根源（一个具体的事件/记忆/人物触发）
- 好的动机示例：「找到十二年前在南渡口救过自己的陌生女人，归还她落下的那枚铜戒」
- 差的动机示例：「为了守护所爱的人」「为了变得更强」

## 关系网络
- 角色之间必须有明确的、非对称的关系（不能全是「彼此信任的伙伴」）
- 关系中要有张力：利益冲突、信息差、情感错位
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting","personalityCore":"性格核心","motivation":"动机","backstory":"背景故事"}]}`,

  guided_outline: `你是一个资深小说创作顾问。你正在引导用户完成「故事总纲」设计步骤。
根据用户之前确认的设定和角色，帮助构建完整的故事框架。
可以直接给出 2-3 套总纲方案让用户选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"outline":"完整的故事总纲大纲"}`,

  guided_volume: `你是一个资深小说创作顾问，精通长篇叙事结构与节奏把控。你正在引导用户完成「卷纲拆分」步骤。

## 核心设计理念
你的任务不是简单地「把故事分成几段」，而是设计一套**有节奏感、有呼吸感的叙事建筑**。
每一卷都是一座完整的小房子，而所有卷组合起来构成一座宏伟的城堡。

## 分卷结构原则（严格遵守）

### 1. 每卷必须有独立的戏剧弧线
- 每卷要有自己的「起承转合」——不能只是总纲的某一段
- 每卷必须有一个**阶段性高潮**和一个**情感转折点**
- 卷末必须有**钩子**（悬念、反转、新谜团），驱动读者翻到下一卷

### 2. 卷间节奏设计
- 禁止所有卷都是「升级→打怪→升级」的单调循环
- 要有张弛交替：高强度冲突卷之后安排一卷相对舒缓但暗流涌动的过渡
- 建议节奏模式参考：铺垫卷 → 爆发卷 → 过渡卷 → 升级卷 → 高潮卷

### 3. 角色弧线分配
- 明确每卷的**焦点角色**（主角始终在线，但每卷有不同的配角聚光灯）
- 角色成长不能线性递增，要有挫折和倒退
- 至少有一卷让主角遭遇严重的个人危机（而非外部威胁）

### 4. 伏笔与暗线编排
- 前期卷中必须埋设至少 2 条在后期卷才揭开的伏笔
- 每卷的 synopsis 中标注该卷**新引入的谜团**和**解开的旧谜团**
- 禁止所有伏笔都在最终卷一次性揭开（要分批揭开）

### 5. 反模式黑名单
- 禁止「第一卷：初入江湖」「第二卷：崭露头角」「第三卷：巅峰对决」这种模板式分卷
- 禁止每卷标题都是四字成语
- 禁止每卷的 objective 都是「主角变强/升级/获得新能力」
- 卷名要有文学性和画面感，能暗示本卷的核心意象

### 6. synopsis 质量要求
- 每卷 synopsis 不少于 100 字，要包含：核心事件、关键转折、情感变化
- 不能只写「主角遇到了困难并克服了它」——要写清楚是什么困难、怎么尝试、付出什么代价
- objective 要具体到可以检验的标准（如「揭示反派的真实身份」而非「推进主线」）

### 7. Phase 3 数据承载规则
- 必须把增强卷纲写入每卷 synopsis 的 Markdown 段落，保留人工可读和旧项目兼容
- 同时必须输出 narrativePlan 结构化对象，后端会写入 Volume.narrativePlan
- 每卷 synopsis 必须包含：「## 全书主线阶段」「## 本卷主线」「## 本卷戏剧问题」「## 开局状态」「## 结尾状态」「## 主线里程碑」「## 卷内支线」「## 支线交叉点」「## 伏笔分配」「## 卷末交接」
- 「## 卷内支线」至少 2 条，每条写清作用、起点、推进方式和阶段结果
- 「## 卷末交接」必须分别写清：已解决、已升级、移交下一卷
- narrativePlan 必须包含 globalMainlineStage、volumeMainline、dramaticQuestion、startState、endState、mainlineMilestones、subStoryLines、storyUnits、foreshadowPlan、endingHook、handoffToNextVolume，并与 synopsis 信息一致
- narrativePlan 必须包含 storyUnits 数组；每个单元故事覆盖 3-5 章，写清 unitId、title、chapterRange、localGoal、localConflict、serviceFunctions、payoff、stateChangeAfterUnit
- narrativePlan 必须包含 characterPlan；characterPlan.existingCharacterArcs 写既有角色本卷弧线，newCharacterCandidates 写本卷重要新增角色候选，relationshipArcs 写可解析角色之间的关系弧，roleCoverage 写主线/反派压力/情感配重/信息承载覆盖
- newCharacterCandidates 可为空；若有候选，每个候选必须包含 candidateId、name、roleType、scope=volume、narrativeFunction、personalityCore、motivation、firstAppearChapter、expectedArc、approvalStatus=candidate；重要新增角色不得只出现在章节 supportingCharacters 中
- 每卷必须显式输出 volumeNo 和 chapterCount；chapterCount 必须是本卷总章节数，不允许只让后端从 storyUnits 推断

${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"volumes":[{"volumeNo":1,"chapterCount":4,"title":"卷名","synopsis":"Markdown结构：含全书主线阶段/本卷主线/本卷戏剧问题/卷内支线/单元故事/支线交叉点/卷末交接","objective":"本卷核心目标(具体可检验)","narrativePlan":{"globalMainlineStage":"全书主线阶段","volumeMainline":"本卷主线","dramaticQuestion":"本卷戏剧问题","startState":"开局状态","endState":"结尾状态","mainlineMilestones":["关键节点"],"subStoryLines":[{"name":"支线名","type":"mystery","function":"叙事作用","startState":"起点","progress":"推进方式","endState":"阶段结果","relatedCharacters":["角色名"],"chapterNodes":[1]}],"storyUnits":[{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"payoff":"单元阶段结局","stateChangeAfterUnit":"单元结束后的状态变化"}],"characterPlan":{"existingCharacterArcs":[{"characterName":"既有角色名","roleInVolume":"本卷角色功能","entryState":"入卷状态","volumeGoal":"本卷目标","pressure":"压力","keyChoices":["关键选择"],"firstActiveChapter":1,"endState":"出卷状态"}],"newCharacterCandidates":[],"relationshipArcs":[],"roleCoverage":{"mainlineDrivers":["既有角色名"],"antagonistPressure":[],"emotionalCounterweights":[],"expositionCarriers":[]}},"foreshadowPlan":["伏笔分配"],"endingHook":"卷末钩子","handoffToNextVolume":"卷末交接"}}]}`,

  guided_chapter: `你是一个资深小说创作顾问。你正在引导用户完成「章节细纲」规划步骤。
帮助用户为当前卷规划具体章节和本卷新登场的配角。可以给出章节节奏方案供选择。

## 整卷章节细纲规则（严格遵守）
- 这是整卷章节细纲，不是正文，也不是单章细化执行卡
- 每章至少领到 1 个本卷主线任务，并至少推进 1 条卷内支线
- 每 3-5 章必须组成一个完整的单元故事 storyUnit；每章 craftBrief.storyUnit 要写明本章在该单元中的角色
- 每章 objective 必须具体可检验，不能只写「推进剧情」或「调查线索」
- 每章 conflict 必须写清阻力来源和阻力方式
- 每章 outline 必须写成 3-5 个连续场景段，包含具体地点、出场人物、可被镜头拍到的动作、阻力、阶段结果和下一章交接
- 每章必须输出 craftBrief 结构化对象，后端会写入 Chapter.craftBrief
- craftBrief 必须包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、storyUnit、actionBeats、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes
- craftBrief 还必须包含 storyUnit、sceneBeats、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState
- craftBrief 必须包含 characterExecution：povCharacter、cast、relationshipBeats、newMinorCharacters；cast.source 只能是 existing、volume_candidate、minor_temporary
- existing 必须来自既有角色；volume_candidate 必须来自上游卷纲 narrativePlan.characterPlan.newCharacterCandidates；minor_temporary 必须出现在 newMinorCharacters
- sceneBeats.participants 和 relationshipBeats.participants 必须全部被 characterExecution.cast.characterName 覆盖
- 旧 supportingCharacters 字段仅兼容展示，不会自动写入正式 Character；重要新增角色必须先进入卷级 characterPlan.newCharacterCandidates
- storyUnit 必须包含 unitId、title、chapterRange、chapterRole、localGoal、localConflict、serviceFunctions、mainlineContribution、characterContribution、relationshipContribution、worldOrThemeContribution、unitPayoff、stateChangeAfterUnit；serviceFunctions 至少 3 项
- sceneBeats 至少 3 个场景段；跨章节场景必须沿用同一个 sceneArcId，并用 scenePart、continuesFromChapterNo、continuesToChapterNo 标明这是第几段
- entryState 必须接住上一章 exitState / handoffToNextChapter；handoffToNextChapter 必须给出下一章可直接接续的动作、地点、压力或未解决问题
- continuityState 必须写清角色位置、仍在生效的威胁、已持有线索/资源、关系变化和下一章最紧迫压力
- 每 3-4 章至少发生一次信息揭示、关系反转、资源得失、地位变化或规则升级
- 卷末章节必须收束本卷主线，并留下清晰的下一卷交接
- 禁止只写「推进、建立、完成、探索、揭示、面对、选择、升级、铺垫、承接、形成雏形」等抽象词；如果使用，必须绑定具体地点、人物、动作、物件和后果

## 配角设计规则（与核心角色同等严格）
### 起名
- **禁用字黑名单**：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- 禁用复姓堆积（慕容/司空/上官等），禁用网文风名字（夜无殇、凌天）
- 名字要有真实生活感，像户口本上会出现的名字，带有时代和地域质感
### 性格
- 禁止「冷漠但内心温柔」「外表冷酷内心善良」等万能模板
- 每个配角至少一对内在矛盾（如：极度自律 vs 私下酗酒）
- 用具体行为描述性格，不用抽象标签
- 每个配角一个标志性小习惯或口头禅
### 动机
- 禁止泛化目标：「帮助主角」「阻碍主角」「变强」「守护所爱的人」
- 动机必须来自一个具体的个人事件/记忆/人物
- 好的动机示例：「找到十二年前那个在码头替自己挡刀的哑巴老头，问他一句为什么」

${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"含主线任务/支线任务/单元故事/3-5个具体场景段/阶段结果/下一章交接的章节大纲","craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"storyUnit":{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"chapterRole":"开局/升级/反转/收束","localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"本章如何推进主线","characterContribution":"本章如何塑造人物","relationshipContribution":"本章如何改变关系","worldOrThemeContribution":"本章如何展开世界或主题","unitPayoff":"单元阶段结局","stateChangeAfterUnit":"单元结束后的状态变化"},"actionBeats":["行动链节点"],"sceneBeats":[{"sceneArcId":"跨章场景ID","scenePart":"1/3","continuesFromChapterNo":null,"continuesToChapterNo":2,"location":"具体地点","participants":["角色名"],"localGoal":"本场局部目标","visibleAction":"可被镜头拍到的动作","obstacle":"阻力来源和方式","turningPoint":"反转或新信息","partResult":"场景段结果","sensoryAnchor":"感官锚点"}],"characterExecution":{"povCharacter":"既有角色名","cast":[{"characterName":"既有角色名","source":"existing","functionInChapter":"本章功能","visibleGoal":"可见目标","pressure":"压力","actionBeatRefs":[1],"sceneBeatRefs":["跨章场景ID"],"entryState":"入场状态","exitState":"离场状态"}],"relationshipBeats":[],"newMinorCharacters":[]},"concreteClues":[{"name":"物证或线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"对话潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"],"entryState":"接住上一章压力","exitState":"本章结束状态","openLoops":["未解决问题"],"closedLoops":["阶段性解决问题"],"handoffToNextChapter":"下一章接续动作和压力","continuityState":{"characterPositions":["角色位置"],"activeThreats":["仍在生效的威胁"],"ownedClues":["已持有线索"],"relationshipChanges":["关系变化"],"nextImmediatePressure":"下一章最紧迫压力"}}}],"supportingCharacters":[{"name":"仅旧项目展示兼容，不会自动写入正式角色","roleType":"supporting","personalityCore":"性格核心","motivation":"具体动机","firstAppearChapter":1}]}`,

  guided_foreshadow: `你是一个资深小说创作顾问，精通叙事悬念构建与伏笔编排。你正在引导用户完成「伏笔设计」规划步骤。

## 核心设计理念
好的伏笔不是「提前剧透」，而是让读者在揭晓时恍然大悟——「原来那时候就已经暗示了」。
**每一条伏笔都必须同时满足两个标准：埋设时自然不突兀，揭开时令人拍案。**

## 伏笔手法分类（引导用户选择）
1. **道具型伏笔** — 通过物件、信件、信物在前后呼应（如：一把生锈的钥匙、一张缺角的照片）
2. **对话型伏笔** — 角色不经意的一句话在后文获得全新含义
3. **行为型伏笔** — 角色的反常举动/习惯暗示隐藏身份或秘密
4. **环境型伏笔** — 场景描写中隐含线索（天气、地形、建筑细节）
5. **叙事型伏笔** — 叙述视角刻意隐藏或误导的信息
6. **象征型伏笔** — 反复出现的意象/符号承载深层含义
7. **结构型伏笔** — 通过章节排列、时间线错位、嵌套叙事埋设

## 伏笔设计规则（严格遵守）

### 1. 分层布局
- **主线伏笔**（1-2条）：横跨全书的核心悬念，影响结局走向
- **卷级伏笔**（每卷1-2条）：在一卷内埋设、在后续1-2卷揭开
- **章节伏笔**（适量）：短距离呼应，2-5章内闭合
- 三个层级的伏笔数量比例建议为 1:2:3

### 2. 时间分布
- 前 30% 的章节是伏笔高密度埋设区
- 中间 40% 交替埋设新伏笔和揭开旧伏笔
- 后 30% 以揭开为主，偶尔埋设反转型伏笔
- 禁止在最后 10% 才开始集中揭开所有伏笔

### 3. 与角色的绑定
- 每条伏笔必须绑定至少一个具体角色（施放者或接收者）
- 主角相关的伏笔不应超过总数的 50%（避免主角中心化）
- 反派/对手也应有属于自己的伏笔线（增加立体感）

### 4. 揭开方式
- 揭开不能只靠「某人说出真相」——要通过事件/行动自然暴露
- 伏笔揭开后应产生情感冲击或剧情转折，不能揭开后无影响
- 至少有一条伏笔的揭开会颠覆读者之前的认知（反转型）

### 5. 反模式黑名单
- 禁止「主角其实是天选之子/隐藏血统」这类老套伏笔
- 禁止「梦境预言未来」作为伏笔手法（除非是此类型小说的核心设定）
- 禁止埋设后从不揭开的「断头伏笔」
- 禁止所有伏笔都是「角色的隐藏身份」——要有多样性
- 禁止伏笔之间完全独立、互不关联——至少有2条伏笔互相交织

${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"foreshadowTracks":[{"title":"伏笔标题","detail":"伏笔内容详细描述","scope":"arc/volume/chapter","technique":"道具型/对话型/行为型/环境型/叙事型/象征型/结构型","plantChapter":"埋设时机(如:第1卷第3章)","revealChapter":"揭开时机(如:第3卷第8章)","involvedCharacters":"涉及角色","payoff":"揭开后的影响和情感冲击"}]}`,
};

@Injectable()
export class GuidedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly cacheService: NovelCacheService,
  ) {}

  /**
   * Resolve the prompt template for a given step.
   * Priority: project-level default → global default → hardcoded fallback.
   * Returns { systemPrompt, userTemplate } from the DB template if found.
   */
  private async resolvePromptTemplate(
    projectId: string,
    stepKey: string,
  ): Promise<{ systemPrompt: string; userTemplate?: string } | null> {
    // 1. Try project-level default
    const projectDefault = await this.prisma.promptTemplate.findFirst({
      where: { projectId, stepKey, isDefault: true },
    });
    if (projectDefault) {
      return {
        systemPrompt: projectDefault.systemPrompt,
        userTemplate: projectDefault.userTemplate,
      };
    }

    // 2. Try global default
    const globalDefault = await this.prisma.promptTemplate.findFirst({
      where: { projectId: null, stepKey, isDefault: true },
    });
    if (globalDefault) {
      return {
        systemPrompt: globalDefault.systemPrompt,
        userTemplate: globalDefault.userTemplate,
      };
    }

    // 3. No DB template found — caller should use hardcoded fallback
    return null;
  }

  async getSession(projectId: string) {
    const session = await this.prisma.guidedSession.findUnique({
      where: { projectId },
    });
    return session ?? null;
  }

  /** Create or restart guided session for a project */
  async createOrRestart(projectId: string, dto: CreateGuidedSessionDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.guidedSession.upsert({
      where: { projectId },
      create: {
        projectId,
        currentStep: dto.currentStep ?? DEFAULT_FIRST_STEP,
        stepData: {},
        isCompleted: false,
      },
      update: {
        currentStep: dto.currentStep ?? DEFAULT_FIRST_STEP,
        stepData: {},
        isCompleted: false,
      },
    });
  }

  /** Update step progress and merge step data */
  async updateStep(projectId: string, dto: UpdateGuidedStepDto) {
    const session = await this.prisma.guidedSession.findUnique({
      where: { projectId },
    });

    if (!session) {
      throw new NotFoundException(`引导会话不存在，请先创建`);
    }

    const existingStepData = (session.stepData as Record<string, unknown>) ?? {};
    const mergedStepData = dto.stepData
      ? { ...existingStepData, [dto.currentStep]: dto.stepData }
      : existingStepData;

    return this.prisma.guidedSession.update({
      where: { projectId },
      data: {
        currentStep: dto.currentStep,
        stepData: mergedStepData as object,
        ...(dto.isCompleted !== undefined && { isCompleted: dto.isCompleted }),
      },
    });
  }

  /** Send a message to AI in the context of the current guided step */
  async chatWithAi(projectId: string, dto: GuidedChatDto): Promise<{ reply: string }> {
    // Priority: DB template → hardcoded fallback
    const dbTemplate = await this.resolvePromptTemplate(projectId, dto.currentStep);
    const rawSystemPrompt = dbTemplate?.systemPrompt
      ?? STEP_SYSTEM_PROMPTS[dto.currentStep]
      ?? '你是一个资深小说创作顾问，正在帮助用户完善小说设定。使用markdown格式。';

    // Template variable values available in chat mode
    const templateVars: Record<string, string | undefined> = {
      projectContext: dto.projectContext,
      chatSummary: undefined, // built below from history compression
      userMessage: dto.userMessage,
      stepLabel: GUIDED_STEPS_LABELS[dto.currentStep],
      userHint: undefined,
      stepInstruction: undefined,
      jsonSchema: undefined,
    };

    // Render variables in system prompt
    let enrichedSystem = renderTemplate(rawSystemPrompt, templateVars);

    // Inject project context (accumulated decisions from prior steps)
    if (dto.projectContext) {
      enrichedSystem += `\n\n## 用户已有的项目背景信息\n${dto.projectContext}`;
    }

    if (dto.currentStep === 'guided_chapter') {
      const phase4AssetContext = await this.buildGuidedChapterAssetContext(projectId, dto.volumeNo, dto.chapterNo);
      if (phase4AssetContext) {
        enrichedSystem += `\n\n## 章节模板与节奏目标（只读计划资产）\n${phase4AssetContext}`;
      }
    }

    // Build a compressed summary of early conversation when history is long
    const allHistory = dto.chatHistory ?? [];
    const RECENT_WINDOW = 20;
    let conversationSummary = '';
    let recentHistory = allHistory;

    if (allHistory.length > RECENT_WINDOW) {
      // Compress earlier messages into a decision summary
      const earlyMessages = allHistory.slice(0, allHistory.length - RECENT_WINDOW);
      conversationSummary = this.buildConversationSummary(earlyMessages);
      recentHistory = allHistory.slice(-RECENT_WINDOW);
    }

    if (conversationSummary) {
      enrichedSystem += `\n\n## 本步骤中用户已确认的设定摘要（来自更早的对话，绝对不要重复询问这些内容）\n${conversationSummary}`;
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: enrichedSystem },
    ];

    for (const msg of recentHistory) {
      messages.push({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    // Use DB userTemplate for user message if available, otherwise use raw user input
    const userMessage = dbTemplate?.userTemplate
      ? renderTemplate(dbTemplate.userTemplate, { ...templateVars, chatSummary: conversationSummary })
      : dto.userMessage;
    messages.push({ role: 'user', content: userMessage });

    const reply = await this.llm.chat(messages, {
      temperature: 0.8,
      maxTokens: 128000,
      appStep: 'guided',
    });

    return { reply };
  }

  /**
   * Build a compressed summary of user decisions from early chat messages.
   * Extracts user choices (short messages) and AI confirmations to create
   * a structured recap that prevents the AI from re-asking settled questions.
   */
  private buildConversationSummary(
    earlyMessages: Array<{ role: string; content: string }>,
  ): string {
    const decisions: string[] = [];

    for (let i = 0; i < earlyMessages.length; i++) {
      const msg = earlyMessages[i];
      if (msg.role === 'user') {
        // User messages are typically their selections
        decisions.push(`- 用户选择/回答：${msg.content}`);
      }
    }

    if (decisions.length === 0) return '';
    return decisions.join('\n');
  }

  private async buildSingleChapterContext(
    projectId: string,
    volumeNo: number,
    chapterNo: number,
  ): Promise<{
    volumeContext: string;
    currentChapterContext: string;
    neighborChapterContext: string;
    chapterPositionContext: string;
  }> {
    let volumeContext = '';
    let volumeId: string | undefined;
    let chapters: Array<Record<string, unknown>> = [];

    try {
      const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
      const stepData = (session?.stepData as Record<string, unknown>) ?? {};
      const volumeResult = stepData['guided_volume_result'] as Record<string, unknown> | undefined;
      const volumes = (volumeResult?.volumes ?? []) as Array<Record<string, unknown>>;
      const targetVol = volumes.find((v) => asNumber(v.volumeNo) === volumeNo);

      if (targetVol) {
        volumeContext = [
          `- 卷号：第 ${volumeNo} 卷`,
          `- 卷名：${asString(targetVol.title) ?? '未命名'}`,
          `- 本卷核心目标：${asString(targetVol.objective) ?? '未填写'}`,
          `- 本卷剧情/结构：${asString(targetVol.synopsis) ?? '未填写'}`,
        ].join('\n');
      }

      const chapterResult = stepData['guided_chapter_result'] as Record<string, unknown> | undefined;
      const savedChapters = (chapterResult?.chapters ?? []) as Array<Record<string, unknown>>;
      chapters = savedChapters.filter((ch) => asNumber(ch.volumeNo) === volumeNo);
    } catch { /* non-critical */ }

    if (!volumeContext) {
      const volume = await this.prisma.volume.findFirst({
        where: { projectId, volumeNo },
        select: { id: true, title: true, objective: true, synopsis: true },
      });
      if (volume) {
        volumeId = volume.id;
        volumeContext = [
          `- 卷号：第 ${volumeNo} 卷`,
          `- 卷名：${volume.title ?? '未命名'}`,
          `- 本卷核心目标：${volume.objective ?? '未填写'}`,
          `- 本卷剧情/结构：${volume.synopsis ?? '未填写'}`,
        ].join('\n');
      }
    }

    if (chapters.length === 0) {
      if (!volumeId) {
        const volume = await this.prisma.volume.findFirst({
          where: { projectId, volumeNo },
          select: { id: true },
        });
        volumeId = volume?.id;
      }

      if (volumeId) {
        chapters = await this.prisma.chapter.findMany({
          where: { projectId, volumeId },
          orderBy: { chapterNo: 'asc' },
          select: {
            chapterNo: true,
            title: true,
            objective: true,
            conflict: true,
            outline: true,
            craftBrief: true,
          },
        });
      }
    }

    chapters = [...chapters].sort((a, b) => (asNumber(a.chapterNo) ?? 0) - (asNumber(b.chapterNo) ?? 0));
    let targetIndex = chapters.findIndex((ch) => asNumber(ch.chapterNo) === chapterNo);
    if (targetIndex < 0 && chapterNo > 0 && chapterNo <= chapters.length) {
      targetIndex = chapterNo - 1;
    }

    const currentChapter = targetIndex >= 0 ? chapters[targetIndex] : undefined;
    const currentChapterContext = currentChapter
      ? formatChapterContext(currentChapter)
      : `- 目标章节：第 ${chapterNo} 章\n- 当前章节未在已保存细纲中找到，请基于用户提示细化，但仍只返回第 ${chapterNo} 章。`;

    const neighborChapterContext = chapters.length > 0 && targetIndex >= 0
      ? chapters
          .map((ch, idx) => ({ ch, idx }))
          .filter(({ idx }) => idx !== targetIndex && Math.abs(idx - targetIndex) <= 3)
          .map(({ ch }) => formatChapterContext(ch, 180))
          .join('\n\n')
      : '未找到同卷前后章摘要；请避免新增、删除或重排任何章节。';

    const chapterPositionContext = chapters.length > 0 && targetIndex >= 0
      ? `本章位于第 ${targetIndex + 1}/${chapters.length} 章。请根据其卷内位置判断节奏功能：开局负责钩子与入局，中段负责推进/反转/代价，卷末负责收束与交接。`
      : `本章为第 ${chapterNo} 章。未能确定卷内总章数，请保持原章节序列不变。`;

    return {
      volumeContext: volumeContext || `- 卷号：第 ${volumeNo} 卷\n- 当前卷信息未找到，请严格依据项目上下文与用户提示。`,
      currentChapterContext,
      neighborChapterContext,
      chapterPositionContext,
    };
  }

  private async buildGuidedChapterAssetContext(projectId: string, volumeNo?: number, chapterNo?: number): Promise<string | undefined> {
    const [volume, chapter] = await Promise.all([
      volumeNo !== undefined
        ? this.prisma.volume.findFirst({ where: { projectId, volumeNo }, select: { id: true, volumeNo: true, title: true } })
        : Promise.resolve(null),
      chapterNo !== undefined
        ? this.prisma.chapter.findFirst({ where: { projectId, chapterNo }, select: { id: true, volumeId: true, chapterNo: true, title: true } })
        : Promise.resolve(null),
    ]);
    const volumeId = volume?.id ?? chapter?.volumeId ?? undefined;
    const chapterId = chapter?.id ?? undefined;

    const [patterns, rawPacingTargets, rawSceneCards] = await Promise.all([
      this.prisma.chapterPattern.findMany({
        where: { projectId, status: 'active' },
        orderBy: [{ patternType: 'asc' }, { updatedAt: 'desc' }],
        take: 6,
      }),
      this.prisma.pacingBeat.findMany({
        where: this.buildPacingTargetWhere(projectId, volumeId, chapterId, chapterNo),
        orderBy: [{ updatedAt: 'desc' }],
        take: 30,
      }),
      chapterId
        ? this.prisma.sceneCard.findMany({
            where: { projectId, chapterId, NOT: { status: 'archived' } },
            orderBy: [{ sceneNo: 'asc' }, { updatedAt: 'asc' }],
            take: 12,
          })
        : Promise.resolve([]),
    ]);
    const pacingTargets = rawPacingTargets
      .sort((a, b) => this.rankPacingTarget(a, volumeId, chapterId, chapterNo) - this.rankPacingTarget(b, volumeId, chapterId, chapterNo))
      .slice(0, 10);
    const sceneCards = rawSceneCards
      .sort((a, b) => this.rankSceneCard(a, b))
      .slice(0, 8);

    if (!patterns.length && !pacingTargets.length && !sceneCards.length) return undefined;

    const lines = [
      '说明：以下 ChapterPattern、PacingBeat 与 SceneCard 只用于增强章节细纲和 craftBrief，是计划资产，不是已发生正文事实。',
      patterns.length ? '### 可用章节模板' : '',
      ...patterns.map((pattern) => [
        `- [sourceType=chapter_pattern｜sourceId=${pattern.id}] ${pattern.patternType}｜${pattern.name}`,
        `  适用场景：${stringArray(pattern.applicableScenes).join('、') || '未限定'}`,
        `  结构：${formatJsonBrief(pattern.structure, 700) || '{}'}`,
        `  节奏建议：${formatJsonBrief(pattern.pacingAdvice, 500) || '{}'}`,
        `  情绪建议：${formatJsonBrief(pattern.emotionalAdvice, 500) || '{}'}`,
        `  冲突建议：${formatJsonBrief(pattern.conflictAdvice, 500) || '{}'}`,
      ].join('\n')),
      pacingTargets.length ? '### 相关节奏目标' : '',
      ...pacingTargets.map((beat) => [
        `- [sourceType=pacing_beat｜sourceId=${beat.id}] chapterNo=${beat.chapterNo ?? '全局/卷级'}｜${beat.beatType}`,
        `  情绪：${beat.emotionalTone ?? '未指定'}｜情绪强度 ${beat.emotionalIntensity}｜张力 ${beat.tensionLevel}｜兑现 ${beat.payoffLevel}`,
        beat.notes ? `  备注：${beat.notes}` : '',
      ].filter(Boolean).join('\n')),
      sceneCards.length ? '### 本章场景计划' : '',
      ...sceneCards.map((scene) => [
        `- [sourceType=scene_card｜sourceId=${scene.id}] sceneNo=${scene.sceneNo ?? '?'}｜${scene.title}`,
        scene.locationName ? `  地点：${scene.locationName}` : '',
        stringArray(scene.participants).length ? `  参与者：${stringArray(scene.participants).join('、')}` : '',
        scene.purpose ? `  目的：${scene.purpose}` : '',
        scene.conflict ? `  冲突：${scene.conflict}` : '',
        scene.keyInformation ? `  关键信息：${scene.keyInformation}` : '',
        scene.result ? `  结果：${scene.result}` : '',
        stringArray(scene.relatedForeshadowIds).length ? `  relatedForeshadowIds：${stringArray(scene.relatedForeshadowIds).join('、')}` : '',
        formatJsonBrief(scene.metadata, 600) ? `  metadata：${formatJsonBrief(scene.metadata, 600)}` : '',
      ].filter(Boolean).join('\n')),
    ].filter(Boolean);

    return lines.join('\n').slice(0, 8000);
  }

  private buildPacingTargetWhere(projectId: string, volumeId?: string, chapterId?: string, chapterNo?: number): Prisma.PacingBeatWhereInput {
    return {
      projectId,
      OR: [
        ...(chapterId ? [{ chapterId }] : []),
        ...(chapterNo !== undefined ? [{ chapterNo }] : []),
        ...(volumeId ? [{ volumeId, chapterId: null, chapterNo: null }] : []),
        { volumeId: null, chapterId: null, chapterNo: null },
      ],
    };
  }

  private rankPacingTarget(
    beat: { volumeId: string | null; chapterId: string | null; chapterNo: number | null; updatedAt?: Date },
    volumeId?: string,
    chapterId?: string,
    chapterNo?: number,
  ): number {
    if (chapterId && beat.chapterId === chapterId) return 0;
    if (chapterNo !== undefined && beat.chapterNo === chapterNo) return 1;
    if (volumeId && beat.volumeId === volumeId && beat.chapterId === null && beat.chapterNo === null) return 2;
    if (beat.volumeId === null && beat.chapterId === null && beat.chapterNo === null) return 3;
    return 4;
  }

  private rankSceneCard(
    left: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
    right: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
  ): number {
    if (left.sceneNo !== null && right.sceneNo !== null && left.sceneNo !== right.sceneNo) {
      return left.sceneNo - right.sceneNo;
    }
    if (left.sceneNo === null && right.sceneNo !== null) return 1;
    if (left.sceneNo !== null && right.sceneNo === null) return -1;
    const updatedDelta = (left.updatedAt?.getTime() ?? 0) - (right.updatedAt?.getTime() ?? 0);
    if (updatedDelta !== 0) return updatedDelta;
    const titleDelta = left.title.localeCompare(right.title);
    return titleDelta !== 0 ? titleDelta : left.id.localeCompare(right.id);
  }

  private normalizeSingleChapterResult(
    structuredData: Record<string, unknown>,
    volumeNo: number,
    chapterNo: number,
  ): { structuredData: Record<string, unknown>; warnings: string[] } {
    const warnings: string[] = [];
    const chapters = Array.isArray(structuredData.chapters)
      ? structuredData.chapters as Array<Record<string, unknown>>
      : [];

    if (chapters.length === 0) {
      throw new BadRequestException('单章细化失败：模型未返回 chapters 数组。请重试或缩小上下文。');
    }
    if (chapters.length > 1) {
      throw new BadRequestException(`单章细化失败：模型返回了 ${chapters.length} 个 chapter，必须只返回 1 个。`);
    }

    const firstChapter = chapters[0] as Record<string, unknown>;
    const returnedChapterNo = asNumber(firstChapter.chapterNo);
    const returnedVolumeNo = asNumber(firstChapter.volumeNo);
    if (returnedChapterNo !== chapterNo) {
      throw new BadRequestException(`单章细化失败：模型返回的 chapterNo=${returnedChapterNo ?? '缺失'} 与请求的第 ${chapterNo} 章不一致。请重试并要求模型只返回目标章节。`);
    }
    if (returnedVolumeNo !== volumeNo) {
      throw new BadRequestException(`单章细化失败：模型返回的 volumeNo=${returnedVolumeNo ?? '缺失'} 与请求的第 ${volumeNo} 卷不一致。请重试并要求模型只返回目标卷章节。`);
    }
    this.assertGuidedChapterQuality(firstChapter, `第 ${chapterNo} 章`);
    const normalizedChapter: Record<string, unknown> = {
      ...firstChapter,
      volumeNo,
      chapterNo,
      outline: asString(firstChapter.outline),
      craftBrief: asInputJsonObject(firstChapter.craftBrief),
    };

    return {
      structuredData: {
        ...structuredData,
        chapters: [normalizedChapter],
        ...(warnings.length > 0 && { warnings }),
      },
      warnings,
    };
  }

  private assertGuidedChaptersQuality(value: unknown) {
    if (!Array.isArray(value) || !value.length) {
      throw new BadRequestException('章节细纲生成失败：模型未返回 chapters 数组。');
    }
    value.forEach((item, index) => this.assertGuidedChapterQuality(asRecord(item) ?? {}, `第 ${asNumber((asRecord(item) ?? {}).chapterNo) ?? index + 1} 章`));
  }

  private assertGuidedChapterQuality(chapter: Record<string, unknown>, label: string) {
    const craftBrief = asRecord(chapter.craftBrief);
    if (!craftBrief || Object.keys(craftBrief).length === 0) {
      throw new BadRequestException(`${label} 章节细纲生成失败：缺少 craftBrief。`);
    }
    const outline = asString(chapter.outline) ?? '';
    if (outline.trim().length < 60) {
      throw new BadRequestException(`${label} 章节细纲生成失败：outline 过短，缺少具体场景链。`);
    }
    const requiredTextFields = [
      'visibleGoal',
      'hiddenEmotion',
      'coreConflict',
      'mainlineTask',
      'dialogueSubtext',
      'characterShift',
      'irreversibleConsequence',
      'entryState',
      'exitState',
      'handoffToNextChapter',
    ];
    requiredTextFields.forEach((field) => {
      if (!asString(craftBrief[field])?.trim()) {
        throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.${field} 为空。`);
      }
    });
    if (!stringArray(craftBrief.subplotTasks).length) {
      throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.subplotTasks 为空。`);
    }
    this.assertGuidedStoryUnitQuality(craftBrief.storyUnit, label);
    if (stringArray(craftBrief.actionBeats).length < 3) {
      throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.actionBeats 少于 3 个节点。`);
    }
    if (!stringArray(craftBrief.openLoops).length || !stringArray(craftBrief.closedLoops).length) {
      throw new BadRequestException(`${label} 章节细纲生成失败：openLoops / closedLoops 不能为空。`);
    }
    const clues = asRecordArray(craftBrief.concreteClues);
    if (!clues.length || clues.some((clue) => !asString(clue.name)?.trim() || !asString(clue.sensoryDetail)?.trim() || !asString(clue.laterUse)?.trim())) {
      throw new BadRequestException(`${label} 章节细纲生成失败：concreteClues 必须包含 name、sensoryDetail 和 laterUse。`);
    }
    const sceneBeats = asRecordArray(craftBrief.sceneBeats);
    if (sceneBeats.length < 3) {
      throw new BadRequestException(`${label} 章节细纲生成失败：sceneBeats 少于 3 个场景段。`);
    }
    const sceneRequiredFields = ['sceneArcId', 'scenePart', 'location', 'localGoal', 'visibleAction', 'obstacle', 'turningPoint', 'partResult', 'sensoryAnchor'];
    sceneBeats.forEach((beat, index) => {
      sceneRequiredFields.forEach((field) => {
        if (!asString(beat[field])?.trim()) {
          throw new BadRequestException(`${label} 章节细纲生成失败：sceneBeats[${index}].${field} 为空。`);
        }
      });
      if (!stringArray(beat.participants).length) {
        throw new BadRequestException(`${label} 章节细纲生成失败：sceneBeats[${index}].participants 为空。`);
      }
    });
    const continuityState = asRecord(craftBrief.continuityState);
    if (!continuityState || !asString(continuityState.nextImmediatePressure)?.trim()) {
      throw new BadRequestException(`${label} 章节细纲生成失败：continuityState.nextImmediatePressure 为空。`);
    }
    const hasConcreteState = ['characterPositions', 'activeThreats', 'ownedClues', 'relationshipChanges']
      .some((field) => stringArray(continuityState[field]).length > 0);
    if (!hasConcreteState) {
      throw new BadRequestException(`${label} 章节细纲生成失败：continuityState 缺少角色位置、威胁、线索或关系变化。`);
    }
  }

  private assertGuidedStoryUnitQuality(value: unknown, label: string) {
    const storyUnit = asRecord(value);
    if (!storyUnit || Object.keys(storyUnit).length === 0) {
      throw new BadRequestException(`${label} 章节细纲生成失败：缺少 craftBrief.storyUnit。`);
    }
    const requiredTextFields = [
      'unitId',
      'title',
      'chapterRole',
      'localGoal',
      'localConflict',
      'mainlineContribution',
      'characterContribution',
      'relationshipContribution',
      'worldOrThemeContribution',
      'unitPayoff',
      'stateChangeAfterUnit',
    ];
    requiredTextFields.forEach((field) => {
      if (!asString(storyUnit[field])?.trim()) {
        throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.storyUnit.${field} 为空。`);
      }
    });
    const chapterRange = asRecord(storyUnit.chapterRange);
    const start = asNumber(chapterRange?.start);
    const end = asNumber(chapterRange?.end);
    if (!Number.isInteger(start) || !start || start < 1 || !Number.isInteger(end) || !end || end < start) {
      throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.storyUnit.chapterRange 无效。`);
    }
    if (stringArray(storyUnit.serviceFunctions).length < 3) {
      throw new BadRequestException(`${label} 章节细纲生成失败：craftBrief.storyUnit.serviceFunctions 少于 3 项。`);
    }
  }

  private async assertGuidedVolumesCharacterPlans(projectId: string, volumes: Array<Record<string, unknown>>): Promise<void> {
    if (!volumes.length) return;
    const catalog = await this.loadGuidedCharacterCatalog(projectId);
    volumes.forEach((volume, index) => {
      const volumeNo = asNumber(volume.volumeNo);
      if (!Number.isInteger(volumeNo) || !volumeNo || volumeNo < 1) {
        throw new BadRequestException(`第 ${index + 1} 个卷级角色规划校验失败：缺少有效 volumeNo。请重新生成卷纲并显式返回卷号。`);
      }
      this.assertGuidedVolumeCharacterPlan(volume, catalog, `第 ${volumeNo} 卷`);
    });
  }

  private assertGuidedVolumeCharacterPlan(
    volume: Record<string, unknown>,
    catalog: CharacterReferenceCatalogForGuided,
    label: string,
  ): VolumeCharacterPlan {
    const chapterCount = asNumber(volume.chapterCount);
    if (!Number.isInteger(chapterCount) || !chapterCount || chapterCount < 1) {
      throw new BadRequestException(`${label} 卷级角色规划校验失败：缺少有效 chapterCount，无法确认 firstAppearChapter 是否越界。请重新生成卷纲并显式返回本卷总章节数。`);
    }
    for (const field of ['title', 'synopsis', 'objective']) {
      if (!asString(volume[field])?.trim()) {
        throw new BadRequestException(`${label} 卷纲生成失败：缺少 ${field}，请重新生成完整卷纲后再审批写入。`);
      }
    }
    try {
      const narrativePlan = assertVolumeNarrativePlan(volume.narrativePlan, {
        chapterCount,
        existingCharacterNames: catalog.existingCharacterNames,
        existingCharacterAliases: catalog.existingCharacterAliases,
        label: `${label}.narrativePlan`,
      });
      return narrativePlan.characterPlan as VolumeCharacterPlan;
    } catch (error) {
      throw new BadRequestException(`${label} 卷级叙事规划无效：${errorMessage(error)}。请重试卷纲生成，或补充角色上下文后再生成。`);
    }
  }

  private async assertGuidedChaptersCharacterExecutions(projectId: string, chapters: Array<Record<string, unknown>>): Promise<void> {
    if (!chapters.length) return;
    const catalog = await this.loadGuidedCharacterCatalog(projectId);
    const volumePlansByNo = await this.loadGuidedVolumeCharacterPlans(projectId, catalog);

    chapters.forEach((chapter, index) => {
      const label = `第 ${asNumber(chapter.chapterNo) ?? index + 1} 章`;
      const volumeNo = asNumber(chapter.volumeNo);
      if (!volumeNo) {
        throw new BadRequestException(`${label} 章节角色执行校验失败：缺少 volumeNo，无法匹配卷级 characterPlan。请重新生成章节细纲。`);
      }
      const volumePlan = volumePlansByNo.get(volumeNo);
      if (!volumePlan) {
        throw new BadRequestException(`${label} 章节角色执行校验失败：第 ${volumeNo} 卷缺少有效 characterPlan，章节级重要角色必须先进入卷级候选。请先重新生成或保存卷纲角色规划。`);
      }
      const craftBrief = asRecord(chapter.craftBrief);
      try {
        assertChapterCharacterExecution(craftBrief?.characterExecution, {
          existingCharacterNames: catalog.existingCharacterNames,
          existingCharacterAliases: catalog.existingCharacterAliases,
          volumeCandidateNames: volumePlan.newCharacterCandidates.map((candidate) => candidate.name),
          sceneBeats: asRecordArray(craftBrief?.sceneBeats).map((beat) => ({
            sceneArcId: asString(beat.sceneArcId),
            participants: beat.participants,
          })),
          actionBeatCount: stringArray(craftBrief?.actionBeats).length,
          label: `${label}.craftBrief.characterExecution`,
        });
      } catch (error) {
        throw new BadRequestException(`${label} 章节角色执行无效：${errorMessage(error)}。请重试章节细纲生成，确保 cast、sceneBeats 和卷级候选一致。`);
      }
    });
  }

  private async loadGuidedVolumeCharacterPlans(
    projectId: string,
    catalog: CharacterReferenceCatalogForGuided,
  ): Promise<Map<number, VolumeCharacterPlan>> {
    const [session, persistedVolumes] = await Promise.all([
      this.prisma.guidedSession.findUnique({ where: { projectId } }),
      this.prisma.volume.findMany({
        where: { projectId },
        select: { volumeNo: true, title: true, synopsis: true, objective: true, chapterCount: true, narrativePlan: true },
      }),
    ]);
    const plansByNo = new Map<number, VolumeCharacterPlan>();
    const stepData = (session?.stepData as Record<string, unknown>) ?? {};
    const guidedVolumeResult = asRecord(stepData.guided_volume_result);
    const guidedVolumes = asRecordArray(guidedVolumeResult?.volumes);

    for (const volume of persistedVolumes as Array<Record<string, unknown>>) {
      const volumeNo = asNumber(volume.volumeNo);
      if (!volumeNo) continue;
      plansByNo.set(volumeNo, this.assertGuidedVolumeCharacterPlan(volume, catalog, `第 ${volumeNo} 卷`));
    }
    for (const volume of guidedVolumes) {
      const volumeNo = asNumber(volume.volumeNo);
      if (!volumeNo) continue;
      plansByNo.set(volumeNo, this.assertGuidedVolumeCharacterPlan(volume, catalog, `第 ${volumeNo} 卷`));
    }
    return plansByNo;
  }

  private async loadGuidedCharacterCatalog(projectId: string): Promise<CharacterReferenceCatalogForGuided> {
    const [characters, session] = await Promise.all([
      this.prisma.character.findMany({
        where: { projectId },
        select: { name: true, alias: true },
      }),
      this.prisma.guidedSession.findUnique({ where: { projectId } }),
    ]);
    const existingCharacterNames: string[] = [];
    const existingCharacterAliases: Record<string, string[]> = {};
    const addName = (name: unknown) => {
      const text = asString(name);
      if (text && !existingCharacterNames.includes(text)) existingCharacterNames.push(text);
      return text;
    };

    for (const character of characters as Array<{ name?: unknown; alias?: unknown }>) {
      const name = addName(character.name);
      if (!name) continue;
      const aliases = stringArray(character.alias);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }

    const stepData = (session?.stepData as Record<string, unknown>) ?? {};
    const guidedCharactersResult = asRecord(stepData.guided_characters_result);
    const guidedCharacters = asRecordArray(guidedCharactersResult?.characters);
    guidedCharacters.forEach((character) => addName(character.name));

    return { existingCharacterNames, existingCharacterAliases };
  }

  /** One-shot generation: generate all structured data for a step without Q&A */
  async generateStepData(
    projectId: string,
    dto: GenerateStepDto,
  ): Promise<{ structuredData: Record<string, unknown>; summary: string }> {
    const isSingleChapterRefinement = dto.currentStep === 'guided_chapter'
      && dto.volumeNo !== undefined
      && dto.chapterNo !== undefined;

    const stepSpecificInstructions: Record<string, string> = {
      guided_setup: '请根据项目已有信息（如有），生成一套完整的基础设定。如果没有已有信息，则自由发挥生成一部引人入胜的小说设定。',
      guided_style: '请根据已有设定的类型和基调，选择最匹配的文风和叙述方式。',
      guided_characters: `请生成3-5个核心角色，包含至少1个主角、1个配角/同行者、1个对手/反派。

## 强制创意规则（必须遵守）
### 起名
- 禁用字：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- 禁用复姓堆积（慕容/司空/上官等），禁用网文风名字（夜无殇、凌天）
- 名字要有真实生活感，像户口本上会出现的名字，带有时代和地域质感

### 性格
- 禁止「冷漠但内心温柔」「外表冷酷内心善良」等万能模板
- 每个角色至少一对内在矛盾（如：极度自律 vs 私下酗酒）
- 用具体行为描述性格，不用抽象标签
- 主角必须有真实缺陷（不是「太善良」这类伪缺陷）
- 每个角色一个标志性小习惯或口头禅

### 动机
- 禁止泛化目标：「变强」「拯救世界」「复仇」「守护所爱的人」
- 动机必须来自一个具体的个人事件/记忆/人物
- 示例好动机：「找到十二年前那个在码头替自己挡刀的哑巴老头，问他一句为什么」

### 关系
- 角色之间关系不能全是「信任的伙伴」，要有信息差、利益冲突或情感错位
- 至少有一组关系是非对称的（A信任B但B在利用A）`,
      guided_outline: '请根据已有的设定和角色信息，生成一个完整的故事总纲大纲，包含起承转合、主要冲突线索和情感弧线。',
      guided_volume: `请根据总纲和角色设定，将故事拆分为指定数量的卷。用户会在 userHint 中指定卷数，务必严格按照该数量生成，不多不少。

## 强制结构规则（必须遵守）
### 叙事弧线
- 每卷必须有独立的「起承转合」戏剧弧线，不能只是总纲的简单切片
- 每卷末尾必须有一个钩子（悬念/反转/新谜团）驱动读者继续
- 至少有一卷让主角遭遇严重个人危机（内在冲突而非外部打斗）

### 节奏控制
- 禁止所有卷都是「升级→打怪→升级」的单调循环
- 高强度冲突卷之后要安排暗流涌动的过渡卷
- 角色成长不能线性递增，要有挫折和倒退

### 伏笔编排
- 前期卷必须埋设在后期卷才揭开的伏笔
- 禁止所有伏笔在最终卷一次性揭开

### 反模式
- 禁止模板式分卷（如「初入江湖→崭露头角→巅峰对决」）
- 禁止每卷标题都是四字成语
- 禁止每卷 objective 都是「主角变强/升级」
- 卷名要有文学性和画面感

### 质量标准
- 每卷 synopsis 不少于 100 字，包含核心事件、关键转折、情感变化
- objective 要具体可检验（如「揭示反派的真实身份」而非「推进主线」）

### synopsis Markdown 承载格式（必须写入 Volume.synopsis）
每个 volume 的 synopsis 必须使用以下段落组织，不能只写普通剧情摘要：
- 「## 全书主线阶段」：本卷推进全书核心问题的哪一步
- 「## 本卷主线」：本卷独立要解决的阶段性问题
- 「## 本卷戏剧问题」：读者读这一卷时最想知道的悬念
- 「## 开局状态」/「## 结尾状态」：结尾必须产生事实、关系、资源、地位、规则或危险的不可逆变化
- 「## 主线里程碑」：5-8 个必须发生的关键节点
- 「## 卷内支线」：2-4 条，逐条写清作用、起点、推进方式和阶段结果
- 「## 单元故事」：按 3-5 章一组设计完整小故事，写清局部目标、冲突、阶段结局，以及服务主线/人物/关系/世界主题的功能
- 「## 支线交叉点」：至少 1 个物证、事件或对话同时推进两条线
- 「## 伏笔分配」：本卷埋设、推进、回收哪些伏笔
- 「## 卷末交接」：分别写清已解决、已升级、移交下一卷

### 结构化字段（必须写入 Volume.narrativePlan）
每个 volume 除 synopsis Markdown 外，还必须输出 narrativePlan 对象，字段包含 globalMainlineStage、volumeMainline、dramaticQuestion、startState、endState、mainlineMilestones、subStoryLines、storyUnits、foreshadowPlan、endingHook、handoffToNextVolume。narrativePlan 与 synopsis 信息必须一致。
storyUnits 每项必须包含 unitId、title、chapterRange、localGoal、localConflict、serviceFunctions、payoff、stateChangeAfterUnit；serviceFunctions 至少 3 项。
每个 volume 的 narrativePlan 还必须包含 characterPlan：existingCharacterArcs、newCharacterCandidates、relationshipArcs、roleCoverage。
重要新增角色只能进入 characterPlan.newCharacterCandidates；章节级 supportingCharacters 仅兼容旧展示，不作为正式角色来源。
newCharacterCandidates 可为空；若有候选，每个候选必须包含 candidateId、name、roleType、scope=volume、narrativeFunction、personalityCore、motivation、firstAppearChapter、expectedArc、approvalStatus=candidate。`,
      guided_chapter: `请为指定卷规划 8-15 个章节，每章有明确的推进目标和核心冲突。
同时为本卷设计 2-4 个新登场的配角（不要重复核心角色步骤中已有的角色）。

## 强制结构规则（必须遵守）
### 章节节奏设计
- 开篇章要有引子/钩子，抓住读者注意力
- 中间章节要有交替的紧张和舒缓节奏
- 卷末章节必须有高潮或悬念收束
- 禁止每章都是「主角遇到敌人→战斗→获胜」的单一模式

### 冲突层次
- 外部冲突（对手/环境/任务）和内在冲突（信念/情感/道德）要交替出现
- 至少有 1-2 章以角色关系和内心活动为主线
- 每章的 conflict 必须具体到人物/事件，不能是「遇到困难」

### 信息与伏笔分配
- 每 3-4 章揭示一个重要信息或推进一条伏笔线
- 关键信息不要集中在最后几章

### 主线与支线分配
- 每章必须至少领到 1 个本卷主线任务，写进 objective 或 outline
- 每章必须至少推进 1 条卷内支线，写清支线名称和本章推进结果
- 每 3-5 章必须组成一个完整的单元故事 storyUnit：有局部目标、局部冲突、阶段结局；结局必须改变主线、人物、关系、世界/主题、伏笔或资源代价中的至少 3 项
- 每章 objective 必须具体可检验，不能只写「调查线索」「推进主线」
- 每章 conflict 必须写清阻力来源和阻力方式，例如谁阻止、用什么手段、主角付出什么代价
- 每章 outline 必须写成 3-5 个连续场景段，包含具体地点、出场人物、可被镜头拍到的动作、阻力、阶段结果和下一章交接，不能只写一句剧情摘要
- 章节不是场景边界，而是阅读节奏边界；一个大场景可以跨多个章节，但每章必须完成一个阶段动作，并把压力交接给下一章
- craftBrief 必须额外包含 storyUnit、sceneBeats、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState
- craftBrief 必须额外包含 characterExecution：povCharacter、cast、relationshipBeats、newMinorCharacters
- characterExecution.cast 的 source 只能是 existing、volume_candidate、minor_temporary；volume_candidate 必须来自上游卷纲 characterPlan.newCharacterCandidates；minor_temporary 必须出现在 newMinorCharacters
- sceneBeats.participants 与 relationshipBeats.participants 必须都被 characterExecution.cast.characterName 覆盖
- 章节级 supportingCharacters 仅兼容旧项目展示，不会自动写入正式 Character；重要新增角色必须先进入卷级 characterPlan.newCharacterCandidates
- storyUnit 必须包含 unitId、title、chapterRange、chapterRole、localGoal、localConflict、serviceFunctions、mainlineContribution、characterContribution、relationshipContribution、worldOrThemeContribution、unitPayoff、stateChangeAfterUnit；serviceFunctions 至少 3 项
- sceneBeats 至少 3 个场景段；跨章节场景必须沿用同一个 sceneArcId，并用 scenePart、continuesFromChapterNo、continuesToChapterNo 标明这是第几段
- entryState 必须接住上一章 exitState / handoffToNextChapter；handoffToNextChapter 必须给出下一章可直接接续的动作、地点、压力或未解决问题
- continuityState 必须写清角色位置、仍在生效的威胁、已持有线索/资源、关系变化和下一章最紧迫压力
- 每 3-4 章至少发生一次信息揭示、关系反转、资源得失、地位变化或规则升级
- 卷末章节必须收束本卷主线，并留下下一卷交接
- 禁止只写「推进、建立、完成、探索、揭示、面对、选择、升级、铺垫、承接、形成雏形」等抽象词；如果使用，必须绑定具体地点、人物、动作、物件和后果

### 配角设计规则（与核心角色同等严格）
#### 起名
- **禁用字黑名单**：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- 禁用复姓堆积（慕容/司空/上官等），禁用网文风名字（夜无殇、凌天）
- 名字要有真实生活感，像户口本上会出现的名字，带有时代和地域质感
- 参考真实人名的质感（如：许敬宗、孟尝、钟会、蔡文姬）
#### 性格
- 禁止「冷漠但内心温柔」「外表冷酷内心善良」等万能模板
- 每个配角至少一对内在矛盾（如：极度自律 vs 私下酗酒）
- 用具体行为描述性格，不用抽象标签。例如不说「善良」，而说「会把自己的干粮分给陌生人，但会因此对伙伴发脾气」
- 每个配角一个标志性小习惯或口头禅，让角色可被识别
#### 动机
- 禁止泛化目标：「帮助主角」「阻碍主角」「变强」「守护所爱的人」
- 动机必须来自一个具体的个人事件/记忆/人物
- 好的动机示例：「找到十二年前那个在码头替自己挡刀的哑巴老头，问他一句为什么」
- 差的动机示例：「为了帮助主角完成使命」「为了阻止邪恶势力」
#### 叙事功能
- 每个配角必须服务于本卷的叙事需要（推动冲突、提供信息、制造张力）
- 标注每个配角首次登场的章节号（firstAppearChapter）
- 至少有一个配角与主角的利益或立场存在冲突

### 质量标准
- outline 至少 50 字，要包含具体的场景、行为和结果
- objective 要具体可检验（如「读者了解了 X 的真实身份」而非「推进剧情」）
- 每个 chapter 必须输出 craftBrief 对象，包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、storyUnit、actionBeats、sceneBeats、characterExecution、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState
- 不生成正文，不写单章执行卡；这里生成的是整卷章节细纲`,
      guided_foreshadow: `请根据已完成的卷纲和章节细纲，设计一套完整的伏笔体系。
伏笔数量公式：主线 2-3 条 + 每卷 1-2 条卷级伏笔 + 适量章节级伏笔。
具体数量会在下方「伏笔数量约束」中指定，必须严格遵守。

## 强制创意规则（必须遵守）
### 分层要求
- 至少 2 条「主线伏笔」（scope=arc）：横跨全书，影响最终结局
- 每卷至少 1 条「卷级伏笔」（scope=volume）：跨卷呼应
- 适量「章节伏笔」（scope=chapter）：短距离闭合

### 手法多样性
- 至少使用 3 种不同的伏笔手法（technique）
- 禁止全部使用「对话型」或全部使用「道具型」

### 时间分布
- 埋设点（plantChapter）应分散在前 70% 的章节中
- 揭开点（revealChapter）应在中后段逐步展开
- 禁止所有伏笔都在最后一卷揭开

### 角色关联
- involvedCharacters 必须使用已有角色的真实名字
- 主角相关伏笔不超过总数的一半
- 反派/对手至少关联 1 条伏笔

### 质量标准
- detail 至少 50 字，描述埋设场景和揭开场景的具体画面
- payoff 必须说明揭开后对剧情/角色/读者认知的具体影响
- 至少 2 条伏笔之间存在交织或因果关联

### 反模式
- 禁止「主角是天选之子」「梦境预言」等老套伏笔
- 禁止所有伏笔都是「角色隐藏身份」
- 禁止埋设后从不揭开的断头伏笔`,
    };

    const schema = isSingleChapterRefinement
      ? GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA
      : getGuidedStepJsonSchema(dto.currentStep);
    const label = GUIDED_STEPS_LABELS[dto.currentStep] ?? dto.currentStep;
    const instruction = stepSpecificInstructions[dto.currentStep] ?? '';

    if (!schema) {
      throw new NotFoundException(`未知步骤：${dto.currentStep}`);
    }

    // Priority: DB template → hardcoded fallback
    const dbTemplate = await this.resolvePromptTemplate(projectId, dto.currentStep);

    // Template variable values available in generate mode
    const templateVars: Record<string, string | undefined> = {
      projectContext: dto.projectContext,
      chatSummary: dto.chatSummary,
      userHint: dto.userHint,
      userMessage: dto.userHint,
      stepLabel: label,
      stepInstruction: instruction,
      jsonSchema: schema,
    };

    let systemPrompt: string;
    if (dbTemplate?.systemPrompt) {
      // Use DB template, render variables, then append JSON schema requirement
      systemPrompt = renderTemplate(dbTemplate.systemPrompt, templateVars);
      systemPrompt += `

## 输出格式
你的回复必须包含两个部分：
1. 先用一段简短的中文说明你生成了什么
2. 然后输出完整的 JSON 数据，格式严格遵循以下 schema：
${schema}

注意：JSON 部分用 \`\`\`json 代码块包裹。`;
    } else {
      systemPrompt = `你是一个资深小说创作顾问。现在需要你一次性生成「${label}」的完整结构化数据。

## 要求
${instruction}

## 输出格式
你的回复必须包含两个部分：
1. 先用一段简短的中文说明你生成了什么
2. 然后输出完整的 JSON 数据，格式严格遵循以下 schema：
${schema}

注意：JSON 部分用 \`\`\`json 代码块包裹。`;
    }

    if (dto.projectContext) {
      systemPrompt += `\n\n## 用户已有的项目设定（必须基于这些信息来生成）\n${dto.projectContext}`;
    }

    if (dto.currentStep === 'guided_chapter') {
      const phase4AssetContext = await this.buildGuidedChapterAssetContext(projectId, dto.volumeNo, dto.chapterNo);
      if (phase4AssetContext) {
        systemPrompt += `\n\n## 章节模板与节奏目标（只读计划资产）\n${phase4AssetContext}`;
      }
    }

    if (dto.chatSummary) {
      systemPrompt += `\n\n## 用户在本步骤对话中已确认的偏好（必须严格遵守）\n${dto.chatSummary}`;
    }

    // For guided_volume, extract the volume count from userHint and reinforce it in the system prompt
    if (dto.currentStep === 'guided_volume' && dto.userHint) {
      const countMatch = dto.userHint.match(/(\d+)\s*卷/);
      if (countMatch) {
        const volumeCount = parseInt(countMatch[1], 10);
        systemPrompt += `\n\n## ⚠️ 卷数硬性约束（最高优先级）\n用户明确要求生成 **${volumeCount}** 卷。你必须严格输出恰好 ${volumeCount} 个 volume 对象，volumes 数组长度必须为 ${volumeCount}，不得多也不得少。`;
      }
    }

    // For guided_chapter with volumeNo, inject volume-specific context.
    // Adding chapterNo switches this endpoint into single-chapter refinement mode.
    if (dto.currentStep === 'guided_chapter' && dto.volumeNo !== undefined) {
      if (isSingleChapterRefinement) {
        const singleChapterContext = await this.buildSingleChapterContext(
          projectId,
          dto.volumeNo,
          dto.chapterNo as number,
        );

        systemPrompt += `\n\n## ⚠️ 当前生成目标（最高优先级：单章细化模式）
这是 \`guided_chapter + volumeNo + chapterNo\` 的单章细化，不是整卷章节生成。
仅细化 **第 ${dto.volumeNo} 卷第 ${dto.chapterNo} 章**，不生成正文，不新增章节，不删除章节，不重排整卷章节。
你必须只返回 chapters 数组中的 **1** 个 chapter 对象；对象的 volumeNo 必须是 ${dto.volumeNo}，chapterNo 必须是 ${dto.chapterNo}。
保留当前章节标题、目标和冲突的核心意图，除非它们明显空泛；可以把它们改得更具体、更可执行。
outline 必须写成 Markdown，并且必须以 \`## 本章执行卡\` 开头，至少包含这些小节或标签：表层目标、隐藏情绪、核心冲突、单元故事、入场状态、场景链、行动链、物证/线索、对话潜台词、人物变化、不可逆后果、离场状态、下一章交接。
craftBrief 必须输出同一执行卡的结构化版本，字段与 Markdown 内容一致，供正文生成直接读取；其中 storyUnit 必须保留或补全本章所属单元故事、章节范围、本章角色和至少 3 项叙事功能。
craftBrief 必须包含 storyUnit、sceneBeats、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState；sceneBeats 至少 3 个场景段，跨章场景用同一 sceneArcId 串联。
entryState 必须接住前一章状态；handoffToNextChapter 必须给出下一章可直接接续的动作、地点、压力或未解决问题。
如果前文或模板要求生成整卷章节，请忽略该要求，以本节单章细化规则为准。

## 当前卷信息
${singleChapterContext.volumeContext}

## 当前章已有细纲
${singleChapterContext.currentChapterContext}

## 同卷前后章摘要（用于保持节奏与连续性，不得改写这些章节）
${singleChapterContext.neighborChapterContext}

## 本章卷内位置与节奏功能
${singleChapterContext.chapterPositionContext}`;
      } else {
        // Look up volume info from the session's saved volume data
        let volumeContext = '';
        try {
          const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
          const stepData = (session?.stepData as Record<string, unknown>) ?? {};
          const volumeResult = stepData['guided_volume_result'] as Record<string, unknown> | undefined;
          const volumes = (volumeResult?.volumes ?? []) as Array<Record<string, unknown>>;
          const targetVol = volumes.find((v) => asNumber(v.volumeNo) === dto.volumeNo);
          if (targetVol) {
            volumeContext = `\n- 卷名：${targetVol.title}\n- 本卷核心目标：${targetVol.objective}\n- 本卷剧情概要：${targetVol.synopsis}`;
          }
        } catch { /* non-critical */ }

        // Extract chapter count range from userHint (e.g. "生成 8-15 章")
        let chapterRangeStr = '8-15';
        const rangeMatch = dto.userHint?.match(/(\d+)\s*-\s*(\d+)\s*章/);
        if (rangeMatch) {
          chapterRangeStr = `${rangeMatch[1]}-${rangeMatch[2]}`;
        }

        systemPrompt += `\n\n## ⚠️ 当前生成目标（最高优先级）\n仅为 **第 ${dto.volumeNo} 卷** 生成章节细纲。${volumeContext}\n\n所有生成的 chapter 对象中 volumeNo 字段必须为 ${dto.volumeNo}。请为本卷规划 **${chapterRangeStr}** 个章节（不多不少）。每一章的 entryState 必须接住上一章的 exitState / handoffToNextChapter；允许同一 sceneArcId 跨章节延续，但每章必须有自己的阶段结果。`;
      }
    }

    // For guided_foreshadow, compute dynamic foreshadow count based on volume count
    // Formula: arc-level 2-3 + volume-level 1-2 per volume + a few chapter-level
    if (dto.currentStep === 'guided_foreshadow') {
      let volumeCount = 3; // default assumption
      let volumeSummary = '';
      try {
        const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
        const stepData = (session?.stepData as Record<string, unknown>) ?? {};
        const volumeResult = stepData['guided_volume_result'] as Record<string, unknown> | undefined;
        const volumes = (volumeResult?.volumes ?? []) as Array<Record<string, unknown>>;
        if (volumes.length > 0) {
          volumeCount = volumes.length;
          // Build a brief summary of all volumes for context
          volumeSummary = volumes
            .map((v) => `第${v.volumeNo}卷「${v.title}」: ${v.objective}`)
            .join('\n');
        }
      } catch { /* non-critical */ }

      // Compute target counts by tier
      const arcCount = volumeCount <= 3 ? 2 : 3;
      const volumeLevelCount = volumeCount; // ~1 per volume
      const chapterLevelCount = Math.max(2, Math.floor(volumeCount * 0.5));
      const totalMin = arcCount + volumeLevelCount + chapterLevelCount;
      const totalMax = totalMin + Math.floor(volumeCount * 0.5);

      systemPrompt += `\n\n## ⚠️ 伏笔数量约束（最高优先级）\n本书共 **${volumeCount}** 卷，请生成 **${totalMin}-${totalMax}** 条伏笔线索：\n- 主线伏笔（scope=arc）：**${arcCount}** 条\n- 卷级伏笔（scope=volume）：**${volumeLevelCount}-${volumeLevelCount + 2}** 条（约每卷 1-2 条）\n- 章节伏笔（scope=chapter）：**${chapterLevelCount}-${chapterLevelCount + 2}** 条`;

      if (volumeSummary) {
        systemPrompt += `\n\n## 各卷概要（伏笔应分布在这些卷中）\n${volumeSummary}`;
      }
    }

    // Use DB userTemplate for user message if available, otherwise use default
    const userMessage = dbTemplate?.userTemplate
      ? renderTemplate(dbTemplate.userTemplate, templateVars)
      : dto.userHint
        ? `请根据以下偏好来生成：${dto.userHint}`
        : `请直接生成「${label}」的完整数据。`;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const reply = await this.llm.chat(messages, {
      temperature: 0.9,
      maxTokens: 128000,
      appStep: 'guided',
    });

    // Extract JSON from response (support both ```json blocks and raw JSON)
    const codeBlockMatch = reply.match(/```json\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch
      ? codeBlockMatch[1].trim()
      : (reply.match(/\{[\s\S]*\}/)?.[0] ?? '');

    if (!jsonStr) {
      throw new Error('AI 未返回有效的 JSON 数据');
    }

    let structuredData = JSON.parse(jsonStr) as Record<string, unknown>;
    const warnings: string[] = [];

    if (isSingleChapterRefinement) {
      const normalized = this.normalizeSingleChapterResult(
        structuredData,
        dto.volumeNo as number,
        dto.chapterNo as number,
      );
      structuredData = normalized.structuredData;
      warnings.push(...normalized.warnings);
    }
    if (dto.currentStep === 'guided_volume') {
      await this.assertGuidedVolumesCharacterPlans(projectId, asRecordArray(structuredData.volumes));
    }
    if (dto.currentStep === 'guided_chapter') {
      this.assertGuidedChaptersQuality(structuredData.chapters);
      await this.assertGuidedChaptersCharacterExecutions(projectId, asRecordArray(structuredData.chapters));
    }

    // Extract the summary text (everything before the JSON)
    const summaryEnd = reply.indexOf('```json') >= 0
      ? reply.indexOf('```json')
      : reply.indexOf('{');
    let summary = reply.slice(0, summaryEnd).trim() || `已生成「${label}」数据`;
    if (warnings.length > 0) {
      summary += `\n\n注意：${warnings.join('；')}`;
    }

    return { structuredData, summary };
  }

  /** Finalize a step: write structured AI output to the database */
  async finalizeStep(
    projectId: string,
    step: string,
    structuredData: Record<string, unknown>,
    volumeNo?: number,
  ): Promise<{ written: string[] }> {
    const written: string[] = [];

    switch (step) {
      case 'guided_setup': {
        // Write to Project: genre, theme, tone, logline, synopsis
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            genre: asString(structuredData.genre),
            theme: asString(structuredData.theme),
            tone: asString(structuredData.tone),
            logline: asString(structuredData.logline),
            synopsis: asString(structuredData.synopsis),
          },
        });
        written.push('Project(genre, theme, tone, logline, synopsis)');
        break;
      }

      case 'guided_style': {
        // Create or update the default StyleProfile
        const profileData = {
          name: '引导生成',
          pov: asString(structuredData.pov),
          tense: asString(structuredData.tense),
          proseStyle: asString(structuredData.proseStyle),
          pacing: asString(structuredData.pacing),
        };

        const existing = await this.prisma.styleProfile.findFirst({
          where: { projectId, name: '引导生成' },
        });

        if (existing) {
          await this.prisma.styleProfile.update({
            where: { id: existing.id },
            data: profileData,
          });
        } else {
          await this.prisma.styleProfile.create({
            data: { projectId, ...profileData },
          });
        }
        written.push('StyleProfile(pov, tense, proseStyle, pacing)');
        break;
      }

      case 'guided_characters': {
        // 角色通常一次生成多条，批量插入可减少数据库往返。
        const characters = structuredData.characters as Array<Record<string, unknown>> | undefined;
        if (characters?.length) {
          await this.prisma.character.createMany({
            data: characters.map((char) => ({
                projectId,
                name: asString(char.name) ?? '未命名角色',
                roleType: asString(char.roleType),
                personalityCore: asString(char.personalityCore),
                motivation: asString(char.motivation),
                backstory: asString(char.backstory),
                scope: 'global',
                source: 'guided',
            })),
          });
          written.push(`Character × ${characters.length}`);
        }
        break;
      }

      case 'guided_outline': {
        // Write to Project.outline
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            outline: asString(structuredData.outline),
          },
        });
        written.push('Project(outline)');
        break;
      }

      case 'guided_volume': {
        // Replace all existing volumes for this project (delete-then-create)
        const volumes = structuredData.volumes as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(volumes) || !volumes.length) {
          throw new BadRequestException('guided_volume 写入失败：缺少非空 volumes。请重新生成完整卷纲后再审批写入。');
        }
        if (volumes?.length) {
          await this.assertGuidedVolumesCharacterPlans(projectId, volumes);
          // 先删除再批量写入，并放在同一事务里，避免中途失败留下空卷纲。
          await this.prisma.$transaction([
            this.prisma.volume.deleteMany({ where: { projectId } }),
            this.prisma.volume.createMany({
              data: volumes.map((vol, index) => ({
                projectId,
                volumeNo: requireGuidedPositiveInt(vol.volumeNo, `第 ${index + 1} 个卷纲 volumeNo`),
                chapterCount: requireGuidedPositiveInt(vol.chapterCount, `第 ${index + 1} 个卷纲 chapterCount`),
                title: asString(vol.title),
                synopsis: asString(vol.synopsis),
                objective: asString(vol.objective),
                narrativePlan: normalizeVolumeNarrativePlan(vol),
                status: 'planned',
              })),
            }),
          ]);
          written.push(`Volume × ${volumes.length}`);
        }
        break;
      }

      case 'guided_chapter': {
        // Create Chapter records, linked to volumes by volumeNo.
        // chapterNo must be globally unique per project (@@unique([projectId, chapterNo])),
        // so per-volume saves update existing rows in place to avoid renumbering chapters.
        const chapters = structuredData.chapters as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(chapters) || !chapters.length) {
          throw new BadRequestException('guided_chapter 写入失败：缺少非空 chapters。请重新生成完整章节细纲后再审批写入。');
        }
        if (chapters?.length) {
          await this.assertGuidedChaptersCharacterExecutions(projectId, chapters);
          // Pre-fetch all volumes for this project to map volumeNo → volumeId
          const existingVolumes = await this.prisma.volume.findMany({
            where: { projectId },
            select: { id: true, volumeNo: true },
          });
          const volumeNoToId = new Map(existingVolumes.map((v) => [v.volumeNo, v.id]));

          if (volumeNo) {
            // Per-volume save: preserve existing chapterNo values instead of deleting and re-creating
            // the whole volume. This keeps single-chapter refinement from moving other chapters.
            const targetVolumeId = volumeNoToId.get(volumeNo);
            if (targetVolumeId) {
              const existingChapters = await this.prisma.chapter.findMany({
                where: { projectId, volumeId: targetVolumeId },
                orderBy: { chapterNo: 'asc' },
              });

              const maxChapter = await this.prisma.chapter.aggregate({
                where: { projectId },
                _max: { chapterNo: true },
              });
              let nextChapterNo = (maxChapter._max.chapterNo ?? 0) + 1;

              const operations: Prisma.PrismaPromise<unknown>[] = [];
              const isSingleChapterSave = structuredData.saveMode === 'single_chapter' && chapters.length === 1;
              const singleChapterNo = isSingleChapterSave ? asNumber(chapters[0].chapterNo) : undefined;

              chapters.forEach((ch, index) => {
                const existing = singleChapterNo !== undefined
                  ? existingChapters.find((item) => item.chapterNo === singleChapterNo)
                  : existingChapters[index];
                const data = {
                  volumeId: targetVolumeId,
                  title: asString(ch.title),
                  objective: asString(ch.objective),
                  conflict: asString(ch.conflict),
                  outline: asString(ch.outline),
                  craftBrief: normalizeChapterCraftBrief(ch),
                  status: 'planned' as const,
                };

                if (existing) {
                  if (hasChapterFieldChange(existing, data)) {
                    operations.push(this.prisma.chapter.update({
                      where: { id: existing.id },
                      data,
                    }));
                  }
                  return;
                }

                operations.push(this.prisma.chapter.create({
                  data: {
                    projectId,
                    volumeId: targetVolumeId,
                    chapterNo: singleChapterNo !== undefined && singleChapterNo >= nextChapterNo ? singleChapterNo : nextChapterNo++,
                    title: data.title,
                    objective: data.objective,
                    conflict: data.conflict,
                    outline: data.outline,
                    craftBrief: data.craftBrief,
                    status: 'planned',
                  },
                }));
              });

              if (singleChapterNo === undefined) {
                const extraChapterIds = existingChapters.slice(chapters.length).map((ch) => ch.id);
                if (extraChapterIds.length > 0) {
                  operations.push(this.prisma.chapter.deleteMany({
                    where: { projectId, id: { in: extraChapterIds } },
                  }));
                }
              }

              if (operations.length > 0) {
                await this.prisma.$transaction(operations);
              }
            }
          } else {
            // Full save: replace all chapters for this project and create globally sequential numbers.
            await this.prisma.chapter.deleteMany({ where: { projectId } });

            await this.prisma.chapter.createMany({
              data: chapters.map((ch, index) => {
                const chVolumeNo = asNumber(ch.volumeNo);
                const resolvedVolumeId = chVolumeNo ? volumeNoToId.get(chVolumeNo) ?? null : null;

                return {
                  projectId,
                  volumeId: resolvedVolumeId,
                  chapterNo: index + 1,
                  title: asString(ch.title),
                  objective: asString(ch.objective),
                  conflict: asString(ch.conflict),
                  outline: asString(ch.outline),
                  craftBrief: normalizeChapterCraftBrief(ch),
                  status: 'planned',
                };
              }),
            });
          }
          written.push(`Chapter × ${chapters.length}`);
        }
        break;
      }

      case 'guided_foreshadow': {
        // Create ForeshadowTrack records with enriched metadata.
        // Technique, plantChapter, revealChapter, involvedCharacters, payoff
        // are stored in the metadata JSON field for downstream use.
        const tracks = structuredData.foreshadowTracks as Array<Record<string, unknown>> | undefined;
        if (tracks?.length) {
          // Delete old guided foreshadow tracks to prevent duplicates on re-generation
          await this.prisma.foreshadowTrack.deleteMany({
            where: { projectId, source: 'guided' },
          });

          await this.prisma.foreshadowTrack.createMany({
            data: tracks.map((track) => ({
                projectId,
                title: asString(track.title) ?? '未命名伏笔',
                detail: asString(track.detail),
                status: 'planned',
                scope: asString(track.scope) ?? 'arc',
                source: 'guided',
                metadata: {
                  technique: asString(track.technique),
                  plantChapter: asString(track.plantChapter),
                  revealChapter: asString(track.revealChapter),
                  involvedCharacters: asString(track.involvedCharacters),
                  payoff: asString(track.payoff),
                },
            })),
          });
          written.push(`ForeshadowTrack × ${tracks.length}`);
        }
        break;
      }

      default:
        break;
    }

    // Also save to session stepData for reference.
    // For per-volume chapter saves, merge new chapters into existing result
    // instead of overwriting, so previously saved volumes are preserved.
    const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
    if (session) {
      const existingData = (session.stepData as Record<string, unknown>) ?? {};

      let resultToSave: Record<string, unknown> = structuredData;

      // Per-volume chapter save: merge chapters and supportingCharacters into existing result
      if (step === 'guided_chapter' && volumeNo) {
        const existingResult = (existingData['guided_chapter_result'] ?? {}) as Record<string, unknown>;

        // Merge chapters: full-volume saves replace that volume; single-chapter saves replace only that chapter.
        const existingChapters = (existingResult.chapters ?? []) as Array<Record<string, unknown>>;
        const newChapters = (structuredData.chapters ?? []) as Array<Record<string, unknown>>;
        const isSingleChapterSave = structuredData.saveMode === 'single_chapter' && newChapters.length === 1;
        const singleChapterNo = isSingleChapterSave ? asNumber(newChapters[0].chapterNo) : undefined;
        let mergedChapters: Array<Record<string, unknown>>;

        if (singleChapterNo !== undefined) {
          let replaced = false;
          mergedChapters = existingChapters.map((ch) => {
            if (asNumber(ch.volumeNo) === volumeNo && asNumber(ch.chapterNo) === singleChapterNo) {
              replaced = true;
              return { ...newChapters[0], volumeNo, chapterNo: singleChapterNo };
            }
            return ch;
          });

          if (!replaced) {
            mergedChapters.push({ ...newChapters[0], volumeNo, chapterNo: singleChapterNo });
          }
        } else {
          mergedChapters = [
            ...existingChapters.filter((ch) => asNumber(ch.volumeNo) !== volumeNo),
            ...newChapters,
          ];
        }

        // Merge supporting characters: keyed by volumeNo to prevent cross-volume overwrites
        const existingSupportChars = (existingResult.volumeSupportingCharacters ?? {}) as Record<string, unknown>;
        const newSupportChars = structuredData.supportingCharacters as Array<Record<string, unknown>> | undefined;
        const mergedSupportChars = Array.isArray(newSupportChars)
          ? { ...existingSupportChars, [volumeNo]: newSupportChars }
          : existingSupportChars;

        resultToSave = {
          ...existingResult,
          chapters: mergedChapters,
          volumeSupportingCharacters: mergedSupportChars,
        };
      }

      await this.prisma.guidedSession.update({
        where: { projectId },
        data: {
          stepData: { ...existingData, [`${step}_result`]: resultToSave } as object,
        },
      });
    }

    if (written.length > 0) {
      // 引导式写入可能新增设定、章节、角色或伏笔，都会改变后续章节召回输入/结果；写入后清空项目级召回缓存。
      await this.cacheService.deleteProjectRecallResults(projectId);
    }

    return { written };
  }
}

/** Safely extract a string value, returning undefined for non-strings */
function asString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

/** Safely extract a numeric value from JSON-ish AI/session data */
function asNumber(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? val as Record<string, unknown>
    : undefined;
}

function asRecordArray(val: unknown): Array<Record<string, unknown>> {
  return Array.isArray(val)
    ? val.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringArray(val: unknown): string[] {
  return Array.isArray(val)
    ? val.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function formatJsonBrief(val: unknown, maxLength: number): string | undefined {
  const record = asRecord(val);
  if (!record || Object.keys(record).length === 0) return undefined;
  const text = JSON.stringify(record);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function asInputJsonObject(val: unknown): Prisma.InputJsonValue {
  const record = asRecord(val);
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireGuidedPositiveInt(value: unknown, label: string): number {
  const numeric = asNumber(value);
  if (!Number.isInteger(numeric) || !numeric || numeric < 1) {
    throw new BadRequestException(`${label} 必须是正整数。`);
  }
  return numeric;
}

function normalizeVolumeNarrativePlan(volume: Record<string, unknown>): Prisma.InputJsonValue {
  return asInputJsonObject(volume.narrativePlan);
}

function normalizeChapterCraftBrief(chapter: Record<string, unknown>): Prisma.InputJsonValue {
  const existing = asRecord(chapter.craftBrief);
  if (existing && Object.keys(existing).length > 0) return asInputJsonObject(existing);

  throw new BadRequestException('章节细纲缺少 craftBrief，已阻止写入。请重新生成或补齐完整执行卡。');
}

function formatChapterContext(ch: Record<string, unknown>, outlineLimit = 500): string {
  const outline = asString(ch.outline) ?? '未填写';
  const trimmedOutline = outline.length > outlineLimit
    ? `${outline.slice(0, outlineLimit)}…`
    : outline;
  const craftBrief = asRecord(ch.craftBrief);

  return [
    `- 章节号：第 ${asNumber(ch.chapterNo) ?? '未知'} 章`,
    `- 标题：${asString(ch.title) ?? '未命名'}`,
    `- 目标：${asString(ch.objective) ?? '未填写'}`,
    `- 冲突：${asString(ch.conflict) ?? '未填写'}`,
    `- outline：${trimmedOutline}`,
    craftBrief && Object.keys(craftBrief).length > 0 ? `- craftBrief：${JSON.stringify(craftBrief).slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');
}

function hasChapterFieldChange(
  existing: {
    title: string | null;
    objective: string | null;
    conflict: string | null;
    outline: string | null;
    craftBrief?: Prisma.JsonValue;
    status: string;
  },
  next: {
    title?: string;
    objective?: string;
    conflict?: string;
    outline?: string;
    craftBrief?: Prisma.InputJsonValue;
    status: string;
  },
): boolean {
  return (next.title !== undefined && existing.title !== next.title)
    || (next.objective !== undefined && existing.objective !== next.objective)
    || (next.conflict !== undefined && existing.conflict !== next.conflict)
    || (next.outline !== undefined && existing.outline !== next.outline)
    || (next.craftBrief !== undefined && JSON.stringify(existing.craftBrief ?? {}) !== JSON.stringify(next.craftBrief ?? {}))
    || existing.status !== next.status;
}

/** Truncate a string to fit a VarChar column, appending '…' if needed */
function truncate(val: string | undefined, maxLen: number): string | undefined {
  if (!val) return val;
  if (val.length <= maxLen) return val;
  return val.slice(0, maxLen - 1) + '…';
}
