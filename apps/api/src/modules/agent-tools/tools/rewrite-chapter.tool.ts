import { BadRequestException, Injectable } from '@nestjs/common';
import { GenerateChapterResult, GenerateChapterService } from '../../generation/generate-chapter.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface RewriteChapterInput {
  chapterId?: string;
  instruction?: string;
  context?: unknown;
  wordCount?: number;
}

/**
 * True chapter rewrite tool: remove the chapter body's generated products first,
 * then generate a fresh draft from outline/context instead of polishing old prose.
 */
@Injectable()
export class RewriteChapterTool implements BaseTool<RewriteChapterInput, GenerateChapterResult> {
  name = 'rewrite_chapter';
  description = '清理本章节旧正文草稿及其自动派生产物后，从头重写章节正文。';
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
      rewriteCleanup: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = [
    'delete_chapter_drafts',
    'delete_quality_reports',
    'delete_validation_issues',
    'delete_auto_story_events',
    'delete_auto_character_states',
    'delete_auto_foreshadows',
    'delete_auto_memory_chunks',
    'create_chapter_draft',
    'update_chapter_status',
  ];
  executionTimeoutMs = 1_000_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '重写章节正文',
    description: '先删除本章旧正文草稿、自动事实、校验、质检与 MemoryChunk，再从章节大纲/上下文重新生成正文。',
    whenToUse: ['用户明确要求重写章节、重新生成章节、从头写当前章、推倒重来写正文', '用户要求旧正文不要作为草稿或参考输入'],
    whenNotToUse: ['用户只要求润色、去 AI 味、增强节奏或局部修改时使用 polish_chapter', '用户只是第一次写新章节且不要求清理旧产物时使用 write_chapter', '缺少真实 chapterId 且尚未调用 resolve_chapter'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterId: { source: 'resolver', resolverTool: 'resolve_chapter', description: '真实章节 ID，可来自 context.session.currentChapterId 或 resolve_chapter 输出。' },
      instruction: { source: 'user_message', description: '保留用户对重写方向、剧情目标、风格、字数和禁改项的要求。' },
      wordCount: { source: 'context', description: '用户未指定时可使用 context.project.defaultWordCount。' },
    },
    examples: [{ user: '重写第一章正文，不要沿用旧稿。', plan: [{ tool: 'resolve_chapter', args: { chapterRef: '第一章' } }, { tool: 'rewrite_chapter', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '重写第一章正文，不要沿用旧稿。' } }] }],
    failureHints: [{ code: 'MISSING_REQUIRED_ARGUMENT', meaning: '缺少真实 chapterId 或 instruction', suggestedRepair: '先调用 resolve_chapter，或要求用户补充重写目标。' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId'], allowedSources: ['context.session.currentChapterId', 'resolve_chapter.output.chapterId', 'steps.resolve_chapter.output.chapterId', 'runtime.currentChapterId'] },
  };

  constructor(private readonly generateChapter: GenerateChapterService) {}

  async run(args: RewriteChapterInput, context: ToolContext): Promise<GenerateChapterResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('rewrite_chapter 需要 chapterId');
    return this.generateChapter.run(context.projectId, chapterId, {
      mode: 'rewrite',
      instruction: args.instruction,
      wordCount: args.wordCount,
      includeLorebook: true,
      includeMemory: true,
      agentRunId: context.agentRunId,
      userId: context.userId,
      progress: {
        updateProgress: context.updateProgress,
        heartbeat: context.heartbeat,
      },
    });
  }
}
