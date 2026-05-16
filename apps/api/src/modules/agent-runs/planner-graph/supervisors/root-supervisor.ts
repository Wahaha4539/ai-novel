import type { AgentContextV2 } from '../../agent-context-builder.service';
import type { AgentPlannerDomain, RouteDecision } from '../planner-graph.state';

export interface RootSupervisorInput {
  goal: string;
  context?: AgentContextV2;
}

const ROUTE_DOMAINS: AgentPlannerDomain[] = [
  'outline',
  'writing',
  'revision',
  'worldbuilding',
  'timeline',
  'import',
  'quality',
  'guided',
  'project_ops',
  'general',
];

export class RootSupervisor {
  classify(input: RootSupervisorInput): RouteDecision {
    return validateRouteDecision(this.classifyUnsafe(input));
  }

  private classifyUnsafe(input: RootSupervisorInput): RouteDecision {
    const goal = input.goal.trim();
    const normalized = normalizeGoal(goal);
    const volumeNo = extractNumberBefore(goal, /[卷卷部]/);
    const chapterNo = extractNumberBefore(goal, /[章章节]/);

    if (input.context?.session.guided?.currentStep) {
      return route('guided', guidedIntent(normalized), 0.94, ['当前上下文包含 guided.currentStep，应保持在创作引导流程内。'], { needsApproval: includesAny(normalized, ['保存', '确认', '写入', 'finalize']) });
    }

    if (includesAny(normalized, ['导入', '文档', '上传', '拆成角色', 'targeted import', 'import preview']) || input.context?.session.requestedAssetTypes?.length || input.context?.session.importPreviewMode) {
      return route('import', 'project_import_preview', 0.9, ['目标涉及导入文档或结构化导入产物。'], { needsApproval: true });
    }

    if (includesAny(normalized, ['时间线', 'timeline', 'storyevent'])) {
      const needsPersistence = includesAny(normalized, ['保存', '写入', '确认后再写入', '持久化']);
      return route('timeline', 'timeline_plan', 0.88, ['目标涉及时间线候选、校验或确认。'], { chapterNo, needsApproval: needsPersistence, needsPersistence });
    }

    if (isEditorPassageEntry(input.context)) {
      const wholeChapterIntent = isExplicitWholeChapterPassageOverride(normalized);
      if (hasCompletePassageSelection(input.context)) {
        if (wholeChapterIntent) {
          return route(
            'revision',
            includesAny(normalized, ['重写', '不沿用旧稿', '推倒重来', 'rewrite']) ? 'chapter_rewrite' : 'chapter_revision',
            0.93,
            ['当前上下文来自 editor_passage_agent，但用户显式要求整章修改，应转到整章修订链路。'],
            { chapterNo, needsApproval: true, needsPersistence: true },
          );
        }
        return route(
          'revision',
          'chapter_passage_revision',
          0.95,
          ['当前上下文来自 editor_passage_agent，且包含完整选区、draftId 与 selectedText，应优先走局部选区修订链路。'],
          { chapterNo, needsApproval: true, needsPersistence: true },
        );
      }
      return route(
        'revision',
        wholeChapterIntent && includesAny(normalized, ['重写', '不沿用旧稿', '推倒重来', 'rewrite']) ? 'chapter_rewrite' : 'chapter_revision',
        0.78,
        ['当前入口来自 editor_passage_agent，但缺少完整选区上下文，不能使用局部 passage 工具链。'],
        { chapterNo, needsApproval: true, needsPersistence: true },
      );
    }

    if (isOutlineGoal(normalized)) {
      return route('outline', 'outline', 0.9, ['目标属于 outline 领域，交由 OutlineSupervisor 判断子意图。'], { volumeNo, needsApproval: true, needsPersistence: true });
    }

    if (includesAny(normalized, ['世界观', 'story bible', '设定', '宗门', '灵脉', '规则体系'])) {
      return route('worldbuilding', includesAny(normalized, ['story bible']) ? 'story_bible_expand' : 'worldbuilding_expand', 0.82, ['目标涉及世界观或 Story Bible 设定扩展。'], { needsApproval: true, needsPersistence: true });
    }

    if (includesAny(normalized, ['检查', '审稿', '一致性', '矛盾', '人设崩', '前后矛盾', '质量'])) {
      return route('quality', qualityIntent(normalized), 0.84, ['目标是检查、审稿或连续性验证。'], { chapterNo, needsApproval: includesAny(normalized, ['修复', '写入', '保存']) });
    }

    if (includesAny(normalized, ['重写', '润色', '修改', '改一下', '去ai味', '去 ai 味', '修文'])) {
      return route('revision', includesAny(normalized, ['重写', '不沿用旧稿', '推倒重来']) ? 'chapter_rewrite' : 'chapter_revision', 0.82, ['目标是对已有章节或文本进行修改。'], { chapterNo, needsApproval: true, needsPersistence: true });
    }

    if (isWritingGoal(normalized)) {
      return route('writing', includesAny(normalized, ['连续', '多章', '接下来']) ? 'multi_chapter_write' : 'chapter_write', 0.82, ['目标明确要求章节正文写作。'], { chapterNo, needsApproval: true, needsPersistence: true });
    }

    return {
      domain: 'general',
      intent: 'clarify',
      confidence: 0.35,
      reasons: ['目标不足以安全判断具体创作任务。'],
      ambiguity: {
        needsClarification: true,
        questions: ['请说明要处理的是大纲、正文、修改、导入、时间线还是检查类任务。'],
      },
    };
  }
}

export const rootSupervisor = new RootSupervisor();

export function classifyIntent(input: RootSupervisorInput): RouteDecision {
  return rootSupervisor.classify(input);
}

export function validateRouteDecision(value: RouteDecision): RouteDecision {
  if (!ROUTE_DOMAINS.includes(value.domain)) throw new Error(`RouteDecision domain 非法：${String(value.domain)}`);
  if (typeof value.intent !== 'string' || !value.intent.trim()) throw new Error('RouteDecision intent 必须是非空字符串');
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new Error('RouteDecision confidence 必须在 0 到 1 之间');
  if (!Array.isArray(value.reasons) || !value.reasons.every((item) => typeof item === 'string' && item.trim())) throw new Error('RouteDecision reasons 必须是非空字符串数组');
  if (value.ambiguity) {
    if (typeof value.ambiguity.needsClarification !== 'boolean') throw new Error('RouteDecision ambiguity.needsClarification 必须是 boolean');
    if (!Array.isArray(value.ambiguity.questions) || !value.ambiguity.questions.every((item) => typeof item === 'string' && item.trim())) throw new Error('RouteDecision ambiguity.questions 必须是非空字符串数组');
  }
  return value;
}

function route(
  domain: AgentPlannerDomain,
  intent: string,
  confidence: number,
  reasons: string[],
  extra: Partial<Omit<RouteDecision, 'domain' | 'intent' | 'confidence' | 'reasons'>> = {},
): RouteDecision {
  return { domain, intent, confidence, reasons, ...extra };
}

function normalizeGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, ' ');
}

function isEditorPassageEntry(context?: RootSupervisorInput['context']): boolean {
  return context?.session.sourcePage === 'editor_passage_agent'
    && context.session.selectionIntent === 'chapter_passage_revision';
}

function hasCompletePassageSelection(context?: RootSupervisorInput['context']): boolean {
  const session = context?.session;
  if (!session) return false;
  const selectedText = typeof session.selectedText === 'string' ? session.selectedText.trim() : '';
  const draftId = typeof session.currentDraftId === 'string' ? session.currentDraftId.trim() : '';
  const draftVersion = typeof session.currentDraftVersion === 'number' && Number.isInteger(session.currentDraftVersion) && session.currentDraftVersion > 0;
  const range = session.selectedRange;
  const hasRange = !!range
    && Number.isInteger(range.start)
    && Number.isInteger(range.end)
    && range.end > range.start;
  return Boolean(selectedText && draftId && draftVersion && hasRange);
}

function isExplicitWholeChapterPassageOverride(goal: string): boolean {
  return includesAny(goal, ['整章', '全章', '整个章节', '全文', '整篇'])
    && includesAny(goal, ['润色', '重写', '修改', '改写', '修文', 'polish', 'rewrite']);
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
    || includesAny(goal, ['大纲']) && includesAny(goal, ['卷']) && !isChapterOutlineGoal(goal) && !isWritingGoal(goal);
}

function isOutlineGoal(goal: string): boolean {
  return includesAny(goal, ['推进卡', '执行卡', 'craftbrief', 'craft brief', '行动链', '场景卡', 'scenecard', 'scene card', '拆成场景', '单元故事', '故事单元', '支线故事', '人物登场', '人物情感', '人物刻画', '背景故事', '单元分类'])
    || isRoleExpansionGoal(goal)
    || isChapterOutlineGoal(goal)
    || isVolumeOutlineGoal(goal);
}

function isRoleExpansionGoal(goal: string): boolean {
  if (includesAny(goal, ['检查', '审稿', '一致性', '人设崩', '质量'])) return false;
  return includesAny(goal, [
    '增加角色',
    '新增角色',
    '添加角色',
    '补充角色',
    '扩充角色',
    '扩展角色',
    '丰富角色',
    '加角色',
    '增加人物',
    '新增人物',
    '添加人物',
    '补充人物',
    '扩充人物',
    '扩展人物',
    '丰富人物',
    '加人物',
    '角色太少',
    '人物太少',
    '角色不够',
    '人物不够',
    '缺角色',
    '缺人物',
    '角色撑不起',
    '人物撑不起',
    '撑不起整本书',
    '撑不起全书',
    '撑不起长篇',
    '扩充角色阵容',
    '丰富角色阵容',
    '补充角色阵容',
    '扩充人物阵容',
    '丰富人物阵容',
    '补充人物阵容',
  ]) || (includesAny(goal, ['角色', '人物']) && includesAny(goal, ['增加', '新增', '添加', '补充', '扩充', '扩展']));
}

function isWritingGoal(goal: string): boolean {
  return includesAny(goal, ['写正文', '生成正文', '续写正文', '写第', '帮我写', '继续写下一章']);
}

function guidedIntent(goal: string): string {
  if (includesAny(goal, ['保存', '确认', '写入', 'finalize'])) return 'guided_step_finalize';
  if (includesAny(goal, ['生成', '产出', '预览'])) return 'guided_step_generate';
  return 'guided_step_consultation';
}

function qualityIntent(goal: string): string {
  if (includesAny(goal, ['人设', '角色'])) return 'character_consistency_check';
  if (includesAny(goal, ['审稿', '质量'])) return 'ai_quality_review';
  if (includesAny(goal, ['关系线', '时间线', '前后矛盾'])) return 'continuity_check';
  return 'plot_consistency_check';
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
