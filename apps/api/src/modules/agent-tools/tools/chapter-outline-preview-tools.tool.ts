import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { ChapterContinuityState, ChapterCraftBrief, ChapterSceneBeat, ChapterStoryUnit, OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

interface GenerateChapterOutlinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterNo?: number;
  chapterCount?: number;
  previousChapter?: Record<string, unknown>;
}

interface MergeChapterOutlinePreviewsInput {
  previews?: unknown[];
  volumeNo?: number;
  chapterCount?: number;
  instruction?: string;
}

export interface ChapterOutlinePreviewOutput {
  volume: OutlinePreviewOutput['volume'];
  chapter: OutlinePreviewOutput['chapters'][number];
  chapters: OutlinePreviewOutput['chapters'];
  risks: string[];
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
  executionTimeoutMs = CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '生成单章细纲与执行卡预览',
    description: '为指定 chapterNo 生成单章章节细纲、storyUnit 和 Chapter.craftBrief；用于把 60 章细纲在 Agent Plan 中展开为每章一个可见 Tool 调用。',
    whenToUse: [
      'Agent 需要为卷细纲、章节细纲、60 章细纲逐章生成可见步骤时',
      '上一章细纲已经生成，需要用 previousChapter 接力卡生成下一章时',
      '只需要生成某一个 chapterNo 的章节细纲和 craftBrief，不写正文时',
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
      chapterNo: { source: 'user_message', description: '本次生成的全卷绝对章号。' },
      chapterCount: { source: 'user_message', description: '目标全卷总章节数，用于 volume.chapterCount 和单元故事范围。' },
      previousChapter: { source: 'previous_step', description: '上一章 generate_chapter_outline_preview.output.chapter，用于接力连续性。' },
    },
    examples: [
      {
        user: '为第一卷生成 60 章细纲。',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'chapters', 'characters', 'lorebook'] } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 1, chapterCount: 60, instruction: '{{context.userMessage}}' } },
          { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 2, chapterCount: 60, previousChapter: '{{steps.2.output.chapter}}', instruction: '{{context.userMessage}}' } },
          { tool: 'merge_chapter_outline_previews', args: { previews: ['{{steps.2.output}}', '{{steps.3.output}}'], volumeNo: 1, chapterCount: 60 } },
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

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `正在生成第 ${chapterNo} 章细纲`,
      progressCurrent: chapterNo,
      progressTotal: chapterCount,
      timeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
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
      maxTokensSent: null,
      maxTokensOmitted: true,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    this.logger.log('chapter_outline_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<unknown>(
        messages,
        { appStep: 'planner', timeoutMs: CHAPTER_OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      const normalized = this.normalize(response.data, volumeNo, chapterNo, chapterCount);
      this.logger.log('chapter_outline_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
      });
      return normalized;
    } catch (error) {
      this.logger.error('chapter_outline_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private normalize(data: unknown, volumeNo: number, chapterNo: number, chapterCount: number): ChapterOutlinePreviewOutput {
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
    const volumeRecord = this.asRecord(output.volume);
    const returnedVolumeChapterCount = Number(volumeRecord.chapterCount);
    if (!Number.isInteger(Number(volumeRecord.volumeNo)) || Number(volumeRecord.volumeNo) !== volumeNo) {
      throw new Error(`generate_chapter_outline_preview volume.volumeNo 与目标卷 ${volumeNo} 不匹配，未生成完整单章细纲。`);
    }
    if (!Number.isInteger(returnedVolumeChapterCount) || returnedVolumeChapterCount !== chapterCount) {
      throw new Error(`generate_chapter_outline_preview volume.chapterCount 与目标章节数 ${chapterCount} 不匹配，未生成完整单章细纲。`);
    }
    const narrativePlan = this.asRecord(volumeRecord.narrativePlan);
    const chapter = {
      chapterNo,
      volumeNo,
      title: this.requiredText(chapterRecord.title, `第 ${chapterNo} 章 title`),
      objective: this.requiredText(chapterRecord.objective, `第 ${chapterNo} 章 objective`),
      conflict: this.requiredText(chapterRecord.conflict, `第 ${chapterNo} 章 conflict`),
      hook: this.requiredText(chapterRecord.hook, `第 ${chapterNo} 章 hook`),
      outline: this.requiredText(chapterRecord.outline, `第 ${chapterNo} 章 outline`),
      expectedWordCount,
      craftBrief: this.normalizeCraftBrief(chapterRecord.craftBrief, `第 ${chapterNo} 章`),
    };
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
      'chapterNo 必须使用用户指定的全卷绝对章号；volume.chapterCount 必须等于目标全卷章节数。',
      '每章必须包含 chapterNo、volumeNo、title、objective、conflict、hook、outline、expectedWordCount、craftBrief。',
      'outline 必须写成 3-5 个连续场景段，包含具体地点、人物、可见动作、阻力、转折和阶段结果。',
      'craftBrief 必须包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、storyUnit、actionBeats、sceneBeats、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes、entryState、exitState、openLoops、closedLoops、handoffToNextChapter、continuityState。',
      'craftBrief.actionBeats 至少 3 个节点；sceneBeats 至少 3 个场景段；concreteClues 至少 1 个且包含 name、sensoryDetail、laterUse。',
      'craftBrief.storyUnit 必须包含 unitId、title、chapterRange、chapterRole、localGoal、localConflict、serviceFunctions、mainlineContribution、characterContribution、relationshipContribution、worldOrThemeContribution、unitPayoff、stateChangeAfterUnit；serviceFunctions 至少 3 项。',
      'craftBrief.continuityState 必须包含角色位置、仍在生效的威胁、已持有线索/资源、关系变化和 nextImmediatePressure。',
      '如果提供 previousChapter，必须承接 previousChapter.craftBrief.exitState、handoffToNextChapter、openLoops、continuityState.nextImmediatePressure；不能让压力凭空消失。',
      '禁止只写推进、建立、完成、探索、揭示、面对、选择、升级、铺垫、承接等抽象词；必须绑定具体地点、人物、动作、物件和后果。',
      'JSON 骨架：{"volume":{"volumeNo":1,"title":"卷名","synopsis":"卷概要","objective":"卷目标","chapterCount":60,"narrativePlan":{"storyUnits":[]}},"chapter":{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章可检验目标","conflict":"阻力来源与方式","hook":"章末交接钩子","outline":"1. 场景段...\\n2. 场景段...\\n3. 场景段...","expectedWordCount":2500,"craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"主线任务","subplotTasks":["支线任务"],"storyUnit":{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"chapterRole":"开局/升级/反转/收束","localGoal":"单元目标","localConflict":"单元阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"主线贡献","characterContribution":"人物贡献","relationshipContribution":"关系贡献","worldOrThemeContribution":"世界或主题贡献","unitPayoff":"单元回收","stateChangeAfterUnit":"单元后状态"},"actionBeats":["行动1","行动2","行动3"],"sceneBeats":[{"sceneArcId":"arc","scenePart":"1/3","continuesFromChapterNo":null,"continuesToChapterNo":null,"location":"地点","participants":["角色"],"localGoal":"场景目标","visibleAction":"可见动作","obstacle":"阻力","turningPoint":"转折","partResult":"结果","sensoryAnchor":"感官锚点"}],"concreteClues":[{"name":"线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"],"entryState":"入场状态","exitState":"离场状态","openLoops":["未解决问题"],"closedLoops":["阶段性解决问题"],"handoffToNextChapter":"下一章交接","continuityState":{"characterPositions":["位置"],"activeThreats":["威胁"],"ownedClues":["线索"],"relationshipChanges":["关系变化"],"nextImmediatePressure":"下一章压力"}}},"risks":[]}',
    ].join('\n');
  }

  private buildUserPrompt(args: GenerateChapterOutlinePreviewInput, volumeNo: number, chapterNo: number, chapterCount: number): string {
    const context = this.asRecord(args.context);
    const project = this.asRecord(context.project);
    const volumes = Array.isArray(context.volumes) ? context.volumes.map((item) => this.asRecord(item)) : [];
    const targetVolume = volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
    return [
      `用户目标：${args.instruction ?? '生成单章章节细纲'}`,
      `目标卷：第 ${volumeNo} 卷`,
      `目标章：第 ${chapterNo} 章`,
      `全卷章节数：${chapterCount}`,
      '',
      '项目概览：',
      this.safeJson({ title: project.title, genre: project.genre, tone: project.tone, synopsis: project.synopsis, outline: project.outline }, 3000),
      '',
      '目标卷纲：',
      this.safeJson({ volumeNo, title: targetVolume.title, synopsis: targetVolume.synopsis, objective: targetVolume.objective, narrativePlan: targetVolume.narrativePlan }, 4000),
      '',
      '已有章节摘要：',
      this.safeJson(Array.isArray(context.existingChapters) ? context.existingChapters.slice(0, 160) : [], 6000),
      '',
      '上一章接力卡：',
      this.safeJson(args.previousChapter ?? { previousChapterNo: null, note: '这是本次计划的首章或未提供上一章；从项目和卷上下文开篇。' }, 3000),
      '',
      '角色摘要：',
      this.safeJson(Array.isArray(context.characters) ? context.characters.slice(0, 30) : [], 4000),
      '',
      '设定摘要：',
      this.safeJson(Array.isArray(context.lorebookEntries) ? context.lorebookEntries.slice(0, 30) : [], 4000),
      '',
      `请严格只返回第 ${chapterNo} 章，不要输出章节数组；chapterNo 必须是 ${chapterNo}，volumeNo 必须是 ${volumeNo}，volume.chapterCount 必须是 ${chapterCount}。`,
      '若上下文不足，把风险写入 risks，但仍输出完整单章细纲和 craftBrief。',
    ].join('\n');
  }

  private normalizeCraftBrief(value: unknown, label: string): ChapterCraftBrief {
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
    return {
      visibleGoal: this.requiredText(record.visibleGoal, `${label}.craftBrief.visibleGoal`),
      hiddenEmotion: this.requiredText(record.hiddenEmotion, `${label}.craftBrief.hiddenEmotion`),
      coreConflict: this.requiredText(record.coreConflict, `${label}.craftBrief.coreConflict`),
      mainlineTask: this.requiredText(record.mainlineTask, `${label}.craftBrief.mainlineTask`),
      subplotTasks,
      storyUnit: this.normalizeStoryUnit(record.storyUnit, label),
      actionBeats,
      sceneBeats: this.normalizeSceneBeats(record.sceneBeats, label),
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
    };
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
}

@Injectable()
export class MergeChapterOutlinePreviewsTool implements BaseTool<MergeChapterOutlinePreviewsInput, OutlinePreviewOutput> {
  name = 'merge_chapter_outline_previews';
  description = '合并多个单章细纲预览为完整 outline_preview，供 validate_outline 和 persist_outline 使用。';
  inputSchema = {
    type: 'object' as const,
    required: ['previews', 'chapterCount'],
    properties: {
      previews: { type: 'array' as const, items: { type: 'object' as const }, minItems: 1 },
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
    whenToUse: ['多个 generate_chapter_outline_preview 步骤完成后，需要合并为 validate_outline 可读取的完整大纲预览'],
    whenNotToUse: ['只有一个整卷 generate_outline_preview 输出时无需使用'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      previews: { source: 'previous_step', description: '所有单章预览输出数组，例如 ["{{steps.2.output}}","{{steps.3.output}}"]。' },
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
    this.assertMergedChapters(chapters, volumeNo, chapterCount);
    const baseVolume = normalized[0].volume;
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

  private assertMergedChapters(chapters: OutlinePreviewOutput['chapters'], volumeNo: number, chapterCount: number): void {
    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo));
    if (chapterNos.length !== chapterCount) throw new Error(`merge_chapter_outline_previews 章节数为 ${chapterNos.length}/${chapterCount}，未合并完整细纲。`);
    if (new Set(chapterNos).size !== chapterNos.length) throw new Error('merge_chapter_outline_previews 发现重复章节编号，未合并完整细纲。');
    if (chapterNos.some((chapterNo, index) => !Number.isInteger(chapterNo) || chapterNo !== index + 1)) {
      throw new Error('merge_chapter_outline_previews 发现章节编号不连续，未合并完整细纲。');
    }
    if (chapters.some((chapter) => Number(chapter.volumeNo) !== volumeNo)) {
      throw new Error(`merge_chapter_outline_previews 发现 volumeNo 与目标卷 ${volumeNo} 不一致，未合并完整细纲。`);
    }
    if (chapters.some((chapter) => !chapter.craftBrief || !chapter.craftBrief.visibleGoal || !chapter.craftBrief.coreConflict || !chapter.craftBrief.storyUnit?.unitId)) {
      throw new Error('merge_chapter_outline_previews 发现部分章节 craftBrief 不完整，未合并完整细纲。');
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
}
