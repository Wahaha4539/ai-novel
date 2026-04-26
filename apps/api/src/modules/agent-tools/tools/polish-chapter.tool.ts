import { BadRequestException, Injectable } from '@nestjs/common';
import { PolishChapterService, PolishChapterResult } from '../../generation/polish-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';

interface PolishChapterInput {
  chapterId?: string;
  draftId?: string;
  instruction?: string;
}

/**
 * Agent 章节润色工具：受审批控制地调用 API 内 PolishChapterService 创建润色草稿。
 * 该工具会写入新 ChapterDraft，因此只能在 Act 阶段且用户审批后执行。
 */
@Injectable()
export class PolishChapterTool implements BaseTool<PolishChapterInput, PolishChapterResult> {
  name = 'polish_chapter';
  description = '润色章节当前草稿，创建新的当前草稿版本，并尽量不改变剧情事实。';
  inputSchema = { type: 'object' as const, required: ['chapterId'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 }, instruction: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['draftId', 'chapterId', 'polishedWordCount'], properties: { draftId: { type: 'string' as const, minLength: 1 }, chapterId: { type: 'string' as const, minLength: 1 }, polishedWordCount: { type: 'number' as const, minimum: 0 } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft', 'update_chapter_word_count'];

  constructor(private readonly polishChapter: PolishChapterService) {}

  run(args: PolishChapterInput, context: ToolContext): Promise<PolishChapterResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('polish_chapter 需要 chapterId');
    return this.polishChapter.run(context.projectId, chapterId, args.instruction, args.draftId);
  }
}