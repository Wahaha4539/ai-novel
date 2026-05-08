import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const OUTLINE_PREVIEW_BATCH_SIZE = 1;
const OUTLINE_PREVIEW_BATCH_THRESHOLD = OUTLINE_PREVIEW_BATCH_SIZE;

interface GenerateOutlinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterCount?: number;
}

interface OutlinePreviewBatch {
  batchIndex: number;
  batchCount: number;
  startChapterNo: number;
  endChapterNo: number;
  chapterCount: number;
}

export interface ChapterCraftBrief {
  visibleGoal?: string;
  hiddenEmotion?: string;
  coreConflict?: string;
  mainlineTask?: string;
  subplotTasks?: string[];
  storyUnit?: ChapterStoryUnit;
  actionBeats?: string[];
  sceneBeats?: ChapterSceneBeat[];
  concreteClues?: Array<{
    name: string;
    sensoryDetail?: string;
    laterUse?: string;
  }>;
  dialogueSubtext?: string;
  characterShift?: string;
  irreversibleConsequence?: string;
  progressTypes?: string[];
  entryState?: string;
  exitState?: string;
  openLoops?: string[];
  closedLoops?: string[];
  handoffToNextChapter?: string;
  continuityState?: ChapterContinuityState;
}

export interface ChapterStoryUnit {
  unitId?: string;
  title?: string;
  chapterRange?: { start: number; end: number };
  chapterRole?: string;
  localGoal?: string;
  localConflict?: string;
  serviceFunctions?: string[];
  mainlineContribution?: string;
  characterContribution?: string;
  relationshipContribution?: string;
  worldOrThemeContribution?: string;
  unitPayoff?: string;
  stateChangeAfterUnit?: string;
}

export interface ChapterSceneBeat {
  sceneArcId: string;
  scenePart: string;
  continuesFromChapterNo?: number | null;
  continuesToChapterNo?: number | null;
  location: string;
  participants: string[];
  localGoal: string;
  visibleAction: string;
  obstacle: string;
  turningPoint: string;
  partResult: string;
  sensoryAnchor: string;
}

export interface ChapterContinuityState {
  characterPositions?: string[];
  activeThreats?: string[];
  ownedClues?: string[];
  relationshipChanges?: string[];
  nextImmediatePressure?: string;
}

export interface OutlinePreviewOutput {
  volume: { volumeNo: number; title: string; synopsis: string; objective: string; chapterCount: number; narrativePlan?: Record<string, unknown> };
  chapters: Array<{ chapterNo: number; volumeNo?: number; title: string; objective: string; conflict: string; hook: string; outline: string; expectedWordCount: number; craftBrief?: ChapterCraftBrief }>;
  risks: string[];
}

/**
 * 大纲预览生成工具：请求 LLM 输出结构化 JSON。
 * LLM 超时、失败或返回不完整结构时直接抛错，避免用模板骨架拉低细纲质量。
 */
@Injectable()
export class GenerateOutlinePreviewTool implements BaseTool<GenerateOutlinePreviewInput, OutlinePreviewOutput> {
  private readonly logger = new StructuredLogger(GenerateOutlinePreviewTool.name);
  name = 'generate_outline_preview';
  description = '根据项目上下文和用户目标生成卷/章节细纲与执行卡预览，不写入正式业务表。';
  inputSchema = { type: 'object' as const, properties: { context: { type: 'object' as const }, instruction: { type: 'string' as const }, volumeNo: { type: 'number' as const }, chapterCount: { type: 'number' as const } } };
  outputSchema = { type: 'object' as const, required: ['volume', 'chapters', 'risks'], properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const, items: { type: 'string' as const } } } };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = OUTLINE_PREVIEW_LLM_TIMEOUT_MS * Math.ceil(80 / OUTLINE_PREVIEW_BATCH_SIZE) + 60_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成卷/章节细纲与执行卡预览',
    description: '生成 outline_preview：包含卷信息、章节细纲、单元故事 storyUnit、每章 Chapter.craftBrief 执行卡和风险；章节细纲每章单独调用一次 LLM，并按上一章接力卡保持连贯性。',
    whenToUse: [
      '用户要求生成卷细纲、章节细纲、章节规划、等长细纲或 60 章细纲',
      '用户要求把某一卷拆成多章，但还不是写正文',
      '用户需要审批前预览 planned 章节和 Chapter.craftBrief 执行卡',
    ],
    whenNotToUse: [
      '用户要求写正文、生成正文、续写正文时使用 write_chapter 或 write_chapter_series',
      '用户要求把章节拆成场景、场景卡或 SceneCard 时使用 generate_scene_cards_preview',
      '用户只要求校验或写入已有 outline_preview 时使用 validate_outline 或 persist_outline',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '通常来自 inspect_project_context.output，包含项目、目标卷、已有章节、角色和设定摘要。' },
      instruction: { source: 'user_message', description: '保留用户对卷号、章节数、节奏、风格和结构的要求。' },
      volumeNo: { source: 'user_message', description: '用户指定“第 N 卷”时填入；未指定时默认第 1 卷。' },
      chapterCount: { source: 'user_message', description: '用户指定“60 章”等目标数量时填入；章节细纲每章单独调用一次 LLM，任一章 timeout 会直接失败。' },
    },
    examples: [
      {
        user: '为第 1 卷生成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'chapters', 'characters', 'lorebook'] } },
          { tool: 'generate_outline_preview', args: { context: '{{steps.1.output}}', instruction: '为第 1 卷生成 60 章细纲', volumeNo: 1, chapterCount: 60 } },
          { tool: 'validate_outline', args: { preview: '{{steps.2.output}}' } },
          { tool: 'persist_outline', args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
        ],
      },
    ],
    failureHints: [
      { code: 'LLM_TIMEOUT', meaning: '单章 LLM 未在内部 timeoutMs 内稳定返回', suggestedRepair: '重新执行或缩小章节范围；工具不会生成 fallback 章节。' },
      { code: 'INCOMPLETE_OUTLINE_PREVIEW', meaning: 'LLM 返回章节数、编号或 craftBrief 不完整', suggestedRepair: '重新生成完整细纲，或先补足提示上下文后再运行。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateOutlinePreviewInput, context: ToolContext): Promise<OutlinePreviewOutput> {
    const volumeNo = args.volumeNo ?? 1;
    const chapterCount = Math.min(80, Math.max(1, args.chapterCount ?? 10));
    const batches = this.createBatches(chapterCount);
    if (batches.length > 1) return this.runBatched(args, context, volumeNo, chapterCount, batches);
    return this.runSingleBatch(args, context, volumeNo, chapterCount);
  }

  private async runSingleBatch(args: GenerateOutlinePreviewInput, context: ToolContext, volumeNo: number, chapterCount: number): Promise<OutlinePreviewOutput> {
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成卷章节预览',
      timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
    });
    const response = await this.callOutlineLlm(args, context, volumeNo, chapterCount);
    recordToolLlmUsage(context, 'planner', response.result);
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
    return this.normalize(response.data, volumeNo, chapterCount);
  }

  private async runBatched(
    args: GenerateOutlinePreviewInput,
    context: ToolContext,
    volumeNo: number,
    chapterCount: number,
    batches: OutlinePreviewBatch[],
  ): Promise<OutlinePreviewOutput> {
    const chapters: OutlinePreviewOutput['chapters'] = [];
    const risks: string[] = [`已按每章一次 LLM 请求生成，共 ${batches.length} 次，避免单次 LLM 请求承载 ${chapterCount} 章。`];
    let volume: OutlinePreviewOutput['volume'] | undefined;
    for (const batch of batches) {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: `正在生成第 ${batch.startChapterNo}-${batch.endChapterNo} 章细纲`,
        progressCurrent: batch.batchIndex,
        progressTotal: batch.batchCount,
        timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      });
      const response = await this.callOutlineLlm(args, context, volumeNo, chapterCount, batch, chapters);
      recordToolLlmUsage(context, 'planner', response.result);
      const normalized = this.normalize(response.data, volumeNo, batch.chapterCount, {
        chapterStart: batch.startChapterNo,
        totalChapterCount: chapterCount,
      });
      volume ??= normalized.volume;
      chapters.push(...normalized.chapters);
      risks.push(...normalized.risks.map((risk) => this.prefixBatchRisk(batch, risk)));
      await context.heartbeat?.({
        phase: 'merging_preview',
        phaseMessage: `已合并 ${chapters.length}/${chapterCount} 章细纲`,
        progressCurrent: batch.batchIndex,
        progressTotal: batch.batchCount,
      });
    }
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验逐章合并后的章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
    return this.finalizeBatchedPreview(volume, chapters, risks, volumeNo, chapterCount);
  }

  private prefixBatchRisk(batch: OutlinePreviewBatch, risk: string): string {
    const rangeLabel = `第 ${batch.startChapterNo}-${batch.endChapterNo} 章`;
    return risk.includes(rangeLabel) ? risk : `${rangeLabel}请求：${risk}`;
  }

  private async callOutlineLlm(
    args: GenerateOutlinePreviewInput,
    context: ToolContext,
    volumeNo: number,
    chapterCount: number,
    batch?: OutlinePreviewBatch,
    previousChapters: OutlinePreviewOutput['chapters'] = [],
  ) {
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterCount, batch, previousChapters) },
    ];
    const maxTokens = this.estimateMaxTokens(batch?.chapterCount ?? chapterCount);
    const logContext = this.buildLlmRequestLogContext(context, messages, volumeNo, chapterCount, batch, previousChapters, maxTokens);
    const startedAt = Date.now();
    this.logger.log('outline_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<OutlinePreviewOutput>(
        messages,
        { appStep: 'planner', maxTokens, timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true },
      );
      this.logger.log('outline_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
      });
      return response;
    } catch (error) {
      this.logger.error('outline_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private buildLlmRequestLogContext(
    context: ToolContext,
    messages: Array<{ role: string; content: string }>,
    volumeNo: number,
    chapterCount: number,
    batch: OutlinePreviewBatch | undefined,
    previousChapters: OutlinePreviewOutput['chapters'],
    maxTokens: number,
  ): Record<string, unknown> {
    const previousChapter = previousChapters.at(-1);
    return {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      volumeNo,
      totalChapterCount: chapterCount,
      requestChapterStart: batch?.startChapterNo ?? 1,
      requestChapterEnd: batch?.endChapterNo ?? chapterCount,
      requestChapterCount: batch?.chapterCount ?? chapterCount,
      requestIndex: batch?.batchIndex ?? 1,
      requestCount: batch?.batchCount ?? 1,
      previousChapterNo: previousChapter?.chapterNo ?? null,
      previousChaptersCount: previousChapters.length,
      timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      maxTokens,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
  }

  private normalize(
    data: OutlinePreviewOutput,
    volumeNo: number,
    chapterCount: number,
    options: { chapterStart?: number; totalChapterCount?: number } = {},
  ): OutlinePreviewOutput {
    const output = this.asRecord(data);
    const chapterStart = options.chapterStart ?? 1;
    const totalChapterCount = options.totalChapterCount ?? chapterCount;
    const rawChapters = Array.isArray(output.chapters) ? output.chapters : undefined;
    if (!rawChapters) {
      throw new Error('generate_outline_preview 返回缺少 chapters 数组，未生成完整细纲。');
    }
    if (rawChapters.length !== chapterCount) {
      throw new Error(`generate_outline_preview 返回章节数 ${rawChapters.length}/${chapterCount}，未生成完整细纲。`);
    }
    const chapters: OutlinePreviewOutput['chapters'] = rawChapters.map((item, index) => {
      const record = this.asRecord(item);
      const chapterNo = chapterStart + index;
      const returnedChapterNo = Number(record.chapterNo);
      if (!Number.isFinite(returnedChapterNo) || returnedChapterNo !== chapterNo) {
        throw new Error(`generate_outline_preview 第 ${chapterNo} 章 chapterNo 不匹配，未生成完整细纲。`);
      }
      const returnedVolumeNo = Number(record.volumeNo);
      if (!Number.isFinite(returnedVolumeNo) || returnedVolumeNo !== volumeNo) {
        throw new Error(`generate_outline_preview 第 ${chapterNo} 章 volumeNo 不匹配，未生成完整细纲。`);
      }
      const expectedWordCount = Number(record.expectedWordCount);
      if (!Number.isFinite(expectedWordCount) || expectedWordCount <= 0) {
        throw new Error(`generate_outline_preview 第 ${chapterNo} 章 expectedWordCount 无效，未生成完整细纲。`);
      }
      const chapter = {
        chapterNo,
        volumeNo,
        title: this.requiredText(record.title, `第 ${chapterNo} 章 title`),
        objective: this.requiredText(record.objective, `第 ${chapterNo} 章 objective`),
        conflict: this.requiredText(record.conflict, `第 ${chapterNo} 章 conflict`),
        hook: this.requiredText(record.hook, `第 ${chapterNo} 章 hook`),
        outline: this.requiredText(record.outline, `第 ${chapterNo} 章 outline`),
        expectedWordCount,
      };
      return { ...chapter, craftBrief: this.normalizeCraftBrief(record.craftBrief, `第 ${chapterNo} 章`) };
    });
    const volumeRecord = this.asRecord(output.volume);
    const returnedVolumeNo = Number(volumeRecord.volumeNo);
    if (!Number.isFinite(returnedVolumeNo) || returnedVolumeNo !== volumeNo) {
      throw new Error(`generate_outline_preview volume.volumeNo 与目标卷 ${volumeNo} 不匹配，未生成完整细纲。`);
    }
    const returnedVolumeChapterCount = Number(volumeRecord.chapterCount);
    if (!Number.isFinite(returnedVolumeChapterCount) || returnedVolumeChapterCount !== totalChapterCount) {
      throw new Error(`generate_outline_preview volume.chapterCount 与目标章节数 ${totalChapterCount} 不匹配，未生成完整细纲。`);
    }
    const risks = this.stringArray(output.risks, []);
    const narrativePlan = this.asRecord(volumeRecord.narrativePlan);
    return {
      volume: {
        volumeNo,
        title: this.requiredText(volumeRecord.title, 'volume.title'),
        synopsis: this.requiredText(volumeRecord.synopsis, 'volume.synopsis'),
        objective: this.requiredText(volumeRecord.objective, 'volume.objective'),
        chapterCount: totalChapterCount,
        ...(Object.keys(narrativePlan).length ? { narrativePlan } : {}),
      },
      chapters,
      risks,
    };
  }

  private finalizeBatchedPreview(
    volume: OutlinePreviewOutput['volume'] | undefined,
    chapters: OutlinePreviewOutput['chapters'],
    risks: string[],
    volumeNo: number,
    chapterCount: number,
  ): OutlinePreviewOutput {
    if (!volume) throw new Error('generate_outline_preview 未返回卷信息，未生成完整细纲。');
    this.assertMergedChapters(chapters, volumeNo, chapterCount);
    return {
      volume: {
        volumeNo,
        title: volume.title,
        synopsis: volume.synopsis,
        objective: volume.objective,
        chapterCount,
        ...(volume?.narrativePlan ? { narrativePlan: volume.narrativePlan } : {}),
      },
      chapters,
      risks,
    };
  }

  private assertMergedChapters(chapters: OutlinePreviewOutput['chapters'], volumeNo: number, chapterCount: number): void {
    if (chapters.length !== chapterCount) {
      throw new Error(`generate_outline_preview 逐章合并章节数为 ${chapters.length}/${chapterCount}，未生成完整细纲。`);
    }
    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo)).filter((chapterNo) => Number.isFinite(chapterNo));
    if (new Set(chapterNos).size !== chapterNos.length) {
      throw new Error('generate_outline_preview 逐章合并发现重复章节编号，未生成完整细纲。');
    }
    if (chapterNos.length !== chapterCount || chapterNos.some((chapterNo, index) => chapterNo !== index + 1)) {
      throw new Error('generate_outline_preview 逐章合并发现章节编号不连续，未生成完整细纲。');
    }
    if (chapters.some((chapter) => Number(chapter.volumeNo) !== volumeNo)) {
      throw new Error(`generate_outline_preview 逐章合并发现 volumeNo 与目标卷 ${volumeNo} 不一致，未生成完整细纲。`);
    }
    if (chapters.some((chapter) => !chapter.craftBrief || !chapter.craftBrief.visibleGoal || !chapter.craftBrief.coreConflict || !chapter.craftBrief.storyUnit?.unitId)) {
      throw new Error('generate_outline_preview 逐章合并发现部分章节 craftBrief 不完整，未生成完整细纲。');
    }
  }

  /** 将 LLM 可能返回的非字符串字段收敛为字符串，避免后续 Tool 对 trim 等字符串方法崩溃。 */
  private text(value: unknown, defaultValue: string): string {
    if (typeof value === 'string') return value.trim() || defaultValue;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return defaultValue;
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.text(value, '');
    if (!text.trim()) {
      throw new Error(`generate_outline_preview 返回缺少 ${label}，未生成完整细纲。`);
    }
    return text;
  }

  private normalizeCraftBrief(value: unknown, label: string): ChapterCraftBrief {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) {
      throw new Error(`generate_outline_preview ${label} 缺少 craftBrief，未生成完整细纲。`);
    }
    const clues = this.asRecordArray(record.concreteClues)
      .map((item, clueIndex) => ({
        name: this.requiredText(item.name, `${label}.craftBrief.concreteClues[${clueIndex}].name`),
        sensoryDetail: this.requiredText(item.sensoryDetail, `${label}.craftBrief.concreteClues[${clueIndex}].sensoryDetail`),
        laterUse: this.requiredText(item.laterUse, `${label}.craftBrief.concreteClues[${clueIndex}].laterUse`),
      }))
      .filter((item) => item.name.trim());
    if (!clues.length) {
      throw new Error(`generate_outline_preview ${label} craftBrief.concreteClues 为空，未生成完整细纲。`);
    }
    const subplotTasks = this.requiredStringArray(record.subplotTasks, `${label}.craftBrief.subplotTasks`);
    const actionBeats = this.requiredStringArray(record.actionBeats, `${label}.craftBrief.actionBeats`);
    if (actionBeats.length < 3) {
      throw new Error(`generate_outline_preview ${label} craftBrief.actionBeats 少于 3 个节点，未生成完整细纲。`);
    }
    const progressTypes = this.requiredStringArray(record.progressTypes, `${label}.craftBrief.progressTypes`);
    const sceneBeats = this.normalizeSceneBeats(record.sceneBeats, label);
    const continuityState = this.normalizeContinuityState(record.continuityState, label);
    const storyUnit = this.normalizeStoryUnit(record.storyUnit, label);
    return {
      visibleGoal: this.requiredText(record.visibleGoal, `${label}.craftBrief.visibleGoal`),
      hiddenEmotion: this.requiredText(record.hiddenEmotion, `${label}.craftBrief.hiddenEmotion`),
      coreConflict: this.requiredText(record.coreConflict, `${label}.craftBrief.coreConflict`),
      mainlineTask: this.requiredText(record.mainlineTask, `${label}.craftBrief.mainlineTask`),
      subplotTasks,
      storyUnit,
      actionBeats,
      sceneBeats,
      concreteClues: clues,
      dialogueSubtext: this.requiredText(record.dialogueSubtext, `${label}.craftBrief.dialogueSubtext`),
      characterShift: this.requiredText(record.characterShift, `${label}.craftBrief.characterShift`),
      irreversibleConsequence: this.requiredText(record.irreversibleConsequence, `${label}.craftBrief.irreversibleConsequence`),
      progressTypes,
      entryState: this.requiredText(record.entryState, `${label}.craftBrief.entryState`),
      exitState: this.requiredText(record.exitState, `${label}.craftBrief.exitState`),
      openLoops: this.requiredStringArray(record.openLoops, `${label}.craftBrief.openLoops`),
      closedLoops: this.requiredStringArray(record.closedLoops, `${label}.craftBrief.closedLoops`),
      handoffToNextChapter: this.requiredText(record.handoffToNextChapter, `${label}.craftBrief.handoffToNextChapter`),
      continuityState,
    };
  }

  private normalizeStoryUnit(value: unknown, label: string): ChapterStoryUnit {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) {
      throw new Error(`generate_outline_preview ${label} 缺少 craftBrief.storyUnit，未生成完整细纲。`);
    }
    const rangeRecord = this.asRecord(record.chapterRange);
    const chapterRange = {
      start: this.requiredPositiveInt(rangeRecord.start, `${label}.craftBrief.storyUnit.chapterRange.start`),
      end: this.requiredPositiveInt(rangeRecord.end, `${label}.craftBrief.storyUnit.chapterRange.end`),
    };
    if (chapterRange.end < chapterRange.start) {
      throw new Error(`generate_outline_preview ${label} craftBrief.storyUnit.chapterRange 无效，未生成完整细纲。`);
    }
    const serviceFunctions = this.requiredStringArray(record.serviceFunctions, `${label}.craftBrief.storyUnit.serviceFunctions`);
    if (serviceFunctions.length < 3) {
      throw new Error(`generate_outline_preview ${label} craftBrief.storyUnit.serviceFunctions 少于 3 项，未生成完整细纲。`);
    }
    return {
      unitId: this.requiredText(record.unitId, `${label}.craftBrief.storyUnit.unitId`),
      title: this.requiredText(record.title, `${label}.craftBrief.storyUnit.title`),
      chapterRange,
      chapterRole: this.requiredText(record.chapterRole, `${label}.craftBrief.storyUnit.chapterRole`),
      localGoal: this.requiredText(record.localGoal, `${label}.craftBrief.storyUnit.localGoal`),
      localConflict: this.requiredText(record.localConflict, `${label}.craftBrief.storyUnit.localConflict`),
      serviceFunctions,
      mainlineContribution: this.requiredText(record.mainlineContribution, `${label}.craftBrief.storyUnit.mainlineContribution`),
      characterContribution: this.requiredText(record.characterContribution, `${label}.craftBrief.storyUnit.characterContribution`),
      relationshipContribution: this.requiredText(record.relationshipContribution, `${label}.craftBrief.storyUnit.relationshipContribution`),
      worldOrThemeContribution: this.requiredText(record.worldOrThemeContribution, `${label}.craftBrief.storyUnit.worldOrThemeContribution`),
      unitPayoff: this.requiredText(record.unitPayoff, `${label}.craftBrief.storyUnit.unitPayoff`),
      stateChangeAfterUnit: this.requiredText(record.stateChangeAfterUnit, `${label}.craftBrief.storyUnit.stateChangeAfterUnit`),
    };
  }

  private normalizeSceneBeats(value: unknown, label: string): ChapterSceneBeat[] {
    const beats = this.asRecordArray(value).map((item, index) => ({
      sceneArcId: this.requiredText(item.sceneArcId, `${label}.craftBrief.sceneBeats[${index}].sceneArcId`),
      scenePart: this.requiredText(item.scenePart, `${label}.craftBrief.sceneBeats[${index}].scenePart`),
      continuesFromChapterNo: this.optionalChapterNo(item.continuesFromChapterNo),
      continuesToChapterNo: this.optionalChapterNo(item.continuesToChapterNo),
      location: this.requiredText(item.location, `${label}.craftBrief.sceneBeats[${index}].location`),
      participants: this.requiredStringArray(item.participants, `${label}.craftBrief.sceneBeats[${index}].participants`),
      localGoal: this.requiredText(item.localGoal, `${label}.craftBrief.sceneBeats[${index}].localGoal`),
      visibleAction: this.requiredText(item.visibleAction, `${label}.craftBrief.sceneBeats[${index}].visibleAction`),
      obstacle: this.requiredText(item.obstacle, `${label}.craftBrief.sceneBeats[${index}].obstacle`),
      turningPoint: this.requiredText(item.turningPoint, `${label}.craftBrief.sceneBeats[${index}].turningPoint`),
      partResult: this.requiredText(item.partResult, `${label}.craftBrief.sceneBeats[${index}].partResult`),
      sensoryAnchor: this.requiredText(item.sensoryAnchor, `${label}.craftBrief.sceneBeats[${index}].sensoryAnchor`),
    }));
    if (beats.length < 3) {
      throw new Error(`generate_outline_preview ${label} craftBrief.sceneBeats 少于 3 个场景段，未生成完整细纲。`);
    }
    return beats;
  }

  private normalizeContinuityState(value: unknown, label: string): ChapterContinuityState {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) {
      throw new Error(`generate_outline_preview ${label} 缺少 craftBrief.continuityState，未生成完整细纲。`);
    }
    const continuityState = {
      characterPositions: this.stringArray(record.characterPositions, []),
      activeThreats: this.stringArray(record.activeThreats, []),
      ownedClues: this.stringArray(record.ownedClues, []),
      relationshipChanges: this.stringArray(record.relationshipChanges, []),
      nextImmediatePressure: this.requiredText(record.nextImmediatePressure, `${label}.craftBrief.continuityState.nextImmediatePressure`),
    };
    const hasConcreteState = [
      continuityState.characterPositions,
      continuityState.activeThreats,
      continuityState.ownedClues,
      continuityState.relationshipChanges,
    ].some((items) => items.length > 0);
    if (!hasConcreteState) {
      throw new Error(`generate_outline_preview ${label} craftBrief.continuityState 缺少角色位置、威胁、线索或关系变化，未生成完整细纲。`);
    }
    return continuityState;
  }

  private optionalChapterNo(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 1 ? numeric : null;
  }

  private requiredStringArray(value: unknown, label: string): string[] {
    const items = this.stringArray(value, []);
    if (!items.length) {
      throw new Error(`generate_outline_preview 返回缺少 ${label}，未生成完整细纲。`);
    }
    return items;
  }

  private requiredPositiveInt(value: unknown, label: string): number {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) {
      throw new Error(`generate_outline_preview 返回缺少 ${label}，未生成完整细纲。`);
    }
    return numeric;
  }

  private buildSystemPrompt(): string {
    return [
      '你是小说章节细纲设计 Agent。只输出严格 JSON，不要 Markdown、解释或代码块。',
      '本工具生成的是卷/章节细纲与章级执行卡，不是正文，不要写正文段落。',
      '输出字段必须包含 volume、chapters、risks；每章必须包含 chapterNo、volumeNo、title、objective、conflict、hook、outline、expectedWordCount、craftBrief。',
      '章节不是场景边界，而是阅读节奏边界。一个大场景可以跨多个章节，但每章必须完成一个阶段动作，并把压力交接给下一章。',
      '',
      '高密度章节细纲规则：',
      '- 每章至少领取 1 个本卷主线任务，并至少推进 1 条卷内支线。',
      '- objective 必须具体可检验，不能只写“推进主线”“调查线索”。',
      '- conflict 必须写清阻力来源和阻力方式。',
      '- outline 必须写成 3-5 个连续场景段，包含具体地点、出场人物、可被镜头拍到的动作、阻力、阶段结果，不要写泛泛剧情摘要。',
      '- craftBrief 必填，必须包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、storyUnit、actionBeats、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes。',
      '- craftBrief 还必须包含 storyUnit、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState、sceneBeats。',
      '- 每 3-5 章设计一个完整的 storyUnit 单元故事。单元故事有自己的局部目标、冲突、高潮/阶段结局，但必须服务全书主线和人物变化。',
      '- volume.narrativePlan 必须包含 storyUnits 数组；每个 storyUnit 写清 unitId、title、chapterRange、localGoal、localConflict、serviceFunctions、payoff、stateChangeAfterUnit。',
      '- craftBrief.storyUnit 必须标明本章所属单元故事，包含 unitId、title、chapterRange、chapterRole、localGoal、localConflict、serviceFunctions、mainlineContribution、characterContribution、relationshipContribution、worldOrThemeContribution、unitPayoff、stateChangeAfterUnit。',
      '- storyUnit.serviceFunctions 至少 3 项，只能从这些方向中选择或具体化：mainline、protagonist_arc、supporting_character、relationship_shift、worldbuilding、theme、antagonist_pressure、foreshadow、emotional_pacing、resource_cost。',
      '- craftBrief.sceneBeats 至少 3 个场景段；每段包含 sceneArcId、scenePart、location、participants、localGoal、visibleAction、obstacle、turningPoint、partResult、sensoryAnchor。跨章场景用相同 sceneArcId，并填写 continuesFromChapterNo / continuesToChapterNo。',
      '- craftBrief.actionBeats 至少 3 个节点，形成“起手行动 -> 正面受阻 -> 阶段结果”的行动链；每个节点都要有具体人物、动作和对象。',
      '- craftBrief.concreteClues 至少 1 个具象线索或物证，必须写清 name、sensoryDetail 和 laterUse。',
      '- craftBrief.irreversibleConsequence 必须具体，且改变事实、关系、资源、地位、规则或危险等级之一。',
      '- craftBrief.entryState 必须接住上一章的 exitState / handoffToNextChapter；craftBrief.handoffToNextChapter 必须给出下一章可直接接续的动作、地点、压力或未解决问题。',
      '- craftBrief.continuityState 必须包含角色位置、仍在生效的威胁、已持有线索/资源、关系变化和 nextImmediatePressure。',
      '- 每 3-4 章至少出现一次信息揭示、关系反转、资源得失、地位变化或规则升级。',
      '- 卷末章节必须收束本卷主线，并留下下一卷或下一阶段交接。',
      '',
      '反空泛规则：',
      '- 禁止只写“推进、建立、完成、探索、揭示、面对、选择、升级、铺垫、承接、形成雏形”等抽象词。',
      '- 如果使用这些词，必须同时绑定具体地点、人物、动作、物件和后果。',
      '',
      'JSON 输出示例骨架：',
      '{"volume":{"volumeNo":1,"title":"卷名","synopsis":"卷概要","objective":"可检验卷目标","chapterCount":10,"narrativePlan":{"storyUnits":[{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"payoff":"单元阶段结局","stateChangeAfterUnit":"单元结束后的状态变化"}]}},"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章可检验目标","conflict":"阻力来源与方式","hook":"章末交接钩子","outline":"1. 具体场景段...\\n2. 具体场景段...\\n3. 具体场景段...","expectedWordCount":2500,"craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"storyUnit":{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"chapterRole":"开局/升级/反转/收束","localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"本章如何推进主线","characterContribution":"本章如何塑造人物","relationshipContribution":"本章如何改变关系","worldOrThemeContribution":"本章如何展开世界或主题","unitPayoff":"单元最终将如何阶段收束","stateChangeAfterUnit":"单元结束后的状态变化"},"actionBeats":["行动1","行动2","行动3"],"sceneBeats":[{"sceneArcId":"dock_escape","scenePart":"1/3","continuesFromChapterNo":null,"continuesToChapterNo":2,"location":"具体地点","participants":["角色名"],"localGoal":"本场局部目标","visibleAction":"角色做出的可见动作","obstacle":"阻力来源和方式","turningPoint":"反转或新信息","partResult":"本场结束后的变化","sensoryAnchor":"可写入正文的感官锚点"}],"concreteClues":[{"name":"线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"],"entryState":"接住上一章压力","exitState":"本章结束状态","openLoops":["未解决问题"],"closedLoops":["阶段性解决问题"],"handoffToNextChapter":"下一章接续动作和压力","continuityState":{"characterPositions":["角色在何处"],"activeThreats":["仍在生效的威胁"],"ownedClues":["已持有线索"],"relationshipChanges":["关系变化"],"nextImmediatePressure":"下一章最紧迫压力"}}}],"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(
    args: GenerateOutlinePreviewInput,
    volumeNo: number,
    chapterCount: number,
    batch?: OutlinePreviewBatch,
    previousChapters: OutlinePreviewOutput['chapters'] = [],
  ): string {
    const record = this.asRecord(args.context);
    const project = this.asRecord(record.project);
    const volumes = Array.isArray(record.volumes) ? record.volumes.map((item) => this.asRecord(item)) : [];
    const targetVolume = volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
    const isReplanning = this.isReplanningInstruction(args.instruction);
    const rangeStart = batch?.startChapterNo ?? 1;
    const rangeEnd = batch?.endChapterNo ?? chapterCount;
    const requestChapterCount = batch?.chapterCount ?? chapterCount;
    const existingChapters = !isReplanning && Array.isArray(record.existingChapters) ? record.existingChapters.slice(0, 160) : [];
    const characters = Array.isArray(record.characters) ? record.characters.slice(0, 30) : [];
    const lorebookEntries = Array.isArray(record.lorebookEntries) ? record.lorebookEntries.slice(0, 30) : [];
    const lastGeneratedChapter = previousChapters.length ? previousChapters[previousChapters.length - 1] : undefined;
    const batchContinuity = lastGeneratedChapter
      ? {
        previousRequestLastChapterNo: lastGeneratedChapter.chapterNo,
        previousRequestLastTitle: lastGeneratedChapter.title,
        hook: lastGeneratedChapter.hook,
        exitState: lastGeneratedChapter.craftBrief?.exitState,
        handoffToNextChapter: lastGeneratedChapter.craftBrief?.handoffToNextChapter,
        openLoops: lastGeneratedChapter.craftBrief?.openLoops,
        activeThreats: lastGeneratedChapter.craftBrief?.continuityState?.activeThreats,
        ownedClues: lastGeneratedChapter.craftBrief?.continuityState?.ownedClues,
        relationshipChanges: lastGeneratedChapter.craftBrief?.continuityState?.relationshipChanges,
        nextImmediatePressure: lastGeneratedChapter.craftBrief?.continuityState?.nextImmediatePressure,
        activeSceneArcs: lastGeneratedChapter.craftBrief?.sceneBeats
          ?.filter((beat) => beat.continuesToChapterNo !== null && beat.continuesToChapterNo !== undefined)
          .map((beat) => ({
            sceneArcId: beat.sceneArcId,
            scenePart: beat.scenePart,
            continuesToChapterNo: beat.continuesToChapterNo,
            partResult: beat.partResult,
          })),
      }
      : { previousRequestLastChapterNo: null, note: '这是首章请求；从项目与目标卷上下文开篇，不需要承接前序章节请求。' };
    const generatedSummary = previousChapters.slice(-8).reverse().map((chapter) => ({
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      objective: chapter.objective,
      hook: chapter.hook,
      exitState: chapter.craftBrief?.exitState,
      handoffToNextChapter: chapter.craftBrief?.handoffToNextChapter,
      openLoops: chapter.craftBrief?.openLoops?.slice(0, 2),
      consequence: chapter.craftBrief?.irreversibleConsequence,
      storyUnit: chapter.craftBrief?.storyUnit
        ? {
          unitId: chapter.craftBrief.storyUnit.unitId,
          title: chapter.craftBrief.storyUnit.title,
          chapterRole: chapter.craftBrief.storyUnit.chapterRole,
          chapterRange: chapter.craftBrief.storyUnit.chapterRange,
          stateChangeAfterUnit: chapter.craftBrief.storyUnit.stateChangeAfterUnit,
        }
        : undefined,
      nextImmediatePressure: chapter.craftBrief?.continuityState?.nextImmediatePressure,
      activeThreats: chapter.craftBrief?.continuityState?.activeThreats?.slice(0, 2),
      ownedClues: chapter.craftBrief?.continuityState?.ownedClues?.slice(0, 2),
      activeSceneArcs: chapter.craftBrief?.sceneBeats
        ?.filter((beat) => beat.continuesToChapterNo !== null && beat.continuesToChapterNo !== undefined)
        .slice(-2)
        .map((beat) => ({
          sceneArcId: beat.sceneArcId,
          scenePart: beat.scenePart,
          continuesToChapterNo: beat.continuesToChapterNo,
          partResult: beat.partResult,
        })),
    }));
    return [
      `用户目标：${args.instruction ?? '生成章节细纲'}`,
      `目标卷：第 ${volumeNo} 卷`,
      `全卷章节数：${chapterCount}`,
      `本次请求章节数：${requestChapterCount}`,
      `章节范围：第 ${rangeStart}-${rangeEnd} 章`,
      '',
      '项目概览：',
      this.safeJson({
        title: project.title,
        genre: project.genre,
        tone: project.tone,
        synopsis: project.synopsis,
        outline: project.outline,
      }, 3000),
      '',
      ...(isReplanning
        ? [
          '目标卷信息（重规划模式；只保留定位字段，不注入旧卷纲或旧细纲）：',
          this.safeJson({
            volumeNo,
            title: targetVolume.title,
            chapterCount: targetVolume.chapterCount,
          }, 2000),
          '重规划输入净化：已省略原有卷纲、章节 outline 和 craftBrief，避免旧规划污染新细纲；请只依据项目总纲、角色、设定与用户目标重新生成。',
        ]
        : [
          '目标卷纲：',
          this.safeJson({
            volumeNo,
            title: targetVolume.title,
            synopsis: targetVolume.synopsis,
            objective: targetVolume.objective,
            narrativePlan: targetVolume.narrativePlan,
          }, 4000),
          '',
          '已有章节摘要（避免重复编号、标题和目标）：',
          this.safeJson(existingChapters, 6000),
        ]),
      '',
      '本次运行已生成章节短表（最近章节在前，保持连续性，避免重复）：',
      this.safeJson(generatedSummary, 4000),
      '章节接力卡（本章请求必须优先承接）：',
      this.safeJson(batchContinuity, 2500),
      '连续性硬要求：本章必须接住接力卡上一章的 exitState、openLoops、handoffToNextChapter、activeThreats、ownedClues、relationshipChanges 和 nextImmediatePressure；这些压力不能凭空消失，必须进入本章 craftBrief.entryState、continuityState、openLoops，或在 closedLoops 中写清关闭原因。同一个跨章场景必须沿用 sceneArcId，并递增 scenePart。',
      ...(isReplanning ? ['重规划硬要求：不要沿用旧标题、旧目标、旧章节 outline 或旧 craftBrief；输出必须是新的完整高密度卷/章节细纲。'] : []),
      '',
      '角色摘要：',
      this.safeJson(characters, 4000),
      '',
      '设定摘要：',
      this.safeJson(lorebookEntries, 4000),
      '',
      `请严格只返回第 ${rangeStart}-${rangeEnd} 章，共 ${requestChapterCount} 个 chapters；chapterNo 必须使用全卷绝对章号。`,
      '若上下文不足，把风险写入 risks，但仍输出完整章节和 craftBrief。',
    ].join('\n');
  }

  private isReplanningInstruction(instruction: string | undefined): boolean {
    return /重新|重编|重写|重做|重排|再规划|推倒|replan|regenerate|rewrite/i.test(instruction ?? '');
  }

  private estimateMaxTokens(chapterCount: number): number {
    return Math.min(16_000, Math.max(5000, chapterCount * 980 + 2200));
  }

  private createBatches(chapterCount: number): OutlinePreviewBatch[] {
    if (chapterCount <= OUTLINE_PREVIEW_BATCH_THRESHOLD) {
      return [{ batchIndex: 1, batchCount: 1, startChapterNo: 1, endChapterNo: chapterCount, chapterCount }];
    }
    const ranges: Array<Omit<OutlinePreviewBatch, 'batchIndex' | 'batchCount'>> = [];
    for (let startChapterNo = 1; startChapterNo <= chapterCount; startChapterNo += OUTLINE_PREVIEW_BATCH_SIZE) {
      const endChapterNo = Math.min(chapterCount, startChapterNo + OUTLINE_PREVIEW_BATCH_SIZE - 1);
      ranges.push({ startChapterNo, endChapterNo, chapterCount: endChapterNo - startChapterNo + 1 });
    }
    return ranges.map((range, index) => ({ ...range, batchIndex: index + 1, batchCount: ranges.length }));
  }

  private safeJson(value: unknown, limit: number): string {
    const text = JSON.stringify(value ?? {}, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0)
      : [];
  }

  private stringArray(value: unknown, defaultValue: string[]): string[] {
    const items = Array.isArray(value)
      ? value.map((item) => this.text(item, '')).filter(Boolean)
      : [];
    return items.length ? items : defaultValue;
  }

}
