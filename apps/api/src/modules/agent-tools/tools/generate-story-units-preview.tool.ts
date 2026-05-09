import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import {
  STORY_UNIT_MAINLINE_RELATIONS,
  STORY_UNIT_PURPOSES,
  assertVolumeStoryUnitPlan,
  type VolumeStoryUnitPlan,
} from './story-unit-contracts';

const STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

interface GenerateStoryUnitsPreviewInput {
  context?: Record<string, unknown>;
  volumeOutline?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterCount?: number;
  densityPreference?: string;
  purposeMix?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface StoryUnitsPreviewOutput {
  volumeNo: number;
  chapterCount?: number;
  storyUnitPlan: VolumeStoryUnitPlan;
  risks: string[];
}

interface PersistStoryUnitsInput {
  preview?: StoryUnitsPreviewOutput;
}

@Injectable()
export class GenerateStoryUnitsPreviewTool implements BaseTool<GenerateStoryUnitsPreviewInput, StoryUnitsPreviewOutput> {
  private readonly logger = new StructuredLogger(GenerateStoryUnitsPreviewTool.name);
  name = 'generate_story_units_preview';
  description = '独立生成卷级单元故事计划，包含主线/人物/情感/背景/世界观/势力/悬念/爽点/缓冲等叙事目的，不写章节细纲。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      context: { type: 'object' as const },
      volumeOutline: { type: 'object' as const },
      instruction: { type: 'string' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      densityPreference: { type: 'string' as const },
      purposeMix: { type: ['object', 'array'] as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeNo', 'storyUnitPlan', 'risks'],
    properties: {
      volumeNo: { type: 'number' as const, minimum: 1 },
      chapterCount: { type: 'number' as const, minimum: 1 },
      storyUnitPlan: { type: 'object' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成单元故事计划',
    description: '在卷大纲之后独立生成 storyUnitPlan；单元故事本体只给建议篇幅和叙事交付物，若提供 chapterCount，则额外输出 chapterAllocation 供章节细纲承接。',
    whenToUse: [
      '用户要求丰富单元故事、支线故事、人物登场、人物情感、背景故事、世界观展示或卷内小故事时',
      '用户要求卷细纲、章节细纲或把卷拆成章节时，应在 generate_volume_outline_preview 后、generate_chapter_outline_preview 前使用',
      '需要把单元故事从 Volume.narrativePlan.storyUnits 解耦为独立预览和审批对象时',
    ],
    whenNotToUse: [
      '用户只要求卷大纲且不需要单元故事时，使用 generate_volume_outline_preview',
      '用户要求具体章节细纲或 Chapter.craftBrief 时，本工具只做上游计划，后续仍要用 generate_chapter_outline_preview',
      '用户要求写正文时使用 write_chapter 或 write_chapter_series',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '通常来自 inspect_project_context.output。' },
      volumeOutline: { source: 'previous_step', description: 'generate_volume_outline_preview.output.volume；单元故事必须承接其中的卷主线、支线、角色规划和伏笔。' },
      instruction: { source: 'user_message', description: '保留用户对单元故事密度、支线类型和人物情感的要求。' },
      chapterCount: { source: 'user_message', description: '若用户后续要章节细分，传入目标章节数；输出必须包含独立 chapterAllocation。' },
    },
    examples: [
      {
        user: '为第一卷生成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'characters', 'lorebook'] } },
          { tool: 'generate_volume_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_story_units_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', volumeNo: 1, chapterNo: 1, chapterCount: 60 } },
        ],
      },
    ],
    failureHints: [
      { code: 'LLM_TIMEOUT', meaning: '单元故事计划 LLM 超时', suggestedRepair: '重试单元故事步骤，或缩小目标卷范围。' },
      { code: 'INCOMPLETE_STORY_UNIT_PLAN', meaning: 'LLM 返回单元故事分类、交付物、建议篇幅或章节分配不完整', suggestedRepair: '重新生成单元故事计划，不要进入章节细纲。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateStoryUnitsPreviewInput, context: ToolContext): Promise<StoryUnitsPreviewOutput> {
    const volumeNo = this.positiveInt(args.volumeNo, 'volumeNo')
      ?? this.positiveInt(this.asRecord(args.volumeOutline).volumeNo, 'volumeOutline.volumeNo')
      ?? 1;
    const chapterCount = this.positiveInt(args.chapterCount, 'chapterCount')
      ?? this.positiveInt(this.asRecord(args.volumeOutline).chapterCount, 'volumeOutline.chapterCount');

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${volumeNo} 卷单元故事计划`,
      timeoutMs: STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS,
    });
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt(chapterCount) },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterCount) },
    ];
    const logContext = {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      volumeNo,
      chapterCount: chapterCount ?? null,
      timeoutMs: STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    this.logger.log('story_units_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<unknown>(
        messages,
        { appStep: 'planner', timeoutMs: STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      const normalized = this.normalize(response.data, volumeNo, chapterCount);
      this.logger.log('story_units_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
      });
      return normalized;
    } catch (error) {
      this.logger.error('story_units_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private normalize(data: unknown, volumeNo: number, chapterCount?: number): StoryUnitsPreviewOutput {
    const output = this.asRecord(data);
    const returnedVolumeNo = Number(output.volumeNo);
    if (!Number.isInteger(returnedVolumeNo) || returnedVolumeNo !== volumeNo) {
      throw new Error(`generate_story_units_preview volumeNo 与目标卷 ${volumeNo} 不匹配，未生成完整单元故事计划。`);
    }
    const returnedChapterCount = this.positiveInt(output.chapterCount, 'chapterCount');
    if (chapterCount !== undefined && returnedChapterCount !== chapterCount) {
      throw new Error(`generate_story_units_preview chapterCount 与目标章节数 ${chapterCount} 不匹配，未生成完整单元故事计划。`);
    }
    const storyUnitPlan = assertVolumeStoryUnitPlan(output.storyUnitPlan, {
      volumeNo,
      chapterCount,
      label: 'storyUnitPlan',
    });
    return {
      volumeNo,
      ...(chapterCount !== undefined ? { chapterCount } : {}),
      storyUnitPlan,
      risks: this.stringArray(output.risks),
    };
  }

  private buildSystemPrompt(chapterCount?: number): string {
    return [
      '你是小说单元故事设计 Agent。只输出严格 JSON，不要 Markdown、解释或代码块。',
      '本工具只生成 storyUnitPlan，不生成 chapters、Chapter.craftBrief、正文或场景卡。',
      '单元故事不是卷主线的平均切块，而是读者体验切片：主线推进、人物登场、人物刻画、人物情感、背景故事、世界观展示、势力博弈、悬念线索、成长能力、爽点兑现、反派塑造、日常缓冲、主题表达、过渡钩子都可以成为单元故事。',
      `primaryPurpose 和 secondaryPurposes 只能使用：${STORY_UNIT_PURPOSES.join(', ')}。`,
      `relationToMainline 只能使用：${STORY_UNIT_MAINLINE_RELATIONS.join(', ')}。`,
      '每个单元故事必须有具体人物、行动压力、情绪效果、至少 2 项 requiredDeliveries，并至少在人物、关系、世界观或线索四类贡献中命中一类。',
      '每个单元故事必须给 suggestedChapterMin 和 suggestedChapterMax，二者表示该单元的弹性建议篇幅，不是绝对章号，也不是 chapterAllocation 的硬性上限；不要把 chapterRange 写进 unit 本体。',
      chapterCount
        ? `本次目标章节数为 ${chapterCount}，必须在 storyUnitPlan.chapterAllocation 中独立分配连续章节范围，覆盖第 1 章到第 ${chapterCount} 章；chapterAllocation 是本次章节细分的可执行分配，优先保证连续覆盖、chapterRoles 数量匹配和叙事承接。`
        : '本次没有目标章节数，不要输出 chapterAllocation；只输出可后续扩展的单元故事池。',
      '禁止用“过渡章、调查章、冲突升级章”等模板名凑数；如果上下文不足以生成高质量单元故事，应让调用失败，而不是输出占位骨架。',
      '输出字段只包含 volumeNo、chapterCount、storyUnitPlan、risks。',
      'JSON 骨架：{"volumeNo":1,"chapterCount":60,"storyUnitPlan":{"planningPrinciple":"本卷单元故事编排原则","purposeMix":{"mainline_progress":"50%","character_depth":"15%","mystery_clue":"15%","daily_buffer":"按节奏插入"},"units":[{"unitId":"v1_unit_01","title":"罪籍入营","primaryPurpose":"mainline_progress","secondaryPurposes":["worldbuilding","character_depth"],"relationToMainline":"direct","suggestedChapterMin":3,"suggestedChapterMax":5,"narrativePurpose":"让主角进入盐灰峡工程体系并理解罪籍代价","localGoal":"拿到最低生存资格","localConflict":"工地规训、旧案污名和盐骨污染同时压迫","requiredDeliveries":["罪籍规则","妹妹线索"],"characterFocus":["陆沉舟"],"relationshipChanges":["与临时同伴从互疑到交换情报"],"worldbuildingReveals":["工分制度"],"clueProgression":["旧桥号第一次出现"],"emotionalEffect":["压迫","悬疑"],"payoff":"主角拿到临时工牌但名字进入盐监名单","stateChangeAfterUnit":"主角从被动押入转为主动寻找旧案线索"}],"chapterAllocation":[{"unitId":"v1_unit_01","chapterRange":{"start":1,"end":4},"chapterRoles":["入局","规则压迫","代价揭示","阶段反转"]}]},"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(args: GenerateStoryUnitsPreviewInput, volumeNo: number, chapterCount?: number): string {
    const context = this.asRecord(args.context);
    const project = this.asRecord(context.project);
    const volumeOutline = this.asRecord(args.volumeOutline);
    return [
      `用户目标：${args.instruction ?? '生成单元故事计划'}`,
      `目标卷：第 ${volumeNo} 卷`,
      chapterCount ? `目标章节数：${chapterCount}` : '目标章节数：未指定',
      args.densityPreference ? `单元密度偏好：${args.densityPreference}` : '',
      args.purposeMix ? `用户指定目的配比：${this.safeJson(args.purposeMix, 2000)}` : '',
      '',
      '项目概览：',
      this.safeJson({ title: project.title, genre: project.genre, tone: project.tone, synopsis: project.synopsis, outline: project.outline }, 4000),
      '',
      '上游卷大纲（必须承接其主线、支线、角色规划和伏笔；不要重写卷大纲）：',
      this.safeJson(volumeOutline, 7000),
      '',
      '已有角色摘要：',
      this.safeJson(Array.isArray(context.characters) ? context.characters.slice(0, 40) : [], 5000),
      '',
      '既有关系边摘要：',
      this.safeJson(Array.isArray(context.relationships) ? context.relationships.slice(0, 80) : [], 5000),
      '',
      '设定摘要：',
      this.safeJson(Array.isArray(context.lorebookEntries) ? context.lorebookEntries.slice(0, 40) : [], 5000),
      '',
      '请严格返回 JSON；若提供目标章节数，chapterAllocation 必须连续覆盖全卷。不要输出 chapters 或正文。',
    ].filter(Boolean).join('\n');
  }

  private positiveInt(value: unknown, _label: string): number | undefined {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => this.text(item)).filter(Boolean) : [];
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private safeJson(value: unknown, limit: number): string {
    const text = JSON.stringify(value ?? {}, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }
}

@Injectable()
export class PersistStoryUnitsTool implements BaseTool<PersistStoryUnitsInput, Record<string, unknown>> {
  name = 'persist_story_units';
  description = '审批后把独立单元故事计划写入 Volume.narrativePlan.storyUnitPlan，不创建或覆盖章节。';
  inputSchema = {
    type: 'object' as const,
    required: ['preview'],
    properties: {
      preview: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeId', 'volumeNo', 'storyUnitCount', 'updatedStoryUnitPlanOnly'],
    properties: {
      volumeId: { type: 'string' as const },
      volumeNo: { type: 'number' as const },
      storyUnitCount: { type: 'number' as const },
      updatedStoryUnitPlanOnly: { type: 'boolean' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['update_volume_story_unit_plan'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '写入单元故事计划',
    description: '审批后仅把 generate_story_units_preview.output.storyUnitPlan 写入 Volume.narrativePlan.storyUnitPlan；不会创建章节，也不会把单元故事硬写回 narrativePlan.storyUnits。',
    whenToUse: [
      '用户明确批准保存独立单元故事计划时',
      '上一步输出来自 generate_story_units_preview，且后续希望在另一次章节细分中继续复用该 storyUnitPlan 时',
    ],
    whenNotToUse: [
      '用户只是在 Plan 阶段预览单元故事时',
      '用户要求保存完整章节细纲时使用 persist_outline',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'generate_story_units_preview.output。' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: PersistStoryUnitsInput, context: ToolContext): Promise<Record<string, unknown>> {
    if (context.mode !== 'act') throw new BadRequestException('persist_story_units must run in act mode.');
    if (!context.approved) throw new BadRequestException('persist_story_units requires explicit user approval.');
    if (!args.preview?.storyUnitPlan) throw new BadRequestException('persist_story_units 需要单元故事预览。');

    const volumeNo = Number(args.preview.volumeNo);
    if (!Number.isInteger(volumeNo) || volumeNo < 1) throw new BadRequestException('persist_story_units blocked: volumeNo must be a positive integer.');
    const chapterCount = args.preview.chapterCount;
    const storyUnitPlan = assertVolumeStoryUnitPlan(args.preview.storyUnitPlan, {
      volumeNo,
      ...(chapterCount ? { chapterCount } : {}),
      label: 'storyUnitPlan',
    });

    const existing = await this.prisma.volume.findUnique({
      where: { projectId_volumeNo: { projectId: context.projectId, volumeNo } },
    });
    if (!existing) {
      throw new BadRequestException('persist_story_units blocked: target Volume does not exist. Persist the volume outline first.');
    }

    const currentNarrativePlan = this.asRecord(existing.narrativePlan);
    const updatedNarrativePlan = {
      ...currentNarrativePlan,
      storyUnitPlan: storyUnitPlan as unknown as Prisma.InputJsonValue,
    } as Prisma.InputJsonObject;
    const saved = await this.prisma.volume.update({
      where: { id: existing.id },
      data: { narrativePlan: updatedNarrativePlan },
    });

    return {
      volumeId: saved.id,
      volumeNo,
      storyUnitCount: storyUnitPlan.units.length,
      updatedStoryUnitPlanOnly: true,
      risks: args.preview.risks ?? [],
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
