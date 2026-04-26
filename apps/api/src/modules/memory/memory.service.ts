import { Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../guided/llm.service';
import { MemoryRebuildService } from './memory-rebuild.service';
import { MemoryWriterService } from './memory-writer.service';
import { RetrievalService } from './retrieval.service';

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

type AiReviewDecision = {
  id: string;
  action: 'confirm' | 'reject';
  reason?: string;
};

@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
    private readonly llmService: LlmService,
    private readonly memoryRebuildService: MemoryRebuildService,
    private readonly memoryWriterService: MemoryWriterService,
    private readonly retrievalService: RetrievalService,
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

  /**
   * Extract a JSON array/object from LLM output that may include Markdown fences or short explanations.
   * The review automation requires deterministic machine-readable decisions; malformed output fails fast.
   */
  private parseAiReviewDecisions(text: string): AiReviewDecision[] {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    const raw = (fenced ?? text).trim();
    const start = raw.search(/[\[{]/);
    const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (start < 0 || end < start) {
      throw new Error('LLM 未返回可解析的审核 JSON');
    }

    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    const list = Array.isArray(parsed) ? parsed : this.asRecord(parsed).decisions;
    if (!Array.isArray(list)) {
      throw new Error('LLM 审核 JSON 缺少 decisions 数组');
    }

    return list
      .map((item: unknown): AiReviewDecision | null => {
        const record = this.asRecord(item);
        const id = typeof record.id === 'string' ? record.id : '';
        const action = record.action === 'confirm' || record.action === 'reject' ? record.action : undefined;
        const reason = typeof record.reason === 'string' ? record.reason : undefined;
        return id && action ? { id, action, reason } : null;
      })
      .filter((item): item is AiReviewDecision => Boolean(item));
  }

  /**
   * Ask LLM to decide whether pending_review memories should be adopted or removed, then propagate status.
   * Decisions are constrained to confirm/reject only so the pipeline can run unattended after generation/rebuild.
   */
  async aiResolveReviewQueue(projectId: string, chapterId?: string) {
    const queue = await this.listReviewQueue(projectId, 'pending_review', undefined, chapterId);
    if (!queue.length) {
      return { reviewedCount: 0, confirmedCount: 0, rejectedCount: 0, decisions: [] };
    }

    const reviewPayload = queue.map((item) => ({
      id: item.id,
      memoryType: item.memoryType,
      summary: item.summary,
      content: item.content,
      sourceTrace: item.sourceTrace,
      metadata: item.metadata,
    }));

    const answer = await this.llmService.chat(
      [
        {
          role: 'system',
          content: '你是小说事实层审计员。只判断 pending_review 记忆是否应采纳进入事实层，或拒绝移除。必须输出严格 JSON。',
        },
        {
          role: 'user',
          content: [
            '请审核以下待确认记忆。判断标准：',
            '1. 与章节事实、人物状态、路线、伏笔一致且有助于后续检索的，action=confirm。',
            '2. 重复、误读、过度推断、与上下文冲突、只是临时心理描写不应固化的，action=reject。',
            '3. 不要新增 id，不要省略任何输入项。',
            '输出格式：[{"id":"...","action":"confirm|reject","reason":"简短中文理由"}]',
            JSON.stringify(reviewPayload),
          ].join('\n'),
        },
      ],
      { temperature: 0.1, maxTokens: 4000, appStep: 'memory_review' },
    );

    const decisions = this.parseAiReviewDecisions(answer);
    const allowedIds = new Set(queue.map((item) => item.id));
    let confirmedCount = 0;
    let rejectedCount = 0;
    const applied: AiReviewDecision[] = [];

    for (const decision of decisions) {
      if (!allowedIds.has(decision.id)) {
        continue;
      }

      await this.updateReviewStatus(projectId, decision.id, decision.action === 'confirm' ? 'user_confirmed' : 'rejected');
      if (decision.action === 'confirm') {
        confirmedCount += 1;
      } else {
        rejectedCount += 1;
      }
      applied.push(decision);
    }

    return {
      reviewedCount: applied.length,
      confirmedCount,
      rejectedCount,
      skippedCount: queue.length - applied.length,
      decisions: applied,
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

  /** 返回一次召回评测快照，帮助迁移期比较 pgvector SQL、应用层 cosine 和关键词召回质量。 */
  evaluateRetrieval(projectId: string, query?: string, expectedMemoryIds: string[] = []) {
    return this.retrievalService.evaluate(projectId, { queryText: query ?? '' }, expectedMemoryIds);
  }

  /** 批量运行召回评测用例，用于对比迁移后 pgvector/关键词兜底的整体质量。 */
  benchmarkRetrieval(projectId: string, cases: Array<{ id?: string; query: string; expectedMemoryIds?: string[] }>) {
    return this.retrievalService.benchmark(projectId, cases.filter((item) => item.query?.trim()));
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
    // Agent-Centric 后端单体架构下，rebuild 直接调用 API 内 MemoryRebuildService，不再依赖 Python Worker 回调。
    const payload = await this.memoryRebuildService.rebuildProject(projectId, chapterId, dryRun);

    if (!dryRun) {
      await this.cacheService.deleteProjectRecallResults(projectId);
    }

    return payload;
  }

  /** 批量补齐历史记忆 embedding，供迁移后召回质量提升使用。 */
  async backfillEmbeddings(projectId: string, chapterId?: string, dryRun = false, limit = 50, cursor?: string, force = false) {
    const payload = await this.memoryWriterService.backfillEmbeddings(projectId, { chapterId, dryRun, limit, cursor, force });
    if (!dryRun && payload.updatedCount > 0) await this.cacheService.deleteProjectRecallResults(projectId);
    return payload;
  }
}
