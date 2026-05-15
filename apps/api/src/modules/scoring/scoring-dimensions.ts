import { ScoringTargetType } from './scoring-contracts';

export type ScoringDimensionCategory =
  | 'structure'
  | 'character'
  | 'craft_brief'
  | 'draft'
  | 'continuity'
  | 'market'
  | 'target_specific';

export interface ScoringDimensionDefinition {
  key: string;
  label: string;
  category: ScoringDimensionCategory;
  description: string;
  appliesTo: ScoringTargetType[];
  criticalFor?: ScoringTargetType[];
}

const allTargets: ScoringTargetType[] = [
  'project_outline',
  'volume_outline',
  'chapter_outline',
  'chapter_craft_brief',
  'chapter_draft',
];

export const SCORING_DIMENSIONS: ScoringDimensionDefinition[] = [
  dimension('premise_strength', '核心设定强度', 'structure', '核心钩子、长期张力与可持续展开能力。', ['project_outline'], ['project_outline']),
  dimension('mainline_clarity', '主线清晰度', 'structure', '主角目标、主要阻力、阶段路径是否明确。', ['project_outline', 'volume_outline']),
  dimension('conflict_engine', '冲突引擎', 'structure', '冲突能否持续驱动长篇，而不是依赖偶发事件。', ['project_outline', 'volume_outline'], ['project_outline']),
  dimension('beat_execution', '叙事节拍执行', 'structure', '目标对象是否完成当前层级应有的叙事功能。', ['volume_outline', 'chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('scene_bridge', '场景/章节衔接', 'structure', '场景、章节、卷之间是否自然递进。', ['volume_outline', 'chapter_outline', 'chapter_craft_brief']),
  dimension('pacing_curve', '节奏曲线', 'structure', '信息、冲突、情绪、回报是否有起伏。', ['volume_outline', 'chapter_outline', 'chapter_draft']),
  dimension('payoff_design', '伏笔与回收设计', 'structure', '埋设、误导、触发、回收对象和计划是否清楚。', ['project_outline', 'volume_outline', 'chapter_outline']),
  dimension('chapter_hook', '章节钩子', 'market', '章节末是否形成继续阅读动力。', ['chapter_outline', 'chapter_craft_brief', 'chapter_draft']),

  dimension('character_motivation', '人物动机', 'character', '行动选择是否有可理解的动机和压力来源。', ['project_outline', 'volume_outline', 'chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('character_consistency', '人物一致性', 'character', '语言、行为、情绪反应是否符合已知人设和状态。', ['chapter_craft_brief', 'chapter_draft']),
  dimension('character_arc', '人物弧光', 'character', '人物变化是否有阶段、触发点和后果。', ['project_outline', 'volume_outline', 'chapter_draft']),
  dimension('relationship_tension', '关系张力', 'character', '人物关系是否产生推进、误解、试探、冲突或亲近。', ['volume_outline', 'chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('dialogue_distinctiveness', '对白区分度', 'character', '不同角色说话方式是否可区分。', ['chapter_draft']),
  dimension('character_balance', '角色平衡', 'character', '主要角色功能是否清楚，配角是否挤占或空转。', ['project_outline', 'volume_outline', 'chapter_draft']),

  dimension('scene_executability', '场景可执行性', 'craft_brief', '是否有地点、参与者、可见动作、阻力、转折、结果。', ['chapter_craft_brief'], ['chapter_craft_brief']),
  dimension('action_chain', '行动链', 'craft_brief', 'actionBeats 是否形成连续可写动作。', ['chapter_craft_brief'], ['chapter_craft_brief']),
  dimension('obstacle_result', '阻力与结果', 'craft_brief', '本章阻力如何出现，行动后造成什么状态变化。', ['chapter_craft_brief'], ['chapter_craft_brief']),
  dimension('entry_exit_state', '入场/离场状态', 'craft_brief', '人物和章节进入状态、离开状态是否清楚。', ['chapter_craft_brief']),
  dimension('continuity_handoff', '连续性递交', 'craft_brief', '能否接住前一章并把下一章自然递出去。', ['chapter_outline', 'chapter_craft_brief'], ['chapter_craft_brief']),
  dimension('information_design', '信息设计', 'craft_brief', '揭示、隐藏、误导、伏笔和回收对象是否明确。', ['chapter_outline', 'chapter_craft_brief']),
  dimension('drafting_clarity', '正文生成清晰度', 'craft_brief', '写作模型是否无需发明重大剧情即可开写。', ['chapter_craft_brief'], ['chapter_craft_brief']),
  dimension('sensory_anchor', '感官锚点', 'craft_brief', '场景是否有可落地的感官或物件锚点。', ['chapter_craft_brief', 'chapter_draft']),

  dimension('prose_quality', '语言质感', 'draft', '语言是否顺滑、准确、有节制。', ['chapter_draft']),
  dimension('sensory_detail', '感官描写', 'draft', '是否有具体感官和动作，而不是空泛概括。', ['chapter_draft']),
  dimension('rhetoric_control', '修辞控制', 'draft', '修辞是否服务人物和场景，是否堆砌。', ['chapter_draft']),
  dimension('atmosphere_fit', '氛围匹配', 'draft', '氛围是否与场景目标和人物状态一致。', ['chapter_draft']),
  dimension('immersion', '沉浸感', 'draft', '读者是否容易进入场景。', ['chapter_draft']),
  dimension('readability', '阅读流畅度', 'draft', '句段节奏、信息密度、理解成本是否适合连载阅读。', ['chapter_draft']),
  dimension('plan_adherence', '计划执行度', 'draft', '正文是否执行章节细纲和执行卡。', ['chapter_draft'], ['chapter_draft']),
  dimension('plot_progress', '剧情推进', 'draft', '正文是否造成新的事实、状态、关系或信息推进。', ['chapter_draft'], ['chapter_draft']),

  dimension('worldbuilding_integration', '世界观参与度', 'continuity', '世界观是否进入冲突和选择，而非背景摆设。', ['project_outline', 'volume_outline', 'chapter_draft']),
  dimension('canon_compliance', '设定一致性', 'continuity', '是否违背已知设定、规则、人物状态。', ['chapter_draft']),
  dimension('timeline_consistency', '时间线一致性', 'continuity', '时间、地点、人物行动顺序是否合理。', ['chapter_draft']),
  dimension('knowledge_boundary', '知情边界', 'continuity', '角色是否提前知道不该知道的信息。', ['chapter_draft']),
  dimension('foreshadowing_integrity', '伏笔完整性', 'continuity', '伏笔是否有对象、触发点、遮蔽方式和预期回收。', ['project_outline', 'volume_outline', 'chapter_outline', 'chapter_draft']),
  dimension('lore_integration', '设定融入', 'continuity', '设定是否通过行动、代价、物件和选择体现。', ['chapter_draft']),

  dimension('market_hook', '市场钩子', 'market', '卖点是否清楚，是否能吸引目标读者。', allTargets),
  dimension('pacing_density', '节奏密度', 'market', '单章推进和信息回报是否匹配平台阅读习惯。', ['chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('emotional_reward', '情绪回报', 'market', '是否给到目标读者期待的情绪回报。', ['volume_outline', 'chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('reader_retention', '追读动力', 'market', '是否制造下一章点击欲。', ['chapter_outline', 'chapter_craft_brief', 'chapter_draft']),
  dimension('genre_expectation_fit', '类型期待匹配', 'market', '是否满足对应类型和平台读者期待。', allTargets),
  dimension('platform_fit', '平台综合适配', 'market', '按当前项目内评分画像看是否适合继续投入生成。', allTargets),

  dimension('longform_sustainability', '长篇可持续性', 'target_specific', '核心冲突、人物成长、世界观扩展和伏笔系统是否支撑长篇。', ['project_outline'], ['project_outline']),
  dimension('theme_coherence', '主题一致性', 'target_specific', '主题是否通过人物选择、冲突后果和叙事结构表达。', ['project_outline', 'chapter_draft']),
  dimension('volume_goal', '卷目标', 'target_specific', '本卷开始要解决什么，结束要改变什么。', ['volume_outline'], ['volume_outline']),
  dimension('phase_conflict', '阶段冲突', 'target_specific', '本卷冲突是否有阶段推进，而不是重复同一压力。', ['volume_outline'], ['volume_outline']),
  dimension('midpoint_turn', '中段转折', 'target_specific', '中段是否出现改变局面的转折。', ['volume_outline']),
  dimension('climax_design', '卷末高潮', 'target_specific', '卷末高潮是否兑现本卷压力和读者期待。', ['volume_outline'], ['volume_outline']),
  dimension('chapter_goal', '章节目标', 'target_specific', '本章要推进什么剧情、人物、信息或关系变化。', ['chapter_outline'], ['chapter_outline']),
  dimension('conflict_pressure', '冲突压力', 'target_specific', '阻力是否具体，压力如何出现在页面中。', ['chapter_outline', 'chapter_craft_brief'], ['chapter_outline']),
];

export const DEFAULT_TARGET_DIMENSION_WEIGHTS: Record<ScoringTargetType, Record<string, number>> = {
  project_outline: {
    premise_strength: 14,
    mainline_clarity: 12,
    conflict_engine: 12,
    character_arc: 10,
    worldbuilding_integration: 10,
    payoff_design: 9,
    market_hook: 9,
    genre_expectation_fit: 8,
    platform_fit: 8,
    longform_sustainability: 8,
  },
  volume_outline: {
    volume_goal: 12,
    phase_conflict: 12,
    climax_design: 12,
    mainline_clarity: 10,
    beat_execution: 10,
    pacing_curve: 10,
    payoff_design: 8,
    emotional_reward: 8,
    genre_expectation_fit: 8,
    platform_fit: 10,
  },
  chapter_outline: {
    chapter_goal: 12,
    conflict_pressure: 12,
    beat_execution: 11,
    scene_bridge: 10,
    pacing_curve: 10,
    information_design: 10,
    continuity_handoff: 10,
    chapter_hook: 9,
    reader_retention: 8,
    platform_fit: 8,
  },
  chapter_craft_brief: {
    scene_executability: 14,
    action_chain: 13,
    obstacle_result: 12,
    entry_exit_state: 10,
    continuity_handoff: 10,
    information_design: 10,
    drafting_clarity: 11,
    sensory_anchor: 8,
    conflict_pressure: 6,
    chapter_hook: 6,
  },
  chapter_draft: {
    plan_adherence: 12,
    plot_progress: 11,
    character_consistency: 10,
    prose_quality: 10,
    sensory_detail: 8,
    pacing_curve: 8,
    chapter_hook: 8,
    reader_retention: 8,
    canon_compliance: 8,
    market_hook: 8,
    readability: 9,
  },
};

export function getDimensionDefinition(key: string): ScoringDimensionDefinition {
  const dimension = SCORING_DIMENSIONS.find((item) => item.key === key);
  if (!dimension) throw new Error(`Unknown scoring dimension: ${key}`);
  return dimension;
}

export function getTargetDimensionKeys(targetType: ScoringTargetType): string[] {
  return Object.keys(DEFAULT_TARGET_DIMENSION_WEIGHTS[targetType]);
}

export function getTargetDimensions(targetType: ScoringTargetType): ScoringDimensionDefinition[] {
  return getTargetDimensionKeys(targetType).map(getDimensionDefinition);
}

function dimension(
  key: string,
  label: string,
  category: ScoringDimensionCategory,
  description: string,
  appliesTo: ScoringTargetType[],
  criticalFor: ScoringTargetType[] = [],
): ScoringDimensionDefinition {
  return { key, label, category, description, appliesTo, criticalFor };
}
