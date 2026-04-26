import { BadRequestException, Injectable } from '@nestjs/common';
import { GenerateChapterResult, GenerateChapterService } from '../../generation/generate-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';

interface WriteChapterInput {
  chapterId?: string;
  instruction?: string;
  context?: unknown;
  wordCount?: number;
}

/**
 * 章节正文写作工具：调用 API 内 GenerateChapterService 生成正文，并写入 ChapterDraft。
 * 输入为章节上下文和写作指令；输出为 draftId、版本号、召回摘要和字数。副作用是创建草稿并更新章节状态。
 */
@Injectable()
export class WriteChapterTool implements BaseTool<WriteChapterInput, GenerateChapterResult> {
  name = 'write_chapter';
  description = '根据章节上下文和用户指令生成章节正文，创建当前章节草稿并更新章节状态。';
  inputSchema = {
    type: 'object' as const,
    required: ['chapterId', 'instruction'],
    additionalProperties: false,
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      instruction: { type: 'string' as const, minLength: 1 },
      context: { type: 'object' as const },
      wordCount: { type: 'number' as const, minimum: 100, maximum: 50000 },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['draftId', 'chapterId', 'versionNo', 'actualWordCount'],
    properties: {
      draftId: { type: 'string' as const, minLength: 1 },
      chapterId: { type: 'string' as const, minLength: 1 },
      versionNo: { type: 'number' as const, minimum: 1 },
      actualWordCount: { type: 'number' as const, minimum: 0 },
      summary: { type: 'string' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft', 'update_chapter_status'];

  constructor(private readonly generateChapter: GenerateChapterService) {}

  async run(args: WriteChapterInput, context: ToolContext): Promise<GenerateChapterResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('write_chapter 需要 chapterId');
    // context 参数保留给旧 Plan 兼容；新生成服务会自行完成 PromptBuilder/Retrieval 完整上下文装配。
    return this.generateChapter.run(context.projectId, chapterId, {
      instruction: args.instruction,
      wordCount: args.wordCount,
      includeLorebook: true,
      includeMemory: true,
      agentRunId: context.agentRunId,
      userId: context.userId,
    });
  }
}