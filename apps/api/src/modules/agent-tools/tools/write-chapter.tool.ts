import { BadRequestException, Injectable } from '@nestjs/common';
import { GenerateChapterResult, GenerateChapterService } from '../../generation/generate-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

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
  /** 章节长文生成在慢模型上可能超过 4 分钟，外层 Tool 按用户配置放宽到 500s。 */
  executionTimeoutMs = 500_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成章节正文',
    description: '根据章节大纲、项目设定、角色状态、前文上下文和用户要求生成章节正文草稿。',
    whenToUse: ['用户要求写新章节正文', '用户要求根据章节大纲生成正文', '用户要求继续写下一章', '用户要求补写某一章内容'],
    whenNotToUse: ['用户只是询问创作建议', '用户只是检查设定矛盾', '用户只是要修改已有章节，应优先使用 polish_chapter', '缺少真实 chapterId 且尚未调用 resolve_chapter'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterId: { source: 'resolver', resolverTool: 'resolve_chapter', description: '从 context.session.currentChapterId 或 resolve_chapter 输出获得；不能把“第十二章”直接当 ID。' },
      instruction: { source: 'user_message', description: '保留用户需求中的风格、氛围、字数、禁改项和剧情约束。' },
      wordCount: { source: 'context', description: '用户未指定时可使用 context.project.defaultWordCount。' },
    },
    examples: [{ user: '帮我写第十二章，压迫感强一点，3500 字。', plan: [{ tool: 'resolve_chapter', args: { chapterRef: '第十二章' } }, { tool: 'collect_chapter_context', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}' } }, { tool: 'write_chapter', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '压迫感强一点', wordCount: 3500 } }] }],
    failureHints: [{ code: 'MISSING_REQUIRED_ARGUMENT', meaning: '缺少真实 chapterId 或 instruction', suggestedRepair: '先调用 resolve_chapter，或要求用户补充写作目标。' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId'], allowedSources: ['context.session.currentChapterId', 'resolve_chapter.output.chapterId', 'steps.resolve_chapter.output.chapterId', 'runtime.currentChapterId'] },
  };

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