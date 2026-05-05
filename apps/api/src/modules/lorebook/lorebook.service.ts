import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLorebookEntryDto } from './dto/create-lorebook-entry.dto';
import { ListLorebookQueryDto } from './dto/list-lorebook-query.dto';
import { UpdateLorebookEntryDto } from './dto/update-lorebook-entry.dto';
import { expandLorebookEntryTypeAliases, normalizeLorebookEntryType } from './lorebook-entry-types';

@Injectable()
export class LorebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateLorebookEntryDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const entry = await this.prisma.lorebookEntry.create({
      data: {
        projectId,
        title: dto.title,
        entryType: normalizeLorebookEntryType(dto.entryType),
        content: dto.content,
        summary: dto.summary,
        tags: dto.tags ?? [],
        priority: dto.priority ?? 50,
        triggerKeywords: dto.triggerKeywords ?? [],
        relatedEntityIds: dto.relatedEntityIds ?? [],
        status: dto.status ?? 'active',
        sourceType: dto.sourceType ?? 'manual',
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return entry;
  }

  async list(projectId: string, query: ListLorebookQueryDto = {}) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const rows = await this.prisma.lorebookEntry.findMany({
      where: {
        projectId,
        ...(query.entryType ? { entryType: { in: expandLorebookEntryTypeAliases(query.entryType) } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { content: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });

    return query.tag ? rows.filter((row) => this.readStringArray(row.tags).includes(query.tag as string)) : rows;
  }

  async update(projectId: string, entryId: string, dto: UpdateLorebookEntryDto) {
    const existing = await this.prisma.lorebookEntry.findFirst({ where: { id: entryId, projectId } });
    if (!existing) {
      throw new NotFoundException(`设定条目不存在：${entryId}`);
    }

    const updated = await this.prisma.lorebookEntry.update({
      where: { id: entryId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.entryType !== undefined && { entryType: normalizeLorebookEntryType(dto.entryType) }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.summary !== undefined && { summary: dto.summary }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.triggerKeywords !== undefined && { triggerKeywords: dto.triggerKeywords }),
        ...(dto.relatedEntityIds !== undefined && { relatedEntityIds: dto.relatedEntityIds }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.sourceType !== undefined && { sourceType: dto.sourceType }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, entryId: string) {
    const existing = await this.prisma.lorebookEntry.findFirst({ where: { id: entryId, projectId } });
    if (!existing) {
      throw new NotFoundException(`设定条目不存在：${entryId}`);
    }

    await this.prisma.lorebookEntry.delete({ where: { id: entryId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: entryId };
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
}
