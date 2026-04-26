import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

export interface PolishChapterResult {
  draftId: string;
  chapterId: string;
  originalDraftId: string;
  originalWordCount: number;
  polishedWordCount: number;
  changed: boolean;
  summary: string;
}

const FALLBACK_POLISH_SYSTEM_PROMPT = `你是一位资深小说文本编辑，任务是润色现有章节正文，让文本更自然、更具画面感，并降低模板化表达。

硬性规则：
- 不得改变剧情事实、人物关系、时间线、关键事件结果或叙事视角。
- 不得新增核心情节、设定或角色。
- 不要输出解释、标题、Markdown 或包裹标签，只输出润色后的正文。
- 润色后的字数应与原文大致相当（±15%）。

润色重点：
1. 删除或替换常见 AI 腔、总结腔和空泛形容。
2. 用动作、感官细节和节奏变化替代直接情绪说明。
3. 优化对话自然度，保留角色原有表达习惯。
4. 保留开头钩子、结尾悬念与章节核心推进。`;

/**
 * API 内章节润色服务，迁移自 Worker PolishChapterPipeline 的核心能力。
 * 输入项目/章节/可选草稿与指令；副作用是创建新的当前草稿版本并更新章节字数。
 */
@Injectable()
export class PolishChapterService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  async run(projectId: string, chapterId: string, instruction?: string, sourceDraftId?: string): Promise<PolishChapterResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { volume: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const currentDraft = sourceDraftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: sourceDraftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!currentDraft) throw new NotFoundException(`章节 ${chapterId} 没有可润色草稿，请先生成正文。`);

    const originalText = currentDraft.content.trim();
    if (this.countChineseLikeWords(originalText) < 50) throw new BadRequestException('草稿内容过短，无法进行有效润色。');

    const [characters, dbTemplate] = await Promise.all([
      this.prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 8 }),
      this.prisma.promptTemplate.findFirst({ where: { stepKey: 'polish_chapter', OR: [{ projectId }, { projectId: null }], isDefault: true }, orderBy: [{ projectId: 'desc' }, { version: 'desc' }] }),
    ]);

    const result = await this.llm.chat(
      [
        { role: 'system', content: dbTemplate?.systemPrompt || FALLBACK_POLISH_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserPrompt(chapter, characters, originalText, instruction) },
      ],
      { appStep: 'polish', maxTokens: Math.min(9000, Math.max(1800, Math.ceil(originalText.length * 1.4))), timeoutMs: 180_000, retries: 1, temperature: 0.35 },
    );

    const polishedText = this.stripWrapperTags(result.text).trim();
    if (!polishedText) throw new BadRequestException('polish_chapter 返回正文为空');

    const originalWordCount = this.countChineseLikeWords(originalText);
    const polishedWordCount = this.countChineseLikeWords(polishedText);
    const changed = polishedText !== currentDraft.content;

    const finalDraft = changed
      ? await this.prisma.$transaction(async (tx) => {
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
              generationContext: { type: 'polish', originalDraftId: currentDraft.id, instruction } as Prisma.InputJsonValue,
              isCurrent: true,
              createdBy: currentDraft.createdBy,
            },
          });
          await tx.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount: polishedWordCount } });
          return draft;
        })
      : currentDraft;

    if (!changed) await this.prisma.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount: polishedWordCount } });

    return { draftId: finalDraft.id, chapterId, originalDraftId: currentDraft.id, originalWordCount, polishedWordCount, changed, summary: polishedText.slice(0, 160) };
  }

  private buildUserPrompt(chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }, characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>, originalText: string, instruction?: string): string {
    const characterBlock = characters.length
      ? characters.map((item) => `- ${item.name}：${[item.roleType && `定位：${item.roleType}`, item.personalityCore && `性格：${item.personalityCore}`, item.motivation && `动机：${item.motivation}`, item.speechStyle && `语言风格：${item.speechStyle}`].filter(Boolean).join('；') || '暂无详细设定'}`).join('\n')
      : '暂无角色资料';

    // 提示词显式传入章节目标和角色信息，约束 LLM 只做表达层润色而不改剧情事实。
    return `请对以下章节正文进行润色。\n\n【章节】第${chapter.chapterNo}章「${chapter.title ?? '未命名'}」\n【章节目标】${chapter.objective ?? '未填写'}\n【章节冲突】${chapter.conflict ?? '未填写'}\n【章节梗概】${chapter.outline ?? '未填写'}\n\n【角色信息】\n${characterBlock}\n\n【用户润色要求】\n${instruction || '提升自然度、画面感和节奏，避免改变剧情事实。'}\n\n【原文】\n${originalText}`;
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