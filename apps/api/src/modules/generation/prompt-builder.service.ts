import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RetrievalHit } from '../memory/retrieval.service';
import { ChapterContextPack } from './context-pack.types';

export interface ChapterPromptContext {
  project: { id: string; title: string; genre: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  volume?: { volumeNo: number; title: string | null; objective: string | null; synopsis: string | null; narrativePlan?: Prisma.JsonValue | null } | null;
  styleProfile?: { pov?: string | null; tense?: string | null; proseStyle?: string | null; pacing?: string | null } | null;
  chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null; craftBrief?: Prisma.JsonValue | null; revealPoints?: string | null; foreshadowPlan?: string | null; expectedWordCount: number | null };
  characters: Array<{ name: string; roleType: string | null; personalityCore: string | null; motivation: string | null; speechStyle: string | null }>;
  plannedForeshadows: Array<{ title: string; detail: string | null; status: string; firstSeenChapterNo: number | null; lastSeenChapterNo: number | null }>;
  previousChapters: Array<{ chapterNo: number; title: string | null; content: string }>;
  hardFacts: string[];
  contextPack: ChapterContextPack;
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
      this.buildCraftBriefSection(context),
      this.buildContextLayerNotice(),
      this.buildForeshadowSection(context),
      this.buildFactsSection(context),
      this.buildUserIntentSection(context),
      this.buildLorebookSection(context),
      this.buildMemorySection(context),
      this.buildStructuredContextSection(context),
      this.buildPreviousChaptersSection(context),
    ].join('\n\n');

    return {
      system,
      user,
      debug: {
        promptSource: 'db',
        contextPackVersion: context.contextPack.schemaVersion,
        lorebookCount: context.contextPack.verifiedContext.lorebookHits.length,
        memoryCount: context.contextPack.verifiedContext.memoryHits.length,
        structuredCount: context.contextPack.verifiedContext.structuredHits.length,
        verifiedContextCount: context.contextPack.verifiedContext.lorebookHits.length + context.contextPack.verifiedContext.memoryHits.length + context.contextPack.verifiedContext.structuredHits.length,
        previousChapterCount: context.previousChapters.length,
        foreshadowCount: context.plannedForeshadows.length,
        hasVolume: Boolean(context.volume),
        hasStyleProfile: Boolean(context.styleProfile),
        hasCraftBrief: this.hasRecordContent(context.chapter.craftBrief),
        craftBriefSource: this.hasRecordContent(context.chapter.craftBrief)
          ? 'chapter.craftBrief'
          : this.extractExecutionCardMarkdown(context.chapter.outline)
            ? 'chapter.outline'
            : 'none',
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
    const narrativePlan = this.formatJsonObject(volume.narrativePlan, 2500);
    return [
      '【所属卷】',
      `第${volume.volumeNo}卷「${volume.title || '未命名'}」`,
      volume.objective ? `本卷叙事目标：${volume.objective}` : '',
      volume.synopsis ? `本卷概要：${volume.synopsis}` : '',
      narrativePlan ? `本卷结构化叙事计划：${narrativePlan}` : '',
    ].filter(Boolean).join('\n');
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

  private buildCraftBriefSection(data: ChapterPromptContext): string {
    const brief = this.asRecord(data.chapter.craftBrief);
    if (brief && Object.keys(brief).length > 0) {
      const clues = this.asRecordArray(brief.concreteClues)
        .map((item) => {
          const name = this.text(item.name);
          const sensoryDetail = this.text(item.sensoryDetail);
          const laterUse = this.text(item.laterUse);
          return `- ${name || '未命名线索'}${sensoryDetail ? `：${sensoryDetail}` : ''}${laterUse ? `；后续用途：${laterUse}` : ''}`;
        });
      return [
        '【本章执行卡】',
        '来源：Chapter.craftBrief（结构化字段）。本区块是正文执行契约，优先级高于普通大纲摘要。',
        this.text(brief.visibleGoal) ? `表层目标：${this.text(brief.visibleGoal)}` : '',
        this.text(brief.hiddenEmotion) ? `隐藏情绪：${this.text(brief.hiddenEmotion)}` : '',
        this.text(brief.coreConflict) ? `核心冲突：${this.text(brief.coreConflict)}` : '',
        this.text(brief.mainlineTask) ? `主线任务：${this.text(brief.mainlineTask)}` : '',
        this.stringArray(brief.subplotTasks).length ? `支线任务：${this.stringArray(brief.subplotTasks).join('；')}` : '',
        this.stringArray(brief.actionBeats).length ? ['行动链：', ...this.stringArray(brief.actionBeats).map((item, index) => `${index + 1}. ${item}`)].join('\n') : '',
        clues.length ? ['物证/线索：', ...clues].join('\n') : '',
        this.text(brief.dialogueSubtext) ? `对话潜台词：${this.text(brief.dialogueSubtext)}` : '',
        this.text(brief.characterShift) ? `人物变化：${this.text(brief.characterShift)}` : '',
        this.text(brief.irreversibleConsequence) ? `不可逆后果：${this.text(brief.irreversibleConsequence)}` : '',
        this.stringArray(brief.progressTypes).length ? `推进类型：${this.stringArray(brief.progressTypes).join(' / ')}` : '',
      ].filter(Boolean).join('\n');
    }

    const markdownCard = this.extractExecutionCardMarkdown(data.chapter.outline);
    if (markdownCard) {
      return [
        '【本章执行卡】',
        '来源：Chapter.outline Markdown（旧项目兼容）。本区块是正文执行契约，必须逐项落地。',
        markdownCard,
      ].join('\n');
    }

    return '【本章执行卡】\n- 未提供结构化执行卡；请严格依据章节目标、冲突与大纲写作，并在正文中落下具体行动、线索和后果。';
  }

  private buildContextLayerNotice(): string {
    return [
      '【上下文分层说明】',
      '- 【硬事实】、【Lorebook 命中】、【记忆召回】、【结构化事实召回】来自数据库或程序确定性上下文，可作为已验证上下文使用。',
      '- 【本章用户意图/新增候选】只代表当前写作要求或本章新增候选，不等同于既有世界事实。',
      '- Retrieval Planner 的查询意图、召回诊断和未命中查询默认不进入正文事实区。',
    ].join('\n');
  }

  private buildForeshadowSection(data: ChapterPromptContext): string {
    if (!data.plannedForeshadows.length) return '【本章伏笔计划】\n- 无特定伏笔要求';
    return ['【本章伏笔计划】', ...data.plannedForeshadows.map((item) => `- ${item.title}：${item.detail || item.status}`)].join('\n');
  }

  private buildFactsSection(data: ChapterPromptContext): string {
    return data.hardFacts.length ? ['【硬事实】', ...data.hardFacts.map((fact) => `- ${fact}`)].join('\n') : '【硬事实】\n- 无';
  }

  private buildUserIntentSection(data: ChapterPromptContext): string {
    const instruction = data.contextPack.userIntent.instruction?.trim();
    return [
      '【本章用户意图/新增候选】',
      '- 说明：以下内容来自章节计划或用户明确要求，可用于推进本章，但若与已验证上下文冲突，以已验证上下文为准。',
      `- 用户附加指令：${instruction || '无'}`,
    ].join('\n');
  }

  private buildLorebookSection(data: ChapterPromptContext): string {
    const hits = data.contextPack.verifiedContext.lorebookHits;
    return hits.length ? ['【Lorebook 命中】', ...hits.map((hit) => this.formatRetrievalHit(hit))].join('\n') : '【Lorebook 命中】\n- 无';
  }

  private buildMemorySection(data: ChapterPromptContext): string {
    const hits = data.contextPack.verifiedContext.memoryHits;
    return hits.length ? ['【记忆召回】', ...hits.map((hit) => this.formatRetrievalHit(hit))].join('\n') : '【记忆召回】\n- 无';
  }

  private buildStructuredContextSection(data: ChapterPromptContext): string {
    const hits = data.contextPack.verifiedContext.structuredHits;
    return hits.length ? ['【结构化事实召回】', ...hits.map((hit) => this.formatRetrievalHit(hit))].join('\n') : '【结构化事实召回】\n- 无';
  }

  private formatRetrievalHit(hit: RetrievalHit): string {
    const trace = hit.sourceTrace;
    const chapterPart = typeof trace.chapterNo === 'number' ? `｜chapterNo=${trace.chapterNo}` : '';
    const sourceTag = `sourceType=${trace.sourceType}｜sourceId=${trace.sourceId}｜projectId=${trace.projectId}${chapterPart}｜score=${hit.score.toFixed(3)}｜method=${hit.searchMethod}`;
    return [`- [${sourceTag}] ${hit.title}: ${hit.content}`, `  召回原因：${hit.reason}`].join('\n');
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

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private hasRecordContent(value: unknown): boolean {
    const record = this.asRecord(value);
    return Boolean(record && Object.keys(record).length > 0);
  }

  private formatJsonObject(value: unknown, limit: number): string | undefined {
    const record = this.asRecord(value);
    if (!record || Object.keys(record).length === 0) return undefined;
    const text = JSON.stringify(record);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  private extractExecutionCardMarkdown(outline: string | null | undefined): string | undefined {
    if (!outline?.includes('本章执行卡')) return undefined;
    const start = outline.indexOf('本章执行卡');
    const card = outline.slice(Math.max(0, start - 3)).trim();
    return card.length > 3500 ? `${card.slice(0, 3500)}...` : card;
  }
}
