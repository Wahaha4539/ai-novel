import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const OUTLINE_PREVIEW_LLM_TIMEOUT_MS = 90_000;

interface GenerateOutlinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterCount?: number;
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
    try {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: '正在生成卷章节预览',
        timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS,
      });
      const response = await this.llm.chatJson<OutlinePreviewOutput>(
        [
          { role: 'system', content: '你是小说大纲设计 Agent。只输出 JSON，不要 Markdown。字段必须包含 volume、chapters、risks。每章包含 chapterNo/volumeNo/title/objective/conflict/hook/outline/expectedWordCount/craftBrief。章节字段要短，不要写正文。craftBrief 是本章执行卡，需包含 visibleGoal/coreConflict/mainlineTask/actionBeats/concreteClues/irreversibleConsequence。' },
          { role: 'user', content: `用户目标：${args.instruction ?? '生成章节大纲'}\n卷号：${volumeNo}\n章节数：${chapterCount}\n项目上下文：\n${this.compactContext(args.context)}` },
        ],
        { appStep: 'planner', maxTokens: Math.min(8000, chapterCount * 220 + 1000), timeoutMs: OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: 0 },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验章节预览', progressCurrent: chapterCount, progressTotal: chapterCount });
      return this.normalize(response.data, volumeNo, chapterCount, args);
    } catch (error) {
      await context.updateProgress?.({ phase: 'fallback_generating', phaseMessage: '模型未稳定返回，正在生成确定性章节骨架', progressCurrent: 0, progressTotal: chapterCount });
      return this.fallback(args, volumeNo, chapterCount, error);
    }
  }

  private normalize(data: OutlinePreviewOutput, volumeNo: number, chapterCount: number, args: GenerateOutlinePreviewInput): OutlinePreviewOutput {
    const seed = this.createFallbackSeed(args.context, args.instruction, volumeNo);
    const chapters: OutlinePreviewOutput['chapters'] = (data.chapters ?? []).slice(0, chapterCount).map((item, index) => {
      const chapter = {
        chapterNo: Number(item.chapterNo) || index + 1,
        volumeNo: Number(item.volumeNo) || volumeNo,
        title: this.text(item.title, `第 ${index + 1} 章`),
        objective: this.text(item.objective, '推进主线目标'),
        conflict: this.text(item.conflict, '制造角色选择压力'),
        hook: this.text(item.hook, '留下下一章悬念'),
        outline: this.text(item.outline, this.text(item.objective, '待扩写')),
        expectedWordCount: Number(item.expectedWordCount) || 2500,
      };
      return { ...chapter, craftBrief: this.normalizeCraftBrief(item.craftBrief, chapter, index, chapterCount, seed) };
    });
    while (chapters.length < chapterCount) {
      chapters.push(this.createFallbackChapter(chapters.length, chapterCount, seed));
    }
    const risks = [
      ...(data.risks ?? []),
      ...(chapters.length > (data.chapters?.length ?? 0) ? ['LLM 返回章节数少于目标章节数，已用确定性章节骨架补齐缺口；请在审批前重点复核补齐章节。'] : []),
    ];
    const narrativePlan = this.asRecord(data.volume?.narrativePlan);
    return {
      volume: {
        volumeNo,
        title: this.text(data.volume?.title, seed.volumeTitle),
        synopsis: this.text(data.volume?.synopsis, seed.synopsis),
        objective: this.text(data.volume?.objective, seed.objective),
        chapterCount: chapters.length,
        ...(Object.keys(narrativePlan).length ? { narrativePlan } : {}),
      },
      chapters,
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

  private compactContext(context: unknown): string {
    const record = this.asRecord(context);
    const project = this.asRecord(record.project);
    const volumes = Array.isArray(record.volumes) ? record.volumes.slice(0, 12) : [];
    const existingChapters = Array.isArray(record.existingChapters) ? record.existingChapters.slice(0, 120) : [];
    const characters = Array.isArray(record.characters) ? record.characters.slice(0, 20) : [];
    const lorebookEntries = Array.isArray(record.lorebookEntries) ? record.lorebookEntries.slice(0, 20) : [];
    return JSON.stringify({ project, volumes, existingChapters, characters, lorebookEntries }, null, 2).slice(0, 12000);
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
