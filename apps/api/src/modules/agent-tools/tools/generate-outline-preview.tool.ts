import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const OUTLINE_PREVIEW_LLM_TIMEOUT_MS = 90_000;
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
 * 大纲预览生成工具：优先请求 LLM 输出结构化 JSON。
 * LLM 超时或失败时降级为确定性章节骨架，保证 Plan 阶段不中断；输出仅作为预览传给后续审批，不直接写正式业务表。
 */
@Injectable()
export class GenerateOutlinePreviewTool implements BaseTool<GenerateOutlinePreviewInput, OutlinePreviewOutput> {
  name = 'generate_outline_preview';
  description = '根据项目上下文和用户目标生成卷/章节大纲预览，不写入正式业务表。';
  inputSchema = { type: 'object' as const, properties: { context: { type: 'object' as const }, instruction: { type: 'string' as const }, volumeNo: { type: 'number' as const }, chapterCount: { type: 'number' as const } } };
  outputSchema = { type: 'object' as const, required: ['volume', 'chapters', 'risks'], properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const, items: { type: 'string' as const } } } };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = 500_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateOutlinePreviewInput, context: ToolContext): Promise<OutlinePreviewOutput> {
    const volumeNo = args.volumeNo ?? 1;
    const chapterCount = Math.min(80, Math.max(1, args.chapterCount ?? 10));
    const batches = this.createBatches(chapterCount);
    if (batches.length > 1) return this.runBatched(args, context, volumeNo, chapterCount, batches);
    return this.runSingleBatch(args, context, volumeNo, chapterCount);
  }

  private async runSingleBatch(args: GenerateOutlinePreviewInput, context: ToolContext, volumeNo: number, chapterCount: number): Promise<OutlinePreviewOutput> {
    try {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: '正在生成卷章节预览',
        timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      });
      const response = await this.callOutlineLlm(args, volumeNo, chapterCount);
      recordToolLlmUsage(context, 'planner', response.result);
      await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
      return this.normalize(response.data, volumeNo, chapterCount, args);
    } catch (error) {
      await context.updateProgress?.({ phase: 'fallback_generating', phaseMessage: '模型未稳定返回，正在生成确定性章节骨架', progressCurrent: 0, progressTotal: chapterCount });
      return this.fallback(args, volumeNo, chapterCount, error);
    }
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
    try {
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
        const normalized = this.normalize(response.data, volumeNo, batch.chapterCount, args, {
          chapterStart: batch.startChapterNo,
          totalChapterCount: chapterCount,
        });
        volume ??= normalized.volume;
        chapters.push(...normalized.chapters);
        risks.push(...normalized.risks.map((risk) => `第 ${batch.startChapterNo}-${batch.endChapterNo} 章批次：${risk}`));
        await context.heartbeat?.({
          phase: 'merging_preview',
          phaseMessage: `已合并 ${chapters.length}/${chapterCount} 章细纲`,
          progressCurrent: batch.batchIndex,
          progressTotal: batch.batchCount,
        });
      }
      await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验批次合并后的章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
      return this.finalizeBatchedPreview(volume, chapters, risks, args, volumeNo, chapterCount);
    } catch (error) {
      await context.updateProgress?.({ phase: 'fallback_generating', phaseMessage: '模型批次返回不稳定，正在生成确定性章节骨架', progressCurrent: chapters.length, progressTotal: chapterCount });
      return this.fallback(args, volumeNo, chapterCount, error);
    }
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
    args: GenerateOutlinePreviewInput,
    options: { chapterStart?: number; totalChapterCount?: number } = {},
  ): OutlinePreviewOutput {
    const seed = this.createFallbackSeed(args.context, args.instruction, volumeNo);
    const chapterStart = options.chapterStart ?? 1;
    const totalChapterCount = options.totalChapterCount ?? chapterCount;
    const returnedCount = Array.isArray(data.chapters) ? Math.min(data.chapters.length, chapterCount) : 0;
    const chapters: OutlinePreviewOutput['chapters'] = (data.chapters ?? []).slice(0, chapterCount).map((item, index) => {
      const chapterNo = chapterStart + index;
      const chapter = {
        chapterNo,
        volumeNo: Number(item.volumeNo) || volumeNo,
        title: this.text(item.title, `第 ${chapterNo} 章`),
        objective: this.text(item.objective, '推进主线目标'),
        conflict: this.text(item.conflict, '制造角色选择压力'),
        hook: this.text(item.hook, '留下下一章悬念'),
        outline: this.text(item.outline, this.text(item.objective, '待扩写')),
        expectedWordCount: Number(item.expectedWordCount) || 2500,
      };
      return { ...chapter, craftBrief: this.normalizeCraftBrief(item.craftBrief, chapter, chapterNo - 1, totalChapterCount, seed) };
    });
    while (chapters.length < chapterCount) {
      chapters.push(this.createFallbackChapter(chapterStart + chapters.length - 1, totalChapterCount, seed));
    }
    const risks = [
      ...(data.risks ?? []),
      ...(chapters.length > returnedCount ? ['LLM 返回章节数少于目标章节数，已用确定性章节骨架补齐缺口；请在审批前重点复核补齐章节。'] : []),
    ];
    const narrativePlan = this.asRecord(data.volume?.narrativePlan);
    return {
      volume: {
        volumeNo,
        title: this.text(data.volume?.title, seed.volumeTitle),
        synopsis: this.text(data.volume?.synopsis, seed.synopsis),
        objective: this.text(data.volume?.objective, seed.objective),
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
    args: GenerateOutlinePreviewInput,
    volumeNo: number,
    chapterCount: number,
  ): OutlinePreviewOutput {
    const seed = this.createFallbackSeed(args.context, args.instruction, volumeNo);
    const normalizedChapters: OutlinePreviewOutput['chapters'] = chapters.slice(0, chapterCount).map((chapter, index) => ({ ...chapter, chapterNo: index + 1, volumeNo }));
    while (normalizedChapters.length < chapterCount) {
      normalizedChapters.push({ ...this.createFallbackChapter(normalizedChapters.length, chapterCount, seed), volumeNo });
    }
    return {
      volume: {
        volumeNo,
        title: this.text(volume?.title, seed.volumeTitle),
        synopsis: this.text(volume?.synopsis, seed.synopsis),
        objective: this.text(volume?.objective, seed.objective),
        chapterCount,
        ...(volume?.narrativePlan ? { narrativePlan: volume.narrativePlan } : {}),
      },
      chapters: normalizedChapters,
      risks,
    };
  }

  /** 将 LLM 可能返回的非字符串字段收敛为字符串，避免后续 Tool 对 trim 等字符串方法崩溃。 */
  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }

  private fallback(args: GenerateOutlinePreviewInput, volumeNo: number, chapterCount: number, error: unknown): OutlinePreviewOutput {
    const seed = this.createFallbackSeed(args.context, args.instruction, volumeNo);
    return {
      volume: {
        volumeNo,
        title: seed.volumeTitle,
        synopsis: seed.synopsis,
        objective: seed.objective,
        chapterCount,
      },
      chapters: Array.from({ length: chapterCount }, (_item, index) => this.createFallbackChapter(index, chapterCount, seed)),
      risks: [
        `${this.isLlmTimeout(error) ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_FALLBACK'}：LLM 大纲预览未在 ${OUTLINE_PREVIEW_LLM_TIMEOUT_MS / 1000}s 内稳定返回，已使用确定性章节骨架保证计划不中断。`,
        `降级原因：${this.text(error instanceof Error ? error.message : String(error), '未知错误').slice(0, 160)}`,
        'fallback 已为每章生成基础 craftBrief，但这些执行卡只用于占位和审批起点，需人工复核行动链、线索和不可逆后果。',
        '确定性骨架适合先进入审批和人工调整；建议重点复核章节标题、关键反转和卷内高潮位置。',
      ],
    };
  }

  private createFallbackSeed(context: unknown, instruction: string | undefined, volumeNo: number) {
    const record = this.asRecord(context);
    const project = this.asRecord(record.project);
    const volumes = Array.isArray(record.volumes) ? record.volumes.map((item) => this.asRecord(item)) : [];
    const volume = volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
    const projectTitle = this.text(project.title, '当前项目');
    const volumeTitle = this.text(volume.title, `第 ${volumeNo} 卷`);
    const objective = this.text(volume.objective, this.text(instruction, this.text(project.outline, '推进卷内主线并形成阶段性胜利')));
    const synopsis = this.text(volume.synopsis, this.text(project.synopsis, objective).slice(0, 240));
    return { projectTitle, volumeTitle, objective, synopsis, instruction: instruction ?? '', volumeNo };
  }

  private createFallbackChapter(index: number, chapterCount: number, seed: ReturnType<GenerateOutlinePreviewTool['createFallbackSeed']>): OutlinePreviewOutput['chapters'][number] {
    const chapterNo = index + 1;
    const phases = [
      { title: '压力入场', objective: '抛出核心危机与行动目标', conflict: '资源、时间和信任同时收紧', hook: '新的风险逼近' },
      { title: '规则成形', objective: '建立解决问题的临时规则', conflict: '旧秩序与新方案发生碰撞', hook: '规则出现代价' },
      { title: '试错破局', objective: '通过行动验证关键方案', conflict: '方案被现实条件反复撕扯', hook: '隐藏阻力浮出水面' },
      { title: '联盟拉扯', objective: '让更多角色卷入共同承担', conflict: '利益分配与旧怨制造裂缝', hook: '盟友立场动摇' },
      { title: '代价揭示', objective: '揭开阶段真相并放大牺牲', conflict: '胜利路径要求付出不可逆代价', hook: '更大的危机压来' },
      { title: '阶段胜利', objective: '完成卷内目标并留下下一阶段入口', conflict: '胜利与新的责任同时到来', hook: '下一卷矛盾开启' },
    ];
    const phase = phases[Math.min(phases.length - 1, Math.floor(index * phases.length / Math.max(1, chapterCount)))];
    const progress = `${chapterNo}/${chapterCount}`;
    const chapter = {
      chapterNo,
      volumeNo: seed.volumeNo,
      title: `第 ${chapterNo} 章：${phase.title}`,
      objective: `${phase.objective}，服务《${seed.projectTitle}》${seed.volumeTitle}目标：${seed.objective}`,
      conflict: `${phase.conflict}，主角团队必须在生存、连接与责任之间做选择。`,
      hook: `${phase.hook}，把矛盾推进到第 ${Math.min(chapterNo + 1, chapterCount)} 章。`,
      outline: `卷内进度 ${progress}。本章围绕“${seed.objective}”推进：先承接上一章压力，再安排一次具体行动或谈判，让方案获得新证据，同时暴露新的成本，为后续章节继续升级冲突。`,
      expectedWordCount: 2500,
    };
    return { ...chapter, craftBrief: this.createFallbackCraftBrief(chapter, index, chapterCount, seed) };
  }

  private normalizeCraftBrief(
    value: unknown,
    chapter: Pick<OutlinePreviewOutput['chapters'][number], 'chapterNo' | 'title' | 'objective' | 'conflict' | 'outline'>,
    index: number,
    chapterCount: number,
    seed: ReturnType<GenerateOutlinePreviewTool['createFallbackSeed']>,
  ): ChapterCraftBrief {
    const fallback = this.createFallbackCraftBrief(chapter, index, chapterCount, seed);
    const record = this.asRecord(value);
    if (!Object.keys(record).length) return fallback;
    const clues = this.asRecordArray(record.concreteClues)
      .map((item, clueIndex) => ({
        name: this.text(item.name, fallback.concreteClues?.[clueIndex]?.name ?? '待复核线索'),
        sensoryDetail: this.text(item.sensoryDetail, fallback.concreteClues?.[clueIndex]?.sensoryDetail ?? ''),
        laterUse: this.text(item.laterUse, fallback.concreteClues?.[clueIndex]?.laterUse ?? ''),
      }))
      .filter((item) => item.name.trim());
    const actionBeats = this.stringArray(record.actionBeats, []);
    return {
      visibleGoal: this.text(record.visibleGoal, fallback.visibleGoal ?? chapter.objective),
      hiddenEmotion: this.text(record.hiddenEmotion, fallback.hiddenEmotion ?? '角色在行动中暴露真实担忧。'),
      coreConflict: this.text(record.coreConflict, fallback.coreConflict ?? chapter.conflict),
      mainlineTask: this.text(record.mainlineTask, fallback.mainlineTask ?? seed.objective),
      subplotTasks: this.stringArray(record.subplotTasks, fallback.subplotTasks ?? []),
      actionBeats: (actionBeats.length >= 3 ? actionBeats : [...actionBeats, ...(fallback.actionBeats ?? [])]).slice(0, 8),
      concreteClues: clues.length ? clues : fallback.concreteClues,
      dialogueSubtext: this.text(record.dialogueSubtext, fallback.dialogueSubtext ?? '对话表面推进信息，实际试探立场和隐瞒代价。'),
      characterShift: this.text(record.characterShift, fallback.characterShift ?? '角色从被动承受转向主动选择。'),
      irreversibleConsequence: this.text(record.irreversibleConsequence, fallback.irreversibleConsequence ?? '本章结尾改变资源、关系或危险等级。'),
      progressTypes: this.stringArray(record.progressTypes, fallback.progressTypes ?? ['info']),
    };
  }

  private createFallbackCraftBrief(
    chapter: Pick<OutlinePreviewOutput['chapters'][number], 'chapterNo' | 'title' | 'objective' | 'conflict' | 'outline'>,
    index: number,
    chapterCount: number,
    seed: ReturnType<GenerateOutlinePreviewTool['createFallbackSeed']>,
  ): ChapterCraftBrief {
    const chapterNo = Number(chapter.chapterNo) || index + 1;
    const progressRatio = (index + 1) / Math.max(1, chapterCount);
    const irreversibleConsequence = progressRatio >= 0.85
      ? '阶段目标完成，但胜利同时打开下一卷或下一阶段的更高风险。'
      : progressRatio >= 0.55
        ? '关键线索或关系被改写，后续章节必须承担新的代价。'
        : '角色获得新证据，同时失去原本安全的退路。';
    return {
      visibleGoal: chapter.objective,
      hiddenEmotion: '害怕目标失败会让既有关系、承诺或安全感崩塌。',
      coreConflict: chapter.conflict,
      mainlineTask: seed.objective,
      subplotTasks: [`补齐第 ${chapterNo} 章与卷内支线的连接点`],
      actionBeats: [
        `明确本章目标：${chapter.objective}`,
        `安排一次具体行动或谈判，让阻力正面出现：${chapter.conflict}`,
        `以新证据、关系变化或风险升级收束：${chapter.outline}`,
      ],
      concreteClues: [
        {
          name: `第 ${chapterNo} 章待复核线索`,
          sensoryDetail: '需要人工补充可见、可听或可触的细节。',
          laterUse: '用于后续章节回收或反转。',
        },
      ],
      dialogueSubtext: '角色表面讨论行动方案，潜台词是试探信任、隐瞒代价或争夺主动权。',
      characterShift: '角色从承接压力转向做出更具体的选择。',
      irreversibleConsequence,
      progressTypes: progressRatio >= 0.85 ? ['info', 'status'] : progressRatio >= 0.55 ? ['info', 'relationship'] : ['info', 'foreshadow'],
    };
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

  private stringArray(value: unknown, fallback: string[]): string[] {
    const items = Array.isArray(value)
      ? value.map((item) => this.text(item, '')).filter(Boolean)
      : [];
    return items.length ? items : fallback;
  }

  private isLlmTimeout(error: unknown) {
    return Boolean(error && typeof error === 'object' && (error as Record<string, unknown>).code === 'LLM_TIMEOUT');
  }

}
