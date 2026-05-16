const storyUnitSchema = {
  unitId: 'v1_unit_01',
  title: '单元故事名',
  chapterRange: { start: 1, end: 4 },
  chapterRole: '开局/升级/反转/收束',
  localGoal: '单元局部目标',
  localConflict: '单元核心阻力',
  serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
  mainlineContribution: '本章如何推进主线',
  characterContribution: '本章如何塑造人物',
  relationshipContribution: '本章如何改变关系',
  worldOrThemeContribution: '本章如何展开世界或主题',
  unitPayoff: '单元阶段结局',
  stateChangeAfterUnit: '单元结束后的状态变化',
};

const sceneBeatSchema = {
  sceneArcId: '跨章场景ID',
  scenePart: '1/3',
  continuesFromChapterNo: null,
  continuesToChapterNo: 2,
  location: '具体地点',
  participants: ['角色名'],
  localGoal: '本场局部目标',
  visibleAction: '可被镜头拍到的动作',
  obstacle: '阻力来源和方式',
  turningPoint: '反转或新信息',
  partResult: '场景段结果',
  sensoryAnchor: '感官锚点',
};

const characterExecutionSchema = {
  povCharacter: '既有角色名',
  cast: [{
    characterName: '角色名',
    source: 'existing/volume_candidate/minor_temporary',
    functionInChapter: '本章功能',
    visibleGoal: '可见目标',
    pressure: '压力',
    actionBeatRefs: [1],
    sceneBeatRefs: ['跨章场景ID'],
    entryState: '入场状态',
    exitState: '离场状态',
  }],
  relationshipBeats: [{
    participants: ['角色名A', '角色名B'],
    publicStateBefore: '关系公开起点',
    trigger: '触发关系变化的具体事件',
    shift: '关系变化',
    publicStateAfter: '关系公开结果',
  }],
  newMinorCharacters: [{
    nameOrLabel: '一次性临时角色',
    narrativeFunction: '仅服务本章场景的功能',
    interactionScope: '互动范围',
    firstAndOnlyUse: true,
    approvalPolicy: 'preview_only',
  }],
};

const craftBriefSchema = {
  visibleGoal: '表层目标',
  hiddenEmotion: '隐藏情绪',
  coreConflict: '核心冲突',
  mainlineTask: '本章主线任务',
  subplotTasks: ['支线任务'],
  storyUnit: storyUnitSchema,
  actionBeats: ['行动链节点'],
  sceneBeats: [sceneBeatSchema],
  characterExecution: characterExecutionSchema,
  concreteClues: [{ name: '物证或线索', sensoryDetail: '感官细节', laterUse: '后续用途' }],
  dialogueSubtext: '对话潜台词',
  characterShift: '人物变化',
  irreversibleConsequence: '不可逆后果',
  progressTypes: ['info'],
  entryState: '接住上一章压力',
  exitState: '本章结束状态',
  openLoops: ['未解决问题'],
  closedLoops: ['阶段性解决问题'],
  handoffToNextChapter: '下一章接续动作和压力',
  continuityState: {
    characterPositions: ['角色位置'],
    activeThreats: ['仍在生效的威胁'],
    ownedClues: ['已持有线索'],
    relationshipChanges: ['关系变化'],
    nextImmediatePressure: '下一章最紧迫压力',
  },
};

const characterPlanSchema = {
  existingCharacterArcs: [{
    characterName: '既有角色名',
    roleInVolume: '本卷角色功能',
    entryState: '入卷状态',
    volumeGoal: '本卷目标',
    pressure: '压力',
    keyChoices: ['关键选择'],
    firstActiveChapter: 1,
    endState: '出卷状态',
  }],
  newCharacterCandidates: [{
    candidateId: 'v1_candidate_01',
    name: '候选角色名',
    roleType: 'supporting',
    scope: 'volume',
    narrativeFunction: '叙事功能',
    personalityCore: '性格核心',
    motivation: '动机',
    conflictWith: ['既有角色名'],
    relationshipAnchors: ['既有角色名'],
    firstAppearChapter: 2,
    expectedArc: '本卷弧线',
    approvalStatus: 'candidate',
  }],
  relationshipArcs: [{
    participants: ['既有角色名', '候选角色名'],
    startState: '关系起点',
    turnChapterNos: [2],
    endState: '关系终点',
  }],
  roleCoverage: {
    mainlineDrivers: ['既有角色名'],
    antagonistPressure: [],
    emotionalCounterweights: [],
    expositionCarriers: ['候选角色名'],
  },
};

export const GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA = JSON.stringify({
  chapters: [{
    chapterNo: 1,
    volumeNo: 1,
    title: '章节标题（保留原核心意图）',
    objective: '本章目标（具体可检验）',
    conflict: '核心冲突（写清阻力来源和方式）',
    outline: 'Markdown，必须以 ## 本章执行卡 开头，并包含角色执行、场景链、行动链和下一章交接',
    craftBrief: craftBriefSchema,
  }],
});

export const GUIDED_OUTLINE_FORESHADOW_SCHEMA = JSON.stringify({
  foreshadowTracks: [{
    title: 'outline-level foreshadow title',
    detail: 'concrete setup, concealment, and future payoff',
    scope: 'book/cross_volume/volume',
    technique: 'prop/dialogue/behavior/environment/narrative/symbol/structure',
    plantStage: 'where it is planted in the whole-story outline',
    revealStage: 'where it is revealed in the whole-story outline',
    involvedCharacters: 'related existing character names',
    payoff: 'plot, character, or reader-recognition effect after reveal',
  }],
});

export const GUIDED_STEP_JSON_SCHEMAS = {
  guided_setup: JSON.stringify({
    genre: '小说类型',
    theme: '核心主题',
    tone: '故事基调',
    logline: '一句话概述',
    synopsis: '故事简介',
  }),
  guided_style: JSON.stringify({
    pov: '人称视角',
    tense: '时态',
    proseStyle: '文风描述',
    pacing: '节奏描述',
  }),
  guided_characters: JSON.stringify({
    characters: [{
      name: '角色名',
      roleType: 'protagonist/antagonist/supporting/competitor',
      personalityCore: '性格核心',
      motivation: '核心动机',
      backstory: '背景故事',
    }],
  }),
  guided_outline: JSON.stringify({ outline: '完整的故事总纲大纲' }),
  guided_volume: JSON.stringify({
    volumes: [{
      volumeNo: 1,
      chapterCount: 4,
      title: '有文学性的卷名',
      synopsis: 'Markdown结构，必须含全书主线阶段/本卷主线/本卷戏剧问题/卷内支线/单元故事/支线交叉点/卷末交接等段落',
      objective: '本卷核心目标(具体可检验)',
      narrativePlan: {
        globalMainlineStage: '全书主线阶段',
        volumeMainline: '本卷主线',
        dramaticQuestion: '本卷戏剧问题',
        startState: '开局状态',
        endState: '结尾状态',
        mainlineMilestones: ['关键节点'],
        subStoryLines: [{
          name: '支线名',
          type: 'mystery',
          function: '叙事作用',
          startState: '起点',
          progress: '推进方式',
          endState: '阶段结果',
          relatedCharacters: ['角色名'],
          chapterNodes: [1],
        }],
        storyUnits: [{
          unitId: 'v1_unit_01',
          title: '单元故事名',
          chapterRange: { start: 1, end: 4 },
          localGoal: '单元局部目标',
          localConflict: '单元核心阻力',
          serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
          payoff: '单元阶段结局',
          stateChangeAfterUnit: '单元结束后的状态变化',
        }],
        characterPlan: characterPlanSchema,
        foreshadowPlan: ['伏笔分配'],
        endingHook: '卷末钩子',
        handoffToNextVolume: '卷末交接',
      },
    }],
  }),
  guided_chapter: JSON.stringify({
    chapters: [{
      chapterNo: 1,
      volumeNo: 1,
      title: '章节标题',
      objective: '本章目标',
      conflict: '核心冲突',
      outline: '章节大纲，必须含主线任务、支线任务、单元故事、3-5个具体场景段、角色执行、阶段结果和下一章交接',
      craftBrief: craftBriefSchema,
    }],
    supportingCharacters: [{
      name: '仅旧项目展示兼容，不会自动写入正式角色',
      roleType: 'supporting',
      personalityCore: '性格核心',
      motivation: '具体动机',
      firstAppearChapter: 1,
    }],
  }),
  guided_foreshadow: JSON.stringify({
    foreshadowTracks: [{
      title: '伏笔标题',
      detail: '伏笔内容详细描述',
      scope: 'book/cross_volume/volume/cross_chapter/chapter',
      technique: '伏笔手法类型',
      plantChapter: '埋设时机',
      revealChapter: '揭开时机',
      involvedCharacters: '涉及角色',
      payoff: '揭开后的影响',
    }],
  }),
} as const;

export type GuidedStepSchemaKey = keyof typeof GUIDED_STEP_JSON_SCHEMAS;

export function getGuidedStepJsonSchema(stepKey: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(GUIDED_STEP_JSON_SCHEMAS, stepKey)
    ? GUIDED_STEP_JSON_SCHEMAS[stepKey as GuidedStepSchemaKey]
    : undefined;
}
