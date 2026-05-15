import { DEFAULT_TARGET_DIMENSION_WEIGHTS, getTargetDimensionKeys } from './scoring-dimensions';
import { PlatformProfileKey, ScoringTargetType } from './scoring-contracts';

export interface PlatformScoringProfile {
  key: PlatformProfileKey;
  name: string;
  version: string;
  description: string;
  disclaimer: string;
  emphasis: string[];
  weightMultipliers: Record<string, number>;
}

export const PLATFORM_SCORING_PROFILES: Record<PlatformProfileKey, PlatformScoringProfile> = {
  generic_longform: {
    key: 'generic_longform',
    name: '通用长篇',
    version: 'profile.generic_longform.v1',
    description: '项目内评分画像：均衡关注长篇结构、人物、连续性和可写性。',
    disclaimer: '这是项目内评分画像，不代表任何平台官方标准。',
    emphasis: ['长线主线', '人物弧光', '连续性', '可写性'],
    weightMultipliers: {},
  },
  qidian_like: {
    key: 'qidian_like',
    name: '起点向',
    version: 'profile.qidian_like.v1',
    description: '项目内评分画像：偏重长线主线、升级成长、规则压力、卷末爆点和追读。',
    disclaimer: '这是项目内评分画像，不代表起点或任何平台官方标准。',
    emphasis: ['长线主线', '冲突引擎', '升级成长', '卷末高潮', '追读动力'],
    weightMultipliers: {
      mainline_clarity: 1.12,
      conflict_engine: 1.14,
      longform_sustainability: 1.15,
      phase_conflict: 1.12,
      climax_design: 1.12,
      plot_progress: 1.1,
      reader_retention: 1.1,
      market_hook: 1.08,
    },
  },
  fanqie_like: {
    key: 'fanqie_like',
    name: '番茄向',
    version: 'profile.fanqie_like.v1',
    description: '项目内评分画像：偏重开篇抓力、爽点密度、情绪回报、单章推进和阅读流畅。',
    disclaimer: '这是项目内评分画像，不代表番茄或任何平台官方标准。',
    emphasis: ['情绪回报', '单章推进', '阅读流畅', '章节钩子'],
    weightMultipliers: {
      emotional_reward: 1.18,
      pacing_density: 1.14,
      chapter_hook: 1.14,
      reader_retention: 1.15,
      readability: 1.1,
      plot_progress: 1.1,
      prose_quality: 0.95,
      theme_coherence: 0.9,
    },
  },
  jinjiang_like: {
    key: 'jinjiang_like',
    name: '晋江向',
    version: 'profile.jinjiang_like.v1',
    description: '项目内评分画像：偏重人物关系、情绪递进、对话张力、角色弧光和关系变化。',
    disclaimer: '这是项目内评分画像，不代表晋江或任何平台官方标准。',
    emphasis: ['人物关系', '情绪递进', '对话张力', '角色弧光'],
    weightMultipliers: {
      character_motivation: 1.14,
      character_consistency: 1.16,
      character_arc: 1.15,
      relationship_tension: 1.18,
      dialogue_distinctiveness: 1.12,
      emotional_reward: 1.1,
      market_hook: 0.92,
      conflict_engine: 0.94,
    },
  },
  published_literary: {
    key: 'published_literary',
    name: '出版文学向',
    version: 'profile.published_literary.v1',
    description: '项目内评分画像：偏重主题表达、语言质感、人物复杂度、结构完整和叙事节制。',
    disclaimer: '这是项目内评分画像，不代表出版社或奖项官方标准。',
    emphasis: ['主题表达', '语言质感', '结构完整', '叙事节制'],
    weightMultipliers: {
      theme_coherence: 1.18,
      prose_quality: 1.16,
      rhetoric_control: 1.12,
      atmosphere_fit: 1.1,
      character_arc: 1.12,
      readability: 1.08,
      pacing_density: 0.9,
      emotional_reward: 0.94,
      market_hook: 0.88,
    },
  },
};

export interface ScoringRubricDimension {
  key: string;
  weight: number;
}

export function getPlatformProfile(profileKey: PlatformProfileKey): PlatformScoringProfile {
  return PLATFORM_SCORING_PROFILES[profileKey];
}

export function getProfileDimensionWeights(targetType: ScoringTargetType, profileKey: PlatformProfileKey): Record<string, number> {
  const baseWeights = DEFAULT_TARGET_DIMENSION_WEIGHTS[targetType];
  const profile = getPlatformProfile(profileKey);
  const keys = getTargetDimensionKeys(targetType);
  const rawWeights = keys.map((key) => ({
    key,
    weight: baseWeights[key] * (profile.weightMultipliers[key] ?? 1),
  }));
  const rawTotal = rawWeights.reduce((sum, item) => sum + item.weight, 0);
  if (rawTotal <= 0) throw new Error(`Invalid scoring weights for ${targetType}/${profileKey}.`);

  const rounded = rawWeights.map((item) => ({
    key: item.key,
    weight: Number(((item.weight / rawTotal) * 100).toFixed(2)),
  }));
  const roundedTotal = rounded.reduce((sum, item) => sum + item.weight, 0);
  const delta = Number((100 - roundedTotal).toFixed(2));
  if (rounded.length) {
    rounded[rounded.length - 1] = {
      ...rounded[rounded.length - 1],
      weight: Number((rounded[rounded.length - 1].weight + delta).toFixed(2)),
    };
  }

  return Object.fromEntries(rounded.map((item) => [item.key, item.weight]));
}

export function assertPlatformProfileCoversTarget(targetType: ScoringTargetType, profileKey: PlatformProfileKey): Record<string, number> {
  const weights = getProfileDimensionWeights(targetType, profileKey);
  const keys = getTargetDimensionKeys(targetType);
  const missing = keys.filter((key) => typeof weights[key] !== 'number' || !Number.isFinite(weights[key]) || weights[key] <= 0);
  if (missing.length) throw new Error(`Platform profile ${profileKey} missing weights for ${targetType}: ${missing.join(', ')}`);
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 100) > 0.01) throw new Error(`Platform profile ${profileKey} weights for ${targetType} must sum to 100.`);
  return weights;
}
