import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  GUIDED_STEP_JSON_SCHEMAS,
  getGuidedStepJsonSchema,
  type GuidedStepSchemaKey,
} from '../../guided/guided-step-schemas';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { assertChapterCharacterExecution, type VolumeCharacterPlan } from './outline-character-contracts';
import { assertVolumeNarrativePlan } from './outline-narrative-contracts';

interface ValidateGuidedStepPreviewInput {
  stepKey?: string;
  structuredData?: Record<string, unknown>;
  volumeNo?: number;
}

type GuidedStepValidationSeverity = 'warning' | 'error';

interface GuidedStepValidationIssue {
  severity: GuidedStepValidationSeverity;
  message: string;
  path?: string;
}

interface GuidedCharacterValidationContext {
  existingCharacterNames: string[];
  existingCharacterAliases: Record<string, string[]>;
  volumePlansByNo: Map<number, VolumeCharacterPlan>;
}

export interface ValidateGuidedStepPreviewOutput {
  valid: boolean;
  issueCount: number;
  issues: GuidedStepValidationIssue[];
  writePreview: Record<string, unknown>;
}

const GUIDED_STEP_KEYS = Object.keys(GUIDED_STEP_JSON_SCHEMAS) as GuidedStepSchemaKey[];

/**
 * 创作引导步骤预览校验工具：只读检查结构化预览是否适合进入审批写入。
 * 真正持久化必须由后续 persist_guided_step_result 在用户审批后执行。
 */
@Injectable()
export class ValidateGuidedStepPreviewTool implements BaseTool<ValidateGuidedStepPreviewInput, ValidateGuidedStepPreviewOutput> {
  name = 'validate_guided_step_preview';
  description = '校验创作引导步骤预览是否可写入，并生成审批前写入 diff。';
  inputSchema = {
    type: 'object' as const,
    required: ['stepKey', 'structuredData'],
    additionalProperties: false,
    properties: {
      stepKey: { type: 'string' as const, enum: GUIDED_STEP_KEYS },
      structuredData: { type: 'object' as const },
      volumeNo: { type: 'number' as const, minimum: 1, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'writePreview'],
    properties: {
      valid: { type: 'boolean' as const },
      issueCount: { type: 'number' as const },
      issues: { type: 'array' as const },
      writePreview: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '校验创作引导步骤预览',
    description: '检查 guided step 结构化预览的缺字段、重复编号和写入风险，并生成审批前 diff；工具只读且不持久化。',
    whenToUse: ['generate_guided_step_preview 之后', 'guided_step_finalize 写入前', '需要展示创作引导步骤写入前校验结果和 diff'],
    whenNotToUse: ['用户只是咨询当前步骤填写建议', '还没有 structuredData 预览', '不能替代 persist_guided_step_result 的审批后写入'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      stepKey: { source: 'previous_step', description: '来自 generate_guided_step_preview.stepKey 或 context.session.guided.currentStep。' },
      structuredData: { source: 'previous_step', description: '来自 generate_guided_step_preview.structuredData。' },
      volumeNo: { source: 'context', description: '章节细纲按卷写入时的目标卷号；缺省表示全量章节预览。' },
    },
    examples: [
      {
        user: '把刚生成的基础设定保存前先检查一下。',
        context: { session: { guided: { currentStep: 'guided_setup' } } },
        plan: [
          { tool: 'generate_guided_step_preview', args: { stepKey: 'guided_setup', userHint: '{{user_message}}' } },
          { tool: 'validate_guided_step_preview', args: { stepKey: 'guided_setup', structuredData: '{{steps.1.output.structuredData}}' } },
        ],
      },
    ],
    failureHints: [
      { code: 'VALIDATION_FAILED', meaning: '预览存在缺字段、重复编号或无法安全写入的问题。', suggestedRepair: '修正 structuredData 后重新校验，再进入审批写入。' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateGuidedStepPreviewInput, context: ToolContext): Promise<ValidateGuidedStepPreviewOutput> {
    const issues: GuidedStepValidationIssue[] = [];
    const stepKey = this.text(args.stepKey);
    const structuredData = this.asRecord(args.structuredData);

    if (!stepKey) {
      issues.push({ severity: 'error', message: '缺少 stepKey，无法校验创作引导步骤预览。', path: 'stepKey' });
      return this.buildOutput(issues, this.emptyWritePreview(stepKey));
    }

    if (!getGuidedStepJsonSchema(stepKey)) {
      issues.push({ severity: 'error', message: `未知创作引导步骤：${stepKey}。`, path: 'stepKey' });
      return this.buildOutput(issues, this.emptyWritePreview(stepKey));
    }

    if (!structuredData) {
      issues.push({ severity: 'error', message: '缺少 structuredData，无法校验创作引导步骤预览。', path: 'structuredData' });
      return this.buildOutput(issues, this.emptyWritePreview(stepKey));
    }

    const guidedStepKey = stepKey as GuidedStepSchemaKey;
    const characterContext = await this.buildCharacterValidationContext(guidedStepKey, structuredData, args.volumeNo, context);
    this.validateByStep(guidedStepKey, structuredData, args.volumeNo, issues, characterContext);
    const writePreview = await this.buildWritePreview(guidedStepKey, structuredData, args.volumeNo, context);

    return this.buildOutput(issues, writePreview);
  }

  private validateByStep(
    stepKey: GuidedStepSchemaKey,
    data: Record<string, unknown>,
    volumeNo: number | undefined,
    issues: GuidedStepValidationIssue[],
    characterContext: GuidedCharacterValidationContext,
  ) {
    switch (stepKey) {
      case 'guided_setup':
        this.validateProjectProfile(data, issues);
        break;
      case 'guided_style':
        this.validateStyleProfile(data, issues);
        break;
      case 'guided_characters':
        this.validateCharacters(data, issues);
        break;
      case 'guided_outline':
        this.validateOutline(data, issues);
        break;
      case 'guided_volume':
        this.validateVolumes(data, issues, characterContext);
        break;
      case 'guided_chapter':
        this.validateChapters(data, volumeNo, issues, characterContext);
        break;
      case 'guided_foreshadow':
        this.validateForeshadow(data, issues);
        break;
    }
  }

  private validateProjectProfile(data: Record<string, unknown>, issues: GuidedStepValidationIssue[]) {
    const fields = ['genre', 'theme', 'tone', 'logline', 'synopsis'];
    this.warnMissingTextFields(data, fields, 'structuredData', issues);
    if (!fields.some((field) => this.text(data[field]))) {
      issues.push({ severity: 'error', message: '基础设定预览没有任何可写入字段。', path: 'structuredData' });
    }
  }

  private validateStyleProfile(data: Record<string, unknown>, issues: GuidedStepValidationIssue[]) {
    const fields = ['pov', 'tense', 'proseStyle', 'pacing'];
    this.warnMissingTextFields(data, fields, 'structuredData', issues);
    if (!fields.some((field) => this.text(data[field]))) {
      issues.push({ severity: 'error', message: '风格定义预览没有任何可写入字段。', path: 'structuredData' });
    }
  }

  private validateCharacters(data: Record<string, unknown>, issues: GuidedStepValidationIssue[]) {
    const characters = this.arrayOfRecords(data.characters);
    if (!characters.length) {
      issues.push({ severity: 'error', message: '核心角色预览中没有 characters。', path: 'structuredData.characters' });
      return;
    }

    this.findDuplicatedStrings(characters.map((character) => this.text(character.name))).forEach((name) => {
      issues.push({ severity: 'warning', message: `预览中存在重复角色名：${name}。`, path: 'structuredData.characters' });
    });

    characters.forEach((character, index) => {
      const path = `structuredData.characters[${index}]`;
      if (!this.text(character.name)) issues.push({ severity: 'error', message: `第 ${index + 1} 个角色缺少 name。`, path: `${path}.name` });
      if (!this.text(character.roleType)) issues.push({ severity: 'warning', message: `第 ${index + 1} 个角色缺少 roleType。`, path: `${path}.roleType` });
      if (!this.text(character.personalityCore)) issues.push({ severity: 'warning', message: `第 ${index + 1} 个角色缺少 personalityCore。`, path: `${path}.personalityCore` });
      if (!this.text(character.motivation)) issues.push({ severity: 'warning', message: `第 ${index + 1} 个角色缺少 motivation。`, path: `${path}.motivation` });
    });
  }

  private validateOutline(data: Record<string, unknown>, issues: GuidedStepValidationIssue[]) {
    if (!this.text(data.outline)) {
      issues.push({ severity: 'error', message: '故事总纲预览缺少 outline。', path: 'structuredData.outline' });
    }
  }

  private validateVolumes(data: Record<string, unknown>, issues: GuidedStepValidationIssue[], characterContext: GuidedCharacterValidationContext) {
    const volumes = this.arrayOfRecords(data.volumes);
    if (!volumes.length) {
      issues.push({ severity: 'error', message: '卷纲预览中没有 volumes。', path: 'structuredData.volumes' });
      return;
    }

    const volumeNos = volumes.map((volume) => this.number(volume.volumeNo));
    this.findDuplicatedNumbers(volumeNos).forEach((volumeNo) => {
      issues.push({ severity: 'error', message: `存在重复卷号：${volumeNo}。`, path: 'structuredData.volumes' });
    });

    volumes.forEach((volume, index) => {
      const path = `structuredData.volumes[${index}]`;
      const label = `第 ${index + 1} 个卷预览`;
      const volumeNo = this.number(volume.volumeNo);
      const chapterCount = this.number(volume.chapterCount);
      if (volumeNo === undefined || volumeNo <= 0) issues.push({ severity: 'error', message: `${label} 的 volumeNo 必须是正数。`, path: `${path}.volumeNo` });
      if (chapterCount === undefined || chapterCount <= 0) issues.push({ severity: 'error', message: `${label} 的 chapterCount 必须是正数。`, path: `${path}.chapterCount` });
      if (!this.text(volume.title)) issues.push({ severity: 'error', message: `${label} 缺少 title。`, path: `${path}.title` });
      if (!this.text(volume.synopsis)) issues.push({ severity: 'error', message: `${label} 缺少 synopsis。`, path: `${path}.synopsis` });
      if (!this.text(volume.objective)) issues.push({ severity: 'error', message: `${label} 缺少 objective。`, path: `${path}.objective` });
      if (chapterCount !== undefined && chapterCount > 0) {
        try {
          assertVolumeNarrativePlan(volume.narrativePlan, {
            chapterCount,
            existingCharacterNames: characterContext.existingCharacterNames,
            existingCharacterAliases: characterContext.existingCharacterAliases,
            label: `${path}.narrativePlan`,
          });
        } catch (error) {
          issues.push({ severity: 'error', message: `${label} 的卷级叙事规划无效：${this.errorMessage(error)}。`, path: `${path}.narrativePlan` });
        }
      }
    });
  }

  private validateChapters(data: Record<string, unknown>, volumeNo: number | undefined, issues: GuidedStepValidationIssue[], characterContext: GuidedCharacterValidationContext) {
    const chapters = this.arrayOfRecords(data.chapters);
    if (!chapters.length) {
      issues.push({ severity: 'error', message: '章节细纲预览中没有 chapters。', path: 'structuredData.chapters' });
      return;
    }

    const chapterNos = chapters.map((chapter) => this.number(chapter.chapterNo));
    this.findDuplicatedNumbers(chapterNos).forEach((chapterNo) => {
      issues.push({ severity: 'error', message: `存在重复章节号：${chapterNo}。`, path: 'structuredData.chapters' });
    });

    chapters.forEach((chapter, index) => {
      const path = `structuredData.chapters[${index}]`;
      const label = `第 ${chapter.chapterNo || index + 1} 章`;
      const chapterNo = this.number(chapter.chapterNo);
      const itemVolumeNo = this.number(chapter.volumeNo) ?? volumeNo;
      if (chapterNo === undefined || chapterNo <= 0) issues.push({ severity: 'error', message: `${label} 的 chapterNo 必须是正数。`, path: `${path}.chapterNo` });
      if (itemVolumeNo === undefined || itemVolumeNo <= 0) issues.push({ severity: 'error', message: `${label} 的 volumeNo 必须是正数。`, path: `${path}.volumeNo` });
      if (volumeNo !== undefined) {
        const itemVolumeNo = this.number(chapter.volumeNo);
        if (itemVolumeNo !== undefined && itemVolumeNo !== volumeNo) {
          issues.push({ severity: 'warning', message: `${label} 的 volumeNo 与目标卷号 ${volumeNo} 不一致。`, path: `${path}.volumeNo` });
        }
      }
      if (!this.text(chapter.title)) issues.push({ severity: 'warning', message: `${label} 缺少 title。`, path: `${path}.title` });
      if (!this.text(chapter.objective)) issues.push({ severity: 'error', message: `${label} 缺少 objective。`, path: `${path}.objective` });
      if (!this.text(chapter.conflict)) issues.push({ severity: 'error', message: `${label} 缺少 conflict。`, path: `${path}.conflict` });
      if (!this.text(chapter.outline)) issues.push({ severity: 'error', message: `${label} 缺少 outline。`, path: `${path}.outline` });
      if (this.text(chapter.outline) && this.text(chapter.outline).length < 60) {
        issues.push({ severity: 'error', message: `${label} 的 outline 过短，缺少具体场景链。`, path: `${path}.outline` });
      }
      this.validateChapterCraftBrief(chapter.craftBrief, label, `${path}.craftBrief`, issues, characterContext, itemVolumeNo ? characterContext.volumePlansByNo.get(itemVolumeNo) : undefined);
    });

    this.validateSupportingCharacters(data, volumeNo, issues);
  }

  private validateChapterCraftBrief(
    value: unknown,
    label: string,
    path: string,
    issues: GuidedStepValidationIssue[],
    characterContext: GuidedCharacterValidationContext,
    volumePlan: VolumeCharacterPlan | undefined,
  ) {
    const brief = this.asRecord(value);
    if (!brief || !Object.keys(brief).length) {
      issues.push({ severity: 'error', message: `${label} 缺少 craftBrief 执行卡。`, path });
      return;
    }
    const requiredTextFields = [
      'visibleGoal',
      'hiddenEmotion',
      'coreConflict',
      'mainlineTask',
      'dialogueSubtext',
      'characterShift',
      'irreversibleConsequence',
      'entryState',
      'exitState',
      'handoffToNextChapter',
    ];
    requiredTextFields.forEach((field) => {
      if (!this.text(brief[field])) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.${field} 为空。`, path: `${path}.${field}` });
      }
    });
    if (!this.stringArray(brief.subplotTasks).length) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.subplotTasks 为空。`, path: `${path}.subplotTasks` });
    }
    this.validateStoryUnit(brief.storyUnit, label, `${path}.storyUnit`, issues);
    if (this.stringArray(brief.actionBeats).length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.actionBeats 少于 3 个节点。`, path: `${path}.actionBeats` });
    }
    if (!this.stringArray(brief.openLoops).length || !this.stringArray(brief.closedLoops).length) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.openLoops / closedLoops 不能为空。`, path });
    }
    const sceneBeats = this.arrayOfRecords(brief.sceneBeats);
    if (sceneBeats.length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.sceneBeats 少于 3 个场景段。`, path: `${path}.sceneBeats` });
    }
    sceneBeats.forEach((beat, index) => {
      ['sceneArcId', 'scenePart', 'location', 'localGoal', 'visibleAction', 'obstacle', 'turningPoint', 'partResult', 'sensoryAnchor'].forEach((field) => {
        if (!this.text(beat[field])) issues.push({ severity: 'error', message: `${label} 的 sceneBeats[${index}].${field} 为空。`, path: `${path}.sceneBeats[${index}].${field}` });
      });
      if (!this.stringArray(beat.participants).length) issues.push({ severity: 'error', message: `${label} 的 sceneBeats[${index}].participants 为空。`, path: `${path}.sceneBeats[${index}].participants` });
    });
    const clues = this.arrayOfRecords(brief.concreteClues);
    if (!clues.length) {
      issues.push({ severity: 'error', message: `${label} 缺少 craftBrief.concreteClues。`, path: `${path}.concreteClues` });
    }
    clues.forEach((clue, index) => {
      if (!this.text(clue.name)) issues.push({ severity: 'error', message: `${label} 的 concreteClues[${index}].name 为空。`, path: `${path}.concreteClues[${index}].name` });
      if (!this.text(clue.sensoryDetail)) issues.push({ severity: 'error', message: `${label} 的 concreteClues[${index}].sensoryDetail 为空。`, path: `${path}.concreteClues[${index}].sensoryDetail` });
      if (!this.text(clue.laterUse)) issues.push({ severity: 'error', message: `${label} 的 concreteClues[${index}].laterUse 为空。`, path: `${path}.concreteClues[${index}].laterUse` });
    });
    const continuityState = this.asRecord(brief.continuityState);
    if (!continuityState || !this.text(continuityState.nextImmediatePressure)) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.continuityState.nextImmediatePressure 为空。`, path: `${path}.continuityState.nextImmediatePressure` });
    } else {
      const hasConcreteState = ['characterPositions', 'activeThreats', 'ownedClues', 'relationshipChanges']
        .some((field) => this.stringArray(continuityState[field]).length > 0);
      if (!hasConcreteState) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.continuityState 缺少角色位置、威胁、线索或关系变化。`, path: `${path}.continuityState` });
      }
    }
    if (!volumePlan) {
      issues.push({ severity: 'error', message: `${label} 缺少可用卷级 characterPlan，无法校验章节角色执行。`, path });
    }
    try {
      assertChapterCharacterExecution(brief.characterExecution, {
        existingCharacterNames: characterContext.existingCharacterNames,
        existingCharacterAliases: characterContext.existingCharacterAliases,
        volumeCandidateNames: volumePlan?.newCharacterCandidates.map((candidate) => candidate.name) ?? [],
        sceneBeats: sceneBeats.map((beat) => ({ sceneArcId: this.text(beat.sceneArcId), participants: beat.participants })),
        actionBeatCount: this.stringArray(brief.actionBeats).length,
        label: `${label}.craftBrief.characterExecution`,
      });
    } catch (error) {
      issues.push({ severity: 'error', message: `${label} 的角色执行无效：${this.errorMessage(error)}。`, path: `${path}.characterExecution` });
    }
  }

  private validateStoryUnit(value: unknown, label: string, path: string, issues: GuidedStepValidationIssue[]) {
    const storyUnit = this.asRecord(value);
    if (!storyUnit || !Object.keys(storyUnit).length) {
      issues.push({ severity: 'error', message: `${label} 缺少 craftBrief.storyUnit。`, path });
      return;
    }
    [
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
    ].forEach((field) => {
      if (!this.text(storyUnit[field])) {
        issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.${field} 为空。`, path: `${path}.${field}` });
      }
    });
    const chapterRange = this.asRecord(storyUnit.chapterRange);
    const start = this.number(chapterRange?.start);
    const end = this.number(chapterRange?.end);
    if (!Number.isInteger(start) || !start || start < 1 || !Number.isInteger(end) || !end || end < start) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.chapterRange 无效。`, path: `${path}.chapterRange` });
    }
    if (this.stringArray(storyUnit.serviceFunctions).length < 3) {
      issues.push({ severity: 'error', message: `${label} 的 craftBrief.storyUnit.serviceFunctions 少于 3 项。`, path: `${path}.serviceFunctions` });
    }
  }

  private validateSupportingCharacters(data: Record<string, unknown>, volumeNo: number | undefined, issues: GuidedStepValidationIssue[]) {
    const supportingCharacters = this.arrayOfRecords(data.supportingCharacters);
    supportingCharacters.forEach((character, index) => {
      const path = `structuredData.supportingCharacters[${index}]`;
      if (!this.text(character.name)) issues.push({ severity: 'error', message: `第 ${index + 1} 个配角缺少 name。`, path: `${path}.name` });
      if (!this.text(character.roleType)) issues.push({ severity: 'warning', message: `第 ${index + 1} 个配角缺少 roleType。`, path: `${path}.roleType` });
    });
    if (supportingCharacters.length && volumeNo === undefined) {
      issues.push({ severity: 'warning', message: '缺少目标 volumeNo，配角写入将使用 chapter 作用域。', path: 'volumeNo' });
    }
  }

  private validateForeshadow(data: Record<string, unknown>, issues: GuidedStepValidationIssue[]) {
    const tracks = this.arrayOfRecords(data.foreshadowTracks);
    if (!tracks.length) {
      issues.push({ severity: 'error', message: '伏笔预览中没有 foreshadowTracks。', path: 'structuredData.foreshadowTracks' });
      return;
    }

    this.findDuplicatedStrings(tracks.map((track) => this.text(track.title))).forEach((title) => {
      issues.push({ severity: 'warning', message: `预览中存在重复伏笔标题：${title}。`, path: 'structuredData.foreshadowTracks' });
    });

    tracks.forEach((track, index) => {
      const path = `structuredData.foreshadowTracks[${index}]`;
      const label = track.title ? `伏笔“${this.text(track.title)}”` : `第 ${index + 1} 条伏笔`;
      if (!this.text(track.title)) issues.push({ severity: 'error', message: `${label} 缺少 title。`, path: `${path}.title` });
      if (!this.text(track.detail)) issues.push({ severity: 'warning', message: `${label} 缺少 detail。`, path: `${path}.detail` });
      if (!this.text(track.payoff)) issues.push({ severity: 'warning', message: `${label} 缺少 payoff。`, path: `${path}.payoff` });
    });
  }

  private async buildWritePreview(stepKey: GuidedStepSchemaKey, data: Record<string, unknown>, volumeNo: number | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    switch (stepKey) {
      case 'guided_setup':
        return this.buildProjectWritePreview(stepKey, ['genre', 'theme', 'tone', 'logline', 'synopsis'], data);
      case 'guided_style':
        return this.buildProjectWritePreview(stepKey, ['pov', 'tense', 'proseStyle', 'pacing'], data, 'create_or_update_style_profile');
      case 'guided_characters':
        return this.buildCharacterWritePreview(data, context);
      case 'guided_outline':
        return this.buildProjectWritePreview(stepKey, ['outline'], data, 'update_project_outline');
      case 'guided_volume':
        return this.buildVolumeWritePreview(data, context);
      case 'guided_chapter':
        return this.buildChapterWritePreview(data, volumeNo, context);
      case 'guided_foreshadow':
        return this.buildForeshadowWritePreview(data, context);
    }
  }

  private buildProjectWritePreview(stepKey: GuidedStepSchemaKey, fields: string[], data: Record<string, unknown>, action = 'update_project_profile'): Record<string, unknown> {
    const writableFields = fields.filter((field) => this.text(data[field]));
    return {
      stepKey,
      action,
      summary: { updateFieldCount: writableFields.length },
      fields: writableFields,
      approvalMessage: '校验通过后仍需用户审批；后续写入将更新项目或风格资料。',
    };
  }

  private async buildCharacterWritePreview(data: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const characters = this.arrayOfRecords(data.characters);
    const names = characters.map((character) => this.text(character.name)).filter(Boolean);
    const existingCharacters = names.length
      ? await this.prisma.character.findMany({ where: { projectId: context.projectId, name: { in: [...new Set(names)] } }, select: { name: true } })
      : [];
    const existingNames = new Set(existingCharacters.map((character) => character.name));
    const seenNames = new Set<string>();
    const items = characters.map((character) => {
      const name = this.text(character.name);
      const duplicateInPreview = Boolean(name && seenNames.has(name));
      if (name) seenNames.add(name);
      return {
        name,
        roleType: this.text(character.roleType) || null,
        action: !name ? 'skip_invalid' : 'create',
        duplicateInPreview,
        existingName: existingNames.has(name),
      };
    });

    return {
      stepKey: 'guided_characters',
      action: 'create_characters',
      summary: {
        createCount: items.filter((item) => item.action === 'create').length,
        invalidCount: items.filter((item) => item.action === 'skip_invalid').length,
        duplicateNameCount: items.filter((item) => item.duplicateInPreview).length,
        existingNameCount: items.filter((item) => item.existingName).length,
      },
      characters: items,
      approvalMessage: '校验通过后仍需用户审批；后续写入会新增 guided 来源角色，已有同名角色需人工确认是否保留重复。',
    };
  }

  private async buildVolumeWritePreview(data: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const volumes = this.arrayOfRecords(data.volumes);
    const existingVolumes = await this.prisma.volume.findMany({ where: { projectId: context.projectId }, select: { volumeNo: true, title: true } });
    const existingByNo = new Map(existingVolumes.map((volume) => [volume.volumeNo, volume.title]));
    const duplicatedVolumeNos = new Set(this.findDuplicatedNumbers(volumes.map((volume) => this.number(volume.volumeNo))));
    const items = volumes.map((volume) => {
      const volumeNo = this.number(volume.volumeNo);
      const valid = volumeNo !== undefined && volumeNo > 0;
      return {
        volumeNo,
        title: this.text(volume.title),
        action: !valid ? 'skip_invalid' : duplicatedVolumeNos.has(volumeNo) ? 'duplicate_in_preview' : 'replace_all_create',
        existingTitle: valid ? existingByNo.get(volumeNo) ?? null : null,
      };
    });

    return {
      stepKey: 'guided_volume',
      action: 'replace_all_volumes',
      summary: {
        deleteExistingCount: existingVolumes.length,
        createCount: items.filter((item) => item.action === 'replace_all_create').length,
        invalidCount: items.filter((item) => item.action === 'skip_invalid').length,
        duplicateCount: items.filter((item) => item.action === 'duplicate_in_preview').length,
      },
      volumes: items,
      approvalMessage: '校验通过后仍需用户审批；后续写入会替换当前项目全部卷纲。',
    };
  }

  private async buildChapterWritePreview(data: Record<string, unknown>, volumeNo: number | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    const chapters = this.arrayOfRecords(data.chapters);
    const supportingCharacters = this.arrayOfRecords(data.supportingCharacters);
    const chapterNos = chapters.map((chapter) => this.number(chapter.chapterNo)).filter((value): value is number => value !== undefined && value > 0);
    const [existingVolumes, existingChapters] = await Promise.all([
      this.prisma.volume.findMany({ where: { projectId: context.projectId }, select: { id: true, volumeNo: true, title: true } }),
      chapterNos.length
        ? this.prisma.chapter.findMany({ where: { projectId: context.projectId, chapterNo: { in: [...new Set(chapterNos)] } }, select: { chapterNo: true, status: true, title: true } })
        : Promise.resolve([]),
    ]);
    const volumeByNo = new Map(existingVolumes.map((volume) => [volume.volumeNo, volume]));
    const existingChapterByNo = new Map(existingChapters.map((chapter) => [chapter.chapterNo, chapter]));
    const duplicatedChapterNos = new Set(this.findDuplicatedNumbers(chapters.map((chapter) => this.number(chapter.chapterNo))));
    const targetVolumeExists = volumeNo === undefined ? null : volumeByNo.has(volumeNo);
    const items = chapters.map((chapter, index) => {
      const chapterNo = this.number(chapter.chapterNo);
      const itemVolumeNo = this.number(chapter.volumeNo) ?? volumeNo ?? null;
      const valid = chapterNo !== undefined && chapterNo > 0;
      const existing = valid ? existingChapterByNo.get(chapterNo) : undefined;
      const action = !valid
        ? 'skip_invalid'
        : duplicatedChapterNos.has(chapterNo)
          ? 'duplicate_in_preview'
          : volumeNo === undefined
            ? 'replace_all_create'
            : existing?.status === 'planned'
              ? 'update_planned'
              : existing
                ? 'skip_existing_content'
                : 'create';
      return {
        chapterNo,
        title: this.text(chapter.title) || `第 ${index + 1} 章`,
        volumeNo: itemVolumeNo,
        action,
        existingStatus: existing?.status ?? null,
        volumeExists: itemVolumeNo === null ? null : volumeByNo.has(itemVolumeNo),
      };
    });

    return {
      stepKey: 'guided_chapter',
      action: volumeNo === undefined ? 'replace_all_chapters' : 'upsert_volume_chapters',
      summary: {
        targetVolumeNo: volumeNo ?? null,
        targetVolumeExists,
        createCount: items.filter((item) => item.action === 'create' || item.action === 'replace_all_create').length,
        updateCount: items.filter((item) => item.action === 'update_planned').length,
        skipCount: items.filter((item) => item.action === 'skip_existing_content').length,
        invalidCount: items.filter((item) => item.action === 'skip_invalid').length,
        duplicateCount: items.filter((item) => item.action === 'duplicate_in_preview').length,
        supportingCharacterCount: supportingCharacters.length,
      },
      chapters: items,
      supportingCharacters: supportingCharacters.map((character) => ({ name: this.text(character.name), action: this.text(character.name) ? 'session_only' : 'skip_invalid' })),
      approvalMessage: volumeNo === undefined
        ? '校验通过后仍需用户审批；后续写入会替换当前项目全部章节细纲；supportingCharacters 仅保留为本次引导预览信息，不会创建正式角色。'
        : '校验通过后仍需用户审批；后续写入会更新目标卷章节细纲；supportingCharacters 仅保留为本次引导预览信息，不会创建正式角色。',
    };
  }

  private async buildForeshadowWritePreview(data: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const tracks = this.arrayOfRecords(data.foreshadowTracks);
    const existingGuidedTracks = await this.prisma.foreshadowTrack.findMany({ where: { projectId: context.projectId, source: 'guided' }, select: { title: true } });
    const duplicatedTitles = new Set(this.findDuplicatedStrings(tracks.map((track) => this.text(track.title))));
    const items = tracks.map((track) => {
      const title = this.text(track.title);
      return {
        title,
        scope: this.text(track.scope) || 'arc',
        action: !title ? 'skip_invalid' : duplicatedTitles.has(title) ? 'duplicate_in_preview' : 'replace_all_create',
      };
    });
    return {
      stepKey: 'guided_foreshadow',
      action: 'replace_guided_foreshadow_tracks',
      summary: {
        deleteExistingGuidedCount: existingGuidedTracks.length,
        createCount: items.filter((item) => item.action === 'replace_all_create').length,
        invalidCount: items.filter((item) => item.action === 'skip_invalid').length,
        duplicateCount: items.filter((item) => item.action === 'duplicate_in_preview').length,
      },
      foreshadowTracks: items,
      approvalMessage: '校验通过后仍需用户审批；后续写入会替换 guided 来源伏笔。',
    };
  }

  private async buildCharacterValidationContext(
    stepKey: GuidedStepSchemaKey,
    _data: Record<string, unknown>,
    _volumeNo: number | undefined,
    context: ToolContext,
  ): Promise<GuidedCharacterValidationContext> {
    const characterContext: GuidedCharacterValidationContext = {
      existingCharacterNames: [],
      existingCharacterAliases: {},
      volumePlansByNo: new Map(),
    };
    if (stepKey !== 'guided_volume' && stepKey !== 'guided_chapter') return characterContext;

    const session = await this.findGuidedSession(context.projectId);
    const stepData = this.asRecord((this.asRecord(session)?.stepData)) ?? {};
    const addCharacterName = (nameValue: unknown) => {
      const name = this.text(nameValue);
      if (name && !characterContext.existingCharacterNames.includes(name)) characterContext.existingCharacterNames.push(name);
      return name;
    };

    const characterRows = await this.findCharacters(context.projectId);
    for (const character of characterRows) {
      const name = addCharacterName(character.name);
      const aliases = this.stringArray(character.alias);
      if (name && aliases.length) characterContext.existingCharacterAliases[name] = aliases;
    }
    const guidedCharactersResult = this.asRecord(stepData.guided_characters_result);
    this.arrayOfRecords(guidedCharactersResult?.characters).forEach((character) => addCharacterName(character.name));

    if (stepKey === 'guided_chapter') {
      const persistedVolumes = await this.findVolumesWithCharacterPlans(context.projectId);
      for (const volume of persistedVolumes) this.addVolumeCharacterPlan(volume, characterContext);
      const guidedVolumeResult = this.asRecord(stepData.guided_volume_result);
      for (const volume of this.arrayOfRecords(guidedVolumeResult?.volumes)) this.addVolumeCharacterPlan(volume, characterContext);
    }

    return characterContext;
  }

  private async findGuidedSession(projectId: string): Promise<unknown> {
    const delegate = (this.prisma as unknown as { guidedSession?: { findUnique?: (args: Record<string, unknown>) => Promise<unknown> } }).guidedSession;
    return delegate?.findUnique ? delegate.findUnique({ where: { projectId } }) : null;
  }

  private async findCharacters(projectId: string): Promise<Array<Record<string, unknown>>> {
    const delegate = (this.prisma as unknown as { character?: { findMany?: (args: Record<string, unknown>) => Promise<unknown[]> } }).character;
    if (!delegate?.findMany) return [];
    const rows = await delegate.findMany({ where: { projectId }, select: { name: true, alias: true } });
    return this.arrayOfRecords(rows);
  }

  private async findVolumesWithCharacterPlans(projectId: string): Promise<Array<Record<string, unknown>>> {
    const delegate = (this.prisma as unknown as { volume?: { findMany?: (args: Record<string, unknown>) => Promise<unknown[]> } }).volume;
    if (!delegate?.findMany) return [];
    const rows = await delegate.findMany({ where: { projectId }, select: { volumeNo: true, chapterCount: true, narrativePlan: true } });
    return this.arrayOfRecords(rows);
  }

  private addVolumeCharacterPlan(volume: Record<string, unknown>, characterContext: GuidedCharacterValidationContext): void {
    const volumeNo = this.number(volume.volumeNo);
    const chapterCount = this.number(volume.chapterCount);
    if (!Number.isInteger(volumeNo) || !volumeNo || volumeNo < 1 || !Number.isInteger(chapterCount) || !chapterCount || chapterCount < 1) return;
    try {
      const narrativePlan = assertVolumeNarrativePlan(volume.narrativePlan, {
        chapterCount,
        existingCharacterNames: characterContext.existingCharacterNames,
        existingCharacterAliases: characterContext.existingCharacterAliases,
        label: `第 ${volumeNo} 卷.narrativePlan`,
      });
      const characterPlan = narrativePlan.characterPlan as VolumeCharacterPlan;
      characterContext.volumePlansByNo.set(volumeNo, characterPlan);
    } catch {
      // Invalid upstream plans are reported by the chapter validation as missing usable characterPlan.
    }
  }

  private buildOutput(issues: GuidedStepValidationIssue[], writePreview: Record<string, unknown>): ValidateGuidedStepPreviewOutput {
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      writePreview,
    };
  }

  private emptyWritePreview(stepKey: string): Record<string, unknown> {
    return {
      stepKey,
      action: 'none',
      summary: {},
      approvalMessage: '校验未通过前不应写入。',
    };
  }

  private warnMissingTextFields(data: Record<string, unknown>, fields: string[], basePath: string, issues: GuidedStepValidationIssue[]) {
    fields.forEach((field) => {
      if (!this.text(data[field])) {
        issues.push({ severity: 'warning', message: `缺少 ${field}。`, path: `${basePath}.${field}` });
      }
    });
  }

  private findDuplicatedNumbers(values: Array<number | undefined>): number[] {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    values.forEach((value) => {
      if (value === undefined || !Number.isFinite(value)) return;
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a - b);
  }

  private findDuplicatedStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.map((value) => value.trim()).filter(Boolean).forEach((value) => {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => this.text(item)).filter(Boolean)
      : [];
  }

  private number(value: unknown): number | undefined {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
