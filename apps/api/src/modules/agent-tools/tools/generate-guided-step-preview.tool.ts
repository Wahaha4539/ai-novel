import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA,
  GUIDED_STEP_JSON_SCHEMAS,
  getGuidedStepJsonSchema,
  type GuidedStepSchemaKey,
} from '../../guided/guided-step-schemas';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { Prisma } from '@prisma/client';

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

const GUIDED_STEP_KEYS = Object.keys(GUIDED_STEP_JSON_SCHEMAS) as GuidedStepSchemaKey[];
const GUIDED_STEP_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const GUIDED_STEP_PREVIEW_LLM_RETRIES = 1;
const GUIDED_STEP_PREVIEW_PHASE_TIMEOUT_MS = GUIDED_STEP_PREVIEW_LLM_TIMEOUT_MS * (GUIDED_STEP_PREVIEW_LLM_RETRIES + 1) + 5_000;

const SUPPORTED_STEP_INSTRUCTIONS: Record<GuidedStepSchemaKey, string> = {
  guided_setup: '生成小说基础设定，字段覆盖 genre/theme/tone/logline/synopsis。',
  guided_style: '根据已有基础设定生成叙事风格，字段覆盖 pov/tense/proseStyle/pacing。',
  guided_characters: '生成 3-5 个核心角色，至少包含主角、配角/同行者、对手/反派；角色必须有具体动机、内在矛盾和可识别行为。',
  guided_outline: '根据基础设定、风格和核心角色生成完整故事总纲，包含起承转合、主要冲突线索和情感弧线。',
  guided_volume: '根据总纲和角色设定拆分卷纲；如用户提示指定卷数，volumes 数组长度必须严格匹配；narrativePlan 必须包含 storyUnits 单元故事。',
  guided_chapter: '为指定卷生成章节细纲和本卷配角；每章必须有具体目标、核心冲突、所属 storyUnit、3-5 个连续场景段、跨章交接、滚动连续状态和完整 craftBrief。若传入 chapterNo，则只细化该单章。',
  guided_foreshadow: '根据卷纲和章节细纲设计伏笔体系，覆盖主线伏笔、卷级伏笔和章节伏笔，并写清埋设、揭开与 payoff。',
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
      stepKey: { type: 'string' as const, enum: GUIDED_STEP_KEYS },
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
  executionTimeoutMs = GUIDED_STEP_PREVIEW_PHASE_TIMEOUT_MS + 60_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成创作引导步骤预览',
    description: '为创作引导页当前步骤生成结构化预览，覆盖基础设定、风格、角色、大纲、卷纲、章节细纲和伏笔设计；只读且不持久化。',
    whenToUse: ['用户在创作引导页要求 AI 生成当前步骤草案', 'context.session.guided.currentStep 是任一 guided_* 步骤', '需要先生成可审阅 Artifact，再由后续工具校验和写入'],
    whenNotToUse: ['用户只是提问当前步骤填写建议，应使用 guided_step_consultation', '用户要求直接保存结构化数据，必须先校验并审批后再持久化', '用户要求导入长文档并拆解项目资产，应使用 creative_document_import 链路'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      stepKey: { source: 'context', description: '来自 context.session.guided.currentStep；支持 guided_setup/guided_style/guided_characters/guided_outline/guided_volume/guided_chapter/guided_foreshadow。' },
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

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly prisma?: PrismaService,
  ) {}

  async run(args: GenerateGuidedStepPreviewInput, context: ToolContext): Promise<GuidedStepPreviewOutput> {
    const stepKey = args.stepKey?.trim();
    if (!stepKey) throw new BadRequestException('缺少 stepKey，无法生成创作引导步骤预览。');

    const schema = this.getSchema(stepKey, args);
    if (!schema) throw new NotFoundException(`未知创作引导步骤：${stepKey}`);

    const stepInstruction = SUPPORTED_STEP_INSTRUCTIONS[stepKey as GuidedStepSchemaKey];
    const inputWarnings = this.buildInputWarnings(stepKey as GuidedStepSchemaKey, args);
    await context.updateProgress?.({ phase: 'preparing_context', phaseMessage: '正在整理创作引导上下文', timeoutMs: 60_000 });
    const projectContext = await this.buildProjectContext(stepKey as GuidedStepSchemaKey, args, context);

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成创作引导步骤预览',
      timeoutMs: GUIDED_STEP_PREVIEW_PHASE_TIMEOUT_MS,
    });
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
            stepKey === 'guided_chapter'
              ? '章节连续性硬要求：章节不是场景边界，而是阅读节奏边界；每 3-5 章必须组成完整 storyUnit 单元故事；每章 craftBrief.storyUnit 必须写清 unitId、chapterRange、chapterRole、至少 3 项 serviceFunctions，以及主线/人物/关系/世界主题贡献。sceneBeats 至少 3 个场景段，跨章节场景用同一 sceneArcId 串联；每章必须包含 entryState、exitState、openLoops、closedLoops、handoffToNextChapter 和 continuityState。禁止只写推进/建立/完成等抽象目标。'
              : '',
            inputWarnings.length ? `已知上下文缺口：\n${inputWarnings.map((warning) => `- ${warning}`).join('\n')}` : '',
            `用户提示：${args.userHint ?? ''}`,
            `聊天摘要：${args.chatSummary ?? ''}`,
            `卷号：${args.volumeNo ?? ''}`,
            `章节号：${args.chapterNo ?? ''}`,
            `项目上下文：\n${JSON.stringify(projectContext, null, 2).slice(0, 20000)}`,
          ].join('\n'),
        },
      ],
      { appStep: 'planner', maxTokens: 8000, timeoutMs: GUIDED_STEP_PREVIEW_LLM_TIMEOUT_MS, retries: GUIDED_STEP_PREVIEW_LLM_RETRIES },
    );

    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验创作引导步骤预览', progressCurrent: 1, progressTotal: 1 });
    const normalized = this.normalizeStructuredData(data);
    return {
      stepKey,
      structuredData: normalized.structuredData,
      summary: this.buildSummary(stepKey, normalized.structuredData),
      warnings: [...inputWarnings, ...normalized.warnings],
    };
  }

  private getSchema(stepKey: string, args: GenerateGuidedStepPreviewInput): string | undefined {
    if (stepKey === 'guided_chapter' && args.volumeNo !== undefined && args.chapterNo !== undefined) {
      return GUIDED_SINGLE_CHAPTER_REFINEMENT_SCHEMA;
    }
    return getGuidedStepJsonSchema(stepKey);
  }

  private async buildProjectContext(stepKey: GuidedStepSchemaKey, args: GenerateGuidedStepPreviewInput, context: ToolContext): Promise<Record<string, unknown>> {
    const base = args.projectContext ?? {};
    if (stepKey !== 'guided_chapter' || !this.prisma) return base;

    const phase4Guidance = await this.loadGuidedChapterAssets(context.projectId, args.volumeNo, args.chapterNo);
    if (!phase4Guidance) return base;

    return {
      ...base,
      phase4Guidance,
    };
  }

  private async loadGuidedChapterAssets(projectId: string, volumeNo?: number, chapterNo?: number): Promise<Record<string, unknown> | undefined> {
    const [volume, chapter] = await Promise.all([
      volumeNo !== undefined
        ? this.prisma!.volume.findFirst({ where: { projectId, volumeNo }, select: { id: true, volumeNo: true, title: true, objective: true } })
        : Promise.resolve(null),
      chapterNo !== undefined
        ? this.prisma!.chapter.findFirst({ where: { projectId, chapterNo }, select: { id: true, volumeId: true, chapterNo: true, title: true, objective: true } })
        : Promise.resolve(null),
    ]);
    const volumeId = volume?.id ?? chapter?.volumeId ?? undefined;
    const chapterId = chapter?.id ?? undefined;

    const [patterns, rawPacingTargets, rawSceneCards] = await Promise.all([
      this.prisma!.chapterPattern.findMany({
        where: { projectId, status: 'active' },
        orderBy: [{ patternType: 'asc' }, { updatedAt: 'desc' }],
        take: 6,
      }),
      this.prisma!.pacingBeat.findMany({
        where: this.buildPacingTargetWhere(projectId, volumeId, chapterId, chapterNo),
        orderBy: [{ updatedAt: 'desc' }],
        take: 30,
      }),
      chapterId
        ? this.prisma!.sceneCard.findMany({
            where: { projectId, chapterId, NOT: { status: 'archived' } },
            orderBy: [{ sceneNo: 'asc' }, { updatedAt: 'asc' }],
            take: 12,
          })
        : Promise.resolve([]),
    ]);
    const pacingTargets = rawPacingTargets
      .sort((a, b) => this.rankPacingTarget(a, volumeId, chapterId, chapterNo) - this.rankPacingTarget(b, volumeId, chapterId, chapterNo))
      .slice(0, 10);
    const sceneCards = rawSceneCards
      .sort((a, b) => this.rankSceneCard(a, b))
      .slice(0, 8);

    if (!patterns.length && !pacingTargets.length && !sceneCards.length) return undefined;

    return {
      note: 'ChapterPattern、PacingBeat 与 SceneCard 是只读计划资产，用来增强 guided_chapter 的 craftBrief，不代表已发生正文事实。',
      target: {
        volumeNo: volume?.volumeNo ?? volumeNo,
        volumeTitle: volume?.title,
        chapterNo: chapter?.chapterNo ?? chapterNo,
        chapterTitle: chapter?.title,
      },
      chapterPatterns: patterns.map((pattern) => ({
        id: pattern.id,
        patternType: pattern.patternType,
        name: pattern.name,
        applicableScenes: this.stringArray(pattern.applicableScenes),
        structure: pattern.structure,
        pacingAdvice: pattern.pacingAdvice,
        emotionalAdvice: pattern.emotionalAdvice,
        conflictAdvice: pattern.conflictAdvice,
        sourceTrace: { sourceType: 'chapter_pattern', sourceId: pattern.id, projectId },
      })),
      pacingTargets: pacingTargets.map((beat) => ({
        id: beat.id,
        volumeId: beat.volumeId,
        chapterId: beat.chapterId,
        chapterNo: beat.chapterNo,
        beatType: beat.beatType,
        emotionalTone: beat.emotionalTone,
        emotionalIntensity: beat.emotionalIntensity,
        tensionLevel: beat.tensionLevel,
        payoffLevel: beat.payoffLevel,
        notes: beat.notes,
        sourceTrace: { sourceType: 'pacing_beat', sourceId: beat.id, projectId, chapterNo: beat.chapterNo ?? undefined },
      })),
      sceneCards: sceneCards.map((scene) => ({
        id: scene.id,
        volumeId: scene.volumeId,
        chapterId: scene.chapterId,
        sceneNo: scene.sceneNo,
        title: scene.title,
        locationName: scene.locationName,
        participants: this.stringArray(scene.participants),
        purpose: scene.purpose,
        conflict: scene.conflict,
        emotionalTone: scene.emotionalTone,
        keyInformation: scene.keyInformation,
        result: scene.result,
        relatedForeshadowIds: this.stringArray(scene.relatedForeshadowIds),
        status: scene.status,
        metadata: this.asRecord(scene.metadata),
        sourceTrace: { sourceType: 'scene_card', sourceId: scene.id, projectId, chapterNo: chapter?.chapterNo ?? chapterNo, sceneNo: scene.sceneNo },
      })),
    };
  }

  private buildPacingTargetWhere(projectId: string, volumeId?: string, chapterId?: string, chapterNo?: number): Prisma.PacingBeatWhereInput {
    return {
      projectId,
      OR: [
        ...(chapterId ? [{ chapterId }] : []),
        ...(chapterNo !== undefined ? [{ chapterNo }] : []),
        ...(volumeId ? [{ volumeId, chapterId: null, chapterNo: null }] : []),
        { volumeId: null, chapterId: null, chapterNo: null },
      ],
    };
  }

  private rankPacingTarget(
    beat: { volumeId: string | null; chapterId: string | null; chapterNo: number | null; updatedAt?: Date },
    volumeId?: string,
    chapterId?: string,
    chapterNo?: number,
  ): number {
    if (chapterId && beat.chapterId === chapterId) return 0;
    if (chapterNo !== undefined && beat.chapterNo === chapterNo) return 1;
    if (volumeId && beat.volumeId === volumeId && beat.chapterId === null && beat.chapterNo === null) return 2;
    if (beat.volumeId === null && beat.chapterId === null && beat.chapterNo === null) return 3;
    return 4;
  }

  private rankSceneCard(
    left: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
    right: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
  ): number {
    if (left.sceneNo !== null && right.sceneNo !== null && left.sceneNo !== right.sceneNo) {
      return left.sceneNo - right.sceneNo;
    }
    if (left.sceneNo === null && right.sceneNo !== null) return 1;
    if (left.sceneNo !== null && right.sceneNo === null) return -1;
    const updatedDelta = (left.updatedAt?.getTime() ?? 0) - (right.updatedAt?.getTime() ?? 0);
    if (updatedDelta !== 0) return updatedDelta;
    const titleDelta = left.title.localeCompare(right.title);
    return titleDelta !== 0 ? titleDelta : left.id.localeCompare(right.id);
  }

  private buildInputWarnings(stepKey: GuidedStepSchemaKey, args: GenerateGuidedStepPreviewInput): string[] {
    const warnings: string[] = [];
    const projectContext = args.projectContext ?? {};
    const hasProjectContext = Object.keys(projectContext).length > 0;
    const hasPriorContext = hasProjectContext || Boolean(args.chatSummary?.trim());

    if (stepKey !== 'guided_setup' && !hasPriorContext) {
      warnings.push('缺少前置步骤上下文，预览会更多依赖模型补全，写入前需要人工复核。');
    }
    if (stepKey === 'guided_volume' && !args.userHint?.match(/\d+\s*卷/)) {
      warnings.push('未检测到明确卷数要求，模型会自行判断 volumes 数量。');
    }
    if (stepKey === 'guided_chapter' && args.volumeNo === undefined) {
      warnings.push('未指定 volumeNo，模型会生成通用章节细纲，可能无法绑定到具体卷。');
    }
    if (stepKey === 'guided_chapter' && args.chapterNo !== undefined && args.volumeNo === undefined) {
      warnings.push('已指定 chapterNo 但缺少 volumeNo，无法进入单章细化模式。');
    }
    if (stepKey === 'guided_foreshadow' && !hasProjectContext) {
      warnings.push('缺少卷纲或章节细纲上下文，伏笔数量和埋设位置可能需要后续校正。');
    }

    return warnings;
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

    if (stepKey === 'guided_characters') {
      const characters = this.array(data.characters).map((item) => this.text((item as Record<string, unknown>)?.name)).filter(Boolean);
      return characters.length ? `已生成 ${characters.length} 个核心角色：${characters.slice(0, 4).join('、')}` : '已生成核心角色预览。';
    }

    if (stepKey === 'guided_outline') {
      const outline = this.text(data.outline);
      return outline ? `已生成故事总纲：${outline.slice(0, 80)}${outline.length > 80 ? '…' : ''}` : '已生成故事总纲预览。';
    }

    if (stepKey === 'guided_volume') {
      const volumes = this.array(data.volumes).map((item) => this.text((item as Record<string, unknown>)?.title)).filter(Boolean);
      return volumes.length ? `已生成 ${volumes.length} 卷卷纲：${volumes.slice(0, 5).join('、')}` : '已生成卷纲预览。';
    }

    if (stepKey === 'guided_chapter') {
      const chapters = this.array(data.chapters);
      const supportingCharacters = this.array(data.supportingCharacters);
      const firstTitle = this.text((chapters[0] as Record<string, unknown> | undefined)?.title);
      return chapters.length ? `已生成 ${chapters.length} 章细纲${firstTitle ? `，首章：${firstTitle}` : ''}${supportingCharacters.length ? `；本卷配角 ${supportingCharacters.length} 个` : ''}` : '已生成章节细纲预览。';
    }

    if (stepKey === 'guided_foreshadow') {
      const tracks = this.array(data.foreshadowTracks).map((item) => this.text((item as Record<string, unknown>)?.title)).filter(Boolean);
      return tracks.length ? `已生成 ${tracks.length} 条伏笔：${tracks.slice(0, 5).join('、')}` : '已生成伏笔设计预览。';
    }

    return '已生成创作引导步骤预览。';
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
