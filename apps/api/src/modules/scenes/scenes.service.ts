import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSceneDto } from './dto/create-scene.dto';
import { ListScenesQueryDto } from './dto/list-scenes-query.dto';
import { UpdateSceneDto } from './dto/update-scene.dto';

type SceneRefs = { volumeId: string | null; chapterId: string | null };

@Injectable()
export class ScenesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateSceneDto) {
    await this.assertProjectExists(projectId);
    const refs = await this.resolveRefs(projectId, dto.volumeId, dto.chapterId);

    const scene = await this.prisma.sceneCard.create({
      data: {
        projectId,
        volumeId: refs.volumeId,
        chapterId: refs.chapterId,
        sceneNo: dto.sceneNo,
        title: dto.title,
        locationName: dto.locationName,
        participants: this.normalizeStringArray(dto.participants, 'participants') as Prisma.InputJsonValue,
        purpose: dto.purpose,
        conflict: dto.conflict,
        emotionalTone: dto.emotionalTone,
        keyInformation: dto.keyInformation,
        result: dto.result,
        relatedForeshadowIds: this.normalizeStringArray(dto.relatedForeshadowIds, 'relatedForeshadowIds') as Prisma.InputJsonValue,
        status: dto.status ?? 'planned',
        metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return scene;
  }

  async list(projectId: string, query: ListScenesQueryDto = {}) {
    await this.assertProjectExists(projectId);
    const chapterId = typeof query.chapterNo === 'number'
      ? await this.findChapterIdByNo(projectId, query.chapterNo)
      : query.chapterId;
    if (typeof query.chapterNo === 'number' && !chapterId) return [];

    return this.prisma.sceneCard.findMany({
      where: this.buildWhere(projectId, { ...query, chapterId }),
      orderBy: [{ chapterId: 'asc' }, { sceneNo: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async update(projectId: string, sceneId: string, dto: UpdateSceneDto) {
    const existing = await this.prisma.sceneCard.findFirst({
      where: { id: sceneId, projectId },
      select: { id: true, projectId: true, volumeId: true, chapterId: true },
    });
    if (!existing) {
      throw new NotFoundException(`SceneCard not found: ${sceneId}`);
    }

    const refs = dto.volumeId !== undefined || dto.chapterId !== undefined
      ? await this.resolveRefs(
          projectId,
          dto.volumeId !== undefined ? dto.volumeId : existing.volumeId,
          dto.chapterId !== undefined ? dto.chapterId : existing.chapterId,
        )
      : undefined;

    const updated = await this.prisma.sceneCard.update({
      where: { id: sceneId },
      data: {
        ...(refs !== undefined && { volumeId: refs.volumeId, chapterId: refs.chapterId }),
        ...(dto.sceneNo !== undefined && { sceneNo: dto.sceneNo }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.locationName !== undefined && { locationName: dto.locationName }),
        ...(dto.participants !== undefined && { participants: this.normalizeStringArray(dto.participants, 'participants') as Prisma.InputJsonValue }),
        ...(dto.purpose !== undefined && { purpose: dto.purpose }),
        ...(dto.conflict !== undefined && { conflict: dto.conflict }),
        ...(dto.emotionalTone !== undefined && { emotionalTone: dto.emotionalTone }),
        ...(dto.keyInformation !== undefined && { keyInformation: dto.keyInformation }),
        ...(dto.result !== undefined && { result: dto.result }),
        ...(dto.relatedForeshadowIds !== undefined && { relatedForeshadowIds: this.normalizeStringArray(dto.relatedForeshadowIds, 'relatedForeshadowIds') as Prisma.InputJsonValue }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.metadata !== undefined && { metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, sceneId: string) {
    const existing = await this.prisma.sceneCard.findFirst({
      where: { id: sceneId, projectId },
      select: { id: true, projectId: true },
    });
    if (!existing) {
      throw new NotFoundException(`SceneCard not found: ${sceneId}`);
    }

    await this.prisma.sceneCard.delete({ where: { id: sceneId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: sceneId };
  }

  private buildWhere(projectId: string, query: ListScenesQueryDto): Prisma.SceneCardWhereInput {
    return {
      projectId,
      ...(query.volumeId ? { volumeId: query.volumeId } : {}),
      ...(query.chapterId ? { chapterId: query.chapterId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { locationName: { contains: query.q, mode: 'insensitive' } },
              { purpose: { contains: query.q, mode: 'insensitive' } },
              { conflict: { contains: query.q, mode: 'insensitive' } },
              { keyInformation: { contains: query.q, mode: 'insensitive' } },
              { result: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async resolveRefs(projectId: string, volumeId?: string | null, chapterId?: string | null): Promise<SceneRefs> {
    const volume = volumeId
      ? await this.prisma.volume.findFirst({ where: { id: volumeId, projectId }, select: { id: true } })
      : null;
    if (volumeId && !volume) {
      throw new NotFoundException(`Volume not found in project: ${volumeId}`);
    }

    const chapter = chapterId
      ? await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, select: { id: true, volumeId: true } })
      : null;
    if (chapterId && !chapter) {
      throw new NotFoundException(`Chapter not found in project: ${chapterId}`);
    }
    if (chapter && volumeId && chapter.volumeId !== volumeId) {
      throw new BadRequestException(`chapterId does not belong to volumeId: ${chapterId}`);
    }

    return {
      volumeId: chapter ? chapter.volumeId : volumeId ?? null,
      chapterId: chapterId ?? null,
    };
  }

  private async findChapterIdByNo(projectId: string, chapterNo: number): Promise<string | undefined> {
    const chapter = await this.prisma.chapter.findFirst({ where: { projectId, chapterNo }, select: { id: true } });
    return chapter?.id;
  }

  private normalizeStringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array of strings.`);
    }
    if (value.some((item) => typeof item !== 'string')) {
      throw new BadRequestException(`${field} must contain only strings.`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  }

  private normalizeJsonObject(value: unknown, field: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }
}
