import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface GenerateWorldbuildingPreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  focus?: string[];
  maxEntries?: number;
}

export interface WorldbuildingPreviewEntry {
  title: string;
  entryType: string;
  summary: string;
  content: string;
  tags: string[];
  priority: number;
  impactAnalysis: string;
  relatedExistingFacts: string[];
  lockedFactHandling: string;
}

export interface WorldbuildingPreviewOutput {
  entries: WorldbuildingPreviewEntry[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    requiresValidation: boolean;
    requiresApprovalBeforePersist: boolean;
  };
}

/**
 * 世界观扩展预览工具：基于项目上下文生成增量设定候选，只输出预览，不写入设定库。
 * 该工具让“扩展世界观”任务先经过可审阅草案与后续冲突校验，避免直接污染 locked facts。
 */
@Injectable()
export class GenerateWorldbuildingPreviewTool implements BaseTool<GenerateWorldbuildingPreviewInput, WorldbuildingPreviewOutput> {
  name = 'generate_worldbuilding_preview';
  description = '根据项目上下文和用户要求生成增量世界观设定预览，不写入正式设定库。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      focus: { type: 'array' as const, items: { type: 'string' as const } },
      maxEntries: { type: 'number' as const, minimum: 1, maximum: 20, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['entries', 'assumptions', 'risks', 'writePlan'],
    properties: {
      entries: { type: 'array' as const },
      assumptions: { type: 'array' as const, items: { type: 'string' as const } },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
      writePlan: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成世界观扩展预览',
    description: '为世界观、宗门体系、城市、能力体系、历史背景等生成增量设定候选；只生成预览，不写业务表。',
    whenToUse: ['用户要求扩展世界观、宗门体系、城市、能力体系或历史背景', '需要先给出不覆盖现有设定的世界观候选', '后续会调用 validate_worldbuilding 做冲突校验'],
    whenNotToUse: ['用户要求写章节正文或润色章节', '用户只是检查角色一致性', '用户要求直接持久化设定；必须先 validate_worldbuilding 并审批'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '来自 inspect_project_context 或 collect_task_context 的项目、世界事实和剧情约束。' },
      instruction: { source: 'user_message', description: '保留用户关于“不影响已有剧情”“只补充宗门体系”等限制。' },
      focus: { source: 'literal', description: '扩展关注点，例如 sect_system、power_rules、locked_world_facts。' },
      maxEntries: { source: 'literal', description: '本次最多生成多少条设定候选，未指定时默认 5 条。' },
    },
    examples: [
      {
        user: '补充宗门体系，但不要影响已有剧情。',
        plan: [
          { tool: 'inspect_project_context', args: {} },
          { tool: 'collect_task_context', args: { taskType: 'worldbuilding_expand', focus: ['locked_world_facts', 'plot_facts'] } },
          { tool: 'generate_worldbuilding_preview', args: { context: '{{steps.collect_task_context.output}}', instruction: '补充宗门体系，但不要影响已有剧情。', focus: ['sect_system', 'locked_world_facts'] } },
          { tool: 'validate_worldbuilding', args: { preview: '{{steps.generate_worldbuilding_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  /** 调用 LLM 生成结构化世界观预览，并将不稳定字段归一化为前端可审阅格式。 */
  async run(args: GenerateWorldbuildingPreviewInput, _context: ToolContext): Promise<WorldbuildingPreviewOutput> {
    const maxEntries = Math.min(20, Math.max(1, Number(args.maxEntries) || 5));
    const { data } = await this.llm.chatJson<WorldbuildingPreviewOutput>(
      [
        {
          role: 'system',
          content:
            '你是 AI Novel 的世界观扩展 Agent。只输出 JSON，不要 Markdown。必须增量扩展，不覆盖 locked facts 或已确认剧情。字段必须包含 entries、assumptions、risks、writePlan。entries 每项包含 title/entryType/summary/content/tags/priority/impactAnalysis/relatedExistingFacts/lockedFactHandling。',
        },
        {
          role: 'user',
          content: `用户目标：${args.instruction ?? '扩展世界观'}\n关注点：${this.stringArray(args.focus).join(', ') || '通用世界观'}\n最多条目：${maxEntries}\n项目上下文：\n${JSON.stringify(args.context ?? {}, null, 2).slice(0, 24000)}`,
        },
      ],
      { appStep: 'planner', maxTokens: Math.min(8000, maxEntries * 700 + 1200), timeoutMs: 120_000, retries: 1 },
    );
    return this.normalize(data, maxEntries);
  }

  /** 防御 LLM 返回缺字段、非字符串或超量条目，确保后续校验工具拿到稳定结构。 */
  private normalize(data: Partial<WorldbuildingPreviewOutput>, maxEntries: number): WorldbuildingPreviewOutput {
    const entries = (Array.isArray(data.entries) ? data.entries : []).slice(0, maxEntries).map((entry, index) => ({
      title: this.text(entry.title, `世界观设定 ${index + 1}`),
      entryType: this.text(entry.entryType, 'setting'),
      summary: this.text(entry.summary, ''),
      content: this.text(entry.content, this.text(entry.summary, '待补充内容')),
      tags: this.stringArray(entry.tags),
      priority: Math.min(100, Math.max(0, Number(entry.priority) || 50)),
      impactAnalysis: this.text(entry.impactAnalysis, '作为增量设定加入，不覆盖既有剧情。'),
      relatedExistingFacts: this.stringArray(entry.relatedExistingFacts),
      lockedFactHandling: this.text(entry.lockedFactHandling, '不修改 locked facts，仅补充兼容解释。'),
    }));
    return {
      entries,
      assumptions: this.stringArray(data.assumptions),
      risks: this.stringArray(data.risks),
      writePlan: { mode: 'preview_only', requiresValidation: true, requiresApprovalBeforePersist: true },
    };
  }

  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
  }
}