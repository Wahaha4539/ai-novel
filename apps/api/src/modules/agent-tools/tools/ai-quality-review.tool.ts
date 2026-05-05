import { BadRequestException, Injectable } from '@nestjs/common';
import { AiQualityReviewResult, AiQualityReviewService } from '../../quality-reports/ai-quality-review.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface AiQualityReviewToolInput {
  chapterId?: string;
  draftId?: string;
  instruction?: string;
  focus?: string[];
}

@Injectable()
export class AiQualityReviewTool implements BaseTool<AiQualityReviewToolInput, AiQualityReviewResult> {
  name = 'ai_quality_review';
  description = '调用 AI 审稿服务审阅章节草稿，并写入 QualityReport。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      draftId: { type: 'string' as const, minLength: 1 },
      instruction: { type: 'string' as const },
      focus: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['reportId', 'projectId', 'chapterId', 'draftId', 'sourceType', 'reportType', 'verdict', 'summary', 'scores', 'issues'],
    properties: {
      reportId: { type: 'string' as const, minLength: 1 },
      projectId: { type: 'string' as const, minLength: 1 },
      chapterId: { type: 'string' as const, minLength: 1 },
      draftId: { type: 'string' as const, minLength: 1 },
      sourceType: { type: 'string' as const, enum: ['ai_review'] },
      reportType: { type: 'string' as const, enum: ['ai_chapter_review'] },
      verdict: { type: 'string' as const, enum: ['pass', 'warn', 'fail'] },
      summary: { type: 'string' as const },
      scores: { type: 'object' as const },
      issues: { type: 'array' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_quality_report'];
  executionTimeoutMs = 300_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'AI 审稿并写入质量报告',
    description: '对章节草稿进行 AI 审稿，输出剧情推进、人设一致性、文风、节奏、伏笔、世界观/时间线/规则等维度评分，并写入 QualityReport。',
    whenToUse: ['用户要求 AI 审稿、质量评分、章节质量报告', '章节生成或润色后需要形成可追踪审稿报告', '需要让后续自动修复读取审稿 issues'],
    whenNotToUse: ['用户只想做只读口头建议且不希望写入报告', '缺少真实 chapterId/draftId 且无法从上下文解析', '用户未审批写入计划'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterId: { source: 'resolver', description: '优先来自 context.session.currentChapterId、runtime.currentChapterId 或 resolve_chapter 输出。' },
      draftId: { source: 'previous_step', description: '优先来自 write_chapter/polish_chapter/auto_repair_chapter 输出或 runtime.currentDraftId；未提供时会读取当前章节最新草稿。' },
      instruction: { source: 'user_message', description: '保留用户指定的审稿重点，例如节奏、伏笔、人设、爽点兑现。' },
      focus: { source: 'literal', description: '可选审稿维度，如 plotProgress、characterConsistency、proseStyle、pacing、foreshadowing。' },
    },
    examples: [
      {
        user: '给当前章节做一次 AI 审稿，重点看伏笔和节奏。',
        plan: [
          { tool: 'resolve_chapter', args: { chapterRef: '当前章节' } },
          { tool: 'ai_quality_review', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '重点看伏笔和节奏', focus: ['foreshadowing', 'pacing'] } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['chapterId', 'draftId'],
      allowedSources: ['context.session.currentChapterId', 'runtime.currentChapterId', 'runtime.currentDraftId', 'resolve_chapter.output.chapterId', 'write_chapter.output.draftId', 'polish_chapter.output.draftId', 'auto_repair_chapter.output.draftId'],
    },
  };

  constructor(private readonly aiQualityReview: AiQualityReviewService) {}

  async run(args: AiQualityReviewToolInput, context: ToolContext): Promise<AiQualityReviewResult> {
    if (context.mode !== 'act') throw new BadRequestException('ai_quality_review 只能在 Act 模式执行');
    if (!context.approved) throw new BadRequestException('ai_quality_review 写入 QualityReport 前需要用户审批');
    const chapterId = args.chapterId ?? context.chapterId;
    const draftId = args.draftId;
    if (!chapterId && !draftId) throw new BadRequestException('ai_quality_review 需要 chapterId 或 draftId');
    return this.aiQualityReview.reviewAndCreate(
      context.projectId,
      { chapterId, draftId, instruction: args.instruction, focus: args.focus },
      { agentRunId: context.agentRunId, userId: context.userId },
    );
  }
}
