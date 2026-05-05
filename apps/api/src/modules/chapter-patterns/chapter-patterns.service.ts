import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterPatternDto } from './dto/create-chapter-pattern.dto';
import { ListChapterPatternsQueryDto } from './dto/list-chapter-patterns-query.dto';
import { UpdateChapterPatternDto } from './dto/update-chapter-pattern.dto';

@Injectable()
export class ChapterPatternsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateChapterPatternDto) {
    await this.assertProjectExists(projectId);

    const pattern = await this.prisma.chapterPattern.create({
      data: {
        projectId,
        patternType: dto.patternType,
        name: dto.name,
        applicableScenes: this.normalizeStringArray(dto.applicableScenes, 'applicableScenes') as Prisma.InputJsonValue,
        structure: this.normalizeJsonObject(dto.structure, 'structure') as Prisma.InputJsonValue,
        pacingAdvice: this.normalizeJsonObject(dto.pacingAdvice, 'pacingAdvice') as Prisma.InputJsonValue,
        emotionalAdvice: this.normalizeJsonObject(dto.emotionalAdvice, 'emotionalAdvice') as Prisma.InputJsonValue,
        conflictAdvice: this.normalizeJsonObject(dto.conflictAdvice, 'conflictAdvice') as Prisma.InputJsonValue,
        status: dto.status ?? 'active',
        metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return pattern;
  }

  async list(projectId: string, query: ListChapterPatternsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    return this.prisma.chapterPattern.findMany({
      where: this.buildWhere(projectId, query),
      orderBy: [{ patternType: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async update(projectId: string, patternId: string, dto: UpdateChapterPatternDto) {
    const existing = await this.prisma.chapterPattern.findFirst({
      where: { id: patternId, projectId },
      select: { id: true, projectId: true },
    });
    if (!existing) {
      throw new NotFoundException(`ChapterPattern not found: ${patternId}`);
    }

    const updated = await this.prisma.chapterPattern.update({
      where: { id: patternId },
      data: {
        ...(dto.patternType !== undefined && { patternType: dto.patternType }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.applicableScenes !== undefined && { applicableScenes: this.normalizeStringArray(dto.applicableScenes, 'applicableScenes') as Prisma.InputJsonValue }),
        ...(dto.structure !== undefined && { structure: this.normalizeJsonObject(dto.structure, 'structure') as Prisma.InputJsonValue }),
        ...(dto.pacingAdvice !== undefined && { pacingAdvice: this.normalizeJsonObject(dto.pacingAdvice, 'pacingAdvice') as Prisma.InputJsonValue }),
        ...(dto.emotionalAdvice !== undefined && { emotionalAdvice: this.normalizeJsonObject(dto.emotionalAdvice, 'emotionalAdvice') as Prisma.InputJsonValue }),
        ...(dto.conflictAdvice !== undefined && { conflictAdvice: this.normalizeJsonObject(dto.conflictAdvice, 'conflictAdvice') as Prisma.InputJsonValue }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.metadata !== undefined && { metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, patternId: string) {
    const existing = await this.prisma.chapterPattern.findFirst({
      where: { id: patternId, projectId },
      select: { id: true, projectId: true },
    });
    if (!existing) {
      throw new NotFoundException(`ChapterPattern not found: ${patternId}`);
    }

    await this.prisma.chapterPattern.delete({ where: { id: patternId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: patternId };
  }

  private buildWhere(projectId: string, query: ListChapterPatternsQueryDto): Prisma.ChapterPatternWhereInput {
    return {
      projectId,
      ...(query.patternType ? { patternType: query.patternType } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { patternType: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
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
