import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GenerationProfileSnapshot } from '../generation-profile/generation-profile.defaults';
import { RetrievalHit } from '../memory/retrieval.service';
import { ChapterContextPack, PlannedTimelineEvent } from './context-pack.types';

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
  generationProfile?: GenerationProfileSnapshot;
  targetWordCount?: number;
}

export interface BuiltChapterPrompt {
  system: string;
  user: string;
  debug: Record<string, unknown>;
}

const MAX_PREVIOUS_CONTEXT_TOTAL = 15_000;
const MAX_SCENE_CARDS_IN_PROMPT = 8;

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
      this.buildNaturalProseSection(),
      this.buildCharacterSection(context),
      this.buildChapterSection(context),
      this.buildCraftBriefSection(context),
      this.buildSceneExecutionSection(context),
      this.buildPlannedTimelineSection(context),
      this.buildContextLayerNotice(),
      this.buildGenerationProfileSection(context),
      this.buildForeshadowSection(context),
      this.buildFactsSection(context),
      this.buildUserIntentSection(context),
      this.buildLorebookSection(context),
      this.buildMemorySection(context),
      this.buildRelationshipSection(context),
      this.buildTimelineSection(context),
      this.buildWritingRulesSection(context),
      this.buildStructuredContextSection(context),
      this.buildPreviousChaptersSection(context),
    ].join('\n\n');
    const verifiedTimelineHits = context.contextPack.verifiedContext.structuredHits.filter((hit) => hit.sourceType === 'timeline_event');
    const plannedTimelineEvents = context.contextPack.planningContext?.plannedTimelineEvents ?? [];

    return {
      system,
      user,
      debug: {
        promptSource: 'db',
        contextPackVersion: context.contextPack.schemaVersion,
        lorebookCount: context.contextPack.verifiedContext.lorebookHits.length,
        memoryCount: context.contextPack.verifiedContext.memoryHits.length,
        structuredCount: context.contextPack.verifiedContext.structuredHits.length,
        relationshipEdgeCount: context.contextPack.verifiedContext.structuredHits.filter((hit) => hit.sourceType === 'relationship_edge').length,
        timelineEventCount: verifiedTimelineHits.length,
        verifiedTimelineEventCount: verifiedTimelineHits.length,
        plannedTimelineEventCount: plannedTimelineEvents.length,
        timelineLayerCounts: { verifiedActive: verifiedTimelineHits.length, plannedCurrent: plannedTimelineEvents.length },
        verifiedTimelineSourceTrace: verifiedTimelineHits.map((hit) => hit.sourceTrace),
        plannedTimelineSourceTrace: plannedTimelineEvents.map((event) => event.sourceTrace),
        writingRuleCount: context.contextPack.verifiedContext.structuredHits.filter((hit) => hit.sourceType === 'writing_rule').length,
        verifiedContextCount: context.contextPack.verifiedContext.lorebookHits.length + context.contextPack.verifiedContext.memoryHits.length + context.contextPack.verifiedContext.structuredHits.length,
        previousChapterCount: context.previousChapters.length,
        foreshadowCount: context.plannedForeshadows.length,
        sceneCardCount: context.contextPack.planningContext?.sceneCards.length ?? 0,
        sceneCardSourceTrace: context.contextPack.planningContext?.sceneCards.map((scene) => scene.sourceTrace) ?? [],
        hasVolume: Boolean(context.volume),
        hasStyleProfile: Boolean(context.styleProfile),
        hasCraftBrief: this.hasRecordContent(context.chapter.craftBrief),
        generationProfile: context.generationProfile ?? context.contextPack.generationProfile,
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

  private buildNaturalProseSection(): string {
    return [
      '【自然正文约束】',
      '- 这层约束用于修正“AI 味”：正文要先写人物在压力下做事，再写环境和修辞。',
      '- 开场 500 字内必须落到人物目标、阻碍或可见行动；不要用漂亮空镜、天气/天象/世界观解释拖住第一场。',
      '- 描写只保留会改变判断、行动、危险或代价的细节；同一段不要连续堆颜色、气味、触感和比喻。',
      '- 压低修辞密度：少用“像、仿佛、似乎、好像、宛如、如同、细如”；能用器物反应、动作后果表达，就不用比喻。',
      '- 避免独立成段的戏剧化反转短句，如“不是雨。”这类句式；如果必须保留，后一句必须立刻推动行动或选择。',
      '- 语言允许粗粝、短促、不对称和口语化；不要让每句都像精修文案。',
    ].join('\n');
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
      const sceneBeats = this.asRecordArray(brief.sceneBeats)
        .map((item, index) => {
          const participants = this.stringArray(item.participants).join('、');
          const continuity = [
            this.text(item.continuesFromChapterNo) ? `承接第${this.text(item.continuesFromChapterNo)}章` : '',
            this.text(item.continuesToChapterNo) ? `延续到第${this.text(item.continuesToChapterNo)}章` : '',
          ].filter(Boolean).join('，');
          return [
            `${index + 1}. [${this.text(item.sceneArcId) || 'scene'} ${this.text(item.scenePart) || ''}] ${this.text(item.location) || '未标地点'}${participants ? `｜人物：${participants}` : ''}${continuity ? `｜${continuity}` : ''}`,
            `   局部目标：${this.text(item.localGoal) || '未写'}`,
            `   可见行动：${this.text(item.visibleAction) || '未写'}`,
            `   阻力：${this.text(item.obstacle) || '未写'}`,
            `   转折：${this.text(item.turningPoint) || '未写'}`,
            `   场景段结果：${this.text(item.partResult) || '未写'}`,
            `   感官锚点：${this.text(item.sensoryAnchor) || '未写'}`,
          ].join('\n');
        });
      const continuityState = this.asRecord(brief.continuityState);
      const storyUnit = this.asRecord(brief.storyUnit);
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
        storyUnit && Object.keys(storyUnit).length
          ? [
            '单元故事：',
            this.text(storyUnit.unitId) || this.text(storyUnit.title) ? `- 单元：${[this.text(storyUnit.unitId), this.text(storyUnit.title)].filter(Boolean).join(' / ')}` : '',
            this.asRecord(storyUnit.chapterRange) ? `- 覆盖章节：第${this.text(this.asRecord(storyUnit.chapterRange)?.start) || '?'}-${this.text(this.asRecord(storyUnit.chapterRange)?.end) || '?'}章` : '',
            this.text(storyUnit.chapterRole) ? `- 本章角色：${this.text(storyUnit.chapterRole)}` : '',
            this.text(storyUnit.localGoal) ? `- 单元局部目标：${this.text(storyUnit.localGoal)}` : '',
            this.text(storyUnit.localConflict) ? `- 单元核心冲突：${this.text(storyUnit.localConflict)}` : '',
            this.stringArray(storyUnit.serviceFunctions).length ? `- 叙事功能：${this.stringArray(storyUnit.serviceFunctions).join(' / ')}` : '',
            this.text(storyUnit.mainlineContribution) ? `- 主线贡献：${this.text(storyUnit.mainlineContribution)}` : '',
            this.text(storyUnit.characterContribution) ? `- 人物贡献：${this.text(storyUnit.characterContribution)}` : '',
            this.text(storyUnit.relationshipContribution) ? `- 关系贡献：${this.text(storyUnit.relationshipContribution)}` : '',
            this.text(storyUnit.worldOrThemeContribution) ? `- 世界/主题贡献：${this.text(storyUnit.worldOrThemeContribution)}` : '',
            this.text(storyUnit.unitPayoff) ? `- 单元回报：${this.text(storyUnit.unitPayoff)}` : '',
            this.text(storyUnit.stateChangeAfterUnit) ? `- 单元结束状态变化：${this.text(storyUnit.stateChangeAfterUnit)}` : '',
          ].filter(Boolean).join('\n')
          : '',
        this.text(brief.entryState) ? `入场状态：${this.text(brief.entryState)}` : '',
        sceneBeats.length ? ['场景链：', ...sceneBeats].join('\n') : '',
        this.stringArray(brief.actionBeats).length ? ['行动链：', ...this.stringArray(brief.actionBeats).map((item, index) => `${index + 1}. ${item}`)].join('\n') : '',
        clues.length ? ['物证/线索：', ...clues].join('\n') : '',
        this.text(brief.dialogueSubtext) ? `对话潜台词：${this.text(brief.dialogueSubtext)}` : '',
        this.text(brief.characterShift) ? `人物变化：${this.text(brief.characterShift)}` : '',
        this.text(brief.irreversibleConsequence) ? `不可逆后果：${this.text(brief.irreversibleConsequence)}` : '',
        this.text(brief.exitState) ? `离场状态：${this.text(brief.exitState)}` : '',
        this.stringArray(brief.closedLoops).length ? `本章闭合问题：${this.stringArray(brief.closedLoops).join('；')}` : '',
        this.stringArray(brief.openLoops).length ? `留给后文的问题：${this.stringArray(brief.openLoops).join('；')}` : '',
        this.text(brief.handoffToNextChapter) ? `下一章交接：${this.text(brief.handoffToNextChapter)}` : '',
        continuityState && Object.keys(continuityState).length
          ? [
            '连续状态：',
            this.stringArray(continuityState.characterPositions).length ? `- 角色位置：${this.stringArray(continuityState.characterPositions).join('；')}` : '',
            this.stringArray(continuityState.activeThreats).length ? `- 有效威胁：${this.stringArray(continuityState.activeThreats).join('；')}` : '',
            this.stringArray(continuityState.ownedClues).length ? `- 已持有线索：${this.stringArray(continuityState.ownedClues).join('；')}` : '',
            this.stringArray(continuityState.relationshipChanges).length ? `- 关系变化：${this.stringArray(continuityState.relationshipChanges).join('；')}` : '',
            this.text(continuityState.nextImmediatePressure) ? `- 下一紧迫压力：${this.text(continuityState.nextImmediatePressure)}` : '',
          ].filter(Boolean).join('\n')
          : '',
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

  private buildSceneExecutionSection(data: ChapterPromptContext): string {
    const sceneCards = data.contextPack.planningContext?.sceneCards ?? [];
    if (!sceneCards.length) {
      return '【场景执行】\n- 未提供本章场景卡；请依据本章执行卡和章节目标自行组织场景，不要把未登记场景当成已发生事实。';
    }
    const visibleSceneCards = sceneCards.slice(0, MAX_SCENE_CARDS_IN_PROMPT);

    return [
      '【场景执行】',
      '说明：以下 SceneCard 是本章写作计划资产，不是已经发生的正文事实；请按场景顺序落实行动、冲突、线索与结果，并保留可追踪来源。',
      ...(sceneCards.length > MAX_SCENE_CARDS_IN_PROMPT ? [`- SceneCard prompt truncated: showing first ${MAX_SCENE_CARDS_IN_PROMPT} of ${sceneCards.length}; full list remains in retrievalPayload/sourceTrace.`] : []),
      ...visibleSceneCards.map((scene) => this.formatSceneCard(scene)),
    ].join('\n');
  }

  private buildPlannedTimelineSection(data: ChapterPromptContext): string {
    const events = data.contextPack.planningContext?.plannedTimelineEvents ?? [];
    if (!events.length) {
      return '【本章计划时间线】\n- 无本章 planned TimelineEvent；请按章节执行卡和场景计划推进，不要自行补造时间线事实。';
    }
    return [
      '【本章计划时间线】',
      '说明：以下 TimelineEvent 是 current_chapter_planned_timeline，只是本章执行目标，不是已发生事实；不得当作 verified fact、前情事实或已公开知识。',
      ...events.slice(0, 8).map((event) => this.formatPlannedTimelineEvent(event)),
      ...(events.length > 8 ? [`- Planned timeline prompt truncated: showing first 8 of ${events.length}; full list remains in retrievalPayload/sourceTrace.`] : []),
    ].join('\n');
  }

  private buildContextLayerNotice(): string {
    return [
      '【上下文分层说明】',
      '- 【硬事实】、【Lorebook 命中】、【记忆召回】、【结构化事实召回】来自数据库或程序确定性上下文，可作为已验证上下文使用。',
      '- 【本章用户意图/新增候选】只代表当前写作要求或本章新增候选，不等同于既有世界事实。',
      '- Retrieval Planner 的查询意图、召回诊断和未命中查询默认不进入正文事实区。',
    ].join('\n');
  }

  private buildGenerationProfileSection(data: ChapterPromptContext): string {
    const profile = data.generationProfile ?? data.contextPack.generationProfile;
    if (!profile) return '【新增事实策略】\n- 允许新增候选：地点、伏笔\n- 禁止新增事实：角色';

    const allowed = [
      ...(profile.allowNewCharacters ? ['角色'] : []),
      ...(profile.allowNewLocations ? ['地点'] : []),
      ...(profile.allowNewForeshadows ? ['伏笔'] : []),
    ];
    const forbidden = [
      ...(!profile.allowNewCharacters ? ['角色'] : []),
      ...(!profile.allowNewLocations ? ['地点'] : []),
      ...(!profile.allowNewForeshadows ? ['伏笔'] : []),
    ];

    return [
      '【新增事实策略】',
      `- 允许新增候选：${allowed.length ? allowed.join('、') : '无'}`,
      `- 禁止新增事实：${forbidden.length ? forbidden.join('、') : '无'}`,
      forbidden.length ? '- 禁止项不得被写成已验证世界事实；如剧情必须触及，只能作为待复核候选处理。' : '',
    ].filter(Boolean).join('\n');
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

  private buildRelationshipSection(data: ChapterPromptContext): string {
    const hits = this.structuredHitsByType(data, 'relationship_edge').slice(0, 4);
    return hits.length ? ['【人物关系网】', ...hits.map((hit) => this.formatRetrievalHit(hit, 650))].join('\n') : '【人物关系网】\n- 无';
  }

  private buildTimelineSection(data: ChapterPromptContext): string {
    const hits = this.structuredHitsByType(data, 'timeline_event').slice(0, 4);
    return hits.length ? ['【时间线与角色知情范围】', ...hits.map((hit) => this.formatRetrievalHit(hit, 700))].join('\n') : '【时间线与角色知情范围】\n- 无';
  }

  private buildWritingRulesSection(data: ChapterPromptContext): string {
    const hits = this.structuredHitsByType(data, 'writing_rule').slice(0, 5);
    return hits.length ? ['【写作约束】', ...hits.map((hit) => this.formatRetrievalHit(hit, 650))].join('\n') : '【写作约束】\n- 无';
  }

  private buildStructuredContextSection(data: ChapterPromptContext): string {
    const hits = data.contextPack.verifiedContext.structuredHits.filter((hit) => !['relationship_edge', 'timeline_event', 'writing_rule'].includes(hit.sourceType));
    return hits.length ? ['【结构化事实召回】', ...hits.map((hit) => this.formatRetrievalHit(hit))].join('\n') : '【结构化事实召回】\n- 无';
  }

  private formatSceneCard(scene: NonNullable<ChapterContextPack['planningContext']>['sceneCards'][number]): string {
    const trace = scene.sourceTrace;
    const traceParts = [
      `sourceType=${trace.sourceType}`,
      `sourceId=${trace.sourceId}`,
      `projectId=${trace.projectId}`,
      trace.chapterNo !== undefined ? `chapterNo=${trace.chapterNo}` : '',
      trace.sceneNo !== undefined && trace.sceneNo !== null ? `sceneNo=${trace.sceneNo}` : '',
    ].filter(Boolean).join('｜');
    const fields = [
      scene.locationName ? `地点：${scene.locationName}` : '',
      scene.participants.length ? `参与者：${scene.participants.join('、')}` : '',
      scene.purpose ? `目的：${scene.purpose}` : '',
      scene.conflict ? `冲突：${scene.conflict}` : '',
      scene.emotionalTone ? `情绪：${scene.emotionalTone}` : '',
      scene.keyInformation ? `关键信息：${scene.keyInformation}` : '',
      scene.result ? `结果：${scene.result}` : '',
      scene.relatedForeshadowIds.length ? `relatedForeshadowIds：${scene.relatedForeshadowIds.join('、')}` : '',
      this.formatJsonObject(scene.metadata, 700) ? `metadata：${this.formatJsonObject(scene.metadata, 700)}` : '',
      `状态：${scene.status}`,
    ].filter(Boolean);
    return [`- [${traceParts}] ${scene.sceneNo ?? '?'}｜${scene.title}`, ...fields.map((field) => `  ${field}`)].join('\n');
  }

  private formatPlannedTimelineEvent(event: PlannedTimelineEvent): string {
    const trace = event.sourceTrace;
    const traceParts = [
      `sourceType=${trace.sourceType}`,
      `sourceId=${trace.sourceId}`,
      `projectId=${trace.projectId}`,
      trace.chapterNo !== undefined && trace.chapterNo !== null ? `chapterNo=${trace.chapterNo}` : '',
      `eventStatus=${trace.eventStatus}`,
      trace.sourceKind ? `sourceKind=${trace.sourceKind}` : '',
    ].filter(Boolean).join('｜');
    const fields = [
      event.eventTime ? `时间：${event.eventTime}` : '',
      event.locationName ? `地点：${event.locationName}` : '',
      event.participants.length ? `参与者：${event.participants.join('、')}` : '',
      event.cause ? `原因：${event.cause}` : '',
      event.result ? `结果：${event.result}` : '',
      event.impactScope ? `影响范围：${event.impactScope}` : '',
      `是否公开：${event.isPublic ? '是' : '否'}`,
      event.knownBy.length ? `知情者：${event.knownBy.join('、')}` : '',
      event.unknownBy.length ? `未知者：${event.unknownBy.join('、')}` : '',
      `sourceType：${event.sourceType}`,
    ].filter(Boolean);
    return [`- [${traceParts}] ${event.title}`, ...fields.map((field) => `  ${field}`)].join('\n');
  }

  private structuredHitsByType(data: ChapterPromptContext, sourceType: RetrievalHit['sourceType']): RetrievalHit[] {
    return data.contextPack.verifiedContext.structuredHits.filter((hit) => hit.sourceType === sourceType);
  }

  private formatRetrievalHit(hit: RetrievalHit, maxContent = 1200): string {
    const trace = hit.sourceTrace;
    const chapterPart = typeof trace.chapterNo === 'number' ? `｜chapterNo=${trace.chapterNo}` : '';
    const sourceTag = `sourceType=${trace.sourceType}｜sourceId=${trace.sourceId}｜projectId=${trace.projectId}${chapterPart}｜score=${hit.score.toFixed(3)}｜method=${hit.searchMethod}`;
    const content = hit.content.length > maxContent ? `${hit.content.slice(0, maxContent)}...` : hit.content;
    return [`- [${sourceTag}] ${hit.title}: ${content}`, `  召回原因：${hit.reason}`].join('\n');
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
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
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
