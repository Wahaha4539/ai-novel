import { BadRequestException, Injectable } from '@nestjs/common';
import { PostProcessChapterResult, PostProcessChapterService } from '../../generation/postprocess-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';

interface PostProcessChapterInput {
  chapterId?: string;
  draftId?: string;
}

/**
 * 章节后处理工具：调用 API 内 PostProcessChapterService 清理当前草稿并同步章节字数。
 * 副作用限定为必要时创建后处理草稿版本，以及更新章节状态/字数。
 */
@Injectable()
export class PostProcessChapterTool implements BaseTool<PostProcessChapterInput, PostProcessChapterResult> {
  name = 'postprocess_chapter';
  description = '对章节当前草稿执行 API 内轻量后处理，返回最终 draftId、字数和处理步骤。';
  inputSchema = { type: 'object' as const, required: ['chapterId', 'draftId'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['draftId', 'chapterId', 'actualWordCount'], properties: { draftId: { type: 'string' as const, minLength: 1 }, chapterId: { type: 'string' as const, minLength: 1 }, actualWordCount: { type: 'number' as const, minimum: 0 } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft_if_changed', 'update_chapter_word_count'];

  constructor(private readonly postprocess: PostProcessChapterService) {}

  async run(args: PostProcessChapterInput, context: ToolContext) {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('postprocess_chapter 需要 chapterId');
    return this.postprocess.run(context.projectId, chapterId, args.draftId);
  }
}