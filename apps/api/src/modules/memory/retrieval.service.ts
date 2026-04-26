import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingGatewayService } from '../llm/embedding-gateway.service';

export interface RetrievalHit {
  sourceType: 'lorebook' | 'memory';
  sourceId: string;
  title: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalBundle {
  lorebookHits: RetrievalHit[];
  memoryHits: RetrievalHit[];
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

export interface RetrieveContext {
  queryText?: string | null;
  objective?: string | null;
  conflict?: string | null;
  characters?: string[];
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
  vectorDistance: number | null;
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
  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingGatewayService) {}

  /**
   * 汇总设定库和记忆库召回结果。
   * 优先走 pgvector SQL；embedding 或 pgvector 不可用时显式降级为关键词召回，避免生成链路硬失败。
   */
  async retrieveBundle(projectId: string, context: RetrieveContext, options: { includeLorebook?: boolean; includeMemory?: boolean } = {}): Promise<RetrievalBundle> {
    const includeLorebook = options.includeLorebook ?? true;
    const includeMemory = options.includeMemory ?? true;
    const memoryAvailableCount = includeMemory ? await this.countAvailableMemory(projectId) : 0;
    const vectorAttempt = includeMemory ? await this.tryEmbedQuery(context) : { vector: undefined, error: undefined };
    const [lorebookHits, memoryHits] = await Promise.all([
      includeLorebook ? this.retrieveLorebook(projectId, context) : Promise.resolve([]),
      includeMemory ? this.retrieveMemory(projectId, context, vectorAttempt.vector, vectorAttempt.error) : Promise.resolve([]),
    ]);
    const rankedHits = this.rerankAndCompress(lorebookHits, memoryHits);

    return { lorebookHits, memoryHits, rankedHits, diagnostics: this.buildDiagnostics(includeMemory, memoryAvailableCount, memoryHits, rankedHits, vectorAttempt.error) };
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
        const content = row.summary || row.content;
        return {
          sourceType: 'lorebook' as const,
          sourceId: row.id,
          title: row.title,
          content: content.slice(0, 1200),
          score: this.scoreText(`${row.title}\n${content}\n${JSON.stringify(row.tags)}`, keywords) + row.priority / 100,
          metadata: { entryType: row.entryType, priority: row.priority },
        };
      })
      .filter((hit) => hit.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private async retrieveMemory(projectId: string, context: RetrieveContext, queryVector?: number[], vectorError?: string): Promise<RetrievalHit[]> {
    const keywords = this.extractKeywords(context);
    if (queryVector?.length) {
      try {
        return await this.retrieveMemoryViaPgvector(projectId, keywords, queryVector);
      } catch (error) {
        return this.retrieveMemoryViaKeyword(projectId, keywords, `pgvector_failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return this.retrieveMemoryViaKeyword(projectId, keywords, vectorError ? `embedding_failed: ${vectorError}` : 'embedding_unavailable');
  }

  /**
   * 优先使用数据库侧 pgvector 排序，避免长期在应用层扫描 MemoryChunk embedding。
   * embeddingVector 是正式检索列；旧 JSON embedding 仅作为迁移期回填来源保留。
   */
  private async retrieveMemoryViaPgvector(projectId: string, keywords: string[], queryVector: number[]): Promise<RetrievalHit[]> {
    const vectorLiteral = `[${queryVector.join(',')}]`;
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
              ("embeddingVector" <=> $2::vector) AS "vectorDistance"
         FROM "MemoryChunk"
        WHERE "projectId" = $1::uuid
          AND status IN ('auto', 'user_confirmed')
          AND "embeddingVector" IS NOT NULL
        ORDER BY "embeddingVector" <=> $2::vector ASC,
                 "importanceScore" DESC,
                 "recencyScore" DESC
        LIMIT 20`,
      projectId,
      vectorLiteral,
    );

    return rows
      .map((row) => {
        const distance = Number(row.vectorDistance ?? 1);
        const vectorScore = Math.round(Math.max(0, 1 - distance) * 10000) / 10000;
        const keywordScore = this.scoreText(`${row.summary ?? ''}\n${row.content}\n${JSON.stringify(row.tags)}`, keywords);
        return {
          sourceType: 'memory' as const,
          sourceId: row.id,
          title: row.summary || row.memoryType,
          content: row.content,
          score: vectorScore,
          metadata: { memoryType: row.memoryType, status: row.status, sourceType: row.sourceType, sourceId: row.sourceId, searchMethod: 'pgvector_sql', vectorDistance: row.vectorDistance, vectorScore, keywordScore, importanceScore: row.importanceScore, recencyScore: row.recencyScore },
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  /** embedding/pgvector 失败时的确定性兜底，保证生成链路仍能拿到可解释的上下文。 */
  private async retrieveMemoryViaKeyword(projectId: string, keywords: string[], fallbackReason: string): Promise<RetrievalHit[]> {
    const rows = await this.prisma.memoryChunk.findMany({
      where: { projectId, status: { in: ['auto', 'user_confirmed'] } },
      orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }, { updatedAt: 'desc' }],
      take: 80,
    });

    return rows
      .map((row) => {
        const keywordScore = this.scoreText(`${row.summary ?? ''}\n${row.content}\n${JSON.stringify(row.tags)}`, keywords);
        return {
          sourceType: 'memory' as const,
          sourceId: row.id,
          title: row.summary || row.memoryType,
          content: row.content,
          score: keywordScore + row.importanceScore / 1000 + row.recencyScore / 2000,
          metadata: { memoryType: row.memoryType, status: row.status, sourceType: row.sourceType, sourceId: row.sourceId, searchMethod: 'keyword_fallback', fallbackReason, keywordScore, importanceScore: row.importanceScore, recencyScore: row.recencyScore },
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

  private rerankAndCompress(lorebookHits: RetrievalHit[], memoryHits: RetrievalHit[]) {
    return [...lorebookHits, ...memoryHits].sort((a, b) => b.score - a.score).slice(0, 8);
  }

  private async countAvailableMemory(projectId: string) {
    return this.prisma.memoryChunk.count({ where: { projectId, status: { in: ['auto', 'user_confirmed'] } } });
  }

  private buildDiagnostics(includeMemory: boolean, memoryAvailableCount: number, memoryHits: RetrievalHit[], rankedHits: RetrievalHit[], embeddingError?: string): RetrievalBundle['diagnostics'] {
    const searchMethod = !includeMemory ? 'disabled' : memoryHits.some((hit) => hit.metadata.searchMethod === 'pgvector_sql') ? 'pgvector_sql' : 'keyword_fallback';
    const fallbackReason = embeddingError ?? (memoryHits[0]?.metadata.fallbackReason as string | undefined);
    const qualityScore = Math.min(1, rankedHits.reduce((sum, hit) => sum + Math.max(0, hit.score), 0) / 3);
    const warnings = [
      ...(fallbackReason ? [`向量召回已降级：${fallbackReason}`] : []),
      ...(includeMemory && memoryAvailableCount > 0 && memoryHits.length === 0 ? ['项目存在记忆，但本次没有命中任何记忆片段。'] : []),
      ...(rankedHits.length < 2 ? ['召回上下文较少，生成质量可能下降。'] : []),
    ];
    const qualityStatus = includeMemory && memoryAvailableCount > 0 && memoryHits.length === 0 ? 'blocked' : warnings.length ? 'warn' : 'ok';
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

}