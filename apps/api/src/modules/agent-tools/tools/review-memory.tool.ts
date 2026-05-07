import { Injectable } from '@nestjs/common';
import { MemoryReviewResult, MemoryReviewService } from '../../memory/memory-review.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';

interface ReviewMemoryInput {
  chapterId?: string;
}

/**
 * 记忆复核工具：对 pending_review 记忆进行自动审计，并更新为确认或拒绝状态。
 * 该工具会修改 MemoryChunk.status，属于中风险写入能力，需要审批。
 */
@Injectable()
export class ReviewMemoryTool implements BaseTool<ReviewMemoryInput, MemoryReviewResult> {
  name = 'review_memory';
  description = '复核 pending_review 记忆，确认可固化记忆并拒绝误读或过度推断记忆。';
  inputSchema = { type: 'object' as const, additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['reviewedCount', 'confirmedCount', 'rejectedCount', 'skippedCount', 'decisions'], properties: { reviewedCount: { type: 'number' as const, minimum: 0 }, confirmedCount: { type: 'number' as const, minimum: 0 }, rejectedCount: { type: 'number' as const, minimum: 0 }, skippedCount: { type: 'number' as const, minimum: 0 }, decisions: { type: 'array' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['update_memory_review_status'];

  constructor(private readonly memoryReview: MemoryReviewService) {}

  async run(args: ReviewMemoryInput, context: ToolContext): Promise<MemoryReviewResult> {
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在复核待审记忆',
      progressCurrent: 0,
      progressTotal: 1,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });
    const result = await this.memoryReview.reviewPending(context.projectId, args.chapterId ?? context.chapterId);
    await context.updateProgress?.({ phase: 'persisting', phaseMessage: '记忆复核已完成', progressCurrent: 1, progressTotal: 1, timeoutMs: 60_000 });
    return result;
  }
}
