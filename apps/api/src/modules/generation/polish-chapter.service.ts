import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';

export interface PolishChapterResult {
  draftId: string;
  chapterId: string;
  originalDraftId: string;
  originalWordCount: number;
  polishedWordCount: number;
  changed: boolean;
  summary: string;
}

export interface PolishChapterRunOptions {
  progress?: PolishChapterProgressReporter;
}

interface PolishChapterProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

interface PolishChapterProgressReporter {
  updateProgress?: (patch: PolishChapterProgressPatch) => Promise<void>;
  heartbeat?: (patch?: PolishChapterProgressPatch) => Promise<void>;
}

const POLISH_CHAPTER_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const POLISH_CHAPTER_LLM_RETRIES = 1;
const POLISH_CHAPTER_LLM_PHASE_TIMEOUT_MS = POLISH_CHAPTER_LLM_TIMEOUT_MS * (POLISH_CHAPTER_LLM_RETRIES + 1) + 5_000;

const FALLBACK_POLISH_SYSTEM_PROMPT = `你是一位资深小说文本编辑，任务是润色现有章节正文，让文本更自然、更有现场阻力，并降低模板化表达。

硬性规则：
- 不得改变剧情事实、人物关系、时间线、关键事件结果或叙事视角。
- 不得新增核心情节、设定或角色。
- 不要输出解释、标题、Markdown 或包裹标签，只输出润色后的正文。
- 润色后的字数应与原文大致相当（±15%）。

润色重点：
0. 润色前先进行内部评分：按 0-10 分评估事实保真、AI味、修辞克制/现场质感、节奏衔接、对话自然度、角色语气一致性；评分只用于改写决策，严禁输出。
1. 优先修复内部评分低于 8 分的维度，尤其是事实保真、AI味、修辞克制和节奏问题。
2. 删除或替换常见 AI 腔、总结腔和空泛形容。
3. 用动作后果、器物反应和节奏变化替代直接情绪说明；不要为了“画面感”继续堆叠感官。
4. 优化对话自然度，保留角色原有表达习惯。
5. 保留开头钩子、结尾悬念与章节核心推进。`;

/**
 * API 内章节润色服务，迁移自 Worker PolishChapterPipeline 的核心能力。
 * 输入项目/章节/可选草稿与指令；副作用是创建新的当前草稿版本并更新章节字数。
 */
@Injectable()
export class PolishChapterService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  async run(projectId: string, chapterId: string, instruction?: string, sourceDraftId?: string, options: PolishChapterRunOptions = {}): Promise<PolishChapterResult> {
    await options.progress?.updateProgress?.({ phase: 'preparing_context', phaseMessage: '正在读取待润色章节' });
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { volume: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const currentDraft = sourceDraftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: sourceDraftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!currentDraft) throw new NotFoundException(`章节 ${chapterId} 没有可润色草稿，请先生成正文。`);

    const originalText = currentDraft.content.trim();
    if (this.countChineseLikeWords(originalText) < 50) throw new BadRequestException('草稿内容过短，无法进行有效润色。');

    await options.progress?.heartbeat?.({ phase: 'preparing_context', phaseMessage: '正在读取润色上下文' });
    const [characters, dbTemplate] = await Promise.all([
      this.prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 8 }),
      this.prisma.promptTemplate.findFirst({ where: { stepKey: 'polish_chapter', OR: [{ projectId }, { projectId: null }], isDefault: true }, orderBy: [{ projectId: 'desc' }, { version: 'desc' }] }),
    ]);

    await options.progress?.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在润色章节草稿',
      progressCurrent: 0,
      progressTotal: 1,
      timeoutMs: POLISH_CHAPTER_LLM_PHASE_TIMEOUT_MS,
    });
    const result = await this.llm.chat(
      [
        { role: 'system', content: dbTemplate?.systemPrompt || FALLBACK_POLISH_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserPrompt(chapter, characters, originalText, instruction) },
      ],
      { appStep: 'polish', maxTokens: Math.min(9000, Math.max(1800, Math.ceil(originalText.length * 1.4))), timeoutMs: POLISH_CHAPTER_LLM_TIMEOUT_MS, retries: POLISH_CHAPTER_LLM_RETRIES, temperature: 0.35 },
    );

    const polishedText = this.stripWrapperTags(result.text).trim();
    if (!polishedText) throw new BadRequestException('polish_chapter 返回正文为空');

    const originalWordCount = this.countChineseLikeWords(originalText);
    const polishedWordCount = this.countChineseLikeWords(polishedText);
    const changed = polishedText !== currentDraft.content;
    const sourceAlreadyPolished = this.isPolishedDraft(currentDraft);
    const shouldCreatePolishedDraft = changed || !sourceAlreadyPolished;

    await options.progress?.updateProgress?.({ phase: 'persisting', phaseMessage: '正在写入润色草稿', progressCurrent: 0, progressTotal: 1, timeoutMs: 60_000 });
    const finalDraft = shouldCreatePolishedDraft
      ? await this.prisma.$transaction(async (tx) => {
          // 即使润色文本与原文一致，也为非润色来源创建 agent_polish 版本，
          // 这样前端“草稿/润色”视图能明确展示完整流程已执行，而不是误判为没有润色。
          // 润色可能与生成/修复并发触发，版本号必须在事务内读取以保证单调递增。
          const latestInTransaction = await tx.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
          await tx.chapterDraft.updateMany({ where: { chapterId, isCurrent: true }, data: { isCurrent: false } });
          const draft = await tx.chapterDraft.create({
            data: {
              chapterId,
              versionNo: (latestInTransaction?.versionNo ?? 0) + 1,
              content: polishedText,
              source: 'agent_polish',
              modelInfo: { model: result.model, usage: result.usage, rawPayloadSummary: result.rawPayloadSummary } as Prisma.InputJsonValue,
              generationContext: { type: 'polish', originalDraftId: currentDraft.id, instruction, changed } as Prisma.InputJsonValue,
              isCurrent: true,
              createdBy: currentDraft.createdBy,
            },
          });
          await tx.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount: polishedWordCount } });
          return draft;
        })
      : currentDraft;

    if (!shouldCreatePolishedDraft) await this.prisma.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount: polishedWordCount } });
    await options.progress?.heartbeat?.({ phase: 'persisting', phaseMessage: '润色草稿写入完成', progressCurrent: 1, progressTotal: 1 });

    return { draftId: finalDraft.id, chapterId, originalDraftId: currentDraft.id, originalWordCount, polishedWordCount, changed, summary: polishedText.slice(0, 160) };
  }

  /** 判断来源草稿是否已经是润色稿，避免重复点击维护流程时制造无意义版本。 */
  private isPolishedDraft(draft: { source: string; generationContext: Prisma.JsonValue }) {
    const context = draft.generationContext;
    return draft.source === 'agent_polish' || (typeof context === 'object' && context !== null && !Array.isArray(context) && context.type === 'polish');
  }

  private buildUserPrompt(chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }, characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>, originalText: string, instruction?: string): string {
    const characterBlock = characters.length
      ? characters.map((item) => `- ${item.name}：${[item.roleType && `定位：${item.roleType}`, item.personalityCore && `性格：${item.personalityCore}`, item.motivation && `动机：${item.motivation}`, item.speechStyle && `语言风格：${item.speechStyle}`].filter(Boolean).join('；') || '暂无详细设定'}`).join('\n')
      : '暂无角色资料';
    const antiAiTasteBlock = [
      '【去 AI 味重点】',
      '- 本次润色按“减法”处理：不要为了画面感继续添加比喻、颜色、气味或环境大段。',
      '- 优先处理独立成段的戏剧化短句、过度整齐的排比、连续感官堆叠、像预告片旁白的句子。',
      '- 对“像/仿佛/似乎/好像/宛如/如同/细如”这类比喻词从严压缩；能改成动作后果、器物反应、人物选择就不要保留比喻。',
      '- 开头若主要是天气、天象或世界观空镜，改为人物在具体压力下的动作或选择，再让环境细节跟着行动出现。',
      '- 保留剧情事实和关键信息，但允许把漂亮句改粗、改短、改不那么对称。',
    ].join('\n');

    // 提示词显式传入章节目标、角色信息和内部评分要求，约束 LLM 先诊断低分项再做表达层润色。
    return `请对以下章节正文进行润色。\n\n【章节】第${chapter.chapterNo}章「${chapter.title ?? '未命名'}」\n【章节目标】${chapter.objective ?? '未填写'}\n【章节冲突】${chapter.conflict ?? '未填写'}\n【章节梗概】${chapter.outline ?? '未填写'}\n\n【角色信息】\n${characterBlock}\n\n【润色前内部评分要求】\n请先在内部按 0-10 分自评以下维度：事实保真、AI味、修辞克制/现场质感、节奏衔接、对话自然度、角色语气一致性。评分和诊断只用于决定改写重点，不得输出；润色时优先改进低于 8 分的维度，最终只输出润色后的正文。\n\n${antiAiTasteBlock}\n\n【用户润色要求】\n${instruction || '提升自然度、叙事阻力和节奏，减少过度修辞与感官堆叠，避免改变剧情事实。'}\n\n【原文】\n${originalText}`;
  }

  private stripWrapperTags(text: string): string {
    return text
      .trim()
      .replace(/^<rewrite>/i, '')
      .replace(/<\/rewrite>$/i, '')
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  private countChineseLikeWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }
}
