import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { ChapterOutlineBatchQualityReview } from './chapter-outline-batch-contracts';
import { assertCompleteChapterCraftBrief } from './chapter-craft-brief-contracts';
import {
  buildChapterOutlineQualityRubric,
  CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS,
  formatChapterOutlineQualityIssues,
  reviewChapterOutlineQuality,
} from './chapter-outline-quality-review';
import { ChapterContinuityState, ChapterCraftBrief, ChapterSceneBeat, ChapterStoryUnit, OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { buildToolStreamProgressHeartbeat, streamPhaseTimeoutMs } from './llm-streaming';
import { assertChapterCharacterExecution, assertVolumeCharacterPlan, type CharacterReferenceCatalog } from './outline-character-contracts';
import { assertVolumeStoryUnitPlan, storyUnitForChapter, storyUnitServiceFunctions, type VolumeStoryUnitPlan } from './story-unit-contracts';
import { normalizeWithLlmRepair } from './structured-output-repair';

const CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const CHAPTER_OUTLINE_PREVIEW_QUALITY_REGENERATION_ATTEMPTS = 1;

interface GenerateChapterOutlinePreviewInput {
  context?: Record<string, unknown>;
  volumeOutline?: Record<string, unknown>;
  storyUnitPlan?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterNo?: number;
  chapterCount?: number;
  previousChapter?: Record<string, unknown>;
}

interface MergeChapterOutlinePreviewsInput {
  previews?: unknown[];
  context?: Record<string, unknown>;
  volumeNo?: number;
  chapterCount?: number;
  instruction?: string;
}

export interface ChapterOutlinePreviewOutput {
  volume: OutlinePreviewOutput['volume'];
  chapter: OutlinePreviewOutput['chapters'][number];
  chapters: OutlinePreviewOutput['chapters'];
  risks: string[];
  qualityReview?: ChapterOutlineBatchQualityReview;
}

@Injectable()
export class GenerateChapterOutlinePreviewTool implements BaseTool<GenerateChapterOutlinePreviewInput, ChapterOutlinePreviewOutput> {
  private readonly logger = new StructuredLogger(GenerateChapterOutlinePreviewTool.name);
  name = 'generate_chapter_outline_preview';
  description = '生成单章章节细纲与 Chapter.craftBrief 执行卡预览，不写入正式业务表。';
  inputSchema = {
    type: 'object' as const,
    required: ['context', 'chapterNo', 'chapterCount'],
    properties: {
      context: { type: 'object' as const },
      volumeOutline: { type: 'object' as const },
      storyUnitPlan: { type: 'object' as const },
      instruction: { type: 'string' as const },
      volumeNo: { type: 'number' as const },
      chapterNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      previousChapter: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volume', 'chapter', 'chapters', 'risks'],
    properties: {
      volume: { type: 'object' as const },
      chapter: { type: 'object' as const },
      chapters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = ((CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS + CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS) * (CHAPTER_OUTLINE_PREVIEW_QUALITY_REGENERATION_ATTEMPTS + 1))
    + (CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS * (CHAPTER_OUTLINE_PREVIEW_QUALITY_REGENERATION_ATTEMPTS + 1))
    + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成单章细纲与执行卡预览',
    description: '为指定 chapterNo 生成单章章节细纲、storyUnit 和 Chapter.craftBrief；用于把 60 章细纲在 Agent Plan 中展开为每章一个可见 Tool 调用。',
    whenToUse: [
      'Agent 需要为卷细纲、章节细纲、60 章细纲逐章生成可见步骤时',
      '上一章细纲已经生成，需要用 previousChapter 接力卡生成下一章时',
      '只需要生成某一个 chapterNo 的章节细纲和 craftBrief，不写正文时',
      '用户只要求基于已有卷纲生成章节细纲时，可直接读取 inspect_project_context.output.volumes 中的 Volume.narrativePlan，不必重新生成卷大纲或单元故事',
    ],
    whenNotToUse: [
      '用户要求写正文时使用 write_chapter 或 write_chapter_series',
      '用户要求拆场景卡时使用 generate_scene_cards_preview',
      '已经有多个单章预览需要合并时使用 merge_chapter_outline_previews',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '通常来自 inspect_project_context.output。' },
      volumeOutline: { source: 'previous_step', description: '可选。若刚重写卷纲，传上游 generate_volume_outline_preview.output.volume；否则工具会从 inspect_project_context.output.volumes 读取目标卷。' },
      storyUnitPlan: { source: 'previous_step', description: '可选。若刚重写单元故事，传上游 generate_story_units_preview.output.storyUnitPlan；否则工具会从 Volume.narrativePlan.storyUnitPlan 或 narrativePlan.storyUnits 读取。' },
      chapterNo: { source: 'user_message', description: '本次生成的全卷绝对章号。' },
      chapterCount: { source: 'user_message', description: '目标全卷总章节数，用于 volume.chapterCount 和单元故事范围。' },
      previousChapter: { source: 'previous_step', description: '上一章 generate_chapter_outline_preview.output.chapter，用于接力连续性。' },
    },
    examples: [
      {
        user: '为第一卷生成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'chapters', 'characters', 'lorebook'] } },
          { tool: 'generate_volume_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_story_units_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', volumeNo: 1, chapterNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', volumeNo: 1, chapterNo: 2, chapterCount: 60, previousChapter: '{{steps.4.output.chapter}}', instruction: '{{context.userMessage}}' } },
          { tool: 'merge_chapter_outline_previews', args: { previews: ['{{steps.4.output}}', '{{steps.5.output}}'], volumeNo: 1, chapterCount: 60 } },
        ],
      },
    ],
    failureHints: [
      { code: 'LLM_TIMEOUT', meaning: '单章细纲 LLM 超时', suggestedRepair: '重试当前失败章节，或缩小上下文。' },
      { code: 'INCOMPLETE_CHAPTER_OUTLINE_PREVIEW', meaning: 'LLM 返回章节编号、volumeNo 或 craftBrief 不完整', suggestedRepair: '重试该章节，不要写入缺失执行卡的预览。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateChapterOutlinePreviewInput, context: ToolContext): Promise<ChapterOutlinePreviewOutput> {
    const volumeNo = this.positiveInt(args.volumeNo, 'volumeNo') ?? 1;
    const chapterNo = this.positiveInt(args.chapterNo, 'chapterNo');
    const chapterCount = this.positiveInt(args.chapterCount, 'chapterCount');
    if (!chapterNo) throw new Error('generate_chapter_outline_preview 缺少有效 chapterNo，未生成单章细纲。');
    if (!chapterCount) throw new Error('generate_chapter_outline_preview 缺少有效 chapterCount，未生成单章细纲。');
    if (chapterNo > chapterCount) throw new Error(`generate_chapter_outline_preview chapterNo ${chapterNo} 超过 chapterCount ${chapterCount}，未生成单章细纲。`);

    const generationPhaseMessage = `Generating chapter ${chapterNo} outline`;
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${chapterNo} 章细纲`,
      progressCurrent: chapterNo,
      progressTotal: chapterCount,
      timeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS),
    });
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterNo, chapterCount) },
    ];
    const logContext = {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      volumeNo,
      chapterNo,
      chapterCount,
      previousChapterNo: Number(this.asRecord(args.previousChapter).chapterNo) || null,
      timeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      timeoutKind: 'stream_idle',
      streamIdleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      streamPhaseTimeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS),
      maxTokensSent: null,
      maxTokensOmitted: true,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    const characterCatalog = this.extractCharacterCatalog(args.context);
    const onStreamProgress = buildToolStreamProgressHeartbeat({
      context,
      logger: this.logger,
      loggerEvent: 'chapter_outline_preview.stream_heartbeat_failed',
      phaseMessage: generationPhaseMessage,
      idleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      progressCurrent: chapterNo,
      progressTotal: chapterCount,
      metadata: { volumeNo, chapterNo, chapterCount },
    });
    this.logger.log('chapter_outline_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<unknown>(
        messages,
        {
          appStep: 'planner',
          timeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
          stream: true,
          streamIdleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
          onStreamProgress,
          retries: 0,
          jsonMode: true,
        },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      let normalized = await normalizeWithLlmRepair({
        toolName: this.name,
        loggerEventPrefix: 'chapter_outline_preview',
        llm: this.llm,
        context,
        data: response.data,
        normalize: (data) => this.normalize(data, volumeNo, chapterNo, chapterCount, args.context, args.volumeOutline, args.storyUnitPlan, characterCatalog),
        shouldRepair: ({ error, data }) => this.shouldRepairChapterOutlineOutput(data, error),
        buildRepairMessages: ({ invalidOutput, validationError }) =>
          this.buildRepairMessages(invalidOutput, validationError, args, volumeNo, chapterNo, chapterCount, characterCatalog),
        progress: {
          phaseMessage: `正在修复第 ${chapterNo} 章细纲结构`,
          timeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS),
        },
        llmOptions: {
          appStep: 'planner',
          timeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
          stream: true,
          streamIdleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
          onStreamProgress: buildToolStreamProgressHeartbeat({
            context,
            logger: this.logger,
            loggerEvent: 'chapter_outline_preview.stream_heartbeat_failed',
            phaseMessage: `Repairing chapter ${chapterNo} outline structure`,
            idleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
            progressCurrent: chapterNo,
            progressTotal: chapterCount,
            metadata: { volumeNo, chapterNo, chapterCount },
          }),
          temperature: 0.1,
        },
        maxRepairAttempts: 2,
        initialModel: response.result.model,
        logger: this.logger,
      });
      let regeneratedForQuality = false;
      let qualityReview = await this.reviewChapterQuality(normalized, args, volumeNo, chapterNo, chapterCount, characterCatalog, context);
      if (!qualityReview.valid) {
        regeneratedForQuality = true;
        await context.updateProgress?.({
          phase: 'calling_llm',
          phaseMessage: `Regenerating chapter ${chapterNo} outline from LLM quality issues`,
          progressCurrent: chapterNo,
          progressTotal: chapterCount,
          timeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS),
        });
        const qualityRegenerationPhaseMessage = `Regenerating chapter ${chapterNo} outline from LLM quality issues`;
        const regenerationResponse = await this.llm.chatJson<unknown>(
          this.buildQualityRegenerationMessages({
            args,
            volumeNo,
            chapterNo,
            chapterCount,
            rejectedOutput: normalized,
            qualityReview,
            characterCatalog,
          }),
          {
            appStep: 'planner',
            timeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
            stream: true,
            streamIdleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
            onStreamProgress: buildToolStreamProgressHeartbeat({
              context,
              logger: this.logger,
              loggerEvent: 'chapter_outline_preview.stream_heartbeat_failed',
              phaseMessage: qualityRegenerationPhaseMessage,
              idleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
              progressCurrent: chapterNo,
              progressTotal: chapterCount,
              metadata: { volumeNo, chapterNo, chapterCount, phase: 'quality_regeneration' },
            }),
            retries: 0,
            jsonMode: true,
            temperature: 0.2,
          },
        );
        recordToolLlmUsage(context, 'outline_chapter_quality_regeneration', regenerationResponse.result);
        normalized = await normalizeWithLlmRepair({
          toolName: this.name,
          loggerEventPrefix: 'chapter_outline_preview',
          llm: this.llm,
          context,
          data: regenerationResponse.data,
          normalize: (data) => this.normalize(data, volumeNo, chapterNo, chapterCount, args.context, args.volumeOutline, args.storyUnitPlan, characterCatalog),
          shouldRepair: ({ error, data }) => this.shouldRepairChapterOutlineOutput(data, error),
          buildRepairMessages: ({ invalidOutput, validationError }) =>
            this.buildRepairMessages(invalidOutput, validationError, args, volumeNo, chapterNo, chapterCount, characterCatalog),
          progress: {
            phaseMessage: `正在修复第 ${chapterNo} 章质量重生后的结构`,
            timeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS),
          },
          llmOptions: {
            appStep: 'planner',
            timeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
            stream: true,
            streamIdleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
            onStreamProgress: buildToolStreamProgressHeartbeat({
              context,
              logger: this.logger,
              loggerEvent: 'chapter_outline_preview.stream_heartbeat_failed',
              phaseMessage: `Repairing regenerated chapter ${chapterNo} outline structure`,
              idleTimeoutMs: CHAPTER_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
              progressCurrent: chapterNo,
              progressTotal: chapterCount,
              metadata: { volumeNo, chapterNo, chapterCount, phase: 'quality_regeneration_repair' },
            }),
            temperature: 0.1,
          },
          maxRepairAttempts: 1,
          initialModel: regenerationResponse.result.model,
          logger: this.logger,
        });
        qualityReview = await this.reviewChapterQuality(normalized, args, volumeNo, chapterNo, chapterCount, characterCatalog, context);
        if (!qualityReview.valid) {
          throw new Error(`generate_chapter_outline_preview LLM quality validation failed after retry: ${formatChapterOutlineQualityIssues(qualityReview)}`);
        }
      }
      this.logger.log('chapter_outline_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
        regeneratedForQuality,
        qualityIssueCount: qualityReview.issues.length,
      });
      return {
        ...normalized,
        qualityReview,
        risks: [
          ...normalized.risks,
          ...(regeneratedForQuality ? [`LLM quality review requested one regeneration for chapter ${chapterNo}; accepted after retry.`] : []),
          ...qualityReview.issues
            .filter((issue) => issue.severity === 'warning')
            .map((issue) => `LLM quality warning${issue.chapterNo ? ` chapter ${issue.chapterNo}` : ''}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`),
        ],
      };
    } catch (error) {
      this.logger.error('chapter_outline_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private shouldRepairChapterOutlineOutput(data: unknown, error: unknown): boolean {
    const message = this.errorMessage(error);
    const output = this.asRecord(data);
    const topLevelChapter = this.asRecord(output.chapter);
    const rawChapters = Object.keys(topLevelChapter).length ? [topLevelChapter] : (Array.isArray(output.chapters) ? output.chapters : []);
    if (rawChapters.length !== 1) return false;
    const chapterRecord = this.asRecord(rawChapters[0]);
    const craftBrief = this.asRecord(chapterRecord.craftBrief);
    if (/chapterNo 不匹配|volumeNo 不匹配/.test(message)) return Object.keys(chapterRecord).length > 0;
    if (!Object.keys(craftBrief).length) return false;
    if (/firstAndOnlyUse|approvalPolicy 声明为 needs_approval|未进入卷级角色候选/.test(message)) return false;
    if (/craftBrief\.storyUnit (is required|缺少)|缺少 craftBrief\.storyUnit/.test(message)) return false;
    if (/craftBrief\.(visibleGoal|hiddenEmotion|coreConflict|mainlineTask|subplotTasks|actionBeats|sceneBeats|concreteClues|dialogueSubtext|characterShift|irreversibleConsequence|progressTypes|entryState|exitState|openLoops|closedLoops|handoffToNextChapter|continuityState)/.test(message)) return true;
    if (/relationshipBeats\[\d+\]\.(participants|publicStateBefore|trigger|shift|publicStateAfter|hiddenStateBefore|hiddenStateAfter)/.test(message)) return true;
    if (/(cast|newMinorCharacters)\[\d+\]\./.test(message)) return true;
    if (/characterExecution|sceneBeats\[\d+\]\.participants|participants 未被 characterExecution\.cast 覆盖|povCharacter 未出现在 cast|sceneBeatRefs|actionBeatRefs/.test(message)) return true;
    return false;
  }

  private async reviewChapterQuality(
    output: ChapterOutlinePreviewOutput,
    args: GenerateChapterOutlinePreviewInput,
    volumeNo: number,
    chapterNo: number,
    chapterCount: number,
    characterCatalog: CharacterReferenceCatalog,
    context: ToolContext,
  ): Promise<ChapterOutlineBatchQualityReview> {
    return reviewChapterOutlineQuality(this.llm, context, {
      task: 'Review this generated single chapter outline before it can enter approval/write or downstream drafting flow.',
      target: { volumeNo, chapterCount, chapterNo, chapterRange: { start: chapterNo, end: chapterNo } },
      output,
      volumeSummary: {
        title: output.volume.title,
        synopsis: output.volume.synopsis,
        objective: output.volume.objective,
        narrativePlan: output.volume.narrativePlan,
      },
      storyUnitSlice: output.chapter.craftBrief?.storyUnit ?? args.storyUnitPlan ?? {},
      characterSourceWhitelist: {
        existing: characterCatalog.existingCharacterNames ?? [],
        volume_candidate: this.extractVolumeCandidateNames(output.volume),
        minor_temporary: 'Only one-off local function characters declared in newMinorCharacters.',
      },
      chapterRange: { start: chapterNo, end: chapterNo },
      progressMessage: `LLM reviewing chapter ${chapterNo} outline quality`,
      progressCurrent: chapterNo,
      progressTotal: chapterCount,
      usageStep: 'outline_chapter_quality_review',
      schemaName: 'chapter_outline_quality_review',
      schemaDescription: 'LLM semantic quality review for a generated single chapter outline.',
    });
  }

  private buildQualityRegenerationMessages(input: {
    args: GenerateChapterOutlinePreviewInput;
    volumeNo: number;
    chapterNo: number;
    chapterCount: number;
    rejectedOutput: ChapterOutlinePreviewOutput;
    qualityReview: ChapterOutlineBatchQualityReview;
    characterCatalog: CharacterReferenceCatalog;
  }): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          'You regenerate a Chinese web-novel single chapter outline after LLM semantic quality review.',
          'Regenerate the whole target chapter, not a prose explanation.',
          'Preserve the target chapterNo, volumeNo, storyUnit identity, and required JSON shape.',
          'Fix every error-level quality issue. Do not create deterministic placeholders or skeletal template text.',
          'Return compact strict JSON only with volume, chapter, and risks. No Markdown, comments, or prose.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          userInstruction: input.args.instruction ?? '',
          target: { volumeNo: input.volumeNo, chapterNo: input.chapterNo, chapterCount: input.chapterCount },
          qualityRubric: buildChapterOutlineQualityRubric(),
          qualityIssuesToFix: input.qualityReview.issues.filter((issue) => issue.severity === 'error'),
          rejectedOutput: input.rejectedOutput,
          volume: input.rejectedOutput.volume,
          storyUnit: input.rejectedOutput.chapter.craftBrief?.storyUnit ?? input.args.storyUnitPlan ?? null,
          previousChapter: input.args.previousChapter ?? null,
          characterSourceWhitelist: {
            existing: input.characterCatalog.existingCharacterNames ?? [],
            volume_candidate: this.extractVolumeCandidateNames(input.rejectedOutput.volume),
            minor_temporary: 'Only one-off local function characters; declare in newMinorCharacters with firstAndOnlyUse=true and approvalPolicy=preview_only.',
          },
          hardRules: [
            `Return exactly chapter ${input.chapterNo}.`,
            'Every chapter must include title, objective, conflict, hook, outline, expectedWordCount, and complete craftBrief.',
            'Every craftBrief.actionBeats item must be a concrete executable beat with actor, visible action, object/target, obstacle or result.',
            'Every sceneBeats.visibleAction must describe a visible action that can be drafted directly into prose.',
            'Maintain entryState, exitState, handoffToNextChapter, openLoops, closedLoops, and continuityState so adjacent chapters can continue.',
          ],
          requiredJsonShape: { volume: input.rejectedOutput.volume, chapter: input.rejectedOutput.chapter, risks: [] },
        }),
      },
    ];
  }

  private buildRepairMessages(
    invalidOutput: unknown,
    validationError: string,
    args: GenerateChapterOutlinePreviewInput,
    volumeNo: number,
    chapterNo: number,
    chapterCount: number,
    characterCatalog: CharacterReferenceCatalog,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    const outlineCandidateNames = this.extractVolumeCandidateNames(args.volumeOutline);
    const volumeCandidateNames = outlineCandidateNames.length ? outlineCandidateNames : this.extractVolumeCandidateNames(this.findContextVolume(args.context, volumeNo));
    return [
      {
        role: 'system',
        content: [
          '你是小说单章细纲 JSON 结构修复器。只输出严格 JSON，不要 Markdown、解释或代码块。',
          '只修复结构校验错误，尽量保留原章节目标、冲突、场景、行动链、线索、人物关系和交接压力；不要重写成新章节。',
          '不得输出占位 craftBrief、模板行动链或模板后果；缺整章、缺整张 craftBrief、重要新角色未进入卷级候选时应保持失败。',
          'characterExecution.cast 的 source 必须与角色来源一致：既有角色用 existing；卷级候选用 volume_candidate；一次性临时角色用 minor_temporary 并列入 newMinorCharacters。',
          'sceneBeats.participants、relationshipBeats.participants 必须都出现在 characterExecution.cast.characterName 中。',
          'relationshipBeats 可以是空数组；如果包含对象，每个对象必须完整包含 participants、publicStateBefore、trigger、shift、publicStateAfter，hiddenStateBefore/hiddenStateAfter 可选。不要留下半截关系变化对象。',
          '修复后必须返回完整对象，只包含 volume、chapter、risks。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            targetVolumeNo: volumeNo,
            targetChapterNo: chapterNo,
            targetChapterCount: chapterCount,
            validationError,
            existingCharacterNames: characterCatalog.existingCharacterNames ?? [],
            existingCharacterAliases: characterCatalog.existingCharacterAliases ?? {},
            volumeCandidateNames,
            previousChapter: args.previousChapter ?? null,
            storyUnitPlan: args.storyUnitPlan ?? null,
            invalidOutput,
            repairContract: {
              chapter: {
                chapterNo,
                volumeNo,
                craftBrief: 'complete local missing fields only; preserve concrete action and consequence content',
                characterExecution: {
                  cast: 'source/participants must match known existing characters, volume candidates, or declared minor temporaries',
                  relationshipBeats: '[] or complete objects with participants, publicStateBefore, trigger, shift, publicStateAfter; hiddenStateBefore/hiddenStateAfter are optional',
                  newMinorCharacters: '[] or complete temporary character declarations',
                },
              },
            },
          },
          null,
          2,
        ),
      },
    ];
  }

  private normalize(data: unknown, volumeNo: number, chapterNo: number, chapterCount: number, contextInput?: Record<string, unknown>, volumeOutline?: Record<string, unknown>, storyUnitPlanInput?: Record<string, unknown>, characterCatalog: CharacterReferenceCatalog = {}): ChapterOutlinePreviewOutput {
    const output = this.asRecord(data);
    const topLevelChapter = this.asRecord(output.chapter);
    const rawChapters = Object.keys(topLevelChapter).length ? [topLevelChapter] : (Array.isArray(output.chapters) ? output.chapters : []);
    if (rawChapters.length !== 1) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章返回章节数 ${rawChapters.length}/1，未生成完整单章细纲。`);
    }
    const chapterRecord = this.asRecord(rawChapters[0]);
    const returnedChapterNo = Number(chapterRecord.chapterNo);
    if (!Number.isInteger(returnedChapterNo) || returnedChapterNo !== chapterNo) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 chapterNo 不匹配，未生成完整单章细纲。`);
    }
    const returnedVolumeNo = Number(chapterRecord.volumeNo);
    if (!Number.isInteger(returnedVolumeNo) || returnedVolumeNo !== volumeNo) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 volumeNo 不匹配，未生成完整单章细纲。`);
    }
    const expectedWordCount = Number(chapterRecord.expectedWordCount);
    if (!Number.isFinite(expectedWordCount) || expectedWordCount <= 0) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 expectedWordCount 无效，未生成完整单章细纲。`);
    }
    const providedVolume = this.asRecord(volumeOutline);
    const contextVolume = this.findContextVolume(contextInput, volumeNo);
    const llmVolume = this.asRecord(output.volume);
    const volumeRecord = Object.keys(providedVolume).length ? providedVolume : (Object.keys(contextVolume).length ? contextVolume : llmVolume);
    const returnedVolumeChapterCount = Number(volumeRecord.chapterCount);
    if (!Number.isInteger(Number(volumeRecord.volumeNo)) || Number(volumeRecord.volumeNo) !== volumeNo) {
      throw new Error(`generate_chapter_outline_preview volume.volumeNo 与目标卷 ${volumeNo} 不匹配，未生成完整单章细纲。`);
    }
    if (!Number.isInteger(returnedVolumeChapterCount) || returnedVolumeChapterCount !== chapterCount) {
      throw new Error(`generate_chapter_outline_preview volume.chapterCount 与目标章节数 ${chapterCount} 不匹配，未生成完整单章细纲。`);
    }
    const narrativePlan = this.asRecord(volumeRecord.narrativePlan);
    const characterPlan = assertVolumeCharacterPlan(narrativePlan.characterPlan, {
      chapterCount,
      ...characterCatalog,
      label: 'volume.narrativePlan.characterPlan',
    });
    narrativePlan.characterPlan = characterPlan;
    const providedStoryUnitPlan = this.asRecord(storyUnitPlanInput);
    if (Object.keys(providedStoryUnitPlan).length) {
      narrativePlan.storyUnitPlan = assertVolumeStoryUnitPlan(providedStoryUnitPlan, {
        chapterCount,
        label: 'storyUnitPlan',
      });
    }
    const volumeCandidateNames = characterPlan.newCharacterCandidates.map((candidate) => candidate.name);
    const hasAuthoritativeVolume = Object.keys(providedVolume).length > 0 || Object.keys(contextVolume).length > 0;
    const requiredStoryUnit = hasAuthoritativeVolume ? this.findRequiredStoryUnit(narrativePlan, storyUnitPlanInput, chapterNo, chapterCount) : undefined;
    if (hasAuthoritativeVolume) {
      this.assertProvidedVolumeStoryUnit(requiredStoryUnit, chapterNo);
    }
    const chapter = {
      chapterNo,
      volumeNo,
      title: this.requiredText(chapterRecord.title, `第 ${chapterNo} 章 title`),
      objective: this.requiredText(chapterRecord.objective, `第 ${chapterNo} 章 objective`),
      conflict: this.requiredText(chapterRecord.conflict, `第 ${chapterNo} 章 conflict`),
      hook: this.requiredText(chapterRecord.hook, `第 ${chapterNo} 章 hook`),
      outline: this.requiredText(chapterRecord.outline, `第 ${chapterNo} 章 outline`),
      expectedWordCount,
      craftBrief: this.normalizeCraftBrief(chapterRecord.craftBrief, `第 ${chapterNo} 章`, { ...characterCatalog, volumeCandidateNames }),
    };
    if (requiredStoryUnit) {
      this.assertChapterUsesProvidedStoryUnit(chapter.craftBrief.storyUnit, requiredStoryUnit, chapterNo);
    }
    return {
      volume: {
        volumeNo,
        title: this.requiredText(volumeRecord.title, 'volume.title'),
        synopsis: this.requiredText(volumeRecord.synopsis, 'volume.synopsis'),
        objective: this.requiredText(volumeRecord.objective, 'volume.objective'),
        chapterCount,
        ...(Object.keys(narrativePlan).length ? { narrativePlan } : {}),
      },
      chapter,
      chapters: [chapter],
      risks: this.stringArray(output.risks, []),
    };
  }

  private buildSystemPrompt(): string {
    return [
      '你是小说单章细纲设计 Agent。只输出严格 JSON，不要 Markdown、解释或代码块。',
      '本工具只生成一个指定 chapterNo 的章节细纲与 Chapter.craftBrief，不写正文。',
      'LLM 输出字段只包含 volume、chapter、risks；不要输出章节数组，工具会在解析通过后自动构造下游合并所需数组。',
      '如果用户提示中提供上游卷大纲 volumeOutline，必须把它作为唯一卷级结构来源；不要重新发明卷大纲、卷内支线或角色规划。',
      '如果用户提示中提供 storyUnitPlan，craftBrief.storyUnit 必须从 storyUnitPlan.chapterAllocation 中选择覆盖本章章号的单元故事，并沿用 unitId、title、chapterRange、localGoal、localConflict、serviceFunctions、mainlineSegmentIds、serviceToMainline、unitPayoff/stateChangeAfterUnit，只补本章 chapterRole 和各类 contribution。',
      '兼容旧数据：只有在没有 storyUnitPlan 时，才允许从 volumeOutline.narrativePlan.storyUnits 中选择覆盖本章章号的单元故事。',
      'chapterNo 必须使用用户指定的全卷绝对章号；volume.chapterCount 必须等于目标全卷章节数。',
      '每章必须包含 chapterNo、volumeNo、title、objective、conflict、hook、outline、expectedWordCount、craftBrief。',
      'outline 必须写成 3-5 个连续场景段，包含具体地点、人物、可见动作、阻力、转折和阶段结果。',
      'craftBrief 必须包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、storyUnit、actionBeats、sceneBeats、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState。',
      'craftBrief 必须包含 characterExecution：povCharacter、cast、relationshipBeats、newMinorCharacters。',
      'characterExecution.cast 至少 1 人；source 只能是 existing、volume_candidate、minor_temporary。existing 必须来自角色摘要；volume_candidate 必须来自上游卷纲 characterPlan.newCharacterCandidates；minor_temporary 必须出现在 newMinorCharacters。',
      'sceneBeats.participants 和 relationshipBeats.participants 必须全部被 characterExecution.cast.characterName 覆盖。',
      'relationshipBeats 可以是空数组；如果包含关系变化对象，必须包含 participants、publicStateBefore、trigger、shift、publicStateAfter，hiddenStateBefore/hiddenStateAfter 可选。',
      'minor_temporary 只能承担一次性功能角色，不得承担本卷主线核心功能、反派主压力或长期人物弧；重要新角色必须先进入上游卷级候选。',
      'craftBrief.actionBeats 至少 3 个节点；sceneBeats 至少 3 个场景段；concreteClues 至少 1 个且包含 name、sensoryDetail、laterUse。',
      'craftBrief.storyUnit 必须包含 unitId、title、chapterRange、chapterRole、localGoal、localConflict、serviceFunctions、mainlineContribution、characterContribution、relationshipContribution、worldOrThemeContribution、unitPayoff、stateChangeAfterUnit；若上游单元故事含 mainlineSegmentIds/serviceToMainline，必须承接到 mainlineContribution；serviceFunctions 至少 3 项。',
      'craftBrief.continuityState 必须包含角色位置、仍在生效的威胁、已持有线索/资源、关系变化和 nextImmediatePressure。',
      '如果提供 previousChapter，必须承接 previousChapter.craftBrief.exitState、handoffToNextChapter、openLoops、continuityState.nextImmediatePressure；不能让压力凭空消失。',
      '禁止只写推进、建立、完成、探索、揭示、面对、选择、升级、铺垫、承接等抽象词；必须绑定具体地点、人物、动作、物件和后果。',
      'JSON 骨架：{"volume":{"volumeNo":1,"title":"卷名","synopsis":"卷概要","objective":"卷目标","chapterCount":60,"narrativePlan":{"storyUnits":[],"characterPlan":{"existingCharacterArcs":[],"newCharacterCandidates":[],"relationshipArcs":[],"roleCoverage":{"mainlineDrivers":[],"antagonistPressure":[],"emotionalCounterweights":[],"expositionCarriers":[]}}}},"chapter":{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章可检验目标","conflict":"阻力来源与方式","hook":"章末交接钩子","outline":"1. 场景段...\\n2. 场景段...\\n3. 场景段...","expectedWordCount":2500,"craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"主线任务","subplotTasks":["支线任务"],"storyUnit":{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"chapterRole":"开局/升级/反转/收束","localGoal":"单元目标","localConflict":"单元阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"主线贡献","characterContribution":"人物贡献","relationshipContribution":"关系贡献","worldOrThemeContribution":"世界或主题贡献","unitPayoff":"单元回收","stateChangeAfterUnit":"单元后状态"},"actionBeats":["行动1","行动2","行动3"],"sceneBeats":[{"sceneArcId":"arc","scenePart":"1/3","continuesFromChapterNo":null,"continuesToChapterNo":null,"location":"地点","participants":["角色"],"localGoal":"场景目标","visibleAction":"可见动作","obstacle":"阻力","turningPoint":"转折","partResult":"结果","sensoryAnchor":"感官锚点"}],"characterExecution":{"povCharacter":"角色","cast":[{"characterName":"角色","source":"existing","functionInChapter":"本章功能","visibleGoal":"可见目标","pressure":"压力","actionBeatRefs":[1],"sceneBeatRefs":["arc"],"entryState":"入场状态","exitState":"离场状态"}],"relationshipBeats":[{"participants":["角色A","角色B"],"publicStateBefore":"公开关系旧状态","trigger":"触发关系变化的具体事件","shift":"关系变化","publicStateAfter":"公开关系新状态"}],"newMinorCharacters":[]},"concreteClues":[{"name":"线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"],"entryState":"入场状态","exitState":"离场状态","openLoops":["未解决问题"],"closedLoops":["阶段性解决问题"],"handoffToNextChapter":"下一章交接","continuityState":{"characterPositions":["位置"],"activeThreats":["威胁"],"ownedClues":["线索"],"relationshipChanges":["关系变化"],"nextImmediatePressure":"下一章压力"}}},"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(args: GenerateChapterOutlinePreviewInput, volumeNo: number, chapterNo: number, chapterCount: number): string {
    const context = this.asRecord(args.context);
    const project = this.asRecord(context.project);
    const volumes = Array.isArray(context.volumes) ? context.volumes.map((item) => this.asRecord(item)) : [];
    const upstreamVolumeOutline = this.asRecord(args.volumeOutline);
    const contextVolume = volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
    const targetVolume = Object.keys(upstreamVolumeOutline).length ? upstreamVolumeOutline : contextVolume;
    const targetNarrativePlan = this.asRecord(targetVolume.narrativePlan);
    const selectedStoryUnit = this.findRequiredStoryUnit(targetNarrativePlan, args.storyUnitPlan, chapterNo, chapterCount);
    const characterCatalog = this.extractCharacterCatalog(context);
    const volumeCandidateNames = this.extractVolumeCandidateNames(targetVolume);
    const relationships = Array.isArray(context.relationships) ? context.relationships.slice(0, 60) : [];
    const characterStates = Array.isArray(context.characterStates) ? context.characterStates.slice(0, 60) : [];
    return [
      `用户目标：${args.instruction ?? '生成单章章节细纲'}`,
      `目标卷：第 ${volumeNo} 卷`,
      `目标章：第 ${chapterNo} 章`,
      `全卷章节数：${chapterCount}`,
      '',
      '项目概览：',
      this.safeJson({ title: project.title, genre: project.genre, tone: project.tone, synopsis: project.synopsis, outline: project.outline }, 3000),
      '',
      '上游卷大纲（必须承接其主线、支线、角色规划和伏笔；不要重写卷级结构）：',
      this.safeJson({ volumeNo, title: targetVolume.title, synopsis: targetVolume.synopsis, objective: targetVolume.objective, narrativePlan: targetVolume.narrativePlan }, 4000),
      '',
      '上游单元故事计划（必须承接；不要在本章重新创造单元故事）：',
      this.safeJson(args.storyUnitPlan ?? targetNarrativePlan.storyUnitPlan ?? {}, 3000),
      '',
      '本章应承接的单元故事：',
      this.safeJson(selectedStoryUnit ?? { warning: '未找到覆盖本章的 storyUnit；如提供了 volumeOutline 或 storyUnitPlan，应视为上游规划不完整并在 risks 中标记。' }, 2000),
      '',
      '已有章节摘要：',
      this.safeJson(Array.isArray(context.existingChapters) ? context.existingChapters.slice(0, 160) : [], 6000),
      '',
      '上一章接力卡：',
      this.safeJson(args.previousChapter ?? { previousChapterNo: null, note: '这是本次计划的首章或未提供上一章；从项目和卷上下文开篇。' }, 3000),
      '',
      '已有角色摘要（名称、别名、scope、状态和关系锚点；优先使用既有角色，不要重复造人）：',
      this.safeJson(Array.isArray(context.characters) ? context.characters.slice(0, 30) : [], 4000),
      '',
      'characterExecution.cast source whitelist (must follow exactly):',
      this.safeJson({
        existing: characterCatalog.existingCharacterNames ?? [],
        volume_candidate: volumeCandidateNames,
        minor_temporary: 'Only one-off local function characters; declare in newMinorCharacters with firstAndOnlyUse as JSON boolean true and approvalPolicy preview_only.',
      }, 3000),
      '',
      '既有关系边摘要（本章 relationshipBeats 必须承接或推进这些关系；新增长期关系应先进入卷级 characterPlan.relationshipArcs）：',
      this.safeJson(relationships, 4000),
      '',
      '近期角色状态摘要（本章 entryState、exitState、continuityState 和 characterExecution.entryState 必须承接，不要让状态凭空重置）：',
      this.safeJson(characterStates, 4000),
      '角色执行硬要求：本章 cast 只能引用角色摘要中的既有角色、上游卷纲 characterPlan.newCharacterCandidates 中的候选，或 newMinorCharacters 中的一次性 minor_temporary。',
      '',
      '设定摘要：',
      this.safeJson(Array.isArray(context.lorebookEntries) ? context.lorebookEntries.slice(0, 30) : [], 4000),
      '',
      `请严格只返回第 ${chapterNo} 章，不要输出章节数组；chapterNo 必须是 ${chapterNo}，volumeNo 必须是 ${volumeNo}，volume.chapterCount 必须是 ${chapterCount}。`,
      '本章 craftBrief.storyUnit 必须使用上方“本章应承接的单元故事”的 unitId、chapterRange 和主线段服务关系；不要在章节细纲里创造新的单元故事或新的主线段。',
      '若上下文不足，把风险写入 risks，但仍输出完整单章细纲和 craftBrief。',
    ].join('\n');
  }

  private assertProvidedVolumeStoryUnit(storyUnit: Record<string, unknown> | undefined, chapterNo: number): void {
    if (!storyUnit) {
      throw new Error(`generate_chapter_outline_preview 上游 storyUnitPlan 或 volumeOutline.narrativePlan.storyUnits 未覆盖第 ${chapterNo} 章，未生成完整单章细纲。`);
    }
  }

  private assertChapterUsesProvidedStoryUnit(chapterStoryUnit: ChapterStoryUnit | undefined, providedStoryUnit: Record<string, unknown>, chapterNo: number): void {
    if (!chapterStoryUnit?.chapterRange) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 craftBrief.storyUnit 未承接上游卷大纲，未生成完整单章细纲。`);
    }
    const expectedUnitId = this.text(providedStoryUnit.unitId, '');
    if (chapterStoryUnit.unitId !== expectedUnitId) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 craftBrief.storyUnit.unitId 未承接上游卷大纲，未生成完整单章细纲。`);
    }
    const range = this.asRecord(providedStoryUnit.chapterRange);
    if (chapterStoryUnit.chapterRange.start !== Number(range.start) || chapterStoryUnit.chapterRange.end !== Number(range.end)) {
      throw new Error(`generate_chapter_outline_preview 第 ${chapterNo} 章 craftBrief.storyUnit.chapterRange 未承接上游卷大纲，未生成完整单章细纲。`);
    }
  }

  private findStoryUnitForChapter(narrativePlan: Record<string, unknown>, chapterNo: number): Record<string, unknown> | undefined {
    const storyUnits = this.asRecordArray(narrativePlan.storyUnits);
    return storyUnits.find((storyUnit) => {
      const range = this.asRecord(storyUnit.chapterRange);
      const start = Number(range.start);
      const end = Number(range.end);
      return Number.isInteger(start) && Number.isInteger(end) && start <= chapterNo && chapterNo <= end;
    });
  }

  private findRequiredStoryUnit(narrativePlan: Record<string, unknown>, storyUnitPlanInput: unknown, chapterNo: number, chapterCount: number): Record<string, unknown> | undefined {
    const explicitPlan = this.asRecord(storyUnitPlanInput);
    const embeddedPlan = this.asRecord(narrativePlan.storyUnitPlan);
    const planRecord = Object.keys(explicitPlan).length ? explicitPlan : embeddedPlan;
    if (Object.keys(planRecord).length) {
      const plan: VolumeStoryUnitPlan = assertVolumeStoryUnitPlan(planRecord, {
        chapterCount,
        label: 'storyUnitPlan',
      });
      const unit = storyUnitForChapter(plan, chapterNo);
      if (!unit) return undefined;
      return {
        unitId: unit.unitId,
        title: unit.title,
        chapterRange: unit.chapterRange,
        chapterRole: unit.chapterRoles[chapterNo - unit.chapterRange.start],
        localGoal: unit.localGoal,
        localConflict: unit.localConflict,
        serviceFunctions: storyUnitServiceFunctions(unit),
        mainlineSegmentIds: unit.mainlineSegmentIds,
        mainlineSegments: unit.mainlineSegments,
        serviceToMainline: unit.serviceToMainline,
        mainlineContribution: unit.narrativePurpose,
        characterContribution: unit.characterFocus.join('；'),
        relationshipContribution: unit.relationshipChanges.join('；'),
        worldOrThemeContribution: unit.worldbuildingReveals.join('；'),
        unitPayoff: unit.payoff,
        payoff: unit.payoff,
        stateChangeAfterUnit: unit.stateChangeAfterUnit,
      };
    }
    return this.findStoryUnitForChapter(narrativePlan, chapterNo);
  }

  private findContextVolume(contextInput: unknown, volumeNo: number): Record<string, unknown> {
    const context = this.asRecord(contextInput);
    const volumes = this.asRecordArray(context.volumes);
    return volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
  }

  private normalizeCraftBrief(value: unknown, label: string, characterOptions: CharacterReferenceCatalog & { volumeCandidateNames: string[] }): ChapterCraftBrief {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_preview ${label} 缺少 craftBrief，未生成完整单章细纲。`);
    const subplotTasks = this.requiredStringArray(record.subplotTasks, `${label}.craftBrief.subplotTasks`);
    const actionBeats = this.requiredStringArray(record.actionBeats, `${label}.craftBrief.actionBeats`);
    if (actionBeats.length < 3) throw new Error(`generate_chapter_outline_preview ${label} craftBrief.actionBeats 少于 3 个节点，未生成完整单章细纲。`);
    const clues = this.asRecordArray(record.concreteClues).map((item, index) => ({
      name: this.requiredText(item.name, `${label}.craftBrief.concreteClues[${index}].name`),
      sensoryDetail: this.requiredText(item.sensoryDetail, `${label}.craftBrief.concreteClues[${index}].sensoryDetail`),
      laterUse: this.requiredText(item.laterUse, `${label}.craftBrief.concreteClues[${index}].laterUse`),
    }));
    if (!clues.length) throw new Error(`generate_chapter_outline_preview ${label} craftBrief.concreteClues 为空，未生成完整单章细纲。`);
    const sceneBeats = this.normalizeSceneBeats(record.sceneBeats, label);
    const actionBeatCount = actionBeats.length;
    const characterExecution = assertChapterCharacterExecution(record.characterExecution, {
      ...characterOptions,
      actionBeatCount,
      sceneBeats,
      label: `${label}.craftBrief.characterExecution`,
    });
    const craftBrief = {
      visibleGoal: this.requiredText(record.visibleGoal, `${label}.craftBrief.visibleGoal`),
      hiddenEmotion: this.requiredText(record.hiddenEmotion, `${label}.craftBrief.hiddenEmotion`),
      coreConflict: this.requiredText(record.coreConflict, `${label}.craftBrief.coreConflict`),
      mainlineTask: this.requiredText(record.mainlineTask, `${label}.craftBrief.mainlineTask`),
      subplotTasks,
      storyUnit: this.normalizeStoryUnit(record.storyUnit, label),
      actionBeats,
      sceneBeats,
      concreteClues: clues,
      dialogueSubtext: this.requiredText(record.dialogueSubtext, `${label}.craftBrief.dialogueSubtext`),
      characterShift: this.requiredText(record.characterShift, `${label}.craftBrief.characterShift`),
      irreversibleConsequence: this.requiredText(record.irreversibleConsequence, `${label}.craftBrief.irreversibleConsequence`),
      progressTypes: this.requiredStringArray(record.progressTypes, `${label}.craftBrief.progressTypes`),
      entryState: this.requiredText(record.entryState, `${label}.craftBrief.entryState`),
      exitState: this.requiredText(record.exitState, `${label}.craftBrief.exitState`),
      openLoops: this.requiredStringArray(record.openLoops, `${label}.craftBrief.openLoops`),
      closedLoops: this.requiredStringArray(record.closedLoops, `${label}.craftBrief.closedLoops`),
      handoffToNextChapter: this.requiredText(record.handoffToNextChapter, `${label}.craftBrief.handoffToNextChapter`),
      continuityState: this.normalizeContinuityState(record.continuityState, label),
      characterExecution,
    };
    assertCompleteChapterCraftBrief(craftBrief, { label: `generate_chapter_outline_preview ${label}.craftBrief` });
    return craftBrief;
  }

  private normalizeStoryUnit(value: unknown, label: string): ChapterStoryUnit {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_preview ${label} 缺少 craftBrief.storyUnit，未生成完整单章细纲。`);
    const range = this.asRecord(record.chapterRange);
    const chapterRange = {
      start: this.requiredPositiveInt(range.start, `${label}.craftBrief.storyUnit.chapterRange.start`),
      end: this.requiredPositiveInt(range.end, `${label}.craftBrief.storyUnit.chapterRange.end`),
    };
    if (chapterRange.end < chapterRange.start) throw new Error(`generate_chapter_outline_preview ${label} craftBrief.storyUnit.chapterRange 无效，未生成完整单章细纲。`);
    const serviceFunctions = this.requiredStringArray(record.serviceFunctions, `${label}.craftBrief.storyUnit.serviceFunctions`);
    if (serviceFunctions.length < 3) throw new Error(`generate_chapter_outline_preview ${label} craftBrief.storyUnit.serviceFunctions 少于 3 项，未生成完整单章细纲。`);
    const mainlineSegmentIds = this.stringArray(record.mainlineSegmentIds, []);
    const mainlineSegments = this.asRecordArray(record.mainlineSegments);
    const serviceToMainline = this.text(record.serviceToMainline, '');
    return {
      unitId: this.requiredText(record.unitId, `${label}.craftBrief.storyUnit.unitId`),
      title: this.requiredText(record.title, `${label}.craftBrief.storyUnit.title`),
      chapterRange,
      chapterRole: this.requiredText(record.chapterRole, `${label}.craftBrief.storyUnit.chapterRole`),
      localGoal: this.requiredText(record.localGoal, `${label}.craftBrief.storyUnit.localGoal`),
      localConflict: this.requiredText(record.localConflict, `${label}.craftBrief.storyUnit.localConflict`),
      serviceFunctions,
      ...(mainlineSegmentIds.length ? { mainlineSegmentIds } : {}),
      ...(mainlineSegments.length ? { mainlineSegments } : {}),
      ...(serviceToMainline ? { serviceToMainline } : {}),
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
    if (beats.length < 3) throw new Error(`generate_chapter_outline_preview ${label} craftBrief.sceneBeats 少于 3 个场景段，未生成完整单章细纲。`);
    return beats;
  }

  private normalizeContinuityState(value: unknown, label: string): ChapterContinuityState {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_preview ${label} 缺少 craftBrief.continuityState，未生成完整单章细纲。`);
    const continuityState = {
      characterPositions: this.stringArray(record.characterPositions, []),
      activeThreats: this.stringArray(record.activeThreats, []),
      ownedClues: this.stringArray(record.ownedClues, []),
      relationshipChanges: this.stringArray(record.relationshipChanges, []),
      nextImmediatePressure: this.requiredText(record.nextImmediatePressure, `${label}.craftBrief.continuityState.nextImmediatePressure`),
    };
    if (![continuityState.characterPositions, continuityState.activeThreats, continuityState.ownedClues, continuityState.relationshipChanges].some((items) => items.length > 0)) {
      throw new Error(`generate_chapter_outline_preview ${label} craftBrief.continuityState 缺少连续状态，未生成完整单章细纲。`);
    }
    return continuityState;
  }

  private positiveInt(value: unknown, _label: string): number | undefined {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  private requiredPositiveInt(value: unknown, label: string): number {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) throw new Error(`generate_chapter_outline_preview 返回缺少 ${label}，未生成完整单章细纲。`);
    return numeric;
  }

  private optionalChapterNo(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 1 ? numeric : null;
  }

  private requiredStringArray(value: unknown, label: string): string[] {
    const items = this.stringArray(value, []);
    if (!items.length) throw new Error(`generate_chapter_outline_preview 返回缺少 ${label}，未生成完整单章细纲。`);
    return items;
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.text(value, '');
    if (!text.trim()) throw new Error(`generate_chapter_outline_preview 返回缺少 ${label}，未生成完整单章细纲。`);
    return text;
  }

  private text(value: unknown, defaultValue: string): string {
    if (typeof value === 'string') return value.trim() || defaultValue;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return defaultValue;
  }

  private stringArray(value: unknown, defaultValue: string[]): string[] {
    const items = Array.isArray(value) ? value.map((item) => this.text(item, '')).filter(Boolean) : [];
    return items.length ? items : defaultValue;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0) : [];
  }

  private safeJson(value: unknown, limit: number): string {
    const text = JSON.stringify(value ?? {}, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private extractVolumeCandidateNames(volumeOutlineValue: unknown): string[] {
    const volumeOutline = this.asRecord(volumeOutlineValue);
    const narrativePlan = this.asRecord(volumeOutline.narrativePlan);
    const characterPlan = this.asRecord(narrativePlan.characterPlan);
    const candidates = Array.isArray(characterPlan.newCharacterCandidates) ? characterPlan.newCharacterCandidates : [];
    return candidates
      .map((candidate) => this.text(this.asRecord(candidate).name, ''))
      .filter(Boolean);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private extractCharacterCatalog(contextValue: unknown): CharacterReferenceCatalog {
    const context = this.asRecord(contextValue);
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const existingCharacterNames: string[] = [];
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const item of characters) {
      const record = this.asRecord(item);
      const name = this.text(record.name, '');
      if (!name) continue;
      existingCharacterNames.push(name);
      const aliases = this.stringArray(record.aliases, []).length ? this.stringArray(record.aliases, []) : this.stringArray(record.alias, []);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }
    return { existingCharacterNames, existingCharacterAliases };
  }
}

@Injectable()
export class MergeChapterOutlinePreviewsTool implements BaseTool<MergeChapterOutlinePreviewsInput, OutlinePreviewOutput> {
  name = 'merge_chapter_outline_previews';
  description = '合并多个单章细纲预览为完整 outline_preview，供 persist_outline 使用。';
  inputSchema = {
    type: 'object' as const,
    required: ['previews', 'chapterCount'],
    properties: {
      previews: { type: 'array' as const, items: { type: 'object' as const }, minItems: 1 },
      context: { type: 'object' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      instruction: { type: 'string' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volume', 'chapters', 'risks'],
    properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '合并单章细纲预览',
    description: '把 generate_chapter_outline_preview 的多章输出合并为完整 outline_preview；严格校验章节数量、编号连续、volumeNo 和 craftBrief 完整性。',
    whenToUse: ['多个 generate_chapter_outline_preview 步骤完成后，需要合并为可写入的完整大纲预览'],
    whenNotToUse: ['只有一个整卷 generate_outline_preview 输出时无需使用'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      previews: { source: 'previous_step', description: '所有单章预览输出数组，例如 ["{{steps.2.output}}","{{steps.3.output}}"]。' },
      context: { source: 'previous_step', description: 'inspect_project_context 输出的真实角色目录；用于校验 existing 角色引用，不能用本次卷纲自证。' },
      chapterCount: { source: 'user_message', description: '目标全卷总章节数；合并后必须严格等于该数量。' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  async run(args: MergeChapterOutlinePreviewsInput, _context: ToolContext): Promise<OutlinePreviewOutput> {
    const previews = Array.isArray(args.previews) ? args.previews : [];
    const chapterCount = this.positiveInt(args.chapterCount, 'chapterCount');
    if (!chapterCount) throw new Error('merge_chapter_outline_previews 缺少有效 chapterCount，未合并完整细纲。');
    if (previews.length !== chapterCount) {
      throw new Error(`merge_chapter_outline_previews 收到单章预览数 ${previews.length}/${chapterCount}，未合并完整细纲。`);
    }
    const normalized = previews.map((preview, index) => this.normalizePreview(preview, index + 1));
    const volumeNo = this.positiveInt(args.volumeNo, 'volumeNo') ?? normalized[0]?.volume.volumeNo;
    if (!volumeNo) throw new Error('merge_chapter_outline_previews 缺少有效 volumeNo，未合并完整细纲。');
    const chapters = normalized.map((item) => item.chapter).sort((a, b) => a.chapterNo - b.chapterNo);
    const baseVolume = normalized[0].volume;
    this.assertMergedChapters(chapters, volumeNo, chapterCount, baseVolume, this.extractCharacterCatalog(args.context));
    if (normalized.some((item) => item.volume.volumeNo !== volumeNo || item.volume.chapterCount !== chapterCount)) {
      throw new Error('merge_chapter_outline_previews 发现卷号或章节总数不一致，未合并完整细纲。');
    }
    return {
      volume: {
        volumeNo,
        title: baseVolume.title,
        synopsis: baseVolume.synopsis,
        objective: baseVolume.objective,
        chapterCount,
        ...(baseVolume.narrativePlan ? { narrativePlan: baseVolume.narrativePlan } : {}),
      },
      chapters,
      risks: [
        `已由 ${chapterCount} 个单章细纲 Tool 调用合并为完整 outline_preview。`,
        ...normalized.flatMap((item) => item.risks.map((risk) => `第 ${item.chapter.chapterNo} 章：${risk}`)),
      ],
    };
  }

  private normalizePreview(value: unknown, fallbackChapterNo: number): ChapterOutlinePreviewOutput {
    const record = this.asRecord(value);
    const volume = this.asRecord(record.volume) as unknown as OutlinePreviewOutput['volume'];
    const chapter = this.asRecord(record.chapter);
    const rawChapter = Object.keys(chapter).length ? chapter : this.asRecordArray(record.chapters)[0];
    const normalizedChapter = rawChapter as unknown as OutlinePreviewOutput['chapters'][number];
    if (!Object.keys(this.asRecord(volume)).length || !Object.keys(rawChapter).length) {
      throw new Error(`merge_chapter_outline_previews 第 ${fallbackChapterNo} 个预览缺少 volume 或 chapter，未合并完整细纲。`);
    }
    return {
      volume,
      chapter: normalizedChapter,
      chapters: [normalizedChapter],
      risks: this.stringArray(record.risks, []),
    };
  }

  private assertMergedChapters(chapters: OutlinePreviewOutput['chapters'], volumeNo: number, chapterCount: number, volume: OutlinePreviewOutput['volume'], characterCatalog: CharacterReferenceCatalog): void {
    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo));
    if (chapterNos.length !== chapterCount) throw new Error(`merge_chapter_outline_previews 章节数为 ${chapterNos.length}/${chapterCount}，未合并完整细纲。`);
    if (new Set(chapterNos).size !== chapterNos.length) throw new Error('merge_chapter_outline_previews 发现重复章节编号，未合并完整细纲。');
    if (chapterNos.some((chapterNo, index) => !Number.isInteger(chapterNo) || chapterNo !== index + 1)) {
      throw new Error('merge_chapter_outline_previews 发现章节编号不连续，未合并完整细纲。');
    }
    if (chapters.some((chapter) => Number(chapter.volumeNo) !== volumeNo)) {
      throw new Error(`merge_chapter_outline_previews 发现 volumeNo 与目标卷 ${volumeNo} 不一致，未合并完整细纲。`);
    }
    const narrativePlan = this.asRecord(volume.narrativePlan);
    const characterPlan = assertVolumeCharacterPlan(narrativePlan.characterPlan, {
      chapterCount,
      existingCharacterNames: characterCatalog.existingCharacterNames,
      existingCharacterAliases: characterCatalog.existingCharacterAliases,
      label: 'volume.narrativePlan.characterPlan',
    });
    const volumeCandidateNames = characterPlan.newCharacterCandidates.map((candidate) => candidate.name);
    for (const chapter of chapters) {
      assertCompleteChapterCraftBrief(chapter.craftBrief, { label: `merge_chapter_outline_previews 第 ${chapter.chapterNo} 章 craftBrief` });
      assertChapterCharacterExecution(chapter.craftBrief?.characterExecution, {
        existingCharacterNames: characterCatalog.existingCharacterNames,
        existingCharacterAliases: characterCatalog.existingCharacterAliases,
        volumeCandidateNames,
        actionBeatCount: chapter.craftBrief?.actionBeats?.length,
        sceneBeats: chapter.craftBrief?.sceneBeats,
        label: `第 ${chapter.chapterNo} 章 craftBrief.characterExecution`,
      });
    }
  }

  private positiveInt(value: unknown, _label: string): number | undefined {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  private stringArray(value: unknown, defaultValue: string[]): string[] {
    const items = Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean) : [];
    return items.length ? items : defaultValue;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0) : [];
  }

  private extractCharacterCatalog(contextValue: unknown): CharacterReferenceCatalog {
    const context = this.asRecord(contextValue);
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const existingCharacterNames: string[] = [];
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const item of characters) {
      const record = this.asRecord(item);
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) continue;
      existingCharacterNames.push(name);
      const aliases = this.stringArray(record.aliases, []).length ? this.stringArray(record.aliases, []) : this.stringArray(record.alias, []);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }
    return { existingCharacterNames, existingCharacterAliases };
  }
}
