import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTimelineEventDto } from './dto/create-timeline-event.dto';
import { ListTimelineEventsQueryDto } from './dto/list-timeline-events-query.dto';
import { UpdateTimelineEventDto } from './dto/update-timeline-event.dto';

@Injectable()
export class TimelineEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateTimelineEventDto) {
    await this.assertProjectExists(projectId);
    const chapterRef = await this.resolveChapterRef(projectId, dto.chapterId, dto.chapterNo);

    const event = await this.prisma.timelineEvent.create({
      data: {
        projectId,
        chapterId: chapterRef.chapterId,
        chapterNo: chapterRef.chapterNo,
        title: dto.title,
        eventTime: dto.eventTime,
        locationName: dto.locationName,
        participants: this.normalizeStringArray(dto.participants) as Prisma.InputJsonValue,
        cause: dto.cause,
        result: dto.result,
        impactScope: dto.impactScope,
        isPublic: dto.isPublic ?? false,
        knownBy: this.normalizeStringArray(dto.knownBy) as Prisma.InputJsonValue,
        unknownBy: this.normalizeStringArray(dto.unknownBy) as Prisma.InputJsonValue,
        eventStatus: dto.eventStatus ?? 'active',
        sourceType: dto.sourceType ?? 'manual',
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return event;
  }

  async list(projectId: string, query: ListTimelineEventsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.timelineEvent.findMany({
      where: this.buildWhere(projectId, query),
      orderBy: [{ chapterNo: 'asc' }, { eventTime: 'asc' }, { updatedAt: 'desc' }],
    });

    return query.knownBy
      ? rows.filter((row) => this.normalizeStringArray(row.knownBy).some((name) => this.equalsLoose(name, query.knownBy as string)))
      : rows;
  }

  async update(projectId: string, eventId: string, dto: UpdateTimelineEventDto) {
    const existing = await this.prisma.timelineEvent.findFirst({ where: { id: eventId, projectId } });
    if (!existing) {
      throw new NotFoundException(`TimelineEvent not found: ${eventId}`);
    }

    const chapterRef = dto.chapterId !== undefined || dto.chapterNo !== undefined
      ? await this.resolveChapterRef(
          projectId,
          dto.chapterId !== undefined ? dto.chapterId : undefined,
          dto.chapterNo !== undefined ? dto.chapterNo : dto.chapterId !== undefined ? undefined : existing.chapterNo,
        )
      : undefined;

    const updated = await this.prisma.timelineEvent.update({
      where: { id: eventId },
      data: {
        ...(chapterRef !== undefined && { chapterId: chapterRef.chapterId, chapterNo: chapterRef.chapterNo }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.eventTime !== undefined && { eventTime: dto.eventTime }),
        ...(dto.locationName !== undefined && { locationName: dto.locationName }),
        ...(dto.participants !== undefined && { participants: this.normalizeStringArray(dto.participants) as Prisma.InputJsonValue }),
        ...(dto.cause !== undefined && { cause: dto.cause }),
        ...(dto.result !== undefined && { result: dto.result }),
        ...(dto.impactScope !== undefined && { impactScope: dto.impactScope }),
        ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
        ...(dto.knownBy !== undefined && { knownBy: this.normalizeStringArray(dto.knownBy) as Prisma.InputJsonValue }),
        ...(dto.unknownBy !== undefined && { unknownBy: this.normalizeStringArray(dto.unknownBy) as Prisma.InputJsonValue }),
        ...(dto.eventStatus !== undefined && { eventStatus: dto.eventStatus }),
        ...(dto.sourceType !== undefined && { sourceType: dto.sourceType }),
        ...(dto.metadata !== undefined && { metadata: dto.metadata as Prisma.InputJsonValue }),
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, eventId: string) {
    const existing = await this.prisma.timelineEvent.findFirst({ where: { id: eventId, projectId } });
    if (!existing) {
      throw new NotFoundException(`TimelineEvent not found: ${eventId}`);
    }

    await this.prisma.timelineEvent.delete({ where: { id: eventId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: eventId };
  }

  private buildWhere(projectId: string, query: ListTimelineEventsQueryDto): Prisma.TimelineEventWhereInput {
    return {
      projectId,
      ...(typeof query.chapterNo === 'number' ? { chapterNo: query.chapterNo } : {}),
      ...(query.eventStatus ? { eventStatus: query.eventStatus } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { eventTime: { contains: query.q, mode: 'insensitive' } },
              { locationName: { contains: query.q, mode: 'insensitive' } },
              { cause: { contains: query.q, mode: 'insensitive' } },
              { result: { contains: query.q, mode: 'insensitive' } },
              { impactScope: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private async resolveChapterRef(projectId: string, chapterId?: string | null, chapterNo?: number | null): Promise<{ chapterId: string | null; chapterNo: number | null }> {
    if (!chapterId && chapterNo == null) {
      return { chapterId: null, chapterNo: null };
    }

    const chapter = await this.prisma.chapter.findFirst({
      where: chapterId ? { id: chapterId, projectId } : { projectId, chapterNo: chapterNo as number },
      select: { id: true, chapterNo: true },
    });
    if (!chapter) {
      throw new NotFoundException(chapterId ? `Chapter not found in project: ${chapterId}` : `Chapter number not found in project: ${chapterNo}`);
    }
    if (chapterNo != null && chapterNo !== chapter.chapterNo) {
      throw new BadRequestException(`chapterNo does not match chapterId: ${chapterNo} != ${chapter.chapterNo}`);
    }
    return { chapterId: chapter.id, chapterNo: chapter.chapterNo };
  }

  private normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private equalsLoose(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }
}
