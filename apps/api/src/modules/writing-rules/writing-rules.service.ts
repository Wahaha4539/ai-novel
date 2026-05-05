import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWritingRuleDto } from './dto/create-writing-rule.dto';
import { ListWritingRulesQueryDto } from './dto/list-writing-rules-query.dto';
import { UpdateWritingRuleDto } from './dto/update-writing-rule.dto';

@Injectable()
export class WritingRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateWritingRuleDto) {
    await this.assertProjectExists(projectId);
    this.assertValidChapterRange(dto.appliesFromChapterNo, dto.appliesToChapterNo);

    const rule = await this.prisma.writingRule.create({
      data: {
        projectId,
        ruleType: dto.ruleType,
        title: dto.title,
        content: dto.content,
        severity: dto.severity ?? 'info',
        appliesFromChapterNo: dto.appliesFromChapterNo,
        appliesToChapterNo: dto.appliesToChapterNo,
        entityType: dto.entityType,
        entityRef: dto.entityRef,
        status: dto.status ?? 'active',
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return rule;
  }

  async list(projectId: string, query: ListWritingRulesQueryDto = {}) {
    await this.assertProjectExists(projectId);
    return this.prisma.writingRule.findMany({
      where: this.buildWhere(projectId, query),
      orderBy: [{ appliesFromChapterNo: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async update(projectId: string, ruleId: string, dto: UpdateWritingRuleDto) {
    const existing = await this.prisma.writingRule.findFirst({ where: { id: ruleId, projectId } });
    if (!existing) {
      throw new NotFoundException(`WritingRule not found: ${ruleId}`);
    }
    const nextFrom = dto.appliesFromChapterNo !== undefined ? dto.appliesFromChapterNo : existing.appliesFromChapterNo;
    const nextTo = dto.appliesToChapterNo !== undefined ? dto.appliesToChapterNo : existing.appliesToChapterNo;
    this.assertValidChapterRange(nextFrom, nextTo);

    const updated = await this.prisma.writingRule.update({
      where: { id: ruleId },
      data: {
        ...(dto.ruleType !== undefined && { ruleType: dto.ruleType }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.severity !== undefined && { severity: dto.severity }),
        ...(dto.appliesFromChapterNo !== undefined && { appliesFromChapterNo: dto.appliesFromChapterNo }),
        ...(dto.appliesToChapterNo !== undefined && { appliesToChapterNo: dto.appliesToChapterNo }),
        ...(dto.entityType !== undefined && { entityType: dto.entityType }),
        ...(dto.entityRef !== undefined && { entityRef: dto.entityRef }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, ruleId: string) {
    const existing = await this.prisma.writingRule.findFirst({ where: { id: ruleId, projectId } });
    if (!existing) {
      throw new NotFoundException(`WritingRule not found: ${ruleId}`);
    }

    await this.prisma.writingRule.delete({ where: { id: ruleId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: ruleId };
  }

  private buildWhere(projectId: string, query: ListWritingRulesQueryDto): Prisma.WritingRuleWhereInput {
    const rangeFilter = typeof query.chapterNo === 'number'
      ? {
          AND: [
            { OR: [{ appliesFromChapterNo: null }, { appliesFromChapterNo: { lte: query.chapterNo } }] },
            { OR: [{ appliesToChapterNo: null }, { appliesToChapterNo: { gte: query.chapterNo } }] },
          ],
        }
      : {};

    return {
      projectId,
      ...(query.ruleType ? { ruleType: query.ruleType } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityRef ? { entityRef: query.entityRef } : {}),
      ...rangeFilter,
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { content: { contains: query.q, mode: 'insensitive' } },
              { entityRef: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }

  private assertValidChapterRange(from?: number | null, to?: number | null) {
    if (typeof from === 'number' && typeof to === 'number' && from > to) {
      throw new BadRequestException('WritingRule chapter range is invalid: appliesFromChapterNo must be <= appliesToChapterNo.');
    }
  }
}
