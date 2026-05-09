import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { normalizeWithLlmRepair } from './structured-output-repair';
import {
  STORY_UNIT_MAINLINE_RELATIONS,
  STORY_UNIT_PURPOSES,
  assertVolumeStoryUnitPlan,
  type VolumeStoryUnitPlan,
} from './story-unit-contracts';

const STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

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
  description = '独立生成卷级单元故事计划，先拆卷主线段，再设计主线/灾难求生/人物/情感/背景/世界观/势力/悬念/爽点/缓冲等单元故事，不写章节细纲。';
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
  executionTimeoutMs = STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS + STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成单元故事计划',
    description: '在卷大纲之后独立生成 storyUnitPlan；先把卷主线拆成 mainlineSegments，再让单元故事绑定主线段并给出建议篇幅和叙事交付物；若提供 chapterCount，则额外输出 chapterAllocation 供章节细纲承接。',
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
      volumeOutline: { source: 'previous_step', description: '可选。若用户明确重写卷大纲，可传 generate_volume_outline_preview.output.volume；否则工具会从 inspect_project_context.output.volumes 中读取目标卷。' },
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
      { code: 'INCOMPLETE_STORY_UNIT_PLAN', meaning: 'LLM 返回主线段、单元故事分类、交付物、建议篇幅或章节分配不完整', suggestedRepair: '重新生成单元故事计划，不要进入章节细纲。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateStoryUnitsPreviewInput, context: ToolContext): Promise<StoryUnitsPreviewOutput> {
    const contextRecord = this.asRecord(args.context);
    const explicitVolumeOutline = this.asRecord(args.volumeOutline);
    const initialVolumeNo = this.positiveInt(args.volumeNo, 'volumeNo')
      ?? this.positiveInt(explicitVolumeOutline.volumeNo, 'volumeOutline.volumeNo')
      ?? this.positiveInt(this.firstContextVolume(contextRecord)?.volumeNo, 'context.volumes.volumeNo')
      ?? 1;
    const contextVolumeOutline = this.findContextVolume(contextRecord, initialVolumeNo);
    const volumeOutline = Object.keys(explicitVolumeOutline).length ? explicitVolumeOutline : contextVolumeOutline;
    const volumeNo = this.positiveInt(args.volumeNo, 'volumeNo')
      ?? this.positiveInt(volumeOutline.volumeNo, 'volumeOutline.volumeNo')
      ?? initialVolumeNo;
    const chapterCount = resolveStoryUnitChapterCount(args.chapterCount, volumeOutline, args.instruction);

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${volumeNo} 卷单元故事计划`,
      timeoutMs: STORY_UNITS_PREVIEW_LLM_TIMEOUT_MS,
    });
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt(chapterCount) },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterCount, volumeOutline) },
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
      const normalized = await normalizeWithLlmRepair({
        toolName: this.name,
        loggerEventPrefix: 'story_units_preview',
        llm: this.llm,
        context,
        data: response.data,
        normalize: (data) => this.normalize(data, volumeNo, chapterCount),
        shouldRepair: ({ error, data }) => this.shouldRepairChapterAllocation(data, error),
        buildRepairMessages: ({ invalidOutput, validationError }) =>
          this.buildRepairMessages(invalidOutput, validationError, volumeNo, chapterCount),
        progress: {
          phaseMessage: `正在修复第 ${volumeNo} 卷单元故事章节分配`,
          timeoutMs: STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS,
        },
        llmOptions: {
          appStep: 'planner',
          timeoutMs: STORY_UNITS_PREVIEW_REPAIR_TIMEOUT_MS,
          temperature: 0.1,
        },
        maxRepairAttempts: 1,
        initialModel: response.result.model,
        logger: this.logger,
      });
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

  private buildRepairMessages(invalidOutput: unknown, validationError: string, volumeNo: number, chapterCount?: number): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          '你是小说 storyUnitPlan JSON 修复器。只输出严格 JSON，不要 Markdown、解释或代码块。',
          '只修复结构校验错误，尽量保留原有卷主线、单元故事、人物、关系、线索和情绪设计；不要重写成新的卷大纲。',
          '不得输出占位或模板化章节角色。chapterRoles 必须逐章具体说明该章在本单元中的叙事作用，并承接 unit 的 localGoal、localConflict、payoff 和 stateChangeAfterUnit。',
          '返回完整对象，只包含 volumeNo、chapterCount、storyUnitPlan、risks。',
          '如果 chapterCount 存在，storyUnitPlan.chapterAllocation 必须连续覆盖第 1 章到目标章数；每个 allocation 的 roleCount = chapterRange.end - chapterRange.start + 1，chapterRoles.length 必须严格等于 roleCount。例如 start=41,end=45 时必须有 5 个 chapterRoles。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            targetVolumeNo: volumeNo,
            targetChapterCount: chapterCount ?? null,
            validationError,
            allowedPrimaryAndSecondaryPurposes: STORY_UNIT_PURPOSES,
            allowedRelationToMainline: STORY_UNIT_MAINLINE_RELATIONS,
            invalidOutput,
            outputContract: {
              volumeNo,
              chapterCount: chapterCount ?? 'omit only when targetChapterCount is null',
              storyUnitPlan: {
                planningPrinciple: 'string',
                purposeMix: 'object or array',
                mainlineSegments: 'preserve and keep sequence continuous from 1',
                units: 'preserve rich unit details and valid enum values',
                chapterAllocation: chapterCount
                  ? `continuous ranges covering 1..${chapterCount}; chapterRoles length must equal end-start+1 for every item`
                  : 'omit',
              },
              risks: ['string'],
            },
          },
          null,
          2,
        ),
      },
    ];
  }

  private shouldRepairChapterAllocation(data: unknown, error: unknown): boolean {
    const message = this.errorMessage(error);
    if (!message.includes('chapterAllocation')) return false;
    return this.asRecord(this.asRecord(data).storyUnitPlan).chapterAllocation !== undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
      '必须先把卷主线拆成 storyUnitPlan.mainlineSegments：这些段落是本卷主线骨架，必须按 sequence 从 1 连续递增，并覆盖卷开局状态、主要压力、关键反转、代价和卷末交接。',
      '单元故事不是卷主线的平均切块，而是读者体验切片：主线推进、灾难求生、人物登场、人物刻画、人物情感、背景故事、世界观展示、势力博弈、悬念线索、成长能力、爽点兑现、反派塑造、日常缓冲、主题表达、过渡钩子都可以成为单元故事。',
      `primaryPurpose 和 secondaryPurposes 只能使用：${STORY_UNIT_PURPOSES.join(', ')}。`,
      `relationToMainline 只能使用：${STORY_UNIT_MAINLINE_RELATIONS.join(', ')}。`,
      '每个 mainlineSegment 必须包含 segmentId、sequence、title、narrativeFunction、mainGoal、mainConflict、turningPoint、stateChange、至少 2 项 requiredDeliveries。',
      '每个单元故事必须用 mainlineSegmentIds 引用至少 1 个主线段，并写明 serviceToMainline；所有 mainlineSegments 都必须至少被 1 个单元故事覆盖。',
      '每个单元故事必须有具体人物、行动压力、情绪效果、至少 2 项 requiredDeliveries，并至少在人物、关系、世界观或线索四类贡献中命中一类。',
      'characterFocus 和 relationshipChanges 应承接上游既有角色或 volumeOutline.narrativePlan.characterPlan.newCharacterCandidates；如果发现某个重要新人物缺失，应在 risks 中要求先重跑卷大纲补充 newCharacterCandidates，不要在 storyUnitPlan 里偷偷发明未持久化的重要角色。',
      '每个单元故事必须给 suggestedChapterMin 和 suggestedChapterMax，二者表示该单元的弹性建议篇幅，不是绝对章号，也不是 chapterAllocation 的硬性上限；不要把 chapterRange 写进 unit 本体。',
      chapterCount
        ? `本次目标章节数为 ${chapterCount}，必须在 storyUnitPlan.chapterAllocation 中独立分配连续章节范围，覆盖第 1 章到第 ${chapterCount} 章；chapterAllocation 是本次章节细分的可执行分配，优先保证连续覆盖、chapterRoles 数量匹配和叙事承接。`
        : '本次没有目标章节数，不要输出 chapterAllocation；只输出可后续扩展的单元故事池。',
      chapterCount
        ? 'chapterAllocation 硬约束：每个 allocation 的 roleCount = chapterRange.end - chapterRange.start + 1；chapterRoles 必须逐章列出 exactly roleCount 项。例：start=41,end=45 时必须有 5 项 chapterRoles。'
        : '',
      '禁止用“过渡章、调查章、冲突升级章”等模板名凑数；如果上下文不足以生成高质量单元故事，应让调用失败，而不是输出占位骨架。',
      '输出字段只包含 volumeNo、chapterCount、storyUnitPlan、risks。',
      'JSON 骨架：{"volumeNo":1,"chapterCount":60,"storyUnitPlan":{"planningPrinciple":"先拆卷主线承重段，再用人物、关系、世界观和支线单元丰富阅读体验。","purposeMix":{"mainline_progress":"45%","survival_disaster":"15%","character_depth":"15%","mystery_clue":"15%","daily_buffer":"按节奏插入"},"mainlineSegments":[{"segmentId":"v1_main_01","sequence":1,"title":"罪籍入营","narrativeFunction":"入局","mainGoal":"让主角进入盐灰峡工程体系并拿到最低生存资格","mainConflict":"罪籍身份、营规剥削和小归潮倒计时同时压迫","turningPoint":"主角发现营地建材混入活盐骨","stateChange":"主角从被动押入转为主动寻找旧案线索","requiredDeliveries":["罪籍规则","活盐骨异常"]}],"units":[{"unitId":"v1_unit_01","title":"罪籍入营","primaryPurpose":"survival_disaster","secondaryPurposes":["worldbuilding","character_depth"],"relationToMainline":"direct","mainlineSegmentIds":["v1_main_01"],"serviceToMainline":"完成入局段的生存资格与活盐骨异常交付，同时用罪籍压迫刻画主角。","suggestedChapterMin":3,"suggestedChapterMax":5,"narrativePurpose":"让主角进入盐灰峡工程体系并理解罪籍代价","localGoal":"拿到最低生存资格","localConflict":"工地规训、小归潮威胁、旧案污名和盐骨污染同时压迫","requiredDeliveries":["罪籍规则","妹妹线索"],"characterFocus":["陆沉舟"],"relationshipChanges":["与临时同伴从互疑到交换情报"],"worldbuildingReveals":["工分制度"],"clueProgression":["旧桥号第一次出现"],"emotionalEffect":["压迫","悬疑"],"payoff":"主角拿到临时工牌但名字进入盐监名单","stateChangeAfterUnit":"主角从被动押入转为主动寻找旧案线索"}],"chapterAllocation":[{"unitId":"v1_unit_01","chapterRange":{"start":1,"end":4},"chapterRoles":["入局","规则压迫","代价揭示","阶段反转"]}]},"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(args: GenerateStoryUnitsPreviewInput, volumeNo: number, chapterCount?: number, resolvedVolumeOutline: Record<string, unknown> = {}): string {
    const context = this.asRecord(args.context);
    const project = this.asRecord(context.project);
    const explicitVolumeOutline = this.asRecord(args.volumeOutline);
    const volumeOutline = Object.keys(resolvedVolumeOutline).length ? resolvedVolumeOutline : explicitVolumeOutline;
    const narrativePlan = this.asRecord(volumeOutline.narrativePlan);
    const characterPlan = this.asRecord(narrativePlan.characterPlan);
    const volumeCandidates = Array.isArray(characterPlan.newCharacterCandidates) ? characterPlan.newCharacterCandidates.slice(0, 30) : [];
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
      '上游卷大纲（必须先拆解其中的卷主线，再承接支线、角色规划和伏笔；不要重写卷大纲）：',
      this.safeJson(volumeOutline, 7000),
      '',
      '上游卷级候选人物（单元故事可以引用这些候选；如缺少重要新人物，应提示先回到卷大纲新增候选）：',
      this.safeJson(volumeCandidates, 3000),
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
      '请严格返回 JSON；必须包含 mainlineSegments 和 units，且每个 unit 必须用 mainlineSegmentIds 绑定它服务的主线段；若提供目标章节数，chapterAllocation 必须连续覆盖全卷。不要输出 chapters 或正文。',
      chapterCount
        ? `逐章分配硬约束：每个 chapterAllocation[i].chapterRoles.length 必须等于 chapterRange.end - chapterRange.start + 1；全体 chapterRange 必须连续覆盖 1..${chapterCount}。`
        : '',
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

  private firstContextVolume(context: Record<string, unknown>): Record<string, unknown> | undefined {
    return Array.isArray(context.volumes)
      ? context.volumes.map((item) => this.asRecord(item)).find((item) => Object.keys(item).length > 0)
      : undefined;
  }

  private findContextVolume(context: Record<string, unknown>, volumeNo: number): Record<string, unknown> {
    const volumes = Array.isArray(context.volumes) ? context.volumes.map((item) => this.asRecord(item)) : [];
    return volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
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
      chapterCount: { type: 'number' as const, minimum: 1 },
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
    const existing = await this.prisma.volume.findUnique({
      where: { projectId_volumeNo: { projectId: context.projectId, volumeNo } },
    });
    if (!existing) {
      throw new BadRequestException('persist_story_units blocked: target Volume does not exist. Persist the volume outline first.');
    }

    const currentNarrativePlan = this.asRecord(existing.narrativePlan);
    const previewChapterCount = positiveIntValue(args.preview.chapterCount);
    const existingChapterCount = resolveStoryUnitChapterCount(undefined, {
      chapterCount: existing.chapterCount,
      objective: existing.objective,
      synopsis: existing.synopsis,
      narrativePlan: currentNarrativePlan,
    });
    if (previewChapterCount && existingChapterCount && previewChapterCount !== existingChapterCount) {
      throw new BadRequestException(`persist_story_units blocked: preview.chapterCount ${previewChapterCount} does not match Volume planned chapterCount ${existingChapterCount}.`);
    }
    const chapterCount = existingChapterCount ?? previewChapterCount;
    const storyUnitPlan = assertVolumeStoryUnitPlan(args.preview.storyUnitPlan, {
      volumeNo,
      ...(chapterCount ? { chapterCount } : {}),
      label: 'storyUnitPlan',
    });

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
      ...(chapterCount ? { chapterCount } : {}),
      storyUnitCount: storyUnitPlan.units.length,
      updatedStoryUnitPlanOnly: true,
      risks: args.preview.risks ?? [],
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}

function resolveStoryUnitChapterCount(rawChapterCount: unknown, volumeOutline: Record<string, unknown>, instruction = ''): number | undefined {
  return positiveIntValue(rawChapterCount)
    ?? positiveIntValue(volumeOutline.chapterCount)
    ?? inferChapterCountFromText(instruction)
    ?? inferChapterCountFromText(text(volumeOutline.objective))
    ?? inferChapterCountFromText(text(volumeOutline.synopsis));
}

function positiveIntValue(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function inferChapterCountFromText(value: string): number | undefined {
  if (!value) return undefined;
  const patterns = [
    /(?:全卷|本卷|目标|计划|规划|篇幅|章节数|总章数|共|在|按|拆成|拆为|细分为)[^\d]{0,12}(\d{1,4})\s*章/u,
    /(\d{1,4})\s*章(?:篇幅|内|左右|上下|细纲|章节规划|单元分配)/u,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const count = positiveIntValue(match?.[1]);
    if (count) return count;
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
