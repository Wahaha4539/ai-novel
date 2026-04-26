import { BadRequestException, Injectable } from '@nestjs/common';
import { ValidationService } from '../../validation/validation.service';
import { BaseTool, ToolContext } from '../base-tool';

interface FactValidationInput {
  chapterId?: string;
}

/**
 * 事实校验工具：复用 API 内 ValidationService 的确定性事实规则。
 * 会删除并重建当前范围的 fact-rule ValidationIssue，因此只允许 Act 阶段执行。
 */
@Injectable()
export class FactValidationTool implements BaseTool<FactValidationInput, Record<string, unknown>> {
  name = 'fact_validation';
  description = '运行确定性事实一致性校验，写入 ValidationIssue 并返回问题摘要。';
  inputSchema = { type: 'object' as const, required: ['chapterId'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['deletedCount', 'createdCount', 'factCounts', 'issues'], properties: { deletedCount: { type: 'number' as const, minimum: 0 }, createdCount: { type: 'number' as const, minimum: 0 }, factCounts: { type: 'object' as const }, issues: { type: 'array' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['replace_fact_rule_validation_issues'];

  constructor(private readonly validation: ValidationService) {}

  async run(args: FactValidationInput, context: ToolContext) {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('fact_validation 需要 chapterId');
    const result = await this.validation.runFactRules(context.projectId, chapterId);
    return {
      deletedCount: result.deletedCount,
      createdCount: result.createdCount,
      factCounts: result.factCounts,
      issues: result.issues,
    };
  }
}