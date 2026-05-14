import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { LlmChatMessage, LlmChatResult } from '../llm/dto/llm-chat.dto';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { HUMANIZER_POLISH_GUIDE } from './humanizer-polish-guide';

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
  targetWordCount?: number;
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

interface ValidatedPolishOutput {
  result: LlmChatResult;
  polishedText: string;
  polishedWordCount: number;
}

interface PolishOutputValidation {
  polishedText?: string;
  polishedWordCount?: number;
  issues: string[];
}

const POLISH_CHAPTER_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const POLISH_CHAPTER_LLM_RETRIES = 1;
const POLISH_CHAPTER_CONTRACT_ATTEMPTS = 2;
const POLISH_CHAPTER_LLM_PHASE_TIMEOUT_MS = POLISH_CHAPTER_LLM_TIMEOUT_MS * (POLISH_CHAPTER_LLM_RETRIES + 1) * POLISH_CHAPTER_CONTRACT_ATTEMPTS + 5_000;
const POLISH_WORD_COUNT_MIN_RATIO = 0.75;
const POLISH_WORD_COUNT_MAX_RATIO = 1.35;
const POLISH_TARGET_WORD_COUNT_MIN_RATIO = 0.85;
const POLISH_TARGET_WORD_COUNT_MAX_RATIO = 1.3;

const FALLBACK_POLISH_SYSTEM_PROMPT = `你是一位资深小说文本编辑，任务是润色现有章节正文，让文本更自然、更有现场阻力，并降低模板化表达。

硬性规则：
- 不得改变剧情事实、人物关系、时间线、关键事件结果或叙事视角。
- 不得新增核心情节、设定或角色。
- 必须只输出一个 <rewrite>...</rewrite> 标签块，标签外不要输出任何解释、标题、Markdown 或说明。
- <rewrite> 内只放完整润色后的章节正文，不要放建议、分析、示例或问题清单。
- 润色后的字数应与原文大致相当（±15%）。

润色重点：
0. 润色前先进行内部评分：按 0-10 分评估事实保真、AI味、修辞克制/现场质感、节奏衔接、对话自然度、角色语气一致性；评分只用于改写决策，严禁输出。
1. 优先修复内部评分低于 8 分的维度，尤其是事实保真、AI味、修辞克制和节奏问题。
2. 删除或替换常见 AI 腔、总结腔和空泛形容。
3. 用动作后果、器物反应和节奏变化替代直接情绪说明；不要为了“画面感”继续堆叠感官。
4. 优化对话自然度，保留角色原有表达习惯。
5. 保留开头钩子、结尾悬念与章节核心推进。

${HUMANIZER_POLISH_GUIDE}`;

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

    const originalWordCount = this.countChineseLikeWords(originalText);
    await options.progress?.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在润色章节草稿',
      progressCurrent: 0,
      progressTotal: POLISH_CHAPTER_CONTRACT_ATTEMPTS,
      timeoutMs: POLISH_CHAPTER_LLM_PHASE_TIMEOUT_MS,
    });

    const targetWordCount = this.normalizeTargetWordCount(options.targetWordCount);
    const systemPrompt = this.withRewriteOutputContract(dbTemplate?.systemPrompt || FALLBACK_POLISH_SYSTEM_PROMPT);
    const baseMessages: LlmChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.buildUserPrompt(chapter, characters, originalText, instruction, targetWordCount) },
    ];
    const { result, polishedText, polishedWordCount } = await this.generateValidatedPolishOutput(baseMessages, originalText, originalWordCount, targetWordCount);

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

  private async generateValidatedPolishOutput(baseMessages: LlmChatMessage[], originalText: string, originalWordCount: number, targetWordCount?: number): Promise<ValidatedPolishOutput> {
    let lastIssues: string[] = [];
    for (let attempt = 0; attempt < POLISH_CHAPTER_CONTRACT_ATTEMPTS; attempt += 1) {
      const messages = attempt === 0
        ? baseMessages
        : [...baseMessages, { role: 'user' as const, content: this.buildRewriteContractRetryPrompt(lastIssues, originalWordCount, targetWordCount) }];
      const result = await this.llm.chat(
        messages,
        { appStep: 'polish', maxTokens: this.estimatePolishMaxTokens(originalText, attempt), timeoutMs: POLISH_CHAPTER_LLM_TIMEOUT_MS, retries: POLISH_CHAPTER_LLM_RETRIES, temperature: attempt === 0 ? 0.35 : 0.2 },
      );
      const validation = this.validatePolishOutput(result, originalWordCount, targetWordCount);
      if (!validation.issues.length && validation.polishedText && validation.polishedWordCount !== undefined) {
        return { result, polishedText: validation.polishedText, polishedWordCount: validation.polishedWordCount };
      }
      lastIssues = validation.issues;
    }
    throw new BadRequestException(`polish_chapter 未返回可写入的完整正文：${lastIssues.join('；') || '输出不符合 <rewrite> 契约'}`);
  }

  private validatePolishOutput(result: LlmChatResult, originalWordCount: number, targetWordCount?: number): PolishOutputValidation {
    const issues: string[] = [];
    if (this.isLengthFinishReason(result.rawPayloadSummary.finishReason)) {
      issues.push('LLM 输出因 token 上限被截断');
    }

    const extracted = this.extractRewriteContent(result.text);
    issues.push(...extracted.issues);
    if (!extracted.polishedText) return { issues };

    const polishedWordCount = this.countChineseLikeWords(extracted.polishedText);
    if (polishedWordCount <= 0) {
      issues.push('polish_chapter 返回正文为空');
      return { issues };
    }

    const ratio = polishedWordCount / originalWordCount;
    if (ratio < POLISH_WORD_COUNT_MIN_RATIO) {
      issues.push(`润色正文过短：${polishedWordCount}/${originalWordCount}`);
    }
    if (ratio > POLISH_WORD_COUNT_MAX_RATIO) {
      issues.push(`润色正文过长：${polishedWordCount}/${originalWordCount}`);
    }

    if (targetWordCount) {
      const targetRatio = polishedWordCount / targetWordCount;
      if (targetRatio < POLISH_TARGET_WORD_COUNT_MIN_RATIO) {
        issues.push(`润色后正文长度仅达到目标的 ${(targetRatio * 100).toFixed(0)}%，低于允许下限 ${Math.round(POLISH_TARGET_WORD_COUNT_MIN_RATIO * 100)}%。`);
      }
      if (targetRatio > POLISH_TARGET_WORD_COUNT_MAX_RATIO) {
        issues.push(`润色后正文长度达到目标的 ${(targetRatio * 100).toFixed(0)}%，超过允许上限 ${Math.round(POLISH_TARGET_WORD_COUNT_MAX_RATIO * 100)}%。`);
      }
    }

    return { polishedText: extracted.polishedText, polishedWordCount, issues };
  }

  private extractRewriteContent(rawText: string): { polishedText?: string; issues: string[] } {
    const text = this.stripOuterMarkdownFence(rawText.trim());
    const exactMatch = text.match(/^<rewrite>\s*([\s\S]*?)\s*<\/rewrite>$/i);
    if (!exactMatch) {
      return {
        issues: [/<rewrite>[\s\S]*?<\/rewrite>/i.test(text) ? 'rewrite 标签外存在额外文本' : '缺少完整 <rewrite>...</rewrite> 标签块'],
      };
    }
    const polishedText = exactMatch[1].trim();
    return polishedText ? { polishedText, issues: [] } : { issues: ['polish_chapter 返回正文为空'] };
  }

  private buildRewriteContractRetryPrompt(issues: string[], originalWordCount: number, targetWordCount?: number): string {
    const targetRequirement = targetWordCount
      ? `\n- 本章目标字数为 ${targetWordCount} 字；润色后正文必须保持在 ${Math.round(targetWordCount * POLISH_TARGET_WORD_COUNT_MIN_RATIO)}-${Math.round(targetWordCount * POLISH_TARGET_WORD_COUNT_MAX_RATIO)} 字之间，不能把正文压缩到目标下限以下。`
      : '';
    return `上一次润色输出不能写入，因为：${issues.join('；') || '输出不符合契约'}。
请重新输出一次。硬性要求：
- 整条回复必须且只能是一个 <rewrite>...</rewrite> 标签块，标签外不要有任何文字。
- <rewrite> 内必须是完整润色后的章节正文，不要写分析、建议、说明、示例、检查清单或“我们需要”之类执行过程。
- 正文必须从章节正文直接开始，完整写到章节结尾，不要中途停止。
- 字数必须接近原文 ${originalWordCount} 字，不能明显扩写或缩写。
- 不改变剧情事实、人物关系、时间线、关键事件结果或叙事视角。${targetRequirement}`;
  }

  private withRewriteOutputContract(systemPrompt: string): string {
    return `${systemPrompt}

【输出契约-后端强制】
- 整条回复必须且只能是一个 <rewrite>...</rewrite> 标签块。
- 标签外禁止任何文字；<rewrite> 内只允许完整润色后的章节正文。
- 不要输出分析、建议、执行步骤、示例、检查清单、Markdown 代码块或标题。
- 如果无法完成完整章节正文，必须失败而不是输出半截内容。`;
  }

  private estimatePolishMaxTokens(originalText: string, attempt: number): number {
    const multiplier = attempt === 0 ? 2.2 : 3.2;
    const minimum = attempt === 0 ? 2400 : 3600;
    const maximum = attempt === 0 ? 16_000 : 24_000;
    return Math.min(maximum, Math.max(minimum, Math.ceil(originalText.length * multiplier)));
  }

  private isLengthFinishReason(finishReason: unknown): boolean {
    const value = Array.isArray(finishReason) ? finishReason.join(' ') : String(finishReason ?? '');
    return /length|max[_ -]?tokens?|token[_ -]?limit/i.test(value);
  }

  private stripOuterMarkdownFence(text: string): string {
    return text.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/i)?.[1].trim() ?? text;
  }

  /** 判断来源草稿是否已经是润色稿，避免重复点击维护流程时制造无意义版本。 */
  private isPolishedDraft(draft: { source: string; generationContext: Prisma.JsonValue }) {
    const context = draft.generationContext;
    return draft.source === 'agent_polish' || (typeof context === 'object' && context !== null && !Array.isArray(context) && context.type === 'polish');
  }

  private buildUserPrompt(chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }, characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>, originalText: string, instruction?: string, targetWordCount?: number): string {
    const characterBlock = characters.length
      ? characters.map((item) => `- ${item.name}：${[item.roleType && `定位：${item.roleType}`, item.personalityCore && `性格：${item.personalityCore}`, item.motivation && `动机：${item.motivation}`, item.speechStyle && `语言风格：${item.speechStyle}`].filter(Boolean).join('；') || '暂无详细设定'}`).join('\n')
      : '暂无角色资料';
    const antiAiTasteBlock = [
      '【去 AI 味重点】',
      HUMANIZER_POLISH_GUIDE,
      '- 本次润色按“减法”处理：不要为了画面感继续添加比喻、颜色、气味或环境大段。',
      '- 优先处理独立成段的戏剧化短句、过度整齐的排比、连续感官堆叠、像预告片旁白的句子。',
      '- 清理“没出声、没反应、又看了一眼”这类不改变判断、阻力、危险、关系或线索的低信息细节；能删就删，必要时并入有行动后果的句子。',
      '- 对“像/仿佛/似乎/好像/宛如/如同/细如”这类比喻词从严压缩；能改成动作后果、器物反应、人物选择就不要保留比喻。',
      '- 开头若主要是天气、天象或世界观空镜，改为人物在具体压力下的动作或选择，再让环境细节跟着行动出现。',
      '- 保留剧情事实和关键信息，但允许把漂亮句改粗、改短、改不那么对称。',
    ].join('\n');

    // 提示词显式传入章节目标、角色信息和内部评分要求，约束 LLM 先诊断低分项再做表达层润色。
    return `请对以下章节正文进行润色。\n\n【章节】第${chapter.chapterNo}章「${chapter.title ?? '未命名'}」\n【章节目标】${chapter.objective ?? '未填写'}\n【章节冲突】${chapter.conflict ?? '未填写'}\n【章节梗概】${chapter.outline ?? '未填写'}\n\n【角色信息】\n${characterBlock}\n\n【润色前内部评分要求】\n请先在内部按 0-10 分自评以下维度：事实保真、AI味、修辞克制/现场质感、节奏衔接、对话自然度、角色语气一致性。评分和诊断只用于决定改写重点，不得输出；润色时优先改进低于 8 分的维度，最终只输出一个 <rewrite>...</rewrite> 标签块。\n\n${antiAiTasteBlock}\n\n【用户润色要求】\n${instruction || '提升自然度、叙事阻力和节奏，减少过度修辞与感官堆叠，避免改变剧情事实。'}\n\n【原文】\n${originalText}`;
  }

  private countChineseLikeWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }

  private normalizeTargetWordCount(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}
