import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

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
  writePreview: {
    draft: { action: 'create_first_draft' | 'create_new_version'; currentDraftId: string | null; currentVersionNo: number | null; currentWordCount: number; currentExcerpt: string | null };
    facts: { existingAutoEventCount: number; existingAutoCharacterStateCount: number; existingAutoForeshadowCount: number; action: 'replace_auto_facts_after_generation' };
    memory: { existingAutoMemoryCount: number; action: 'replace_agent_generated_memory_after_generation' };
    validation: { openIssueCount: number; openErrorCount: number };
    approvalRiskHints: string[];
  };
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
    required: ['project', 'chapter', 'previousChapters', 'characters', 'lorebookEntries', 'memoryChunks', 'writePreview'],
    properties: { project: { type: 'object' as const }, chapter: { type: 'object' as const }, previousChapters: { type: 'array' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const }, memoryChunks: { type: 'array' as const }, writePreview: { type: 'object' as const } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '收集章节上下文',
    description: '读取章节写作/修改所需的项目、章节、角色、设定、前文草稿摘录和记忆上下文。',
    whenToUse: ['write_chapter、polish_chapter 前需要上下文预览', '需要审批前展示章节写入影响', '用户要求基于前文继续写或修改当前章'],
    whenNotToUse: ['任务不涉及章节', '缺少真实 chapterId 且尚未解析章节引用'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: { chapterId: { source: 'resolver', resolverTool: 'resolve_chapter', description: '真实章节 ID，可来自 context.session.currentChapterId 或 resolve_chapter。' } },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId'], allowedSources: ['context.session.currentChapterId', 'resolve_chapter.output.chapterId', 'steps.resolve_chapter.output.chapterId'] },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: CollectChapterContextInput, context: ToolContext): Promise<ChapterContextOutput> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('collect_chapter_context 需要 chapterId');

    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId: context.projectId }, include: { project: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const [previousChapters, characters, lorebookEntries, rawMemoryChunks, currentDraft, factCounts, autoMemoryCount, openIssues] = await Promise.all([
      this.prisma.chapter.findMany({
        where: { projectId: context.projectId, chapterNo: { lt: chapter.chapterNo } },
        orderBy: { chapterNo: 'desc' },
        take: 5,
        include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } },
      }),
      this.prisma.character.findMany({ where: { projectId: context.projectId }, orderBy: { createdAt: 'asc' }, take: 20 }),
      this.prisma.lorebookEntry.findMany({ where: { projectId: context.projectId, status: 'active' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 20 }),
      this.prisma.memoryChunk.findMany({ where: { projectId: context.projectId }, orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }], take: 80 }),
      this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } }),
      this.countCurrentDraftFacts(context.projectId, chapterId),
      this.prisma.memoryChunk.count({ where: { projectId: context.projectId, sourceType: 'chapter', sourceId: chapterId, metadata: { path: ['generatedBy'], equals: 'agent_memory_rebuild' } } }),
      this.prisma.validationIssue.findMany({ where: { projectId: context.projectId, chapterId, status: 'open' }, select: { severity: true } }),
    ]);
    const memoryChunks = this.visibleMemoryChunksBeforeChapter(rawMemoryChunks, chapter).slice(0, 12);
    const writePreview = this.buildWritePreview(currentDraft, factCounts, autoMemoryCount, openIssues);

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
      writePreview,
    };
  }

  /**
   * 统计当前章节由 Agent 自动生成的事实层记录，用于审批前展示“将替换哪些自动产物”。
   * 这里刻意只统计 generatedBy=agent_fact_extractor 的记录，避免把人工维护事实误标为会被覆盖。
   */
  private async countCurrentDraftFacts(projectId: string, chapterId: string) {
    const where = { projectId, chapterId, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } };
    const [existingAutoEventCount, existingAutoCharacterStateCount, existingAutoForeshadowCount] = await Promise.all([
      this.prisma.storyEvent.count({ where }),
      this.prisma.characterStateSnapshot.count({ where }),
      this.prisma.foreshadowTrack.count({ where }),
    ]);
    return { existingAutoEventCount, existingAutoCharacterStateCount, existingAutoForeshadowCount };
  }

  /** 生成面向用户的章节写入前 diff 摘要，供 Plan 阶段审批和风险解释使用。 */
  private buildWritePreview(
    currentDraft: { id: string; versionNo: number; content: string } | null,
    factCounts: { existingAutoEventCount: number; existingAutoCharacterStateCount: number; existingAutoForeshadowCount: number },
    autoMemoryCount: number,
    openIssues: Array<{ severity: string }>,
  ): ChapterContextOutput['writePreview'] {
    const openErrorCount = openIssues.filter((issue) => issue.severity === 'error').length;
    const approvalRiskHints = [
      currentDraft ? `当前已有 v${currentDraft.versionNo} 草稿；执行后会创建 v${currentDraft.versionNo + 1} 并切换为当前版本。` : '当前没有草稿；执行后会创建首个当前草稿。',
      factCounts.existingAutoEventCount + factCounts.existingAutoCharacterStateCount + factCounts.existingAutoForeshadowCount > 0 ? '事实抽取步骤会替换本章已有 Agent 自动事实层记录。' : '事实抽取步骤会新增本章 Agent 自动事实层记录。',
      autoMemoryCount > 0 ? `记忆重建步骤会替换 ${autoMemoryCount} 条本章 Agent 自动记忆。` : '记忆重建步骤会新增本章 Agent 自动记忆。',
      ...(openErrorCount > 0 ? [`当前章节仍有 ${openErrorCount} 个 open error 级校验问题，生成前门禁可能阻断写入。`] : []),
    ];

    return {
      draft: {
        action: currentDraft ? 'create_new_version' : 'create_first_draft',
        currentDraftId: currentDraft?.id ?? null,
        currentVersionNo: currentDraft?.versionNo ?? null,
        currentWordCount: currentDraft ? this.countChineseLikeWords(currentDraft.content) : 0,
        currentExcerpt: currentDraft?.content.slice(0, 260) ?? null,
      },
      facts: { ...factCounts, action: 'replace_auto_facts_after_generation' },
      memory: { existingAutoMemoryCount: autoMemoryCount, action: 'replace_agent_generated_memory_after_generation' },
      validation: { openIssueCount: openIssues.length, openErrorCount },
      approvalRiskHints,
    };
  }

  private countChineseLikeWords(content: string) {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }

  private visibleMemoryChunksBeforeChapter<T extends { sourceType: string; sourceId: string; sourceTrace: unknown }>(chunks: T[], chapter: { id: string; chapterNo: number }): T[] {
    return chunks.filter((chunk) => {
      if (chunk.sourceType === 'chapter' && chunk.sourceId === chapter.id) return false;
      const trace = this.asRecord(chunk.sourceTrace);
      if (this.readString(trace.chapterId) === chapter.id) return false;
      const traceChapterNo = this.readNumber(trace.chapterNo);
      return typeof traceChapterNo !== 'number' || traceChapterNo < chapter.chapterNo;
    });
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  }
}
