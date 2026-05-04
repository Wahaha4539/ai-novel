import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { getGuidedStepJsonSchema } from '../../guided/guided-step-schemas';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface GenerateGuidedStepPreviewInput {
  stepKey?: string;
  userHint?: string;
  projectContext?: Record<string, unknown>;
  chatSummary?: string;
  volumeNo?: number;
  chapterNo?: number;
}

export interface GuidedStepPreviewOutput {
  stepKey: string;
  structuredData: Record<string, unknown>;
  summary: string;
  warnings: string[];
}

const SUPPORTED_STEP_INSTRUCTIONS: Record<string, string> = {
  guided_setup: '生成小说基础设定，字段覆盖 genre/theme/tone/logline/synopsis。',
  guided_style: '根据已有基础设定生成叙事风格，字段覆盖 pov/tense/proseStyle/pacing。',
};

/**
 * 创作引导步骤预览工具：只生成可审阅结构化草案，不写入业务表。
 */
@Injectable()
export class GenerateGuidedStepPreviewTool implements BaseTool<GenerateGuidedStepPreviewInput, GuidedStepPreviewOutput> {
  name = 'generate_guided_step_preview';
  description = '根据创作引导当前步骤、项目上下文和用户提示生成结构化步骤预览，不写入业务表。';
  inputSchema = {
    type: 'object' as const,
    required: ['stepKey'],
    additionalProperties: false,
    properties: {
      stepKey: { type: 'string' as const, enum: ['guided_setup', 'guided_style'] },
      userHint: { type: 'string' as const },
      projectContext: { type: 'object' as const },
      chatSummary: { type: 'string' as const },
      volumeNo: { type: 'number' as const, minimum: 1, integer: true },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['stepKey', 'structuredData', 'summary', 'warnings'],
    properties: {
      stepKey: { type: 'string' as const },
      structuredData: { type: 'object' as const },
      summary: { type: 'string' as const },
      warnings: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成创作引导步骤预览',
    description: '为创作引导页当前步骤生成结构化预览；当前支持基础设定和风格定义，只读且不持久化。',
    whenToUse: ['用户在创作引导页要求 AI 生成当前步骤草案', 'context.session.guided.currentStep 是 guided_setup 或 guided_style', '需要先生成可审阅 Artifact，再由后续工具校验和写入'],
    whenNotToUse: ['用户只是提问当前步骤填写建议，应使用 guided_step_consultation', '用户要求直接保存结构化数据，必须先校验并审批后再持久化', '当前步骤是角色、大纲、卷纲、章节或伏笔，等待扩展支持'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      stepKey: { source: 'context', description: '来自 context.session.guided.currentStep；当前支持 guided_setup/guided_style。' },
      userHint: { source: 'user_message', description: '用户对本次生成的偏好或补充要求。' },
      projectContext: { source: 'context', description: '当前项目资料、已完成 guided stepData 或 collect_task_context 输出。' },
      chatSummary: { source: 'context', description: '当前步骤右侧 AI 助手对话摘要，可为空。' },
    },
    examples: [
      {
        user: '帮我生成基础设定，偏悬疑但不要太黑暗。',
        context: { session: { guided: { currentStep: 'guided_setup' } } },
        plan: [{ tool: 'generate_guided_step_preview', args: { stepKey: 'guided_setup', userHint: '偏悬疑但不要太黑暗', projectContext: '{{context.session.guided.documentDraft}}' } }],
      },
      {
        user: '根据刚才的设定给一个更冷静克制的文风。',
        context: { session: { guided: { currentStep: 'guided_style' } } },
        plan: [{ tool: 'generate_guided_step_preview', args: { stepKey: 'guided_style', userHint: '冷静克制', projectContext: '{{context.session.guided.documentDraft}}' } }],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    artifactMapping: [{ outputPath: '$', artifactType: 'guided_step_preview', title: '创作引导步骤预览' }],
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateGuidedStepPreviewInput, _context: ToolContext): Promise<GuidedStepPreviewOutput> {
    const stepKey = args.stepKey?.trim();
    if (!stepKey) throw new BadRequestException('缺少 stepKey，无法生成创作引导步骤预览。');

    const schema = getGuidedStepJsonSchema(stepKey);
    if (!schema) throw new NotFoundException(`未知创作引导步骤：${stepKey}`);

    const stepInstruction = SUPPORTED_STEP_INSTRUCTIONS[stepKey];
    if (!stepInstruction) {
      throw new BadRequestException(`generate_guided_step_preview 当前暂支持 guided_setup/guided_style，尚未支持 ${stepKey}。`);
    }

    const { data } = await this.llm.chatJson<Record<string, unknown>>(
      [
        {
          role: 'system',
          content: `你是 AI Novel 的创作引导预览 Agent。只输出 JSON，不要 Markdown，不要外层解释。当前步骤：${stepKey}。输出必须严格符合这个 JSON 示例结构：${schema}`,
        },
        {
          role: 'user',
          content: [
            `步骤要求：${stepInstruction}`,
            `用户提示：${args.userHint ?? ''}`,
            `聊天摘要：${args.chatSummary ?? ''}`,
            `卷号：${args.volumeNo ?? ''}`,
            `章节号：${args.chapterNo ?? ''}`,
            `项目上下文：\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 20000)}`,
          ].join('\n'),
        },
      ],
      { appStep: 'planner', maxTokens: 2500, timeoutMs: 120_000, retries: 1 },
    );

    const normalized = this.normalizeStructuredData(data);
    return {
      stepKey,
      structuredData: normalized.structuredData,
      summary: this.buildSummary(stepKey, normalized.structuredData),
      warnings: normalized.warnings,
    };
  }

  private normalizeStructuredData(data: unknown): { structuredData: Record<string, unknown>; warnings: string[] } {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { structuredData: data as Record<string, unknown>, warnings: [] };
    }
    return { structuredData: {}, warnings: ['模型返回的步骤预览不是 JSON 对象，已返回空预览。'] };
  }

  private buildSummary(stepKey: string, data: Record<string, unknown>): string {
    if (stepKey === 'guided_setup') {
      const genre = this.text(data.genre);
      const theme = this.text(data.theme);
      const logline = this.text(data.logline);
      return [genre, theme, logline].filter(Boolean).join(' / ') || '已生成基础设定预览。';
    }

    if (stepKey === 'guided_style') {
      const pov = this.text(data.pov);
      const proseStyle = this.text(data.proseStyle);
      const pacing = this.text(data.pacing);
      return [pov, proseStyle, pacing].filter(Boolean).join(' / ') || '已生成风格定义预览。';
    }

    return '已生成创作引导步骤预览。';
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}
