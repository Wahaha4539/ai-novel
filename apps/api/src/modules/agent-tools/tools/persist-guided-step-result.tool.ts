import { BadRequestException, Injectable } from '@nestjs/common';
import { GuidedService } from '../../guided/guided.service';
import { getGuidedStepJsonSchema, type GuidedStepSchemaKey } from '../../guided/guided-step-schemas';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { ValidateGuidedStepPreviewTool, type ValidateGuidedStepPreviewOutput } from './validate-guided-step-preview.tool';

interface PersistGuidedStepResultInput {
  stepKey?: string;
  structuredData?: Record<string, unknown>;
  validation?: ValidateGuidedStepPreviewOutput;
  volumeNo?: number;
}

export interface PersistGuidedStepResultOutput {
  stepKey: string;
  written: string[];
  validation: ValidateGuidedStepPreviewOutput;
  writePreview: Record<string, unknown>;
  approval: {
    required: true;
    approved: boolean;
    mode: string;
  };
  persistedAt: string;
}

/**
 * 创作引导步骤结果持久化工具：仅在 Agent Act + 用户审批后写入业务表。
 * 写入前强制执行 validate_guided_step_preview，避免绕过校验直接调用旧 guided finalize 逻辑。
 */
@Injectable()
export class PersistGuidedStepResultTool implements BaseTool<PersistGuidedStepResultInput, PersistGuidedStepResultOutput> {
  name = 'persist_guided_step_result';
  description = '审批后将已校验的创作引导步骤结构化结果写入项目资料、角色、卷章或伏笔。';
  inputSchema = {
    type: 'object' as const,
    required: ['stepKey', 'structuredData'],
    additionalProperties: false,
    properties: {
      stepKey: { type: 'string' as const },
      structuredData: { type: 'object' as const },
      validation: { type: 'object' as const },
      volumeNo: { type: 'number' as const, minimum: 1, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['stepKey', 'written', 'validation', 'writePreview', 'approval', 'persistedAt'],
    properties: {
      stepKey: { type: 'string' as const },
      written: { type: 'array' as const, items: { type: 'string' as const } },
      validation: { type: 'object' as const },
      writePreview: { type: 'object' as const },
      approval: { type: 'object' as const },
      persistedAt: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = [
    'update_project_profile',
    'create_or_update_style_profile',
    'create_or_update_characters',
    'update_project_outline',
    'replace_project_outline_foreshadows',
    'create_or_update_volumes',
    'create_or_update_planned_chapters',
    'create_or_update_foreshadow_tracks',
  ];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '写入创作引导步骤结果',
    description: '在用户审批后，将 validate_guided_step_preview 通过的 guided step 结构化结果写入项目业务表。高风险写入工具，只允许 Act 阶段执行。',
    whenToUse: ['validate_guided_step_preview 已通过', '用户确认保存当前创作引导步骤结果', '需要把 guided_step_preview 正式写入项目资料、角色、卷章或伏笔'],
    whenNotToUse: ['Plan 阶段或预览阶段', '没有 structuredData', '校验未通过或用户未审批', '用户只是咨询或生成预览'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      stepKey: { source: 'previous_step', description: '来自 generate_guided_step_preview.stepKey 或 context.session.guided.currentStep。' },
      structuredData: { source: 'previous_step', description: '来自已审阅的 guided_step_preview.structuredData。' },
      validation: { source: 'previous_step', description: '来自 validate_guided_step_preview 的输出；执行时仍会重新校验。' },
      volumeNo: { source: 'context', description: '章节细纲按卷写入时的目标卷号。' },
    },
    preconditions: ['用户已审批写入计划', 'Agent 运行模式必须是 act', 'validate_guided_step_preview 必须 valid=true'],
    postconditions: ['复用 GuidedService.finalizeStep 的归一化写入逻辑', '写入结果同步到 guided session stepData', 'GuidedService 负责在实际写入后清理项目召回缓存'],
    failureHints: [
      { code: 'VALIDATION_FAILED', meaning: '创作引导步骤预览未通过写入前校验。', suggestedRepair: '先修正 structuredData 并重新调用 validate_guided_step_preview。' },
      { code: 'APPROVAL_REQUIRED', meaning: '写入工具必须在用户审批后的 Act 阶段执行。', suggestedRepair: '生成审批计划并等待用户确认后再执行。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(
    private readonly guidedService: GuidedService,
    private readonly validateGuidedStepPreviewTool: ValidateGuidedStepPreviewTool,
  ) {}

  async run(args: PersistGuidedStepResultInput, context: ToolContext): Promise<PersistGuidedStepResultOutput> {
    const { stepKey, structuredData } = this.assertExecutableInput(args, context);
    const validation = await this.validateBeforePersist(stepKey, structuredData, args, context);

    const result = await this.guidedService.finalizeStep(context.projectId, stepKey, structuredData, args.volumeNo);
    return {
      stepKey,
      written: result.written,
      validation,
      writePreview: validation.writePreview,
      approval: { required: true, approved: context.approved, mode: context.mode },
      persistedAt: new Date().toISOString(),
    };
  }

  private assertExecutableInput(args: PersistGuidedStepResultInput, context: ToolContext): { stepKey: GuidedStepSchemaKey; structuredData: Record<string, unknown> } {
    if (context.mode !== 'act') throw new BadRequestException('persist_guided_step_result 只能在 Agent Act 阶段执行。');
    if (!context.approved) throw new BadRequestException('persist_guided_step_result 需要用户审批后执行。');

    const stepKey = this.text(args.stepKey);
    if (!stepKey) throw new BadRequestException('persist_guided_step_result 缺少 stepKey。');
    if (!getGuidedStepJsonSchema(stepKey)) throw new BadRequestException(`未知创作引导步骤：${stepKey}`);

    const structuredData = this.asRecord(args.structuredData);
    if (!structuredData) throw new BadRequestException('persist_guided_step_result 缺少 structuredData。');

    return { stepKey: stepKey as GuidedStepSchemaKey, structuredData };
  }

  private async validateBeforePersist(stepKey: GuidedStepSchemaKey, structuredData: Record<string, unknown>, args: PersistGuidedStepResultInput, context: ToolContext): Promise<ValidateGuidedStepPreviewOutput> {
    if (args.validation && args.validation.valid === false) {
      throw new BadRequestException(`创作引导步骤预览校验未通过，已阻止写入：${this.describeIssues(args.validation)}`);
    }

    const validation = await this.validateGuidedStepPreviewTool.run(
      { stepKey, structuredData, volumeNo: args.volumeNo },
      { ...context, mode: 'act' },
    );

    if (!validation.valid) {
      throw new BadRequestException(`创作引导步骤预览校验未通过，已阻止写入：${this.describeIssues(validation)}`);
    }

    return validation;
  }

  private describeIssues(validation: ValidateGuidedStepPreviewOutput): string {
    const messages = validation.issues.map((issue) => issue.message).filter(Boolean).slice(0, 5);
    return messages.length ? messages.join('；') : '存在未通过校验的问题';
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}
