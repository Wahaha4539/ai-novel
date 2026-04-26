import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface PostProcessChapterResult {
  draftId: string;
  chapterId: string;
  actualWordCount: number;
  summary: string;
  steps: Array<Record<string, unknown>>;
}

/**
 * 章节后处理服务的 API 内最小实现。
 * 当前阶段只做确定性清理、当前草稿重写与字数同步；润色、记忆重建和自动修复后续逐步迁入。
 */
@Injectable()
export class PostProcessChapterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 对章节当前草稿进行轻量确定性后处理。
   * 输入项目与章节 ID；输出最终草稿元数据；副作用是必要时创建新草稿版本并更新章节字数。
   */
  async run(projectId: string, chapterId: string, sourceDraftId?: string): Promise<PostProcessChapterResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const draft = sourceDraftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: sourceDraftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可后处理的草稿`);

    const normalized = this.normalizeContent(draft.content);
    const actualWordCount = this.countChineseLikeWords(normalized);
    const steps: Array<Record<string, unknown>> = [
      { step: 'normalize_text', changed: normalized !== draft.content, sourceDraftId: draft.id, wordCount: actualWordCount },
    ];

    // 只有内容确实发生变化才创建新版本，避免 Agent 每次执行都产生无意义草稿。
    const finalDraft =
      normalized === draft.content
        ? draft
        : await this.prisma.$transaction(async (tx) => {
            const latest = await tx.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
            await tx.chapterDraft.updateMany({ where: { chapterId, isCurrent: true }, data: { isCurrent: false } });
            return tx.chapterDraft.create({
              data: {
                chapterId,
                versionNo: (latest?.versionNo ?? 0) + 1,
                content: normalized,
                source: 'agent_postprocess',
                modelInfo: (draft.modelInfo ?? {}) as Prisma.InputJsonValue,
                generationContext: { sourceDraftId: draft.id, postprocess: 'normalize_text' } as Prisma.InputJsonValue,
                isCurrent: true,
                createdBy: draft.createdBy,
              },
            });
          });

    await this.prisma.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount } });

    return { draftId: finalDraft.id, chapterId, actualWordCount, summary: normalized.slice(0, 160), steps };
  }

  private normalizeContent(content: string): string {
    return content
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private countChineseLikeWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }
}