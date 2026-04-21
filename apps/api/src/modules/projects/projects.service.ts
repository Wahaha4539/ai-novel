import { Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async list() {
    const projects = await this.prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        _count: {
          select: {
            chapters: true,
            characters: true,
            lorebookEntries: true,
            generationJobs: true,
            memoryChunks: true,
            storyEvents: true,
            characterStateSnapshots: true,
            foreshadowTracks: true,
          },
        },
      },
    });

    return projects.map(({ _count, ...project }) => ({
      ...project,
      stats: {
        chapterCount: _count.chapters,
        characterCount: _count.characters,
        lorebookCount: _count.lorebookEntries,
        jobCount: _count.generationJobs,
        memoryChunkCount: _count.memoryChunks,
        storyEventCount: _count.storyEvents,
        characterStateSnapshotCount: _count.characterStateSnapshots,
        foreshadowTrackCount: _count.foreshadowTracks,
      },
    }));
  }

  async create(dto: CreateProjectDto) {
    const project = await this.prisma.project.create({
      data: {
        title: dto.title,
        genre: dto.genre,
        theme: dto.theme,
        tone: dto.tone,
        targetWordCount: dto.targetWordCount,
      },
    });

    await this.cacheService.setProjectSnapshot(project.id, {
      id: project.id,
      title: project.title,
      genre: project.genre,
      theme: project.theme,
      tone: project.tone,
      synopsis: project.synopsis ?? null,
    });

    return project;
  }

  async getDetail(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const [chapterCount, characterCount, lorebookCount, jobCount] = await this.prisma.$transaction([
      this.prisma.chapter.count({ where: { projectId } }),
      this.prisma.character.count({ where: { projectId } }),
      this.prisma.lorebookEntry.count({ where: { projectId } }),
      this.prisma.generationJob.count({ where: { projectId } }),
    ]);

    return {
      ...project,
      stats: {
        chapterCount,
        characterCount,
        lorebookCount,
        jobCount,
      },
      defaults: {
        styleProfileId: project.defaultStyleProfileId,
        modelProfileId: project.defaultModelProfileId,
      },
    };
  }
}
