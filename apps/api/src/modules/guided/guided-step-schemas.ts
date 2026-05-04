export const GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA = '{"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题（保留原核心意图）","objective":"本章目标（具体可检验）","conflict":"核心冲突（写清阻力来源和方式）","outline":"Markdown，必须以 ## 本章执行卡 开头，并包含表层目标/隐藏情绪/核心冲突/行动链/物证/线索/对话潜台词/人物变化/不可逆后果","craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"actionBeats":["行动链节点"],"concreteClues":[{"name":"物证或线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"对话潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"]}}]}';

export const GUIDED_STEP_JSON_SCHEMAS = {
  guided_setup: '{"genre":"小说类型","theme":"核心主题","tone":"故事基调","logline":"一句话概述","synopsis":"故事简介"}',
  guided_style: '{"pov":"人称视角","tense":"时态","proseStyle":"文风描述","pacing":"节奏描述"}',
  guided_characters: '{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting/competitor","personalityCore":"性格核心","motivation":"核心动机","backstory":"背景故事"}]}',
  guided_outline: '{"outline":"完整的故事总纲大纲"}',
  guided_volume: '{"volumes":[{"volumeNo":1,"title":"有文学性的卷名","synopsis":"Markdown结构，必须含## 全书主线阶段/## 本卷主线/## 本卷戏剧问题/## 卷内支线/## 支线交叉点/## 卷末交接等段落","objective":"本卷核心目标(具体可检验)","narrativePlan":{"globalMainlineStage":"全书主线阶段","volumeMainline":"本卷主线","dramaticQuestion":"本卷戏剧问题","startState":"开局状态","endState":"结尾状态","mainlineMilestones":["关键节点"],"subStoryLines":[{"name":"支线名","type":"mystery","function":"叙事作用","startState":"起点","progress":"推进方式","endState":"阶段结果","relatedCharacters":["角色名"],"chapterNodes":[1]}],"foreshadowPlan":["伏笔分配"],"endingHook":"卷末钩子","handoffToNextVolume":"卷末交接"}}]}',
  guided_chapter: '{"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"章节大纲，必须含主线任务、支线任务、具体场景行动、阶段结果","craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"actionBeats":["行动链节点"],"concreteClues":[{"name":"物证或线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"对话潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"]}}],"supportingCharacters":[{"name":"角色名","roleType":"supporting","personalityCore":"性格核心(含内在矛盾)","motivation":"具体动机","firstAppearChapter":1}]}',
  guided_foreshadow: '{"foreshadowTracks":[{"title":"伏笔标题","detail":"伏笔内容详细描述","scope":"arc/volume/chapter","technique":"伏笔手法类型","plantChapter":"埋设时机","revealChapter":"揭开时机","involvedCharacters":"涉及角色","payoff":"揭开后的影响"}]}',
} as const;

export type GuidedStepSchemaKey = keyof typeof GUIDED_STEP_JSON_SCHEMAS;

export function getGuidedStepJsonSchema(stepKey: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(GUIDED_STEP_JSON_SCHEMAS, stepKey)
    ? GUIDED_STEP_JSON_SCHEMAS[stepKey as GuidedStepSchemaKey]
    : undefined;
}
