import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { RelationshipGraphEdge, RelationshipGraphService } from '../relationship-graph.service';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface CollectTaskContextInput {
  projectId?: string;
  taskType?: string;
  chapterId?: string;
  characterId?: string;
  entityRefs?: {
    chapterId?: string;
    characterId?: string;
    chapterRange?: string;
    worldSettingRef?: string;
    locationRef?: string;
    query?: string;
    includeFullDrafts?: boolean;
    maxFullDraftChars?: number;
  };
  focus?: string[];
}

interface CollectTaskContextOutput {
  projectDigest: Record<string, unknown>;
  chapters: Array<Record<string, unknown>>;
  characters: Array<Record<string, unknown>>;
  worldFacts: Array<Record<string, unknown>>;
  memoryChunks: Array<Record<string, unknown>>;
  relationshipGraph: RelationshipGraphEdge[];
  plotEvents: Array<Record<string, unknown>>;
  constraints: string[];
  diagnostics: {
    retrievalMode: 'deterministic_compact';
    taskType: string;
    focus: string[];
    missingContext: string[];
    chapterRange?: string;
    worldFactKeywords?: string[];
    retrievalDimensions: string[];
    fullDraftIncluded: boolean;
    fullDraftMaxChars?: number;
  };
}

/**
 * 通用任务上下文收集工具：为角色一致性、世界观扩展、剧情检查等非纯章节写作任务提供压缩上下文。
 * 输入可以包含已解析的 chapterId/characterId；工具只读项目内数据，不猜测自然语言实体，也不产生业务写入。
 */
@Injectable()
export class CollectTaskContextTool implements BaseTool<CollectTaskContextInput, CollectTaskContextOutput> {
  name = 'collect_task_context';
  description = '按任务类型收集项目、章节、角色、世界事实、记忆和校验问题等通用上下文。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' as const, minLength: 1 },
      taskType: { type: 'string' as const, minLength: 1 },
      chapterId: { type: 'string' as const, minLength: 1 },
      characterId: { type: 'string' as const, minLength: 1 },
      entityRefs: { type: 'object' as const },
      focus: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['projectDigest', 'chapters', 'characters', 'worldFacts', 'memoryChunks', 'relationshipGraph', 'plotEvents', 'constraints', 'diagnostics'],
    properties: {
      projectDigest: { type: 'object' as const },
      chapters: { type: 'array' as const },
      characters: { type: 'array' as const },
      worldFacts: { type: 'array' as const },
      memoryChunks: { type: 'array' as const },
      relationshipGraph: { type: 'array' as const },
      plotEvents: { type: 'array' as const },
      constraints: { type: 'array' as const },
      diagnostics: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '收集任务上下文',
    description: '根据 taskType 和已解析实体收集章节写作、角色一致性、世界观扩展、剧情检查等任务所需上下文。',
    whenToUse: ['需要在专用检查/预览工具前读取项目与事实上下文', '任务不是单纯章节写作，collect_chapter_context 覆盖不足', '需要围绕 characterId、chapterId 或世界事实做只读分析'],
    whenNotToUse: ['只需要解析章节或角色 ID 时，应先使用 resolver', '要读取完整章节正文时，应由后续专用工具按需拉取 Cold Context'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      taskType: { source: 'user_message', description: 'Planner 语义判断出的任务类型，例如 character_consistency_check、worldbuilding_expand。' },
      chapterId: { source: 'resolver', resolverTool: 'resolve_chapter', description: '真实章节 ID；自然语言章节引用必须先 resolve_chapter。' },
      characterId: { source: 'resolver', resolverTool: 'resolve_character', description: '真实角色 ID；“男主/小林”等引用必须先 resolve_character。' },
      focus: { source: 'literal', description: '本次检索关注点，例如 character_arc、plot_facts、locked_world_facts、relationship_graph、full_draft。' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['projectId', 'chapterId', 'characterId'], allowedSources: ['context.session.currentProjectId', 'context.session.currentChapterId', 'resolve_chapter.output.chapterId', 'resolve_character.output.characterId', 'steps.resolve_chapter.output.chapterId', 'steps.resolve_character.output.characterId'] },
  };

  constructor(private readonly prisma: PrismaService, private readonly relationshipGraphService: RelationshipGraphService = new RelationshipGraphService()) {}

  async run(args: CollectTaskContextInput, context: ToolContext): Promise<CollectTaskContextOutput> {
    const projectId = args.projectId ?? context.projectId;
    if (projectId !== context.projectId) throw new BadRequestException('collect_task_context 只能读取当前 AgentRun 所属项目');

    const taskType = args.taskType?.trim() || 'general';
    const focus = this.stringArray(args.focus);
    const entityRefs = this.asRecord(args.entityRefs);
    const chapterId = args.chapterId ?? this.stringValue(entityRefs.chapterId) ?? context.chapterId;
    const characterId = args.characterId ?? this.stringValue(entityRefs.characterId);
    const chapterRange = this.stringValue(entityRefs.chapterRange);
    const fullDraftRequested = focus.includes('full_draft') || this.booleanValue(entityRefs.includeFullDrafts);
    // 完整草稿属于 Cold Context：仅对明确需要正文证据的任务开放，并在输出阶段做长度裁剪，避免检查类工具无界消耗 Prompt 成本。
    const includeFullDrafts = fullDraftRequested && this.isFullDraftAllowed(taskType);
    const maxFullDraftChars = this.resolveFullDraftMaxChars(entityRefs.maxFullDraftChars);
    const worldFactKeywords = this.buildWorldFactKeywords(taskType, focus, entityRefs);

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`项目不存在：${projectId}`);

    const [chapters, characters, worldFacts, memoryChunks, validationIssues, characterStates, storyEvents] = await Promise.all([
      this.loadChapters(projectId, chapterId, chapterRange, includeFullDrafts),
      this.loadCharacters(projectId, characterId),
      this.loadWorldFacts(projectId, taskType, focus, worldFactKeywords),
      this.prisma.memoryChunk.findMany({ where: { projectId }, orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }], take: 16 }),
      this.prisma.validationIssue.findMany({ where: { projectId, ...(chapterId ? { chapterId } : {}), status: 'open' }, take: 20 }),
      characterId ? this.prisma.characterStateSnapshot.findMany({ where: { projectId, characterId }, orderBy: [{ chapterNo: 'desc' }, { createdAt: 'desc' }], take: 20 }) : Promise.resolve([]),
      this.loadStoryEvents(projectId, chapterId, chapterRange),
    ]);

    const missingContext = this.collectMissingContext(taskType, { chapterId, characterId, chapterCount: chapters.length, characterCount: characters.length });
    if (fullDraftRequested && !includeFullDrafts) missingContext.push('full_draft_blocked_by_task_type');
    const constraints = this.buildConstraints(taskType, focus, worldFacts.filter((fact) => fact.status === 'locked').length);

    return {
      projectDigest: { id: project.id, title: project.title, genre: project.genre, theme: project.theme, tone: project.tone, synopsis: project.synopsis, outline: project.outline, targetWordCount: project.targetWordCount, status: project.status },
      chapters: chapters.map((chapter) => {
        const latestDraftContent = chapter.drafts?.[0]?.content ?? null;
        return {
          id: chapter.id,
          chapterNo: chapter.chapterNo,
          title: chapter.title,
          status: chapter.status,
          objective: chapter.objective,
          conflict: chapter.conflict,
          outline: chapter.outline,
          latestDraftExcerpt: latestDraftContent?.slice(0, 1200) ?? null,
          ...(includeFullDrafts ? { latestDraftContent: this.compactText(latestDraftContent, maxFullDraftChars) } : {}),
        };
      }),
      characters: characters.map((character) => ({ id: character.id, name: character.name, aliases: this.stringArray(character.alias), roleType: character.roleType, personalityCore: character.personalityCore, motivation: character.motivation, speechStyle: character.speechStyle, recentStates: characterStates.filter((state) => state.characterId === character.id || state.characterName === character.name).map((state) => ({ chapterNo: state.chapterNo, stateType: state.stateType, stateValue: state.stateValue, summary: state.summary })).slice(0, 8) })),
      worldFacts: worldFacts.map((fact) => ({ id: fact.id, title: fact.title, entryType: fact.entryType, entityType: this.mapWorldFactEntityType(fact), summary: fact.summary, content: this.compactText(fact.content, 1200), locked: fact.status === 'locked', matchedKeywords: this.matchWorldFactKeywords(fact, worldFactKeywords) })),
      memoryChunks: memoryChunks.map((chunk) => ({ id: chunk.id, sourceType: chunk.sourceType, sourceId: chunk.sourceId, memoryType: chunk.memoryType, summary: chunk.summary, content: chunk.content.slice(0, 900), importanceScore: chunk.importanceScore, recencyScore: chunk.recencyScore })),
      relationshipGraph: this.relationshipGraphService.buildGraph(characters, storyEvents, characterStates),
      plotEvents: storyEvents.map((event) => ({ id: event.id, chapterNo: event.chapterNo, title: event.title, eventType: event.eventType, description: this.compactText(event.description, 260), participants: this.relationshipGraphService.extractParticipantNames(event.participants), status: event.status })),
      constraints: [...constraints, ...validationIssues.map((issue) => `未关闭校验问题(${issue.severity}/${issue.issueType})：${issue.message}`)],
      diagnostics: { retrievalMode: 'deterministic_compact', taskType, focus, missingContext, retrievalDimensions: this.buildRetrievalDimensions(focus, includeFullDrafts), fullDraftIncluded: includeFullDrafts, ...(includeFullDrafts ? { fullDraftMaxChars: maxFullDraftChars } : {}), ...(chapterRange ? { chapterRange } : {}), ...(worldFactKeywords.length ? { worldFactKeywords } : {}) },
    };
  }

  /** 章节上下文默认只取压缩摘录；只有显式 focus=full_draft 时才返回完整当前草稿，控制 Prompt 成本。 */
  private async loadChapters(projectId: string, chapterId?: string, chapterRange?: string, includeFullDrafts = false) {
    const range = this.parseChapterRange(chapterRange);
    // 只加载当前草稿的最新版本；是否暴露完整正文由 run() 输出阶段控制，避免重复查询多版草稿。
    const draftTake = 1;
    if (range?.mode === 'first') {
      return this.prisma.chapter.findMany({
        where: { projectId, chapterNo: { lte: range.count } },
        orderBy: { chapterNo: 'asc' },
        take: range.count,
        include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: draftTake } },
      });
    }

    if (range?.mode === 'recent') {
      return this.prisma.chapter.findMany({
        where: { projectId },
        orderBy: { chapterNo: 'desc' },
        take: range.count,
        include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: draftTake } },
      });
    }

    return this.prisma.chapter.findMany({
      where: { projectId, ...(chapterId ? { id: chapterId } : {}) },
      orderBy: { chapterNo: chapterId ? 'asc' : 'desc' },
      take: chapterId ? 1 : 12,
      include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: draftTake } },
    });
  }

  /** 剧情事件用于构建关系图和剧情一致性证据；按同一章节范围裁剪，避免一次性读取全书事件。 */
  private async loadStoryEvents(projectId: string, chapterId?: string, chapterRange?: string) {
    const range = this.parseChapterRange(chapterRange);
    if (range?.mode === 'first') return this.prisma.storyEvent.findMany({ where: { projectId, chapterNo: { lte: range.count } }, orderBy: [{ chapterNo: 'asc' }, { createdAt: 'asc' }], take: Math.min(60, range.count * 6) });
    if (range?.mode === 'recent') return this.prisma.storyEvent.findMany({ where: { projectId }, orderBy: [{ chapterNo: 'desc' }, { createdAt: 'desc' }], take: Math.min(60, range.count * 6) });
    return this.prisma.storyEvent.findMany({ where: { projectId, ...(chapterId ? { chapterId } : {}) }, orderBy: [{ chapterNo: 'desc' }, { createdAt: 'desc' }], take: chapterId ? 20 : 40 });
  }

  /** 保守解析常见章节范围表达；复杂模糊范围仍交给 Planner/Resolver 要求用户澄清。 */
  private parseChapterRange(chapterRange?: string): { mode: 'first' | 'recent'; count: number } | undefined {
    const text = chapterRange?.trim();
    if (!text) return undefined;
    const count = this.parseChineseNumber(text) ?? Number(text.match(/\d+/)?.[0]);
    const safeCount = Math.min(30, Math.max(1, Number(count) || 0));
    if (!safeCount) return undefined;
    if (/前|开头|起始/.test(text)) return { mode: 'first', count: safeCount };
    if (/最近|近|末|最后/.test(text)) return { mode: 'recent', count: safeCount };
    return undefined;
  }

  /** 只覆盖常见中文数字，避免引入重量级解析器；无法识别时回退阿拉伯数字。 */
  private parseChineseNumber(text: string): number | undefined {
    const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const match = text.match(/[一二两三四五六七八九十]+/);
    if (!match) return undefined;
    const raw = match[0];
    if (raw === '十') return 10;
    if (raw.startsWith('十')) return 10 + (digits[raw[1]] ?? 0);
    if (raw.includes('十')) {
      const [tens, ones] = raw.split('十');
      return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0);
    }
    return digits[raw];
  }

  private async loadCharacters(projectId: string, characterId?: string) {
    return this.prisma.character.findMany({ where: { projectId, ...(characterId ? { id: characterId } : {}) }, orderBy: { createdAt: 'asc' }, take: characterId ? 1 : 30 });
  }

  /** 世界观扩展需要相关实体优先：先多取候选，再按 focus/自然语言引用做轻量排序，避免数据库层复杂模糊查询。 */
  private async loadWorldFacts(projectId: string, taskType: string, focus: string[], keywords: string[]) {
    const take = taskType === 'worldbuilding_expand' || keywords.length ? 60 : 30;
    const facts = await this.prisma.lorebookEntry.findMany({ where: { projectId, status: { in: ['active', 'locked'] } }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take });
    if (!keywords.length) return facts.slice(0, 30);
    return facts
      .map((fact) => ({ fact, score: this.scoreWorldFact(fact, keywords, focus) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((item) => item.fact);
  }

  private buildWorldFactKeywords(taskType: string, focus: string[], entityRefs: Record<string, unknown>) {
    const explicit = [entityRefs.worldSettingRef, entityRefs.locationRef, entityRefs.query].map((item) => this.stringValue(item)).filter((item): item is string => Boolean(item));
    const focusKeywords = focus.flatMap((item) => item.split(/[_\s-]+/)).filter((item) => item.length >= 2);
    if (taskType === 'worldbuilding_expand') return [...new Set([...explicit, ...focusKeywords, '世界观', '设定'])];
    return [...new Set([...explicit, ...focusKeywords])];
  }

  private scoreWorldFact(fact: { title?: string | null; entryType?: string | null; summary?: string | null; content?: string | null; status?: string | null }, keywords: string[], focus: string[]) {
    const haystack = `${fact.title ?? ''}\n${fact.entryType ?? ''}\n${fact.summary ?? ''}\n${fact.content ?? ''}`.toLowerCase();
    const keywordScore = keywords.reduce((score, keyword) => score + (haystack.includes(keyword.toLowerCase()) ? 5 : 0), 0);
    const lockedScore = fact.status === 'locked' && focus.includes('locked_world_facts') ? 3 : 0;
    return keywordScore + lockedScore;
  }

  private buildConstraints(taskType: string, focus: string[], lockedFactCount: number) {
    const constraints = ['不得编造内部 ID；自然语言实体必须来自 resolver 输出或上下文明确字段。'];
    if (taskType === 'character_consistency_check' || focus.includes('character_arc')) constraints.push('角色一致性检查必须以角色基线、近期状态和文本证据为依据，区分“轻微偏差”和“真正人设崩坏”。');
    if (taskType === 'worldbuilding_expand' || focus.includes('locked_world_facts')) constraints.push(`世界观扩展只能增量补充，不得覆盖 ${lockedFactCount} 条 locked facts 或已确认剧情事实。`);
    if (taskType === 'plot_consistency_check' || focus.includes('plot_facts')) constraints.push('剧情一致性检查需要标出冲突证据、影响范围和最小修改建议。');
    return constraints;
  }

  private buildRetrievalDimensions(focus: string[], includeFullDrafts: boolean) {
    const dimensions = ['project_digest', 'chapter_compact', 'characters', 'world_facts', 'memory_chunks', 'validation_issues', 'plot_events'];
    if (focus.includes('relationship_graph') || focus.includes('character_arc')) dimensions.push('relationship_graph');
    if (includeFullDrafts) dimensions.push('full_current_draft');
    return [...new Set(dimensions)];
  }

  /** 完整草稿召回只开放给需要正文级证据的任务；世界观扩展等资产任务即使请求也只返回压缩摘录。 */
  private isFullDraftAllowed(taskType: string) {
    return ['chapter_revision', 'chapter_polish', 'character_consistency_check', 'plot_consistency_check'].includes(taskType);
  }

  /** 对完整草稿做硬裁剪：允许调用方收紧长度，但不能突破全局上限，防止单次上下文成本失控。 */
  private resolveFullDraftMaxChars(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 6000;
    return Math.min(12000, Math.max(2000, Math.floor(parsed)));
  }

  /** 将自由文本 entryType 归一为世界观实体类型，便于后续前端和 Eval 检查宗门、地点、规则、物品、历史事件、势力关系等召回。 */
  private mapWorldFactEntityType(fact: { title?: string | null; entryType?: string | null; summary?: string | null; content?: string | null }) {
    const entryType = (fact.entryType ?? '').toLowerCase();
    // entryType 是人工/导入时的强信号，必须优先于标题里的“宗门”等泛词，避免“宗门戒律”被误归为 faction。
    if (/rule|law|system/.test(entryType)) return 'rule';
    if (/location|place|city/.test(entryType)) return 'location';
    if (/item|artifact|weapon|relic/.test(entryType)) return 'item';
    if (/history|timeline|event/.test(entryType)) return 'history_event';
    if (/relationship|alliance|conflict/.test(entryType)) return 'relationship';
    if (/faction|sect|guild/.test(entryType)) return 'faction';

    const text = `${fact.title ?? ''} ${fact.summary ?? ''} ${fact.content ?? ''}`.toLowerCase();
    if (/规则|法则|制度|体系/.test(text)) return 'rule';
    if (/山门|地点|城市|秘境|地理/.test(text)) return 'location';
    if (/物品|法宝|兵器|遗物/.test(text)) return 'item';
    if (/历史|纪年|旧事|事件/.test(text)) return 'history_event';
    if (/关系|盟约|敌对|冲突/.test(text)) return 'relationship';
    if (/宗门|门派|势力|组织/.test(text)) return 'faction';
    return 'setting';
  }

  private matchWorldFactKeywords(fact: { title?: string | null; entryType?: string | null; summary?: string | null; content?: string | null }, keywords: string[]) {
    const haystack = `${fact.title ?? ''}\n${fact.entryType ?? ''}\n${fact.summary ?? ''}\n${fact.content ?? ''}`.toLowerCase();
    return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).slice(0, 8);
  }

  private compactText(value: unknown, maxLength: number): string {
    const text = this.stringValue(value)?.replace(/\s+/g, ' ').trim() ?? '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  private collectMissingContext(taskType: string, state: { chapterId?: string; characterId?: string; chapterCount: number; characterCount: number }) {
    const missing: string[] = [];
    if (taskType === 'chapter_revision' && !state.chapterId) missing.push('chapterId');
    if (taskType === 'character_consistency_check' && !state.characterId) missing.push('characterId');
    if (state.chapterCount === 0) missing.push('chapters');
    if (state.characterCount === 0) missing.push('characters');
    return missing;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }

  private booleanValue(value: unknown) {
    return value === true || value === 'true';
  }
}