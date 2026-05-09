import type { AgentContextV2 } from '../../agent-context-builder.service';
import type { RouteDecision } from '../planner-graph.state';

export type OutlineSupervisorIntent = 'volume_outline' | 'chapter_outline' | 'craft_brief' | 'scene_card';

export type OutlineRouteDecision = RouteDecision & {
  domain: 'outline';
  outlineIntent: OutlineSupervisorIntent;
};

export interface OutlineSupervisorInput {
  goal: string;
  context?: AgentContextV2;
}

export class OutlineSupervisor {
  classify(input: OutlineSupervisorInput): OutlineRouteDecision {
    const goal = input.goal.trim();
    const normalized = normalizeGoal(goal);
    const volumeNo = extractNumberBefore(goal, /[卷卷部]/);
    const chapterNo = extractNumberBefore(goal, /[章章节]/);

    if (includesAny(normalized, ['推进卡', '执行卡', 'craftbrief', 'craft brief', '行动链'])) {
      return route('craft_brief', 'chapter_craft_brief', 0.88, ['目标是章节推进卡或 Chapter.craftBrief。'], { chapterNo, needsApproval: true, needsPersistence: true });
    }

    if (includesAny(normalized, ['场景卡', 'scenecard', 'scene card', '拆成场景'])) {
      return route('scene_card', 'scene_card_planning', 0.86, ['目标是场景卡规划或更新。'], { chapterNo, needsApproval: true, needsPersistence: true });
    }

    if (isChapterOutlineGoal(normalized)) {
      return route('chapter_outline', 'split_volume_to_chapters', 0.9, ['目标明确要求章节细纲、卷细纲或拆分成多章。'], { volumeNo, needsApproval: true, needsPersistence: true });
    }

    if (isVolumeOutlineGoal(normalized)) {
      return route('volume_outline', 'generate_volume_outline', 0.9, ['目标只要求卷级大纲，没有要求章节细纲或正文。'], { volumeNo, needsApproval: true, needsPersistence: true });
    }

    return {
      domain: 'outline',
      intent: 'outline_clarify',
      outlineIntent: 'volume_outline',
      confidence: 0.35,
      reasons: ['目标不足以安全判断 outline 子意图。'],
      ambiguity: {
        needsClarification: true,
        questions: ['请说明要生成卷级大纲、章节细纲、Chapter.craftBrief 还是场景卡。'],
      },
    };
  }
}

export const outlineSupervisor = new OutlineSupervisor();

export function classifyOutlineIntent(input: OutlineSupervisorInput): OutlineRouteDecision {
  return outlineSupervisor.classify(input);
}

function route(
  outlineIntent: OutlineSupervisorIntent,
  intent: string,
  confidence: number,
  reasons: string[],
  extra: Partial<Omit<OutlineRouteDecision, 'domain' | 'intent' | 'outlineIntent' | 'confidence' | 'reasons'>> = {},
): OutlineRouteDecision {
  return { domain: 'outline', intent, outlineIntent, confidence, reasons, ...extra };
}

function normalizeGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, ' ');
}

function includesAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function isChapterOutlineGoal(goal: string): boolean {
  if (hasNegatedChapterOutlineGoal(goal)) return false;
  return includesAny(goal, ['章节细纲', '卷细纲', '章节规划', '等长细纲', '拆成'])
    || /[0-9０-９一二三四五六七八九十百]+ ?章/.test(goal) && includesAny(goal, ['细纲', '大纲', '规划']);
}

function hasNegatedChapterOutlineGoal(goal: string): boolean {
  return includesAny(goal, ['不生成章节细纲', '不要生成章节细纲', '不需要章节细纲', '无需章节细纲', '不用章节细纲', '不要章节细纲', '不拆成章节']);
}

function isVolumeOutlineGoal(goal: string): boolean {
  return includesAny(goal, ['卷大纲', '第1卷大纲', '第一卷大纲', '第 1 卷大纲'])
    || includesAny(goal, ['大纲', 'outline']) && includesAny(goal, ['卷', 'volume']) && !isChapterOutlineGoal(goal) && !isWritingGoal(goal);
}

function isWritingGoal(goal: string): boolean {
  return includesAny(goal, ['写正文', '生成正文', '续写正文', '写第', '帮我写', '继续写下一章']);
}

function extractNumberBefore(goal: string, suffix: RegExp): number | undefined {
  const match = goal.match(new RegExp(`([0-9０-９一二三四五六七八九十百]+)\\s*${suffix.source}`));
  if (!match) return undefined;
  return parsePositiveInt(match[1]);
}

function parsePositiveInt(value: string): number | undefined {
  const normalizedDigits = value.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 65296));
  const numeric = Number(normalizedDigits);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    const tensValue = tens ? chinese[tens] : 1;
    const onesValue = ones ? chinese[ones] : 0;
    if (tensValue && onesValue !== undefined) return tensValue * 10 + onesValue;
  }
  return chinese[value];
}
