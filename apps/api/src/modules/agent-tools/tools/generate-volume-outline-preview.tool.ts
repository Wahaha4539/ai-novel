import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService, LlmJsonInvalidError } from '../../llm/llm-gateway.service';
import type { LlmChatMessage, LlmChatOptions } from '../../llm/dto/llm-chat.dto';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { buildToolStreamProgressHeartbeat, streamPhaseTimeoutMs } from './llm-streaming';
import { VOLUME_CHARACTER_ROLE_TYPES, type CharacterReferenceCatalog } from './outline-character-contracts';
import { assertVolumeNarrativePlan } from './outline-narrative-contracts';
import { normalizeWithLlmRepair } from './structured-output-repair';

const VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const VOLUME_OUTLINE_PREVIEW_MAX_TOKENS = 16_000;

interface GenerateVolumeOutlinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterCount?: number;
}

export interface VolumeOutlinePreviewOutput {
  volume: OutlinePreviewOutput['volume'];
  risks: string[];
}

@Injectable()
export class GenerateVolumeOutlinePreviewTool implements BaseTool<GenerateVolumeOutlinePreviewInput, VolumeOutlinePreviewOutput> {
  private readonly logger = new StructuredLogger(GenerateVolumeOutlinePreviewTool.name);
  name = 'generate_volume_outline_preview';
  description = '生成单独的卷大纲预览，包含 Volume.narrativePlan，不生成单元故事、章节细纲或正文。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volume', 'risks'],
    properties: {
      volume: { type: 'object' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS + VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成卷大纲预览',
    description: '先生成卷大纲、卷内支线、角色规划和伏笔方向；单元故事由 generate_story_units_preview 在后续步骤独立生成。',
    whenToUse: [
      '用户要求生成或重写卷大纲、重写卷细纲、从头规划卷细纲、重新拆成 N 章、改变章节数或重新划分单元故事时，先用本工具生成卷级战略规划',
      '后续 generate_story_units_preview 需要承接稳定的卷主线、支线、角色规划和伏笔时',
    ],
    whenNotToUse: [
      '用户只要求生成单章正文时使用 write_chapter',
      '用户只要求合并已生成章节细纲时使用 merge_chapter_outline_previews',
      '用户只要求基于已有卷纲生成、重写或重新生成章节细纲时，直接由 generate_chapter_outline_preview 承接 inspect_project_context 中的已持久化卷纲',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '通常来自 inspect_project_context.output。' },
      instruction: { source: 'user_message', description: '保留用户对卷号、章节数、节奏、风格和结构的要求。' },
      volumeNo: { source: 'user_message', description: '目标卷号。' },
      chapterCount: { source: 'user_message', description: '目标全卷章节数；只用于校验卷级角色/伏笔章节节点，不在本工具内固定单元故事范围。' },
    },
    examples: [
      {
        user: '重写第 1 卷卷纲，并重新拆成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'characters', 'lorebook'] } },
          { tool: 'generate_volume_outline_preview', args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 60 } },
          { tool: 'generate_story_units_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterCount: 60 } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', volumeNo: 1, chapterNo: 1, chapterCount: 60 } },
        ],
      },
    ],
    failureHints: [
      { code: 'LLM_TIMEOUT', meaning: '卷大纲 LLM 超时', suggestedRepair: '重试卷大纲步骤，或缩小卷范围。' },
      { code: 'INCOMPLETE_VOLUME_OUTLINE_PREVIEW', meaning: 'LLM 返回卷号、章节数、卷级 narrativePlan 或 characterPlan 不完整', suggestedRepair: '重新生成完整卷纲，不要进入单元故事或章节细纲。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateVolumeOutlinePreviewInput, context: ToolContext): Promise<VolumeOutlinePreviewOutput> {
    const volumeNo = this.positiveInt(args.volumeNo, 'volumeNo') ?? 1;
    const chapterCount = this.positiveInt(args.chapterCount, 'chapterCount') ?? this.targetVolumeChapterCount(args.context, volumeNo);
    if (!chapterCount) {
      throw new Error('generate_volume_outline_preview 缺少目标章节数，未生成完整卷大纲。');
    }
    const generationPhaseMessage = `Generating volume ${volumeNo} outline`;
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${volumeNo} 卷卷大纲`,
      timeoutMs: streamPhaseTimeoutMs(VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS),
    });
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterCount) },
    ];
    const maxTokens = VOLUME_OUTLINE_PREVIEW_MAX_TOKENS;
    const logContext = {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      volumeNo,
      chapterCount,
      timeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      timeoutKind: 'stream_idle',
      streamIdleTimeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      streamPhaseTimeoutMs: streamPhaseTimeoutMs(VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS),
      maxTokensSent: maxTokens,
      maxTokensOmitted: false,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    const characterCatalog = this.extractCharacterCatalog(args.context);
    const onStreamProgress = buildToolStreamProgressHeartbeat({
      context,
      logger: this.logger,
      loggerEvent: 'volume_outline_preview.stream_heartbeat_failed',
      phaseMessage: generationPhaseMessage,
      idleTimeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      metadata: { volumeNo, chapterCount },
    });
    this.logger.log('volume_outline_preview.llm_request.started', logContext);
    try {
      const response = await this.chatVolumeOutlineJson(
        messages,
        {
          appStep: 'planner',
          timeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
          stream: true,
          streamIdleTimeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
          onStreamProgress,
          retries: 0,
          jsonMode: true,
          maxTokens,
        },
        { volumeNo, chapterCount },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      this.logger.log('volume_outline_preview.llm_response.received', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
        rawPayloadSummary: response.result.rawPayloadSummary,
        rawResponse: this.rawLlmResponseLog(response.data),
      });
      const normalized = await normalizeWithLlmRepair({
        toolName: this.name,
        loggerEventPrefix: 'volume_outline_preview',
        llm: this.llm,
        context,
        data: response.data,
        normalize: (data) => this.normalize(data, volumeNo, chapterCount, characterCatalog),
        shouldRepair: ({ error, data }) => this.shouldRepairVolumeOutlineOutput(data, error),
        buildRepairMessages: ({ invalidOutput, validationError }) =>
          this.buildRepairMessages(invalidOutput, validationError, volumeNo, chapterCount, characterCatalog),
        progress: {
          phaseMessage: `正在修复第 ${volumeNo} 卷卷大纲结构`,
          timeoutMs: streamPhaseTimeoutMs(VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS),
        },
        llmOptions: {
          appStep: 'planner',
          timeoutMs: VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
          stream: true,
          streamIdleTimeoutMs: VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
          onStreamProgress: buildToolStreamProgressHeartbeat({
            context,
            logger: this.logger,
            loggerEvent: 'volume_outline_preview.stream_heartbeat_failed',
            phaseMessage: `Repairing volume ${volumeNo} outline structure`,
            idleTimeoutMs: VOLUME_OUTLINE_PREVIEW_REPAIR_TIMEOUT_MS,
            metadata: { volumeNo, chapterCount },
          }),
          temperature: 0.1,
          maxTokens,
        },
        maxRepairAttempts: 1,
        initialModel: response.result.model,
        logger: this.logger,
      });
      this.logger.log('volume_outline_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
      });
      return normalized;
    } catch (error) {
      this.logger.error('volume_outline_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async chatVolumeOutlineJson(
    messages: LlmChatMessage[],
    options: LlmChatOptions,
    retryContext: { volumeNo: number; chapterCount: number },
  ) {
    try {
      return await this.llm.chatJson<unknown>(messages, options);
    } catch (error) {
      if (!(error instanceof LlmJsonInvalidError)) throw error;
      this.logger.log('volume_outline_preview.json_parse_retry.started', {
        volumeNo: retryContext.volumeNo,
        chapterCount: retryContext.chapterCount,
        rawResponseLength: error.rawText.length,
        maxTokens: options.maxTokens ?? null,
        error: error.message,
      });
      return this.llm.chatJson<unknown>(
        this.buildJsonParseRetryMessages(messages, error, retryContext),
        {
          ...options,
          retries: 0,
          temperature: 0,
          jsonMode: true,
        },
      );
    }
  }

  private buildJsonParseRetryMessages(
    messages: LlmChatMessage[],
    error: LlmJsonInvalidError,
    retryContext: { volumeNo: number; chapterCount: number },
  ): LlmChatMessage[] {
    const system = messages.find((message) => message.role === 'system')?.content ?? this.buildSystemPrompt();
    const originalUser = messages.find((message) => message.role === 'user')?.content ?? '';
    const rawTail = this.truncateText(error.rawText.slice(-1500), 1500);
    return [
      {
        role: 'system',
        content: [
          system,
          'JSON parse retry contract: the previous answer was invalid or truncated. Regenerate the whole target volume outline from scratch as one complete closed JSON object.',
          'Do not continue the previous partial output. Do not include Markdown fences. Do not include chapters, chapter outlines, prose, or narrativePlan.storyUnits.',
          'Keep every Chinese string compact while preserving concrete goals, pressure, choices, costs, reversals, state changes, character plan, foreshadow plan, ending hook, and next-volume handoff.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Previous JSON parse failed for volume ${retryContext.volumeNo}, chapterCount ${retryContext.chapterCount}.`,
          `Parser error: ${error.message}`,
          `Previous invalid tail for diagnosis only; do not continue it: ${rawTail}`,
          'Regenerate a complete compact JSON object now. Output must parse with JSON.parse.',
          '',
          originalUser,
        ].join('\n'),
      },
    ];
  }

  private shouldRepairVolumeOutlineOutput(data: unknown, error: unknown): boolean {
    const message = this.errorMessage(error);
    const output = this.asRecord(data);
    const volume = this.asRecord(output.volume);
    const narrativePlan = this.asRecord(volume.narrativePlan);
    const characterPlan = this.asRecord(narrativePlan.characterPlan);
    const hasCharacterPlan = Object.keys(characterPlan).length > 0;
    const foreshadowPlan = narrativePlan.foreshadowPlan;
    if (/volume\.chapterCount 与目标章节数/.test(message)) return Object.keys(volume).length > 0;
    if (/未知既有角色|existingCharacterArcs/.test(message)) {
      return hasCharacterPlan && Array.isArray(characterPlan.existingCharacterArcs);
    }
    if (/newCharacterCandidates/.test(message)) {
      return hasCharacterPlan && Array.isArray(characterPlan.newCharacterCandidates);
    }
    if (/foreshadowPlan.*(appearRange|setupRange|recoverRange|recoveryRange|payoffRange|recoveryMethod|payoffMethod|缺失)/.test(message)) {
      return Array.isArray(foreshadowPlan) && foreshadowPlan.length > 0;
    }
    return false;
  }

  private buildRepairMessages(
    invalidOutput: unknown,
    validationError: string,
    volumeNo: number,
    chapterCount: number,
    characterCatalog: CharacterReferenceCatalog,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          '你是小说卷大纲 JSON 结构修复器。只输出严格 JSON，不要 Markdown、解释或代码块。',
          '只修复结构校验错误，尽量保留原有卷主线、支线、角色弧、伏笔和卷末交接；不要重写成新的卷大纲。',
          '不得输出占位角色、占位伏笔或模板化剧情；如果原始内容不足以修复，保持失败，不要编造低质量内容。',
          'existingCharacterArcs 只能引用既有角色白名单中的 name 或 aliases；未知人物若确实是本卷重要新人物，必须移入 newCharacterCandidates 并补齐候选字段。',
          'newCharacterCandidates 只能补齐已有候选的结构字段，不能扩大导入范围或把临时功能人物升级为重要角色。',
          'foreshadowPlan 只能补齐局部结构字段，例如 appearRange、recoverRange、recoveryMethod；补充内容必须基于原伏笔名称、出现章节和回收意图。',
          '修复后必须返回完整对象，只包含 volume 和 risks。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            targetVolumeNo: volumeNo,
            targetChapterCount: chapterCount,
            validationError,
            existingCharacterNames: characterCatalog.existingCharacterNames ?? [],
            existingCharacterAliases: characterCatalog.existingCharacterAliases ?? {},
            allowedNewCharacterRoleTypes: VOLUME_CHARACTER_ROLE_TYPES,
            invalidOutput,
            outputContract: {
              volume: {
                volumeNo,
                title: 'string',
                synopsis: 'structured markdown volume outline, preserve original content',
                objective: 'string',
                chapterCount,
                narrativePlan: {
                  globalMainlineStage: 'string',
                  volumeMainline: 'string',
                  dramaticQuestion: 'string',
                  startState: 'string',
                  endState: 'string',
                  mainlineMilestones: ['string'],
                  subStoryLines: 'preserve at least 2 rich sub story lines',
                  characterPlan: {
                    existingCharacterArcs: 'only known existing names or aliases',
                    newCharacterCandidates: 'complete candidate fields when important new characters are present',
                    relationshipArcs: 'participants must be known existing names or new candidate names',
                    roleCoverage: 'all referenced names must be known existing names or new candidate names',
                  },
                  foreshadowPlan: 'items need name, appearRange/setupRange, recoverRange/recoveryRange/payoffRange, recoveryMethod/payoffMethod',
                  endingHook: 'string',
                  handoffToNextVolume: 'string',
                },
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

  private normalize(data: unknown, volumeNo: number, chapterCount: number, characterCatalog: CharacterReferenceCatalog = {}): VolumeOutlinePreviewOutput {
    const output = this.asRecord(data);
    const volumeRecord = this.asRecord(output.volume);
    if (!Object.keys(volumeRecord).length) {
      throw new Error('generate_volume_outline_preview 返回缺少 volume，未生成完整卷大纲。');
    }
    const returnedVolumeNo = Number(volumeRecord.volumeNo);
    if (!Number.isInteger(returnedVolumeNo) || returnedVolumeNo !== volumeNo) {
      throw new Error(`generate_volume_outline_preview volume.volumeNo 与目标卷 ${volumeNo} 不匹配，未生成完整卷大纲。`);
    }
    const returnedChapterCount = Number(volumeRecord.chapterCount);
    if (!Number.isInteger(returnedChapterCount) || returnedChapterCount !== chapterCount) {
      throw new Error(`generate_volume_outline_preview volume.chapterCount 与目标章节数 ${chapterCount} 不匹配，未生成完整卷大纲。`);
    }
    const narrativePlan = assertVolumeNarrativePlan(volumeRecord.narrativePlan, {
      chapterCount,
      ...characterCatalog,
      label: 'volume.narrativePlan',
    });
    return {
      volume: {
        volumeNo,
        title: this.requiredText(volumeRecord.title, 'volume.title'),
        synopsis: this.requiredText(volumeRecord.synopsis, 'volume.synopsis'),
        objective: this.requiredText(volumeRecord.objective, 'volume.objective'),
        chapterCount,
        narrativePlan,
      },
      risks: this.stringArray(output.risks),
    };
  }

  private buildSystemPrompt(): string {
    return [
      `newCharacterCandidates.roleType 只能使用固定枚举：${VOLUME_CHARACTER_ROLE_TYPES.join(', ')}；不要自造 key_missing_family、antagonist_agent、mentor 等扩展值；具体叙事功能写入 narrativeFunction。`,
      '你是小说卷大纲设计 Agent。只输出严格 JSON，不要 Markdown、解释或代码块。',
      '本工具只生成 volume 卷大纲与 risks，不生成 chapters、chapter、正文或章节细纲。',
      '卷大纲必须先定盘整卷主线、卷内支线、伏笔分配、角色规划和卷末交接，供后续单元故事 Agent 承接。',
      '卷大纲还必须生成本卷角色规划 characterPlan：既有角色本卷弧线、重要新增角色候选、关系弧和角色功能覆盖。',
      'existingCharacterArcs 只能写上下文“既有角色白名单”中的角色名或别名；任何不在白名单中的人物，即使是本卷重要管事、反派、工匠、亲属或势力代理人，也必须写入 newCharacterCandidates，不能伪装成既有角色。',
      '遇到白名单外人物时，先判断它是否只是一次性功能角色，还是本卷需要承载登场、反派压力、人物情感、背景故事、支线推进或关系变化的重要新人物；重要新人物必须新增为 newCharacterCandidates。',
      '重要新增角色只能作为 narrativePlan.characterPlan.newCharacterCandidates 候选进入预览，不能在章节细纲里临时发明 supporting/protagonist/antagonist 等重要角色。',
      '角色扩充必须结构化返回：不要只在 synopsis、risks、subStoryLines 或自然语言说明里写“新增角色”；每个重要新增角色都必须进入 newCharacterCandidates[] 并补齐固定字段。',
      'newCharacterCandidates.name 可以被 subStoryLines.relatedCharacters、relationshipArcs.participants、roleCoverage 和后续单元故事引用，但不得同时出现在 existingCharacterArcs。',
      '角色内容失败即失败：不要生成占位角色、未命名角色或模板角色；如果缺上下文，把风险写入 risks，但仍必须返回完整合法 characterPlan。',
      '短卷输出体量控制：若 chapterCount 不超过 5，synopsis 每个 Markdown 小节写 1-2 句；mainlineMilestones 3-5 项；subStoryLines 2-3 条；foreshadowPlan 3-5 项；existingCharacterArcs 只写本卷关键既有角色；newCharacterCandidates 和 relationshipArcs 只写必要项。',
      'synopsis 必须写成结构化 Markdown 卷纲，至少包含：## 全书主线阶段、## 本卷主线、## 本卷戏剧问题、## 卷内支线、## 角色与势力功能、## 伏笔分配、## 支线交叉点、## 卷末交接。',
      '故事性要求：每条主线/支线都要有“欲望目标 -> 阻力升级 -> 选择代价 -> 阶段反转/回收 -> 状态变化”，不能只写功能标签。',
      '不要在本工具中生成 narrativePlan.storyUnits，也不要把单元故事固定为第几章到第几章；单元故事由后续 generate_story_units_preview 独立生成。',
      'subStoryLines 必须是真正会跨章节推进的支线：至少 2 条，每条要绑定角色、动机、推进节点、与主线交叉点和阶段结果。',
      'foreshadowPlan 必须分配具体伏笔、出现区间、回收区间和回收方式；每项优先写成 {"name":"伏笔名","appearRange":{"start":1,"end":2},"recoverRange":{"start":5,"end":6},"recoveryMethod":"回收方式"}；endingHook 必须能把本卷胜利代价交接到下一卷压力。',
      '输出字段只包含 volume、risks。',
      'volume 必须包含 volumeNo、title、synopsis、objective、chapterCount、narrativePlan。',
      'narrativePlan 必须包含 globalMainlineStage、volumeMainline、dramaticQuestion、startState、endState、mainlineMilestones、subStoryLines、foreshadowPlan、endingHook、handoffToNextVolume、characterPlan。',
      'subStoryLines 至少 2 条，写清 name、type、function、startState、progress、endState、relatedCharacters、chapterNodes。',
      'characterPlan 必须包含 existingCharacterArcs、newCharacterCandidates、relationshipArcs、roleCoverage。',
      'newCharacterCandidates 可为空；若有候选，每个候选必须包含 candidateId、name、roleType、scope=volume、narrativeFunction、personalityCore、motivation、firstAppearChapter、expectedArc、approvalStatus=candidate。',
      'firstAppearChapter 必须在 1 到 chapterCount 范围内；relationshipArcs.participants 只能引用既有角色名或 newCharacterCandidates.name。',
      '禁止空泛词堆叠；每条支线都必须绑定具体人物、行动、资源/线索/制度压力和阶段结果。',
      'JSON 骨架：{"volume":{"volumeNo":1,"title":"卷名","synopsis":"Markdown结构卷纲","objective":"可检验卷目标","chapterCount":60,"narrativePlan":{"globalMainlineStage":"全书主线阶段","volumeMainline":"本卷主线","dramaticQuestion":"本卷戏剧问题","startState":"开局状态","endState":"结尾状态","mainlineMilestones":["里程碑"],"subStoryLines":[{"name":"支线名","type":"mystery","function":"叙事作用","startState":"起点","progress":"推进方式","endState":"阶段结果","relatedCharacters":["角色名"],"chapterNodes":[1]}],"characterPlan":{"existingCharacterArcs":[{"characterName":"既有角色名","roleInVolume":"本卷角色功能","entryState":"入卷状态","volumeGoal":"本卷目标","pressure":"压力","keyChoices":["关键选择"],"firstActiveChapter":1,"endState":"出卷状态"}],"newCharacterCandidates":[{"candidateId":"v1_candidate_01","name":"候选角色名","roleType":"supporting","scope":"volume","narrativeFunction":"叙事功能","personalityCore":"性格核心","motivation":"动机","conflictWith":["既有角色名"],"relationshipAnchors":["既有角色名"],"firstAppearChapter":2,"expectedArc":"本卷弧线","approvalStatus":"candidate"}],"relationshipArcs":[{"participants":["既有角色名","候选角色名"],"startState":"关系起点","turnChapterNos":[2],"endState":"关系终点"}],"roleCoverage":{"mainlineDrivers":["角色名"],"antagonistPressure":["角色名"],"emotionalCounterweights":["角色名"],"expositionCarriers":["角色名"]}},"foreshadowPlan":[{"name":"伏笔名","appearRange":{"start":1,"end":2},"recoverRange":{"start":5,"end":6},"recoveryMethod":"回收方式"}],"endingHook":"卷末钩子","handoffToNextVolume":"下一卷交接"}},"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(args: GenerateVolumeOutlinePreviewInput, volumeNo: number, chapterCount: number): string {
    const context = this.asRecord(args.context);
    const project = this.asRecord(context.project);
    const volumes = Array.isArray(context.volumes) ? context.volumes.map((item) => this.asRecord(item)) : [];
    const targetVolume = volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
    const characters = Array.isArray(context.characters) ? context.characters.slice(0, 30) : [];
    const relationships = Array.isArray(context.relationships) ? context.relationships.slice(0, 60) : [];
    const characterStates = Array.isArray(context.characterStates) ? context.characterStates.slice(0, 60) : [];
    const lorebookEntries = Array.isArray(context.lorebookEntries) ? context.lorebookEntries.slice(0, 30) : [];
    const characterCatalog = this.extractCharacterCatalog(context);
    const existingCharacterNames = characterCatalog.existingCharacterNames ?? [];
    const existingCharacterAliases = characterCatalog.existingCharacterAliases ?? {};
    const existingCharacterWhitelist = existingCharacterNames.map((name) => ({
      name,
      aliases: existingCharacterAliases[name] ?? [],
    }));
    return [
      `用户目标：${args.instruction ?? '生成卷大纲'}`,
      `目标卷：第 ${volumeNo} 卷`,
      `全卷章节数：${chapterCount}`,
      chapterCount <= 5
        ? '短卷紧凑要求：这是 5 章以内短卷，请输出完整但克制的卷纲，避免长篇幅人物传记或逐章细纲；每个文本字段优先 1-3 句。'
        : '',
      '',
      '项目概览：',
      this.safeJson({ title: project.title, genre: project.genre, tone: project.tone, synopsis: project.synopsis, outline: project.outline }, 5000),
      '',
      '现有目标卷信息（只作定位和承接；若用户要求重写，应重新生成完整卷纲）：',
      this.safeJson({ volumeNo, title: targetVolume.title, synopsis: targetVolume.synopsis, objective: targetVolume.objective, chapterCount: targetVolume.chapterCount, narrativePlan: targetVolume.narrativePlan }, 4000),
      '',
      '已有角色摘要（名称、别名、scope、状态和关系锚点；优先规划既有角色，不要重复造人）：',
      this.safeJson(characters, 4000),
      '',
      '既有角色白名单（existingCharacterArcs.characterName 只能使用这些 name 或 aliases；未列入白名单且需要承担本卷功能的新人物，必须先作为 newCharacterCandidates 新增候选）：',
      this.safeJson(existingCharacterWhitelist, 2000),
      '',
      '既有关系边摘要（只能承接或推进这些关系；新增长期关系应先进入卷级 characterPlan.relationshipArcs）：',
      this.safeJson(relationships, 4000),
      '',
      '近期角色状态摘要（用于 entryState、volumeGoal 和关系弧起点；不要让状态凭空重置）：',
      this.safeJson(characterStates, 4000),
      '',
      '设定摘要：',
      this.safeJson(lorebookEntries, 4000),
      '',
      '请严格只返回 volume 和 risks；不要返回 chapters 或 chapter。',
    ].filter(Boolean).join('\n');
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.text(value);
    if (!text.trim()) throw new Error(`generate_volume_outline_preview 返回缺少 ${label}，未生成完整卷大纲。`);
    return text;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private positiveInt(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) {
      throw new Error(`generate_volume_outline_preview ${label} 必须是正整数。`);
    }
    return numeric;
  }

  private targetVolumeChapterCount(contextValue: unknown, volumeNo: number): number | undefined {
    const context = this.asRecord(contextValue);
    const volumes = Array.isArray(context.volumes) ? context.volumes.map((item) => this.asRecord(item)) : [];
    const targetVolume = volumes.find((item) => Number(item.volumeNo) === volumeNo);
    if (!targetVolume) return undefined;
    return this.positiveInt(targetVolume.chapterCount, 'context.volume.chapterCount');
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => this.text(item)).filter(Boolean) : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private safeJson(value: unknown, limit: number): string {
    const text = JSON.stringify(value ?? {}, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private truncateText(value: unknown, limit: number): string {
    const text = this.text(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private rawLlmResponseLog(value: unknown): Record<string, unknown> {
    const text = JSON.stringify(value ?? {}, null, 2);
    const record = this.asRecord(value);
    const volume = this.asRecord(record.volume);
    const narrativePlan = this.asRecord(volume.narrativePlan);
    const foreshadowPlan = narrativePlan.foreshadowPlan;
    return {
      length: JSON.stringify(value ?? {}).length,
      rawResponseText: text,
      topLevelKeys: Object.keys(record),
      volumeKeys: Object.keys(volume),
      narrativePlanKeys: Object.keys(narrativePlan),
      foreshadowPlanType: Array.isArray(foreshadowPlan) ? 'array' : typeof foreshadowPlan,
      foreshadowPlanLength: Array.isArray(foreshadowPlan) ? foreshadowPlan.length : undefined,
      foreshadowPlanText: JSON.stringify(foreshadowPlan ?? null, null, 2),
    };
  }

  private extractCharacterCatalog(contextValue: unknown): CharacterReferenceCatalog {
    const context = this.asRecord(contextValue);
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const existingCharacterNames: string[] = [];
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const item of characters) {
      const record = this.asRecord(item);
      const name = this.text(record.name);
      if (!name) continue;
      existingCharacterNames.push(name);
      const aliases = this.stringArray(record.aliases).length ? this.stringArray(record.aliases) : this.stringArray(record.alias);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }
    return { existingCharacterNames, existingCharacterAliases };
  }
}
