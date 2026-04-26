import { BadRequestException, Injectable } from '@nestjs/common';
import { MemoryRebuildResult, MemoryRebuildService } from '../../memory/memory-rebuild.service';
import { BaseTool, ToolContext } from '../base-tool';

interface RebuildMemoryInput {
  chapterId?: string;
  draftId?: string;
}

/**
 * 章节记忆重建工具：在 Act 阶段把当前草稿沉淀为 API 内 MemoryChunk。
 * 副作用为替换本章节由 Agent 自动生成的记忆片段，不触碰人工记忆。
 */
@Injectable()
export class RebuildMemoryTool implements BaseTool<RebuildMemoryInput, MemoryRebuildResult> {
  name = 'rebuild_memory';
  description = '基于章节当前草稿重建自动记忆片段，供后续章节上下文召回使用。';
  inputSchema = { type: 'object' as const, required: ['chapterId', 'draftId'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['createdCount', 'deletedCount', 'embeddingAttachedCount', 'chunks'], properties: { createdCount: { type: 'number' as const, minimum: 0 }, deletedCount: { type: 'number' as const, minimum: 0 }, embeddingAttachedCount: { type: 'number' as const, minimum: 0 }, chunks: { type: 'array' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['replace_auto_memory_chunks'];

  constructor(private readonly memoryRebuild: MemoryRebuildService) {}

  async run(args: RebuildMemoryInput, context: ToolContext) {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('rebuild_memory 需要 chapterId');
    return this.memoryRebuild.rebuildChapter(context.projectId, chapterId, args.draftId);
  }
}