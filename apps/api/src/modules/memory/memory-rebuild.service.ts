import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryWriterService } from './memory-writer.service';

export interface MemoryRebuildResult {
  chapterId: string;
  draftId: string;
  deletedCount: number;
  createdCount: number;
  embeddingAttachedCount: number;
  chunks: Array<{ id: string; memoryType: string; summary: string; status: string }>;
}

export interface MemoryRebuildProjectResult {
  processedChapterCount: number;
  failedChapterCount: number;
  diffSummary: Record<string, { deleted: number; created: number; delta: number }>;
  failedChapters: Array<{ chapterNo?: number; chapterId?: string; error: string }>;
  dryRun: boolean;
}

/**
 * API 内记忆重建服务的确定性过渡实现。
 * 输入项目和章节；输出重建的记忆片段摘要；副作用是替换该章节自动生成的 memory chunk。
 */
@Injectable()
export class MemoryRebuildService {
  constructor(private readonly prisma: PrismaService, private readonly memoryWriter: MemoryWriterService) {}

  /**
   * 重建项目或单章记忆，供旧 memory/rebuild API 与新 Agent Tool 共同复用。
   * dryRun 只计算将删除/创建的自动记忆差异，不修改正式 MemoryChunk 表。
   */
  async rebuildProject(projectId: string, chapterId?: string, dryRun = false): Promise<MemoryRebuildProjectResult> {
    const chapters = await this.prisma.chapter.findMany({
      where: { projectId, ...(chapterId ? { id: chapterId } : {}) },
      orderBy: { chapterNo: 'asc' },
      include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } },
    });

    const diffSummary: MemoryRebuildProjectResult['diffSummary'] = {};
    const failedChapters: MemoryRebuildProjectResult['failedChapters'] = [];

    for (const chapter of chapters) {
      try {
        const draft = chapter.drafts[0];
        if (!draft) {
          diffSummary[`chapter:${chapter.chapterNo}`] = { deleted: 0, created: 0, delta: 0 };
          continue;
        }

        const existingAutoCount = await this.countAgentGeneratedChunks(projectId, chapter.id);
        if (dryRun) {
          const plannedCount = this.buildChunkData(projectId, chapter, draft.content).length;
          // dry-run 使用同一份 chunk 规划逻辑，避免预估数量和真实写入数量长期漂移。
          diffSummary[`chapter:${chapter.chapterNo}`] = { deleted: existingAutoCount, created: plannedCount, delta: plannedCount - existingAutoCount };
          continue;
        }

        const result = await this.rebuildChapter(projectId, chapter.id, draft.id);
        diffSummary[`chapter:${chapter.chapterNo}`] = { deleted: result.deletedCount, created: result.createdCount, delta: result.createdCount - result.deletedCount };
      } catch (error) {
        failedChapters.push({ chapterNo: chapter.chapterNo, chapterId: chapter.id, error: error instanceof Error ? error.message : 'unknown_rebuild_error' });
      }
    }

    return { processedChapterCount: chapters.length - failedChapters.length, failedChapterCount: failedChapters.length, diffSummary, failedChapters, dryRun };
  }

  /**
   * 基于章节当前草稿重建记忆片段。
   * 当前会写入章节摘要、目标/冲突和关键段落，并尽量附加 embedding；embedding 失败时保留关键词召回能力。
   */
  async rebuildChapter(projectId: string, chapterId: string, draftId?: string): Promise<MemoryRebuildResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const draft = draftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: draftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可重建记忆的草稿`);

    const result = await this.memoryWriter.replaceGeneratedChapterMemories({
      projectId,
      chapterId,
      generatedBy: 'agent_memory_rebuild',
      chunks: this.buildChunkData(projectId, chapter, draft.content).map((chunk) => ({
        ...chunk,
        sourceTrace: { ...(chunk.sourceTrace ?? {}), draftId: draft.id },
        metadata: { agentVersion: 'memory_writer_v1' },
      })),
    });

    return {
      chapterId,
      draftId: draft.id,
      deletedCount: result.deletedCount,
      createdCount: result.createdCount,
      embeddingAttachedCount: result.embeddingAttachedCount,
      chunks: result.chunks,
    };
  }

  private buildChunkData(projectId: string, chapter: { id: string; chapterNo: number; title: string | null; objective: string | null; conflict: string | null; revealPoints: string | null; foreshadowPlan: string | null; outline: string | null }, content: string) {
    const outlineParts = [chapter.objective, chapter.conflict, chapter.revealPoints, chapter.foreshadowPlan, chapter.outline].filter(Boolean).join('\n');
    const contentSummary = this.buildSummary(content);
    const keyParagraphs = this.extractKeyParagraphs(content);

    const summaryChunk = this.memoryWriter.buildSummaryMemory(projectId, { id: chapter.id, chapterNo: chapter.chapterNo }, [`第 ${chapter.chapterNo} 章${chapter.title ? `《${chapter.title}》` : ''}`, outlineParts, contentSummary].filter(Boolean).join('\n\n'));

    return [
      {
        ...summaryChunk,
        summary: contentSummary.slice(0, 300),
        tags: ['agent', 'chapter_summary', 'summary', `chapter:${chapter.chapterNo}`],
      },
      ...keyParagraphs.map((paragraph, index) => ({
        memoryType: 'key_scene',
        content: paragraph,
        summary: paragraph.slice(0, 180),
        tags: ['agent', 'key_scene', `chapter:${chapter.chapterNo}`],
        importanceScore: 55 - index * 5,
        freshnessScore: 80,
        recencyScore: 80,
        status: 'auto',
        sourceTrace: { projectId, chapterId: chapter.id, chapterNo: chapter.chapterNo, kind: 'key_scene' },
      })),
    ];
  }

  private extractKeyParagraphs(content: string): string[] {
    const paragraphs = content.split(/\n{2,}/).map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => item.length >= 80);
    // 选取开端、中段、结尾三个关键段落，保证召回既覆盖目标进入，也覆盖转折和钩子。
    const candidates = [paragraphs[0], paragraphs[Math.floor(paragraphs.length / 2)], paragraphs[paragraphs.length - 1]].filter(Boolean) as string[];
    return [...new Set(candidates)].slice(0, 3).map((item) => (item.length > 700 ? `${item.slice(0, 700)}…` : item));
  }

  private buildSummary(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length > 800 ? `${normalized.slice(0, 800)}…` : normalized;
  }

  private countAgentGeneratedChunks(projectId: string, chapterId: string) {
    return this.prisma.memoryChunk.count({
      where: { projectId, sourceType: 'chapter', sourceId: chapterId, metadata: { path: ['generatedBy'], equals: 'agent_memory_rebuild' } },
    });
  }
}