import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';

interface ReportResultInput {
  taskType?: string;
  draftId?: string;
  chapterId?: string;
  actualWordCount?: number;
  summary?: string;
  validation?: { issues?: unknown[]; createdCount?: number };
  postprocess?: { steps?: unknown[] };
  polish?: unknown;
  autoRepair?: { skipped?: boolean; reason?: string; repairedIssueCount?: number; draftId?: string; repairedWordCount?: number; summary?: string };
  facts?: { createdEvents?: number; createdCharacterStates?: number; createdForeshadows?: number; summary?: string };
  memory?: { createdCount?: number; deletedCount?: number; chunks?: unknown[] };
  memoryReview?: { reviewedCount?: number; confirmedCount?: number; rejectedCount?: number; skippedCount?: number };
  outline?: unknown;
  outlineValidation?: unknown;
  importPreview?: unknown;
  importValidation?: unknown;
  persist?: unknown;
}

/**
 * 结果报告工具：汇总章节写作执行结果，供 AgentRun.output 和前端展示使用。
 * 该工具只读入参和上游 outputs，不写业务数据。
 */
@Injectable()
export class ReportResultTool implements BaseTool<ReportResultInput, Record<string, unknown>> {
  name = 'report_result';
  description = '汇总 Agent 执行结果，输出 draftId、章节、字数、摘要和下一步建议。';
  inputSchema = {
    type: 'object' as const,
    properties: { taskType: { type: 'string' as const }, draftId: { type: 'string' as const }, chapterId: { type: 'string' as const }, actualWordCount: { type: 'number' as const }, summary: { type: 'string' as const }, validation: { type: 'object' as const }, postprocess: { type: 'object' as const }, autoRepair: { type: 'object' as const }, facts: { type: 'object' as const }, memory: { type: 'object' as const }, memoryReview: { type: 'object' as const }, persist: { type: 'object' as const } },
  };
  outputSchema = { type: 'object' as const, required: ['status', 'agentRunId', 'nextActions'], properties: { status: { type: 'string' as const }, agentRunId: { type: 'string' as const }, draftId: { type: ['string', 'null'] as const }, chapterId: { type: ['string', 'null'] as const }, nextActions: { type: 'array' as const, items: { type: 'string' as const } } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  async run(args: ReportResultInput, context: ToolContext) {
    const nextActions = this.buildNextActions(args);

    return {
      status: 'completed',
      taskType: args.taskType,
      agentRunId: context.agentRunId,
      draftId: args.draftId,
      chapterId: args.chapterId ?? context.chapterId,
      actualWordCount: args.actualWordCount,
      summary: args.summary,
      postprocessSteps: args.postprocess?.steps ?? [],
      polish: args.polish,
      autoRepair: args.autoRepair,
      validationIssues: args.validation?.issues ?? [],
      validationCreatedCount: args.validation?.createdCount ?? 0,
      factExtraction: args.facts ?? { createdEvents: 0, createdCharacterStates: 0, createdForeshadows: 0 },
      memoryRebuild: args.memory ?? { createdCount: 0, deletedCount: 0, chunks: [] },
      memoryReview: args.memoryReview ?? { reviewedCount: 0, confirmedCount: 0, rejectedCount: 0, skippedCount: 0 },
      outline: args.outline,
      outlineValidation: args.outlineValidation,
      importPreview: args.importPreview,
      importValidation: args.importValidation,
      persist: args.persist,
      nextActions,
    };
  }

  /** 根据任务类型给出更贴合用户意图的后续动作，避免所有 Agent 报告都显示章节写作建议。 */
  private buildNextActions(args: ReportResultInput) {
    const outlineIssueCount = this.getIssueCount(args.outlineValidation);
    const importIssueCount = this.getIssueCount(args.importValidation);
    if (args.outline) {
      return outlineIssueCount > 0 ? ['优先检查大纲校验报告中的 warning/error', '修正后再进入 Agent 工作台生成目标章节正文'] : ['检查卷纲和章节节奏是否符合预期', '确认无误后可进入 Agent 工作台继续生成目标章节正文'];
    }
    if (args.importPreview) {
      return importIssueCount > 0 ? ['优先检查导入校验报告中的结构性问题', '如发现遗漏，可再次提交补充文案让 Agent 增量拆解'] : ['检查导入后的项目资料、角色、设定和章节列表', '如发现遗漏，可再次提交补充文案让 Agent 增量拆解'];
    }
    if (args.autoRepair && !args.autoRepair.skipped) return ['检查自动修复后的章节正文是否仍符合原意', '建议重新运行事实抽取/校验或人工复核关键剧情事实'];
    return ['检查章节正文是否符合预期', '如存在 validationIssues，请人工确认后再继续自动修稿'];
  }

  /** 上游校验输出来自动态 Tool JSON，需要先做弱类型收窄再读取 issueCount。 */
  private getIssueCount(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    const issueCount = (value as { issueCount?: unknown }).issueCount;
    return typeof issueCount === 'number' ? issueCount : 0;
  }
}