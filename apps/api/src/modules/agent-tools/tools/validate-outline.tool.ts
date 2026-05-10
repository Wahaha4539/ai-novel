import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { assertChapterCharacterExecution, VolumeCharacterPlan } from './outline-character-contracts';
import { assertVolumeNarrativePlan } from './outline-narrative-contracts';

interface ValidateOutlineInput {
  preview?: OutlinePreviewOutput;
}

type OutlineValidationSeverity = 'warning' | 'error';

interface OutlineValidationIssue {
  severity: OutlineValidationSeverity;
  message: string;
  suggestion?: string;
}

interface CharacterValidationStats {
  volumeCharacterCandidateCount: number;
  chapterCharacterExecutionCount: number;
  characterExecutionMissingCount: number;
  unknownCharacterReferenceCount: number;
  temporaryCharacterCount: number;
  characterRiskCount: number;
}

interface CharacterCatalog {
  existingCharacterNames: string[];
  existingCharacterAliases: Record<string, string[]>;
}

export interface ValidateOutlineOutput {
  valid: boolean;
  issueCount: number;
  issues: OutlineValidationIssue[];
  stats: {
    chapterCount: number;
    expectedChapterCount?: number;
    duplicatedChapterNos: number[];
    totalExpectedWordCount: number;
    craftBriefCount: number;
    craftBriefMissingCount: number;
    storyUnitCount: number;
    storyUnitMissingCount: number;
    sceneBeatCount: number;
    continuityMissingCount: number;
    volumeCharacterCandidateCount: number;
    chapterCharacterExecutionCount: number;
    characterExecutionMissingCount: number;
    unknownCharacterReferenceCount: number;
    temporaryCharacterCount: number;
    characterRiskCount: number;
  };
  sourceRisks: string[];
  writePreview?: {
    volume: { action: 'create' | 'update'; volumeNo?: number; existingTitle?: string | null; nextTitle?: string };
    summary: { createCount: number; updateCount: number; skipCount: number };
    chapters: Array<{ chapterNo: number; title: string; action: 'create' | 'update_planned' | 'skip_existing_content'; existingStatus?: string | null }>;
  };
}

/**
 * 大纲预览校验工具：在持久化前检查章节编号、必填字段、字数和连续性风险。
 * 该工具只读取上游 preview，不写业务数据，用于提前暴露可人工修正的问题。
 */
@Injectable()
export class ValidateOutlineTool implements BaseTool<ValidateOutlineInput, ValidateOutlineOutput> {
  name = 'validate_outline';
  description = '校验大纲预览的章节编号、必填字段、字数和连续性风险。';
  inputSchema = { type: 'object' as const, properties: { preview: { type: 'object' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'stats', 'sourceRisks'],
    properties: { valid: { type: 'boolean' as const }, issueCount: { type: 'number' as const }, issues: { type: 'array' as const }, stats: { type: 'object' as const }, sourceRisks: { type: 'array' as const, items: { type: 'string' as const } } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateOutlineInput, _context: ToolContext): Promise<ValidateOutlineOutput> {
    const issues: OutlineValidationIssue[] = [];
    const characterStats = this.createCharacterStats();
    const preview = args.preview;

    if (!preview) {
      issues.push({ severity: 'error', message: '缺少大纲预览，无法执行写入前校验。', suggestion: '请先重新生成大纲预览。' });
      return this.buildOutput(issues, [], undefined, [], characterStats);
    }

    const chapters = preview.chapters ?? [];
    const characterCatalog = await this.loadCharacterCatalog(_context.projectId);
    if (!chapters.length) {
      issues.push({ severity: 'error', message: '大纲预览中没有章节。', suggestion: '至少需要 1 个章节才能写入卷和章节表。' });
    }

    if (!Number.isFinite(preview.volume?.volumeNo) || preview.volume.volumeNo <= 0) {
      issues.push({ severity: 'error', message: '卷号必须是正数。', suggestion: '请重新生成或手动修正 volume.volumeNo。' });
    }

    const expectedChapterCount = preview.volume?.chapterCount;
    if (expectedChapterCount && expectedChapterCount !== chapters.length) {
      issues.push({ severity: 'error', message: `卷声明章节数为 ${expectedChapterCount}，但实际预览为 ${chapters.length} 章。`, suggestion: '请重新生成完整章节细纲，不要写入数量不一致的预览。' });
    }

    const characterPlan = this.validateVolumeCharacterPlan(preview, characterCatalog, issues, characterStats);

    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo));
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapterNos);
    if (duplicatedChapterNos.length) {
      issues.push({ severity: 'error', message: `存在重复章节编号：${duplicatedChapterNos.join(', ')}。`, suggestion: '章节编号重复会导致写入时覆盖判断不清晰，请先修正。' });
    }

    const sortedNos = [...new Set(chapterNos.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    if (sortedNos.length > 1 && sortedNos.some((value, index) => index > 0 && value !== sortedNos[index - 1] + 1)) {
      issues.push({ severity: 'error', message: '章节编号不连续。', suggestion: '请重新生成连续 chapterNo，避免跨章交接和持久化错位。' });
    }

    const duplicatedTitles = this.findDuplicatedTexts(chapters.map((chapter) => this.normalizeChapterTitle(this.text(chapter.title))));
    if (duplicatedTitles.length) {
      issues.push({
        severity: 'warning',
        message: `存在重复章节标题：${duplicatedTitles.join('、')}。`,
        suggestion: '建议在写入前重新生成或手动区分标题，避免章节导航和后续定位混淆。',
      });
    }

    chapters.forEach((chapter, index) => {
      const label = `第 ${chapter.chapterNo || index + 1} 章`;
      if (!Number.isFinite(Number(chapter.chapterNo)) || Number(chapter.chapterNo) <= 0) {
        issues.push({ severity: 'error', message: `${label} 的 chapterNo 必须是正数。` });
      }
      if (!this.text(chapter.title).trim()) issues.push({ severity: 'error', message: `${label} 缺少标题。`, suggestion: '请重新生成或补充标题。' });
      if (!this.text(chapter.objective).trim()) issues.push({ severity: 'error', message: `${label} 缺少目标。`, suggestion: '请补充具体可检验的 objective。' });
      if (!this.text(chapter.conflict).trim()) issues.push({ severity: 'error', message: `${label} 缺少冲突。`, suggestion: '请补充阻力来源和阻力方式。' });
      if (!this.text(chapter.outline).trim()) issues.push({ severity: 'error', message: `${label} 缺少章节梗概。`, suggestion: '请补充具体场景链后再写入。' });
      this.validateOutlineDensity(chapter.outline, label, issues);
      if (!Number.isFinite(Number(chapter.expectedWordCount)) || Number(chapter.expectedWordCount) <= 0) {
        issues.push({ severity: 'error', message: `${label} 的 expectedWordCount 无效。`, suggestion: '请设置一个正数字数目标。' });
      } else if (Number(chapter.expectedWordCount) < 500) {
        issues.push({ severity: 'warning', message: `${label} 的预期字数偏低。`, suggestion: '如非短篇/片段，建议提高到更合理的章节字数。' });
      }
      this.validateCraftBrief(chapter.craftBrief, label, issues);
      this.validateChapterCharacterExecution(chapter, label, characterPlan, characterCatalog, issues, characterStats);
    });

    const writePreview = await this.buildWritePreview(preview, _context);
    return this.buildOutput(issues, chapters, expectedChapterCount, preview.risks ?? [], characterStats, writePreview);
  }

  /** 统一构建输出，确保前端和 report_result 都能稳定读取 issueCount/stats。 */
  private buildOutput(issues: OutlineValidationIssue[], chapters: OutlinePreviewOutput['chapters'], expectedChapterCount: number | undefined, sourceRisks: string[], characterStats: CharacterValidationStats, writePreview?: ValidateOutlineOutput['writePreview']): ValidateOutlineOutput {
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapters.map((chapter) => Number(chapter.chapterNo)));
    const craftBriefCount = chapters.filter((chapter) => Object.keys(this.asRecord(chapter.craftBrief)).length > 0).length;
    const storyUnitCount = chapters.filter((chapter) => Object.keys(this.asRecord(this.asRecord(chapter.craftBrief).storyUnit)).length > 0).length;
    const sceneBeatCount = chapters.reduce((sum, chapter) => sum + this.asRecordArray(this.asRecord(chapter.craftBrief).sceneBeats).length, 0);
    const continuityMissingCount = chapters.filter((chapter) => !this.hasContinuityFields(this.asRecord(chapter.craftBrief))).length;
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      stats: {
        chapterCount: chapters.length,
        expectedChapterCount,
        duplicatedChapterNos,
        totalExpectedWordCount: chapters.reduce((sum, chapter) => sum + (Number(chapter.expectedWordCount) || 0), 0),
        craftBriefCount,
        craftBriefMissingCount: Math.max(0, chapters.length - craftBriefCount),
        storyUnitCount,
        storyUnitMissingCount: Math.max(0, chapters.length - storyUnitCount),
        sceneBeatCount,
        continuityMissingCount,
        ...characterStats,
      },
      sourceRisks,
      ...(writePreview ? { writePreview } : {}),
    };
  }

  /**
   * 在 Plan 阶段提前派生写入 diff，让审批台能说明哪些章节会创建、更新或跳过。
   * 这里只读数据库，不改变正式业务数据；真正写入仍由 persist_outline 在 Act 阶段执行。
   */
  private createCharacterStats(): CharacterValidationStats {
    return {
      volumeCharacterCandidateCount: 0,
      chapterCharacterExecutionCount: 0,
      characterExecutionMissingCount: 0,
      unknownCharacterReferenceCount: 0,
      temporaryCharacterCount: 0,
      characterRiskCount: 0,
    };
  }

  private validateVolumeCharacterPlan(
    preview: OutlinePreviewOutput,
    characterCatalog: CharacterCatalog,
    issues: OutlineValidationIssue[],
    stats: CharacterValidationStats,
  ): VolumeCharacterPlan | undefined {
    try {
      const narrativePlan = assertVolumeNarrativePlan(preview.volume?.narrativePlan, {
        chapterCount: Number(preview.volume?.chapterCount),
        existingCharacterNames: characterCatalog.existingCharacterNames,
        existingCharacterAliases: characterCatalog.existingCharacterAliases,
        label: 'volume.narrativePlan',
      });
      const characterPlan = narrativePlan.characterPlan as VolumeCharacterPlan;
      stats.volumeCharacterCandidateCount = characterPlan.newCharacterCandidates.length;
      return characterPlan;
    } catch (error) {
      this.addCharacterIssue(
        issues,
        stats,
        `volume.narrativePlan invalid: ${this.errorMessage(error)}`,
        'Regenerate the outline preview with a complete volume narrativePlan and characterPlan before approval or persist.',
      );
      return undefined;
    }
  }

  private validateChapterCharacterExecution(
    chapter: OutlinePreviewOutput['chapters'][number],
    label: string,
    characterPlan: VolumeCharacterPlan | undefined,
    characterCatalog: CharacterCatalog,
    issues: OutlineValidationIssue[],
    stats: CharacterValidationStats,
  ): void {
    const craftBrief = this.asRecord(chapter.craftBrief);
    const characterExecution = this.asRecord(craftBrief.characterExecution);
    if (!Object.keys(characterExecution).length) {
      stats.characterExecutionMissingCount += 1;
      this.addCharacterIssue(
        issues,
        stats,
        `${label} missing craftBrief.characterExecution.`,
        'Regenerate this chapter outline with POV, cast, relationshipBeats, and newMinorCharacters.',
      );
      return;
    }

    if (!characterPlan) return;

    try {
      const execution = assertChapterCharacterExecution(characterExecution, {
        existingCharacterNames: characterCatalog.existingCharacterNames,
        existingCharacterAliases: characterCatalog.existingCharacterAliases,
        volumeCandidateNames: characterPlan.newCharacterCandidates.map((candidate) => candidate.name),
        sceneBeats: this.asRecordArray(craftBrief.sceneBeats).map((sceneBeat) => ({
          sceneArcId: this.text(sceneBeat.sceneArcId),
          participants: this.stringArray(sceneBeat.participants),
        })),
        actionBeatCount: this.stringArray(craftBrief.actionBeats).length,
        label: `${label}.craftBrief.characterExecution`,
      });
      stats.chapterCharacterExecutionCount += 1;
      stats.temporaryCharacterCount += execution.newMinorCharacters.length;
    } catch (error) {
      this.addCharacterIssue(
        issues,
        stats,
        `${label}.craftBrief.characterExecution invalid: ${this.errorMessage(error)}`,
        'Regenerate the chapter with cast sources that resolve to existing characters, volume candidates, or declared minor temporary characters.',
      );
    }
  }

  private addCharacterIssue(
    issues: OutlineValidationIssue[],
    stats: CharacterValidationStats,
    message: string,
    suggestion: string,
  ): void {
    stats.characterRiskCount += 1;
    if (this.isUnknownCharacterIssue(message)) stats.unknownCharacterReferenceCount += 1;
    issues.push({ severity: 'error', message, suggestion });
  }

  private isUnknownCharacterIssue(message: string): boolean {
    return /unknown|not registered|not listed|not covered|candidate|未知|未进入|未出现在|未被|候选/i.test(message);
  }

  private async loadCharacterCatalog(projectId: string): Promise<CharacterCatalog> {
    const characterModel = (this.prisma as unknown as {
      character?: { findMany?: (args: unknown) => Promise<Array<{ name: string; alias?: unknown }>> };
    }).character;
    if (!characterModel?.findMany) return { existingCharacterNames: [], existingCharacterAliases: {} };

    const characters = await characterModel.findMany({
      where: { projectId },
      select: { name: true, alias: true },
    });
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const character of characters) {
      const aliases = Array.isArray(character.alias)
        ? character.alias.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        : [];
      if (aliases.length) existingCharacterAliases[character.name] = aliases;
    }
    return {
      existingCharacterNames: characters.map((character) => character.name).filter(Boolean),
      existingCharacterAliases,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async buildWritePreview(preview: OutlinePreviewOutput, context: ToolContext): Promise<ValidateOutlineOutput['writePreview']> {
    const validChapterNos = preview.chapters.map((chapter) => Number(chapter.chapterNo)).filter((value) => Number.isFinite(value) && value > 0);
    const [existingVolume, existingChapters] = await Promise.all([
      this.prisma.volume.findUnique({ where: { projectId_volumeNo: { projectId: context.projectId, volumeNo: preview.volume.volumeNo } }, select: { title: true } }),
      validChapterNos.length
        ? this.prisma.chapter.findMany({ where: { projectId: context.projectId, chapterNo: { in: validChapterNos } }, select: { chapterNo: true, status: true, title: true } })
        : Promise.resolve([]),
    ]);
    const existingByNo = new Map(existingChapters.map((chapter) => [chapter.chapterNo, chapter]));
    const chapters = preview.chapters.map((chapter) => {
      const existing = existingByNo.get(Number(chapter.chapterNo));
      const action: 'create' | 'update_planned' | 'skip_existing_content' = !existing ? 'create' : existing.status === 'planned' ? 'update_planned' : 'skip_existing_content';
      return { chapterNo: Number(chapter.chapterNo), title: this.text(chapter.title), action, existingStatus: existing?.status ?? null };
    });
    return {
      volume: { action: existingVolume ? 'update' : 'create', volumeNo: preview.volume.volumeNo, existingTitle: existingVolume?.title ?? null, nextTitle: preview.volume.title },
      summary: {
        createCount: chapters.filter((chapter) => chapter.action === 'create').length,
        updateCount: chapters.filter((chapter) => chapter.action === 'update_planned').length,
        skipCount: chapters.filter((chapter) => chapter.action === 'skip_existing_content').length,
      },
      chapters,
    };
  }

  private findDuplicatedNumbers(values: number[]): number[] {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    values.forEach((value) => {
      if (!Number.isFinite(value)) return;
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a - b);
  }

  private findDuplicatedTexts(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.forEach((value) => {
      const normalized = value.trim();
      if (!normalized) return;
      if (seen.has(normalized)) duplicated.add(normalized);
      seen.add(normalized);
    });
    return [...duplicated].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  private normalizeChapterTitle(value: string): string {
    return value.trim().replace(/^第\s*\d+\s*章\s*[：:、.\-]?\s*/, '');
  }

  private validateCraftBrief(value: unknown, label: string, issues: OutlineValidationIssue[]) {
    const brief = this.asRecord(value);
    if (!Object.keys(brief).length) {
      issues.push({
        severity: 'error',
        message: `${label} 缺少 craftBrief 执行卡。`,
        suggestion: '请重新生成包含 craftBrief 的章节细纲；不要把缺执行卡的内容写入审批链路。',
      });
      return;
    }
    if (!this.text(brief.visibleGoal).trim()) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.visibleGoal 为空。`, suggestion: '补充可被正文检验的表层目标。' });
    }
    if (!this.text(brief.coreConflict).trim()) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.coreConflict 为空。`, suggestion: '补充阻力来源和阻力方式。' });
    }
    const actionBeats = this.stringArray(brief.actionBeats);
    if (actionBeats.length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.actionBeats 少于 3 个节点。`, suggestion: '行动链必须至少包含起手行动、正面受阻、阶段结果。' });
    }
    this.validateSceneBeats(brief.sceneBeats, label, issues);
    const clues = this.asRecordArray(brief.concreteClues).filter((item) => this.text(item.name).trim());
    if (!clues.length) {
      issues.push({ severity: 'error', message: `${label} 缺少 craftBrief.concreteClues。`, suggestion: '至少补 1 个具象线索、物证或可回收细节。' });
    }
    clues.forEach((clue, index) => {
      if (!this.text(clue.sensoryDetail).trim()) issues.push({ severity: 'error', message: `${label} 的 craftBrief.concreteClues[${index}].sensoryDetail 为空。`, suggestion: '线索必须有可见、可触、可听或可闻的感官细节。' });
      if (!this.text(clue.laterUse).trim()) issues.push({ severity: 'error', message: `${label} 的 craftBrief.concreteClues[${index}].laterUse 为空。`, suggestion: '线索必须说明后续用途或回收方式。' });
    });
    if (!this.text(brief.irreversibleConsequence).trim()) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.irreversibleConsequence 为空。`, suggestion: '结尾后果应改变事实、关系、资源、地位、规则或危险等级之一。' });
    }
    this.validateStoryUnit(brief.storyUnit, label, issues);
    this.validateContinuityFields(brief, label, issues);
  }

  private validateStoryUnit(value: unknown, label: string, issues: OutlineValidationIssue[]) {
    const storyUnit = this.asRecord(value);
    if (!Object.keys(storyUnit).length) {
      issues.push({
        severity: 'error',
        message: `${label} 缺少 craftBrief.storyUnit。`,
        suggestion: '请把每章归入 3-5 章的单元故事，并写清这个单元如何服务主线、人物、关系和世界/主题。',
      });
      return;
    }
    const requiredTextFields = [
      'unitId',
      'title',
      'chapterRole',
      'localGoal',
      'localConflict',
      'mainlineContribution',
      'characterContribution',
      'relationshipContribution',
      'worldOrThemeContribution',
      'unitPayoff',
      'stateChangeAfterUnit',
    ];
    requiredTextFields.forEach((field) => {
      if (!this.text(storyUnit[field]).trim()) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.${field} 为空。`, suggestion: '单元故事必须有可执行的局部故事弧和叙事功能说明。' });
      }
    });
    const chapterRange = this.asRecord(storyUnit.chapterRange);
    const start = Number(chapterRange.start);
    const end = Number(chapterRange.end);
    if (!Number.isInteger(start) || start <= 0 || !Number.isInteger(end) || end < start) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.chapterRange 无效。`, suggestion: 'chapterRange 必须写成正整数 start/end，例如 {"start":1,"end":4}。' });
    }
    const serviceFunctions = this.stringArray(storyUnit.serviceFunctions);
    if (serviceFunctions.length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.serviceFunctions 少于 3 项。`, suggestion: '至少标明主线推进、人物塑造、关系变化、世界观、主题、反派压力、伏笔、节奏或资源代价中的 3 项功能。' });
    }
  }

  private validateOutlineDensity(value: unknown, label: string, issues: OutlineValidationIssue[]) {
    const outline = this.text(value).trim();
    if (!outline) return;
    if (outline.length < 60) {
      issues.push({ severity: 'error', message: `${label} 的 outline 过短，缺少可执行场景链。`, suggestion: 'outline 至少写出 3 个场景段，每段包含地点、行动、阻力和结果。' });
    }
  }

  private validateSceneBeats(value: unknown, label: string, issues: OutlineValidationIssue[]) {
    const sceneBeats = this.asRecordArray(value);
    if (sceneBeats.length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.sceneBeats 少于 3 个场景段。`, suggestion: '每章至少拆成 3 个可连续写正文的场景段；跨章场景用 sceneArcId 串联。' });
      return;
    }
    const requiredFields = ['sceneArcId', 'scenePart', 'location', 'localGoal', 'visibleAction', 'obstacle', 'turningPoint', 'partResult', 'sensoryAnchor'];
    sceneBeats.forEach((beat, index) => {
      requiredFields.forEach((field) => {
        if (!this.text(beat[field]).trim()) {
          issues.push({ severity: 'error', message: `${label} 的 craftBrief.sceneBeats[${index}].${field} 为空。`, suggestion: '场景段必须能回答地点、动作、阻力、转折、结果和感官锚点。' });
        }
      });
      if (!this.stringArray(beat.participants).length) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.sceneBeats[${index}].participants 为空。`, suggestion: '场景段必须列出参与人物。' });
      }
    });
  }

  private validateContinuityFields(brief: Record<string, unknown>, label: string, issues: OutlineValidationIssue[]) {
    const requiredTextFields = ['entryState', 'exitState', 'handoffToNextChapter'];
    requiredTextFields.forEach((field) => {
      if (!this.text(brief[field]).trim()) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.${field} 为空。`, suggestion: '章节必须写清入场状态、离场状态和下一章交接。' });
      }
    });
    if (!this.stringArray(brief.openLoops).length) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.openLoops 为空。`, suggestion: '请列出至少 1 个留给后续章节的问题或压力。' });
    }
    if (!this.stringArray(brief.closedLoops).length) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.closedLoops 为空。`, suggestion: '请列出至少 1 个本章阶段性解决的问题。' });
    }
    const continuityState = this.asRecord(brief.continuityState);
    if (!this.text(continuityState.nextImmediatePressure).trim()) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.continuityState.nextImmediatePressure 为空。`, suggestion: '请写清下一章最紧迫压力。' });
    }
    const hasConcreteState = ['characterPositions', 'activeThreats', 'ownedClues', 'relationshipChanges']
      .some((field) => this.stringArray(continuityState[field]).length > 0);
    if (!hasConcreteState) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.continuityState 缺少连续状态。`, suggestion: '请至少提供角色位置、有效威胁、已持有线索或关系变化之一。' });
    }
  }

  private hasContinuityFields(brief: Record<string, unknown>) {
    return Boolean(
      this.text(brief.entryState).trim()
      && this.text(brief.exitState).trim()
      && this.text(brief.handoffToNextChapter).trim()
      && this.asRecordArray(brief.sceneBeats).length >= 3
      && this.text(this.asRecord(brief.continuityState).nextImmediatePressure).trim(),
    );
  }

  /** 将上游 LLM 预览字段安全转换为文本，避免非字符串内容导致校验阶段 500。 */
  private text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0)
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }
}
