import { BadRequestException, Injectable } from '@nestjs/common';
import { PolishChapterService, PolishChapterResult } from '../../generation/polish-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

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
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '润色/修改章节草稿',
    description: '根据用户约束润色或改写章节当前草稿，创建新的草稿版本。',
    whenToUse: ['用户要求润色、去 AI 味、增强压迫感或修改当前章节', '用户要求改稿但不覆盖正式正文'],
    whenNotToUse: ['用户只是检查问题不要求修改', '没有真实 chapterId 且未调用 resolve_chapter', '章节没有可用草稿且用户要求写新正文时应使用 write_chapter'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: { chapterId: { source: 'resolver', resolverTool: 'resolve_chapter', description: '真实章节 ID。' }, draftId: { source: 'context', description: '当前草稿 ID，可来自 context.session.currentDraftId 或 runtime.currentDraftId。' }, instruction: { source: 'user_message', description: '必须保留用户禁改项，例如“别改结局”。' } },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId', 'draftId'], allowedSources: ['context.session.currentChapterId', 'context.session.currentDraftId', 'runtime.currentChapterId', 'runtime.currentDraftId', 'resolve_chapter.output.chapterId'] },
  };

  constructor(private readonly polishChapter: PolishChapterService) {}

  run(args: PolishChapterInput, context: ToolContext): Promise<PolishChapterResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('polish_chapter 需要 chapterId');
    return this.polishChapter.run(context.projectId, chapterId, args.instruction, args.draftId);
  }
}