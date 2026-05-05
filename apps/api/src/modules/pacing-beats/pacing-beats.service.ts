import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePacingBeatDto } from './dto/create-pacing-beat.dto';
import { ListPacingBeatsQueryDto } from './dto/list-pacing-beats-query.dto';
import { UpdatePacingBeatDto } from './dto/update-pacing-beat.dto';

type PacingRefs = { volumeId: string | null; chapterId: string | null; chapterNo: number | null };

@Injectable()
export class PacingBeatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreatePacingBeatDto) {
    await this.assertProjectExists(projectId);
    this.assertLevel('emotionalIntensity', dto.emotionalIntensity);
    this.assertLevel('tensionLevel', dto.tensionLevel);
    this.assertLevel('payoffLevel', dto.payoffLevel);
    const refs = await this.resolveRefs(projectId, dto.volumeId, dto.chapterId, dto.chapterNo);

    const beat = await this.prisma.pacingBeat.create({
      data: {
        projectId,
        volumeId: refs.volumeId,
        chapterId: refs.chapterId,
        chapterNo: refs.chapterNo,
        beatType: dto.beatType,
        emotionalTone: dto.emotionalTone,
        emotionalIntensity: dto.emotionalIntensity ?? 50,
        tensionLevel: dto.tensionLevel ?? 50,
        payoffLevel: dto.payoffLevel ?? 50,
        notes: dto.notes,
        metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return beat;
  }

  async list(projectId: string, query: ListPacingBeatsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    return this.prisma.pacingBeat.findMany({
      where: this.buildWhere(projectId, query),
      orderBy: [{ chapterNo: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async update(projectId: string, beatId: string, dto: UpdatePacingBeatDto) {
    const existing = await this.prisma.pacingBeat.findFirst({
      where: { id: beatId, projectId },
      select: { id: true, projectId: true, volumeId: true, chapterId: true, chapterNo: true },
    });
    if (!existing) {
      throw new NotFoundException(`PacingBeat not found: ${beatId}`);
    }

    this.assertLevel('emotionalIntensity', dto.emotionalIntensity);
    this.assertLevel('tensionLevel', dto.tensionLevel);
    this.assertLevel('payoffLevel', dto.payoffLevel);

    const refs = dto.volumeId !== undefined || dto.chapterId !== undefined || dto.chapterNo !== undefined
      ? await this.resolveRefs(
          projectId,
          dto.volumeId !== undefined ? dto.volumeId : existing.volumeId,
          dto.chapterId !== undefined ? dto.chapterId : existing.chapterId,
          dto.chapterNo !== undefined ? dto.chapterNo : existing.chapterNo,
        )
      : undefined;

    const updated = await this.prisma.pacingBeat.update({
      where: { id: beatId },
      data: {
        ...(refs !== undefined && { volumeId: refs.volumeId, chapterId: refs.chapterId, chapterNo: refs.chapterNo }),
        ...(dto.beatType !== undefined && { beatType: dto.beatType }),
        ...(dto.emotionalTone !== undefined && { emotionalTone: dto.emotionalTone }),
        ...(dto.emotionalIntensity !== undefined && { emotionalIntensity: dto.emotionalIntensity }),
        ...(dto.tensionLevel !== undefined && { tensionLevel: dto.tensionLevel }),
        ...(dto.payoffLevel !== undefined && { payoffLevel: dto.payoffLevel }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.metadata !== undefined && { metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, beatId: string) {
    const existing = await this.prisma.pacingBeat.findFirst({
      where: { id: beatId, projectId },
      select: { id: true, projectId: true },
    });
    if (!existing) {
      throw new NotFoundException(`PacingBeat not found: ${beatId}`);
    }

    await this.prisma.pacingBeat.delete({ where: { id: beatId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: beatId };
  }

  private buildWhere(projectId: string, query: ListPacingBeatsQueryDto): Prisma.PacingBeatWhereInput {
    return {
      projectId,
      ...(query.volumeId ? { volumeId: query.volumeId } : {}),
      ...(query.chapterId ? { chapterId: query.chapterId } : {}),
      ...(typeof query.chapterNo === 'number' ? { chapterNo: query.chapterNo } : {}),
      ...(query.beatType ? { beatType: query.beatType } : {}),
      ...(query.q
        ? {
            OR: [
              { beatType: { contains: query.q, mode: 'insensitive' } },
              { emotionalTone: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async resolveRefs(projectId: string, volumeId?: string | null, chapterId?: string | null, chapterNo?: number | null): Promise<PacingRefs> {
    const volume = volumeId
      ? await this.prisma.volume.findFirst({ where: { id: volumeId, projectId }, select: { id: true } })
      : null;
    if (volumeId && !volume) {
      throw new NotFoundException(`Volume not found in project: ${volumeId}`);
    }

    const chapter = chapterId || chapterNo != null
      ? await this.prisma.chapter.findFirst({
          where: chapterId ? { id: chapterId, projectId } : { projectId, chapterNo: chapterNo as number },
          select: { id: true, chapterNo: true, volumeId: true },
        })
      : null;
    if ((chapterId || chapterNo != null) && !chapter) {
      throw new NotFoundException(chapterId ? `Chapter not found in project: ${chapterId}` : `Chapter number not found in project: ${chapterNo}`);
    }
    if (chapter && chapterNo != null && chapter.chapterNo !== chapterNo) {
      throw new BadRequestException(`chapterNo does not match chapterId: ${chapterNo} != ${chapter.chapterNo}`);
    }
    if (chapter && volumeId && chapter.volumeId !== volumeId) {
      throw new BadRequestException(`chapterId does not belong to volumeId: ${chapter.id}`);
    }

    return {
      volumeId: chapter ? chapter.volumeId : volumeId ?? null,
      chapterId: chapter?.id ?? chapterId ?? null,
      chapterNo: chapter?.chapterNo ?? chapterNo ?? null,
    };
  }

  private assertLevel(field: string, value?: number) {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new BadRequestException(`${field} must be an integer between 0 and 100.`);
    }
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
