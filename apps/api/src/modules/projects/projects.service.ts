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
