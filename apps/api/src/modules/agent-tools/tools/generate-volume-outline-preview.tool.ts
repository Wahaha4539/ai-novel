import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { VOLUME_CHARACTER_ROLE_TYPES, type CharacterReferenceCatalog } from './outline-character-contracts';
import { assertVolumeNarrativePlan } from './outline-narrative-contracts';

const VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

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
  description = '生成单独的卷大纲预览，包含 Volume.narrativePlan 和 storyUnits，不生成章节细纲。';
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
  executionTimeoutMs = VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成卷大纲预览',
    description: '先生成卷大纲、卷内支线和 narrativePlan.storyUnits；章节细纲必须承接该卷纲，不在每章里重新发明单元故事。',
    whenToUse: [
      '用户要求生成卷大纲、卷细纲、章节细纲或 60 章细纲时，先用本工具生成卷级规划',
      '后续 generate_chapter_outline_preview 需要承接稳定的 Volume.narrativePlan.storyUnits 时',
    ],
    whenNotToUse: [
      '用户只要求生成单章正文时使用 write_chapter',
      '用户只要求合并已生成章节细纲时使用 merge_chapter_outline_previews',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: '通常来自 inspect_project_context.output。' },
      instruction: { source: 'user_message', description: '保留用户对卷号、章节数、节奏、风格和结构的要求。' },
      volumeNo: { source: 'user_message', description: '目标卷号。' },
      chapterCount: { source: 'user_message', description: '目标全卷章节数；storyUnits 必须覆盖这个范围。' },
    },
    examples: [
      {
        user: '为第 1 卷生成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'characters', 'lorebook'] } },
          { tool: 'generate_volume_outline_preview', args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 60 } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterNo: 1, chapterCount: 60 } },
        ],
      },
    ],
    failureHints: [
      { code: 'LLM_TIMEOUT', meaning: '卷大纲 LLM 超时', suggestedRepair: '重试卷大纲步骤，或缩小卷范围。' },
      { code: 'INCOMPLETE_VOLUME_OUTLINE_PREVIEW', meaning: 'LLM 返回卷号、章节数或 narrativePlan.storyUnits 不完整', suggestedRepair: '重新生成完整卷纲，不要进入章节细纲。' },
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
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${volumeNo} 卷卷大纲`,
      timeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
    });
    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      { role: 'user' as const, content: this.buildUserPrompt(args, volumeNo, chapterCount) },
    ];
    const logContext = {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      volumeNo,
      chapterCount,
      timeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      maxTokensSent: null,
      maxTokensOmitted: true,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    this.logger.log('volume_outline_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<unknown>(
        messages,
        { appStep: 'planner', timeoutMs: VOLUME_OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true },
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
      const normalized = this.normalize(response.data, volumeNo, chapterCount, this.extractCharacterCatalog(args.context));
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
      '卷大纲必须先定盘整卷主线、卷内支线、单元故事 storyUnits、伏笔分配和卷末交接，供后续章节细纲承接。',
      '卷大纲还必须生成本卷角色规划 characterPlan：既有角色本卷弧线、重要新增角色候选、关系弧和角色功能覆盖。',
      '重要新增角色只能作为 narrativePlan.characterPlan.newCharacterCandidates 候选进入预览，不能在章节细纲里临时发明 supporting/protagonist/antagonist 等重要角色。',
      '角色内容失败即失败：不要生成占位角色、未命名角色或模板角色；如果缺上下文，把风险写入 risks，但仍必须返回完整合法 characterPlan。',
      'synopsis 必须写成结构化 Markdown 卷纲，至少包含：## 全书主线阶段、## 本卷主线、## 本卷戏剧问题、## 卷内支线、## 单元故事、## 支线交叉点、## 卷末交接。',
      '故事性要求：每条主线/支线/单元故事都要有“欲望目标 -> 阻力升级 -> 选择代价 -> 阶段反转/回收 -> 状态变化”，不能只写功能标签。',
      '单元故事是卷级规划，不是章节内临时生成；storyUnits 必须连续覆盖第 1 章到目标 chapterCount，不能缺章、重叠或跳号。',
      '每个 storyUnit 必须写清该单元的局部故事目标、核心阻力、关键人物关系变化、工程/制度/线索抓手、阶段 payoff 和单元结束后的局面变化。',
      'subStoryLines 必须是真正会跨章节推进的支线：至少 2 条，每条要绑定角色、动机、推进节点、与主线交叉点和阶段结果。',
      'foreshadowPlan 必须分配具体伏笔、出现区间、回收区间和回收方式；每项优先写成 {"name":"伏笔名","appearRange":{"start":1,"end":2},"recoverRange":{"start":5,"end":6},"recoveryMethod":"回收方式"}；endingHook 必须能把本卷胜利代价交接到下一卷压力。',
      '输出字段只包含 volume、risks。',
      'volume 必须包含 volumeNo、title、synopsis、objective、chapterCount、narrativePlan。',
      'narrativePlan 必须包含 globalMainlineStage、volumeMainline、dramaticQuestion、startState、endState、mainlineMilestones、subStoryLines、storyUnits、foreshadowPlan、endingHook、handoffToNextVolume、characterPlan。',
      'storyUnits 必须按 3-5 章一组规划完整单元故事；每个 storyUnit 包含 unitId、title、chapterRange、localGoal、localConflict、serviceFunctions、payoff、stateChangeAfterUnit。',
      'subStoryLines 至少 2 条，写清 name、type、function、startState、progress、endState、relatedCharacters、chapterNodes。',
      'characterPlan 必须包含 existingCharacterArcs、newCharacterCandidates、relationshipArcs、roleCoverage。',
      'newCharacterCandidates 可为空；若有候选，每个候选必须包含 candidateId、name、roleType、scope=volume、narrativeFunction、personalityCore、motivation、firstAppearChapter、expectedArc、approvalStatus=candidate。',
      'firstAppearChapter 必须在 1 到 chapterCount 范围内；relationshipArcs.participants 只能引用既有角色名或 newCharacterCandidates.name。',
      '禁止空泛词堆叠；每条支线和单元故事都必须绑定具体人物、行动、资源/线索/制度压力和阶段结果。',
      'JSON 骨架：{"volume":{"volumeNo":1,"title":"卷名","synopsis":"Markdown结构卷纲","objective":"可检验卷目标","chapterCount":60,"narrativePlan":{"globalMainlineStage":"全书主线阶段","volumeMainline":"本卷主线","dramaticQuestion":"本卷戏剧问题","startState":"开局状态","endState":"结尾状态","mainlineMilestones":["里程碑"],"subStoryLines":[{"name":"支线名","type":"mystery","function":"叙事作用","startState":"起点","progress":"推进方式","endState":"阶段结果","relatedCharacters":["角色名"],"chapterNodes":[1]}],"storyUnits":[{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"localGoal":"局部目标","localConflict":"局部阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"payoff":"阶段结局","stateChangeAfterUnit":"单元后状态"}],"characterPlan":{"existingCharacterArcs":[{"characterName":"既有角色名","roleInVolume":"本卷角色功能","entryState":"入卷状态","volumeGoal":"本卷目标","pressure":"压力","keyChoices":["关键选择"],"firstActiveChapter":1,"endState":"出卷状态"}],"newCharacterCandidates":[{"candidateId":"v1_candidate_01","name":"候选角色名","roleType":"supporting","scope":"volume","narrativeFunction":"叙事功能","personalityCore":"性格核心","motivation":"动机","conflictWith":["既有角色名"],"relationshipAnchors":["既有角色名"],"firstAppearChapter":2,"expectedArc":"本卷弧线","approvalStatus":"candidate"}],"relationshipArcs":[{"participants":["既有角色名","候选角色名"],"startState":"关系起点","turnChapterNos":[2],"endState":"关系终点"}],"roleCoverage":{"mainlineDrivers":["角色名"],"antagonistPressure":["角色名"],"emotionalCounterweights":["角色名"],"expositionCarriers":["角色名"]}},"foreshadowPlan":[{"name":"伏笔名","appearRange":{"start":1,"end":2},"recoverRange":{"start":5,"end":6},"recoveryMethod":"回收方式"}],"endingHook":"卷末钩子","handoffToNextVolume":"下一卷交接"}},"risks":[]}',
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
    return [
      `用户目标：${args.instruction ?? '生成卷大纲'}`,
      `目标卷：第 ${volumeNo} 卷`,
      `全卷章节数：${chapterCount}`,
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
    ].join('\n');
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.text(value);
    if (!text.trim()) throw new Error(`generate_volume_outline_preview 返回缺少 ${label}，未生成完整卷大纲。`);
    return text;
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
