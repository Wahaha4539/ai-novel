import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingGatewayService } from '../llm/embedding-gateway.service';

export type RetrievalHitSourceType =
  | 'lorebook'
  | 'memory'
  | 'story_event'
  | 'character_state'
  | 'foreshadow'
  | 'relationship_edge'
  | 'timeline_event'
  | 'writing_rule';
export type RetrievalSearchMethod = 'lorebook_keyword' | 'pgvector_sql' | 'keyword_fallback' | 'structured_keyword';

/**
 * 单条召回内容的来源追踪信息。
 * 该结构用于解释“为什么这条内容进入 Prompt”，不参与事实创造，也不替代数据库原始记录。
 */
export interface RetrievalHitSourceTrace {
  sourceType: RetrievalHitSourceType;
  sourceId: string;
  projectId: string;
  chapterId?: string;
  chapterNo?: number;
  score: number;
  searchMethod: RetrievalSearchMethod;
  reason: string;
}

/**
 * 进入写作上下文的单条真实命中。
 * 包含展示内容、排序分数和可审计来源，调用方只能把它当作数据库召回结果，不能当作 LLM 新造事实。
 */
export interface RetrievalHit {
  sourceType: RetrievalHitSourceType;
  sourceId: string;
  projectId: string;
  title: string;
  content: string;
  score: number;
  searchMethod: RetrievalSearchMethod;
  reason: string;
  sourceTrace: RetrievalHitSourceTrace;
  metadata: Record<string, unknown>;
}

export interface RetrievalBundle {
  lorebookHits: RetrievalHit[];
  memoryHits: RetrievalHit[];
  structuredHits: RetrievalHit[];
  rankedHits: RetrievalHit[];
  diagnostics: {
    searchMethod: 'pgvector_sql' | 'keyword_fallback' | 'disabled';
    fallbackReason?: string;
    qualityScore: number;
    qualityStatus: 'ok' | 'warn' | 'blocked';
    memoryAvailableCount: number;
    warnings: string[];
  };
}

export interface RetrievalCacheMeta {
  enabled: boolean;
  hit: boolean;
  querySpecHash: string;
  version: number;
  error?: string;
}

export interface RetrievalBundleWithCacheMeta extends RetrievalBundle {
  cache: RetrievalCacheMeta;
}

export interface RetrieveContext {
  queryText?: string | null;
  objective?: string | null;
  conflict?: string | null;
  characters?: string[];
  chapterId?: string;
  chapterNo?: number;
  excludeCurrentChapter?: boolean;
  requestId?: string;
  jobId?: string;
  plannerQueries?: {
    lorebook?: RetrievalPlannedQuery[];
    memory?: RetrievalPlannedQuery[];
    relationship?: RetrievalPlannedQuery[];
    timeline?: RetrievalPlannedQuery[];
    writingRule?: RetrievalPlannedQuery[];
    foreshadow?: RetrievalPlannedQuery[];
  };
}

export interface RetrievalPlannedQuery {
  query: string;
  type?: string;
  importance?: string;
  reason?: string;
}

interface MemoryVectorRow {
  id: string;
  sourceType: string;
  sourceId: string;
  memoryType: string;
  content: string;
  summary: string | null;
  tags: unknown;
  status: string;
  importanceScore: number;
  recencyScore: number;
  sourceTrace: unknown;
  vectorDistance: number | null;
}

interface RelationshipEdgeRow {
  id: string;
  characterAId: string | null;
  characterBId: string | null;
  characterAName: string;
  characterBName: string;
  relationType: string;
  publicState: string | null;
  hiddenState: string | null;
  conflictPoint: string | null;
  emotionalArc: string | null;
  turnChapterNos: unknown;
  finalState: string | null;
  status: string;
  sourceType: string;
  metadata: unknown;
}

interface TimelineEventRow {
  id: string;
  chapterId: string | null;
  chapterNo: number | null;
  title: string;
  eventTime: string | null;
  locationName: string | null;
  participants: unknown;
  cause: string | null;
  result: string | null;
  impactScope: string | null;
  isPublic: boolean;
  knownBy: unknown;
  unknownBy: unknown;
  eventStatus: string;
  sourceType: string;
  metadata: unknown;
}

interface WritingRuleRow {
  id: string;
  ruleType: string;
  title: string;
  content: string;
  severity: 'info' | 'warning' | 'error';
  appliesFromChapterNo: number | null;
  appliesToChapterNo: number | null;
  entityType: string | null;
  entityRef: string | null;
  status: string;
  metadata: unknown;
}

interface RetrievalQuerySpec {
  version: number;
  projectId: string;
  chapterId?: string | null;
  chapterNo?: number | null;
  excludeCurrentChapter?: boolean;
  includeLorebook: boolean;
  includeMemory: boolean;
  queryText?: string | null;
  objective?: string | null;
  conflict?: string | null;
  characters: string[];
  plannerQueries: Required<NonNullable<RetrieveContext['plannerQueries']>>;
}

export interface RetrievalBenchmarkCase {
  id?: string;
  query: string;
  expectedMemoryIds?: string[];
}

/**
 * API 内确定性召回服务，迁移 Worker RetrievalService 的核心能力。
 * 输入项目与章节语义上下文；输出设定命中、记忆命中和合并排序结果；不产生写库副作用。
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new StructuredLogger(RetrievalService.name);
  private static readonly CACHE_VERSION = 4;

  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingGatewayService, private readonly cacheService: NovelCacheService) {}

  /**
   * 汇总设定库和记忆库召回结果。
   * 优先走 pgvector SQL；embedding 或 pgvector 不可用时显式降级为关键词召回，避免生成链路硬失败。
   */
  async retrieveBundle(projectId: string, context: RetrieveContext, options: { includeLorebook?: boolean; includeMemory?: boolean } = {}): Promise<RetrievalBundle> {
    return this.retrieveBundleWithCacheMeta(projectId, context, options);
  }

  /**
   * 召回缓存只由 querySpec 输入生成 hash：项目、章节、召回开关、章节语义、角色和 Planner 查询。
   * 不允许使用召回结果生成缓存键，否则会出现“先有结果才能命中缓存”的循环设计。
   */
  async retrieveBundleWithCacheMeta(projectId: string, context: RetrieveContext, options: { includeLorebook?: boolean; includeMemory?: boolean } = {}): Promise<RetrievalBundleWithCacheMeta> {
    const startedAt = Date.now();
    const includeLorebook = options.includeLorebook ?? true;
    const includeMemory = options.includeMemory ?? true;
    const querySpec = this.buildQuerySpec(projectId, context, includeLorebook, includeMemory);
    const querySpecHash = this.hashQuerySpec(querySpec);
    const cacheMetaBase: Omit<RetrievalCacheMeta, 'hit'> = { enabled: true, querySpecHash, version: RetrievalService.CACHE_VERSION };

    const cached = await this.tryGetCachedBundle(projectId, querySpecHash);
    if (cached) {
      const cache: RetrievalCacheMeta = { ...cacheMetaBase, hit: true };
      this.logger.log('retrieval.bundle.cache_hit', {
        projectId,
        chapterId: context.chapterId,
        chapterNo: context.chapterNo,
        requestId: context.requestId,
        jobId: context.jobId,
        stage: 'retrieving_context',
        querySpecHash,
        includeLorebook,
        includeMemory,
        lorebookHitCount: cached.lorebookHits.length,
        memoryHitCount: cached.memoryHits.length,
        structuredHitCount: cached.structuredHits.length,
        rankedHitCount: cached.rankedHits.length,
        plannerQueryCount: this.countPlannerQueries(context),
        elapsedMs: Date.now() - startedAt,
      });
      return { ...cached, cache };
    }

    const memoryAvailableCount = includeMemory ? await this.countAvailableMemory(projectId, context) : 0;
    const vectorAttempt = includeMemory ? await this.tryEmbedQuery(context) : { vector: undefined, error: undefined };
    const [lorebookHits, memoryHits] = await Promise.all([
      includeLorebook ? this.retrieveLorebook(projectId, context) : Promise.resolve([]),
      includeMemory ? this.retrieveMemory(projectId, context, vectorAttempt.vector, vectorAttempt.error) : Promise.resolve([]),
    ]);
    const structuredHits = await this.retrieveStructuredFacts(projectId, context);
    const rankedHits = this.rerankAndCompress(lorebookHits, memoryHits, structuredHits);
    const diagnostics = this.buildDiagnostics(includeMemory, memoryAvailableCount, memoryHits, structuredHits, rankedHits, vectorAttempt.error);
    const cache = await this.trySetCachedBundle(projectId, querySpecHash, { lorebookHits, memoryHits, structuredHits, rankedHits, diagnostics }, cacheMetaBase);

    this.logger.log('retrieval.bundle.completed', {
      projectId,
      chapterId: context.chapterId,
      chapterNo: context.chapterNo,
      requestId: context.requestId,
      jobId: context.jobId,
      stage: 'retrieving_context',
      queryText: this.truncateForLog(context.queryText, 500),
      objective: this.truncateForLog(context.objective, 300),
      conflict: this.truncateForLog(context.conflict, 300),
      includeLorebook,
      includeMemory,
      lorebookHitCount: lorebookHits.length,
      memoryHitCount: memoryHits.length,
      structuredHitCount: structuredHits.length,
      rankedHitCount: rankedHits.length,
      plannerQueryCount: this.countPlannerQueries(context),
      querySpecHash,
      cacheHit: cache.hit,
      cacheEnabled: cache.enabled,
      cacheError: cache.error,
      diagnostics,
      elapsedMs: Date.now() - startedAt,
    });

    return { lorebookHits, memoryHits, structuredHits, rankedHits, diagnostics, cache };
  }

  /** 评测单次召回结果，供开发阶段观察关键词/向量命中质量和 expectedMemoryIds 覆盖率。 */
  async evaluate(projectId: string, context: RetrieveContext, expectedMemoryIds: string[] = []) {
    const bundle = await this.retrieveBundle(projectId, context, { includeLorebook: true, includeMemory: true });
    const expected = new Set(expectedMemoryIds.filter(Boolean));
    const hitIds = bundle.memoryHits.map((hit) => hit.sourceId);
    const matchedExpectedIds = hitIds.filter((id) => expected.has(id));
    const firstHitIndex = hitIds.findIndex((id) => expected.has(id));
    return {
      diagnostics: bundle.diagnostics,
      memoryHitCount: bundle.memoryHits.length,
      rankedHitCount: bundle.rankedHits.length,
      expectedCount: expected.size,
      matchedExpectedIds,
      recallAt10: expected.size ? matchedExpectedIds.length / expected.size : null,
      precisionAt10: hitIds.length ? matchedExpectedIds.length / hitIds.length : null,
      mrr: firstHitIndex >= 0 ? 1 / (firstHitIndex + 1) : 0,
      topHits: bundle.rankedHits.map((hit) => ({ sourceType: hit.sourceType, sourceId: hit.sourceId, title: hit.title, score: hit.score, metadata: hit.metadata })),
    };
  }

  /** 批量评测召回用例，输出平均 recall/precision/MRR，供迁移期比较检索质量。 */
  async benchmark(projectId: string, cases: RetrievalBenchmarkCase[]) {
    const results = [];
    for (const item of cases.slice(0, 50)) {
      results.push({ id: item.id, query: item.query, result: await this.evaluate(projectId, { queryText: item.query }, item.expectedMemoryIds ?? []) });
    }
    const scored = results.filter((item) => typeof item.result.recallAt10 === 'number');
    const average = (key: 'recallAt10' | 'precisionAt10' | 'mrr') => {
      const values = scored.map((item) => item.result[key]).filter((value): value is number => typeof value === 'number');
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return {
      caseCount: results.length,
      scoredCaseCount: scored.length,
      averages: { recallAt10: average('recallAt10'), precisionAt10: average('precisionAt10'), mrr: average('mrr') },
      results,
    };
  }

  private async retrieveLorebook(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    const rows = await this.prisma.lorebookEntry.findMany({
      where: { projectId, status: 'active' },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      take: 40,
    });

    return rows
      .map((row) => {
        const customMetadata = this.asRecord(row.metadata);
        const content = row.summary || row.content;
        const searchableText = `${row.title}\n${content}\n${JSON.stringify(row.tags)}\n${JSON.stringify(customMetadata)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, context.plannerQueries?.lorebook);
        const score = keywordScore + plannerScore + row.priority / 100;
        const searchMethod: RetrievalSearchMethod = 'lorebook_keyword';
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'lorebook' as const,
          sourceId: row.id,
          projectId,
          title: row.title,
          content: content.slice(0, 1200),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'lorebook', sourceId: row.id, projectId, score, searchMethod, reason }),
          metadata: { ...customMetadata, entryType: row.entryType, priority: row.priority, searchMethod, matchedKeywords, keywordScore, plannerScore, projectId },
        };
      })
      .filter((hit) => hit.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private async retrieveMemory(projectId: string, context: RetrieveContext, queryVector?: number[], vectorError?: string): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    const plannedQueries = [
      ...(context.plannerQueries?.memory ?? []),
      ...(context.plannerQueries?.relationship ?? []),
      ...(context.plannerQueries?.timeline ?? []),
      ...(context.plannerQueries?.writingRule ?? []),
      ...(context.plannerQueries?.foreshadow ?? []),
    ];
    if (queryVector?.length) {
      try {
        return await this.retrieveMemoryViaPgvector(projectId, keywords, queryVector, plannedQueries, context);
      } catch (error) {
        return this.retrieveMemoryViaKeyword(projectId, keywords, `pgvector_failed: ${error instanceof Error ? error.message : String(error)}`, plannedQueries, context);
      }
    }

    return this.retrieveMemoryViaKeyword(projectId, keywords, vectorError ? `embedding_failed: ${vectorError}` : 'embedding_unavailable', plannedQueries, context);
  }

  /**
   * 优先使用数据库侧 pgvector 排序，避免长期在应用层扫描 MemoryChunk embedding。
   * embeddingVector 是正式检索列；旧 JSON embedding 仅作为迁移期回填来源保留。
   */
  private async retrieveMemoryViaPgvector(projectId: string, keywords: string[], queryVector: number[], plannedQueries: RetrievalPlannedQuery[], context: RetrieveContext): Promise<RetrievalHit[]> {
    const vectorLiteral = `[${queryVector.join(',')}]`;
    const excludeCurrentChapter = context.excludeCurrentChapter === true;
    const rows = await this.prisma.$queryRawUnsafe<MemoryVectorRow[]>(
      `SELECT id,
              "sourceType",
              "sourceId"::text AS "sourceId",
              "memoryType",
              content,
              summary,
              tags,
              status,
              "importanceScore",
              "recencyScore",
              "sourceTrace",
              ("embeddingVector" <=> $2::vector) AS "vectorDistance"
         FROM "MemoryChunk"
        WHERE "projectId" = $1::uuid
          AND status IN ('auto', 'user_confirmed')
          AND "embeddingVector" IS NOT NULL
          AND (
            $3::integer IS NULL
            OR "sourceTrace"->>'chapterNo' IS NULL
            OR (
              ("sourceTrace"->>'chapterNo') ~ '^[0-9]+$'
              AND (
                ($4::boolean = true AND ("sourceTrace"->>'chapterNo')::integer < $3::integer)
                OR ($4::boolean = false AND ("sourceTrace"->>'chapterNo')::integer <= $3::integer)
              )
            )
          )
          AND (
            $4::boolean = false
            OR $5::text IS NULL
            OR "sourceTrace"->>'chapterId' IS NULL
            OR "sourceTrace"->>'chapterId' <> $5::text
          )
        ORDER BY "embeddingVector" <=> $2::vector ASC,
                 "importanceScore" DESC,
                 "recencyScore" DESC
        LIMIT 20`,
      projectId,
      vectorLiteral,
      context.chapterNo ?? null,
      excludeCurrentChapter,
      context.chapterId ?? null,
    );

    return rows
      .filter((row) => this.isMemoryVisibleAtChapter(row.sourceTrace, context))
      .map((row) => {
        const distance = Number(row.vectorDistance ?? 1);
        const vectorScore = Math.round(Math.max(0, 1 - distance) * 10000) / 10000;
        const searchableText = `${row.summary ?? ''}\n${row.content}\n${JSON.stringify(row.tags)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, plannedQueries);
        const score = vectorScore + plannerScore;
        const searchMethod: RetrievalSearchMethod = 'pgvector_sql';
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, vectorScore, plannerScore);
        const storedSourceTrace = this.asRecord(row.sourceTrace);
        return {
          sourceType: 'memory' as const,
          sourceId: row.id,
          projectId,
          title: row.summary || row.memoryType,
          content: row.content,
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'memory', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace }),
          metadata: { memoryType: row.memoryType, status: row.status, sourceType: row.sourceType, sourceId: row.sourceId, searchMethod, vectorDistance: row.vectorDistance, vectorScore, keywordScore, plannerScore, matchedKeywords, importanceScore: row.importanceScore, recencyScore: row.recencyScore, sourceTrace: storedSourceTrace, projectId },
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  /** embedding/pgvector 失败时的确定性兜底，保证生成链路仍能拿到可解释的上下文。 */
  private async retrieveMemoryViaKeyword(projectId: string, keywords: string[], fallbackReason: string, plannedQueries: RetrievalPlannedQuery[], context: RetrieveContext): Promise<RetrievalHit[]> {
    const rows = await this.prisma.memoryChunk.findMany({
      where: { projectId, status: { in: ['auto', 'user_confirmed'] } },
      orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }, { updatedAt: 'desc' }],
      take: 160,
    });

    return rows
      .filter((row) => this.isMemoryVisibleAtChapter(row.sourceTrace, context))
      .map((row) => {
        const searchableText = `${row.summary ?? ''}\n${row.content}\n${JSON.stringify(row.tags)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, plannedQueries);
        const score = keywordScore + plannerScore + row.importanceScore / 1000 + row.recencyScore / 2000;
        const searchMethod: RetrievalSearchMethod = 'keyword_fallback';
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        const storedSourceTrace = this.asRecord(row.sourceTrace);
        return {
          sourceType: 'memory' as const,
          sourceId: row.id,
          projectId,
          title: row.summary || row.memoryType,
          content: row.content,
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'memory', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace }),
          metadata: { memoryType: row.memoryType, status: row.status, sourceType: row.sourceType, sourceId: row.sourceId, searchMethod, fallbackReason, keywordScore, plannerScore, matchedKeywords, importanceScore: row.importanceScore, recencyScore: row.recencyScore, sourceTrace: storedSourceTrace, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  private async tryEmbedQuery(context: RetrieveContext): Promise<{ vector?: number[]; error?: string }> {
    try {
      return { vector: await this.embedQuery(context) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async embedQuery(context: RetrieveContext): Promise<number[]> {
    const query = [context.queryText, context.objective, context.conflict, ...(context.characters ?? [])].filter(Boolean).join('\n').slice(0, 4000);
    if (!query.trim()) throw new Error('记忆召回查询文本为空，无法生成 embedding。');

    const result = await this.embeddings.embedTexts([query], { appStep: 'embedding', timeoutMs: 45_000, retries: 1 });
    const vector = result.vectors[0];
    if (!vector?.length) throw new Error('embedding 服务未返回有效查询向量。');
    return vector;
  }

  private async retrieveStructuredFacts(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const [events, states, foreshadows, relationships, timelineEvents, writingRules] = await Promise.all([
      this.retrieveStoryEvents(projectId, context),
      this.retrieveCharacterStates(projectId, context),
      this.retrieveForeshadows(projectId, context),
      this.retrieveRelationshipEdges(projectId, context),
      this.retrieveTimelineEvents(projectId, context),
      this.retrieveWritingRules(projectId, context),
    ]);
    return [...events, ...states, ...foreshadows, ...relationships, ...timelineEvents, ...writingRules].sort((a, b) => b.score - a.score).slice(0, 16);
  }

  private async retrieveStoryEvents(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    const chapterNoWhere = this.chapterNoWhere(context);
    const rows = await this.prisma.storyEvent.findMany({
      where: { projectId, ...(chapterNoWhere ? { chapterNo: chapterNoWhere } : {}) },
      orderBy: [{ chapterNo: 'desc' }, { updatedAt: 'desc' }],
      take: 80,
    });
    return rows
      .filter((row) => this.isStructuredFactVisibleAtChapter(row, context))
      .map((row) => {
        const content = `${row.description}\n参与者：${JSON.stringify(row.participants)}`;
        const searchableText = `${row.title}\n${row.eventType}\n${content}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, context.plannerQueries?.memory);
        const score = keywordScore + plannerScore + 0.08;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'story_event' as const,
          sourceId: row.id,
          projectId,
          title: row.title,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'story_event', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace: { chapterId: row.chapterId, chapterNo: row.chapterNo } }),
          metadata: { eventType: row.eventType, chapterNo: row.chapterNo, timelineSeq: row.timelineSeq, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async retrieveCharacterStates(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    const queries = context.plannerQueries?.relationship ?? [];
    const chapterNoWhere = this.chapterNoWhere(context);
    const rows = await this.prisma.characterStateSnapshot.findMany({
      where: { projectId, ...(chapterNoWhere ? { chapterNo: chapterNoWhere } : {}) },
      orderBy: [{ chapterNo: 'desc' }, { updatedAt: 'desc' }],
      take: 80,
    });
    return rows
      .filter((row) => this.isStructuredFactVisibleAtChapter(row, context))
      .map((row) => {
        const content = `${row.characterName}｜${row.stateType}：${row.stateValue}${row.summary ? `\n摘要：${row.summary}` : ''}`;
        const searchableText = `${row.characterName}\n${row.stateType}\n${row.stateValue}\n${row.summary ?? ''}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, queries);
        const score = keywordScore + plannerScore + 0.06;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'character_state' as const,
          sourceId: row.id,
          projectId,
          title: `${row.characterName} 状态`,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'character_state', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace: { chapterId: row.chapterId, chapterNo: row.chapterNo } }),
          metadata: { characterName: row.characterName, stateType: row.stateType, status: row.status, chapterNo: row.chapterNo, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async retrieveForeshadows(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    const queries = context.plannerQueries?.foreshadow ?? [];
    const chapterNoWhere = this.chapterNoWhere(context);
    const rows = await this.prisma.foreshadowTrack.findMany({
      where: { projectId, ...(chapterNoWhere ? { OR: [{ chapterNo: chapterNoWhere }, { firstSeenChapterNo: chapterNoWhere }] } : {}) },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 80,
    });
    return rows
      .filter((row) => this.isForeshadowVisibleAtChapter(row, context))
      .map((row) => {
        const content = `${row.detail ?? ''}\n状态：${row.status}｜范围：${row.scope}`;
        const searchableText = `${row.title}\n${row.detail ?? ''}\n${row.status}\n${row.scope}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, queries);
        const score = keywordScore + plannerScore + 0.06;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'foreshadow' as const,
          sourceId: row.id,
          projectId,
          title: row.title,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'foreshadow', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace: { chapterId: row.chapterId, chapterNo: row.chapterNo } }),
          metadata: { status: row.status, scope: row.scope, firstSeenChapterNo: row.firstSeenChapterNo, lastSeenChapterNo: row.lastSeenChapterNo, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async retrieveRelationshipEdges(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const client = (this.prisma as unknown as { relationshipEdge?: { findMany(args: unknown): Promise<RelationshipEdgeRow[]> } }).relationshipEdge;
    if (!client) return [];

    const keywords = this.extractKeywords(context);
    const queries = context.plannerQueries?.relationship ?? [];
    const rows = await client.findMany({
      where: { projectId, status: 'active' },
      orderBy: [{ updatedAt: 'desc' }],
    });

    return rows
      .filter((row) => this.isRelationshipVisibleAtChapter(row.turnChapterNos, context))
      .map((row) => {
        const customMetadata = this.asRecord(row.metadata);
        const turnChapterNos = this.readNumberArray(row.turnChapterNos);
        const content = [
          `${row.characterAName} -> ${row.characterBName}`,
          `relationType: ${row.relationType}`,
          row.publicState ? `publicState: ${row.publicState}` : '',
          row.hiddenState ? `hiddenState: ${row.hiddenState}` : '',
          row.conflictPoint ? `conflictPoint: ${row.conflictPoint}` : '',
          row.emotionalArc ? `emotionalArc: ${row.emotionalArc}` : '',
          row.finalState ? `finalState: ${row.finalState}` : '',
          turnChapterNos.length ? `turnChapterNos: ${turnChapterNos.join(',')}` : '',
        ].filter(Boolean).join('\n');
        const searchableText = `${content}\n${JSON.stringify(customMetadata)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, queries);
        const score = keywordScore + plannerScore + 0.08;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'relationship_edge' as const,
          sourceId: row.id,
          projectId,
          title: `${row.characterAName} / ${row.characterBName}`,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'relationship_edge', sourceId: row.id, projectId, score, searchMethod, reason }),
          metadata: { ...customMetadata, characterAId: row.characterAId, characterBId: row.characterBId, characterAName: row.characterAName, characterBName: row.characterBName, relationType: row.relationType, status: row.status, sourceType: row.sourceType, turnChapterNos, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async retrieveTimelineEvents(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const client = (this.prisma as unknown as { timelineEvent?: { findMany(args: unknown): Promise<TimelineEventRow[]> } }).timelineEvent;
    if (!client) return [];

    const keywords = this.extractKeywords(context);
    const queries = context.plannerQueries?.timeline ?? [];
    const chapterNoWhere = this.chapterNoWhere(context);
    const rows = await client.findMany({
      where: {
        projectId,
        eventStatus: 'active',
        ...(chapterNoWhere ? { chapterNo: chapterNoWhere } : {}),
      },
      orderBy: [{ chapterNo: 'desc' }, { updatedAt: 'desc' }],
      take: 80,
    });

    return rows
      .filter((row) => this.isStructuredFactVisibleAtChapter(row, context))
      .map((row) => {
        const participants = this.readStringArray(row.participants);
        const knownBy = this.readStringArray(row.knownBy);
        const unknownBy = this.readStringArray(row.unknownBy);
        const customMetadata = this.asRecord(row.metadata);
        const content = [
          row.eventTime ? `eventTime: ${row.eventTime}` : '',
          row.locationName ? `location: ${row.locationName}` : '',
          participants.length ? `participants: ${participants.join(', ')}` : '',
          row.cause ? `cause: ${row.cause}` : '',
          row.result ? `result: ${row.result}` : '',
          row.impactScope ? `impactScope: ${row.impactScope}` : '',
          `isPublic: ${row.isPublic}`,
          knownBy.length ? `knownBy: ${knownBy.join(', ')}` : '',
          unknownBy.length ? `unknownBy: ${unknownBy.join(', ')}` : '',
        ].filter(Boolean).join('\n');
        const searchableText = `${row.title}\n${content}\n${JSON.stringify(customMetadata)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, queries);
        const score = keywordScore + plannerScore + 0.08;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'timeline_event' as const,
          sourceId: row.id,
          projectId,
          title: row.title,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'timeline_event', sourceId: row.id, projectId, score, searchMethod, reason, storedSourceTrace: { chapterId: row.chapterId, chapterNo: row.chapterNo } }),
          metadata: { ...customMetadata, chapterId: row.chapterId, chapterNo: row.chapterNo, eventTime: row.eventTime, locationName: row.locationName, participants, knownBy, unknownBy, eventStatus: row.eventStatus, sourceType: row.sourceType, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  private async retrieveWritingRules(projectId: string, context: RetrieveContext): Promise<RetrievalHit[]> {
    const client = (this.prisma as unknown as { writingRule?: { findMany(args: unknown): Promise<WritingRuleRow[]> } }).writingRule;
    if (!client) return [];

    const keywords = this.extractKeywords(context);
    const queries = context.plannerQueries?.writingRule ?? [];
    const rows = await client.findMany({
      where: {
        projectId,
        status: 'active',
        ...(typeof context.chapterNo === 'number'
          ? {
              AND: [
                { OR: [{ appliesFromChapterNo: null }, { appliesFromChapterNo: { lte: context.chapterNo } }] },
                { OR: [{ appliesToChapterNo: null }, { appliesToChapterNo: { gte: context.chapterNo } }] },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
    });

    return rows
      .map((row) => {
        const customMetadata = this.asRecord(row.metadata);
        const range = [
          row.appliesFromChapterNo != null ? `from=${row.appliesFromChapterNo}` : '',
          row.appliesToChapterNo != null ? `to=${row.appliesToChapterNo}` : '',
        ].filter(Boolean).join(',');
        const content = [
          `ruleType: ${row.ruleType}`,
          `severity: ${row.severity}`,
          range ? `chapterRange: ${range}` : '',
          row.entityType ? `entityType: ${row.entityType}` : '',
          row.entityRef ? `entityRef: ${row.entityRef}` : '',
          row.content,
        ].filter(Boolean).join('\n');
        const searchableText = `${row.title}\n${content}\n${JSON.stringify(customMetadata)}`;
        const keywordScore = this.scoreText(searchableText, keywords);
        const plannerScore = this.scorePlannedQueries(searchableText, queries);
        const severityScore = row.severity === 'error' ? 0.18 : row.severity === 'warning' ? 0.12 : 0.06;
        const score = keywordScore + plannerScore + severityScore;
        const searchMethod: RetrievalSearchMethod = 'structured_keyword';
        const matchedKeywords = this.matchKeywords(searchableText, keywords);
        const reason = this.buildHitReason(searchMethod, matchedKeywords, keywordScore, undefined, plannerScore);
        return {
          sourceType: 'writing_rule' as const,
          sourceId: row.id,
          projectId,
          title: row.title,
          content: content.slice(0, 900),
          score,
          searchMethod,
          reason,
          sourceTrace: this.buildSourceTrace({ sourceType: 'writing_rule', sourceId: row.id, projectId, score, searchMethod, reason }),
          metadata: { ...customMetadata, ruleType: row.ruleType, severity: row.severity, appliesFromChapterNo: row.appliesFromChapterNo, appliesToChapterNo: row.appliesToChapterNo, entityType: row.entityType, entityRef: row.entityRef, status: row.status, keywordScore, plannerScore, matchedKeywords, projectId },
        };
      })
      .filter((hit) => hit.score > 0.12)
      .sort((a, b) => (this.severityRank(b.metadata.severity) - this.severityRank(a.metadata.severity)) || b.score - a.score)
      .slice(0, 6);
  }

  private rerankAndCompress(lorebookHits: RetrievalHit[], memoryHits: RetrievalHit[], structuredHits: RetrievalHit[] = []) {
    return [...lorebookHits, ...memoryHits, ...structuredHits].sort((a, b) => b.score - a.score).slice(0, 12);
  }

  private async countAvailableMemory(projectId: string, context: RetrieveContext) {
    if (!context.excludeCurrentChapter && typeof context.chapterNo !== 'number') {
      return this.prisma.memoryChunk.count({ where: { projectId, status: { in: ['auto', 'user_confirmed'] } } });
    }
    const rows = await this.prisma.memoryChunk.findMany({
      where: { projectId, status: { in: ['auto', 'user_confirmed'] } },
      select: { sourceTrace: true },
      take: 5000,
    });
    return rows.filter((row) => this.isMemoryVisibleAtChapter(row.sourceTrace, context)).length;
  }

  private async tryGetCachedBundle(projectId: string, querySpecHash: string): Promise<RetrievalBundle | null> {
    try {
      return await this.cacheService.getRecallResult<RetrievalBundle>(projectId, querySpecHash);
    } catch (error) {
      this.logger.warn('retrieval.bundle.cache_read_failed', { projectId, querySpecHash, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async trySetCachedBundle(projectId: string, querySpecHash: string, bundle: RetrievalBundle, base: Omit<RetrievalCacheMeta, 'hit'>): Promise<RetrievalCacheMeta> {
    try {
      await this.cacheService.setRecallResult(projectId, querySpecHash, bundle);
      return { ...base, hit: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('retrieval.bundle.cache_write_failed', { projectId, querySpecHash, error: message });
      return { ...base, hit: false, error: message };
    }
  }

  private buildQuerySpec(projectId: string, context: RetrieveContext, includeLorebook: boolean, includeMemory: boolean): RetrievalQuerySpec {
    return {
      version: RetrievalService.CACHE_VERSION,
      projectId,
      chapterId: context.chapterId ?? null,
      chapterNo: context.chapterNo ?? null,
      excludeCurrentChapter: context.excludeCurrentChapter === true,
      includeLorebook,
      includeMemory,
      queryText: context.queryText ?? null,
      objective: context.objective ?? null,
      conflict: context.conflict ?? null,
      characters: this.normalizeStringList(context.characters ?? []),
      plannerQueries: {
        lorebook: this.normalizePlannedQueries(context.plannerQueries?.lorebook),
        memory: this.normalizePlannedQueries(context.plannerQueries?.memory),
        relationship: this.normalizePlannedQueries(context.plannerQueries?.relationship),
        timeline: this.normalizePlannedQueries(context.plannerQueries?.timeline),
        writingRule: this.normalizePlannedQueries(context.plannerQueries?.writingRule),
        foreshadow: this.normalizePlannedQueries(context.plannerQueries?.foreshadow),
      },
    };
  }

  private hashQuerySpec(spec: RetrievalQuerySpec): string {
    return createHash('sha256').update(this.stableStringify(spec)).digest('hex').slice(0, 32);
  }

  private normalizeStringList(values: string[]): string[] {
    return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  private normalizePlannedQueries(queries: RetrievalPlannedQuery[] | undefined): RetrievalPlannedQuery[] {
    return (queries ?? [])
      .map((item) => ({ query: item.query?.trim() ?? '', type: item.type?.trim() ?? '', importance: item.importance?.trim() ?? '', reason: item.reason?.trim() ?? '' }))
      .filter((item) => item.query)
      .sort((a, b) => `${a.importance}:${a.type}:${a.query}:${a.reason}`.localeCompare(`${b.importance}:${b.type}:${b.query}:${b.reason}`));
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private buildDiagnostics(includeMemory: boolean, memoryAvailableCount: number, memoryHits: RetrievalHit[], structuredHits: RetrievalHit[], rankedHits: RetrievalHit[], embeddingError?: string): RetrievalBundle['diagnostics'] {
    const searchMethod = !includeMemory ? 'disabled' : memoryHits.some((hit) => hit.metadata.searchMethod === 'pgvector_sql') ? 'pgvector_sql' : 'keyword_fallback';
    const fallbackReason = embeddingError ?? (memoryHits[0]?.metadata.fallbackReason as string | undefined);
    const qualityScore = Math.min(1, rankedHits.reduce((sum, hit) => sum + Math.max(0, hit.score), 0) / 3);
    const hasAnyVerifiedContext = memoryHits.length > 0 || structuredHits.length > 0;
    const warnings = [
      ...(fallbackReason ? [`向量召回已降级：${fallbackReason}`] : []),
      ...(includeMemory && memoryAvailableCount > 0 && memoryHits.length === 0 ? ['项目存在记忆，但本次没有命中 MemoryChunk 记忆片段。'] : []),
      ...(rankedHits.length < 2 ? ['召回上下文较少，生成质量可能下降。'] : []),
    ];
    // Planner 可能从 StoryEvent/CharacterState/Foreshadow 命中结构化事实；只在完全没有记忆类上下文时阻断。
    const qualityStatus = includeMemory && memoryAvailableCount > 0 && !hasAnyVerifiedContext ? 'blocked' : warnings.length ? 'warn' : 'ok';
    return { searchMethod, fallbackReason, qualityScore, qualityStatus, memoryAvailableCount, warnings };
  }

  private extractKeywords(context: RetrieveContext): string[] {
    const raw = [context.queryText, context.objective, context.conflict, ...(context.characters ?? [])].filter(Boolean).join('\n');
    const cjkTerms = raw.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    const latinTerms = raw.match(/[A-Za-z0-9_]{3,}/g) ?? [];
    return [...new Set([...cjkTerms, ...latinTerms].map((item) => item.toLowerCase()))].slice(0, 30);
  }

  private scoreText(text: string, keywords: string[]): number {
    if (!keywords.length) return 0.2;
    const lowerText = text.toLowerCase();
    const matched = keywords.filter((keyword) => lowerText.includes(keyword.toLowerCase())).length;
    return matched / Math.max(1, keywords.length);
  }

  private matchKeywords(text: string, keywords: string[]): string[] {
    const lowerText = text.toLowerCase();
    return keywords.filter((keyword) => lowerText.includes(keyword.toLowerCase())).slice(0, 8);
  }

  private buildHitReason(searchMethod: RetrievalSearchMethod, matchedKeywords: string[], keywordScore: number, vectorScore?: number, plannerScore = 0): string {
    const keywordPart = matchedKeywords.length ? `关键词命中：${matchedKeywords.join('、')}` : '无明确关键词命中';
    const plannerPart = plannerScore > 0 ? `；Planner 查询命中=${plannerScore.toFixed(3)}` : '';
    if (searchMethod === 'pgvector_sql') {
      return `向量相似度=${(vectorScore ?? 0).toFixed(3)}；${keywordPart}；keywordScore=${keywordScore.toFixed(3)}${plannerPart}`;
    }
    return `${keywordPart}；keywordScore=${keywordScore.toFixed(3)}${plannerPart}`;
  }

  private buildSourceTrace(input: { sourceType: RetrievalHitSourceType; sourceId: string; projectId: string; score: number; searchMethod: RetrievalSearchMethod; reason: string; storedSourceTrace?: Record<string, unknown> }): RetrievalHitSourceTrace {
    const chapterId = this.readString(input.storedSourceTrace?.chapterId);
    const chapterNo = this.readNumber(input.storedSourceTrace?.chapterNo);
    return {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      projectId: input.projectId,
      ...(chapterId ? { chapterId } : {}),
      ...(typeof chapterNo === 'number' ? { chapterNo } : {}),
      score: Math.round(input.score * 10000) / 10000,
      searchMethod: input.searchMethod,
      reason: input.reason,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  }

  private readNumberArray(value: unknown): number[] {
    return Array.isArray(value)
      ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [];
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private chapterNoWhere(context: RetrieveContext): { lt: number } | { lte: number } | undefined {
    if (typeof context.chapterNo !== 'number') return undefined;
    return context.excludeCurrentChapter ? { lt: context.chapterNo } : { lte: context.chapterNo };
  }

  private isStructuredFactVisibleAtChapter(row: { chapterId?: string | null; chapterNo?: number | null }, context: RetrieveContext): boolean {
    if (context.excludeCurrentChapter && context.chapterId && row.chapterId === context.chapterId) return false;
    if (typeof context.chapterNo !== 'number' || typeof row.chapterNo !== 'number') return true;
    return context.excludeCurrentChapter ? row.chapterNo < context.chapterNo : row.chapterNo <= context.chapterNo;
  }

  private isForeshadowVisibleAtChapter(row: { chapterId?: string | null; chapterNo?: number | null; firstSeenChapterNo?: number | null }, context: RetrieveContext): boolean {
    if (context.excludeCurrentChapter && context.chapterId && row.chapterId === context.chapterId) return false;
    if (typeof context.chapterNo !== 'number') return true;
    const chapterNos = [row.chapterNo, row.firstSeenChapterNo].filter((item): item is number => typeof item === 'number');
    if (!chapterNos.length) return true;
    return chapterNos.some((chapterNo) => context.excludeCurrentChapter ? chapterNo < context.chapterNo! : chapterNo <= context.chapterNo!);
  }

  private isRelationshipVisibleAtChapter(turnChapterNos: unknown, context: RetrieveContext): boolean {
    if (typeof context.chapterNo !== 'number') return true;
    const turns = this.readNumberArray(turnChapterNos);
    return turns.length === 0 || turns.some((item) => context.excludeCurrentChapter ? item < context.chapterNo! : item <= context.chapterNo!);
  }

  private isMemoryVisibleAtChapter(sourceTrace: unknown, context: RetrieveContext): boolean {
    const trace = this.asRecord(sourceTrace);
    const traceChapterId = this.readString(trace.chapterId);
    if (context.excludeCurrentChapter && context.chapterId && traceChapterId === context.chapterId) return false;
    if (typeof context.chapterNo !== 'number') return true;
    const traceChapterNo = this.readNumber(trace.chapterNo);
    if (typeof traceChapterNo !== 'number') return true;
    return context.excludeCurrentChapter ? traceChapterNo < context.chapterNo : traceChapterNo <= context.chapterNo;
  }

  private severityRank(value: unknown): number {
    return value === 'error' ? 3 : value === 'warning' ? 2 : value === 'info' ? 1 : 0;
  }

  private truncateForLog(value: string | null | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

  private scorePlannedQueries(text: string, queries: RetrievalPlannedQuery[] | undefined): number {
    if (!queries?.length) return 0;
    const lowerText = text.toLowerCase();
    return queries.reduce((sum, query) => {
      const terms = this.extractKeywords({ queryText: query.query });
      if (!terms.length) return sum;
      const matched = terms.filter((term) => lowerText.includes(term.toLowerCase())).length;
      if (!matched) return sum;
      const weight = query.importance === 'must' ? 0.35 : query.importance === 'nice_to_have' ? 0.12 : 0.22;
      return sum + (matched / terms.length) * weight;
    }, 0);
  }

  private countPlannerQueries(context: RetrieveContext): number {
    const queries = context.plannerQueries;
    if (!queries) return 0;
    return (queries.lorebook?.length ?? 0)
      + (queries.memory?.length ?? 0)
      + (queries.relationship?.length ?? 0)
      + (queries.timeline?.length ?? 0)
      + (queries.writingRule?.length ?? 0)
      + (queries.foreshadow?.length ?? 0);
  }

}
