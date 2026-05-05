import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { ListRelationshipsQueryDto } from './dto/list-relationships-query.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';

@Injectable()
export class RelationshipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateRelationshipDto) {
    await this.assertProjectExists(projectId);
    await this.assertCharactersMatchProject(projectId, [
      { id: dto.characterAId, name: dto.characterAName, label: 'characterA' },
      { id: dto.characterBId, name: dto.characterBName, label: 'characterB' },
    ]);

    const relationship = await this.prisma.relationshipEdge.create({
      data: {
        projectId,
        characterAId: dto.characterAId,
        characterBId: dto.characterBId,
        characterAName: dto.characterAName,
        characterBName: dto.characterBName,
        relationType: dto.relationType,
        publicState: dto.publicState,
        hiddenState: dto.hiddenState,
        conflictPoint: dto.conflictPoint,
        emotionalArc: dto.emotionalArc,
        turnChapterNos: (dto.turnChapterNos ?? []) as Prisma.InputJsonValue,
        finalState: dto.finalState,
        status: dto.status ?? 'active',
        sourceType: dto.sourceType ?? 'manual',
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return relationship;
  }

  async list(projectId: string, query: ListRelationshipsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.relationshipEdge.findMany({
      where: this.buildWhere(projectId, query),
      orderBy: [{ updatedAt: 'desc' }],
    });

    return typeof query.chapterNo === 'number'
      ? rows.filter((row) => this.isVisibleAtChapter(row.turnChapterNos, query.chapterNo as number))
      : rows;
  }

  async update(projectId: string, relationshipId: string, dto: UpdateRelationshipDto) {
    const existing = await this.prisma.relationshipEdge.findFirst({ where: { id: relationshipId, projectId } });
    if (!existing) {
      throw new NotFoundException(`RelationshipEdge not found: ${relationshipId}`);
    }
    const nextCharacterAId = dto.characterAId !== undefined ? dto.characterAId : existing.characterAId;
    const nextCharacterBId = dto.characterBId !== undefined ? dto.characterBId : existing.characterBId;
    await this.assertCharactersMatchProject(projectId, [
      { id: nextCharacterAId, name: dto.characterAName !== undefined ? dto.characterAName : existing.characterAName, label: 'characterA' },
      { id: nextCharacterBId, name: dto.characterBName !== undefined ? dto.characterBName : existing.characterBName, label: 'characterB' },
    ]);

    const updated = await this.prisma.relationshipEdge.update({
      where: { id: relationshipId },
      data: {
        ...(dto.characterAId !== undefined && { characterAId: dto.characterAId }),
        ...(dto.characterBId !== undefined && { characterBId: dto.characterBId }),
        ...(dto.characterAName !== undefined && { characterAName: dto.characterAName }),
        ...(dto.characterBName !== undefined && { characterBName: dto.characterBName }),
        ...(dto.relationType !== undefined && { relationType: dto.relationType }),
        ...(dto.publicState !== undefined && { publicState: dto.publicState }),
        ...(dto.hiddenState !== undefined && { hiddenState: dto.hiddenState }),
        ...(dto.conflictPoint !== undefined && { conflictPoint: dto.conflictPoint }),
        ...(dto.emotionalArc !== undefined && { emotionalArc: dto.emotionalArc }),
        ...(dto.turnChapterNos !== undefined && { turnChapterNos: dto.turnChapterNos as Prisma.InputJsonValue }),
        ...(dto.finalState !== undefined && { finalState: dto.finalState }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.sourceType !== undefined && { sourceType: dto.sourceType }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, relationshipId: string) {
    const existing = await this.prisma.relationshipEdge.findFirst({ where: { id: relationshipId, projectId } });
    if (!existing) {
      throw new NotFoundException(`RelationshipEdge not found: ${relationshipId}`);
    }

    await this.prisma.relationshipEdge.delete({ where: { id: relationshipId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: relationshipId };
  }

  private buildWhere(projectId: string, query: ListRelationshipsQueryDto): Prisma.RelationshipEdgeWhereInput {
    const and: Prisma.RelationshipEdgeWhereInput[] = [];
    if (query.characterName) {
      and.push({
        OR: [
          { characterAName: { contains: query.characterName, mode: 'insensitive' } },
          { characterBName: { contains: query.characterName, mode: 'insensitive' } },
        ],
      });
    }
    if (query.q) {
      and.push({
        OR: [
          { characterAName: { contains: query.q, mode: 'insensitive' } },
          { characterBName: { contains: query.q, mode: 'insensitive' } },
          { relationType: { contains: query.q, mode: 'insensitive' } },
          { publicState: { contains: query.q, mode: 'insensitive' } },
          { hiddenState: { contains: query.q, mode: 'insensitive' } },
          { conflictPoint: { contains: query.q, mode: 'insensitive' } },
          { emotionalArc: { contains: query.q, mode: 'insensitive' } },
          { finalState: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    return {
      projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(and.length ? { AND: and } : {}),
    };
  }

  private isVisibleAtChapter(value: unknown, chapterNo: number): boolean {
    const turns = this.readNumberArray(value);
    return turns.length === 0 || turns.some((item) => item <= chapterNo);
  }

  private readNumberArray(value: unknown): number[] {
    return Array.isArray(value)
      ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [];
  }

  private async assertCharactersMatchProject(projectId: string, refs: Array<{ id?: string | null; name?: string | null; label: string }>) {
    const uniqueIds = Array.from(new Set(refs.map((ref) => ref.id).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))));
    if (!uniqueIds.length) return;

    const rows = await this.prisma.character.findMany({
      where: { projectId, id: { in: uniqueIds } },
      select: { id: true, name: true },
    });
    const found = new Map(rows.map((row) => [row.id, row.name]));
    const missing = uniqueIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(`Relationship character ids do not belong to project: ${missing.join(', ')}`);
    }

    const mismatched = refs.filter((ref) => {
      if (!ref.id || !ref.name) return false;
      const actualName = found.get(ref.id);
      return typeof actualName === 'string' && actualName.trim() !== ref.name.trim();
    });
    if (mismatched.length) {
      throw new BadRequestException(`Relationship character id/name mismatch: ${mismatched.map((ref) => ref.label).join(', ')}`);
    }
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }
}
