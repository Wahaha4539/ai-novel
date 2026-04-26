import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RetrievalHit } from '../memory/retrieval.service';

export interface ChapterPromptContext {
  project: { id: string; title: string; genre: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  volume?: { volumeNo: number; title: string | null; objective: string | null; synopsis: string | null } | null;
  styleProfile?: { pov?: string | null; tense?: string | null; proseStyle?: string | null; pacing?: string | null } | null;
  chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null; revealPoints?: string | null; foreshadowPlan?: string | null; expectedWordCount: number | null };
  characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>;
  plannedForeshadows: Array<{ title: string; detail: string | null; status: string; firstSeenChapterNo: number | null; lastSeenChapterNo: number | null }>;
  previousChapters: Array<{ chapterNo: number; title: string | null; content: string }>;
  hardFacts: string[];
  lorebookHits: RetrievalHit[];
  memoryHits: RetrievalHit[];
  userInstruction?: string;
  targetWordCount?: number;
}

export interface BuiltChapterPrompt {
  system: string;
  user: string;
  debug: Record<string, unknown>;
}

const MAX_PREVIOUS_CONTEXT_TOTAL = 15_000;

/**
 * API 内章节提示词构建服务，迁移 Worker PromptBuilder 的上下文拼装能力。
 * 输入结构化创作上下文；输出 system/user prompt 和调试摘要；不直接调用 LLM 或写库。
 */
@Injectable()
export class PromptBuilderService {
  constructor(private readonly prisma: PrismaService) {}

  /** 构建章节写作 Prompt；缺少正式 PromptTemplate 时直接报错，避免低质量模板影响正文。 */
  async buildChapterPrompt(context: ChapterPromptContext): Promise<BuiltChapterPrompt> {
    const template = await this.prisma.promptTemplate.findFirst({
      where: { stepKey: 'write_chapter', OR: [{ projectId: context.project.id }, { projectId: null }], isDefault: true },
      orderBy: [{ projectId: 'desc' }, { version: 'desc' }],
    });
    if (!template?.systemPrompt || !template?.userTemplate) throw new BadRequestException('缺少默认 write_chapter PromptTemplate，已拒绝使用内置兜底模板生成正文。');
    const system = template.systemPrompt;
    const userTemplate = template.userTemplate;
    const user = [
      userTemplate,
      this.buildProjectSection(context),
      this.buildVolumeSection(context),
      this.buildStyleSection(context),
      this.buildCharacterSection(context),
      this.buildChapterSection(context),
      this.buildForeshadowSection(context),
      this.buildFactsSection(context),
      this.buildLorebookSection(context),
      this.buildMemorySection(context),
      this.buildPreviousChaptersSection(context),
      `【附加指令】\n${context.userInstruction || '无'}`,
    ].join('\n\n');

    return {
      system,
      user,
      debug: {
        promptSource: 'db',
        lorebookCount: context.lorebookHits.length,
        memoryCount: context.memoryHits.length,
        previousChapterCount: context.previousChapters.length,
        foreshadowCount: context.plannedForeshadows.length,
        hasVolume: Boolean(context.volume),
        hasStyleProfile: Boolean(context.styleProfile),
        targetWordCount: context.targetWordCount ?? context.chapter.expectedWordCount ?? 3500,
      },
    };
  }

  private buildProjectSection(data: ChapterPromptContext): string {
    const project = data.project;
    return ['【项目概览】', `标题：${project.title}`, `类型：${project.genre || '未指定'}`, `基调：${project.tone || '未指定'}`, project.synopsis ? `故事简介：${project.synopsis}` : '', project.outline ? `故事总纲：${project.outline.slice(0, 3000)}` : ''].filter(Boolean).join('\n');
  }

  private buildVolumeSection(data: ChapterPromptContext): string {
    const volume = data.volume;
    if (!volume) return '【所属卷】\n未指定分卷';
    return ['【所属卷】', `第${volume.volumeNo}卷「${volume.title || '未命名'}」`, volume.objective ? `本卷叙事目标：${volume.objective}` : '', volume.synopsis ? `本卷概要：${volume.synopsis}` : ''].filter(Boolean).join('\n');
  }

  private buildStyleSection(data: ChapterPromptContext): string {
    const style = data.styleProfile ?? {};
    return ['【文风设定】', `视角：${style.pov || '第三人称限制'}`, `时态：${style.tense || '过去时'}`, `文风：${style.proseStyle || '冷峻、克制'}`, `节奏：${style.pacing || 'medium'}`].join('\n');
  }

  private buildCharacterSection(data: ChapterPromptContext): string {
    if (!data.characters.length) return '【角色信息】\n- 无登场角色';
    return ['【角色信息】', ...data.characters.slice(0, 12).map((character) => `- ${character.name}（${character.roleType || '未知'}）${[character.personalityCore && `性格：${character.personalityCore}`, character.motivation && `动机：${character.motivation}`, character.speechStyle && `语言风格：${character.speechStyle}`].filter(Boolean).join('｜')}`)].join('\n');
  }

  private buildChapterSection(data: ChapterPromptContext): string {
    const chapter = data.chapter;
    return ['【章节信息】', `章节号：第${chapter.chapterNo}章`, `标题：${chapter.title || '未命名'}`, `目标：${chapter.objective || '无'}`, `冲突：${chapter.conflict || '无'}`, `大纲：${chapter.outline || '无'}`, `目标字数：${data.targetWordCount || chapter.expectedWordCount || 3500}`, chapter.revealPoints ? `揭示点：${chapter.revealPoints}` : '', chapter.foreshadowPlan ? `伏笔计划：${chapter.foreshadowPlan}` : ''].filter(Boolean).join('\n');
  }

  private buildForeshadowSection(data: ChapterPromptContext): string {
    if (!data.plannedForeshadows.length) return '【本章伏笔计划】\n- 无特定伏笔要求';
    return ['【本章伏笔计划】', ...data.plannedForeshadows.map((item) => `- ${item.title}：${item.detail || item.status}`)].join('\n');
  }

  private buildFactsSection(data: ChapterPromptContext): string {
    return data.hardFacts.length ? ['【硬事实】', ...data.hardFacts.map((fact) => `- ${fact}`)].join('\n') : '【硬事实】\n- 无';
  }

  private buildLorebookSection(data: ChapterPromptContext): string {
    return data.lorebookHits.length ? ['【Lorebook 命中】', ...data.lorebookHits.map((hit) => `- ${hit.title}: ${hit.content}`)].join('\n') : '【Lorebook 命中】\n- 无';
  }

  private buildMemorySection(data: ChapterPromptContext): string {
    return data.memoryHits.length ? ['【记忆召回】', ...data.memoryHits.map((hit) => `- ${hit.title}: ${hit.content}`)].join('\n') : '【记忆召回】\n- 无';
  }

  private buildPreviousChaptersSection(data: ChapterPromptContext): string {
    if (!data.previousChapters.length) return '【前文回顾】\n本章为首章或前文尚未生成。';
    const lines = ['【前文回顾（前几章正文）】'];
    let totalChars = 0;
    let included = 0;
    for (const chapter of data.previousChapters) {
      if (totalChars + chapter.content.length > MAX_PREVIOUS_CONTEXT_TOTAL && included > 0) {
        lines.push(`（后续 ${data.previousChapters.length - included} 章因篇幅省略，请参考记忆召回摘要）`);
        break;
      }
      lines.push(`\n=== 第${chapter.chapterNo}章「${chapter.title || '未命名'}」===`);
      lines.push(chapter.content);
      totalChars += chapter.content.length;
      included += 1;
    }
    return lines.join('\n');
  }
}