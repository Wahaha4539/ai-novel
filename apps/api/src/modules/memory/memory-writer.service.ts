import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingGatewayService } from '../llm/embedding-gateway.service';

export interface MemoryWriterChunkInput {
  memoryType: string;
  content: string;
  summary?: string;
  tags?: string[];
  importanceScore?: number;
  freshnessScore?: number;
  recencyScore?: number;
  status?: string;
  sourceTrace?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MemoryWriterResult {
  deletedCount: number;
  createdCount: number;
  embeddingAttachedCount: number;
  chunks: Array<{ id: string; memoryType: string; summary: string; status: string }>;
}

export interface ChapterMemorySource {
  id: string;
  chapterNo?: number | null;
}

export interface ChapterEventMemoryInput {
  title?: string;
  description: string;
  eventType?: string;
  participants?: unknown[];
}

export interface ChapterCharacterStateMemoryInput {
  character: string;
  stateValue: string;
  stateType?: string;
  summary?: string;
}

export interface ChapterForeshadowMemoryInput {
  title: string;
  detail?: string | null;
  status?: string;
}

export interface MemoryEmbeddingBackfillResult {
  scannedCount: number;
  updatedCount: number;
  failedCount: number;
  dryRun: boolean;
  nextCursor?: string;
  failures: Array<{ id: string; error: string }>;
}

/**
 * API 内 MemoryWriter：统一负责自动记忆替换、embedding 附加和写入元数据。
 * 副作用限定为替换指定 generatedBy/source 范围内的自动记忆，避免误删人工记忆。
 */
@Injectable()
export class MemoryWriterService {
  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingGatewayService) {}

  /** 为历史 MemoryChunk 批量补齐 embedding；支持 cursor 续跑和 force 统一重算。 */
  async backfillEmbeddings(projectId: string, options: { chapterId?: string; limit?: number; dryRun?: boolean; cursor?: string; force?: boolean } = {}): Promise<MemoryEmbeddingBackfillResult> {
    const chunks = await this.prisma.memoryChunk.findMany({
      where: { projectId, ...(options.force ? {} : { embedding: { equals: Prisma.DbNull } }), ...(options.chapterId ? { sourceType: 'chapter', sourceId: options.chapterId } : {}), ...(options.cursor ? { id: { gt: options.cursor } } : {}) },
      orderBy: [{ id: 'asc' }],
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
    const nextCursor = chunks.length ? chunks[chunks.length - 1].id : undefined;
    if (options.dryRun) return { scannedCount: chunks.length, updatedCount: 0, failedCount: 0, dryRun: true, nextCursor, failures: [] };

    let updatedCount = 0;
    const failures: MemoryEmbeddingBackfillResult['failures'] = [];

    try {
      const embedding = await this.attachEmbeddings(chunks.map((chunk) => ({ memoryType: chunk.memoryType, content: chunk.content, summary: chunk.summary ?? undefined })));
      for (const [index, chunk] of chunks.entries()) {
        const vector = embedding.vectors[index];
        const vectorLiteral = `[${vector.join(',')}]`;
        await this.prisma.memoryChunk.update({
          where: { id: chunk.id },
          data: { embedding: vector as Prisma.InputJsonValue, metadata: this.compactJson({ ...(this.asRecord(chunk.metadata)), embeddingModel: embedding.model, embeddingBackfilledBy: 'api_memory_writer' }) as Prisma.InputJsonValue },
        });
        await this.prisma.$executeRawUnsafe('UPDATE "MemoryChunk" SET "embeddingVector" = $2::vector WHERE id = $1::uuid', chunk.id, vectorLiteral);
        updatedCount += 1;
      }
    } catch (error) {
      // 批量失败后保留逐条失败明细，方便调用方从 nextCursor 或失败 id 继续排障/续跑。
      const message = error instanceof Error ? error.message : String(error);
      failures.push(...chunks.map((chunk) => ({ id: chunk.id, error: message })));
    }

    return { scannedCount: chunks.length, updatedCount, failedCount: failures.length, dryRun: false, nextCursor, failures };
  }

  async replaceGeneratedChapterMemories(input: {
    projectId: string;
    chapterId: string;
    generatedBy: string;
    chunks: MemoryWriterChunkInput[];
  }): Promise<MemoryWriterResult> {
    const embedding = await this.attachEmbeddings(input.chunks);
    const createdRows = input.chunks.map((chunk, index) => ({
      id: randomUUID(),
      projectId: input.projectId,
      sourceType: 'chapter',
      sourceId: input.chapterId,
      memoryType: chunk.memoryType,
      content: chunk.content,
      summary: chunk.summary,
      embedding: embedding.vectors[index] ? (embedding.vectors[index] as Prisma.InputJsonValue) : undefined,
      tags: (chunk.tags ?? []) as Prisma.InputJsonValue,
      sourceTrace: (chunk.sourceTrace ?? {}) as Prisma.InputJsonValue,
      metadata: this.compactJson({ ...(chunk.metadata ?? {}), generatedBy: input.generatedBy, embeddingModel: embedding.model }) as Prisma.InputJsonValue,
      importanceScore: chunk.importanceScore ?? 60,
      freshnessScore: chunk.freshnessScore ?? 80,
      recencyScore: chunk.recencyScore ?? 80,
      status: chunk.status ?? 'auto',
    }));

    const result = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.memoryChunk.deleteMany({
        where: { projectId: input.projectId, sourceType: 'chapter', sourceId: input.chapterId, metadata: { path: ['generatedBy'], equals: input.generatedBy } },
      });

      // 批量写入缩短 interactive transaction 时间，避免 Prisma 默认事务超时导致 tx 被关闭。
      const created = createdRows.length ? await tx.memoryChunk.createMany({ data: createdRows }) : { count: 0 };

      return { deletedCount: deleted.count, created };
    }, { timeout: 30_000, maxWait: 10_000 });

    for (const [index, chunk] of createdRows.entries()) {
      const vector = embedding.vectors[index];
      if (!vector?.length) continue;
      // Unsupported("vector") 暂不能由 Prisma Client 直接写入，创建后用 SQL 同步正式 pgvector 检索列。
      await this.prisma.$executeRawUnsafe('UPDATE "MemoryChunk" SET "embeddingVector" = $2::vector WHERE id = $1::uuid', chunk.id, `[${vector.join(',')}]`);
    }

    return {
      deletedCount: result.deletedCount,
      createdCount: result.created.count,
      embeddingAttachedCount: embedding.vectors.filter(Boolean).length,
      chunks: createdRows.map((chunk) => ({ id: chunk.id, memoryType: chunk.memoryType, summary: chunk.summary ?? chunk.content.slice(0, 160), status: chunk.status })),
    };
  }

  /** 对齐 Worker MemoryWriter.write_summary_memory：构造章节摘要记忆并交由统一写入流程附加 embedding。 */
  buildSummaryMemory(projectId: string, chapter: ChapterMemorySource, summary: string): MemoryWriterChunkInput {
    return {
      memoryType: 'summary',
      content: summary,
      summary,
      tags: ['chapter', 'summary'],
      status: 'auto',
      importanceScore: 90,
      freshnessScore: 95,
      recencyScore: 95,
      sourceTrace: { projectId, chapterId: chapter.id, chapterNo: chapter.chapterNo, kind: 'chapter_summary' },
    };
  }

  /** 对齐 Worker write_event_memories：剧情事件记忆默认 auto，并批量走 embedding。 */
  buildEventMemories(projectId: string, chapter: ChapterMemorySource, events: ChapterEventMemoryInput[]): MemoryWriterChunkInput[] {
    return events.map((event) => ({
      memoryType: 'event',
      content: event.description,
      summary: event.title,
      tags: ['chapter', 'event', event.eventType ?? 'event'],
      status: 'auto',
      importanceScore: 75,
      freshnessScore: 85,
      recencyScore: 85,
      metadata: { eventType: event.eventType, participants: event.participants ?? [] },
      sourceTrace: { projectId, chapterId: chapter.id, chapterNo: chapter.chapterNo, kind: 'event' },
    }));
  }

  /** 对齐 Worker write_character_state_memories：角色状态进入 pending_review，避免未经确认污染事实记忆。 */
  buildCharacterStateMemories(projectId: string, chapter: ChapterMemorySource, states: ChapterCharacterStateMemoryInput[]): MemoryWriterChunkInput[] {
    return states.map((state) => ({
      memoryType: 'character_state',
      content: `${state.character}：${state.stateValue}`,
      summary: state.summary || `${state.character}状态更新`,
      tags: ['chapter', 'character_state', state.character],
      status: 'pending_review',
      importanceScore: 70,
      freshnessScore: 80,
      recencyScore: 80,
      metadata: { character: state.character, stateType: state.stateType ?? 'state' },
      sourceTrace: { projectId, chapterId: chapter.id, chapterNo: chapter.chapterNo, kind: 'character_state' },
    }));
  }

  /** 对齐 Worker write_foreshadow_memories：伏笔记忆进入 pending_review，由后续复核决定是否确认。 */
  buildForeshadowMemories(projectId: string, chapter: ChapterMemorySource, foreshadows: ChapterForeshadowMemoryInput[]): MemoryWriterChunkInput[] {
    return foreshadows.map((foreshadow) => ({
      memoryType: 'foreshadow',
      content: foreshadow.detail || foreshadow.title,
      summary: foreshadow.title,
      tags: ['chapter', 'foreshadow'],
      status: 'pending_review',
      importanceScore: 65,
      freshnessScore: 75,
      recencyScore: 75,
      metadata: { foreshadowStatus: foreshadow.status ?? 'planned' },
      sourceTrace: { projectId, chapterId: chapter.id, chapterNo: chapter.chapterNo, kind: 'foreshadow' },
    }));
  }

  /** 对齐 Worker replace_for_source：将抽取出的事实记忆按 generatedBy 原子替换到 MemoryChunk。 */
  replaceGeneratedChapterFactMemories(input: {
    projectId: string;
    chapter: ChapterMemorySource;
    generatedBy: string;
    summary?: string;
    events?: ChapterEventMemoryInput[];
    characterStates?: ChapterCharacterStateMemoryInput[];
    foreshadows?: ChapterForeshadowMemoryInput[];
  }): Promise<MemoryWriterResult> {
    const chunks = [
      ...(input.summary ? [this.buildSummaryMemory(input.projectId, input.chapter, input.summary)] : []),
      ...this.buildEventMemories(input.projectId, input.chapter, input.events ?? []),
      ...this.buildCharacterStateMemories(input.projectId, input.chapter, input.characterStates ?? []),
      ...this.buildForeshadowMemories(input.projectId, input.chapter, input.foreshadows ?? []),
    ];

    return this.replaceGeneratedChapterMemories({
      projectId: input.projectId,
      chapterId: input.chapter.id,
      generatedBy: input.generatedBy,
      chunks,
    });
  }

  private async attachEmbeddings(chunks: MemoryWriterChunkInput[]): Promise<{ vectors: number[][]; model?: string }> {
    if (!chunks.length) return { vectors: [] };

    const result = await this.embeddings.embedTexts(chunks.map((chunk) => `${chunk.summary ?? ''}\n${chunk.content}`.slice(0, 4000)), { appStep: 'embedding', timeoutMs: 60_000, retries: 1 });
    if (result.vectors.length !== chunks.length || result.vectors.some((vector) => !vector?.length)) throw new Error(`embedding 返回数量或内容无效：期望 ${chunks.length}，实际 ${result.vectors.length}`);
    return { vectors: result.vectors, model: result.model };
  }

  private compactJson(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
}