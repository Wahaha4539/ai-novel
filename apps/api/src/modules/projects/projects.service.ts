import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateCreativeProfileDto } from './dto/update-creative-profile.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

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

  async update(projectId: string, dto: UpdateProjectDto) {
    const existing = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!existing) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.genre !== undefined && { genre: dto.genre }),
        ...(dto.theme !== undefined && { theme: dto.theme }),
        ...(dto.tone !== undefined && { tone: dto.tone }),
        ...(dto.targetWordCount !== undefined && { targetWordCount: dto.targetWordCount }),
        ...(dto.synopsis !== undefined && { synopsis: dto.synopsis }),
        ...(dto.outline !== undefined && { outline: dto.outline }),
      },
    });

    await this.cacheService.setProjectSnapshot(updated.id, {
      id: updated.id,
      title: updated.title,
      genre: updated.genre,
      theme: updated.theme,
      tone: updated.tone,
      synopsis: updated.synopsis ?? null,
    });

    return updated;
  }

  async getCreativeProfile(projectId: string) {
    await this.assertProjectExists(projectId);

    const profile = await this.prisma.projectCreativeProfile.findUnique({ where: { projectId } });
    return profile ?? this.buildCreativeProfileDefaults(projectId);
  }

  async updateCreativeProfile(projectId: string, dto: UpdateCreativeProfileDto) {
    await this.assertProjectExists(projectId);

    return this.prisma.projectCreativeProfile.upsert({
      where: { projectId },
      create: this.buildCreativeProfileData(projectId, dto),
      update: this.buildCreativeProfilePatch(dto),
    });
  }

  async remove(projectId: string) {
    const existing = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!existing) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    // Prisma schema has onDelete: Cascade on all relations, so this will cascade delete all related data
    await this.prisma.project.delete({
      where: { id: projectId },
    });

    await this.cacheService.deleteProjectSnapshot(projectId);

    return { deleted: true, id: projectId };
  }

  private async assertProjectExists(projectId: string) {
    const existing = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!existing) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }
  }

  private buildCreativeProfileData(projectId: string, dto: UpdateCreativeProfileDto): Prisma.ProjectCreativeProfileUncheckedCreateInput {
    return {
      projectId,
      audienceType: dto.audienceType,
      platformTarget: dto.platformTarget,
      sellingPoints: dto.sellingPoints ?? [],
      pacingPreference: dto.pacingPreference,
      targetWordCount: dto.targetWordCount,
      chapterWordCount: dto.chapterWordCount,
      contentRating: dto.contentRating,
      centralConflict: (dto.centralConflict ?? {}) as Prisma.InputJsonValue,
      generationDefaults: (dto.generationDefaults ?? {}) as Prisma.InputJsonValue,
      validationDefaults: (dto.validationDefaults ?? {}) as Prisma.InputJsonValue,
    };
  }

  private buildCreativeProfilePatch(dto: UpdateCreativeProfileDto): Prisma.ProjectCreativeProfileUncheckedUpdateInput {
    return {
      ...(dto.audienceType !== undefined && { audienceType: dto.audienceType }),
      ...(dto.platformTarget !== undefined && { platformTarget: dto.platformTarget }),
      ...(dto.sellingPoints !== undefined && { sellingPoints: dto.sellingPoints ?? [] }),
      ...(dto.pacingPreference !== undefined && { pacingPreference: dto.pacingPreference }),
      ...(dto.targetWordCount !== undefined && { targetWordCount: dto.targetWordCount }),
      ...(dto.chapterWordCount !== undefined && { chapterWordCount: dto.chapterWordCount }),
      ...(dto.contentRating !== undefined && { contentRating: dto.contentRating }),
      ...(dto.centralConflict !== undefined && { centralConflict: dto.centralConflict as Prisma.InputJsonValue }),
      ...(dto.generationDefaults !== undefined && { generationDefaults: dto.generationDefaults as Prisma.InputJsonValue }),
      ...(dto.validationDefaults !== undefined && { validationDefaults: dto.validationDefaults as Prisma.InputJsonValue }),
    };
  }

  private buildCreativeProfileDefaults(projectId: string) {
    return {
      projectId,
      audienceType: null,
      platformTarget: null,
      sellingPoints: [],
      pacingPreference: null,
      targetWordCount: null,
      chapterWordCount: null,
      contentRating: null,
      centralConflict: {},
      generationDefaults: {},
      validationDefaults: {},
      createdAt: null,
      updatedAt: null,
    };
  }
}

