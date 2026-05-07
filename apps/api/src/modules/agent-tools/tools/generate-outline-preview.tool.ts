import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const OUTLINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const OUTLINE_PREVIEW_BATCH_THRESHOLD = 15;
const OUTLINE_PREVIEW_BATCH_SIZE = 12;

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
  actionBeats?: string[];
  concreteClues?: Array<{
    name: string;
    sensoryDetail?: string;
    laterUse?: string;
  }>;
  dialogueSubtext?: string;
  characterShift?: string;
  irreversibleConsequence?: string;
  progressTypes?: string[];
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
    description: '生成 outline_preview：包含卷信息、章节细纲、每章 Chapter.craftBrief 执行卡和风险；当章节数超过 15 时自动按批次调用 LLM 并合并。',
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
      chapterCount: { source: 'user_message', description: '用户指定“60 章”等目标数量时填入；超过 15 章会自动分批，任一批 timeout 会直接失败。' },
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
      { code: 'LLM_TIMEOUT', meaning: '单批 LLM 未在内部 timeoutMs 内稳定返回', suggestedRepair: '重新执行或缩小章节范围；工具不会生成 fallback 章节。' },
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
    const response = await this.callOutlineLlm(args, volumeNo, chapterCount);
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
    const risks: string[] = [`已按 ${OUTLINE_PREVIEW_BATCH_SIZE} 章以内自动分批生成，共 ${batches.length} 批，避免单次 LLM 请求承载 ${chapterCount} 章。`];
    let volume: OutlinePreviewOutput['volume'] | undefined;
    for (const batch of batches) {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: `正在生成第 ${batch.startChapterNo}-${batch.endChapterNo} 章细纲`,
        progressCurrent: batch.batchIndex,
        progressTotal: batch.batchCount,
        timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      });
      const response = await this.callOutlineLlm(args, volumeNo, chapterCount, batch, chapters);
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
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验批次合并后的章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
    return this.finalizeBatchedPreview(volume, chapters, risks, volumeNo, chapterCount);
  }

  private prefixBatchRisk(batch: OutlinePreviewBatch, risk: string): string {
    const rangeLabel = `第 ${batch.startChapterNo}-${batch.endChapterNo} 章`;
    return risk.includes(rangeLabel) ? risk : `${rangeLabel}批次：${risk}`;
  }

  private async callOutlineLlm(
    args: GenerateOutlinePreviewInput,
    volumeNo: number,
    chapterCount: number,
    batch?: OutlinePreviewBatch,
    previousChapters: OutlinePreviewOutput['chapters'] = [],
  ) {
    return this.llm.chatJson<OutlinePreviewOutput>(
      [
        { role: 'system', content: this.buildSystemPrompt() },
        { role: 'user', content: this.buildUserPrompt(args, volumeNo, chapterCount, batch, previousChapters) },
      ],
      { appStep: 'planner', maxTokens: this.estimateMaxTokens(batch?.chapterCount ?? chapterCount), timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: 0 },
    );
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
      throw new Error(`generate_outline_preview 批次合并章节数为 ${chapters.length}/${chapterCount}，未生成完整细纲。`);
    }
    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo)).filter((chapterNo) => Number.isFinite(chapterNo));
    if (new Set(chapterNos).size !== chapterNos.length) {
      throw new Error('generate_outline_preview 批次合并发现重复章节编号，未生成完整细纲。');
    }
    if (chapterNos.length !== chapterCount || chapterNos.some((chapterNo, index) => chapterNo !== index + 1)) {
      throw new Error('generate_outline_preview 批次合并发现章节编号不连续，未生成完整细纲。');
    }
    if (chapters.some((chapter) => Number(chapter.volumeNo) !== volumeNo)) {
      throw new Error(`generate_outline_preview 批次合并发现 volumeNo 与目标卷 ${volumeNo} 不一致，未生成完整细纲。`);
    }
    if (chapters.some((chapter) => !chapter.craftBrief || !chapter.craftBrief.visibleGoal || !chapter.craftBrief.coreConflict)) {
      throw new Error('generate_outline_preview 批次合并发现部分章节 craftBrief 不完整，未生成完整细纲。');
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
        sensoryDetail: this.text(item.sensoryDetail, ''),
        laterUse: this.text(item.laterUse, ''),
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
    return {
      visibleGoal: this.requiredText(record.visibleGoal, `${label}.craftBrief.visibleGoal`),
      hiddenEmotion: this.requiredText(record.hiddenEmotion, `${label}.craftBrief.hiddenEmotion`),
      coreConflict: this.requiredText(record.coreConflict, `${label}.craftBrief.coreConflict`),
      mainlineTask: this.requiredText(record.mainlineTask, `${label}.craftBrief.mainlineTask`),
      subplotTasks,
      actionBeats,
      concreteClues: clues,
      dialogueSubtext: this.requiredText(record.dialogueSubtext, `${label}.craftBrief.dialogueSubtext`),
      characterShift: this.requiredText(record.characterShift, `${label}.craftBrief.characterShift`),
      irreversibleConsequence: this.requiredText(record.irreversibleConsequence, `${label}.craftBrief.irreversibleConsequence`),
      progressTypes,
    };
  }

  private requiredStringArray(value: unknown, label: string): string[] {
    const items = this.stringArray(value, []);
    if (!items.length) {
      throw new Error(`generate_outline_preview 返回缺少 ${label}，未生成完整细纲。`);
    }
    return items;
  }

  private buildSystemPrompt(): string {
    return [
      '你是小说章节细纲设计 Agent。只输出严格 JSON，不要 Markdown、解释或代码块。',
      '本工具生成的是卷/章节细纲与章级执行卡，不是正文，不要写正文段落。',
      '输出字段必须包含 volume、chapters、risks；每章必须包含 chapterNo、volumeNo、title、objective、conflict、hook、outline、expectedWordCount、craftBrief。',
      '',
      '高密度章节细纲规则：',
      '- 每章至少领取 1 个本卷主线任务，并至少推进 1 条卷内支线。',
      '- objective 必须具体可检验，不能只写“推进主线”“调查线索”。',
      '- conflict 必须写清阻力来源和阻力方式。',
      '- outline 必须包含具体场景、关键行动、阶段结果，不要写泛泛剧情摘要。',
      '- craftBrief 必填，必须包含 visibleGoal、hiddenEmotion、coreConflict、mainlineTask、subplotTasks、actionBeats、concreteClues、dialogueSubtext、characterShift、irreversibleConsequence、progressTypes。',
      '- craftBrief.actionBeats 至少 3 个节点，形成“起手行动 -> 正面受阻 -> 阶段结果”的行动链。',
      '- craftBrief.concreteClues 至少 1 个具象线索或物证，写清 name，可补 sensoryDetail 和 laterUse。',
      '- craftBrief.irreversibleConsequence 必须具体，且改变事实、关系、资源、地位、规则或危险等级之一。',
      '- 每 3-4 章至少出现一次信息揭示、关系反转、资源得失、地位变化或规则升级。',
      '- 卷末章节必须收束本卷主线，并留下下一卷或下一阶段交接。',
      '',
      'JSON 输出示例骨架：',
      '{"volume":{"volumeNo":1,"title":"卷名","synopsis":"卷概要","objective":"可检验卷目标","chapterCount":10,"narrativePlan":{}},"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章可检验目标","conflict":"阻力来源与方式","hook":"章末钩子","outline":"具体场景、关键行动、阶段结果","expectedWordCount":2500,"craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"actionBeats":["行动1","行动2","行动3"],"concreteClues":[{"name":"线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"]}}],"risks":[]}',
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
    const existingChapters = Array.isArray(record.existingChapters) ? record.existingChapters.slice(0, 160) : [];
    const characters = Array.isArray(record.characters) ? record.characters.slice(0, 30) : [];
    const lorebookEntries = Array.isArray(record.lorebookEntries) ? record.lorebookEntries.slice(0, 30) : [];
    const rangeStart = batch?.startChapterNo ?? 1;
    const rangeEnd = batch?.endChapterNo ?? chapterCount;
    const requestChapterCount = batch?.chapterCount ?? chapterCount;
    const generatedSummary = previousChapters.slice(-12).map((chapter) => ({
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      objective: chapter.objective,
      hook: chapter.hook,
      consequence: chapter.craftBrief?.irreversibleConsequence,
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
      '',
      '本次运行已生成章节短表（保持连续性，避免重复）：',
      this.safeJson(generatedSummary, 4000),
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

  private estimateMaxTokens(chapterCount: number): number {
    return Math.min(16_000, Math.max(4000, chapterCount * 620 + 1800));
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
