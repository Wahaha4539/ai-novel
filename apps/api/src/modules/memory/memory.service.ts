import { BadGatewayException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';

const REVIEW_STATUSES = ['pending_review', 'user_confirmed', 'rejected'] as const;

type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

type StoryEventRow = {
  id: string;
  projectId: string;
  chapterId: string;
  chapterNo: number | null;
  title: string;
  eventType: string;
  description: string;
  participants: unknown;
  timelineSeq: number | null;
  status: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type CharacterStateSnapshotRow = {
  id: string;
  projectId: string;
  chapterId: string;
  chapterNo: number | null;
  characterId: string | null;
  characterName: string;
  stateType: string;
  stateValue: string;
  summary: string | null;
  status: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type ForeshadowTrackRow = {
  id: string;
  projectId: string;
  chapterId: string;
  chapterNo: number | null;
  title: string;
  detail: string | null;
  status: string;
  firstSeenChapterNo: number | null;
  lastSeenChapterNo: number | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type MemoryChunkRow = {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  memoryType: string;
  content: string;
  summary: string | null;
  embedding: unknown;
  tags: unknown;
  sourceTrace: unknown;
  metadata: unknown;
  importanceScore: number;
  freshnessScore: number;
  recencyScore: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type PrismaFactsClient = {
  storyEvent: {
    findMany(args: unknown): Promise<StoryEventRow[]>;
  };
  characterStateSnapshot: {
    findMany(args: unknown): Promise<CharacterStateSnapshotRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  foreshadowTrack: {
    findMany(args: unknown): Promise<ForeshadowTrackRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  private get prismaFacts(): PrismaFactsClient {
    return this.prisma as unknown as PrismaFactsClient;
  }

  private asRecord(value: unknown) {
    return isRecord(value) ? value : {};
  }

  private parseStateValue(content: string) {
    const match = content.match(/^[^：:]+[：:](.+)$/);
    return match?.[1]?.trim();
  }

  private normalizeForeshadow(track: {
    metadata: unknown;
    status: string;
  }) {
    const metadata = this.asRecord(track.metadata);
    const reviewStatus = REVIEW_STATUSES.includes(track.status as ReviewStatus)
      ? track.status
      : 'user_confirmed';
    const foreshadowStatus =
      typeof metadata.foreshadowStatus === 'string'
        ? metadata.foreshadowStatus
        : REVIEW_STATUSES.includes(track.status as ReviewStatus)
          ? 'planned'
          : track.status;

    return {
      reviewStatus,
      foreshadowStatus,
    };
  }

  search(projectId: string, query?: string) {
    return this.prisma.memoryChunk.findMany({
      where: {
        projectId,
        ...(query
          ? {
              OR: [
                { content: { contains: query, mode: 'insensitive' } },
                { summary: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ importanceScore: 'desc' }, { freshnessScore: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async listStoryEvents(projectId: string, chapterId?: string, query?: string, take = 50) {
    return this.prismaFacts.storyEvent.findMany({
      where: {
        projectId,
        ...(chapterId ? { chapterId } : {}),
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { description: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ chapterNo: 'desc' }, { createdAt: 'desc' }],
      take,
    });
  }

  async listCharacterStateSnapshots(
    projectId: string,
    chapterId?: string,
    status?: string,
    character?: string,
    query?: string,
    take = 50,
  ) {
    return this.prismaFacts.characterStateSnapshot.findMany({
      where: {
        projectId,
        ...(chapterId ? { chapterId } : {}),
        ...(status ? { status } : {}),
        ...(character ? { characterName: { contains: character, mode: 'insensitive' } } : {}),
        ...(query
          ? {
              OR: [
                { characterName: { contains: query, mode: 'insensitive' } },
                { stateValue: { contains: query, mode: 'insensitive' } },
                { summary: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ chapterNo: 'desc' }, { createdAt: 'desc' }],
      take,
    });
  }

  async listForeshadowTracks(projectId: string, chapterId?: string, status?: string, query?: string, take = 50) {
    const tracks = await this.prismaFacts.foreshadowTrack.findMany({
      where: {
        projectId,
        ...(chapterId ? { chapterId } : {}),
        ...(status ? { status } : {}),
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { detail: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ firstSeenChapterNo: 'asc' }, { createdAt: 'desc' }],
      take,
    });

    return tracks.map((track: ForeshadowTrackRow) => ({
      ...track,
      ...this.normalizeForeshadow(track),
    }));
  }

  async listReviewQueue(projectId: string, status = 'pending_review', memoryType?: string, chapterId?: string, query?: string) {
    const items = (await this.prisma.memoryChunk.findMany({
      where: {
        projectId,
        ...(status ? { status } : {}),
        ...(memoryType ? { memoryType } : {}),
        ...(chapterId
          ? {
              sourceType: 'chapter',
              sourceId: chapterId,
            }
          : {}),
        ...(query
          ? {
              OR: [
                { content: { contains: query, mode: 'insensitive' } },
                { summary: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    })) as unknown as MemoryChunkRow[];

    return items.map((item: MemoryChunkRow) => ({
      ...item,
      sourceTrace: this.asRecord(item.sourceTrace),
      metadata: this.asRecord(item.metadata),
    }));
  }

  async getDashboard(projectId: string, chapterId?: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        genre: true,
        theme: true,
        tone: true,
        status: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const [chapters, storyEvents, characterStateSnapshots, foreshadowTracks, reviewQueue, validationIssues] =
      await Promise.all([
        this.prisma.chapter.findMany({
          where: { projectId },
          orderBy: { chapterNo: 'asc' },
        }),
        this.listStoryEvents(projectId, chapterId, undefined, 30),
        this.listCharacterStateSnapshots(projectId, chapterId, undefined, undefined, undefined, 30),
        this.listForeshadowTracks(projectId, chapterId, undefined, undefined, 30),
        this.listReviewQueue(projectId, 'pending_review', undefined, chapterId),
        this.prisma.validationIssue.findMany({
          where: {
            projectId,
            ...(chapterId ? { chapterId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

    return {
      project,
      scope: {
        projectId,
        chapterId: chapterId ?? null,
      },
      chapters,
      storyEvents,
      characterStateSnapshots,
      foreshadowTracks,
      reviewQueue,
      validationIssues,
    };
  }

  async updateReviewStatus(projectId: string, memoryId: string, nextStatus: ReviewStatus) {
    const memory = (await this.prisma.memoryChunk.findFirst({
      where: {
        id: memoryId,
        projectId,
      },
    })) as unknown as MemoryChunkRow | null;

    if (!memory) {
      throw new NotFoundException(`待审核记忆不存在：${memoryId}`);
    }

    const updated = (await this.prisma.memoryChunk.update({
      where: { id: memoryId },
      data: { status: nextStatus },
    })) as unknown as MemoryChunkRow;

    const sourceTrace = this.asRecord(memory.sourceTrace);
    const metadata = this.asRecord(memory.metadata);
    const chapterId = typeof sourceTrace.chapterId === 'string' ? sourceTrace.chapterId : undefined;
    const kind = typeof sourceTrace.kind === 'string' ? sourceTrace.kind : undefined;

    let characterStateSnapshotCount = 0;
    let foreshadowTrackCount = 0;

    if (chapterId && kind === 'character_state') {
      const characterName =
        typeof metadata.character === 'string'
          ? metadata.character
          : memory.content.split(/[：:]/)[0]?.trim();
      const stateType = typeof metadata.stateType === 'string' ? metadata.stateType : undefined;
      const stateValue = this.parseStateValue(memory.content);

      const result = await this.prismaFacts.characterStateSnapshot.updateMany({
        where: {
          projectId,
          chapterId,
          ...(characterName ? { characterName } : {}),
          ...(stateType ? { stateType } : {}),
          ...(stateValue ? { stateValue } : {}),
        },
        data: {
          status: nextStatus,
        },
      });
      characterStateSnapshotCount = result.count;
    }

    if (chapterId && kind === 'foreshadow') {
      const title = updated.summary ?? updated.content;
      const result = await this.prismaFacts.foreshadowTrack.updateMany({
        where: {
          projectId,
          chapterId,
          title,
        },
        data: {
          status: nextStatus,
        },
      });
      foreshadowTrackCount = result.count;
    }

    await this.cacheService.deleteProjectRecallResults(projectId);

    return {
      memory: {
        ...updated,
        sourceTrace: this.asRecord(updated.sourceTrace),
        metadata: this.asRecord(updated.metadata),
      },
      propagated: {
        characterStateSnapshotCount,
        foreshadowTrackCount,
      },
    };
  }

  async rebuild(projectId: string, chapterId?: string, dryRun = false) {
    const workerBaseUrl = process.env.WORKER_BASE_URL;
    if (!workerBaseUrl) {
      throw new InternalServerErrorException('missing_worker_base_url');
    }

    const response = await fetch(`${workerBaseUrl}/internal/memory/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        chapterId,
        dryRun,
      }),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new BadGatewayException(`worker rebuild 请求失败: ${response.status} ${responseText.slice(0, 1000)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;

    if (!dryRun) {
      await this.cacheService.deleteProjectRecallResults(projectId);
    }

    return payload;
  }
}
