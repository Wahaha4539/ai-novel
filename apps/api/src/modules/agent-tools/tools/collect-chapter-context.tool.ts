import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';

interface CollectChapterContextInput {
  chapterId?: string;
}

interface ChapterContextOutput {
  project: { id: string; title: string; genre: string | null; theme: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  chapter: { id: string; chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null; expectedWordCount: number | null };
  previousChapters: Array<{ chapterNo: number; title: string | null; objective: string | null; outline: string | null; latestDraftExcerpt: string | null }>;
  characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>;
  lorebookEntries: Array<{ title: string; entryType: string; summary: string | null; content: string }>;
  memoryChunks: Array<{ memoryType: string; summary: string | null; content: string }>;
}

/**
 * 章节上下文收集工具：为写作 Tool 汇总项目、章节、角色、设定、记忆和前文摘要。
 * 输入为 chapterId；输出为结构化上下文。该工具只读数据库，不写业务表。
 */
@Injectable()
export class CollectChapterContextTool implements BaseTool<CollectChapterContextInput, ChapterContextOutput> {
  name = 'collect_chapter_context';
  description = '读取章节写作所需的项目、章节、角色、设定、前文草稿摘录和记忆上下文。';
  inputSchema = { type: 'object' as const, properties: { chapterId: { type: 'string' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['project', 'chapter', 'previousChapters', 'characters', 'lorebookEntries', 'memoryChunks'],
    properties: { project: { type: 'object' as const }, chapter: { type: 'object' as const }, previousChapters: { type: 'array' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const }, memoryChunks: { type: 'array' as const } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: CollectChapterContextInput, context: ToolContext): Promise<ChapterContextOutput> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('collect_chapter_context 需要 chapterId');

    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId: context.projectId }, include: { project: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const [previousChapters, characters, lorebookEntries, memoryChunks] = await Promise.all([
      this.prisma.chapter.findMany({
        where: { projectId: context.projectId, chapterNo: { lt: chapter.chapterNo } },
        orderBy: { chapterNo: 'desc' },
        take: 5,
        include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } },
      }),
      this.prisma.character.findMany({ where: { projectId: context.projectId }, orderBy: { createdAt: 'asc' }, take: 20 }),
      this.prisma.lorebookEntry.findMany({ where: { projectId: context.projectId, status: 'active' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 20 }),
      this.prisma.memoryChunk.findMany({ where: { projectId: context.projectId }, orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }], take: 12 }),
    ]);

    return {
      project: { id: chapter.project.id, title: chapter.project.title, genre: chapter.project.genre, theme: chapter.project.theme, tone: chapter.project.tone, synopsis: chapter.project.synopsis, outline: chapter.project.outline },
      chapter: { id: chapter.id, chapterNo: chapter.chapterNo, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, outline: chapter.outline, expectedWordCount: chapter.expectedWordCount },
      previousChapters: previousChapters.reverse().map((item) => ({
        chapterNo: item.chapterNo,
        title: item.title,
        objective: item.objective,
        outline: item.outline,
        // 只传递前文摘录，避免单次 Agent 请求上下文过大。
        latestDraftExcerpt: item.drafts[0]?.content.slice(0, 1200) ?? null,
      })),
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, personalityCore: item.personalityCore, motivation: item.motivation, speechStyle: item.speechStyle })),
      lorebookEntries: lorebookEntries.map((item) => ({ title: item.title, entryType: item.entryType, summary: item.summary, content: item.content.slice(0, 1000) })),
      memoryChunks: memoryChunks.map((item) => ({ memoryType: item.memoryType, summary: item.summary, content: item.content.slice(0, 1000) })),
    };
  }
}