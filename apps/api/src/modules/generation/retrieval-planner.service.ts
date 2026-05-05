import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { RetrievalImportance, RetrievalPlan, RetrievalPlanQuery, RetrievalPlannerResult } from '../memory/retrieval-plan.types';

export interface RetrievalPlannerInput {
  project: { id: string; title: string; genre: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  volume?: { volumeNo: number; title: string | null; objective: string | null; synopsis: string | null } | null;
  chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null; revealPoints?: string | null; foreshadowPlan?: string | null };
  characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null }>;
  previousChapters: Array<{ chapterNo: number; title: string | null; content: string }>;
  userInstruction?: string;
  requestId?: string;
  jobId?: string;
}

const MAX_TASKS = 8;
const MAX_ENTITIES_PER_TYPE = 10;
const MAX_QUERIES_PER_TYPE = 6;
const MAX_CONSTRAINTS = 12;
const VALID_IMPORTANCE = new Set<RetrievalImportance>(['must', 'should', 'nice_to_have']);

/**
 * LLM 召回规划器：分析本章写作任务需要查询哪些资料。
 * 它只产出查询意图；真实命中、过滤、排序和 Prompt 注入都由程序侧完成。
 */
@Injectable()
export class RetrievalPlannerService {
  private readonly logger = new StructuredLogger(RetrievalPlannerService.name);

  constructor(private readonly llm: LlmGatewayService) {}

  /** 调用 LLM 生成召回计划；失败时降级为确定性计划，确保传统召回链路仍可运行。 */
  async createPlan(input: RetrievalPlannerInput): Promise<RetrievalPlannerResult> {
    const startedAt = Date.now();
    const fallback = this.buildFallbackPlan(input);
    try {
      const { data, result } = await this.llm.chatJson<unknown>(
        [
          { role: 'system', content: this.buildSystemPrompt() },
          { role: 'user', content: this.buildUserPrompt(input) },
        ],
        { appStep: 'retrieval_planner', maxTokens: 1800, timeoutMs: 90_000, retries: 1, temperature: 0 },
      );
      const rawQueryCount = this.countRawQueries(data);
      const plan = this.normalizePlan(data, fallback);
      const normalizedQueryCount = this.countPlanQueries(plan);
      const warnings = normalizedQueryCount === 0 ? ['Retrieval Planner 没有产出有效查询，已保留确定性兜底计划。'] : [];
      const finalPlan = normalizedQueryCount === 0 ? fallback : plan;
      const diagnostics = { status: 'ok' as const, elapsedMs: Date.now() - startedAt, model: result.model, usage: result.usage, rawQueryCount, normalizedQueryCount: this.countPlanQueries(finalPlan), warnings };
      this.logger.log('retrieval.planner.completed', { projectId: input.project.id, chapterNo: input.chapter.chapterNo, requestId: input.requestId, jobId: input.jobId, ...diagnostics });
      return { plan: finalPlan, diagnostics };
    } catch (error) {
      const diagnostics = {
        status: 'fallback' as const,
        elapsedMs: Date.now() - startedAt,
        rawQueryCount: 0,
        normalizedQueryCount: this.countPlanQueries(fallback),
        warnings: ['Retrieval Planner 调用失败，已降级为确定性召回计划。'],
        fallbackReason: error instanceof Error ? error.message : String(error),
      };
      this.logger.warn('retrieval.planner.fallback', { projectId: input.project.id, chapterNo: input.chapter.chapterNo, requestId: input.requestId, jobId: input.jobId, ...diagnostics });
      return { plan: fallback, diagnostics };
    }
  }

  private buildSystemPrompt(): string {
    return [
      '你是长篇小说章节生成前的 Retrieval Planner。',
      '职责：只分析这一章应该查询哪些已有资料，不要创造剧情事实，不要补写正文。',
      '必须输出严格 JSON 对象，不要 Markdown，不要解释。',
      '输出字段固定为：chapterTasks, entities, lorebookQueries, memoryQueries, relationshipQueries, timelineQueries, writingRuleQueries, foreshadowQueries, constraints。',
      'entities 固定包含 characters, locations, items, factions 四个字符串数组。',
      '每个 query 对象固定包含 query,type,importance,reason；importance 只能是 must/should/nice_to_have。',
      '如果某内容可能是本章首次出现，只能写入 constraints 或 user intent 相关查询意图，不能当作已存在事实。',
      '避免未来剧透：只规划需要查询当前章节及以前已经存在的事实。',
    ].join('\n');
  }

  private buildUserPrompt(input: RetrievalPlannerInput): string {
    const previous = input.previousChapters
      .map((chapter) => `第${chapter.chapterNo}章「${chapter.title ?? '未命名'}」：${chapter.content.slice(0, 800)}`)
      .join('\n\n');
    return JSON.stringify(
      {
        project: input.project,
        volume: input.volume ?? null,
        chapter: input.chapter,
        userInstruction: input.userInstruction ?? '',
        characters: input.characters.slice(0, 20),
        previousChapters: previous || '无前文章节正文。',
        outputExample: {
          chapterTasks: ['判断本章是否涉及身份线/关系转折/伏笔回收'],
          entities: { characters: ['角色名'], locations: ['地点名'], items: ['道具名'], factions: ['组织名'] },
          lorebookQueries: [{ query: '需要查询的设定关键词', type: 'setting', importance: 'must', reason: '为什么本章需要该设定' }],
          memoryQueries: [{ query: '需要查询的前情记忆', type: 'event', importance: 'should', reason: '为什么需要前情' }],
          relationshipQueries: [{ query: '人物A 与 人物B 信任状态', type: 'relationship_state', importance: 'should', reason: '为什么需要关系状态' }],
          timelineQueries: [{ query: '事件发生顺序与知情角色', type: 'timeline_event', importance: 'should', reason: '为什么需要时间线与知情范围' }],
          writingRuleQueries: [{ query: '本章必须遵守的禁写/保密/出场规则', type: 'writing_rule', importance: 'must', reason: '为什么需要写作约束' }],
          foreshadowQueries: [{ query: '伏笔或道具的首次出现/当前状态', type: 'foreshadow', importance: 'nice_to_have', reason: '为什么需要伏笔资料' }],
          constraints: ['查不到的规划内容不得当作事实写入 Prompt。'],
        },
      },
      null,
      2,
    );
  }

  private buildFallbackPlan(input: RetrievalPlannerInput): RetrievalPlan {
    const baseQuery = [input.userInstruction, input.chapter.objective, input.chapter.conflict, input.chapter.outline].filter(Boolean).join('；').slice(0, 240);
    const characterNames = input.characters.map((item) => item.name).filter(Boolean).slice(0, MAX_ENTITIES_PER_TYPE);
    const query = baseQuery || `第${input.chapter.chapterNo}章 ${input.chapter.title ?? ''}`.trim();
    return {
      chapterTasks: this.normalizeStringArray([input.chapter.objective, input.chapter.conflict, input.userInstruction], MAX_TASKS),
      entities: { characters: characterNames, locations: [], items: [], factions: [] },
      lorebookQueries: query ? [{ query, type: 'chapter_setting', importance: 'should', reason: '根据章节目标查询相关设定。' }] : [],
      memoryQueries: query ? [{ query, type: 'previous_context', importance: 'should', reason: '根据章节目标查询前情记忆。' }] : [],
      relationshipQueries: characterNames.length ? [{ query: `${characterNames.slice(0, 4).join('、')} 当前关系与信任状态`, type: 'relationship_state', importance: 'nice_to_have', reason: '根据登场角色查询关系状态，避免人物互动断裂。' }] : [],
      timelineQueries: query ? [{ query, type: 'timeline_event', importance: 'should', reason: '根据章节目标查询已发生时间线事件与知情范围。' }] : [],
      writingRuleQueries: query ? [{ query, type: 'writing_rule', importance: 'must', reason: '查询本章适用的写作硬约束。' }] : [],
      foreshadowQueries: input.chapter.foreshadowPlan || input.chapter.revealPoints ? [{ query: [input.chapter.foreshadowPlan, input.chapter.revealPoints].filter(Boolean).join('；'), type: 'foreshadow', importance: 'should', reason: '章节含伏笔计划或揭示点，需要查询伏笔状态。' }] : [],
      constraints: ['只使用数据库真实命中的资料作为已验证上下文。', '未命中查询只进入诊断，不当作既有事实。'],
    };
  }

  private normalizePlan(data: unknown, fallback: RetrievalPlan): RetrievalPlan {
    const record = this.asRecord(data);
    const entities = this.asRecord(record.entities);
    return {
      chapterTasks: this.normalizeStringArray(record.chapterTasks, MAX_TASKS),
      entities: {
        characters: this.normalizeStringArray(entities.characters, MAX_ENTITIES_PER_TYPE, fallback.entities.characters),
        locations: this.normalizeStringArray(entities.locations, MAX_ENTITIES_PER_TYPE),
        items: this.normalizeStringArray(entities.items, MAX_ENTITIES_PER_TYPE),
        factions: this.normalizeStringArray(entities.factions, MAX_ENTITIES_PER_TYPE),
      },
      lorebookQueries: this.normalizeQueries(record.lorebookQueries, 'lorebook', fallback.lorebookQueries),
      memoryQueries: this.normalizeQueries(record.memoryQueries, 'memory', fallback.memoryQueries),
      relationshipQueries: this.normalizeQueries(record.relationshipQueries, 'relationship', fallback.relationshipQueries),
      timelineQueries: this.normalizeQueries(record.timelineQueries, 'timeline', fallback.timelineQueries),
      writingRuleQueries: this.normalizeQueries(record.writingRuleQueries, 'writing_rule', fallback.writingRuleQueries),
      foreshadowQueries: this.normalizeQueries(record.foreshadowQueries, 'foreshadow', fallback.foreshadowQueries),
      constraints: this.normalizeStringArray(record.constraints, MAX_CONSTRAINTS, fallback.constraints),
    };
  }

  private normalizeQueries(value: unknown, defaultType: string, fallback: RetrievalPlanQuery[] = []): RetrievalPlanQuery[] {
    const items = Array.isArray(value) ? value : [];
    const normalized = items
      .map((item): RetrievalPlanQuery | null => {
        const record = typeof item === 'string' ? { query: item } : this.asRecord(item);
        const query = this.truncateString(record.query, 160);
        if (!query) return null;
        const importance = VALID_IMPORTANCE.has(record.importance as RetrievalImportance) ? (record.importance as RetrievalImportance) : 'should';
        return {
          query,
          type: this.truncateString(record.type, 50) || defaultType,
          importance,
          reason: this.truncateString(record.reason, 160) || 'Planner 判断本章需要查询该资料。',
        };
      })
      .filter((item): item is RetrievalPlanQuery => Boolean(item));
    const deduped = this.dedupeBy(normalized, (item) => `${item.type}:${item.query}`.toLowerCase()).slice(0, MAX_QUERIES_PER_TYPE);
    return deduped.length ? deduped : fallback.slice(0, MAX_QUERIES_PER_TYPE);
  }

  private normalizeStringArray(value: unknown, maxCount: number, fallback: string[] = []): string[] {
    const items = Array.isArray(value) ? value : [];
    const normalized = items.map((item) => this.truncateString(item, 120)).filter(Boolean);
    const deduped = this.dedupeBy(normalized, (item) => item.toLowerCase()).slice(0, maxCount);
    return deduped.length ? deduped : fallback.slice(0, maxCount);
  }

  private countRawQueries(data: unknown): number {
    const record = this.asRecord(data);
    return ['lorebookQueries', 'memoryQueries', 'relationshipQueries', 'timelineQueries', 'writingRuleQueries', 'foreshadowQueries'].reduce((sum, key) => sum + (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0), 0);
  }

  private countPlanQueries(plan: RetrievalPlan): number {
    return plan.lorebookQueries.length + plan.memoryQueries.length + plan.relationshipQueries.length + plan.timelineQueries.length + plan.writingRuleQueries.length + plan.foreshadowQueries.length;
  }

  private dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = keyOf(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private truncateString(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
}
