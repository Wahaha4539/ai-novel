import { Injectable } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

export interface MemoryReviewResult {
  reviewedCount: number;
  confirmedCount: number;
  rejectedCount: number;
  skippedCount: number;
  decisions: Array<{ id: string; action: 'confirm' | 'reject'; reason?: string }>;
}

/**
 * API 内记忆复核服务，迁移 Worker MemoryReviewPipeline 的核心审计能力。
 * 输入项目/章节范围；副作用是把 pending_review 记忆更新为 user_confirmed 或 rejected。
 */
@Injectable()
export class MemoryReviewService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService, private readonly cacheService: NovelCacheService) {}

  async reviewPending(projectId: string, chapterId?: string): Promise<MemoryReviewResult> {
    const queue = await this.prisma.memoryChunk.findMany({
      where: { projectId, status: 'pending_review', ...(chapterId ? { sourceType: 'chapter', sourceId: chapterId } : {}) },
      orderBy: [{ importanceScore: 'desc' }, { createdAt: 'asc' }],
      take: 30,
    });

    if (!queue.length) return { reviewedCount: 0, confirmedCount: 0, rejectedCount: 0, skippedCount: 0, decisions: [] };

    const decisions = await this.buildDecisions(
      queue.map((item) => ({ id: item.id, memoryType: item.memoryType, content: item.content.slice(0, 1000), summary: item.summary, sourceTrace: item.sourceTrace })),
    );
    const allowedIds = new Set(queue.map((item) => item.id));
    const queueById = new Map(queue.map((item) => [item.id, item]));
    const applied = decisions.filter((item) => allowedIds.has(item.id));

    await this.prisma.$transaction(
      applied.map((decision) => {
        const previousMetadata = this.asRecord(queueById.get(decision.id)?.metadata);
        return this.prisma.memoryChunk.update({
          where: { id: decision.id },
          data: {
            status: decision.action === 'confirm' ? 'user_confirmed' : 'rejected',
            metadata: { ...previousMetadata, reviewedBy: 'agent_memory_review', decision: decision.action, reason: decision.reason ?? '' },
          },
        });
      }),
    );

    const confirmedCount = applied.filter((item) => item.action === 'confirm').length;
    const rejectedCount = applied.filter((item) => item.action === 'reject').length;
    if (applied.length > 0) {
      // 复核会把 pending_review 推进到 user_confirmed/rejected，直接影响可召回记忆集合，必须清空项目级召回缓存。
      await this.cacheService.deleteProjectRecallResults(projectId);
    }
    return { reviewedCount: applied.length, confirmedCount, rejectedCount, skippedCount: queue.length - applied.length, decisions: applied };
  }

  private async buildDecisions(queue: Array<Record<string, unknown>>): Promise<Array<{ id: string; action: 'confirm' | 'reject'; reason?: string }>> {
    const { data } = await this.llm.chatJson<unknown>(
      [
        { role: 'system', content: '你是小说事实层审计员。判断 pending_review 记忆是否应采纳进入事实层。只输出 JSON 数组，不要 Markdown。' },
        { role: 'user', content: `判断标准：\n1. 与章节事实、人物状态、路线、伏笔一致且有助于后续检索的，action=confirm。\n2. 重复、误读、过度推断、与上下文冲突、只是临时心理描写不应固化的，action=reject。\n3. 不要新增 id，不要省略任何输入项。\n输出格式：[{"id":"...","action":"confirm|reject","reason":"简短中文理由"}]\n\n待审核记忆：\n${JSON.stringify(queue, null, 2).slice(0, 20000)}` },
      ],
      { appStep: 'memory_review', maxTokens: 2500, timeoutMs: 120_000, retries: 1, temperature: 0.1 },
    );
    const decisions = this.normalizeDecisions(data);
    if (decisions.length !== queue.length) throw new Error(`记忆复核返回数量不完整：期望 ${queue.length}，实际 ${decisions.length}。已拒绝自动降级。`);
    return decisions;
  }

  private normalizeDecisions(data: unknown): Array<{ id: string; action: 'confirm' | 'reject'; reason?: string }> {
    const items = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { decisions?: unknown }).decisions) ? (data as { decisions: unknown[] }).decisions : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const action = record.action === 'confirm' ? 'confirm' : record.action === 'reject' ? 'reject' : undefined;
      return typeof record.id === 'string' && action ? [{ id: record.id, action, reason: typeof record.reason === 'string' ? record.reason : undefined }] : [];
    });
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
