import { Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';

@Injectable()
export class ChaptersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateChapterDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const chapter = await this.prisma.chapter.create({
      data: {
        projectId,
        chapterNo: dto.chapterNo,
        title: dto.title,
        objective: dto.objective,
        conflict: dto.conflict,
        outline: dto.outline,
        expectedWordCount: dto.expectedWordCount,
      },
    });

    await this.refreshChapterContext(projectId, chapter.id);
    return chapter;
  }

  listByProject(projectId: string) {
    return this.prisma.chapter.findMany({
      where: { projectId },
      orderBy: { chapterNo: 'asc' },
    });
  }

  async getById(chapterId: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      throw new NotFoundException(`章节不存在：${chapterId}`);
    }

    return chapter;
  }

  /**
   * Return the latest (isCurrent=true) draft for a chapter, or null if none exists.
   * Used by the frontend EditorPanel to display AI-generated content.
   */
  async getLatestDraft(chapterId: string) {
    const draft = await this.prisma.chapterDraft.findFirst({
      where: { chapterId, isCurrent: true },
      orderBy: { versionNo: 'desc' },
    });
    return draft;
  }

  /**
   * Return all draft versions for a chapter, ordered newest first.
   * Used by the frontend to show draft history / version switching.
   */
  async listDrafts(chapterId: string) {
    return this.prisma.chapterDraft.findMany({
      where: { chapterId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        chapterId: true,
        versionNo: true,
        content: true,
        source: true,
        modelInfo: true,
        isCurrent: true,
        createdAt: true,
      },
    });
  }

  async markDrafted(chapterId: string, actualWordCount: number) {
    const chapter = await this.getById(chapterId);
    const updatedChapter = await this.prisma.chapter.update({
      where: { id: chapterId },
      data: {
        status: 'drafted',
        actualWordCount,
      },
    });

    await this.refreshChapterContext(chapter.projectId, updatedChapter.id);
    return updatedChapter;
  }

  private async refreshChapterContext(projectId: string, chapterId: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      await this.cacheService.deleteChapterContext(projectId, chapterId);
      return;
    }

    const relatedCharacters = await this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    await this.cacheService.setChapterContext(projectId, chapterId, {
      chapter: {
        id: chapter.id,
        projectId: chapter.projectId,
        chapterNo: chapter.chapterNo,
        title: chapter.title,
        objective: chapter.objective,
        conflict: chapter.conflict,
        outline: chapter.outline,
        expectedWordCount: chapter.expectedWordCount ?? null,
        status: chapter.status,
        actualWordCount: chapter.actualWordCount ?? null,
      },
      relatedCharacters: relatedCharacters.map((item) => ({
        id: item.id,
        name: item.name,
        roleType: item.roleType,
        speechStyle: item.speechStyle,
      })),
    });
  }
}
