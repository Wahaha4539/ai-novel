import { BadRequestException, Injectable } from '@nestjs/common';
import { ChapterAutoRepairResult, ChapterAutoRepairService } from '../../generation/chapter-auto-repair.service';
import { BaseTool, ToolContext } from '../base-tool';

interface AutoRepairChapterInput {
  chapterId?: string;
  draftId?: string;
  issues?: unknown[];
  instruction?: string;
  maxRounds?: number;
}

/**
 * 章节有界自动修复工具：根据校验问题最多执行一轮最小改写。
 * 会创建新的当前草稿版本，因此只能在 Act 阶段且经用户审批后运行。
 */
@Injectable()
export class AutoRepairChapterTool implements BaseTool<AutoRepairChapterInput, ChapterAutoRepairResult> {
  name = 'auto_repair_chapter';
  description = '根据事实校验问题对当前章节草稿做最多一轮自动修复，避免无限自动改稿。';
  inputSchema = { type: 'object' as const, required: ['chapterId', 'draftId', 'issues', 'maxRounds'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 }, issues: { type: 'array' as const }, instruction: { type: 'string' as const, minLength: 1 }, maxRounds: { type: 'number' as const, minimum: 0, maximum: 1 } } };
  outputSchema = { type: 'object' as const, required: ['draftId', 'chapterId', 'repairedWordCount'], properties: { draftId: { type: 'string' as const, minLength: 1 }, chapterId: { type: 'string' as const, minLength: 1 }, repairedWordCount: { type: 'number' as const, minimum: 0 }, summary: { type: 'string' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft_if_repaired', 'update_chapter_word_count'];
  executionTimeoutMs = 425_000;

  constructor(private readonly autoRepair: ChapterAutoRepairService) {}

  run(args: AutoRepairChapterInput, context: ToolContext): Promise<ChapterAutoRepairResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('auto_repair_chapter 需要 chapterId');
    return this.autoRepair.run(context.projectId, chapterId, {
      draftId: args.draftId,
      issues: args.issues,
      instruction: args.instruction,
      userId: context.userId,
      maxRounds: args.maxRounds,
      progress: {
        updateProgress: context.updateProgress,
        heartbeat: context.heartbeat,
      },
    });
  }
}
