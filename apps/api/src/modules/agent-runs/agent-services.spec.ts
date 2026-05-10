import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseTool } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { BUILTIN_SKILLS } from '../agent-skills/builtin-skills';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { EmbeddingGatewayService } from '../llm/embedding-gateway.service';
import { LlmGatewayService, LlmJsonInvalidError, LlmTimeoutError } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { AgentExecutorService, AgentWaitingReviewError } from './agent-executor.service';
import { AgentExecutionObservationError } from './agent-observation.types';
import { AgentReplannerService } from './agent-replanner.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentPlannerFailedError, AgentPlannerService, type AgentPlanSpec } from './agent-planner.service';
import { AgentPlannerGraphService } from './planner-graph/agent-planner-graph.service';
import { PlanValidatorService } from './planner-graph/plan-validator.service';
import { createDomainPlannerNode, createSelectToolBundleNode } from './planner-graph/nodes';
import { TOOL_BUNDLE_DEFINITIONS, ToolBundleRegistry } from './planner-graph/tool-bundles';
import { invokeOutlineSubgraph } from './planner-graph/subgraphs/outline.subgraph';
import { OutlineSupervisor } from './planner-graph/supervisors/outline-supervisor';
import { RootSupervisor, validateRouteDecision } from './planner-graph/supervisors/root-supervisor';
import { AgentPolicyService, AgentSecondConfirmationRequiredError } from './agent-policy.service';
import { AgentTraceService } from './agent-trace.service';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunWatchdogService } from './agent-run-watchdog.service';
import type { AgentContextV2 } from './agent-context-builder.service';
import { GenerateChapterService } from '../generation/generate-chapter.service';
import { GenerationService } from '../generation/generation.service';
import { GenerationProfileService } from '../generation-profile/generation-profile.service';
import { UpdateGenerationProfileDto } from '../generation-profile/dto/update-generation-profile.dto';
import { ChapterAutoRepairService } from '../generation/chapter-auto-repair.service';
import { PromptBuilderService } from '../generation/prompt-builder.service';
import { RetrievalPlannerService } from '../generation/retrieval-planner.service';
import { ValidateOutlineTool } from '../agent-tools/tools/validate-outline.tool';
import { ValidateImportedAssetsTool } from '../agent-tools/tools/validate-imported-assets.tool';
import { PersistOutlineTool } from '../agent-tools/tools/persist-outline.tool';
import { PersistVolumeOutlineTool } from '../agent-tools/tools/persist-volume-outline.tool';
import { GenerateOutlinePreviewTool, OutlinePreviewOutput } from '../agent-tools/tools/generate-outline-preview.tool';
import { GenerateVolumeOutlinePreviewTool } from '../agent-tools/tools/generate-volume-outline-preview.tool';
import { GenerateStoryUnitsPreviewTool, PersistStoryUnitsTool, type StoryUnitsPreviewOutput } from '../agent-tools/tools/generate-story-units-preview.tool';
import { assertChapterCharacterExecution, assertVolumeCharacterPlan } from '../agent-tools/tools/outline-character-contracts';
import { normalizeWithLlmRepair } from '../agent-tools/tools/structured-output-repair';
import { PersistVolumeCharacterCandidatesTool } from '../agent-tools/tools/persist-volume-character-candidates.tool';
import { ResolveChapterTool } from '../agent-tools/tools/resolve-chapter.tool';
import { CollectChapterContextTool } from '../agent-tools/tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from '../agent-tools/tools/collect-task-context.tool';
import { InspectProjectContextTool } from '../agent-tools/tools/inspect-project-context.tool';
import { CharacterConsistencyCheckTool } from '../agent-tools/tools/character-consistency-check.tool';
import { PlotConsistencyCheckTool } from '../agent-tools/tools/plot-consistency-check.tool';
import { GenerateGuidedStepPreviewTool } from '../agent-tools/tools/generate-guided-step-preview.tool';
import { ValidateGuidedStepPreviewTool } from '../agent-tools/tools/validate-guided-step-preview.tool';
import { PersistGuidedStepResultTool } from '../agent-tools/tools/persist-guided-step-result.tool';
import { BuildImportBriefTool } from '../agent-tools/tools/build-import-brief.tool';
import { BuildImportPreviewTool } from '../agent-tools/tools/build-import-preview.tool';
import { GenerateChapterOutlinePreviewTool, MergeChapterOutlinePreviewsTool } from '../agent-tools/tools/chapter-outline-preview-tools.tool';
import { GenerateImportCharactersPreviewTool } from '../agent-tools/tools/generate-import-characters-preview.tool';
import { GenerateImportOutlinePreviewTool } from '../agent-tools/tools/generate-import-outline-preview.tool';
import { GenerateImportProjectProfilePreviewTool } from '../agent-tools/tools/generate-import-project-profile-preview.tool';
import { GenerateImportWorldbuildingPreviewTool } from '../agent-tools/tools/generate-import-worldbuilding-preview.tool';
import { GenerateImportWritingRulesPreviewTool } from '../agent-tools/tools/generate-import-writing-rules-preview.tool';
import { CrossTargetConsistencyCheckTool } from '../agent-tools/tools/cross-target-consistency-check.tool';
import { MergeImportPreviewsTool } from '../agent-tools/tools/merge-import-previews.tool';
import { PersistProjectAssetsTool } from '../agent-tools/tools/persist-project-assets.tool';
import { GenerateWorldbuildingPreviewTool } from '../agent-tools/tools/generate-worldbuilding-preview.tool';
import { ValidateWorldbuildingTool } from '../agent-tools/tools/validate-worldbuilding.tool';
import { PersistWorldbuildingTool } from '../agent-tools/tools/persist-worldbuilding.tool';
import { GenerateStoryBiblePreviewTool } from '../agent-tools/tools/generate-story-bible-preview.tool';
import { ValidateStoryBibleTool } from '../agent-tools/tools/validate-story-bible.tool';
import { PersistStoryBibleTool } from '../agent-tools/tools/persist-story-bible.tool';
import { GenerateContinuityPreviewTool, PersistContinuityChangesTool, ValidateContinuityChangesTool } from '../agent-tools/tools/continuity-changes.tool';
import { AlignChapterTimelinePreviewTool } from '../agent-tools/tools/align-chapter-timeline-preview.tool';
import { GenerateTimelinePreviewTool } from '../agent-tools/tools/generate-timeline-preview.tool';
import { ValidateTimelinePreviewTool } from '../agent-tools/tools/validate-timeline-preview.tool';
import { PersistTimelineEventsTool } from '../agent-tools/tools/persist-timeline-events.tool';
import { assertNoTimelineDuplicateConflicts, normalizeTimelineCandidate, normalizeTimelineCandidates, normalizeTimelinePreviewFromLlmCall, validateTimelineCandidateChapterRefs } from '../agent-tools/tools/timeline-preview.support';
import { GenerateChapterCraftBriefPreviewTool, PersistChapterCraftBriefTool, ValidateChapterCraftBriefTool } from '../agent-tools/tools/chapter-craft-brief-tools.tool';
import { GenerateSceneCardsPreviewTool, ListSceneCardsTool, PersistSceneCardsTool, UpdateSceneCardTool, ValidateSceneCardsTool } from '../agent-tools/tools/scene-card-tools.tool';
import { RelationshipGraphService } from '../agent-tools/relationship-graph.service';
import { FactExtractorService } from '../facts/fact-extractor.service';
import { ChapterRewriteCleanupService } from '../generation/chapter-rewrite-cleanup.service';
import { WriteChapterTool } from '../agent-tools/tools/write-chapter.tool';
import { RewriteChapterTool } from '../agent-tools/tools/rewrite-chapter.tool';
import { PolishChapterTool } from '../agent-tools/tools/polish-chapter.tool';
import { WriteChapterSeriesTool } from '../agent-tools/tools/write-chapter-series.tool';
import { AutoRepairChapterTool } from '../agent-tools/tools/auto-repair-chapter.tool';
import { AiQualityReviewTool } from '../agent-tools/tools/ai-quality-review.tool';
import { RetrievalService } from '../memory/retrieval.service';
import { GuidedService } from '../guided/guided.service';
import { GuidedController } from '../guided/guided.controller';
import { LorebookService } from '../lorebook/lorebook.service';
import { ProjectsService } from '../projects/projects.service';
import { ValidationService } from '../validation/validation.service';
import { WritingRulesService } from '../writing-rules/writing-rules.service';
import { RelationshipsService } from '../relationships/relationships.service';
import { TimelineEventsService } from '../timeline-events/timeline-events.service';
import { ScenesService } from '../scenes/scenes.service';
import { ChapterPatternsService } from '../chapter-patterns/chapter-patterns.service';
import { UpdateChapterPatternDto } from '../chapter-patterns/dto/update-chapter-pattern.dto';
import { PacingBeatsService } from '../pacing-beats/pacing-beats.service';
import { QualityReportsService } from '../quality-reports/quality-reports.service';
import { AiQualityReviewService } from '../quality-reports/ai-quality-review.service';
import { UpdateQualityReportDto } from '../quality-reports/dto/update-quality-report.dto';
import { QualityReportsController } from '../quality-reports/quality-reports.controller';

type TestCase = { name: string; run: () => void | Promise<void> };
type ImportPlannerTestPlan = { steps: Array<{ stepNo: number; tool: string; requiresApproval: boolean; args: Record<string, unknown> }>; requiredApprovals: Array<{ target?: { stepNos?: number[]; tools?: string[] } }> };

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

function createTool(overrides: Partial<BaseTool> = {}): BaseTool {
  return {
    name: 'write_chapter',
    description: '测试工具',
    allowedModes: ['act'],
    riskLevel: 'medium',
    requiresApproval: true,
    sideEffects: ['create_chapter_draft'],
    async run() {
      return {};
    },
    ...overrides,
  };
}

function createOutlineCraftBrief(overrides: Record<string, unknown> = {}) {
  return {
    visibleGoal: '完成本章可检验目标',
    hiddenEmotion: '担心行动失败会伤及同伴信任',
    coreConflict: '外部阻力迫使主角正面选择',
    mainlineTask: '推进卷内主线',
    subplotTasks: ['推进卷内支线'],
    storyUnit: {
      unitId: 'v1_unit_01',
      title: '旧闸棚失踪案',
      chapterRange: { start: 1, end: 4 },
      chapterRole: '开局推进',
      localGoal: '查清旧闸棚账册被替换的原因',
      localConflict: '巡检员和馆方同时阻断调阅并试图销毁账册',
      serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
      mainlineContribution: '把旧账册缺页指向卷内主线的失踪记录。',
      characterContribution: '让主角从谨慎旁观转向主动承担调查风险。',
      relationshipContribution: '同伴第一次为主角藏证据，信任开始改变。',
      worldOrThemeContribution: '展示档案制度如何被权力篡改，回应记忆与真相主题。',
      unitPayoff: '单元末主角确认账册替换者与东闸封锁有关。',
      stateChangeAfterUnit: '主角持有半页账纸，但名字进入临检记录。',
    },
    actionBeats: ['林澈在旧闸棚翻开潮蚀账册', '巡检员当场扣住账册并逼他交出通行牌', '同伴撕下半页账册塞进工具箱带离现场'],
    sceneBeats: [
      {
        sceneArcId: 'archive_pressure',
        scenePart: '1/3',
        continuesFromChapterNo: null,
        continuesToChapterNo: null,
        location: '旧闸棚账房',
        participants: ['林澈', '巡检员'],
        localGoal: '确认账册里是否有被改过的船籍号',
        visibleAction: '林澈用油灯照出账页边缘的新墨痕',
        obstacle: '巡检员夺走账册并要求他立刻离开',
        turningPoint: '账页夹层掉出一枚带盐霜的铜扣',
        partResult: '林澈确认有人刚刚替换过账页',
        sensoryAnchor: '铜扣上有刺手盐霜和湿铁味',
      },
      {
        sceneArcId: 'archive_pressure',
        scenePart: '2/3',
        continuesFromChapterNo: null,
        continuesToChapterNo: null,
        location: '账房后门',
        participants: ['林澈', '同伴'],
        localGoal: '把账册证据带出账房',
        visibleAction: '同伴假装摔倒，把半页账纸压进工具箱夹层',
        obstacle: '巡检员锁上后门并检查每个人的袖口',
        turningPoint: '工具箱底部的旧印泥暴露了另一枚章印',
        partResult: '林澈带走半页账纸却失去通行牌',
        sensoryAnchor: '印泥有辛辣桐油味',
      },
      {
        sceneArcId: 'archive_pressure',
        scenePart: '3/3',
        continuesFromChapterNo: null,
        continuesToChapterNo: 2,
        location: '闸棚外雨廊',
        participants: ['林澈', '同伴', '巡检员'],
        localGoal: '离开封锁线前确认下一步去向',
        visibleAction: '林澈把铜扣藏进靴筒，转身走向东闸',
        obstacle: '巡检员命人把他的名字写进临检记录',
        turningPoint: '同伴发现东闸只剩一刻钟开放',
        partResult: '林澈必须立刻穿过东闸，不能再回到账房',
        sensoryAnchor: '雨廊木梁不断滴下咸涩黑水',
      },
    ],
    concreteClues: [{ name: '关键线索', sensoryDetail: '带有可辨认质感', laterUse: '后续回收' }],
    dialogueSubtext: '对话表面交换信息，潜台词试探立场。',
    characterShift: '角色从犹疑转向主动承担。',
    irreversibleConsequence: '本章结尾改变资源、关系或危险等级。',
    progressTypes: ['info'],
    entryState: '上一章留下的压力压到现场，主角必须立刻验证关键线索。',
    exitState: '主角带走半页证据，但身份进入临检记录。',
    openLoops: ['谁替换了账页仍未查明'],
    closedLoops: ['确认账页确实被人动过手脚'],
    handoffToNextChapter: '下一章从主角赶往东闸、通行时间即将失效接起。',
    continuityState: {
      characterPositions: ['林澈在旧闸棚外雨廊'],
      activeThreats: ['临检记录已经写入他的名字'],
      ownedClues: ['带盐霜的铜扣', '半页账纸'],
      relationshipChanges: ['同伴为他冒险藏证据'],
      nextImmediatePressure: '必须在东闸关闭前离开封锁线',
    },
    characterExecution: {
      povCharacter: '林澈',
      cast: [
        {
          characterName: '林澈',
          source: 'existing' as const,
          functionInChapter: '推动本章行动链并承接主线压力',
          visibleGoal: '完成本章可检验目标',
          pressure: '外部阻力迫使他立刻选择',
          actionBeatRefs: [1, 2],
          sceneBeatRefs: ['archive_pressure'],
          entryState: '带着上一章压力进入现场',
          exitState: '带走证据但付出资源代价',
        },
        {
          characterName: '邵衡',
          source: 'volume_candidate' as const,
          functionInChapter: '制造制度压力并留下合作缝隙',
          visibleGoal: '阻止林澈公开账册',
          hiddenGoal: '判断林澈是否值得托付登记簿',
          pressure: '巡检处正在清查泄密者',
          actionBeatRefs: [2, 3],
          sceneBeatRefs: ['archive_pressure'],
          entryState: '以巡检处代表身份压制现场',
          exitState: '暗中放过林澈离开',
        },
        {
          characterName: '巡检员',
          source: 'minor_temporary' as const,
          functionInChapter: '一次性现场阻力',
          visibleGoal: '清空旧闸棚并登记靠近者',
          pressure: '上级要求立刻封锁账房',
          actionBeatRefs: [2],
          sceneBeatRefs: ['archive_pressure'],
          entryState: '守在账房门口',
          exitState: '完成搜查后离场',
        },
        {
          characterName: '同伴',
          source: 'minor_temporary' as const,
          functionInChapter: '一次性协助藏证据',
          visibleGoal: '帮林澈把半页账纸带出账房',
          pressure: '巡检员正在检查袖口',
          actionBeatRefs: [3],
          sceneBeatRefs: ['archive_pressure'],
          entryState: '跟随林澈进入账房',
          exitState: '带着工具箱离开旧闸棚',
        },
      ],
      relationshipBeats: [
        {
          participants: ['林澈', '邵衡'],
          publicStateBefore: '互相怀疑',
          trigger: '邵衡没有揭穿半页账纸',
          shift: '林澈意识到他可能不是纯粹敌人',
          publicStateAfter: '表面仍对立，私下出现合作余地',
        },
      ],
      newMinorCharacters: [
        {
          nameOrLabel: '巡检员',
          narrativeFunction: '一次性现场阻力',
          interactionScope: '旧闸棚搜查',
          firstAndOnlyUse: true,
          approvalPolicy: 'preview_only' as const,
        },
        {
          nameOrLabel: '同伴',
          narrativeFunction: '一次性协助藏证据',
          interactionScope: '账房后门藏证据',
          firstAndOnlyUse: true,
          approvalPolicy: 'preview_only' as const,
        },
      ],
    },
    ...overrides,
  };
}

function createOutlineChapter(chapterNo: number, volumeNo = 1, overrides: Record<string, unknown> = {}) {
  const base = {
    chapterNo,
    volumeNo,
    title: `第 ${chapterNo} 章`,
    objective: `完成第 ${chapterNo} 章目标`,
    conflict: `第 ${chapterNo} 章阻力`,
    hook: `第 ${chapterNo} 章钩子`,
    outline: `第 ${chapterNo} 章场景、行动和结果。`,
    expectedWordCount: 2600,
  };
  const chapter = { ...base, ...overrides };
  return {
    ...chapter,
    craftBrief: overrides.craftBrief ?? createOutlineCraftBrief({
      visibleGoal: String(chapter.objective),
      coreConflict: String(chapter.conflict),
      mainlineTask: String(chapter.objective),
    }),
  };
}

function createVccCharacterPlan(overrides: Record<string, unknown> = {}) {
  return {
    existingCharacterArcs: [
      {
        characterName: '林澈',
        roleInVolume: '调查旧闸棚账册的人',
        entryState: '仍相信失踪案只是档案造假',
        volumeGoal: '查清东闸封锁背后的真实名单',
        pressure: '巡检处持续封锁账册和通行证',
        keyChoices: ['是否公开半页账纸', '是否信任沈栖的线索'],
        firstActiveChapter: 1,
        lastActiveChapter: 4,
        endState: '确认东闸名单与失踪案直接相关',
      },
      {
        characterName: '沈栖',
        roleInVolume: '用制度内协助和职业风险平衡主角冲动',
        entryState: '只愿在规则边界内提供有限帮助',
        volumeGoal: '保护旧档案馆同僚并避免无辜者被封锁名单牵连',
        pressure: '巡检处要求她交出所有调阅记录',
        keyChoices: ['是否隐瞒半页账纸去向', '是否承认自己改过调阅时辰'],
        firstActiveChapter: 1,
        lastActiveChapter: 4,
        endState: '愿意为林澈承担一次记录风险',
      },
    ],
    newCharacterCandidates: [
      {
        candidateId: 'cand_shaoheng',
        name: '邵衡',
        roleType: 'supporting',
        scope: 'volume',
        narrativeFunction: '作为巡检处内线，把制度压力具象化为可对抗的人',
        personalityCore: '谨慎、讲秩序，但对旧案有亏欠感',
        motivation: '想在不暴露自己的前提下纠正旧案记录',
        backstorySeed: '三年前参与过东闸封锁登记',
        conflictWith: ['林澈'],
        relationshipAnchors: ['沈栖'],
        firstAppearChapter: 2,
        expectedArc: '从旁观内线转为主动递交关键登记簿',
        approvalStatus: 'candidate',
      },
    ],
    relationshipArcs: [
      {
        participants: ['林澈', '邵衡'],
        startState: '互相试探，林澈怀疑邵衡是封锁帮凶',
        turnChapterNos: [2, 4],
        endState: '邵衡交出登记簿，但要求林澈保护他的家人',
      },
    ],
    roleCoverage: {
      mainlineDrivers: ['林澈'],
      antagonistPressure: ['邵衡'],
      emotionalCounterweights: ['沈栖'],
      expositionCarriers: ['邵衡'],
    },
    ...overrides,
  };
}

function createVccNarrativePlan(overrides: Record<string, unknown> = {}) {
  return {
    globalMainlineStage: '从个人翻案进入工程求生',
    volumeMainline: '验证旧闸棚账册与失踪案的真实关系',
    dramaticQuestion: '林澈能否在巡检处封锁前拿到可公开的账册证据',
    startState: '林澈只握有传闻和一枚铜扣',
    endState: '林澈拿到半页账纸并确认巡检处改过记录',
    mainlineMilestones: ['拿到铜扣', '遇见邵衡', '带走半页账纸', '确认东闸名单被改'],
    subStoryLines: [
      { name: '账册缺页线', type: 'mystery', function: '推动主线证据递进', startState: '只知道账册缺页', progress: '逐章找到铜扣和半页账纸', endState: '确认缺页与东闸名单有关', relatedCharacters: ['林澈', '邵衡'], chapterNodes: [1, 2, 4] },
      { name: '同伴信任线', type: 'relationship', function: '把调查代价压到人物关系上', startState: '沈栖不愿越界', progress: '用藏证据和放行逐步改变立场', endState: '沈栖愿为林澈承担一次记录风险', relatedCharacters: ['林澈', '沈栖'], chapterNodes: [1, 3] },
    ],
    storyUnits: [
      { unitId: 'v1_unit_01', title: '旧闸棚账册', chapterRange: { start: 1, end: 4 }, localGoal: '拿到账册被改的第一份证据', localConflict: '巡检处封锁账房并登记所有靠近者', serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'], payoff: '林澈带走半页账纸但名字进入临检记录', stateChangeAfterUnit: '调查从传闻变成可追查证据' },
    ],
    characterPlan: createVccCharacterPlan(),
    foreshadowPlan: ['第 1 章铜扣，第 4 章回收到东闸名单'],
    endingHook: '半页账纸背面出现沈栖父亲的旧签名',
    handoffToNextVolume: '带着半页账纸追查东闸名单原件',
    ...overrides,
  };
}

function createVccCharacterPlanForChapterCount(chapterCount: number, overrides: Record<string, unknown> = {}) {
  const base = createVccCharacterPlan();
  return createVccCharacterPlan({
    existingCharacterArcs: base.existingCharacterArcs.map((arc) => ({
      ...arc,
      lastActiveChapter: chapterCount,
    })),
    newCharacterCandidates: base.newCharacterCandidates.map((candidate) => ({
      ...candidate,
      firstAppearChapter: Math.min(Number(candidate.firstAppearChapter) || 1, chapterCount),
    })),
    relationshipArcs: base.relationshipArcs.map((arc) => ({
      ...arc,
      turnChapterNos: [Math.max(1, Math.min(chapterCount, 2))],
    })),
    ...overrides,
  });
}

function createVccNarrativePlanForChapterCount(chapterCount: number, overrides: Record<string, unknown> = {}) {
  return createVccNarrativePlan({
    storyUnits: createVccStoryUnitsForChapterCount(chapterCount),
    characterPlan: createVccCharacterPlanForChapterCount(chapterCount),
    ...overrides,
  });
}

function createVccStoryUnitsForChapterCount(chapterCount: number) {
  const units: Array<Record<string, unknown>> = [];
  let start = 1;
  let unitIndex = 1;
  while (start <= chapterCount) {
    const remaining = chapterCount - start + 1;
    let length = remaining;
    if (chapterCount >= 3 && remaining > 5) {
      length = remaining % 5 === 1 ? 3 : remaining % 5 === 2 ? 4 : 5;
    }
    const end = start + length - 1;
    units.push({
      unitId: `v1_unit_${String(unitIndex).padStart(2, '0')}`,
      title: `旧闸棚失踪档案 ${unitIndex}`,
      chapterRange: { start, end },
      localGoal: `拿到第 ${unitIndex} 组可核对证据`,
      localConflict: '巡检处封锁账房并登记靠近者',
      serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
      payoff: '主角带走证据但名字进入记录',
      stateChangeAfterUnit: '调查从传闻变成可追查证据',
    });
    start = end + 1;
    unitIndex += 1;
  }
  return units;
}

function createVccStoryUnitPlan(chapterCount = 4, overrides: Record<string, unknown> = {}) {
  return {
    planningPrinciple: '主线单元负责工程压力，人物和悬念单元穿插提供情感与信息增量。',
    purposeMix: {
      mainline_progress: '50%',
      character_depth: '20%',
      mystery_clue: '20%',
      daily_buffer: '10%',
    },
    mainlineSegments: [
      {
        segmentId: 'v1_main_01',
        sequence: 1,
        title: '旧闸棚账册入局',
        narrativeFunction: '入局到证据确认',
        mainGoal: '让林澈从传闻进入旧闸棚账册现场并拿到第一份证据',
        mainConflict: '巡检处封锁账房并登记所有靠近者',
        turningPoint: '半页账纸证明东闸名单被改过',
        stateChange: '调查从传闻变成可追查证据',
        requiredDeliveries: ['铜扣证据', '半页账纸'],
      },
    ],
    units: [
      {
        unitId: 'v1_unit_01',
        title: '旧闸棚账册',
        primaryPurpose: 'mainline_progress',
        secondaryPurposes: ['mystery_clue', 'relationship_emotion'],
        relationToMainline: 'direct',
        mainlineSegmentIds: ['v1_main_01'],
        serviceToMainline: '承接旧闸棚账册入局段，让证据取得、关系风险和东闸名单疑点合并推进。',
        suggestedChapterMin: Math.min(1, chapterCount),
        suggestedChapterMax: chapterCount,
        narrativePurpose: '让林澈从传闻进入证据现场，并把账册缺页和东闸封锁建立因果。',
        localGoal: '拿到账册被改的第一份证据',
        localConflict: '巡检处封锁账房并登记所有靠近者',
        requiredDeliveries: ['铜扣证据', '半页账纸'],
        characterFocus: ['林澈', '沈栖'],
        relationshipChanges: ['沈栖从只守规则到替林澈藏下半页账纸'],
        worldbuildingReveals: ['旧闸棚调阅制度和临检记录规则'],
        clueProgression: ['铜扣指向东闸旧名单'],
        emotionalEffect: ['压迫', '悬疑'],
        payoff: '林澈带走半页账纸但名字进入临检记录',
        stateChangeAfterUnit: '调查从传闻变成可追查证据',
      },
    ],
    chapterAllocation: [
      {
        unitId: 'v1_unit_01',
        chapterRange: { start: 1, end: chapterCount },
        chapterRoles: Array.from({ length: chapterCount }, (_, index) => ['入局', '升级', '反转', '收束'][index] ?? `推进${index + 1}`),
      },
    ],
    ...overrides,
  };
}

test('structured output repair helper 可修错误时调用 LLM 并重新 normalize', async () => {
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const errors: Array<{ event: string; error: unknown; payload: Record<string, unknown> }> = [];
  const usages: Array<Record<string, unknown>> = [];
  const repairs: Array<Record<string, unknown>> = [];
  const progress: Array<Record<string, unknown>> = [];
  let shouldRepairCalls = 0;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      assert.match(messages[1].content, /initial missing wrapper/);
      assert.equal(options.jsonMode, true);
      return {
        data: { valid: true, value: 'repaired-value' },
        result: { model: 'mock-structured-repair', usage: { total_tokens: 9 }, elapsedMs: 12, rawPayloadSummary: {} },
      };
    },
  };

  const result = await normalizeWithLlmRepair({
    toolName: 'mock_structured_tool',
    loggerEventPrefix: 'mock_structured_tool',
    llm: llm as never,
    context: {
      agentRunId: 'run-structured-repair-success',
      projectId: 'p1',
      mode: 'plan',
      approved: false,
      outputs: {},
      policy: {},
      recordLlmUsage: (usage) => usages.push(usage as Record<string, unknown>),
      recordRepairDiagnostic: (diagnostic) => repairs.push(diagnostic as unknown as Record<string, unknown>),
      updateProgress: async (patch) => { progress.push(patch as Record<string, unknown>); },
    },
    data: { valid: false, reason: 'initial missing wrapper' },
    normalize: (data) => {
      const record = data as Record<string, unknown>;
      if (record.valid !== true) throw new Error(String(record.reason ?? 'invalid structured output'));
      return { value: String(record.value) };
    },
    shouldRepair: ({ error, attempt }) => {
      shouldRepairCalls += 1;
      assert.equal(attempt, 1);
      return error instanceof Error && error.message.includes('missing wrapper');
    },
    buildRepairMessages: ({ validationError }) => [
      { role: 'system', content: 'Repair JSON only.' },
      { role: 'user', content: validationError },
    ],
    progress: { phaseMessage: '正在修复 mock 结构化输出', timeoutMs: 1234 },
    llmOptions: { appStep: 'planner', timeoutMs: 1234, temperature: 0.1 },
    logger: {
      log: (event, payload) => logs.push({ event, payload: payload ?? {} }),
      error: (event, error, payload) => errors.push({ event, error, payload: payload ?? {} }),
    },
  });

  assert.deepEqual(result, { value: 'repaired-value' });
  assert.equal(shouldRepairCalls, 1);
  assert.deepEqual(usages.map((usage) => usage.model), ['mock-structured-repair']);
  assert.equal(progress[0].phaseMessage, '正在修复 mock 结构化输出');
  assert.deepEqual(logs.map((item) => item.event), ['mock_structured_tool.llm_repair.started', 'mock_structured_tool.llm_repair.completed']);
  assert.equal(errors.length, 0);
  assert.deepEqual(repairs.map((item) => item.model), ['mock-structured-repair']);
  assert.equal(repairs[0].attempts, 1);
  assert.match(String((repairs[0].repairedFromErrors as string[])[0]), /initial missing wrapper/);
  assert.equal(logs[0].payload.attempt, 1);
  assert.equal(logs[1].payload.repairModel, 'mock-structured-repair');
});

test('structured output repair helper 不可修错误保持原错误传播', async () => {
  let llmCalls = 0;
  await assert.rejects(
    () => normalizeWithLlmRepair({
      toolName: 'mock_structured_tool',
      loggerEventPrefix: 'mock_structured_tool',
      llm: {
        async chatJson() {
          llmCalls += 1;
          return { data: {}, result: { model: 'unused', rawPayloadSummary: {} } };
        },
      } as never,
      context: { agentRunId: 'run-structured-repair-skip', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
      data: { valid: false },
      normalize: () => {
        throw new Error('not repairable');
      },
      shouldRepair: () => false,
      buildRepairMessages: () => [{ role: 'system', content: 'unused' }],
    }),
    /not repairable/,
  );
  assert.equal(llmCalls, 0);
});

test('structured output repair helper 修复后仍非法时只尝试默认一次', async () => {
  const errors: Array<{ event: string; error: unknown; payload: Record<string, unknown> }> = [];
  const repairs: Array<Record<string, unknown>> = [];
  let llmCalls = 0;
  await assert.rejects(
    () => normalizeWithLlmRepair({
      toolName: 'mock_structured_tool',
      loggerEventPrefix: 'mock_structured_tool',
      llm: {
        async chatJson() {
          llmCalls += 1;
          return {
            data: { valid: false, reason: 'still invalid after repair' },
            result: { model: 'mock-structured-repair-bad', usage: { total_tokens: 7 }, rawPayloadSummary: {} },
          };
        },
      } as never,
      context: {
        agentRunId: 'run-structured-repair-still-bad',
        projectId: 'p1',
        mode: 'plan',
        approved: false,
        outputs: {},
        policy: {},
        recordRepairDiagnostic: (diagnostic) => repairs.push(diagnostic as unknown as Record<string, unknown>),
      },
      data: { valid: false, reason: 'initial invalid' },
      normalize: (data) => {
        const record = data as Record<string, unknown>;
        if (record.valid !== true) throw new Error(String(record.reason ?? 'invalid structured output'));
        return record;
      },
      shouldRepair: () => true,
      buildRepairMessages: ({ validationError }) => [
        { role: 'system', content: 'Repair JSON only.' },
        { role: 'user', content: validationError },
      ],
      logger: {
        log: () => undefined,
        error: (event, error, payload) => errors.push({ event, error, payload: payload ?? {} }),
      },
    }),
    /still invalid after repair/,
  );
  assert.equal(llmCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, 'mock_structured_tool.llm_repair.failed');
  assert.equal(errors[0].payload.attempt, 1);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].failedError, 'still invalid after repair');
});

test('generate_story_units_preview 生成丰富单元故事计划和章节分配', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  let receivedOptions: Record<string, unknown> | undefined;
  const storyUnitPlan = createVccStoryUnitPlan(4);
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      receivedMessages = messages;
      receivedOptions = options;
      return {
        data: { volumeNo: 1, chapterCount: 4, storyUnitPlan, risks: ['人物情感线需要后续章节承接'] },
        result: { model: 'mock-story-units', usage: { total_tokens: 55 } },
      };
    },
  };
  const tool = new GenerateStoryUnitsPreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: { volumeNo: 1, title: '旧闸棚账册', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4, { storyUnits: undefined }) },
      instruction: '丰富单元故事分类，加入人物登场、人物情感、背景故事和支线小故事',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-story-units', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.volumeNo, 1);
  assert.equal(result.chapterCount, 4);
  assert.equal(result.storyUnitPlan.mainlineSegments.length, 1);
  assert.equal(result.storyUnitPlan.units.length, 1);
  assert.deepEqual(result.storyUnitPlan.units[0].mainlineSegmentIds, ['v1_main_01']);
  assert.equal(result.storyUnitPlan.units[0].secondaryPurposes.length, 2);
  assert.equal(result.storyUnitPlan.chapterAllocation?.[0].chapterRange.end, 4);
  assert.deepEqual(result.risks, ['人物情感线需要后续章节承接']);
  assert.equal(receivedOptions?.jsonMode, true);
  assert.match(receivedMessages[0].content, /人物登场/);
  assert.match(receivedMessages[0].content, /mainlineSegments/);
  assert.match(receivedMessages[0].content, /chapterAllocation/);
  assert.match(receivedMessages[0].content, /不生成 chapters/);
  assert.match(receivedMessages[0].content, /不要在 storyUnitPlan 里偷偷发明未持久化的重要角色/);
  assert.match(receivedMessages[1].content, /上游卷级候选人物/);
});

test('generate_story_units_preview 未传 volumeOutline 时从 inspect context 读取目标卷大纲', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  const storyUnitPlan = createVccStoryUnitPlan(4);
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      receivedMessages = messages;
      return {
        data: { volumeNo: 1, chapterCount: 4, storyUnitPlan, risks: [] },
        result: { model: 'mock-story-units-context-volume' },
      };
    },
  };
  const tool = new GenerateStoryUnitsPreviewTool(llm as never);

  const result = await tool.run(
    {
      context: {
        project: { title: 'Context Project' },
        volumes: [
          { volumeNo: 1, title: 'ContextVolumeOutlineToken', synopsis: 'context synopsis', objective: 'context objective', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4, { storyUnits: undefined }) },
        ],
        characters: [{ name: '林澈' }, { name: '沈栖' }],
      },
      instruction: '只生成单元故事，不重写卷大纲',
      volumeNo: 1,
    },
    { agentRunId: 'run-story-units-context-volume', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapterCount, 4);
  assert.match(receivedMessages[1].content, /ContextVolumeOutlineToken/);
  assert.match(receivedMessages[1].content, /context objective/);
});

test('generate_story_units_preview 从既有卷目标文本推导目标章数并要求覆盖全卷', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  const storyUnitPlan = createVccStoryUnitPlan(60);
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      receivedMessages = messages;
      return {
        data: { volumeNo: 1, chapterCount: 60, storyUnitPlan, risks: [] },
        result: { model: 'mock-story-units-objective-chapter-count' },
      };
    },
  };
  const tool = new GenerateStoryUnitsPreviewTool(llm as never);

  const result = await tool.run(
    {
      context: {
        project: { title: 'Context Project' },
        volumes: [
          { volumeNo: 1, title: '黑脊罪桥', objective: '在60章篇幅内完成流放入局、工队建立和小归潮救亡。', chapterCount: 0, narrativePlan: createVccNarrativePlan({ storyUnits: undefined }) },
        ],
      },
      instruction: '生成单元故事，按照原有卷章节数安排',
      volumeNo: 1,
    },
    { agentRunId: 'run-story-units-objective-chapter-count', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapterCount, 60);
  assert.equal(result.storyUnitPlan.chapterAllocation?.[0].chapterRange.end, 60);
  assert.match(receivedMessages[0].content, /目标章节数为 60/);
  assert.match(receivedMessages[1].content, /目标章节数：60/);
});

test('generate_story_units_preview 缺少主线段时直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  delete badPlan.mainlineSegments;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-missing-mainline', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /mainlineSegments/,
  );
});

test('generate_story_units_preview 缺少 units 时直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  delete badPlan.units;
  let calls = 0;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      calls += 1;
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units-missing-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-missing-units', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /units/,
  );
  assert.equal(calls, 1);
});

test('generate_story_units_preview 单元故事引用未知主线段时直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.units[0].mainlineSegmentIds = ['v1_main_missing'];
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-bad-mainline-ref', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /主线段/,
  );
});

test('generate_story_units_preview 主线段未被任何单元故事覆盖时直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.mainlineSegments.push({
    segmentId: 'v1_main_02',
    sequence: 2,
    title: '东闸名单反转',
    narrativeFunction: '反转',
    mainGoal: '确认名单篡改背后的真正压力来源',
    mainConflict: '巡检处把证据源头转嫁给沈栖家族旧案',
    turningPoint: '账纸背面出现沈栖父亲的旧签名',
    stateChange: '调查目标从找到账册扩展为追查旧案责任链',
    requiredDeliveries: ['旧签名', '责任链新方向'],
  });
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-uncovered-mainline', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /未被单元故事覆盖/,
  );
});

test('generate_story_units_preview 支持灾难求生单元目的', async () => {
  const plan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  plan.purposeMix.survival_disaster = '15%';
  plan.units[0].primaryPurpose = 'survival_disaster';
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: plan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  const result = await tool.run(
    { volumeNo: 1, chapterCount: 4 },
    { agentRunId: 'run-story-units-survival-disaster', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.storyUnitPlan.units[0].primaryPurpose, 'survival_disaster');
});

test('generate_story_units_preview 缺少丰富目的字段时直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  delete badPlan.units[0].secondaryPurposes;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-bad', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /secondaryPurposes/,
  );
});

test('generate_story_units_preview 有目标章数时缺少 chapterAllocation 直接报错', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, unknown>;
  delete badPlan.chapterAllocation;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-missing-allocation', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /chapterAllocation/,
  );
});

test('generate_story_units_preview chapterAllocation 可执行分配优先于建议篇幅', async () => {
  const plan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(6))) as Record<string, any>;
  plan.units[0].suggestedChapterMin = 1;
  plan.units[0].suggestedChapterMax = 2;
  plan.chapterAllocation[0].chapterRange = { start: 1, end: 6 };
  plan.chapterAllocation[0].chapterRoles = ['入局', '试压', '交锋', '反转', '代价', '收束'];
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      return { data: { volumeNo: 1, chapterCount: 6, storyUnitPlan: plan, risks: [] }, result: { model: 'mock-story-units' } };
    },
  } as never);

  const result = await tool.run(
    { volumeNo: 1, chapterCount: 6 },
    { agentRunId: 'run-story-units-flex-allocation', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.storyUnitPlan.units[0].suggestedChapterMax, 2);
  assert.equal(result.storyUnitPlan.chapterAllocation?.[0].chapterRange.end, 6);
  assert.equal(result.storyUnitPlan.chapterAllocation?.[0].chapterRoles.length, 6);
});

test('generate_story_units_preview chapterRoles 数量不匹配时允许一次 LLM 修复', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.chapterAllocation[0].chapterRoles = ['入局', '取证'];
  const repairedPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  repairedPlan.chapterAllocation[0].chapterRoles = ['入局压迫', '取证受阻', '同伴藏证', '带证脱身'];
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const usages: Array<Record<string, unknown>> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return calls.length === 1
        ? { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units-bad', usage: { total_tokens: 11 } } }
        : { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: repairedPlan, risks: [] }, result: { model: 'mock-story-units-repair', usage: { total_tokens: 13 } } };
    },
  };
  const tool = new GenerateStoryUnitsPreviewTool(llm as never);

  const result = await tool.run(
    { volumeNo: 1, chapterCount: 4 },
    {
      agentRunId: 'run-story-units-repair-roles',
      projectId: 'p1',
      mode: 'plan',
      approved: false,
      outputs: {},
      policy: {},
      recordLlmUsage: (usage) => usages.push(usage as Record<string, unknown>),
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[0].content, /storyUnitPlan JSON 修复器/);
  assert.match(calls[1].messages[0].content, /chapterRoles\.length/);
  assert.match(calls[1].messages[1].content, /validationError/);
  assert.match(calls[1].messages[1].content, /chapterRoles/);
  assert.deepEqual(result.storyUnitPlan.chapterAllocation?.[0].chapterRoles, ['入局压迫', '取证受阻', '同伴藏证', '带证脱身']);
  assert.deepEqual(usages.map((usage) => usage.model), ['mock-story-units-bad', 'mock-story-units-repair']);
});

test('generate_story_units_preview chapterRange 不连续时允许一次 LLM 修复', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.chapterAllocation[0].chapterRange = { start: 2, end: 4 };
  badPlan.chapterAllocation[0].chapterRoles = ['误从第二章开始', '推进线索', '阶段收束'];
  const repairedPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  repairedPlan.chapterAllocation[0].chapterRoles = ['第一章入局', '第二章取证', '第三章受阻', '第四章脱身'];
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return calls.length === 1
        ? { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: 'mock-story-units-range-bad' } }
        : { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: repairedPlan, risks: [] }, result: { model: 'mock-story-units-range-repair' } };
    },
  } as never);

  const result = await tool.run(
    { volumeNo: 1, chapterCount: 4 },
    { agentRunId: 'run-story-units-repair-range', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /连续覆盖/);
  assert.deepEqual(result.storyUnitPlan.chapterAllocation?.[0].chapterRange, { start: 1, end: 4 });
  assert.deepEqual(result.storyUnitPlan.chapterAllocation?.[0].chapterRoles, ['第一章入局', '第二章取证', '第三章受阻', '第四章脱身']);
});

test('generate_story_units_preview chapterRange 未覆盖全卷修复后仍非法时继续失败', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.chapterAllocation[0].chapterRange = { start: 1, end: 3 };
  badPlan.chapterAllocation[0].chapterRoles = ['入局', '取证', '受阻'];
  let calls = 0;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      calls += 1;
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: `mock-story-units-uncovered-${calls}` } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-repair-range-still-bad', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /未覆盖到第 4 章/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(badPlan.chapterAllocation[0].chapterRange, { start: 1, end: 3 });
});

test('generate_story_units_preview chapterRoles 修复后仍非法时继续失败且不补占位', async () => {
  const badPlan = JSON.parse(JSON.stringify(createVccStoryUnitPlan(4))) as Record<string, any>;
  badPlan.chapterAllocation[0].chapterRoles = ['入局'];
  let calls = 0;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      calls += 1;
      return { data: { volumeNo: 1, chapterCount: 4, storyUnitPlan: badPlan, risks: [] }, result: { model: `mock-story-units-${calls}` } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-repair-still-bad', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /chapterRoles/,
  );
  assert.equal(calls, 2);
  assert.equal(badPlan.chapterAllocation[0].chapterRoles.length, 1);
});

test('generate_story_units_preview LLM timeout 直接抛错且不生成 fallback', async () => {
  let calls = 0;
  const tool = new GenerateStoryUnitsPreviewTool({
    async chatJson() {
      calls += 1;
      throw new LlmTimeoutError('单元故事超时', 'planner', DEFAULT_LLM_TIMEOUT_MS);
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run-story-units-timeout', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /单元故事超时/,
  );
  assert.equal(calls, 1);
});

test('persist_story_units 审批后只写入 Volume.narrativePlan.storyUnitPlan', async () => {
  const updates: Array<Record<string, any>> = [];
  let chapterTouched = false;
  const prisma = {
    volume: {
      async findUnique() {
        return { id: 'v1', narrativePlan: { volumeMainline: '旧闸棚账册主线' } };
      },
      async update(args: Record<string, any>) {
        updates.push(args);
        return { id: args.where.id };
      },
    },
    chapter: {
      async update() { chapterTouched = true; throw new Error('persist_story_units 不应写章节'); },
      async create() { chapterTouched = true; throw new Error('persist_story_units 不应创建章节'); },
    },
  };
  const tool = new PersistStoryUnitsTool(prisma as never);
  const preview: StoryUnitsPreviewOutput = {
    volumeNo: 1,
    chapterCount: 4,
    storyUnitPlan: createVccStoryUnitPlan(4) as StoryUnitsPreviewOutput['storyUnitPlan'],
    risks: ['待确认情感支线'],
  };

  await assert.rejects(
    () => tool.run(
      { preview },
      { agentRunId: 'run-persist-story-units-plan', projectId: 'p1', mode: 'plan', approved: true, outputs: {}, policy: {} },
    ),
    /act mode/,
  );
  await assert.rejects(
    () => tool.run(
      { preview },
      { agentRunId: 'run-persist-story-units-unapproved', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} },
    ),
    /approval/,
  );

  const result = await tool.run(
    { preview },
    { agentRunId: 'run-persist-story-units', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );
  assert.equal(result.volumeId, 'v1');
  assert.equal(result.storyUnitCount, 1);
  assert.equal(result.updatedStoryUnitPlanOnly, true);
  assert.equal(updates.length, 1);
  assert.equal(chapterTouched, false);
  assert.equal(updates[0].where.id, 'v1');
  assert.equal(updates[0].data.narrativePlan.volumeMainline, '旧闸棚账册主线');
  assert.equal(updates[0].data.narrativePlan.storyUnitPlan.units[0].unitId, 'v1_unit_01');
  assert.equal(updates[0].data.narrativePlan.storyUnits, undefined);
});

test('persist_story_units 按数据库卷计划章数复核章节分配', async () => {
  const shortPlan = createVccStoryUnitPlan(16);
  const prisma = {
    volume: {
      async findUnique() {
        return {
          id: 'v1',
          chapterCount: 0,
          objective: '在60章篇幅内完成第一卷目标。',
          synopsis: '',
          narrativePlan: { volumeMainline: '第一卷主线' },
        };
      },
      async update() {
        throw new Error('不应写入未覆盖全卷的单元故事计划');
      },
    },
  };
  const tool = new PersistStoryUnitsTool(prisma as never);

  await assert.rejects(
    () => tool.run(
      {
        preview: {
          volumeNo: 1,
          storyUnitPlan: shortPlan as StoryUnitsPreviewOutput['storyUnitPlan'],
          risks: [],
        },
      },
      { agentRunId: 'persist-story-units-short-allocation', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /未覆盖到第 60 章|planned chapterCount 60/,
  );
});

function createVccOutlinePreview(chapterCount = 1, overrides: Record<string, unknown> = {}): OutlinePreviewOutput {
  const volume = {
    volumeNo: 1,
    title: '旧闸棚账册',
    synopsis: '卷简介',
    objective: '拿到账册证据',
    chapterCount,
    narrativePlan: createVccNarrativePlanForChapterCount(chapterCount),
    ...(overrides.volume as Record<string, unknown> | undefined),
  };
  const chapters = Array.from({ length: chapterCount }, (_, index) => createOutlineChapter(index + 1, 1, {
    outline: '林澈在旧闸棚账房核对账页墨痕，巡检员夺走账册并登记他的名字；同伴在后门藏下半页证据；雨廊尽头的东闸即将关闭，迫使他带着残缺证据离开。',
  }));
  return {
    volume,
    chapters: (overrides.chapters as OutlinePreviewOutput['chapters'] | undefined) ?? chapters,
    risks: (overrides.risks as string[] | undefined) ?? [],
  };
}

function createVccCharacterExecution(overrides: Record<string, unknown> = {}) {
  return {
    povCharacter: '林澈',
    cast: [
      {
        characterName: '林澈',
        source: 'existing',
        functionInChapter: '追查半页账纸来源',
        visibleGoal: '在旧闸棚封锁前带走账册证据',
        pressure: '巡检员正在登记他的名字',
        actionBeatRefs: [1, 2],
        sceneBeatRefs: ['archive_pressure'],
        entryState: '持有旧账册线索但缺少证据',
        exitState: '带走半页账纸并失去通行牌',
      },
      {
        characterName: '邵衡',
        source: 'volume_candidate',
        functionInChapter: '用一次迟疑暴露巡检处内部裂缝',
        visibleGoal: '阻止林澈立刻公开账册',
        hiddenGoal: '确认林澈是否值得托付登记簿',
        pressure: '巡检处正在清查泄密者',
        actionBeatRefs: [2],
        sceneBeatRefs: ['archive_pressure'],
        entryState: '以巡检处代表身份压制现场',
        exitState: '暗中放过林澈离开旧闸棚',
      },
      {
        characterName: '门卫',
        source: 'minor_temporary',
        functionInChapter: '阻拦门口搜查并制造一次时间压力',
        visibleGoal: '完成门禁登记',
        pressure: '上级要求立刻清空雨廊',
        actionBeatRefs: [3],
        sceneBeatRefs: ['archive_pressure'],
        entryState: '守在旧闸棚门口',
        exitState: '完成搜查后离场',
      },
    ],
    relationshipBeats: [
      {
        participants: ['林澈', '邵衡'],
        publicStateBefore: '互相怀疑',
        trigger: '邵衡没有揭穿半页账纸',
        shift: '林澈意识到他可能不是纯粹敌人',
        publicStateAfter: '表面仍对立，私下出现合作余地',
      },
    ],
    newMinorCharacters: [
      {
        nameOrLabel: '门卫',
        narrativeFunction: '一次性门禁阻力',
        interactionScope: '旧闸棚门口搜查',
        firstAndOnlyUse: true,
        approvalPolicy: 'preview_only',
      },
    ],
    ...overrides,
  };
}

test('VCC character contract accepts complete volume plan and chapter execution', () => {
  const characterPlan = assertVolumeCharacterPlan(createVccCharacterPlan(), {
    chapterCount: 4,
    existingCharacterNames: ['林澈', '沈栖'],
  });
  const characterExecution = assertChapterCharacterExecution(createVccCharacterExecution(), {
    existingCharacterNames: ['林澈', '沈栖'],
    volumeCandidateNames: characterPlan.newCharacterCandidates.map((candidate) => candidate.name),
    actionBeatCount: 3,
    sceneBeats: [{ sceneArcId: 'archive_pressure', participants: ['林澈', '邵衡', '门卫'] }],
  });

  assert.equal(characterPlan.newCharacterCandidates[0].name, '邵衡');
  assert.equal(characterExecution.cast.length, 3);
});

test('VCC character contract rejects missing volume candidate required field', () => {
  for (const field of ['motivation', 'narrativeFunction', 'firstAppearChapter']) {
    const candidate = { ...createVccCharacterPlan().newCharacterCandidates[0] } as Record<string, unknown>;
    delete candidate[field];
    const plan = createVccCharacterPlan({ newCharacterCandidates: [candidate] });

    assert.throws(
      () => assertVolumeCharacterPlan(plan, { chapterCount: 4, existingCharacterNames: ['林澈', '沈栖'] }),
      new RegExp(field),
    );
  }
});

test('VCC character contract rejects candidate first appearance outside volume range', () => {
  const plan = createVccCharacterPlan({
    newCharacterCandidates: [
      {
        ...createVccCharacterPlan().newCharacterCandidates[0],
        firstAppearChapter: 9,
      },
    ],
  });

  assert.throws(
    () => assertVolumeCharacterPlan(plan, { chapterCount: 4, existingCharacterNames: ['林澈', '沈栖'] }),
    /firstAppearChapter/,
  );
});

test('VCC character contract rejects unknown volume character references', () => {
  const badCandidate = {
    ...createVccCharacterPlan().newCharacterCandidates[0],
    conflictWith: ['不存在的人'],
  };
  const badCoverage = createVccCharacterPlan({
    roleCoverage: {
      ...createVccCharacterPlan().roleCoverage,
      expositionCarriers: ['未建档角色'],
    },
  });

  assert.throws(
    () => assertVolumeCharacterPlan(createVccCharacterPlan({ newCharacterCandidates: [badCandidate] }), { chapterCount: 4, existingCharacterNames: ['林澈', '沈栖'] }),
    /conflictWith.*未知角色/,
  );
  assert.throws(
    () => assertVolumeCharacterPlan(badCoverage, { chapterCount: 4, existingCharacterNames: ['林澈', '沈栖'] }),
    /roleCoverage\.expositionCarriers.*未知角色/,
  );
});

test('VCC character contract rejects self-declared existing characters without catalog', () => {
  assert.throws(
    () => assertVolumeCharacterPlan(createVccCharacterPlan(), { chapterCount: 4, existingCharacterNames: [] }),
    /existingCharacterArcs\[0\]\.characterName.*未知既有角色/,
  );
});

test('VCC character contract rejects unknown chapter character references', () => {
  const execution = createVccCharacterExecution({
    cast: [
      {
        ...createVccCharacterExecution().cast[0],
        characterName: '陌生人',
        source: 'existing',
      },
    ],
  });

  assert.throws(
    () => assertChapterCharacterExecution(execution, { existingCharacterNames: ['林澈'], volumeCandidateNames: ['邵衡'] }),
    /未知既有角色/,
  );
});

test('VCC character contract rejects scene participants missing from cast', () => {
  assert.throws(
    () => assertChapterCharacterExecution(createVccCharacterExecution(), {
      existingCharacterNames: ['林澈'],
      volumeCandidateNames: ['邵衡'],
      sceneBeats: [{ sceneArcId: 'archive_pressure', participants: ['林澈', '邵衡', '未列入角色'] }],
    }),
    /未被 characterExecution\.cast 覆盖/,
  );
});

test('VCC character contract rejects important temporary character metadata', () => {
  const execution = createVccCharacterExecution({
    newMinorCharacters: [
      {
        ...createVccCharacterExecution().newMinorCharacters[0],
        narrativeFunction: '承担本卷主线长期关键配角弧线',
      },
    ],
  });

  assert.throws(
    () => assertChapterCharacterExecution(execution, { existingCharacterNames: ['林澈'], volumeCandidateNames: ['邵衡'] }),
    /临时角色承担了重要或长期角色功能/,
  );
});

test('VCC context injection exposes aliases relationships and character states', async () => {
  const prisma = {
    project: {
      async findUnique() {
        return { id: 'p1', title: '旧档案', genre: '悬疑', theme: '记忆', tone: '冷峻', synopsis: '档案缺页', outline: '追查旧案' };
      },
    },
    volume: { async findMany() { return []; } },
    chapter: { async findMany() { return []; } },
    character: {
      async findMany() {
        return [
          {
            name: '林澈',
            alias: ['阿澈', '旧闸棚学徒'],
            roleType: 'protagonist',
            motivation: '找到账册缺页真相',
            personalityCore: '谨慎但会为证据冒险',
            scope: 'global',
            activeFromChapter: 1,
            activeToChapter: null,
            source: 'manual',
          },
        ];
      },
    },
    relationshipEdge: {
      async findMany() {
        return [
          {
            characterAName: '林澈',
            characterBName: '沈栖',
            relationType: '同盟',
            publicState: '互相信任但仍隐瞒账册来源',
            hiddenState: '沈栖担心林澈过早公开证据',
            conflictPoint: '是否立刻公布半页账纸',
            emotionalArc: '从互相利用转向并肩',
            turnChapterNos: [2, 4],
            finalState: '愿意共同承担旧案风险',
            status: 'active',
          },
        ];
      },
    },
    characterStateSnapshot: {
      async findMany() {
        return [
          { characterName: '林澈', chapterNo: 3, stateType: 'location', stateValue: '受伤后仍在东闸雨廊', summary: '带着半页账纸等待沈栖', status: 'auto' },
        ];
      },
    },
    lorebookEntry: { async findMany() { return []; } },
  };
  const tool = new InspectProjectContextTool(prisma as never);
  const result = await tool.run({}, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.deepEqual(result.characters[0].aliases, ['阿澈', '旧闸棚学徒']);
  assert.equal(result.characters[0].scope, 'global');
  assert.match(result.characters[0].relationshipAnchors[0], /沈栖｜同盟｜互相信任/);
  assert.equal(result.relationships[0].conflictPoint, '是否立刻公布半页账纸');
  assert.deepEqual(result.relationships[0].turnChapterNos, [2, 4]);
  assert.equal(result.characterStates[0].stateValue, '受伤后仍在东闸雨廊');
});

test('VCC context injection prompts include character relationship and state summaries', async () => {
  const aliasCharacterPlan = createVccCharacterPlan({
    existingCharacterArcs: createVccCharacterPlan().existingCharacterArcs.map((arc) => ({ ...arc, characterName: '阿澈' })),
    relationshipArcs: createVccCharacterPlan().relationshipArcs.map((arc) => ({ ...arc, participants: ['阿澈', '邵衡'] })),
  });
  const aliasNarrativePlan = createVccNarrativePlan({ characterPlan: aliasCharacterPlan });
  const baseCraftBrief = createOutlineCraftBrief();
  const aliasCraftBrief = {
    ...baseCraftBrief,
    storyUnit: {
      ...baseCraftBrief.storyUnit,
      chapterRange: { start: 1, end: 1 },
    },
    sceneBeats: baseCraftBrief.sceneBeats.map((beat) => ({
      ...beat,
      participants: beat.participants.map((participant) => (participant === '林澈' ? '阿澈' : participant)),
    })),
    characterExecution: {
      ...baseCraftBrief.characterExecution,
      povCharacter: '阿澈',
      cast: baseCraftBrief.characterExecution.cast.map((member) => (
        member.characterName === '林澈' ? { ...member, characterName: '阿澈' } : member
      )),
      relationshipBeats: baseCraftBrief.characterExecution.relationshipBeats.map((beat) => ({
        ...beat,
        participants: beat.participants.map((participant) => (participant === '林澈' ? '阿澈' : participant)),
      })),
    },
  };
  const aliasChapter = createOutlineChapter(1, 1, { craftBrief: aliasCraftBrief });
  const aliasPreview = createVccOutlinePreview(1, {
    volume: {
      narrativePlan: createVccNarrativePlanForChapterCount(1, {
        characterPlan: createVccCharacterPlanForChapterCount(1, {
          existingCharacterArcs: createVccCharacterPlanForChapterCount(1).existingCharacterArcs.map((arc) => ({ ...arc, characterName: '阿澈' })),
          relationshipArcs: createVccCharacterPlanForChapterCount(1).relationshipArcs.map((arc) => ({ ...arc, participants: ['阿澈', '邵衡'] })),
        }),
      }),
    },
    chapters: [aliasChapter],
  });
  const enrichedContext = {
    project: { title: '旧档案', tone: '冷峻' },
    characters: [
      {
        name: '林澈',
        aliases: ['阿澈'],
        roleType: 'protagonist',
        motivation: '找到账册缺页真相',
        scope: 'global',
        activeFromChapter: 1,
        relationshipAnchors: ['沈栖｜同盟｜互相信任但仍隐瞒账册来源'],
      },
      { name: '沈栖', aliases: [], roleType: 'supporting', motivation: '保护登记簿', scope: 'global', relationshipAnchors: ['林澈｜同盟'] },
    ],
    relationships: [
      {
        characterAName: '林澈',
        characterBName: '沈栖',
        relationType: '同盟',
        publicState: '互相信任但仍隐瞒账册来源',
        conflictPoint: '是否立刻公布半页账纸',
        turnChapterNos: [2, 4],
      },
    ],
    characterStates: [
      { characterName: '林澈', chapterNo: 3, stateType: 'location', stateValue: '受伤后仍在东闸雨廊', summary: '带着半页账纸等待沈栖' },
    ],
  };
  let volumePrompt = '';
  const volumeTool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>) {
      volumePrompt = messages[1].content;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '## 全书主线阶段\n从传闻进入证据\n## 本卷主线\n找到账册缺页证据\n## 本卷戏剧问题\n林澈能否在封锁前拿到证据\n## 卷内支线\n账册缺页线\n## 单元故事\n旧闸棚账册\n## 支线交叉点\n铜扣\n## 卷末交接\n东闸名单压力',
            objective: '拿到账册被改的第一份证据',
            chapterCount: 4,
            narrativePlan: aliasNarrativePlan,
          },
          risks: [],
        },
        result: { model: 'mock-volume-context' },
      };
    },
  } as never);
  await volumeTool.run(
    { context: enrichedContext, instruction: '为第 1 卷生成角色规划和卷纲', volumeNo: 1, chapterCount: 4 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  let outlinePrompt = '';
  const outlineTool = new GenerateOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>) {
      outlinePrompt = messages[1].content;
      return { data: aliasPreview, result: { model: 'mock-outline-context' } };
    },
  } as never);
  await outlineTool.run(
    { context: enrichedContext, instruction: '为第 1 卷生成 1 章细纲', volumeNo: 1, chapterCount: 1 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  let chapterPrompt = '';
  const chapterTool = new GenerateChapterOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>) {
      chapterPrompt = messages[1].content;
      return {
        data: { volume: aliasPreview.volume, chapter: aliasChapter, risks: [] },
        result: { model: 'mock-chapter-context' },
      };
    },
  } as never);
  await chapterTool.run(
    {
      context: enrichedContext,
      volumeOutline: aliasPreview.volume as unknown as Record<string, unknown>,
      instruction: '生成第 1 章细纲',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 1,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal((aliasPreview.chapters[0].craftBrief?.characterExecution?.cast[0] as { characterName?: string }).characterName, '阿澈');
  for (const prompt of [volumePrompt, outlinePrompt, chapterPrompt]) {
    assert.match(prompt, /已有角色摘要/);
    assert.match(prompt, /阿澈/);
    assert.match(prompt, /既有关系边摘要/);
    assert.match(prompt, /是否立刻公布半页账纸/);
    assert.match(prompt, /近期角色状态摘要/);
    assert.match(prompt, /受伤后仍在东闸雨廊/);
  }
});

test('VCC volume outline preview preserves complete characterPlan', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      receivedMessages = messages;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '## 全书主线阶段\n从传闻进入证据\n## 本卷主线\n找到账册缺页证据\n## 本卷戏剧问题\n林澈能否在封锁前拿到证据\n## 卷内支线\n账册缺页线\n## 单元故事\n旧闸棚账册\n## 支线交叉点\n铜扣\n## 卷末交接\n东闸名单压力',
            objective: '拿到账册被改的第一份证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan(),
          },
          risks: [],
        },
        result: { model: 'mock-volume-character-plan' },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      instruction: '为第 1 卷生成角色规划和卷纲',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const characterPlan = result.volume.narrativePlan?.characterPlan as Record<string, unknown>;
  assert.ok(characterPlan);
  assert.equal((characterPlan.newCharacterCandidates as Array<Record<string, unknown>>)[0].name, '邵衡');
  assert.match(receivedMessages[0].content, /characterPlan/);
  assert.match(receivedMessages[0].content, /newCharacterCandidates/);
  assert.match(receivedMessages[0].content, /protagonist, antagonist, supporting, minor/);
  assert.match(receivedMessages[0].content, /key_missing_family/);
  assert.match(receivedMessages[0].content, /重要新人物必须新增为 newCharacterCandidates/);
  assert.match(receivedMessages[0].content, /newCharacterCandidates\.name 可以被/);
  assert.match(receivedMessages[1].content, /已有角色摘要/);
  assert.match(receivedMessages[1].content, /既有角色白名单/);
  assert.match(receivedMessages[1].content, /existingCharacterArcs\.characterName 只能使用/);
});

test('VCC volume outline preview rejects unknown existing character and prompts candidate use', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const badCharacterPlan = createVccCharacterPlan({
    existingCharacterArcs: [
      ...createVccCharacterPlan().existingCharacterArcs,
      {
        characterName: '罗嵩',
        roleInVolume: '流放营管事，制造制度压力',
        entryState: '尚未进入既有角色库',
        volumeGoal: '压住罪籍工匠并维持营规',
        pressure: '小归潮倒计时和浮税盟催料',
        keyChoices: ['是否允许陆沉舟验材'],
        firstActiveChapter: 1,
        lastActiveChapter: 4,
        endState: '被迫暴露活盐骨替材线索',
      },
    ],
  });
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>) {
      calls.push({ messages });
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '## 全书主线阶段\n从传闻进入证据\n## 本卷主线\n找到账册缺页证据\n## 本卷戏剧问题\n林澈能否在封锁前拿到证据\n## 卷内支线\n账册缺页线\n## 单元故事\n旧闸棚账册\n## 支线交叉点\n铜扣\n## 卷末交接\n东闸名单压力',
            objective: '拿到账册被改的第一份证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan({ characterPlan: badCharacterPlan }),
          },
          risks: [],
        },
        result: { model: 'mock-volume-character-plan' },
      };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
        instruction: '为第 1 卷生成角色规划和卷纲',
        volumeNo: 1,
        chapterCount: 4,
      },
      { agentRunId: 'run-volume-unknown-existing-character', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /引用未知既有角色：罗嵩。.*newCharacterCandidates/,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[0].content, /不在白名单中的人物/);
  assert.match(calls[0].messages[1].content, /既有角色白名单/);
  assert.match(calls[0].messages[1].content, /newCharacterCandidates/);
  assert.match(calls[1].messages[0].content, /未知人物若确实是本卷重要新人物/);
  assert.match(calls[1].messages[1].content, /validationError/);
});

test('generate_volume_outline_preview 未知既有角色可由 LLM 修复为新增候选人物', async () => {
  const badCharacterPlan = createVccCharacterPlan({
    existingCharacterArcs: [
      ...createVccCharacterPlan().existingCharacterArcs,
      {
        characterName: '罗嵩',
        roleInVolume: '流放营管事，制造制度压力',
        entryState: '尚未进入既有角色库',
        volumeGoal: '压住罪籍工匠并维持营规',
        pressure: '小归潮倒计时和浮税盟催料',
        keyChoices: ['是否允许林澈验材'],
        firstActiveChapter: 1,
        lastActiveChapter: 4,
        endState: '被迫暴露活盐骨替材线索',
      },
    ],
  });
  const repairedCharacterPlan = createVccCharacterPlan({
    newCharacterCandidates: [
      {
        candidateId: 'cand_luosong',
        name: '罗嵩',
        roleType: 'antagonist',
        scope: 'volume',
        narrativeFunction: '作为流放营管事，把营规剥削和替材压力具象化',
        personalityCore: '精明、强硬、习惯借规矩压人',
        motivation: '保住营地供料指标并遮住替材账',
        conflictWith: ['林澈'],
        relationshipAnchors: ['林澈'],
        firstAppearChapter: 1,
        expectedArc: '从营规执行者逐步暴露为替材链条的明面压力',
        approvalStatus: 'candidate',
      },
    ],
    relationshipArcs: [
      {
        participants: ['林澈', '罗嵩'],
        startState: '罗嵩用营规压制林澈验材',
        turnChapterNos: [2, 4],
        endState: '林澈拿到罗嵩参与替材的第一条实证',
      },
    ],
    roleCoverage: {
      mainlineDrivers: ['林澈'],
      antagonistPressure: ['罗嵩'],
      emotionalCounterweights: ['沈栖'],
      expositionCarriers: ['沈栖'],
    },
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const characterPlan = calls.length === 1 ? badCharacterPlan : repairedCharacterPlan;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '## 全书主线阶段\n从传闻进入证据\n## 本卷主线\n找到账册缺页证据\n## 本卷戏剧问题\n林澈能否在封锁前拿到证据\n## 卷内支线\n账册缺页线\n## 角色与势力功能\n罗嵩制造营规压力\n## 伏笔分配\n铜扣\n## 支线交叉点\n验材冲突\n## 卷末交接\n东闸名单压力',
            objective: '拿到账册被改的第一份证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan({ characterPlan }),
          },
          risks: [],
        },
        result: { model: `mock-volume-outline-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      instruction: '为第 1 卷生成角色规划和卷纲',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-volume-repair-unknown-existing-character', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const resultCharacterPlan = result.volume.narrativePlan?.characterPlan as ReturnType<typeof createVccCharacterPlan>;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[0].content, /未知人物若确实是本卷重要新人物/);
  assert.equal(resultCharacterPlan.newCharacterCandidates[0].name, '罗嵩');
  assert.equal(resultCharacterPlan.existingCharacterArcs.some((arc) => arc.characterName === '罗嵩'), false);
});

test('generate_volume_outline_preview 既有角色误名可由 LLM 修复为白名单角色名', async () => {
  const badCharacterPlan = createVccCharacterPlan({
    existingCharacterArcs: createVccCharacterPlan().existingCharacterArcs.map((arc, index) => (
      index === 0 ? { ...arc, characterName: '林彻' } : arc
    )),
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan({ characterPlan: calls.length === 1 ? badCharacterPlan : createVccCharacterPlan() }),
          },
          risks: [],
        },
        result: { model: `mock-volume-outline-alias-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { characters: [{ name: '林澈', aliases: ['阿澈'] }, { name: '沈栖' }] },
      instruction: '生成卷纲',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-volume-repair-existing-name', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const resultCharacterPlan = result.volume.narrativePlan?.characterPlan as ReturnType<typeof createVccCharacterPlan>;
  assert.equal(calls.length, 2);
  assert.equal(resultCharacterPlan.existingCharacterArcs[0].characterName, '林澈');
});

test('VCC volume outline preview accepts missing person as new character candidate', async () => {
  const baseCandidate = createVccCharacterPlan().newCharacterCandidates[0];
  const characterPlan = createVccCharacterPlan({
    newCharacterCandidates: [
      {
        ...baseCandidate,
        candidateId: 'cand_luosong',
        name: '罗嵩',
        roleType: 'antagonist',
        narrativeFunction: '作为流放营管事，把营规剥削和活盐骨替材压力具象化',
        personalityCore: '精明、强硬、习惯用规矩压人',
        motivation: '保住营地供料指标并遮住替材账',
        conflictWith: ['林澈'],
        relationshipAnchors: ['林澈'],
        firstAppearChapter: 1,
        expectedArc: '从营规执行者逐步暴露为替材链条的明面压力',
      },
    ],
    relationshipArcs: [
      {
        participants: ['林澈', '罗嵩'],
        startState: '罗嵩用营规压制林澈验材',
        turnChapterNos: [2, 4],
        endState: '林澈拿到罗嵩参与替材的第一条实证',
      },
    ],
    roleCoverage: {
      mainlineDrivers: ['林澈'],
      antagonistPressure: ['罗嵩'],
      emotionalCounterweights: ['沈栖'],
      expositionCarriers: ['沈栖'],
    },
  });
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '## 全书主线阶段\n从传闻进入证据\n## 本卷主线\n找到账册缺页证据\n## 本卷戏剧问题\n林澈能否在封锁前拿到证据\n## 卷内支线\n账册缺页线\n## 角色与势力功能\n罗嵩制造营规压力\n## 伏笔分配\n铜扣\n## 支线交叉点\n验材冲突\n## 卷末交接\n东闸名单压力',
            objective: '拿到账册被改的第一份证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan({ characterPlan }),
          },
          risks: [],
        },
        result: { model: 'mock-volume-character-plan' },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      instruction: '为第 1 卷生成角色规划和卷纲',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-volume-new-character-candidate', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const resultCharacterPlan = result.volume.narrativePlan?.characterPlan as ReturnType<typeof createVccCharacterPlan>;
  assert.equal(resultCharacterPlan.newCharacterCandidates[0].name, '罗嵩');
  assert.deepEqual(resultCharacterPlan.roleCoverage.antagonistPressure, ['罗嵩']);
});

test('VCC volume outline preview rejects missing candidate motivation', async () => {
  const badPlan = createVccNarrativePlan({
    characterPlan: createVccCharacterPlan({
      newCharacterCandidates: [
        {
          candidateId: 'cand_shaoheng',
          name: '邵衡',
          roleType: 'supporting',
          scope: 'volume',
          narrativeFunction: '作为巡检处内线，把制度压力具象化为可对抗的人',
          personalityCore: '谨慎、讲秩序',
          firstAppearChapter: 2,
          expectedArc: '从旁观内线转为主动递交关键登记簿',
          approvalStatus: 'candidate',
        },
      ],
    }),
  });
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan: badPlan,
          },
          risks: [],
        },
        result: { model: 'mock-volume-character-plan' },
      };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { context: { characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成卷纲', volumeNo: 1, chapterCount: 4 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /motivation/,
  );
});

test('generate_volume_outline_preview newCharacterCandidates 缺字段可由 LLM 修复', async () => {
  const badPlan = createVccNarrativePlan({
    characterPlan: createVccCharacterPlan({
      newCharacterCandidates: [
        {
          ...createVccCharacterPlan().newCharacterCandidates[0],
          motivation: '',
        },
      ],
    }),
  });
  const repairedPlan = createVccNarrativePlan();
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan: calls.length === 1 ? badPlan : repairedPlan,
          },
          risks: [],
        },
        result: { model: `mock-volume-candidate-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    { context: { characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成卷纲', volumeNo: 1, chapterCount: 4 },
    { agentRunId: 'run-volume-repair-candidate-field', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const candidate = ((result.volume.narrativePlan?.characterPlan as ReturnType<typeof createVccCharacterPlan>).newCharacterCandidates[0] as Record<string, unknown>);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /motivation/);
  assert.equal(candidate.motivation, '想在不暴露自己的前提下纠正旧案记录');
});

test('VCC outline preview requires volume characterPlan', async () => {
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      const chapterNo = match ? Number(match[1]) : 1;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan(),
          },
          chapters: [createOutlineChapter(chapterNo, 1)],
          risks: [],
        },
        result: { model: 'mock-outline-character-plan' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      instruction: '为第 1 卷生成 4 章细纲并安排角色',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapters.length, 4);
  assert.equal(((result.volume.narrativePlan?.characterPlan as Record<string, unknown>).newCharacterCandidates as Array<Record<string, unknown>>)[0].name, '邵衡');
});

test('VCC outline preview accepts volume narrativePlan without legacy storyUnits', async () => {
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      const chapterNo = match ? Number(match[1]) : 1;
      const narrativePlan = { ...createVccNarrativePlan(), storyUnits: undefined };
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan,
          },
          chapters: [createOutlineChapter(chapterNo, 1)],
          risks: [],
        },
        result: { model: 'mock-outline-incomplete-narrative' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      instruction: '生成完整细纲',
      volumeNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-vcc-outline-narrative', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  assert.equal(result.chapters.length, 4);
  assert.equal((result.volume.narrativePlan as Record<string, unknown>).storyUnits, undefined);
});

test('VCC chapter outline preview preserves characterExecution', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          chapter: createOutlineChapter(2, 1),
          risks: [],
        },
        result: { model: 'mock-chapter-character-execution' },
      };
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: {
        volumeNo: 1,
        title: '旧闸棚账册',
        synopsis: '卷简介',
        objective: '拿到账册证据',
        chapterCount: 4,
        narrativePlan: createVccNarrativePlan(),
      },
      instruction: '生成第 2 章角色执行',
      volumeNo: 1,
      chapterNo: 2,
      chapterCount: 4,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapter.craftBrief?.characterExecution?.povCharacter, '林澈');
  assert.equal(result.chapter.craftBrief?.characterExecution?.cast.some((member) => member.characterName === '邵衡' && member.source === 'volume_candidate'), true);
});

test('VCC chapter outline preview rejects character not in volume candidates', async () => {
  const badCraftBrief = createOutlineCraftBrief({
    characterExecution: {
      ...createOutlineCraftBrief().characterExecution,
      cast: [
        ...(createOutlineCraftBrief().characterExecution.cast as Array<Record<string, unknown>>).filter((member) => member.characterName !== '邵衡'),
        {
          ...(createOutlineCraftBrief().characterExecution.cast as Array<Record<string, unknown>>).find((member) => member.characterName === '邵衡'),
          characterName: '未入候选',
          source: 'volume_candidate',
        },
      ],
    },
  });
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson() {
      return {
        data: {
          chapter: createOutlineChapter(2, 1, { craftBrief: badCraftBrief }),
          risks: [],
        },
        result: { model: 'mock-chapter-character-execution' },
      };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
        volumeOutline: {
          volumeNo: 1,
          title: '旧闸棚账册',
          synopsis: '卷简介',
          objective: '拿到账册证据',
          chapterCount: 4,
          narrativePlan: createVccNarrativePlan(),
        },
        instruction: '生成第 2 章角色执行',
        volumeNo: 1,
        chapterNo: 2,
        chapterCount: 4,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /未进入卷级角色候选/,
  );
});

test('VCC chapter outline preview rejects important temporary character', async () => {
  const badExecution = {
    ...createOutlineCraftBrief().characterExecution,
    cast: (createOutlineCraftBrief().characterExecution.cast as Array<Record<string, unknown>>).map((member) => (
      member.characterName === '巡检员'
        ? { ...member, functionInChapter: '承担本卷主线核心反派主压力' }
        : member
    )),
  };
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson() {
      return {
        data: {
          chapter: createOutlineChapter(2, 1, { craftBrief: createOutlineCraftBrief({ characterExecution: badExecution }) }),
          risks: [],
        },
        result: { model: 'mock-chapter-character-execution' },
      };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
        volumeOutline: {
          volumeNo: 1,
          title: '旧闸棚账册',
          synopsis: '卷简介',
          objective: '拿到账册证据',
          chapterCount: 4,
          narrativePlan: createVccNarrativePlan(),
        },
        instruction: '生成第 2 章角色执行',
        volumeNo: 1,
        chapterNo: 2,
        chapterCount: 4,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /临时角色承担了重要或长期角色功能/,
  );
});

test('VCC outline preview rejects scene participant outside characterExecution cast', async () => {
  const badCraftBrief = createOutlineCraftBrief({
    sceneBeats: [
      {
        ...createOutlineCraftBrief().sceneBeats[0],
        participants: ['林澈', '未列入角色'],
      },
      ...(createOutlineCraftBrief().sceneBeats as Array<Record<string, unknown>>).slice(1),
    ],
  });
  const tool = new GenerateOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      const chapterNo = match ? Number(match[1]) : 1;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '旧闸棚账册',
            synopsis: '卷简介',
            objective: '拿到账册证据',
            chapterCount: 4,
            narrativePlan: createVccNarrativePlan(),
          },
          chapters: [createOutlineChapter(chapterNo, 1, { craftBrief: badCraftBrief })],
          risks: [],
        },
        result: { model: 'mock-outline-character-execution' },
      };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
        instruction: '为第 1 卷生成 4 章细纲',
        volumeNo: 1,
        chapterCount: 4,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /未被 characterExecution\.cast 覆盖/,
  );
});

test('VCC merge chapter outline previews rejects missing characterExecution', async () => {
  const craftBrief = createOutlineCraftBrief();
  delete (craftBrief as Record<string, unknown>).characterExecution;
  const tool = new MergeChapterOutlinePreviewsTool();
  const characterPlan = createVccCharacterPlan({
    existingCharacterArcs: [
      {
        ...createVccCharacterPlan().existingCharacterArcs[0],
        lastActiveChapter: 1,
      },
    ],
    newCharacterCandidates: [
      {
        ...createVccCharacterPlan().newCharacterCandidates[0],
        firstAppearChapter: 1,
      },
    ],
    relationshipArcs: [
      {
        ...createVccCharacterPlan().relationshipArcs[0],
        turnChapterNos: [1],
      },
    ],
  });

  await assert.rejects(
    () => tool.run(
      {
        previews: [
          {
            volume: { volumeNo: 1, title: '旧闸棚账册', synopsis: '卷简介', objective: '拿到账册证据', chapterCount: 1, narrativePlan: createVccNarrativePlan({ storyUnits: [{ unitId: 'v1_unit_01', title: '短单元', chapterRange: { start: 1, end: 1 }, localGoal: '短目标', localConflict: '短阻力', serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'], payoff: '短回收', stateChangeAfterUnit: '短变化' }], characterPlan }) },
            chapter: createOutlineChapter(1, 1, { craftBrief }),
            chapters: [createOutlineChapter(1, 1, { craftBrief })],
            risks: [],
          },
        ],
        volumeNo: 1,
        chapterCount: 1,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /craftBrief 不完整/,
  );
});

const TARGETED_IMPORT_PREVIEW_TOOL_NAMES = [
  'generate_import_project_profile_preview',
  'generate_import_outline_preview',
  'generate_import_characters_preview',
  'generate_import_worldbuilding_preview',
  'generate_import_writing_rules_preview',
];

function createProjectImportToolRegistry(targetToolNames = TARGETED_IMPORT_PREVIEW_TOOL_NAMES, includeBuildImportPreview = true): ToolRegistryService {
  const toolNames = [
    'read_source_document',
    'analyze_source_text',
    'build_import_brief',
    ...(includeBuildImportPreview ? ['build_import_preview'] : []),
    ...targetToolNames,
    'merge_import_previews',
    'cross_target_consistency_check',
    'validate_imported_assets',
    'persist_project_assets',
  ];
  return {
    list: () => toolNames.map((name) => createTool({
      name,
      requiresApproval: name === 'persist_project_assets',
      sideEffects: name === 'persist_project_assets' ? ['update_project_profile'] : [],
    })),
  } as unknown as ToolRegistryService;
}

function createGenerationProfile(overrides: Record<string, unknown> = {}) {
  return {
    source: 'database',
    defaultChapterWordCount: null,
    autoContinue: false,
    autoSummarize: true,
    autoUpdateCharacterState: true,
    autoUpdateTimeline: false,
    autoValidation: true,
    allowNewCharacters: false,
    allowNewLocations: true,
    allowNewForeshadows: true,
    preGenerationChecks: [],
    promptBudget: {},
    metadata: {},
    ...overrides,
  };
}

test('RuleEngine 暴露统一策略上限和硬规则', () => {
  const rules = new RuleEngineService();
  assert.equal(rules.getPolicy().limits.maxSteps, 100);
  assert.equal(rules.getPolicy().limits.maxLlmCalls, 2);
  assert.ok(rules.listHardRules().some((rule) => rule.includes('Plan 模式禁止')));
});

test('Policy 阻止未审批写入类 Tool 执行', () => {
  const policy = new AgentPolicyService(new RuleEngineService());
  assert.throws(
    () => policy.assertAllowed(createTool(), { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} }, ['write_chapter']),
    /需要用户审批/,
  );
});

test('Policy 阻止 Plan 模式执行副作用 Tool', () => {
  const policy = new AgentPolicyService(new RuleEngineService());
  assert.throws(
    () => policy.assertAllowed(createTool({ allowedModes: ['plan', 'act'], requiresApproval: false }), { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }, ['write_chapter']),
    /Plan 模式禁止执行有副作用工具/,
  );
});

test('Policy 阻止 Act 执行未出现在计划中的 Tool', () => {
  const policy = new AgentPolicyService(new RuleEngineService());
  assert.throws(
    () => policy.assertAllowed(createTool({ requiresApproval: false }), { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }, ['resolve_chapter']),
    /不在已批准计划中/,
  );
});

test('Policy 阻止超过步骤上限的计划执行', () => {
  const rules = new RuleEngineService();
  const policy = new AgentPolicyService(rules);
  const tooManySteps = Array.from({ length: rules.getPolicy().limits.maxSteps + 1 }, (_, index) => ({ stepNo: index + 1, name: `步骤${index + 1}`, tool: 'echo_report', mode: 'act' as const, requiresApproval: false, args: {} }));
  assert.throws(() => policy.assertPlanExecutable(tooManySteps), /步骤数超过上限/);
});

test('Policy 要求事实层/高风险 Tool 二次确认', () => {
  const policy = new AgentPolicyService(new RuleEngineService());
  const tool = createTool({ name: 'extract_chapter_facts', riskLevel: 'high', sideEffects: ['replace_auto_story_events'] });
  assert.throws(
    () => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }, ['extract_chapter_facts']),
    /需要二次确认/,
  );
  assert.throws(
    () => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }, ['extract_chapter_facts']),
    AgentSecondConfirmationRequiredError,
  );
  assert.doesNotThrow(() => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: { confirmation: { confirmHighRisk: true } } }, ['extract_chapter_facts']));
  assert.doesNotThrow(() =>
    policy.assertAllowed(
      tool,
      { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: { confirmation: { confirmedRiskIds: ['high_risk', 'destructive_side_effect', 'fact_layer_write'] } } },
      ['extract_chapter_facts'],
    ),
  );
});

test('Executor Schema 校验必填、额外字段和数值范围', () => {
  const executor = new AgentExecutorService({} as never, {} as never, {} as never, {} as never) as unknown as { assertSchema: (schema: unknown, value: unknown, path: string) => void };
  const schema = {
    type: 'object' as const,
    required: ['chapterId', 'wordCount'],
    additionalProperties: false,
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      wordCount: { type: 'number' as const, minimum: 100, maximum: 50000 },
    },
  };
  assert.throws(() => executor.assertSchema(schema, { chapterId: '', wordCount: 1000 }, 'tool.input'), /长度不能小于/);
  assert.throws(() => executor.assertSchema(schema, { chapterId: 'c1', wordCount: 50 }, 'tool.input'), /不能小于/);
  assert.throws(() => executor.assertSchema(schema, { chapterId: 'c1', wordCount: 1000, extra: true }, 'tool.input'), /不是允许的字段/);
  assert.doesNotThrow(() => executor.assertSchema(schema, { chapterId: 'c1', wordCount: 1000 }, 'tool.input'));
});

test('Executor Schema 校验整数、字符串格式和数组长度', () => {
  const executor = new AgentExecutorService({} as never, {} as never, {} as never, {} as never) as unknown as { assertSchema: (schema: unknown, value: unknown, path: string) => void };
  const schema = {
    type: 'object' as const,
    required: ['chapterNo', 'requestId', 'tags'],
    properties: {
      chapterNo: { type: 'number' as const, integer: true, minimum: 1 },
      requestId: { type: 'string' as const, minLength: 8, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
      tags: { type: 'array' as const, minItems: 1, maxItems: 3, items: { type: 'string' as const } },
    },
  };
  assert.throws(() => executor.assertSchema(schema, { chapterNo: 1.5, requestId: 'req_123456', tags: ['a'] }, 'tool.input'), /必须是整数/);
  assert.throws(() => executor.assertSchema(schema, { chapterNo: 1, requestId: 'bad id !', tags: ['a'] }, 'tool.input'), /格式不符合/);
  assert.throws(() => executor.assertSchema(schema, { chapterNo: 1, requestId: 'req_123456', tags: [] }, 'tool.input'), /数组长度不能小于/);
  assert.doesNotThrow(() => executor.assertSchema(schema, { chapterNo: 1, requestId: 'req_123456', tags: ['a', 'b'] }, 'tool.input'));
});

test('Executor 解析完整步骤输出引用时保留对象类型', () => {
  const executor = new AgentExecutorService({} as never, {} as never, {} as never, {} as never) as unknown as {
    resolveValue: (value: unknown, outputs: Record<number, unknown>) => unknown;
  };
  const context = { project: { title: '测试项目' }, chapters: [{ chapterNo: 1 }] };
  const resolved = executor.resolveValue({ context: '{{steps.1.output}}', title: '{{steps.1.output.project.title}}' }, { 1: context });

  assert.deepEqual(resolved, { context, title: '测试项目' });
});

test('GenerateChapterService 生成后质量门禁阻断拒答和占位符', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (content: string, actualWordCount: number, targetWordCount: number) => { blocked: boolean; blockers: string[]; warnings: string[]; score: number };
  };
  const result = service.assessGeneratedDraftQuality('作为AI，我无法完成这个请求。{{待补充正文}}', 24, 3500);
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.length >= 2);
  assert.ok(result.score < 50);
});

test('GenerateChapterService 生成后质量门禁标记重复段落退化', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (content: string, actualWordCount: number, targetWordCount: number) => { blocked: boolean; blockers: string[] };
  };
  const repeated = Array.from({ length: 5 }, () => '走廊尽头的灯忽明忽暗，脚步声一次次逼近，像有什么东西贴着墙面缓慢爬行。').join('\n');
  const result = service.assessGeneratedDraftQuality(repeated, 2200, 3000);
  assert.equal(result.blocked, true);
  assert.match(result.blockers.join('；'), /重复段落/);
});

test('GenerateChapterService 生成后质量门禁提示修辞堆叠的 AI 味', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (content: string, actualWordCount: number, targetWordCount: number) => { warnings: string[]; metrics: { aiTasteHitCount: number; ornamentalParagraphCount: number } };
  };
  const content = [
    '刑车刚过西崖哨门，天上的海先落了一线。',
    '不是雨。盐水从倒悬的垂海底部渗下来，细如断银，敲在车棚上，噼啪成片。车厢里霉草、汗臭和铁锈味搅在一处，脚镣被震得乱响。有人伸手去接那水，指腹立刻白了一层，像被薄刀刮过。',
    '陆沉舟抬头。',
    '垂海倒扣在天穹上，青黑色潮腹压得很低，边缘翻着白沫。按潮历，小归潮还有三日，流放营该有三日验桥、三日转运、三日封仓。',
  ].join('\n\n');
  const result = service.assessGeneratedDraftQuality(content, 650, 3000);
  assert.ok(result.metrics.aiTasteHitCount >= 1);
  assert.ok(result.metrics.ornamentalParagraphCount >= 1);
  assert.match(result.warnings.join('；'), /AI 味|修辞|感官/);
});

test('GenerateChapterService maps pass and warning quality gates to QualityReport payloads', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildGenerationQualityReportData: (input: Record<string, unknown>) => Record<string, unknown>;
  };
  const qualityGate = {
    valid: true,
    blocked: false,
    score: 96,
    blockers: [],
    warnings: [],
    metrics: {
      actualWordCount: 3200,
      targetWordCount: 3000,
      targetRatio: 1.06,
      paragraphCount: 32,
      duplicateParagraphCount: 0,
      duplicateParagraphRatio: 0,
      hasWrapperOrMarkdown: false,
      hasRefusalPattern: false,
      hasTemplateMarker: false,
    },
  };
  const passReport = service.buildGenerationQualityReportData({
    projectId: 'p1',
    chapterId: '11111111-1111-4111-8111-111111111111',
    draftId: '22222222-2222-4222-8222-222222222222',
    agentRunId: 'not-a-uuid',
    qualityGate,
    actualWordCount: 3200,
    targetWordCount: 3000,
    summary: 'ok',
    modelInfo: {},
  });
  const warnReport = service.buildGenerationQualityReportData({
    projectId: 'p1',
    chapterId: '11111111-1111-4111-8111-111111111111',
    draftId: '22222222-2222-4222-8222-222222222222',
    agentRunId: '33333333-3333-4333-8333-333333333333',
    qualityGate: { ...qualityGate, score: 72, warnings: ['too short'] },
    actualWordCount: 1800,
    targetWordCount: 3000,
    summary: 'warn',
    modelInfo: {},
  });
  const failReport = service.buildGenerationQualityReportData({
    projectId: 'p1',
    chapterId: '11111111-1111-4111-8111-111111111111',
    draftId: '22222222-2222-4222-8222-222222222222',
    qualityGate: { ...qualityGate, valid: false, blocked: true, score: 20, blockers: ['refusal text'] },
    actualWordCount: 40,
    targetWordCount: 3000,
    summary: 'fail',
    modelInfo: {},
  });

  assert.equal(passReport.verdict, 'pass');
  assert.equal(passReport.agentRunId, undefined);
  assert.equal(warnReport.verdict, 'warn');
  assert.equal(warnReport.agentRunId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(warnReport.issues, [{ severity: 'warning', issueType: 'generation_quality_gate_warning', message: 'too short' }]);
  assert.equal(failReport.verdict, 'fail');
  assert.deepEqual(failReport.issues, [{ severity: 'error', issueType: 'generation_quality_gate_blocker', message: 'refusal text' }]);
});

test('EmbeddingGatewayService splits large embedding requests by local service batch limit', async () => {
  const service = new EmbeddingGatewayService() as unknown as {
    embedTexts: (texts: string[], options?: Record<string, unknown>) => Promise<{ vectors: number[][]; model: string; usage?: Record<string, number> }>;
    requestEmbedding: (_config: unknown, input: string[], _options: unknown, _trace: unknown) => Promise<{ vectors: number[][]; model: string; usage: Record<string, number>; rawPayloadSummary: Record<string, unknown> }>;
  };
  const batchSizes: number[] = [];
  service.requestEmbedding = async (_config, input) => {
    batchSizes.push(input.length);
    return {
      vectors: input.map((_, index) => [batchSizes.length, index]),
      model: 'mock-embedding',
      usage: { total_tokens: input.length },
      rawPayloadSummary: { count: input.length },
    };
  };

  const result = await service.embedTexts(Array.from({ length: 35 }, (_, index) => `memory ${index}`), { retries: 0 });

  assert.deepEqual(batchSizes, [32, 3]);
  assert.equal(result.vectors.length, 35);
  assert.deepEqual(result.vectors[0], [1, 0]);
  assert.deepEqual(result.vectors[32], [2, 0]);
  assert.equal(result.usage?.total_tokens, 35);
});

test('GenerateChapterService 生成前细纲密度检查标记缺失执行卡字段', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessOutlineDensity: (
      chapter: { objective: string | null; conflict: string | null; outline: string | null; craftBrief?: unknown },
      input: { outlineQualityGate?: 'warning' | 'blocker' },
    ) => { valid: boolean; blockers: string[]; warnings: string[]; missing: string[] };
  };
  const result = service.assessOutlineDensity({ objective: null, conflict: null, outline: '主角走到井边。', craftBrief: {} }, { outlineQualityGate: 'warning' });
  assert.equal(result.valid, true);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.warnings.length >= 4);
  assert.ok(result.missing.includes('objective'));
  assert.ok(result.missing.includes('action_beats'));
  assert.ok(result.missing.includes('story_unit'));
  assert.ok(result.missing.includes('scene_beats'));
  assert.ok(result.missing.includes('concrete_clues'));
  assert.ok(result.missing.includes('irreversible_consequence'));
  assert.ok(result.missing.includes('chapter_handoff'));
});

test('GenerateChapterService 完整 craftBrief 通过细纲密度检查', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessOutlineDensity: (
      chapter: { objective: string | null; conflict: string | null; outline: string | null; craftBrief?: unknown },
      input: { outlineQualityGate?: 'warning' | 'blocker' },
    ) => { valid: boolean; warnings: string[]; missing: string[] };
  };
  const result = service.assessOutlineDensity({
    objective: '确认井边湿红线来自失踪者衣物',
    conflict: '守井人阻止主角靠近后院',
    outline: '短纲',
    craftBrief: createOutlineCraftBrief({
      visibleGoal: '确认失踪者最后出现位置',
      coreConflict: '守井人阻止主角靠近',
      actionBeats: ['主角绕到井后', '守井人故意打翻灯油', '主角抢在火起前捡走湿红线'],
      concreteClues: [{ name: '湿红线', sensoryDetail: '冰凉，带井水泥腥味', laterUse: '证明失踪者来过井边' }],
      irreversibleConsequence: '主角拿走木珠后，井开始叫他的名字',
    }),
  }, { outlineQualityGate: 'warning' });
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.missing, []);
});

test('GenerateChapterService 生成后执行卡覆盖检查标记漏写关键项', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (
      content: string,
      actualWordCount: number,
      targetWordCount: number,
      chapter?: { outline: string | null; craftBrief?: unknown },
    ) => { blocked: boolean; warnings: string[]; executionCardCoverage?: { missing: { clueNames: string[]; irreversibleConsequence?: string } } };
  };
  const content = '主角绕过祠堂后院，和守井人短暂交锋，最后带着一身泥水离开。';
  const result = service.assessGeneratedDraftQuality(content, 1200, 1600, {
    outline: null,
    craftBrief: {
      concreteClues: [{ name: '湿红线', sensoryDetail: '冰凉，带井水泥腥味', laterUse: '证明失踪者来过井边' }],
      irreversibleConsequence: '井开始叫他的名字',
    },
  });
  assert.equal(result.blocked, false);
  assert.match(result.warnings.join('；'), /湿红线/);
  assert.match(result.warnings.join('；'), /不可逆后果/);
  assert.deepEqual(result.executionCardCoverage?.missing.clueNames, ['湿红线']);
  assert.equal(result.executionCardCoverage?.missing.irreversibleConsequence, '井开始叫他的名字');
});

test('GenerateChapterService scene card coverage adds traceable warnings without blocking', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (
      content: string,
      actualWordCount: number,
      targetWordCount: number,
      chapter?: { outline: string | null; craftBrief?: unknown },
      sceneCards?: unknown[],
    ) => { blocked: boolean; warnings: string[]; sceneCardCoverage?: { missing: Array<{ title: string; missingFields: Array<{ field: string; value: string }>; relatedForeshadowIds: string[] }> } };
  };
  const sceneCards = [{
    id: 'scene-1',
    sceneNo: 1,
    title: 'Archive Gate',
    locationName: 'Old archive',
    participants: ['Lin Che'],
    purpose: 'Enter the locked archive.',
    conflict: 'The guard hides the ledger key.',
    emotionalTone: 'cold dread',
    keyInformation: 'The ledger has a missing page.',
    result: 'Lin Che gets a false key.',
    relatedForeshadowIds: ['foreshadow-1'],
    status: 'planned',
    metadata: { beat: 'reveal' },
    sourceTrace: { sourceType: 'scene_card', sourceId: 'scene-1', projectId: 'p1', chapterId: 'c4', chapterNo: 4, sceneNo: 1 },
  }];

  const result = service.assessGeneratedDraftQuality('Lin Che waits in the rain and leaves before anyone opens the gate.', 900, 1200, { outline: null, craftBrief: {} }, sceneCards);

  assert.equal(result.blocked, false);
  assert.match(result.warnings.join(' | '), /SceneCard coverage warning/);
  assert.equal(result.sceneCardCoverage?.missing[0].title, 'Archive Gate');
  assert.ok(result.sceneCardCoverage?.missing[0].missingFields.some((field) => field.field === 'keyInformation'));
  assert.ok(result.sceneCardCoverage?.missing[0].missingFields.some((field) => field.field === 'result'));
  assert.deepEqual(result.sceneCardCoverage?.missing[0].relatedForeshadowIds, ['foreshadow-1']);
});

test('GenerateChapterService sorts SceneCards predictably and preserves trace metadata', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildSceneExecutionPlans: (sceneCards: Array<Record<string, unknown>>, chapter: { id: string; chapterNo: number }) => Array<Record<string, unknown>>;
  };
  const base = {
    projectId: 'p1',
    volumeId: null,
    chapterId: 'c4',
    chapterNo: 4,
    locationName: null,
    participants: [],
    purpose: null,
    conflict: null,
    emotionalTone: null,
    keyInformation: null,
    result: null,
    relatedForeshadowIds: [],
    status: 'planned',
    metadata: {},
  };
  const plans = service.buildSceneExecutionPlans([
    { ...base, id: 'scene-null', sceneNo: null, title: 'No Number', updatedAt: new Date('2026-05-05T00:00:03Z') },
    { ...base, id: 'scene-2-late', sceneNo: 2, title: 'Second Late', updatedAt: new Date('2026-05-05T00:00:04Z') },
    { ...base, id: 'scene-1', sceneNo: 1, title: 'First', updatedAt: new Date('2026-05-05T00:00:05Z'), relatedForeshadowIds: ['f1'], metadata: { beat: 'plant' } },
    { ...base, id: 'scene-2-early', sceneNo: 2, title: 'Second Early', updatedAt: new Date('2026-05-05T00:00:01Z') },
  ], { id: 'c4', chapterNo: 4 });

  assert.deepEqual(plans.map((scene) => scene.id), ['scene-1', 'scene-2-early', 'scene-2-late', 'scene-null']);
  assert.deepEqual(plans[0].relatedForeshadowIds, ['f1']);
  assert.deepEqual(plans[0].metadata, { beat: 'plant' });
  assert.deepEqual(plans[0].sourceTrace, { sourceType: 'scene_card', sourceId: 'scene-1', projectId: 'p1', volumeId: null, chapterId: 'c4', chapterNo: 4, sceneNo: 1 });
});

test('GenerateChapterService run carries current chapter SceneCards and planned TimelineEvents without future prompt leaks', async () => {
  let sceneWhere: Record<string, unknown> | undefined;
  let timelineWhere: Record<string, unknown> | undefined;
  let draftCreateData: Record<string, unknown> | undefined;
  let qualityReportData: Record<string, unknown> | undefined;
  let llmUserPrompt = '';
  const chapter = {
    id: 'c1',
    chapterNo: 4,
    title: 'Archive Gate',
    objective: 'Open the archive',
    conflict: 'The guard lies',
    outline: 'Lin Che tests the guard at the archive gate.',
    revealPoints: null,
    foreshadowPlan: null,
    craftBrief: {},
    expectedWordCount: 240,
    status: 'planned',
    project: {
      id: 'p1',
      title: 'Novel',
      genre: null,
      tone: null,
      synopsis: null,
      outline: null,
      defaultStyleProfileId: null,
      creativeProfile: null,
      generationProfile: null,
    },
    volume: null,
  };
  const prisma = {
    chapter: {
      async findFirst() {
        return chapter;
      },
      async findMany() {
        return [];
      },
      async update() {
        return { ...chapter, status: 'drafted' };
      },
    },
    chapterDraft: {
      async findFirst() {
        return null;
      },
      async updateMany() {
        return { count: 0 };
      },
      async create(args: { data: Record<string, unknown> }) {
        draftCreateData = args.data;
        return { id: 'draft-created', versionNo: 1, ...args.data };
      },
    },
    styleProfile: { async findFirst() { return null; } },
    character: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    sceneCard: {
      async findMany(args: { where: Record<string, unknown> }) {
        sceneWhere = args.where;
        return [{
          id: 'scene-run',
          projectId: 'p1',
          volumeId: null,
          chapterId: 'c1',
          sceneNo: 1,
          title: 'Archive Gate Scene',
          locationName: 'Old archive',
          participants: ['Lin Che'],
          purpose: 'Enter the archive.',
          conflict: 'The guard hides the ledger key.',
          emotionalTone: 'cold dread',
          keyInformation: 'The ledger has a missing page.',
          result: 'Lin Che gets a false key.',
          relatedForeshadowIds: ['f-ledger'],
          status: 'planned',
          metadata: { beat: 'reveal' },
          updatedAt: new Date('2026-05-05T00:00:00Z'),
        }];
      },
    },
    timelineEvent: {
      async findMany(args: { where: Record<string, unknown> }) {
        timelineWhere = args.where;
        return [
          {
            id: 'timeline-plan-current',
            projectId: 'p1',
            chapterId: 'c1',
            chapterNo: 4,
            title: 'Planned archive gate breach',
            eventTime: '第四章黄昏',
            locationName: 'Old archive',
            participants: ['Lin Che'],
            cause: 'Lin Che follows the false key.',
            result: 'The archive gate opens to a missing page.',
            impactScope: 'archive',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'planned',
            sourceType: 'agent_timeline_plan',
            metadata: { sourceTrace: { sourceKind: 'planned_timeline_event' } },
            updatedAt: new Date('2026-05-04T00:00:00Z'),
          },
          {
            id: 'timeline-active-current',
            projectId: 'p1',
            chapterId: 'c1',
            chapterNo: 4,
            title: 'Active should not be planning context',
            eventTime: '第四章',
            locationName: 'Old archive',
            participants: ['Lin Che'],
            cause: 'already happened',
            result: 'active event belongs to verified retrieval only',
            impactScope: 'archive',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: [],
            eventStatus: 'active',
            sourceType: 'manual',
            metadata: {},
            updatedAt: new Date('2026-05-04T00:00:00Z'),
          },
          {
            id: 'timeline-plan-future',
            projectId: 'p1',
            chapterId: 'c5',
            chapterNo: 5,
            title: 'Future plan',
            eventTime: '第五章',
            locationName: 'Old archive',
            participants: ['Lin Che'],
            cause: 'future outline',
            result: 'future planned event stays out',
            impactScope: 'archive',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: [],
            eventStatus: 'planned',
            sourceType: 'agent_timeline_plan',
            metadata: {},
            updatedAt: new Date('2026-05-05T00:00:00Z'),
          },
          {
            id: 'timeline-plan-cross-project',
            projectId: 'p2',
            chapterId: 'c1',
            chapterNo: 4,
            title: 'Cross project plan',
            eventTime: '第四章',
            locationName: 'Old archive',
            participants: ['Lin Che'],
            cause: 'wrong project',
            result: 'must not enter context',
            impactScope: 'archive',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: [],
            eventStatus: 'planned',
            sourceType: 'agent_timeline_plan',
            metadata: {},
            updatedAt: new Date('2026-05-06T00:00:00Z'),
          },
        ];
      },
    },
    promptTemplate: {
      async findFirst() {
        return { systemPrompt: 'system prompt', userTemplate: 'user template' };
      },
    },
    qualityReport: {
      async create(args: { data: Record<string, unknown> }) {
        qualityReportData = args.data;
        return { id: 'quality-report', ...args.data };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  const retrievalPlanner = {
    async createPlan() {
      return {
        plan: { lorebookQueries: [], memoryQueries: [], relationshipQueries: [], timelineQueries: [], writingRuleQueries: [], foreshadowQueries: [], chapterTasks: [], constraints: [], entities: { characters: [] } },
        diagnostics: { planner: 'mock' },
      };
    },
  };
  const retrieval = {
    async retrieveBundleWithCacheMeta() {
      return {
        lorebookHits: [],
        memoryHits: [],
        structuredHits: [],
        rankedHits: [],
        cache: { strategy: 'mock' },
        diagnostics: { searchMethod: 'disabled', qualityScore: 0.9, qualityStatus: 'ok', memoryAvailableCount: 0, warnings: [] },
      };
    },
  };
  const llm = {
    async chat(messages: Array<{ role: string; content: string }>) {
      llmUserPrompt = messages.find((message) => message.role === 'user')?.content ?? '';
      return {
        text: 'Lin Che reaches the Old archive. The ledger has a missing page. Lin Che gets a false key. '.repeat(20),
        model: 'mock-generate-model',
        usage: { total_tokens: 120 },
        rawPayloadSummary: { id: 'mock' },
      };
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new GenerateChapterService(
    prisma as never,
    llm as never,
    retrieval as never,
    new PromptBuilderService(prisma as never),
    retrievalPlanner as never,
    { async listByChapter() { return []; } } as never,
    cache as never,
  );

  const result = await service.run('p1', 'c1', { instruction: 'Write the planned scene.' });
  const contextPack = result.retrievalPayload.contextPack as { verifiedContext: { structuredHits: Array<Record<string, unknown>> }; planningContext: { sceneCards: Array<Record<string, unknown>>; plannedTimelineEvents: Array<Record<string, unknown>> } };
  const promptTrace = result.promptDebug.sceneCardSourceTrace as Array<Record<string, unknown>>;
  const generationContext = draftCreateData?.generationContext as { retrievalPayload: { contextPack: { planningContext: { sceneCards: Array<Record<string, unknown>>; plannedTimelineEvents: Array<Record<string, unknown>> } } } };

  assert.deepEqual(sceneWhere, { projectId: 'p1', chapterId: 'c1', NOT: { status: 'archived' } });
  assert.deepEqual(timelineWhere, { projectId: 'p1', eventStatus: 'planned', OR: [{ chapterId: 'c1' }, { chapterNo: 4 }] });
  assert.equal(contextPack.planningContext.sceneCards[0].id, 'scene-run');
  assert.deepEqual(contextPack.planningContext.sceneCards[0].relatedForeshadowIds, ['f-ledger']);
  assert.deepEqual(contextPack.planningContext.sceneCards[0].metadata, { beat: 'reveal' });
  assert.deepEqual(contextPack.planningContext.plannedTimelineEvents.map((item) => item.id), ['timeline-plan-current']);
  assert.deepEqual(contextPack.planningContext.plannedTimelineEvents[0].participants, ['Lin Che']);
  assert.equal((contextPack.planningContext.plannedTimelineEvents[0].sourceTrace as Record<string, unknown>).sourceKind, 'planned_timeline_event');
  assert.equal(contextPack.verifiedContext.structuredHits.some((hit) => hit.sourceType === 'timeline_event'), false);
  assert.equal(result.promptDebug.verifiedTimelineEventCount, 0);
  assert.equal(result.promptDebug.plannedTimelineEventCount, 1);
  assert.match(llmUserPrompt, /current_chapter_planned_timeline/);
  assert.match(llmUserPrompt, /Planned archive gate breach/);
  assert.match(llmUserPrompt, /sourceId=timeline-plan-current/);
  assert.doesNotMatch(llmUserPrompt, /Future plan/);
  assert.doesNotMatch(llmUserPrompt, /future planned event stays out/);
  assert.doesNotMatch(llmUserPrompt, /Cross project plan/);
  assert.doesNotMatch(llmUserPrompt, /Active should not be planning context/);
  assert.deepEqual(promptTrace[0], { sourceType: 'scene_card', sourceId: 'scene-run', projectId: 'p1', volumeId: null, chapterId: 'c1', chapterNo: 4, sceneNo: 1 });
  assert.equal(generationContext.retrievalPayload.contextPack.planningContext.sceneCards[0].id, 'scene-run');
  assert.equal(generationContext.retrievalPayload.contextPack.planningContext.plannedTimelineEvents[0].id, 'timeline-plan-current');
  assert.equal(((qualityReportData?.metadata as Record<string, unknown>).qualityGate as Record<string, unknown>).sceneCardCoverage !== undefined, true);
  assert.equal(result.qualityGate.sceneCardCoverage?.missing.length, 0);
});

test('GenerateChapterService uses GenerationProfile as conservative word count fallback', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    resolveTargetWordCount: (
      input: { wordCount?: number },
      chapter: { expectedWordCount: number | null; project: { creativeProfile?: { chapterWordCount: number | null } | null } },
      generationProfile: { defaultChapterWordCount: number | null },
    ) => number;
  };
  const generationProfile = createGenerationProfile({ defaultChapterWordCount: 2400 });

  assert.equal(service.resolveTargetWordCount({}, { expectedWordCount: null, project: { creativeProfile: null } }, generationProfile), 2400);
  assert.equal(service.resolveTargetWordCount({}, { expectedWordCount: null, project: { creativeProfile: { chapterWordCount: 1800 } } }, generationProfile), 1800);
  assert.equal(service.resolveTargetWordCount({ wordCount: 1200 }, { expectedWordCount: 1600, project: { creativeProfile: { chapterWordCount: 1800 } } }, generationProfile), 1200);
});

test('GenerateChapterService preflight warns or blocks disallowed new entity candidates from GenerationProfile', async () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never, { async listByChapter() { return []; } } as never) as unknown as {
    runPreflight: (
      projectId: string,
      chapter: { id: string; chapterNo: number; objective: string | null; conflict: string | null; outline: string | null; craftBrief?: unknown; status: string },
      currentDraftVersionNo: number | undefined,
      input: { instruction?: string; outlineQualityGate?: 'warning' | 'blocker' },
      generationProfile: ReturnType<typeof createGenerationProfile>,
    ) => Promise<{ valid: boolean; blockers: string[]; warnings: string[]; newEntityPolicy: { candidates: Array<{ type: string }> } }>;
  };
  const chapter = {
    id: 'c1',
    chapterNo: 3,
    objective: '新增角色沈砚加入队伍',
    conflict: '守门人阻止主角进入档案库',
    outline: '主角在档案库外遇到阻力。',
    craftBrief: {
      visibleGoal: '进入档案库',
      coreConflict: '守门人阻止',
      actionBeats: ['对峙', '绕行', '取得钥匙'],
      concreteClues: [{ name: '铜钥匙' }],
      irreversibleConsequence: '守门人认出主角身份',
    },
    status: 'planned',
  };

  const warningResult = await service.runPreflight('p1', chapter, undefined, {}, createGenerationProfile({ allowNewCharacters: false, preGenerationChecks: [] }));
  assert.equal(warningResult.valid, true);
  assert.match(warningResult.warnings.join('；'), /禁止新增角色/);
  assert.equal(warningResult.newEntityPolicy.candidates.some((item) => item.type === 'character'), true);

  const blockerResult = await service.runPreflight('p1', chapter, undefined, {}, createGenerationProfile({ allowNewCharacters: false, preGenerationChecks: ['blockNewEntities'] }));
  assert.equal(blockerResult.valid, false);
  assert.match(blockerResult.blockers.join('；'), /禁止新增角色/);
});

test('ChapterAutoRepairService 可从草稿上下文提取执行卡覆盖问题', () => {
  const service = new ChapterAutoRepairService({} as never, {} as never) as unknown as {
    readDraftExecutionCardCoverage: (generationContext: unknown) => unknown;
    buildCoverageRepairIssues: (coverage: unknown) => Array<{ severity: string; message: string; suggestion?: string }>;
  };
  const coverage = service.readDraftExecutionCardCoverage({
    qualityGate: {
      executionCardCoverage: {
        warnings: ['正文未覆盖执行卡关键物证/线索：湿红线。'],
        missing: { clueNames: ['湿红线'], irreversibleConsequence: '井开始叫他的名字' },
      },
    },
  });
  const issues = service.buildCoverageRepairIssues(coverage);
  assert.ok(issues.length >= 2);
  assert.ok(issues.every((issue) => issue.severity === 'warning'));
  assert.match(issues.map((issue) => issue.message).join('；'), /湿红线/);
  assert.match(issues.map((issue) => issue.message).join('；'), /不可逆后果|井开始叫他的名字/);
});

test('Executor 在 Run 被取消后停止后续步骤', async () => {
  let lookupCount = 0;
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        lookupCount += 1;
        // 第一次读取用于加载上下文，后续带 select.status 的读取用于取消检查。
        return args.select?.status ? { status: 'cancelled' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
  };
  const tools = { get: () => createTool({ requiresApproval: false, riskLevel: 'low', sideEffects: [] }) };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep() {} };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);
  await assert.rejects(
    () => executor.execute('run1', [{ stepNo: 1, name: '测试步骤', tool: 'write_chapter', mode: 'act', requiresApproval: false, args: {} }], { mode: 'act', approved: true }),
    /已取消/,
  );
  assert.equal(lookupCount, 2);
});

test('Executor 将二次确认缺失转换为等待复核而不是执行失败', async () => {
  const reviewed: Array<{ stepNo: number; error: unknown }> = [];
  const prisma = {
    agentRun: { async findUnique(args: { select?: { status?: boolean } }) { return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' }; } },
  };
  const tools = { get: () => createTool({ name: 'fact_validation', requiresApproval: true, sideEffects: ['replace_fact_rule_validation_issues'] }) };
  const policy = {
    assertPlanExecutable() {},
    assertAllowed() { throw new AgentSecondConfirmationRequiredError('fact_validation', ['destructive_side_effect', 'fact_layer_write']); },
  };
  const trace = {
    startStep() {},
    finishStep() {},
    failStep() { throw new Error('二次确认不应记录为 failed step'); },
    reviewStep(_agentRunId: string, stepNo: number, error: unknown) { reviewed.push({ stepNo, error }); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  await assert.rejects(
    () => executor.execute('run1', [{ stepNo: 1, name: '事实校验', tool: 'fact_validation', mode: 'act', requiresApproval: true, args: {} }], { mode: 'act', approved: true }),
    /需要二次确认/,
  );
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].stepNo, 1);
});

test('Runtime 遇到等待复核异常时保持 Run 为 waiting_review', async () => {
  const updates: Array<Record<string, unknown>> = [];
  let currentStatus = 'waiting_approval';
  const prisma = {
    agentPlan: { async findFirst() { return { version: 1, taskType: 'chapter_write', steps: [] }; } },
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: '测试目标', input: { contextSnapshot: { schemaVersion: 2, session: { currentProjectId: 'p1' } } }, status: currentStatus }; },
      async updateMany(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        if (typeof args.data.status === 'string') currentStatus = args.data.status;
        return { count: 1 };
      },
      async update(args: { data: Record<string, unknown> }) { updates.push(args.data); return { id: 'run1', status: args.data.status, error: args.data.error }; },
    },
  };
  const executor = { async execute() { throw new AgentWaitingReviewError('工具 fact_validation 命中风险 destructive_side_effect, fact_layer_write，需要二次确认'); } };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, executor as never, {} as never, {} as never);

  const result = await runtime.act('run1');
  assert.equal(result.status, 'waiting_review');
  assert.ok(updates.some((item) => item.status === 'waiting_review'));
});

test('Executor 重试只复用当前计划中同 stepNo 且同 toolName 的成功输出', async () => {
  const prisma = {
    agentStep: {
      async findMany() {
        return [
          { stepNo: 1, toolName: 'resolve_chapter', output: { chapterId: 'c1' } },
          { stepNo: 2, toolName: 'old_tool', output: { stale: true } },
          { stepNo: 3, toolName: 'write_chapter', output: null },
        ];
      },
    },
  };
  const tools = {
    get(name: string) {
      return createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [], outputSchema: { type: 'object' } });
    },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, {} as never, {} as never) as unknown as {
    loadReusableOutputs: (agentRunId: string, mode: 'act', planVersion: number, steps: Array<{ stepNo: number; tool: string }>) => Promise<Record<number, unknown>>;
  };
  const outputs = await executor.loadReusableOutputs('run1', 'act', 2, [
    { stepNo: 1, tool: 'resolve_chapter' },
    { stepNo: 2, tool: 'collect_chapter_context' },
    { stepNo: 3, tool: 'write_chapter' },
  ]);
  assert.deepEqual(outputs, { 1: { chapterId: 'c1' } });
});

test('Executor Act 阶段复用同版本 Plan 预览输出作为后续步骤输入', async () => {
  let previewToolRunCount = 0;
  let receivedContext: unknown;
  let receivedToolContext: Record<string, unknown> | undefined;
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
    agentStep: {
      async findMany(args: { where: { mode: string } }) {
        if (args.where.mode === 'act') return [];
        return [{ stepNo: 1, toolName: 'collect_chapter_context', output: { chapterId: 'c1', cached: true } }];
      },
    },
  };
  const tools = {
    get(name: string) {
      if (name === 'collect_chapter_context') {
        return createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [], outputSchema: { type: 'object' }, async run() { previewToolRunCount += 1; return { cached: false }; } });
      }
      return createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [], inputSchema: { type: 'object', properties: { context: { type: 'object' } } }, outputSchema: { type: 'object' }, async run(args: Record<string, unknown>, context) { receivedContext = args.context; receivedToolContext = context as unknown as Record<string, unknown>; return { ok: true }; } });
    },
  };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep() {} };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);
  const outputs = await executor.execute(
    'run1',
    [
      { stepNo: 1, name: '收集上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: {} },
      { stepNo: 2, name: '使用上下文', tool: 'report_result', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}' } },
    ],
    { mode: 'act', approved: true, reuseSucceeded: true, planVersion: 1 },
  );

  assert.equal(previewToolRunCount, 0);
  assert.deepEqual(receivedContext, { chapterId: 'c1', cached: true });
  assert.deepEqual(receivedToolContext?.stepTools, { 1: 'collect_chapter_context', 2: 'report_result' });
  assert.deepEqual(outputs[1], { chapterId: 'c1', cached: true });
});

test('Trace 使用 mode + planVersion 隔离 Plan 预览、Act 执行和 replan 步骤', async () => {
  const upserts: Array<{ agentRunId: string; stepNo: number; mode: string; planVersion: number }> = [];
  const updates: Array<{ agentRunId: string; stepNo: number; mode: string; planVersion: number; status?: string }> = [];
  const prisma = {
    agentRun: { async updateMany() { return { count: 1 }; } },
    agentStep: {
      async upsert(args: { where: { agentRunId_mode_planVersion_stepNo: { agentRunId: string; stepNo: number; mode: string; planVersion: number } }; create: { mode: string } }) {
        upserts.push(args.where.agentRunId_mode_planVersion_stepNo);
      },
      async updateMany(args: { where: { agentRunId: string; stepNo: number; mode: string; planVersion: number; status?: string } }) {
        updates.push(args.where);
        return { count: 1 };
      },
      async findUnique(args: { where: { agentRunId_mode_planVersion_stepNo: { agentRunId: string; stepNo: number; mode: string; planVersion: number } } }) {
        return args.where.agentRunId_mode_planVersion_stepNo;
      },
    },
  };
  const trace = new AgentTraceService(prisma as never);
  await trace.startStep('run1', 2, { stepType: 'tool', name: 'Plan 预览', toolName: 'collect_chapter_context', mode: 'plan', planVersion: 2 });
  await trace.finishStep('run1', 2, { ok: true }, 'plan', 2);
  await trace.startStep('run1', 2, { stepType: 'tool', name: 'Act 执行', toolName: 'collect_chapter_context', mode: 'act', planVersion: 2 });
  await trace.finishStep('run1', 2, { ok: true }, 'act', 2);
  assert.deepEqual(upserts, [
    { agentRunId: 'run1', stepNo: 2, mode: 'plan', planVersion: 2 },
    { agentRunId: 'run1', stepNo: 2, mode: 'act', planVersion: 2 },
  ]);
  assert.deepEqual(updates, [
    { agentRunId: 'run1', stepNo: 2, mode: 'plan', planVersion: 2, status: 'running' },
    { agentRunId: 'run1', stepNo: 2, mode: 'act', planVersion: 2, status: 'running' },
  ]);
});

test('Executor records target import tool cost metadata without changing tool output', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          projectProfile: { outline: '雾城档案员追查记忆篡改主线' },
          volumes: [{ volumeNo: 1, title: '雾城缺页', synopsis: '档案员追查记忆篡改。', objective: '锁定缺页来源', chapterCount: 1 }],
          chapters: [{ chapterNo: 1, volumeNo: 1, title: '失踪的页码', objective: '发现缺页', conflict: '馆方阻止', hook: '湿钥匙出现', outline: '夜查档案库并发现被篡改的索引。', expectedWordCount: 3200 }],
          risks: ['章节数量需复核'],
        },
        result: {
          model: 'mock-outline-model',
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          elapsedMs: 33,
          rawPayloadSummary: { id: 'llm-outline' },
        },
      };
    },
  };
  const tool = new GenerateImportOutlinePreviewTool(llm as never);
  const prisma = {
    agentRun: {
      async findUnique(args?: { select?: { status?: boolean } }) {
        return args?.select?.status ? { status: 'planning' } : { id: 'run1', projectId: 'p1', chapterId: null };
      },
    },
  };
  const tools = { get: (name: string) => name === tool.name ? tool : undefined };
  const policy = new AgentPolicyService(new RuleEngineService());
  const finished: Array<{ output: unknown; metadata: unknown; mode: string; planVersion: number }> = [];
  const trace = {
    startStep() {},
    updateStepPhase() {},
    heartbeatStep() {},
    finishStep(_agentRunId: string, _stepNo: number, output: unknown, mode: string, planVersion: number, metadata: unknown) {
      finished.push({ output, mode, planVersion, metadata });
    },
    failStep() { throw new Error('target import preview should not fail'); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy, trace as never);

  const outputs = await executor.execute(
    'run1',
    [{ stepNo: 1, name: '生成大纲预览', tool: 'generate_import_outline_preview', mode: 'act', requiresApproval: false, args: { analysis: { sourceText: '雾城档案员发现档案缺页。', length: 12, paragraphs: ['档案缺页'], keywords: ['雾城'] }, chapterCount: 1 } }],
    { mode: 'plan', planVersion: 7, approved: false },
  );

  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].mode, 'plan');
  assert.equal(finished[0].planVersion, 7);
  assert.deepEqual(finished[0].output, outputs[1]);
  assert.equal(Object.prototype.hasOwnProperty.call(outputs[1] as Record<string, unknown>, 'executionCost'), false);
  const metadata = finished[0].metadata as { executionCost: Record<string, unknown> };
  assert.equal(metadata.executionCost.toolName, 'generate_import_outline_preview');
  assert.equal(metadata.executionCost.stepNo, 1);
  assert.equal(metadata.executionCost.planVersion, 7);
  assert.equal(metadata.executionCost.model, 'mock-outline-model');
  assert.deepEqual(metadata.executionCost.tokenUsage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(metadata.executionCost.llmCallCount, 1);
  assert.ok(typeof metadata.executionCost.elapsedMs === 'number');
});

test('Executor records distinguishable costs for every full import target tool', async () => {
  const prisma = {
    agentRun: {
      async findUnique(args?: { select?: { status?: boolean } }) {
        return args?.select?.status ? { status: 'planning' } : { id: 'run1', projectId: 'p1', chapterId: null };
      },
    },
  };
  const tools = {
    get(name: string) {
      if (!TARGETED_IMPORT_PREVIEW_TOOL_NAMES.includes(name)) return undefined;
      const targetIndex = TARGETED_IMPORT_PREVIEW_TOOL_NAMES.indexOf(name) + 1;
      return createTool({
        name,
        allowedModes: ['plan', 'act'],
        riskLevel: 'low',
        requiresApproval: false,
        sideEffects: [],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        async run(_args, context) {
          await new Promise((resolve) => setTimeout(resolve, targetIndex));
          context.recordLlmUsage?.({
            appStep: `test_${name}`,
            model: `mock-${name}`,
            usage: { total_tokens: targetIndex * 100 },
            elapsedMs: targetIndex,
          });
          return { target: name };
        },
      });
    },
  };
  const policy = new AgentPolicyService(new RuleEngineService());
  const costs: Array<Record<string, unknown>> = [];
  const trace = {
    startStep() {},
    finishStep(_agentRunId: string, _stepNo: number, _output: unknown, _mode: string, _planVersion: number, metadata: { executionCost: Record<string, unknown> }) {
      costs.push(metadata.executionCost);
    },
    failStep() { throw new Error('full import target tools should not fail'); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy, trace as never);

  await executor.execute(
    'run1',
    TARGETED_IMPORT_PREVIEW_TOOL_NAMES.map((toolName, index) => ({ stepNo: index + 1, name: toolName, tool: toolName, mode: 'act' as const, requiresApproval: false, args: {} })),
    { mode: 'plan', planVersion: 3, approved: false },
  );

  assert.deepEqual(costs.map((cost) => cost.toolName), TARGETED_IMPORT_PREVIEW_TOOL_NAMES);
  assert.deepEqual(costs.map((cost) => cost.stepNo), [1, 2, 3, 4, 5]);
  assert.equal(new Set(costs.map((cost) => cost.model)).size, TARGETED_IMPORT_PREVIEW_TOOL_NAMES.length);
  assert.deepEqual(costs.map((cost) => (cost.tokenUsage as Record<string, number>).total_tokens), [100, 200, 300, 400, 500]);
  assert.ok(costs.every((cost) => typeof cost.elapsedMs === 'number'));
});

test('Executor records fallback build_import_preview cost metadata', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          requestedAssetTypes: ['outline'],
          projectProfile: { outline: '桥城主线' },
          characters: [],
          lorebookEntries: [],
          writingRules: [],
          volumes: [{ volumeNo: 1, title: '第一卷' }],
          chapters: [{ chapterNo: 1, title: '逃离', outline: '修桥' }],
          risks: [],
        },
        result: {
          model: 'mock-fallback-model',
          usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
          elapsedMs: 44,
          rawPayloadSummary: { id: 'llm-fallback' },
        },
      };
    },
  };
  const tool = new BuildImportPreviewTool(llm as never);
  const prisma = {
    agentRun: {
      async findUnique(args?: { select?: { status?: boolean } }) {
        return args?.select?.status ? { status: 'planning' } : { id: 'run1', projectId: 'p1', chapterId: null };
      },
    },
  };
  const tools = { get: (name: string) => name === 'build_import_preview' ? tool : undefined };
  const policy = new AgentPolicyService(new RuleEngineService());
  let metadata: { executionCost: Record<string, unknown> } | undefined;
  const trace = {
    startStep() {},
    updateStepPhase() {},
    heartbeatStep() {},
    finishStep(_agentRunId: string, _stepNo: number, _output: unknown, _mode: string, _planVersion: number, value: { executionCost: Record<string, unknown> }) {
      metadata = value;
    },
    failStep() { throw new Error('fallback import preview should not fail'); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy, trace as never);

  const outputs = await executor.execute(
    'run1',
    [{ stepNo: 1, name: '兼容导入预览', tool: 'build_import_preview', mode: 'act', requiresApproval: false, args: { analysis: { sourceText: 'source', length: 6, paragraphs: ['source'], keywords: [] }, requestedAssetTypes: ['outline'] } }],
    { mode: 'plan', planVersion: 4, approved: false },
  );

  assert.deepEqual((outputs[1] as Record<string, unknown>).requestedAssetTypes, ['outline']);
  assert.equal(((outputs[1] as Record<string, unknown>).characters as unknown[]).length, 0);
  assert.equal(metadata?.executionCost.toolName, 'build_import_preview');
  assert.equal(metadata?.executionCost.model, 'mock-fallback-model');
  assert.deepEqual(metadata?.executionCost.tokenUsage, { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 });
});

test('AgentExecutorService records structured output repair diagnostics in step metadata', async () => {
  let metadata: { repairDiagnostics?: Array<Record<string, unknown>>; executionCost?: Record<string, unknown> } | undefined;
  const tool = createTool({
    name: 'mock_repair_diagnostic_tool',
    allowedModes: ['plan'],
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: [],
    async run(_args, context) {
      context.recordRepairDiagnostic?.({
        toolName: 'mock_repair_diagnostic_tool',
        attempted: true,
        attempts: 1,
        repairedFromErrors: ['missing wrapper'],
        model: 'mock-repair-model',
      });
      return { ok: true };
    },
  });
  const prisma = {
    agentRun: {
      async findUnique(args?: { select?: { status?: boolean } }) {
        return args?.select?.status ? { status: 'planning' } : { id: 'run-repair-metadata', projectId: 'p1', chapterId: null };
      },
    },
  };
  const tools = { get: (name: string) => name === 'mock_repair_diagnostic_tool' ? tool : undefined };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = {
    startStep() {},
    updateStepPhase() {},
    heartbeatStep() {},
    finishStep(_agentRunId: string, _stepNo: number, _output: unknown, _mode: string, _planVersion: number, value: typeof metadata) {
      metadata = value;
    },
    failStep() { throw new Error('repair diagnostic tool should not fail'); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  await executor.execute(
    'run-repair-metadata',
    [{ stepNo: 1, name: 'Mock repair metadata', tool: 'mock_repair_diagnostic_tool', mode: 'act', requiresApproval: false, args: {} }],
    { mode: 'plan', planVersion: 1, approved: false },
  );

  assert.equal(metadata?.repairDiagnostics?.[0]?.toolName, 'mock_repair_diagnostic_tool');
  assert.equal(metadata?.repairDiagnostics?.[0]?.model, 'mock-repair-model');
  assert.deepEqual(metadata?.repairDiagnostics?.[0]?.repairedFromErrors, ['missing wrapper']);
  assert.equal(metadata?.executionCost?.toolName, 'mock_repair_diagnostic_tool');
});

test('persist_project_assets remains approval gated with cost instrumentation present', () => {
  const tool = new PersistProjectAssetsTool({} as never, {} as never);
  const policy = new AgentPolicyService(new RuleEngineService());

  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.riskLevel, 'high');
  assert.ok(tool.sideEffects.includes('update_project_profile'));
  assert.throws(
    () => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} }, ['persist_project_assets']),
    /需要用户审批/,
  );
});

test('AgentRunsService 审计轨迹按时间聚合 Run/Plan/Approval/Step/Artifact', async () => {
  const base = new Date('2026-04-27T00:00:00.000Z');
  const prisma = {
    agentRun: {
      async findUnique() {
        return {
          id: 'run1',
          goal: '帮我写第 1 章',
          taskType: 'chapter_write',
          status: 'failed',
          input: {},
          output: null,
          error: '写入失败',
          createdAt: base,
          updatedAt: new Date(base.getTime() + 5000),
          plans: [{ id: 'plan1', version: 1, status: 'waiting_approval', taskType: 'chapter_write', summary: '章节写作计划', risks: ['写入草稿'], requiredApprovals: [], createdAt: new Date(base.getTime() + 1000) }],
          approvals: [{ id: 'approval1', approvalType: 'plan', status: 'approved', target: {}, comment: 'ok', createdAt: new Date(base.getTime() + 2000), approvedAt: new Date(base.getTime() + 2000) }],
          steps: [{ id: 'step1', stepNo: 3, planVersion: 1, mode: 'act', name: '写入草稿', toolName: 'write_chapter', status: 'failed', input: {}, output: null, error: 'boom', createdAt: new Date(base.getTime() + 3000), startedAt: new Date(base.getTime() + 3000), finishedAt: new Date(base.getTime() + 4000) }],
          artifacts: [{ id: 'artifact1', title: '诊断', artifactType: 'planner_diagnostics', status: 'final', sourceStepNo: null, createdAt: new Date(base.getTime() + 4500) }],
        };
      },
    },
  };
  const service = new AgentRunsService(prisma as never, {} as never, {} as never);
  const events = await service.auditTrail('run1');
  assert.deepEqual(events.map((event) => event.eventType), ['run_created', 'plan_created', 'approval_recorded', 'step_failed', 'artifact_created', 'current_status']);
  assert.equal(events.find((event) => event.eventType === 'step_failed')?.severity, 'danger');
});

test('AgentRunsService 接收结构化 requestedAssetTypes 并写入 Run context', async () => {
  let createdInput: Record<string, unknown> | undefined;
  const prisma = {
    agentRun: {
      async findFirst() { return null; },
      async create(args: { data: { input: Record<string, unknown> } }) {
        createdInput = args.data.input;
        return { id: 'run-targets' };
      },
    },
  };
  const runtime = { async plan() { return { plan: null, artifacts: [] }; } };
  const service = new AgentRunsService(prisma as never, runtime as never, {} as never);

  await service.createPlan({
    projectId: '11111111-1111-4111-8111-111111111111',
    message: '只生成大纲和写作规则',
    context: { currentProjectId: '11111111-1111-4111-8111-111111111111', requestedAssetTypes: ['outline', 'writingRules', 'outline'], importPreviewMode: 'quick' },
  });

  assert.deepEqual((createdInput?.context as Record<string, unknown>).requestedAssetTypes, ['outline', 'writingRules']);
  assert.equal((createdInput?.context as Record<string, unknown>).importPreviewMode, 'quick');
});

test('AgentRunsService 拒绝非法 requestedAssetTypes', async () => {
  const service = new AgentRunsService({} as never, {} as never, {} as never);

  await assert.rejects(
    () => service.createPlan({
      projectId: '11111111-1111-4111-8111-111111111111',
      message: '导入文档',
      context: { requestedAssetTypes: ['outline', 'allAssets'] as never },
    }),
    /context\.requestedAssetTypes\[1\]/,
  );
});

test('AgentRunsService 拒绝非法 importPreviewMode', async () => {
  const service = new AgentRunsService({} as never, {} as never, {} as never);

  await assert.rejects(
    () => service.createPlan({
      projectId: '11111111-1111-4111-8111-111111111111',
      message: '导入文档',
      context: { requestedAssetTypes: ['outline'], importPreviewMode: 'turbo' as never },
    }),
    /context\.importPreviewMode/,
  );
});

test('ValidateOutlineTool 生成写入前 diff，区分创建、更新和跳过章节', async () => {
  const prisma = {
    volume: { async findUnique() { return { title: '旧第一卷' }; } },
    chapter: { async findMany() { return [{ chapterNo: 1, status: 'planned', title: '旧第 1 章' }, { chapterNo: 2, status: 'drafted', title: '旧第 2 章' }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    { preview: { volume: { volumeNo: 1, title: '新第一卷', synopsis: '卷简介', objective: '卷目标', chapterCount: 3 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }, { chapterNo: 2, title: '二', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }, { chapterNo: 3, title: '三', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  assert.deepEqual(result.writePreview?.summary, { createCount: 1, updateCount: 1, skipCount: 1 });
});

test('ValidateOutlineTool 容忍 LLM 返回非字符串章节梗概', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    {
      preview: {
        volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 1, narrativePlan: createVccNarrativePlanForChapterCount(1) },
        chapters: [{
          chapterNo: 1,
          title: '一',
          objective: '目标',
          conflict: '冲突',
          hook: '钩子',
          outline: {
            beats: [
              '林澈在旧档案室用油灯照到账册边缘的新墨痕，确认有人刚替换过账页。',
              '馆方掌柜锁住木门拦住他搜身，同伴把湿账纸压进工具箱夹层。',
              '巡检员在门外登记他的名字，林澈带着铜扣赶往即将关闭的东闸。',
            ],
          } as unknown as string,
          expectedWordCount: 2000,
          craftBrief: createOutlineCraftBrief(),
        }],
        risks: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, true);
  assert.equal(result.writePreview?.chapters[0].title, '一');
});

test('ValidateOutlineTool 拦截旧 outline_preview 缺 craftBrief', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    { preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 1 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.stats.craftBriefCount, 0);
  assert.equal(result.stats.craftBriefMissingCount, 1);
  assert.equal(result.issues.some((issue) => issue.severity === 'error' && /缺少 craftBrief/.test(issue.message)), true);
});

test('ValidateOutlineTool 校验 craftBrief 行动链、线索和不可逆后果质量', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    {
      preview: {
        volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 1 },
        chapters: [
          {
            chapterNo: 1,
            title: '一',
            objective: '目标',
            conflict: '冲突',
            hook: '钩子',
            outline: '梗概',
            expectedWordCount: 2000,
            craftBrief: { visibleGoal: '拿到钥匙', actionBeats: ['潜入档案室'], concreteClues: [], progressTypes: ['info'] },
          },
        ],
        risks: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.stats.craftBriefCount, 1);
  assert.equal(result.stats.craftBriefMissingCount, 0);
  assert.equal(result.issues.some((issue) => /coreConflict/.test(issue.message)), true);
  assert.equal(result.issues.some((issue) => /actionBeats/.test(issue.message)), true);
  assert.equal(result.issues.some((issue) => /concreteClues/.test(issue.message)), true);
  assert.equal(result.issues.some((issue) => /irreversibleConsequence/.test(issue.message)), true);
});

test('ValidateOutlineTool 对重复章节标题给出 warning', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    {
      preview: {
        volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 2, narrativePlan: createVccNarrativePlanForChapterCount(2) },
        chapters: [
          createOutlineChapter(1, 1, {
            title: '第 1 章：压力入场',
            objective: '在旧闸棚核对被换过的船籍账页',
            conflict: '巡检员扣住账册并把主角姓名写入临检记录',
            hook: '东闸只剩一刻钟开放，主角无法回头取证',
            outline: '林澈在旧闸棚账房用油灯照出账页边缘的新墨痕，巡检员夺走账册并锁门搜身；同伴假装摔倒，把半页账纸压进工具箱夹层；门外雨廊里，林澈把盐霜铜扣藏进靴筒，听见东闸即将关闭，只能带着残缺证据离开。',
          }),
          createOutlineChapter(2, 1, {
            title: '第 2 章：压力入场',
            objective: '穿过东闸前确认铜扣来自哪艘船',
            conflict: '闸口守卫按临检记录盘查主角并拖延放行',
            hook: '铜扣上的船号指向已经沉没的白灯号',
            outline: '林澈赶到东闸闸口，把盐霜铜扣递给守闸老人辨认，守卫按临检记录拦住他反复盘问；同伴在货车阴影里打开工具箱，发现湿账纸背面残留白灯号船印；闸门绞链开始下落，林澈必须在暴露铜扣来源和错过闸门之间立刻取舍。',
          }),
        ],
        risks: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, true);
  assert.equal(result.issues.some((issue) => /重复章节标题/.test(issue.message) && /压力入场/.test(issue.message)), true);
});

test('VCC validate_outline rejects missing characterExecution', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const craftBrief = { ...createOutlineCraftBrief(), characterExecution: undefined };
  const preview = createVccOutlinePreview(1, { chapters: [createOutlineChapter(1, 1, { craftBrief })] });
  const tool = new ValidateOutlineTool(prisma as never);

  const result = await tool.run(
    { preview },
    { agentRunId: 'run-vcc-validate-missing-execution', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.stats.characterExecutionMissingCount, 1);
  assert.equal(result.issues.some((issue) => /craftBrief\.characterExecution/.test(issue.message)), true);
});

test('VCC validate_outline rejects self-declared existing characters without catalog', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);

  const result = await tool.run(
    { preview: createVccOutlinePreview(1) },
    { agentRunId: 'run-vcc-validate-self-existing', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.stats.characterRiskCount > 0, true);
  assert.equal(result.issues.some((issue) => /existingCharacterArcs|未知既有角色/.test(issue.message)), true);
});

test('VCC validate_outline reports character planning stats', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const tool = new ValidateOutlineTool(prisma as never);

  const result = await tool.run(
    { preview: createVccOutlinePreview(1) },
    { agentRunId: 'run-vcc-validate-stats', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, true);
  assert.equal(result.stats.volumeCharacterCandidateCount, 1);
  assert.equal(result.stats.chapterCharacterExecutionCount, 1);
  assert.equal(result.stats.characterExecutionMissingCount, 0);
  assert.equal(result.stats.temporaryCharacterCount, 2);
  assert.equal(result.stats.characterRiskCount, 0);
});

test('VCC validate_outline rejects scene participants outside cast', async () => {
  const prisma = {
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const baseCraftBrief = createOutlineCraftBrief();
  const craftBrief = {
    ...baseCraftBrief,
    sceneBeats: [
      { ...(baseCraftBrief.sceneBeats as Array<Record<string, unknown>>)[0], participants: ['未知访客'] },
      ...(baseCraftBrief.sceneBeats as Array<Record<string, unknown>>).slice(1),
    ],
  };
  const tool = new ValidateOutlineTool(prisma as never);

  const result = await tool.run(
    { preview: createVccOutlinePreview(1, { chapters: [createOutlineChapter(1, 1, { craftBrief })] }) },
    { agentRunId: 'run-vcc-validate-scene-cast', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.stats.unknownCharacterReferenceCount, 1);
  assert.equal(result.issues.some((issue) => /characterExecution/.test(issue.message)), true);
});

test('ValidateImportedAssetsTool 生成导入写入前 diff，并标记重复/已存在资产', async () => {
  const prisma = {
    character: { async findMany() { return [{ name: '林岚' }]; } },
    lorebookEntry: { async findMany() { return [{ title: '雾城' }]; } },
    writingRule: { async findMany() { return [{ title: '禁用现代词' }]; } },
    volume: { async findMany() { return [{ volumeNo: 1 }]; } },
    chapter: { async findMany() { return [{ chapterNo: 1, status: 'drafted', title: '旧章' }]; } },
  };
  const tool = new ValidateImportedAssetsTool(prisma as never);
  const result = await tool.run(
    { preview: { projectProfile: { title: '项目' }, characters: [{ name: '林岚' }, { name: '林岚' }, { name: '沈砚' }], lorebookEntries: [{ title: '雾城', entryType: 'location', content: '旧城' }, { title: '灯塔', entryType: 'place', content: '信号' }], writingRules: [{ title: '禁用现代词', ruleType: 'style', content: '避免现代网络词' }, { title: '保持第三人称', ruleType: 'pov', content: '不得切换视角' }], volumes: [{ volumeNo: 1, title: '卷一' }], chapters: [{ chapterNo: 1, title: '一' }, { chapterNo: 2, title: '二' }], risks: [] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  assert.equal(result.writePreview?.summary.characterCreateCount, 1);
  assert.equal(result.writePreview?.summary.characterSkipCount, 2);
  assert.equal(result.writePreview?.summary.writingRuleCreateCount, 1);
  assert.equal(result.writePreview?.summary.writingRuleSkipCount, 1);
  assert.equal(result.writePreview?.summary.chapterCreateCount, 1);
  assert.equal(result.writePreview?.summary.chapterSkipCount, 1);
});

test('CollectChapterContextTool 生成章节草稿、事实和记忆写入前预览', async () => {
  const prisma = {
    chapter: {
      async findFirst() { return { id: 'c1', projectId: 'p1', chapterNo: 3, title: '第三章', objective: '目标', conflict: '冲突', outline: '梗概', expectedWordCount: 3000, project: { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null } }; },
      async findMany() { return []; },
    },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async findMany() { return []; }, async count() { return 2; } },
    chapterDraft: { async findFirst() { return { id: 'd1', versionNo: 4, content: '旧草稿内容'.repeat(120) }; } },
    storyEvent: { async count() { return 3; } },
    characterStateSnapshot: { async count() { return 1; } },
    foreshadowTrack: { async count() { return 1; } },
    validationIssue: { async findMany() { return [{ severity: 'error' }, { severity: 'warning' }]; } },
  };
  const tool = new CollectChapterContextTool(prisma as never);
  const result = await tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });
  assert.equal(result.writePreview.draft.action, 'create_new_version');
  assert.equal(result.writePreview.draft.currentVersionNo, 4);
  assert.equal(result.writePreview.facts.existingAutoEventCount, 3);
  assert.equal(result.writePreview.memory.existingAutoMemoryCount, 2);
  assert.equal(result.writePreview.validation.openErrorCount, 1);
  assert.ok(result.writePreview.approvalRiskHints.some((item) => item.includes('切换为当前版本')));
});

test('CollectChapterContextTool excludes current chapter MemoryChunk rows from write context preview', async () => {
  const prisma = {
    chapter: {
      async findFirst() { return { id: 'c1', projectId: 'p1', chapterNo: 1, title: 'Chapter 1', objective: null, conflict: null, outline: null, expectedWordCount: 3000, project: { id: 'p1', title: 'Project', genre: null, theme: null, tone: null, synopsis: null, outline: null } }; },
      async findMany() { return []; },
    },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: {
      async findMany() {
        return [
          { id: 'm-current', sourceType: 'chapter', sourceId: 'c1', memoryType: 'summary', summary: 'old chapter one', content: 'old chapter one content', importanceScore: 100, recencyScore: 100, sourceTrace: { chapterId: 'c1', chapterNo: 1 } },
          { id: 'm-future', sourceType: 'chapter', sourceId: 'c2', memoryType: 'summary', summary: 'future chapter', content: 'future chapter content', importanceScore: 90, recencyScore: 90, sourceTrace: { chapterId: 'c2', chapterNo: 2 } },
          { id: 'm-global', sourceType: 'manual', sourceId: '00000000-0000-0000-0000-000000000000', memoryType: 'setting', summary: 'global setting', content: 'global setting content', importanceScore: 80, recencyScore: 80, sourceTrace: {} },
        ];
      },
      async count() { return 1; },
    },
    chapterDraft: { async findFirst() { return null; } },
    storyEvent: { async count() { return 0; } },
    characterStateSnapshot: { async count() { return 0; } },
    foreshadowTrack: { async count() { return 0; } },
    validationIssue: { async findMany() { return []; } },
  };
  const tool = new CollectChapterContextTool(prisma as never);
  const result = await tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.deepEqual(result.memoryChunks.map((chunk) => chunk.summary), ['global setting']);
});

test('CollectTaskContextTool 为角色一致性检查收集角色、章节和约束', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: '玄幻', theme: null, tone: '压迫感', synopsis: '简介', outline: '大纲', targetWordCount: 3000, status: 'active' }; } },
    chapter: { async findMany() { return [{ id: 'c1', chapterNo: 3, title: '第三章', status: 'drafted', objective: '目标', conflict: '冲突', outline: '梗概', drafts: [{ content: '当前草稿内容'.repeat(80) }] }]; } },
    character: { async findMany() { return [{ id: 'char1', name: '林烬', alias: ['男主'], roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }]; } },
    lorebookEntry: { async findMany() { return [{ id: 'l1', title: '禁忌', entryType: 'rule', summary: '不能破坏', content: '锁定事实', status: 'locked' }]; } },
    memoryChunk: { async findMany() { return [{ id: 'm1', sourceType: 'chapter', sourceId: 'c1', memoryType: 'character_arc', summary: '他保持克制', content: '记忆内容', importanceScore: 80, recencyScore: 70 }] } },
    validationIssue: { async findMany() { return [{ severity: 'warning', issueType: 'character', message: '语气略偏' }]; } },
    characterStateSnapshot: { async findMany() { return [{ characterId: 'char1', characterName: '林烬', chapterNo: 3, stateType: 'emotion', stateValue: '压抑', summary: '情绪压抑' }]; } },
    storyEvent: { async findMany() { return [{ id: 'e1', chapterNo: 3, title: '雨夜对峙', eventType: 'conflict', description: '林烬与沈砚在雨夜对峙', participants: ['林烬', '沈砚'], status: 'detected' }]; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);
  const result = await tool.run(
    { taskType: 'character_consistency_check', chapterId: 'c1', characterId: 'char1', focus: ['character_arc'] },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.projectDigest.title, '项目');
  assert.equal(result.chapters[0].id, 'c1');
  assert.equal(result.characters[0].id, 'char1');
  assert.deepEqual(result.diagnostics.missingContext, []);
  assert.equal(result.plotEvents[0].title, '雨夜对峙');
  assert.ok(result.relationshipGraph.some((item) => item.source === '林烬'));
  assert.ok(result.constraints.some((item) => item.includes('角色一致性检查')));
  assert.ok(result.constraints.some((item) => item.includes('未关闭校验问题')));
});

test('CollectTaskContextTool 拒绝跨项目 projectId 并标记世界观 locked facts 约束', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return [{ id: 'l1', title: '锁定法则', entryType: 'rule', summary: null, content: '不可覆盖', status: 'locked' }]; } },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    storyEvent: { async findMany() { return []; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  await assert.rejects(
    () => tool.run({ projectId: 'other', taskType: 'worldbuilding_expand' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }),
    /只能读取当前 AgentRun 所属项目/,
  );

  const result = await tool.run({ taskType: 'worldbuilding_expand', focus: ['locked_world_facts'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });
  assert.ok(result.constraints.some((item) => item.includes('不得覆盖 1 条 locked facts')));
});

test('CollectTaskContextTool 支持前三章范围召回并记录诊断', async () => {
  const chapterQueries: Array<Record<string, unknown>> = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: {
      async findMany(args: Record<string, unknown>) {
        chapterQueries.push(args);
        return [1, 2, 3].map((chapterNo) => ({ id: `c${chapterNo}`, chapterNo, title: `第${chapterNo}章`, status: 'drafted', objective: '目标', conflict: '冲突', outline: '梗概', drafts: [{ content: `第${chapterNo}章草稿` }] }));
      },
    },
    character: { async findMany() { return [{ id: 'char1', name: '林烬', alias: [], roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }]; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    storyEvent: { async findMany() { return []; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  const result = await tool.run({ taskType: 'plot_consistency_check', entityRefs: { chapterRange: '前三章' }, focus: ['plot_facts'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.equal(result.chapters.length, 3);
  assert.equal(result.diagnostics.chapterRange, '前三章');
  assert.deepEqual((chapterQueries[0].where as Record<string, unknown>).chapterNo, { lte: 3 });
});

test('CollectTaskContextTool 根据世界观引用优先召回相关设定', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
    lorebookEntry: {
      async findMany() {
        return [
          { id: 'l1', title: '普通城市', entryType: 'location', summary: '市井', content: '普通居民生活', status: 'active' },
          { id: 'l2', title: '青云宗', entryType: 'faction', summary: '宗门体系核心', content: '宗门戒律与长老会', status: 'active' },
          { id: 'l3', title: '锁定法则', entryType: 'rule', summary: '不可覆盖', content: 'locked fact', status: 'locked' },
        ];
      },
    },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    storyEvent: { async findMany() { return []; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  const result = await tool.run({ taskType: 'worldbuilding_expand', entityRefs: { worldSettingRef: '宗门体系' }, focus: ['locked_world_facts'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.ok(result.worldFacts.slice(0, 2).some((fact) => fact.title === '青云宗'));
  assert.ok(result.diagnostics.worldFactKeywords?.includes('宗门体系'));
  assert.ok(result.constraints.some((item) => item.includes('不得覆盖 1 条 locked facts')));
});

test('CollectTaskContextTool 按需召回完整草稿并构建关系图维度', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: { async findMany() { return [{ id: 'c1', chapterNo: 7, title: '对峙', status: 'drafted', objective: '目标', conflict: '冲突', outline: '梗概', drafts: [{ content: '完整草稿内容'.repeat(200) }] }]; } },
    character: { async findMany() { return [{ id: 'char1', name: '林烬', alias: ['男主'], roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }, { id: 'char2', name: '沈砚', alias: ['师姐'], roleType: 'mentor', personalityCore: '谨慎', motivation: '守护', speechStyle: '冷静' }]; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return [{ characterId: 'char1', characterName: '林烬', chapterNo: 7, stateType: 'emotion', stateValue: '愤怒', summary: '强压怒意' }] } },
    storyEvent: { async findMany() { return [{ id: 'e1', chapterNo: 7, title: '师姐对峙', eventType: 'conflict', description: '林烬和沈砚在祠堂对峙', participants: [{ name: '林烬' }, { name: '沈砚' }], status: 'detected' }] } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  const result = await tool.run(
    { taskType: 'plot_consistency_check', chapterId: 'c1', focus: ['full_draft', 'relationship_graph', 'plot_facts'] },
    { agentRunId: 'run1', projectId: 'p1', chapterId: 'c1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.ok(typeof result.chapters[0].latestDraftContent === 'string');
  assert.ok(result.relationshipGraph.some((edge) => edge.source === '林烬' && edge.target === '沈砚'));
  assert.deepEqual(result.plotEvents.map((event) => event.title), ['师姐对峙']);
  assert.equal(result.diagnostics.fullDraftIncluded, true);
  assert.ok(result.diagnostics.retrievalDimensions.includes('full_current_draft'));
  assert.ok(result.diagnostics.retrievalDimensions.includes('relationship_graph'));
});

test('CollectTaskContextTool 对完整草稿召回执行任务白名单和长度裁剪', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: { async findMany() { return [{ id: 'c1', chapterNo: 1, title: '正文', status: 'drafted', objective: '目标', conflict: '冲突', outline: '梗概', drafts: [{ content: '长草稿'.repeat(5000) }] }]; } },
    character: { async findMany() { return [{ id: 'char1', name: '林烬', alias: [], roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }]; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    storyEvent: { async findMany() { return []; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  const allowed = await tool.run(
    { taskType: 'plot_consistency_check', chapterId: 'c1', focus: ['full_draft'], entityRefs: { maxFullDraftChars: 2400 } },
    { agentRunId: 'run1', projectId: 'p1', chapterId: 'c1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const blocked = await tool.run(
    { taskType: 'worldbuilding_expand', chapterId: 'c1', focus: ['full_draft'], entityRefs: { includeFullDrafts: true } },
    { agentRunId: 'run1', projectId: 'p1', chapterId: 'c1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(allowed.diagnostics.fullDraftIncluded, true);
  assert.equal(allowed.diagnostics.fullDraftMaxChars, 2400);
  assert.ok(String(allowed.chapters[0].latestDraftContent).length <= 2401);
  assert.equal(blocked.diagnostics.fullDraftIncluded, false);
  assert.ok(!('latestDraftContent' in blocked.chapters[0]));
  assert.ok(blocked.diagnostics.missingContext.includes('full_draft_blocked_by_task_type'));
});

test('CollectTaskContextTool 输出世界观实体类型和权重化关系边', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '项目', genre: null, theme: null, tone: null, synopsis: null, outline: null, targetWordCount: null, status: 'active' }; } },
    chapter: { async findMany() { return [{ id: 'c1', chapterNo: 1, title: '对峙', status: 'drafted', objective: '目标', conflict: '冲突', outline: '梗概', drafts: [] }]; } },
    character: { async findMany() { return [{ id: 'char1', name: '林烬', alias: [], roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }, { id: 'char2', name: '沈怀舟', alias: [], roleType: 'mentor', personalityCore: '谨慎', motivation: '守护', speechStyle: '冷静' }]; } },
    lorebookEntry: {
      async findMany() {
        return [
          { id: 'l1', title: '青云宗', entryType: 'faction', summary: '宗门势力', content: '宗门与旧盟约相关', status: 'active', priority: 90 },
          { id: 'l2', title: '宗门戒律', entryType: 'rule', summary: '规则', content: '同门不得私斗', status: 'locked', priority: 80 },
          { id: 'l3', title: '旧盟玉佩', entryType: 'item', summary: '物品', content: '旧盟约信物', status: 'active', priority: 70 },
          { id: 'l4', title: '青云宗与玄夜盟关系', entryType: 'relationship', summary: '势力关系', content: '双方敌对', status: 'active', priority: 60 },
        ];
      },
    },
    memoryChunk: { async findMany() { return []; } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    storyEvent: { async findMany() { return [{ id: 'e1', chapterNo: 1, title: '祠堂对峙', eventType: 'conflict', description: '林烬和沈怀舟发生对峙并暴露敌对关系', participants: [{ name: '林烬' }, { name: '沈怀舟' }], status: 'detected' }]; } },
  };
  const tool = new CollectTaskContextTool(prisma as never);

  const result = await tool.run(
    { taskType: 'worldbuilding_expand', focus: ['宗门体系', 'relationship_graph'], entityRefs: { worldSettingRef: '宗门' } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.ok(result.worldFacts.some((fact) => fact.entityType === 'faction'));
  assert.ok(result.worldFacts.some((fact) => fact.entityType === 'rule'));
  assert.ok(result.worldFacts.some((fact) => fact.entityType === 'item'));
  assert.ok(result.worldFacts.some((fact) => fact.entityType === 'relationship'));
  const edge = result.relationshipGraph.find((item) => item.source === '林烬' && item.target === '沈怀舟');
  assert.equal(edge?.relationType, 'conflict');
  assert.equal(edge?.conflict, true);
  assert.ok(Number(edge?.weight) >= 0.75);
  assert.ok(Array.isArray(edge?.evidenceSources));
});

test('RelationshipGraphService 独立构建带证据和时间范围的只读关系边', () => {
  const service = new RelationshipGraphService();

  const graph = service.buildGraph(
    [{ name: '林烬' }, { name: '沈怀舟' }],
    [{ chapterNo: 3, title: '雨夜对峙', description: '林烬和沈怀舟发生对峙并敌对', participants: [{ name: '林烬' }, { name: '沈怀舟' }] }],
    [{ characterName: '林烬', chapterNo: 4, summary: '林烬强压怒意' }],
  );

  const edge = graph.find((item) => item.source === '林烬' && item.target === '沈怀舟');
  assert.equal(edge?.relationType, 'conflict');
  assert.equal(edge?.conflict, true);
  assert.deepEqual(edge?.timeRange, { fromChapterNo: 3, toChapterNo: 3 });
  assert.equal(edge?.evidenceSources[0].sourceType, 'story_event');
  assert.ok(graph.some((item) => item.relationType === 'state_evidence' && item.source === '林烬'));
});

test('CharacterConsistencyCheckTool 基于上下文输出人设偏差诊断', async () => {
  const tool = new CharacterConsistencyCheckTool();
  const result = await tool.run(
    {
      characterId: 'char1',
      instruction: '男主这里是不是太冲动，人设崩了？',
      taskContext: {
        characters: [{ id: 'char1', name: '林烬', roleType: 'protagonist', personalityCore: '克制隐忍', motivation: '复仇但不牵连无辜', speechStyle: '短句', recentStates: [{ chapterNo: 3, stateType: 'emotion', stateValue: '压抑', summary: '强忍怒意' }] }],
        chapters: [{ chapterNo: 4, title: '雨夜', latestDraftExcerpt: '林烬怒吼着冲上去，不顾所有人的阻拦。' }],
        constraints: ['未关闭校验问题(warning/character)：语气略偏'],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.character.name, '林烬');
  assert.equal(result.verdict.status, 'minor_drift');
  assert.equal('llmEvidenceSummary' in result, false);
  assert.ok(result.deviations.some((item) => item.dimension === 'behavior'));
  assert.ok(result.suggestions.some((item) => item.includes('过渡')));
});

test('CharacterConsistencyCheckTool LLM 证据归纳实验开启时只读追加摘要', async () => {
  const llm = {
    async chatJson() {
      return { data: { summary: '林烬的强烈行为已有压抑状态和冲突事件支撑。', keyFindings: ['近期状态：压抑愤怒', '关系证据：冲突升级'] }, result: { model: 'mock-evidence-model' } };
    },
  };
  const tool = new CharacterConsistencyCheckTool(llm as never);
  const result = await tool.run(
    {
      characterId: 'char1',
      instruction: '男主突然怒吼是否突兀？',
      experimentalLlmEvidenceSummary: true,
      taskContext: {
        characters: [{ id: 'char1', name: '林烬', personalityCore: '克制', motivation: '查明真相', recentStates: [{ chapterNo: 6, stateValue: '压抑愤怒', summary: '接近爆发' }] }],
        chapters: [{ chapterNo: 7, latestDraftExcerpt: '林烬怒吼着冲上前。' }],
        plotEvents: [{ chapterNo: 7, title: '祠堂对峙', eventType: 'conflict', description: '林烬和沈砚发生对峙', participants: ['林烬', '沈砚'] }],
        relationshipGraph: [{ source: '林烬', target: '沈砚', relationType: 'conflict', conflict: true, evidence: '二人冲突升级' }],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.llmEvidenceSummary?.status, 'succeeded');
  assert.equal(result.llmEvidenceSummary?.fallbackUsed, false);
  assert.equal(result.llmEvidenceSummary?.model, 'mock-evidence-model');
  assert.equal(result.verdict.status, 'minor_drift');
});

test('CharacterConsistencyCheckTool 可通过环境变量开启 LLM 证据归纳实验', async () => {
  const previous = process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY;
  process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY = 'true';
  const llm = { async chatJson() { return { data: { summary: '环境变量开启的只读摘要。', keyFindings: ['只读'] }, result: { model: 'mock-env-evidence-model' } }; } };
  const tool = new CharacterConsistencyCheckTool(llm as never);
  try {
    const result = await tool.run(
      { characterId: 'char1', taskContext: { characters: [{ id: 'char1', name: '林烬', roleType: 'protagonist', personalityCore: '克制', motivation: '复仇', speechStyle: '短句' }], chapters: [{ title: '雨夜', latestDraftExcerpt: '林烬沉默片刻。' }] } },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    );
    assert.equal(result.llmEvidenceSummary?.status, 'succeeded');
    assert.equal(result.llmEvidenceSummary?.model, 'mock-env-evidence-model');
  } finally {
    if (previous === undefined) delete process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY;
    else process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY = previous;
  }
});

test('CharacterConsistencyCheckTool 复用关系边和近期状态支撑角色转折', async () => {
  const tool = new CharacterConsistencyCheckTool();
  const result = await tool.run(
    {
      characterId: 'char1',
      instruction: '男主这里突然怒吼冲上去，会不会太冲动、转折突兀？',
      taskContext: {
        characters: [{ id: 'char1', name: '林烬', roleType: 'protagonist', personalityCore: '克制隐忍', motivation: '查明真相', speechStyle: '短句', recentStates: [{ chapterNo: 6, stateType: 'emotion', stateValue: '压抑愤怒', summary: '被迫忍让后临近爆发' }] }],
        chapters: [{ chapterNo: 7, title: '祠堂', latestDraftExcerpt: '林烬怒吼着冲上前，第一次不顾沈砚的阻拦。' }],
        plotEvents: [{ chapterNo: 7, title: '祠堂对峙', eventType: 'conflict', description: '林烬和沈砚发生对峙', participants: ['林烬', '沈砚'] }],
        relationshipGraph: [{ source: '林烬', target: '沈砚', relationType: 'conflict', conflict: true, evidence: '祠堂对峙显示二人敌对升级' }],
        worldFacts: [{ title: '宗门戒律', summary: '同门不得私斗', locked: true }],
        constraints: ['世界观扩展只能增量补充，不得覆盖 1 条 locked facts 或已确认剧情事实。'],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.verdict.status, 'minor_drift');
  assert.ok(result.currentEvidence.some((item) => item.includes('关系证据') && item.includes('冲突')));
  assert.ok(result.currentEvidence.some((item) => item.includes('锁定事实边界')));
  assert.ok(result.deviations.some((item) => item.dimension === 'behavior' && item.message.includes('提供转折支撑')));
  assert.ok(result.deviations.some((item) => item.dimension === 'fact_boundary'));
});

test('CharacterConsistencyCheckTool 标记关系证据不足和动机基线缺失', async () => {
  const tool = new CharacterConsistencyCheckTool();
  const result = await tool.run(
    {
      characterId: 'char1',
      instruction: '检查这段对峙的动机和关系转折是否突兀。',
      taskContext: {
        characters: [{ id: 'char1', name: '林烬', roleType: 'protagonist', personalityCore: '克制', speechStyle: '短句' }],
        chapters: [{ chapterNo: 4, title: '断桥', outline: '林烬与沈砚突然决裂' }],
        plotEvents: [{ chapterNo: 4, title: '断桥决裂', eventType: 'conflict', description: '林烬和沈砚突然决裂', participants: ['林烬', '沈砚'] }],
        relationshipGraph: [],
        constraints: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.verdict.status, 'minor_drift');
  assert.ok(result.deviations.some((item) => item.dimension === 'motivation'));
  assert.ok(result.deviations.some((item) => item.dimension === 'relationship'));
  assert.ok(result.suggestions.some((item) => item.includes('relationship_graph')));
});

test('CharacterConsistencyCheckTool Manifest 声明 resolver 参数来源且只读免审批', () => {
  const tool = new CharacterConsistencyCheckTool();

  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.manifest.parameterHints?.characterId.resolverTool, 'resolve_character');
  assert.ok(tool.manifest.whenToUse.some((item) => item.includes('人设')));
});

test('PlotConsistencyCheckTool 基于上下文输出时间线和伏笔诊断', async () => {
  const tool = new PlotConsistencyCheckTool();
  const result = await tool.run(
    {
      instruction: '当前大纲有没有矛盾？顺便检查伏笔是否回收。',
      taskContext: {
        chapters: [
          { chapterNo: 1, title: '入山', objective: '进入宗门', conflict: '门规压力', outline: '埋下玉佩伏笔' },
          { chapterNo: 2, title: '对峙', objective: '揭示矛盾', conflict: '师姐阻拦', outline: '对峙升级' },
        ],
        plotEvents: [
          { chapterNo: 2, timelineSeq: 20, title: '师姐阻拦', description: '沈砚阻拦林烬' },
          { chapterNo: 1, timelineSeq: 10, title: '获得玉佩', description: '林烬先获得玉佩' },
        ],
        characters: [{ name: '林烬', motivation: '查明真相', personalityCore: '克制' }],
        relationshipGraph: [{ source: '林烬', target: '沈砚', evidence: '雨夜对峙' }],
        constraints: ['未关闭校验问题(warning/plot)：第二章时间线待复核'],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.scope.chapterCount, 2);
  assert.equal(result.verdict.status, 'likely_conflict');
  assert.ok(result.deviations.some((item) => item.dimension === 'event_order' && item.severity === 'error'));
  assert.ok(result.evidence.foreshadowEvidence.some((item) => item.includes('玉佩伏笔')));
});

test('PlotConsistencyCheckTool 区分伏笔未回收、动机证据不足和 locked facts 冲突', async () => {
  const tool = new PlotConsistencyCheckTool();
  const result = await tool.run(
    {
      instruction: '检查伏笔是否回收，角色转折是否突兀，并确认有没有事实冲突。',
      taskContext: {
        chapters: [
          { chapterNo: 1, title: '玉佩', objective: '取得信物', conflict: '宗门压力', outline: '埋下旧盟玉佩伏笔' },
          { chapterNo: 2, title: '废誓', objective: '推进反转', conflict: '林烬突然废除禁忌法则', outline: '林烬宣布禁忌法则不再成立' },
        ],
        plotEvents: [{ chapterNo: 2, timelineSeq: 20, title: '突然决裂', eventType: 'turning_point', description: '林烬突然决裂并改写禁忌法则' }],
        characters: [{ name: '林烬', motivation: '查明真相', personalityCore: '克制' }],
        relationshipGraph: [],
        worldFacts: [{ title: '禁忌法则', summary: '任何人不得废除宗门禁忌', content: '禁忌法则不可改写', locked: true }],
        constraints: ['世界观扩展只能增量补充，不得覆盖 1 条 locked facts 或已确认剧情事实。'],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.verdict.status, 'likely_conflict');
  assert.ok(result.deviations.some((item) => item.dimension === 'foreshadowing' && item.message.includes('缺少明确回收')));
  assert.ok(result.deviations.some((item) => item.dimension === 'motivation' && item.message.includes('缺少可支撑')));
  assert.ok(result.deviations.some((item) => item.dimension === 'fact_conflict' && item.severity === 'error'));
  assert.ok(result.evidence.lockedFactEvidence.some((item) => item.includes('禁忌法则')));
});

test('PlotConsistencyCheckTool 使用冲突关系边支撑角色转折动机', async () => {
  const tool = new PlotConsistencyCheckTool();
  const result = await tool.run(
    {
      instruction: '检查这段对峙的角色动机是否突兀。',
      taskContext: {
        chapters: [{ chapterNo: 3, title: '对峙', objective: '揭示师徒裂痕', conflict: '师姐阻拦', outline: '林烬与沈砚在祠堂对峙，关系进一步恶化' }],
        plotEvents: [{ chapterNo: 3, timelineSeq: 30, title: '祠堂对峙', eventType: 'conflict', description: '林烬和沈砚发生对峙' }],
        characters: [{ name: '林烬', motivation: '查明真相', personalityCore: '克制' }, { name: '沈砚', motivation: '守护宗门秘密', personalityCore: '谨慎' }],
        relationshipGraph: [{ source: '林烬', target: '沈砚', relationType: 'conflict', conflict: true, evidence: '祠堂对峙显示两人敌对升级' }],
        constraints: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.ok(result.evidence.motivationEvidence.some((item) => item.includes('冲突关系')));
  assert.ok(!result.deviations.some((item) => item.dimension === 'motivation'));
});

test('PlotConsistencyCheckTool LLM 证据归纳失败时降级 deterministic 结果', async () => {
  const llm = { async chatJson() { throw new Error('mock llm unavailable'); } };
  const tool = new PlotConsistencyCheckTool(llm as never);
  const result = await tool.run(
    {
      instruction: '检查伏笔是否回收',
      experimentalLlmEvidenceSummary: true,
      taskContext: {
        chapters: [{ chapterNo: 1, title: '玉佩', outline: '埋下旧盟玉佩伏笔' }],
        plotEvents: [{ chapterNo: 1, timelineSeq: 10, title: '获得玉佩', description: '林烬获得玉佩' }],
        characters: [{ name: '林烬', motivation: '查明真相' }],
        relationshipGraph: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.llmEvidenceSummary?.status, 'fallback');
  assert.equal(result.llmEvidenceSummary?.fallbackUsed, true);
  assert.match(result.llmEvidenceSummary?.error ?? '', /mock llm unavailable/);
  assert.ok(['needs_review', 'consistent'].includes(result.verdict.status));
  assert.ok(Array.isArray(result.suggestions));
});

test('PlotConsistencyCheckTool Manifest 声明 collect_task_context 来源且只读免审批', () => {
  const tool = new PlotConsistencyCheckTool();

  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.manifest.parameterHints?.taskContext.source, 'previous_step');
  assert.ok(tool.manifest.whenToUse.some((item) => item.includes('大纲')));
});

test('AgentRuntime 为剧情一致性检查提升上下文和报告 Artifact', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const artifacts = runtime.buildExecutionArtifacts(
    'plot_consistency_check',
    { 1: { diagnostics: { retrievalDimensions: ['plot_events'] } }, 2: { verdict: { status: 'consistent' } } },
    [{ stepNo: 1, tool: 'collect_task_context' }, { stepNo: 2, tool: 'plot_consistency_check' }],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['task_context_preview', 'plot_consistency_report']);
  assert.equal(artifacts[1].title, '剧情一致性检查报告');
});

test('AgentRuntime 为 AI 审稿提升 QualityReport Artifact', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const report = { reportId: 'report-1', verdict: 'warn', scores: { overall: 82 }, issues: [{ severity: 'warning', message: '节奏略急' }] };
  const artifacts = runtime.buildExecutionArtifacts(
    'ai_quality_review',
    { 1: { chapterId: 'c1' }, 2: report },
    [{ stepNo: 1, tool: 'resolve_chapter' }, { stepNo: 2, tool: 'ai_quality_review' }],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['ai_quality_report']);
  assert.equal(artifacts[0].title, 'AI 审稿质量报告');
  assert.deepEqual(artifacts[0].content, report);
});

test('AgentRuntime 为 Story Bible 扩展提升 preview/validation/persist Artifacts', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'sbc_1', title: '宗门戒律' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'sbc_1', title: '宗门戒律' }] };
  const persist = { createdCount: 1, updatedCount: 0 };
  const artifacts = runtime.buildExecutionArtifacts(
    'story_bible_expand',
    { 1: { diagnostics: {} }, 2: preview, 3: validation, 4: persist },
    [
      { stepNo: 1, tool: 'collect_task_context' },
      { stepNo: 2, tool: 'generate_story_bible_preview' },
      { stepNo: 3, tool: 'validate_story_bible' },
      { stepNo: 4, tool: 'persist_story_bible' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['story_bible_preview', 'story_bible_validation_report', 'story_bible_persist_result']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation, persist]);
});

test('AgentRuntime 为 Story Bible Plan 预览按 tool 名提升 Artifacts', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'sbc_1', title: '宗门戒律' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'sbc_1', title: '宗门戒律' }] };
  const artifacts = runtime.buildPreviewArtifacts(
    'story_bible_expand',
    { 2: { noise: true }, 4: preview, 5: validation },
    [
      { stepNo: 2, tool: 'collect_task_context' },
      { stepNo: 4, tool: 'generate_story_bible_preview' },
      { stepNo: 5, tool: 'validate_story_bible' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['story_bible_preview', 'story_bible_validation_report']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation]);
});

test('AgentRuntime 为文档导入按 tool 名提升预览和写入结果 Artifacts', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { projectProfile: { title: '导入项目' }, characters: [{ name: '林岚' }], lorebookEntries: [{ title: '雾城' }], writingRules: [{ title: '禁用现代词' }], volumes: [{ volumeNo: 1, title: '卷一' }], chapters: [{ chapterNo: 1, title: '一' }], risks: [] };
  const validation = { valid: true };
  const persist = { characterCreatedCount: 1, writingRuleCreatedCount: 1, chapterCreatedCount: 1 };
  const steps = [
    { stepNo: 1, tool: 'read_source_document' },
    { stepNo: 2, tool: 'analyze_source_text' },
    { stepNo: 3, tool: 'build_import_preview' },
    { stepNo: 4, tool: 'validate_imported_assets' },
    { stepNo: 5, tool: 'persist_project_assets' },
  ];

  const planArtifacts = runtime.buildPreviewArtifacts('project_import_preview', { 1: { sourceText: '正文' }, 2: { sourceText: '分析' }, 3: preview, 4: validation }, steps);
  const actArtifacts = runtime.buildExecutionArtifacts('project_import_preview', { 1: {}, 2: {}, 3: preview, 4: validation, 5: persist }, steps);

  assert.deepEqual(planArtifacts.map((item) => item.artifactType), ['project_profile_preview', 'characters_preview', 'lorebook_preview', 'writing_rules_preview', 'outline_preview', 'import_validation_report']);
  assert.equal(planArtifacts.find((item) => item.artifactType === 'writing_rules_preview')?.content, preview.writingRules);
  assert.deepEqual(actArtifacts.map((item) => item.artifactType).slice(-2), ['import_validation_report', 'import_persist_result']);
  assert.deepEqual(actArtifacts.at(-1)?.content, persist);
});

test('AgentRuntime 为文档导入按 requestedAssetTypes 只提升用户选择的目标产物', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = {
    requestedAssetTypes: ['outline'],
    projectProfile: { title: '不应展示', outline: '主线' },
    characters: [{ name: '不应展示' }],
    lorebookEntries: [{ title: '不应展示' }],
    writingRules: [{ title: '不应展示' }],
    volumes: [{ volumeNo: 1, title: '卷一' }],
    chapters: [{ chapterNo: 1, title: '一' }],
    risks: [],
  };
  const validation = { valid: true };
  const steps = [
    { stepNo: 1, tool: 'build_import_preview' },
    { stepNo: 2, tool: 'validate_imported_assets' },
  ];

  const artifacts = runtime.buildPreviewArtifacts('project_import_preview', { 1: preview, 2: validation }, steps);

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['outline_preview', 'import_validation_report']);
});

test('AgentRuntime 为文档导入提升 merge_import_previews 输出', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = {
    requestedAssetTypes: ['outline', 'writingRules'],
    projectProfile: { outline: '主线' },
    characters: [],
    lorebookEntries: [],
    writingRules: [{ title: '视角规则', ruleType: 'pov', content: '第三人称有限视角' }],
    volumes: [{ volumeNo: 1, title: '卷一' }],
    chapters: [{ chapterNo: 1, title: '一' }],
    risks: [],
  };
  const validation = { valid: true };
  const steps = [
    { stepNo: 1, tool: 'read_source_document' },
    { stepNo: 2, tool: 'analyze_source_text' },
    { stepNo: 3, tool: 'generate_import_outline_preview' },
    { stepNo: 4, tool: 'generate_import_writing_rules_preview' },
    { stepNo: 5, tool: 'merge_import_previews' },
    { stepNo: 6, tool: 'validate_imported_assets' },
  ];

  const artifacts = runtime.buildPreviewArtifacts('project_import_preview', { 5: preview, 6: validation }, steps);

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['writing_rules_preview', 'outline_preview', 'import_validation_report']);
  assert.equal(artifacts[0].content, preview.writingRules);
  assert.deepEqual(artifacts[1].content, { outline: '主线', volumes: preview.volumes, chapters: preview.chapters, risks: preview.risks });
});

test('AgentRuntime 为文档导入提升目标 Tool 输出', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const projectProfilePreview = { projectProfile: { title: '雾城旧档', genre: '悬疑' }, risks: ['标题待确认'] };
  const outlinePreview = { projectProfile: { outline: '旧档案牵出城市记忆篡改。' }, volumes: [{ volumeNo: 1, title: '旧档' }], chapters: [{ chapterNo: 1, title: '缺页' }], risks: ['大纲待确认'] };
  const charactersPreview = { characters: [{ name: '许知微' }], lorebookEntries: [{ title: '不应展示' }], risks: [] };
  const worldbuildingPreview = { lorebookEntries: [{ title: '雾城档案馆' }], characters: [{ name: '不应展示' }], risks: [] };
  const writingRulesPreview = { writingRules: [{ title: '第三人称有限视角' }], risks: [] };
  const validation = { valid: true };
  const steps = [
    { stepNo: 1, tool: 'read_source_document' },
    { stepNo: 2, tool: 'analyze_source_text' },
    { stepNo: 3, tool: 'generate_import_project_profile_preview' },
    { stepNo: 4, tool: 'generate_import_outline_preview' },
    { stepNo: 5, tool: 'generate_import_characters_preview' },
    { stepNo: 6, tool: 'generate_import_worldbuilding_preview' },
    { stepNo: 7, tool: 'generate_import_writing_rules_preview' },
    { stepNo: 8, tool: 'validate_imported_assets' },
  ];

  const artifacts = runtime.buildPreviewArtifacts(
    'project_import_preview',
    { 3: projectProfilePreview, 4: outlinePreview, 5: charactersPreview, 6: worldbuildingPreview, 7: writingRulesPreview, 8: validation },
    steps,
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['project_profile_preview', 'characters_preview', 'lorebook_preview', 'writing_rules_preview', 'outline_preview', 'import_validation_report']);
  assert.deepEqual(artifacts[0].content, projectProfilePreview.projectProfile);
  assert.deepEqual(artifacts[1].content, charactersPreview.characters);
  assert.deepEqual(artifacts[2].content, worldbuildingPreview.lorebookEntries);
  assert.deepEqual(artifacts[3].content, writingRulesPreview.writingRules);
  assert.deepEqual(artifacts[4].content, {
    outline: outlinePreview.projectProfile.outline,
    volumes: outlinePreview.volumes,
    chapters: outlinePreview.chapters,
    risks: ['标题待确认', '大纲待确认'],
  });
});

test('AgentRuntime 为目标 Tool 输出只展示用户选择的产物', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const outlinePreview = {
    projectProfile: { title: '不应展示为项目资料', outline: '只看大纲' },
    characters: [{ name: '不应展示' }],
    volumes: [{ volumeNo: 1, title: '卷一' }],
    chapters: [{ chapterNo: 1, title: '第一章' }],
    risks: [],
  };
  const steps = [
    { stepNo: 1, tool: 'generate_import_outline_preview' },
  ];

  const artifacts = runtime.buildPreviewArtifacts('project_import_preview', { 1: outlinePreview }, steps);

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['outline_preview']);
  assert.deepEqual(artifacts[0].content, { outline: '只看大纲', volumes: outlinePreview.volumes, chapters: outlinePreview.chapters, risks: [] });
});

test('AgentRuntime maps continuity preview/validation/persist artifacts', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'cont_1', changeType: 'relationship_edge' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'cont_1', action: 'create' }] };
  const persist = { createdRelationshipEdgeCount: 1, createdTimelineEventCount: 0 };
  const artifacts = runtime.buildExecutionArtifacts(
    'continuity_check',
    { 1: { diagnostics: {} }, 2: preview, 3: validation, 4: persist },
    [
      { stepNo: 1, tool: 'collect_task_context' },
      { stepNo: 2, tool: 'generate_continuity_preview' },
      { stepNo: 3, tool: 'validate_continuity_changes' },
      { stepNo: 4, tool: 'persist_continuity_changes' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['continuity_preview', 'continuity_validation_report', 'continuity_persist_result']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation, persist]);
});

test('AgentRuntime maps continuity preview and validation artifacts in plan mode', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'cont_1', changeType: 'timeline_event' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'cont_1', action: 'update' }] };
  const artifacts = runtime.buildPreviewArtifacts(
    'continuity_check',
    { 2: { noise: true }, 4: preview, 5: validation },
    [
      { stepNo: 2, tool: 'collect_task_context' },
      { stepNo: 4, tool: 'generate_continuity_preview' },
      { stepNo: 5, tool: 'validate_continuity_changes' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['continuity_preview', 'continuity_validation_report']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation]);
});

test('AgentRuntime maps timeline preview and validation artifacts in plan mode', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'tl_1', title: '失踪的页码', action: 'create_planned' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'tl_1', action: 'create_planned' }], rejected: [] };
  const artifacts = runtime.buildPreviewArtifacts(
    'timeline_plan',
    { 1: { context: true }, 2: preview, 3: validation },
    [
      { stepNo: 1, tool: 'inspect_project_context' },
      { stepNo: 2, tool: 'generate_timeline_preview' },
      { stepNo: 3, tool: 'validate_timeline_preview' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['timeline_preview', 'timeline_validation_report']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation]);
});

test('AgentRuntime maps timeline persist artifact in act mode', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'tl_1', title: '失踪的页码', action: 'create_planned' }] };
  const validation = { valid: true, accepted: [{ candidateId: 'tl_1', action: 'create_planned' }], rejected: [] };
  const persist = { createdCount: 1, updatedCount: 0, archivedCount: 0, events: [{ candidateId: 'tl_1', timelineEventId: 'event1' }] };
  const artifacts = runtime.buildExecutionArtifacts(
    'timeline_plan',
    { 2: preview, 3: validation, 4: persist },
    [
      { stepNo: 2, tool: 'generate_timeline_preview' },
      { stepNo: 3, tool: 'validate_timeline_preview' },
      { stepNo: 4, tool: 'persist_timeline_events' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['timeline_preview', 'timeline_validation_report', 'timeline_persist_result']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation, persist]);
});

test('VCC AgentRuntime maps volume character candidate preview and filters existing characters', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: Record<string, unknown> }>;
  };
  const baseCandidate = createVccCharacterPlanForChapterCount(4).newCharacterCandidates[0] as Record<string, unknown>;
  const characterPlan = createVccCharacterPlanForChapterCount(4, {
    newCharacterCandidates: [
      { ...baseCandidate, candidateId: 'cand_existing', name: '沈栖', firstAppearChapter: 1 },
      { ...baseCandidate, candidateId: 'cand_new', name: '顾临', firstAppearChapter: 2 },
    ],
  });
  const preview = createVccOutlinePreview(4, {
    volume: { narrativePlan: createVccNarrativePlanForChapterCount(4, { characterPlan }) },
  });
  const inspectContext = { characters: [{ name: '沈栖', aliases: ['旧名沈栖'], source: 'manual' }] };

  const artifacts = runtime.buildPreviewArtifacts(
    'outline_design',
    { 1: inspectContext, 2: preview },
    [
      { stepNo: 1, tool: 'inspect_project_context' },
      { stepNo: 2, tool: 'generate_volume_outline_preview' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['outline_preview', 'volume_character_candidates_preview']);
  const content = artifacts[1].content;
  assert.equal(content.totalCandidateCount, 2);
  assert.equal(content.persistableCount, 1);
  assert.equal(content.existingCount, 1);
  assert.equal(((content.persistableCandidates as Array<Record<string, unknown>>)[0]).name, '顾临');
  assert.equal(((content.existingCandidates as Array<Record<string, unknown>>)[0]).name, '沈栖');
});

test('VCC AgentRuntime maps volume character candidate persist artifact', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = createVccOutlinePreview(1);
  const validation = { valid: true, stats: { characterCandidateCount: 1 } };
  const outlinePersist = { createdCount: 1, updatedCount: 0, skippedCount: 0, chapterCount: 1 };
  const characterPersist = { createdCount: 1, updatedCount: 0, skippedCount: 0, relationshipCreatedCount: 1, relationshipSkippedCount: 0 };

  const artifacts = runtime.buildExecutionArtifacts(
    'outline_design',
    { 2: preview, 3: validation, 4: outlinePersist, 5: characterPersist },
    [
      { stepNo: 2, tool: 'merge_chapter_outline_previews' },
      { stepNo: 3, tool: 'validate_outline' },
      { stepNo: 4, tool: 'persist_outline' },
      { stepNo: 5, tool: 'persist_volume_character_candidates' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['outline_preview', 'outline_validation_report', 'outline_persist_result', 'volume_character_candidates_persist_result']);
  assert.equal(artifacts[3].content, characterPersist);
});

function createVccGuidedChapter(overrides: Record<string, unknown> = {}) {
  return createOutlineChapter(1, 1, {
    outline: '主角在旧闸棚账房逐页核对账册墨痕，巡检员夺走账册并要求他离开；同伴在后门假装摔倒藏下半页证据，雨廊尽头的东闸即将关闭，迫使他带着证据立刻转移。',
    ...overrides,
  });
}

function createVccGuidedVolume(overrides: Record<string, unknown> = {}) {
  return {
    volumeNo: 1,
    chapterCount: 3,
    title: '旧闸棚账册',
    synopsis: '## 全书主线阶段\n主角确认旧账册并非普通缺页，而是有人长期替换记录。\n## 本卷主线\n在东闸关闭前拿到账册证据。',
    objective: '拿到账册被替换的可验证证据',
    narrativePlan: createVccNarrativePlanForChapterCount(3),
    ...overrides,
  };
}

test('VCC guided_volume requires characterPlan', async () => {
  let transactionCalled = false;
  const prisma = {
    character: { async findMany() { return []; } },
    guidedSession: { async findUnique() { return { stepData: { guided_characters_result: { characters: [{ name: '林澈' }, { name: '沈栖' }] } } }; } },
    volume: {
      deleteMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
      createMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
    },
    async $transaction() {
      transactionCalled = true;
      return [];
    },
  };
  const service = new GuidedService(prisma as never, {} as never, {} as never);
  const badVolume = createVccGuidedVolume({
    narrativePlan: { ...createVccNarrativePlanForChapterCount(3), characterPlan: undefined },
  });

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_volume', { volumes: [badVolume] }),
    /characterPlan|角色规划/,
  );
  assert.equal(transactionCalled, false);
});

test('VCC guided_volume requires explicit volumeNo and chapterCount', async () => {
  let transactionCalled = false;
  const prisma = {
    character: { async findMany() { return []; } },
    guidedSession: { async findUnique() { return { stepData: { guided_characters_result: { characters: [{ name: '林澈' }, { name: '沈栖' }] } } }; } },
    volume: {
      deleteMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
      createMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
    },
    async $transaction() {
      transactionCalled = true;
      return [];
    },
  };
  const service = new GuidedService(prisma as never, {} as never, {} as never);

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_volume', { volumes: [createVccGuidedVolume({ volumeNo: undefined })] }),
    /volumeNo/,
  );
  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_volume', { volumes: [createVccGuidedVolume({ chapterCount: undefined })] }),
    /chapterCount/,
  );
  assert.equal(transactionCalled, false);
});

test('VCC guided_volume rejects incomplete narrativePlan before writes', async () => {
  let transactionCalled = false;
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: { guided_characters_result: { characters: [{ name: '林澈' }, { name: '沈栖' }] } } }; } },
    volume: {
      deleteMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
      createMany() {
        transactionCalled = true;
        return Promise.resolve({ count: 1 });
      },
    },
    async $transaction() {
      transactionCalled = true;
      return [];
    },
  };
  const service = new GuidedService(prisma as never, {} as never, {} as never);
  const badVolume = createVccGuidedVolume({
    narrativePlan: { ...createVccNarrativePlanForChapterCount(3), characterPlan: undefined },
  });

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_volume', { volumes: [badVolume] }),
    /characterPlan|叙事规划|narrativePlan/,
  );
  assert.equal(transactionCalled, false);
});

test('VCC legacy guided finalize-step endpoint rejects direct writes', () => {
  let serviceCalled = false;
  const controller = new GuidedController({
    finalizeStep() {
      serviceCalled = true;
      throw new Error('legacy finalize-step must not call GuidedService.finalizeStep');
    },
  } as never);

  assert.throws(
    () => controller.finalizeStep('p1', {
      currentStep: 'guided_volume',
      structuredData: { volumes: [createVccGuidedVolume()] },
    }),
    (error) => error instanceof BadRequestException && /guided_step_finalize|persist_guided_step_result/.test(error.message),
  );
  assert.equal(serviceCalled, false);
});

test('VCC guided finalize rejects empty volume and chapter results without saving session data', async () => {
  let sessionTouched = false;
  let writeTouched = false;
  const prisma = {
    character: { async findMany() { throw new Error('empty guided result should fail before loading character catalog'); } },
    guidedSession: {
      async findUnique() { sessionTouched = true; return { stepData: {} }; },
      async update() { sessionTouched = true; return {}; },
    },
    volume: {
      deleteMany() { writeTouched = true; return Promise.resolve({ count: 0 }); },
      createMany() { writeTouched = true; return Promise.resolve({ count: 0 }); },
      findMany() { writeTouched = true; return Promise.resolve([]); },
    },
    chapter: {
      findMany() { writeTouched = true; return Promise.resolve([]); },
      aggregate() { writeTouched = true; return Promise.resolve({ _max: { chapterNo: 0 } }); },
      create() { writeTouched = true; return Promise.resolve({}); },
    },
  };
  const service = new GuidedService(prisma as never, {} as never, {} as never);

  await assert.rejects(() => service.finalizeStep('p1', 'guided_volume', {}), /volumes/);
  await assert.rejects(() => service.finalizeStep('p1', 'guided_volume', { volumes: [] }), /volumes/);
  await assert.rejects(() => service.finalizeStep('p1', 'guided_chapter', {}), /chapters/);
  await assert.rejects(() => service.finalizeStep('p1', 'guided_chapter', { chapters: [] }, 1), /chapters/);
  assert.equal(sessionTouched, false);
  assert.equal(writeTouched, false);
});

test('VCC guided_chapter requires characterExecution', async () => {
  let chapterWriteCalled = false;
  const validVolume = createVccGuidedVolume();
  const existingName = (validVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>).existingCharacterArcs[0].characterName;
  const prisma = {
    character: { async findMany() { return [{ name: existingName, alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; } },
    volume: { async findMany() { return []; } },
    chapter: {
      async findMany() { chapterWriteCalled = true; return []; },
      async aggregate() { chapterWriteCalled = true; return { _max: { chapterNo: 0 } }; },
    },
  };
  const service = new GuidedService(prisma as never, {} as never, {} as never);
  const craftBrief = { ...createOutlineCraftBrief(), characterExecution: undefined };

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_chapter', { chapters: [createVccGuidedChapter({ craftBrief })] }, 1),
    /characterExecution|角色执行/,
  );
  assert.equal(chapterWriteCalled, false);
});

test('VCC guided_chapter resolves persisted volume narrativePlan without session draft', async () => {
  const persistedVolume = { id: 'v1', ...createVccGuidedVolume() };
  const existingName = (persistedVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>).existingCharacterArcs[0].characterName;
  const volumeSelects: Array<Record<string, unknown>> = [];
  const createdChapters: Array<Record<string, unknown>> = [];
  let transactionCalled = false;
  const pickSelected = (source: Record<string, unknown>, select: Record<string, unknown>) => Object.fromEntries(
    Object.entries(source).filter(([key]) => select[key] === true),
  );
  const prisma = {
    character: { async findMany() { return [{ name: existingName, alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: {
      async findUnique() { return { stepData: {} }; },
      async update() { return {}; },
    },
    volume: {
      async findMany(args: { select?: Record<string, unknown> }) {
        const select = args.select ?? {};
        volumeSelects.push(select);
        if (select.id) return [pickSelected({ id: 'v1', volumeNo: persistedVolume.volumeNo }, select)];
        return [pickSelected(persistedVolume as Record<string, unknown>, select)];
      },
    },
    chapter: {
      async findMany() { return []; },
      async aggregate() { return { _max: { chapterNo: 0 } }; },
      create(args: { data: Record<string, unknown> }) {
        createdChapters.push(args.data);
        return Promise.resolve({ id: 'c1', ...args.data });
      },
    },
    async $transaction(operations: Array<Promise<unknown>>) {
      transactionCalled = true;
      return Promise.all(operations);
    },
  };
  const persistedVolumeCache = { async deleteProjectRecallResults() {} };
  const service = new GuidedService(prisma as never, {} as never, persistedVolumeCache as never);

  const result = await service.finalizeStep(
    'p1',
    'guided_chapter',
    { chapters: [createVccGuidedChapter({ chapterNo: 1, volumeNo: 1 })], saveMode: 'single_chapter' },
    1,
  );

  assert.deepEqual(result.written, ['Chapter × 1']);
  assert.equal(transactionCalled, true);
  assert.equal(createdChapters[0].volumeId, 'v1');
  assert.deepEqual(volumeSelects[0], { volumeNo: true, title: true, synopsis: true, objective: true, chapterCount: true, narrativePlan: true });
});

test('VCC guided_chapter rejects unpersisted session characterPlan when writing chapters', async () => {
  const createVolumeWithCandidate = (candidateName: string) => {
    const basePlan = createVccCharacterPlanForChapterCount(3);
    const baseCandidateName = String((basePlan.newCharacterCandidates[0] as Record<string, unknown>).name);
    const characterPlan = createVccCharacterPlanForChapterCount(3, {
      newCharacterCandidates: [
        {
          ...(basePlan.newCharacterCandidates[0] as Record<string, unknown>),
          candidateId: `cand_${candidateName.toLowerCase()}`,
          name: candidateName,
        },
      ],
      relationshipArcs: basePlan.relationshipArcs.map((arc) => ({
        ...arc,
        participants: (arc.participants as unknown[]).map((name) => name === baseCandidateName ? candidateName : name),
      })),
      roleCoverage: {
        ...(basePlan.roleCoverage as Record<string, unknown>),
        antagonistPressure: [candidateName],
        expositionCarriers: [candidateName],
      },
    });
    const narrativePlan = createVccNarrativePlanForChapterCount(3, { characterPlan });
    return createVccGuidedVolume({
      narrativePlan: {
        ...narrativePlan,
        subStoryLines: (narrativePlan.subStoryLines as Array<Record<string, unknown>>).map((line) => ({
          ...line,
          relatedCharacters: Array.isArray(line.relatedCharacters)
            ? line.relatedCharacters.map((name) => name === baseCandidateName ? candidateName : name)
            : line.relatedCharacters,
        })),
      },
    });
  };
  const createChapterUsingCandidate = (candidateName: string) => {
    const craftBrief = createOutlineCraftBrief();
    const characterExecution = craftBrief.characterExecution as Record<string, unknown>;
    const previousCandidateName = (characterExecution.cast as Array<Record<string, unknown>>)
      .find((item) => item.source === 'volume_candidate')?.characterName;
    return createVccGuidedChapter({
      chapterNo: 1,
      volumeNo: 1,
      craftBrief: {
        ...craftBrief,
        characterExecution: {
          ...characterExecution,
          cast: (characterExecution.cast as Array<Record<string, unknown>>).map((item) => (
            item.source === 'volume_candidate' ? { ...item, characterName: candidateName } : item
          )),
          relationshipBeats: (characterExecution.relationshipBeats as Array<Record<string, unknown>>).map((beat) => ({
            ...beat,
            participants: Array.isArray(beat.participants)
              ? beat.participants.map((name) => name === previousCandidateName ? candidateName : name)
              : beat.participants,
          })),
        },
      },
    });
  };
  const persistedVolume = { id: 'v1', ...createVolumeWithCandidate('PersistedCandidate') };
  const sessionDraftVolume = createVolumeWithCandidate('SessionCandidate');
  const persistedPlan = persistedVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>;
  const existingNames = persistedPlan.existingCharacterArcs.map((arc) => arc.characterName);
  let sessionUpdated = false;
  let cacheCleared = false;
  let chapterTouched = false;
  let transactionCalled = false;
  const pickSelected = (source: Record<string, unknown>, select: Record<string, unknown>) => Object.fromEntries(
    Object.entries(source).filter(([key]) => select[key] === true),
  );
  const prisma = {
    character: { async findMany() { return existingNames.map((name) => ({ name, alias: [] })); } },
    guidedSession: {
      async findUnique() { return { stepData: { guided_volume_result: { volumes: [sessionDraftVolume] } } }; },
      async update() { sessionUpdated = true; return {}; },
    },
    volume: {
      async findMany(args: { select?: Record<string, unknown> }) {
        const select = args.select ?? {};
        if (select.id) return [pickSelected({ id: 'v1', volumeNo: persistedVolume.volumeNo }, select)];
        return [pickSelected(persistedVolume as Record<string, unknown>, select)];
      },
    },
    chapter: {
      async findMany() { chapterTouched = true; return []; },
      async aggregate() { chapterTouched = true; return { _max: { chapterNo: 0 } }; },
      create() { chapterTouched = true; return Promise.resolve({}); },
    },
    async $transaction() {
      transactionCalled = true;
      return [];
    },
  };
  const cache = { async deleteProjectRecallResults() { cacheCleared = true; } };
  const service = new GuidedService(prisma as never, {} as never, cache as never);

  await assert.rejects(
    () => service.finalizeStep(
      'p1',
      'guided_chapter',
      { chapters: [createChapterUsingCandidate('SessionCandidate')], saveMode: 'single_chapter' },
      1,
    ),
    /volume_candidate|guided_volume|章节角色执行/,
  );
  assert.equal(chapterTouched, false);
  assert.equal(transactionCalled, false);
  assert.equal(sessionUpdated, false);
  assert.equal(cacheCleared, false);
});

test('VCC guided_chapter rejects per-volume write before volume is persisted', async () => {
  const validVolume = createVccGuidedVolume();
  const existingName = (validVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>).existingCharacterArcs[0].characterName;
  let sessionUpdated = false;
  let cacheCleared = false;
  let chapterTouched = false;
  let transactionCalled = false;
  const prisma = {
    character: { async findMany() { return [{ name: existingName, alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: {
      async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; },
      async update() { sessionUpdated = true; return {}; },
    },
    volume: { async findMany() { return []; } },
    chapter: {
      async findMany() { chapterTouched = true; return []; },
      async aggregate() { chapterTouched = true; return { _max: { chapterNo: 0 } }; },
      create() { chapterTouched = true; return Promise.resolve({}); },
    },
    async $transaction() {
      transactionCalled = true;
      return [];
    },
  };
  const cache = { async deleteProjectRecallResults() { cacheCleared = true; } };
  const service = new GuidedService(prisma as never, {} as never, cache as never);

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_chapter', { chapters: [createVccGuidedChapter({ chapterNo: 1, volumeNo: 1 })] }, 1),
    /第 1 卷尚未持久化|先审批写入 guided_volume/,
  );
  assert.equal(chapterTouched, false);
  assert.equal(transactionCalled, false);
  assert.equal(sessionUpdated, false);
  assert.equal(cacheCleared, false);
});

test('VCC guided_chapter rejects full write with unresolved volume references', async () => {
  const validVolume = createVccGuidedVolume();
  const existingName = (validVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>).existingCharacterArcs[0].characterName;
  let sessionUpdated = false;
  let cacheCleared = false;
  let deleteManyCalled = false;
  let createManyCalled = false;
  const prisma = {
    character: { async findMany() { return [{ name: existingName, alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: {
      async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; },
      async update() { sessionUpdated = true; return {}; },
    },
    volume: { async findMany() { return []; } },
    chapter: {
      async deleteMany() { deleteManyCalled = true; return { count: 0 }; },
      async createMany() { createManyCalled = true; return { count: 0 }; },
    },
  };
  const cache = { async deleteProjectRecallResults() { cacheCleared = true; } };
  const service = new GuidedService(prisma as never, {} as never, cache as never);

  await assert.rejects(
    () => service.finalizeStep('p1', 'guided_chapter', { chapters: [createVccGuidedChapter({ chapterNo: 1, volumeNo: 1 })] }),
    /章节引用的卷尚未持久化|先审批写入 guided_volume/,
  );
  assert.equal(deleteManyCalled, false);
  assert.equal(createManyCalled, false);
  assert.equal(sessionUpdated, false);
  assert.equal(cacheCleared, false);
});

test('VCC guided_chapter rejects mismatched chapter number', async () => {
  const llm = {
    async chat() {
      return '已生成。\n```json\n{"chapters":[{"chapterNo":4,"volumeNo":1,"title":"错章","objective":"目标","conflict":"冲突","outline":"短"}]}\n```';
    },
  };
  const prisma = {
    promptTemplate: { async findFirst() { return null; } },
    guidedSession: { async findUnique() { return { stepData: {} }; } },
    volume: {
      async findFirst() { return { id: 'v1', volumeNo: 1, title: '卷一', objective: '目标', synopsis: '简介' }; },
    },
    chapter: {
      async findFirst() { return { id: 'c3', volumeId: 'v1', chapterNo: 3, title: '第三章', objective: '旧目标', conflict: '旧冲突', outline: '旧细纲', craftBrief: {} }; },
      async findMany() { return []; },
    },
    chapterPattern: { async findMany() { return []; } },
    pacingBeat: { async findMany() { return []; } },
    sceneCard: { async findMany() { return []; } },
  };
  const service = new GuidedService(prisma as never, llm as never, {} as never);

  await assert.rejects(
    () => service.generateStepData('p1', { currentStep: 'guided_chapter', volumeNo: 1, chapterNo: 3 }),
    /chapterNo=4|第 3 章/,
  );
});

test('VCC guided_chapter finalize does not create supporting Character', async () => {
  const validVolume = createVccGuidedVolume();
  const existingName = (validVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>).existingCharacterArcs[0].characterName;
  const characterWrites: string[] = [];
  let savedStepData: Record<string, unknown> | undefined;
  const persistedVolume = { id: 'v1', ...validVolume };
  const pickSelected = (source: Record<string, unknown>, select: Record<string, unknown>) => Object.fromEntries(
    Object.entries(source).filter(([key]) => select[key] === true),
  );
  const prisma = {
    character: {
      async findMany() { return [{ name: existingName, alias: [] }, { name: '沈栖', alias: [] }]; },
      async deleteMany() { characterWrites.push('deleteMany'); return { count: 1 }; },
      async createMany() { characterWrites.push('createMany'); return { count: 1 }; },
    },
    guidedSession: {
      async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; },
      async update(args: { data: { stepData: Record<string, unknown> } }) {
        savedStepData = args.data.stepData;
        return {};
      },
    },
    volume: {
      async findMany(args: { select?: Record<string, unknown> }) {
        const select = args.select ?? {};
        if (select.id) return [pickSelected({ id: 'v1', volumeNo: 1 }, select)];
        return [pickSelected(persistedVolume as Record<string, unknown>, select)];
      },
    },
    chapter: {
      async findMany() { return []; },
      async aggregate() { return { _max: { chapterNo: 0 } }; },
      create(args: Record<string, unknown>) { return Promise.resolve({ id: 'c1', ...args }); },
    },
    async $transaction(operations: Array<Promise<unknown>>) {
      return Promise.all(operations);
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new GuidedService(prisma as never, {} as never, cache as never);

  const result = await service.finalizeStep(
    'p1',
    'guided_chapter',
    {
      chapters: [createVccGuidedChapter()],
      supportingCharacters: [{ name: '旧展示配角', roleType: 'supporting', personalityCore: '谨慎', motivation: '守门' }],
    },
    1,
  );

  assert.deepEqual(result.written, ['Chapter × 1']);
  assert.deepEqual(characterWrites, []);
  const guidedChapterResult = savedStepData?.guided_chapter_result as Record<string, unknown> | undefined;
  assert.deepEqual((guidedChapterResult?.volumeSupportingCharacters as Record<string, unknown>)?.[1], [{ name: '旧展示配角', roleType: 'supporting', personalityCore: '谨慎', motivation: '守门' }]);
});

test('GenerateGuidedStepPreviewTool 生成全部 guided 步骤预览且保持只读', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const progress: Array<Record<string, unknown>> = [];
  const responses = [
    { genre: '悬疑', theme: '记忆与真相', tone: '冷静克制', logline: '档案员追查一份不存在的死亡记录。', synopsis: '档案错位牵出旧案。' },
    { pov: '第三人称有限视角', tense: '过去时', proseStyle: '冷静、克制、细节驱动', pacing: '缓慢加压' },
    { characters: [{ name: '许知微', roleType: 'protagonist', personalityCore: '谨慎但害怕失控', motivation: '查清父亲旧案', backstory: '旧档案馆长大的调查员' }] },
    { outline: '旧档案牵出一座城市的集体记忆篡改，主角逐步发现自己也是证据之一。' },
    { volumes: [{ volumeNo: 1, title: '灰楼旧灯', synopsis: '## 全书主线阶段\n发现异常', objective: '确认旧案存在', narrativePlan: { globalMainlineStage: '发现异常' } }] },
    { chapters: [{ chapterNo: 1, volumeNo: 1, title: '失踪的页码', objective: '发现档案缺页', conflict: '馆方阻止调阅', outline: '主角夜查档案库。', craftBrief: { visibleGoal: '查档案' } }], supportingCharacters: [{ name: '周砚', roleType: 'supporting', personalityCore: '沉默但执拗', motivation: '保护旧馆', firstAppearChapter: 1 }] },
    { foreshadowTracks: [{ title: '缺页编号', detail: '每次缺页都对应一个仍活着的人。', scope: 'arc', technique: '道具型', plantChapter: '第1卷第1章', revealChapter: '第3卷第8章', involvedCharacters: '许知微', payoff: '证明记忆篡改是真实机制。' }] },
  ];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return { data: responses.shift() };
    },
  };
  const tool = new GenerateGuidedStepPreviewTool(llm as never);
  const context = {
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
    async updateProgress(patch: unknown) { progress.push(patch as Record<string, unknown>); },
  };

  const setup = await tool.run({ stepKey: 'guided_setup', userHint: '偏悬疑但不要太黑暗', projectContext: { title: '旧档案' } }, context);
  const style = await tool.run({ stepKey: 'guided_style', chatSummary: '用户确认了冷静基调' }, context);
  const characters = await tool.run({ stepKey: 'guided_characters', projectContext: { guided_setup_result: setup.structuredData } }, context);
  const outline = await tool.run({ stepKey: 'guided_outline', projectContext: { guided_characters_result: characters.structuredData } }, context);
  const volume = await tool.run({ stepKey: 'guided_volume', userHint: '请生成 1 卷', projectContext: { guided_outline_result: outline.structuredData } }, context);
  const chapter = await tool.run({ stepKey: 'guided_chapter', volumeNo: 1, projectContext: { guided_volume_result: volume.structuredData } }, context);
  const foreshadow = await tool.run({ stepKey: 'guided_foreshadow', projectContext: { guided_volume_result: volume.structuredData, guided_chapter_result: chapter.structuredData } }, context);

  assert.equal(setup.stepKey, 'guided_setup');
  assert.equal(setup.structuredData.genre, '悬疑');
  assert.match(setup.summary, /悬疑/);
  assert.equal(style.stepKey, 'guided_style');
  assert.equal(style.structuredData.pov, '第三人称有限视角');
  assert.equal((characters.structuredData.characters as unknown[]).length, 1);
  assert.match(outline.summary, /故事总纲/);
  assert.equal((volume.structuredData.volumes as unknown[]).length, 1);
  assert.match(chapter.summary, /1 章细纲/);
  assert.equal((foreshadow.structuredData.foreshadowTracks as unknown[]).length, 1);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.riskLevel, 'low');
  assert.ok(tool.allowedModes.includes('plan'));
  assert.match(calls[0].messages[0].content, /"genre"/);
  assert.equal(calls[0].options.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(calls[0].options.retries, 1);
  assert.match(calls[1].messages[0].content, /"pov"/);
  assert.match(calls[5].messages[0].content, /"chapters"/);
  assert.match(calls[6].messages[0].content, /"foreshadowTracks"/);
  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000 + 60_000);
  assert.equal(progress.some((item) => item.phase === 'calling_llm' && item.timeoutMs === DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000), true);
  assert.equal(progress.some((item) => item.phase === 'validating'), true);
});

test('GenerateGuidedStepPreviewTool 对缺少上下文的章节预览返回 warnings', async () => {
  const tool = new GenerateGuidedStepPreviewTool({
    async chatJson() {
      return { data: { chapters: [{ chapterNo: 1, volumeNo: 1, title: '失踪的页码', objective: '发现缺页', conflict: '馆方阻止', outline: '夜查档案库。' }] } };
    },
  } as never);

  const result = await tool.run(
    { stepKey: 'guided_chapter' },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.match(result.warnings.join('；'), /缺少前置步骤上下文/);
  assert.match(result.warnings.join('；'), /未指定 volumeNo/);
});

test('GenerateGuidedStepPreviewTool injects chapter patterns and pacing targets for guided chapters', async () => {
  let promptText = '';
  let pacingWhere: Record<string, unknown> | undefined;
  let sceneWhere: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      return {
        data: {
          chapters: [{
            chapterNo: 3,
            volumeNo: 1,
            title: 'Archive Gate',
            objective: 'Force the guard to reveal the missing ledger.',
            conflict: 'The guard hides the ledger key.',
            outline: 'The protagonist confronts the guard at the archive gate.',
            craftBrief: { visibleGoal: 'Get inside the archive.' },
          }],
        },
      };
    },
  };
  const prisma = {
    volume: {
      async findFirst() {
        return { id: 'v1', volumeNo: 1, title: 'Volume One', objective: 'Open the archive' };
      },
    },
    chapter: {
      async findFirst() {
        return { id: 'c3', volumeId: 'v1', chapterNo: 3, title: 'Archive Gate', objective: 'Get the ledger' };
      },
    },
    chapterPattern: {
      async findMany() {
        return [{
          id: 'pat-1',
          patternType: 'reversal',
          name: 'Pressure Reversal',
          applicableScenes: ['confrontation'],
          structure: { beats: ['approach', 'pressure', 'reversal'] },
          pacingAdvice: { tempo: 'tight' },
          emotionalAdvice: { tone: 'contained anger' },
          conflictAdvice: { source: 'information asymmetry' },
        }];
      },
    },
    pacingBeat: {
      async findMany(args: { where: Record<string, unknown> }) {
        pacingWhere = args.where;
        return [{
          id: 'pace-1',
          volumeId: 'v1',
          chapterId: 'c3',
          chapterNo: 3,
          beatType: 'reveal',
          emotionalTone: 'cold dread',
          emotionalIntensity: 72,
          tensionLevel: 85,
          payoffLevel: 35,
          notes: 'Keep the reveal partial.',
        }];
      },
    },
    sceneCard: {
      async findMany(args: { where: Record<string, unknown> }) {
        sceneWhere = args.where;
        return [{
          id: 'scene-guided',
          volumeId: 'v1',
          chapterId: 'c3',
          sceneNo: 1,
          title: 'Archive Gate Confrontation',
          locationName: 'Archive gate',
          participants: ['Lin Che'],
          purpose: 'Force the guard to reveal the missing ledger.',
          conflict: 'The guard hides the ledger key.',
          emotionalTone: 'cold dread',
          keyInformation: 'The ledger key is fake.',
          result: 'Lin Che enters with the wrong key.',
          relatedForeshadowIds: ['f-ledger'],
          status: 'planned',
          metadata: { beat: 'turn' },
          updatedAt: new Date('2026-05-05T00:00:00Z'),
        }];
      },
    },
  };
  const tool = new GenerateGuidedStepPreviewTool(llm as never, prisma as never);

  await tool.run(
    { stepKey: 'guided_chapter', volumeNo: 1, chapterNo: 3, projectContext: { existing: true } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.match(promptText, /phase4Guidance/);
  assert.match(promptText, /chapter_pattern/);
  assert.match(promptText, /Pressure Reversal/);
  assert.match(promptText, /pacing_beat/);
  assert.match(promptText, /tensionLevel/);
  assert.match(promptText, /scene_card/);
  assert.match(promptText, /Archive Gate Confrontation/);
  assert.match(promptText, /f-ledger/);
  const pacingOr = (pacingWhere?.OR ?? []) as Array<Record<string, unknown>>;
  assert.ok(pacingOr.some((item) => item.volumeId === 'v1' && item.chapterId === null && item.chapterNo === null));
  assert.equal(pacingOr.some((item) => item.volumeId === 'v1' && !Object.prototype.hasOwnProperty.call(item, 'chapterId') && !Object.prototype.hasOwnProperty.call(item, 'chapterNo')), false);
  assert.deepEqual(sceneWhere, { projectId: 'p1', chapterId: 'c3', NOT: { status: 'archived' } });
});

test('GuidedService chat injects chapter patterns and pacing targets for guided chapter consultation', async () => {
  let systemPrompt = '';
  let pacingWhere: Record<string, unknown> | undefined;
  let sceneWhere: Record<string, unknown> | undefined;
  const prisma = {
    promptTemplate: {
      async findFirst() {
        return null;
      },
    },
    volume: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.volumeNo === 1 && args.where.projectId === 'p1') return { id: 'v1', volumeNo: 1, title: 'Volume One' };
        return null;
      },
    },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.chapterNo === 3 && args.where.projectId === 'p1') return { id: 'c3', volumeId: 'v1', chapterNo: 3, title: 'Archive Gate' };
        return null;
      },
    },
    chapterPattern: {
      async findMany() {
        return [{
          id: 'pat-chat',
          patternType: 'suspense',
          name: 'Question Escalation',
          applicableScenes: ['investigation'],
          structure: { beats: ['clue', 'misread', 'new question'] },
          pacingAdvice: { tempo: 'slow burn' },
          emotionalAdvice: { tone: 'uneasy' },
          conflictAdvice: { source: 'false certainty' },
        }];
      },
    },
    pacingBeat: {
      async findMany(args: { where: Record<string, unknown> }) {
        pacingWhere = args.where;
        return [{
          id: 'pace-chat',
          volumeId: 'v1',
          chapterId: 'c3',
          chapterNo: 3,
          beatType: 'setup',
          emotionalTone: 'uneasy',
          emotionalIntensity: 60,
          tensionLevel: 70,
          payoffLevel: 20,
          notes: 'Keep the answer incomplete.',
        }];
      },
    },
    sceneCard: {
      async findMany(args: { where: Record<string, unknown> }) {
        sceneWhere = args.where;
        return [{
          id: 'scene-chat',
          chapterId: 'c3',
          sceneNo: 1,
          title: 'Ledger Gate',
          locationName: 'Archive gate',
          participants: ['Lin Che'],
          purpose: 'Test the guard lie.',
          conflict: 'The guard conceals the real ledger.',
          emotionalTone: 'uneasy',
          keyInformation: 'The guard uses a fake key.',
          result: 'The team enters a trap.',
          relatedForeshadowIds: ['f-trap'],
          status: 'planned',
          metadata: { beat: 'trap' },
          updatedAt: new Date('2026-05-05T00:00:00Z'),
        }];
      },
    },
  };
  const llm = {
    async chat(messages: Array<{ role: string; content: string }>) {
      systemPrompt = messages[0].content;
      return '好的。[STEP_COMPLETE]{}';
    },
  };
  const service = new GuidedService(prisma as never, llm as never, {} as never);

  await service.chatWithAi('p1', { currentStep: 'guided_chapter', userMessage: '帮我细化这一章。', volumeNo: 1, chapterNo: 3 });

  assert.match(systemPrompt, /章节模板与节奏目标/);
  assert.match(systemPrompt, /sourceType=chapter_pattern/);
  assert.match(systemPrompt, /Question Escalation/);
  assert.match(systemPrompt, /sourceType=pacing_beat/);
  assert.match(systemPrompt, /张力 70/);
  assert.match(systemPrompt, /sourceType=scene_card/);
  assert.match(systemPrompt, /Ledger Gate/);
  assert.match(systemPrompt, /f-trap/);
  const pacingOr = (pacingWhere?.OR ?? []) as Array<Record<string, unknown>>;
  assert.ok(pacingOr.some((item) => item.chapterId === 'c3'));
  assert.ok(pacingOr.some((item) => item.volumeId === 'v1' && item.chapterId === null && item.chapterNo === null));
  assert.equal(pacingOr.some((item) => item.volumeId === 'v1' && !Object.prototype.hasOwnProperty.call(item, 'chapterId') && !Object.prototype.hasOwnProperty.call(item, 'chapterNo')), false);
  assert.deepEqual(sceneWhere, { projectId: 'p1', chapterId: 'c3', NOT: { status: 'archived' } });
});

test('GenerateGuidedStepPreviewTool 对未知步骤显式拒绝', async () => {
  const tool = new GenerateGuidedStepPreviewTool({ async chatJson() { throw new Error('不应调用 LLM'); } } as never);

  await assert.rejects(
    () => tool.run({ stepKey: 'guided_unknown' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }),
    /未知创作引导步骤/,
  );
});

test('VCC generate_guided_step_preview rejects non-object LLM output', async () => {
  const tool = new GenerateGuidedStepPreviewTool({
    async chatJson() {
      return { data: [], result: { model: 'mock-guided-preview' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { stepKey: 'guided_setup' },
      { agentRunId: 'run-vcc-guided-preview-non-object', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /不是 JSON 对象|JSON object/,
  );
});

test('ValidateGuidedStepPreviewTool 标记缺字段、重复编号并保持只读', async () => {
  const reads: string[] = [];
  const prisma = {
    character: {
      async findMany() {
        reads.push('character.findMany');
        return [{ name: '许知微' }];
      },
    },
    volume: {
      async findMany() {
        reads.push('volume.findMany');
        return [{ id: 'v1', volumeNo: 1, title: '旧第一卷' }];
      },
    },
    chapter: {
      async findMany() {
        reads.push('chapter.findMany');
        return [{ chapterNo: 2, status: 'drafted', title: '旧第二章' }];
      },
    },
    foreshadowTrack: {
      async findMany() {
        reads.push('foreshadowTrack.findMany');
        return [];
      },
    },
  };
  const tool = new ValidateGuidedStepPreviewTool(prisma as never);
  const context = { agentRunId: 'run1', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };

  const characters = await tool.run(
    { stepKey: 'guided_characters', structuredData: { characters: [{ name: '', roleType: 'protagonist' }, { name: '许知微' }, { name: '许知微' }] } },
    context,
  );
  const volumes = await tool.run(
    { stepKey: 'guided_volume', structuredData: { volumes: [{ volumeNo: 1, title: '新第一卷' }, { volumeNo: 1, title: '重复第一卷' }] } },
    context,
  );
  const chapters = await tool.run(
    { stepKey: 'guided_chapter', volumeNo: 1, structuredData: { chapters: [{ chapterNo: 2, volumeNo: 1, title: '二' }, { chapterNo: 2, volumeNo: 1, title: '二-重复' }] } },
    context,
  );

  assert.equal(characters.valid, false);
  assert.match(characters.issues.map((issue) => issue.message).join('；'), /缺少 name/);
  assert.match(characters.issues.map((issue) => issue.message).join('；'), /重复角色名/);
  assert.equal((characters.writePreview.summary as Record<string, number>).existingNameCount, 2);
  assert.equal(volumes.valid, false);
  assert.match(volumes.issues.map((issue) => issue.message).join('；'), /重复卷号/);
  assert.equal((volumes.writePreview.summary as Record<string, number>).duplicateCount, 2);
  assert.equal(chapters.valid, false);
  assert.match(chapters.issues.map((issue) => issue.message).join('；'), /重复章节号/);
  assert.equal((chapters.writePreview.summary as Record<string, number>).duplicateCount, 2);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(reads, ['character.findMany', 'character.findMany', 'volume.findMany', 'character.findMany', 'volume.findMany', 'volume.findMany', 'chapter.findMany']);
});

test('VCC validate_guided_step_preview rejects missing characterPlan', async () => {
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: {} }; } },
    volume: { async findMany() { return []; } },
  };
  const tool = new ValidateGuidedStepPreviewTool(prisma as never);
  const badVolume = createVccGuidedVolume({
    narrativePlan: { ...createVccNarrativePlanForChapterCount(3), characterPlan: undefined },
  });

  const result = await tool.run(
    { stepKey: 'guided_volume', structuredData: { volumes: [badVolume] } },
    { agentRunId: 'run-vcc-validate-guided-volume', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => /characterPlan|角色规划/.test(issue.message)), true);
});

test('VCC validate_guided_step_preview rejects incomplete volume narrativePlan', async () => {
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: {} }; } },
    volume: { async findMany() { return []; } },
  };
  const tool = new ValidateGuidedStepPreviewTool(prisma as never);
  const badVolume = createVccGuidedVolume({
    narrativePlan: { ...createVccNarrativePlanForChapterCount(3), foreshadowPlan: undefined },
  });

  const result = await tool.run(
    { stepKey: 'guided_volume', structuredData: { volumes: [badVolume] } },
    { agentRunId: 'run-vcc-validate-guided-narrative', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => /foreshadowPlan|叙事规划|narrativePlan/.test(issue.message)), true);
});

test('VCC validate_guided_step_preview rejects invalid characterExecution', async () => {
  const validVolume = createVccGuidedVolume();
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; } },
    volume: { async findMany() { return []; } },
    chapter: { async findMany() { return []; } },
  };
  const tool = new ValidateGuidedStepPreviewTool(prisma as never);
  const baseCraftBrief = createOutlineCraftBrief();
  const craftBrief = {
    ...baseCraftBrief,
    sceneBeats: [
      { ...(baseCraftBrief.sceneBeats as Array<Record<string, unknown>>)[0], participants: ['未列入角色'] },
      ...(baseCraftBrief.sceneBeats as Array<Record<string, unknown>>).slice(1),
    ],
  };

  const result = await tool.run(
    { stepKey: 'guided_chapter', volumeNo: 1, structuredData: { chapters: [createVccGuidedChapter({ craftBrief })] } },
    { agentRunId: 'run-vcc-validate-guided-chapter', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => /characterExecution|角色执行/.test(issue.message)), true);
  assert.equal(result.issues.some((issue) => /未被 characterExecution\.cast 覆盖/.test(issue.message)), true);
});

test('ValidateGuidedStepPreviewTool 为有效基础设定生成写入前 diff', async () => {
  const tool = new ValidateGuidedStepPreviewTool({} as never);
  const result = await tool.run(
    {
      stepKey: 'guided_setup',
      structuredData: { genre: '悬疑', theme: '记忆与真相', tone: '冷静克制', logline: '档案员追查不存在的死亡记录。', synopsis: '旧档案牵出城市记忆篡改。' },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, true);
  assert.equal(result.issueCount, 0);
  assert.equal(result.writePreview.action, 'update_project_profile');
  assert.equal((result.writePreview.summary as Record<string, number>).updateFieldCount, 5);
  assert.ok(tool.manifest.examples?.[0].plan.some((step) => step.tool === 'validate_guided_step_preview'));
});

test('PersistGuidedStepResultTool 审批后复用校验并调用 GuidedService 写入', async () => {
  let validatedArgs: Record<string, unknown> | undefined;
  let finalizedArgs: Record<string, unknown> | undefined;
  const validation = { valid: true, issueCount: 0, issues: [], writePreview: { action: 'update_project_profile' } };
  const validateTool = {
    async run(args: Record<string, unknown>) {
      validatedArgs = args;
      return validation;
    },
  };
  const guidedService = {
    async finalizeStep(projectId: string, stepKey: string, structuredData: Record<string, unknown>, volumeNo?: number) {
      finalizedArgs = { projectId, stepKey, structuredData, volumeNo };
      return { written: ['Project(genre, theme, tone, logline, synopsis)'] };
    },
  };
  const tool = new PersistGuidedStepResultTool(guidedService as never, validateTool as never);
  const structuredData = { genre: '悬疑', theme: '记忆与真相', tone: '冷静克制', logline: '旧档案', synopsis: '档案错位牵出旧案。' };

  const result = await tool.run(
    { stepKey: 'guided_setup', structuredData },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.deepEqual(validatedArgs, { stepKey: 'guided_setup', structuredData, volumeNo: undefined });
  assert.deepEqual(finalizedArgs, { projectId: 'p1', stepKey: 'guided_setup', structuredData, volumeNo: undefined });
  assert.deepEqual(result.written, ['Project(genre, theme, tone, logline, synopsis)']);
  assert.equal(result.validation.valid, true);
  assert.equal(result.writePreview.action, 'update_project_profile');
  assert.deepEqual(tool.allowedModes, ['act']);
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.riskLevel, 'high');
});

test('PersistGuidedStepResultTool 阻止未审批或校验失败的写入', async () => {
  let finalizeCalled = false;
  const guidedService = {
    async finalizeStep() {
      finalizeCalled = true;
      return { written: [] };
    },
  };
  const validateTool = {
    async run() {
      return { valid: false, issueCount: 1, issues: [{ severity: 'error', message: '存在重复章节号：2。' }], writePreview: { action: 'none' } };
    },
  };
  const tool = new PersistGuidedStepResultTool(guidedService as never, validateTool as never);
  const context = { agentRunId: 'run1', projectId: 'p1', mode: 'act' as const, approved: true, outputs: {}, policy: {} };

  await assert.rejects(
    () => tool.run({ stepKey: 'guided_chapter', structuredData: { chapters: [{ chapterNo: 2 }, { chapterNo: 2 }] } }, { ...context, approved: false }),
    /需要用户审批/,
  );
  await assert.rejects(
    () => tool.run({ stepKey: 'guided_chapter', structuredData: { chapters: [{ chapterNo: 2 }, { chapterNo: 2 }] } }, context),
    /校验未通过/,
  );
  assert.equal(finalizeCalled, false);
});

test('VCC persist_guided_step_result rejects incomplete guided_volume before service write', async () => {
  let finalizeCalled = false;
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    guidedSession: { async findUnique() { return { stepData: {} }; } },
    volume: { async findMany() { return []; } },
  };
  const validateTool = new ValidateGuidedStepPreviewTool(prisma as never);
  const guidedService = {
    async finalizeStep() {
      finalizeCalled = true;
      return { written: [] };
    },
  };
  const tool = new PersistGuidedStepResultTool(guidedService as never, validateTool);
  const badVolume = createVccGuidedVolume({
    narrativePlan: { ...createVccNarrativePlanForChapterCount(3), foreshadowPlan: undefined },
  });

  await assert.rejects(
    () => tool.run(
      { stepKey: 'guided_volume', structuredData: { volumes: [badVolume] } },
      { agentRunId: 'run-vcc-persist-guided-narrative', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /foreshadowPlan|校验未通过|narrativePlan/,
  );
  assert.equal(finalizeCalled, false);
});

test('GenerateWorldbuildingPreviewTool 归一化 LLM 预览并声明后续校验链路', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          entries: [{ title: '宗门戒律', entryType: 'rule', summary: '不得私斗', content: { rule: '同门不得私斗' }, tags: ['宗门'], priority: 70 }],
          assumptions: ['只做增量补充'],
          risks: ['需校验 locked facts'],
        },
      };
    },
  };
  const tool = new GenerateWorldbuildingPreviewTool(llm as never);
  const result = await tool.run({ instruction: '补充宗门体系，但不要影响已有剧情', maxEntries: 3 }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.equal(result.entries[0].title, '宗门戒律');
  assert.equal(result.entries[0].content, '{"rule":"同门不得私斗"}');
  assert.equal(result.writePlan.requiresValidation, true);
  assert.ok(tool.manifest.examples?.[0].plan.some((step) => step.tool === 'validate_worldbuilding'));
});

test('ValidateWorldbuildingTool 标记 locked facts 冲突并生成写入前 diff', async () => {
  const prisma = {
    lorebookEntry: { async findMany() { return [{ title: '旧宗门', status: 'active' }]; } },
  };
  const tool = new ValidateWorldbuildingTool(prisma as never);
  const result = await tool.run(
    {
      preview: {
        entries: [
          { title: '旧宗门', entryType: 'faction', summary: '重复', content: '补充旧宗门', tags: [], priority: 50, impactAnalysis: '增量', relatedExistingFacts: [], lockedFactHandling: '不覆盖' },
          { title: '新戒律', entryType: 'rule', summary: '新规则', content: '改写禁忌法则，使其不再成立', tags: [], priority: 50, impactAnalysis: '会改写禁忌法则', relatedExistingFacts: ['禁忌法则'], lockedFactHandling: '覆盖禁忌法则' },
        ],
        assumptions: [],
        risks: [],
        writePlan: { mode: 'preview_only', requiresValidation: true, requiresApprovalBeforePersist: true },
      },
      taskContext: { worldFacts: [{ title: '禁忌法则', content: '不可改写', locked: true }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, false);
  assert.equal(result.conflictSummary.lockedFactConflictCount, 1);
  assert.equal(result.writePreview?.summary.skipDuplicateCount, 1);
  assert.ok(result.issues.some((issue) => issue.message.includes('locked fact')));
  assert.deepEqual(result.relatedLockedFacts?.map((fact) => fact.title), ['禁忌法则']);
});

test('PersistWorldbuildingTool 只新增通过校验的新世界观条目并跳过同名设定', async () => {
  const createdData: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        lorebookEntry: {
          async findMany() { return [{ title: '旧宗门' }]; },
          async create(args: { data: Record<string, unknown> }) {
            createdData.push(args.data);
            return { id: 'l-new', title: args.data.title, entryType: args.data.entryType };
          },
        },
      });
    },
  };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const tool = new PersistWorldbuildingTool(prisma as never, cache as never);
  const result = await tool.run(
    {
      preview: {
        entries: [
          { title: '旧宗门', entryType: 'faction', summary: '重复', content: '已有设定', tags: ['宗门'], priority: 50, impactAnalysis: '不覆盖', relatedExistingFacts: [], lockedFactHandling: '跳过同名' },
          { title: '新戒律', entryType: 'rule', summary: '新增规则', content: '同门不得私斗，但允许公开裁决。', tags: ['宗门'], priority: 70, impactAnalysis: '增量补充，不影响既有剧情', relatedExistingFacts: [], lockedFactHandling: '不覆盖 locked facts' },
        ],
        assumptions: [],
        risks: [],
        writePlan: { mode: 'preview_only', requiresValidation: true, requiresApprovalBeforePersist: true },
      },
      validation: { valid: true, issueCount: 0, issues: [], conflictSummary: { lockedFactConflictCount: 0, duplicateTitleCount: 0, writeRequiresApproval: true } },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.createdCount, 1);
  assert.deepEqual(result.skippedTitles, ['旧宗门']);
  assert.equal(createdData[0].sourceType, 'agent_worldbuilding');
  assert.deepEqual(invalidatedProjectIds, ['p1']);
  assert.equal(tool.requiresApproval, true);
  assert.ok(tool.manifest.whenNotToUse.some((item) => item.includes('校验未通过')));
});

test('PersistWorldbuildingTool 支持按用户选择局部写入世界观条目', async () => {
  const createdData: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        lorebookEntry: {
          async findMany() { return [{ title: '旧宗门' }]; },
          async create(args: { data: Record<string, unknown> }) {
            createdData.push(args.data);
            return { id: `l-${createdData.length}`, title: args.data.title, entryType: args.data.entryType };
          },
        },
      });
    },
  };
  const preview = {
    entries: [
      { title: '旧宗门', entryType: 'faction', summary: '重复', content: '已有设定', tags: ['宗门'], priority: 50, impactAnalysis: '不覆盖', relatedExistingFacts: [], lockedFactHandling: '跳过同名' },
      { title: '新戒律', entryType: 'rule', summary: '新增规则', content: '同门不得私斗，但允许公开裁决。', tags: ['宗门'], priority: 70, impactAnalysis: '增量补充，不影响既有剧情', relatedExistingFacts: [], lockedFactHandling: '不覆盖 locked facts' },
      { title: '山门制度', entryType: 'setting', summary: '候选制度', content: '山门制度只作为备选，不在本次写入。', tags: ['宗门'], priority: 40, impactAnalysis: '备选', relatedExistingFacts: [], lockedFactHandling: '不覆盖' },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validation = { valid: true, issueCount: 0, issues: [], conflictSummary: { lockedFactConflictCount: 0, duplicateTitleCount: 0, writeRequiresApproval: true } };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const tool = new PersistWorldbuildingTool(prisma as never, cache as never);

  const result = await tool.run({ preview, validation, selectedTitles: ['旧宗门', '新戒律'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} });

  assert.equal(result.createdCount, 1);
  assert.equal(result.skippedDuplicateCount, 1);
  assert.deepEqual(result.skippedUnselectedTitles, ['山门制度']);
  assert.deepEqual(result.perEntryAudit.map((item) => item.action), ['skipped_duplicate', 'created', 'skipped_unselected']);
  assert.deepEqual(createdData.map((item) => item.title), ['新戒律']);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
  await assert.rejects(
    () => tool.run({ preview, validation, selectedTitles: ['不存在的设定'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
    /不存在于预览中/,
  );
});

test('PersistWorldbuildingTool 阻止未通过校验的世界观预览写入', async () => {
  const cache = { async deleteProjectRecallResults() {} };
  const tool = new PersistWorldbuildingTool({} as never, cache as never);
  await assert.rejects(
    () => tool.run(
      {
        preview: { entries: [{ title: '冲突设定', entryType: 'rule', summary: '冲突', content: '覆盖旧设定', tags: [], priority: 50, impactAnalysis: '覆盖', relatedExistingFacts: [], lockedFactHandling: '覆盖' }], assumptions: [], risks: [], writePlan: { mode: 'preview_only', requiresValidation: true, requiresApprovalBeforePersist: true } },
        validation: { valid: false, issueCount: 1, issues: [{ severity: 'error', message: '冲突' }], conflictSummary: { lockedFactConflictCount: 1, duplicateTitleCount: 0, writeRequiresApproval: true } },
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /校验未通过/,
  );
});

test('GenerateStoryBiblePreviewTool 归一化候选并保持只读', async () => {
  const relatedId = '11111111-1111-4111-8111-111111111111';
  const llm = {
    async chatJson() {
      return {
        data: {
          candidates: [{
            title: 'Sect Oath',
            entryType: 'rule',
            summary: 'No private duels.',
            content: { rule: 'Disputes must be resolved in public trial.' },
            tags: ['sect'],
            relatedEntityIds: [relatedId],
            priority: 75,
          }],
          assumptions: ['planned only'],
          risks: ['needs validation'],
        },
      };
    },
  };
  const tool = new GenerateStoryBiblePreviewTool(llm as never);
  const result = await tool.run(
    { instruction: 'Plan sect rules', focus: ['forbidden_rule'], maxCandidates: 3 },
    { agentRunId: 'run-story', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.candidates[0].title, 'Sect Oath');
  assert.equal(result.candidates[0].entryType, 'forbidden_rule');
  assert.equal(result.candidates[0].content, '{"rule":"Disputes must be resolved in public trial."}');
  assert.deepEqual(result.candidates[0].relatedEntityIds, [relatedId]);
  assert.equal(result.candidates[0].metadata.sourceKind, 'planned_story_bible_asset');
  assert.equal(result.candidates[0].sourceTrace.agentRunId, 'run-story');
  assert.equal(result.writePlan.requiresValidation, true);
  assert.equal(result.writePlan.requiresApprovalBeforePersist, true);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
});

test('ValidateStoryBibleTool 只读校验重复、locked 和跨项目引用', async () => {
  const allowedId = '11111111-1111-4111-8111-111111111111';
  const crossProjectId = '22222222-2222-4222-8222-222222222222';
  const prisma = {
    lorebookEntry: {
      async findMany(args: { where: Record<string, unknown> }) {
        if (Object.prototype.hasOwnProperty.call(args.where, 'id')) return [{ id: allowedId }];
        return [{
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Locked City',
          entryType: 'location',
          summary: 'Existing',
          content: 'Locked existing city.',
          tags: [],
          triggerKeywords: [],
          relatedEntityIds: [],
          priority: 50,
          status: 'locked',
          sourceType: 'manual',
          metadata: { locked: true },
          updatedAt: new Date('2026-05-05T00:00:00Z'),
        }];
      },
    },
    character: { async findMany() { return []; } },
    chapter: { async findMany() { return []; } },
    volume: { async findMany() { return []; } },
    relationshipEdge: { async findMany() { return []; } },
    timelineEvent: { async findMany() { return []; } },
  };
  const tool = new ValidateStoryBibleTool(prisma as never);
  const preview = {
    candidates: [
      {
        candidateId: 'sbc_valid',
        title: 'New Rule',
        entryType: 'forbidden_rule',
        summary: 'No private duels.',
        content: 'Disputes must be resolved in public trial.',
        tags: ['sect'],
        triggerKeywords: ['New Rule'],
        relatedEntityIds: [allowedId],
        priority: 70,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 0, instruction: 'Plan rules', focus: [], contextSources: [] },
      },
      {
        candidateId: 'sbc_locked',
        title: ' locked   city ',
        entryType: 'location',
        summary: 'Try update.',
        content: 'Update locked city.',
        tags: [],
        triggerKeywords: [],
        relatedEntityIds: [],
        priority: 60,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 1, instruction: 'Plan city', focus: [], contextSources: [] },
      },
      {
        candidateId: 'sbc_bad_ref',
        title: 'Bad Reference',
        entryType: 'item',
        summary: 'Bad refs.',
        content: 'References must be real IDs.',
        tags: [],
        triggerKeywords: [],
        relatedEntityIds: ['not-an-id', crossProjectId],
        priority: 50,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 2, instruction: 'Plan item', focus: [], contextSources: [] },
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, target: 'LorebookEntry' as const, sourceKind: 'planned_story_bible_asset' as const, requiresValidation: true, requiresApprovalBeforePersist: true },
  };

  const result = await tool.run({ preview: preview as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.equal(result.valid, false);
  assert.deepEqual(result.accepted.map((item) => item.candidateId), ['sbc_valid']);
  assert.equal(result.writePreview.summary.createCount, 1);
  assert.equal(result.writePreview.summary.rejectCount, 2);
  assert.ok(result.issues.some((issue) => issue.message.includes('locked')));
  assert.ok(result.issues.some((issue) => issue.message.includes('non-UUID')));
  assert.ok(result.issues.some((issue) => issue.message.includes('outside the current project')));
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
});

test('PersistStoryBibleTool 仅在 Act 审批后写入并清理召回缓存', async () => {
  const relatedId = '11111111-1111-4111-8111-111111111111';
  const existingId = '33333333-3333-4333-8333-333333333333';
  const createdData: Array<Record<string, unknown>> = [];
  const updatedData: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        lorebookEntry: {
          async findMany(args: { where: Record<string, unknown> }) {
            if (Object.prototype.hasOwnProperty.call(args.where, 'id')) return [{ id: relatedId }];
            return [{
              id: existingId,
              title: 'Existing Rule',
              entryType: 'forbidden_rule',
              summary: 'Old',
              content: 'Old content',
              tags: [],
              triggerKeywords: [],
              relatedEntityIds: [],
              priority: 50,
              status: 'active',
              sourceType: 'manual',
              metadata: {},
            }];
          },
          async create(args: { data: Record<string, unknown> }) {
            createdData.push(args.data);
            return { id: '44444444-4444-4444-8444-444444444444', title: args.data.title, entryType: args.data.entryType };
          },
          async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
            updatedData.push({ where: args.where, ...args.data });
            return { id: existingId, title: 'Existing Rule', entryType: args.data.entryType };
          },
        },
        character: { async findMany() { return []; } },
        chapter: { async findMany() { return []; } },
        volume: { async findMany() { return []; } },
        relationshipEdge: { async findMany() { return []; } },
        timelineEvent: { async findMany() { return []; } },
      });
    },
  };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const preview = {
    candidates: [
      {
        candidateId: 'sbc_create',
        title: 'New Rule',
        entryType: 'forbidden_rule',
        summary: 'New',
        content: 'New content',
        tags: ['sect'],
        triggerKeywords: ['New Rule'],
        relatedEntityIds: [relatedId],
        priority: 80,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 0, instruction: 'Plan rules', focus: [], contextSources: [] },
      },
      {
        candidateId: 'sbc_update',
        title: 'Existing Rule',
        entryType: 'forbidden_rule',
        summary: 'Updated',
        content: 'Updated content',
        tags: ['sect'],
        triggerKeywords: ['Existing Rule'],
        relatedEntityIds: [],
        priority: 65,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 1, instruction: 'Plan rules', focus: [], contextSources: [] },
      },
      {
        candidateId: 'sbc_skip',
        title: 'Skipped Rule',
        entryType: 'setting',
        summary: 'Skip',
        content: 'Skip content',
        tags: [],
        triggerKeywords: [],
        relatedEntityIds: [],
        priority: 50,
        metadata: { sourceKind: 'planned_story_bible_asset' },
        sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 2, instruction: 'Plan rules', focus: [], contextSources: [] },
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, target: 'LorebookEntry' as const, sourceKind: 'planned_story_bible_asset' as const, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validation = {
    valid: true,
    issueCount: 0,
    issues: [],
    accepted: [
      { candidateId: 'sbc_create', title: 'New Rule', entryType: 'forbidden_rule', action: 'create' as const, existingEntryId: null, sourceTrace: preview.candidates[0].sourceTrace },
      { candidateId: 'sbc_update', title: 'Existing Rule', entryType: 'forbidden_rule', action: 'update' as const, existingEntryId: existingId, sourceTrace: preview.candidates[1].sourceTrace },
    ],
    rejected: [],
    writePreview: {
      target: 'LorebookEntry' as const,
      projectScope: 'context.projectId' as const,
      sourceKind: 'planned_story_bible_asset' as const,
      summary: { createCount: 1, updateCount: 1, rejectCount: 0 },
      entries: [
        { candidateId: 'sbc_create', title: 'New Rule', entryType: 'forbidden_rule', action: 'create' as const, existingEntryId: null, existingStatus: null, before: null, after: {}, fieldDiff: {}, sourceTrace: preview.candidates[0].sourceTrace },
        { candidateId: 'sbc_update', title: 'Existing Rule', entryType: 'forbidden_rule', action: 'update' as const, existingEntryId: existingId, existingStatus: 'active', before: {}, after: {}, fieldDiff: {}, sourceTrace: preview.candidates[1].sourceTrace },
      ],
      approvalMessage: 'ok',
    },
  };
  const tool = new PersistStoryBibleTool(prisma as never, cache as never);

  const result = await tool.run(
    { preview: preview as never, validation: validation as never, selectedCandidateIds: ['sbc_create', 'sbc_update'] },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.skippedUnselectedCount, 1);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
  assert.equal(createdData[0].projectId, 'p1');
  assert.deepEqual(createdData[0].relatedEntityIds, [relatedId]);
  assert.equal((createdData[0].metadata as Record<string, unknown>).sourceKind, 'planned_story_bible_asset');
  assert.deepEqual(updatedData[0].where, { id: existingId });
  assert.equal(tool.requiresApproval, true);
  assert.deepEqual(tool.allowedModes, ['act']);
  assert.deepEqual(tool.sideEffects, ['create_lorebook_entries', 'update_lorebook_entries', 'fact_layer_story_bible_write']);
});

test('PersistStoryBibleTool 阻止 Plan、未审批、无效校验、未知选择和跨项目引用', async () => {
  let transactionCount = 0;
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      transactionCount += 1;
      return callback({
        lorebookEntry: { async findMany() { return []; }, async create() { throw new Error('should not write'); }, async update() { throw new Error('should not write'); } },
        character: { async findMany() { return []; } },
        chapter: { async findMany() { return []; } },
        volume: { async findMany() { return []; } },
        relationshipEdge: { async findMany() { return []; } },
        timelineEvent: { async findMany() { return []; } },
      });
    },
  };
  const cache = { async deleteProjectRecallResults() { throw new Error('should not invalidate'); } };
  const preview = {
    candidates: [{
      candidateId: 'sbc_cross',
      title: 'Cross Ref',
      entryType: 'setting',
      summary: 'Cross',
      content: 'Cross content',
      tags: [],
      triggerKeywords: [],
      relatedEntityIds: ['22222222-2222-4222-8222-222222222222'],
      priority: 50,
      metadata: { sourceKind: 'planned_story_bible_asset' },
      sourceTrace: { sourceKind: 'planned_story_bible_asset', originTool: 'generate_story_bible_preview', agentRunId: 'run1', candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
    }],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, target: 'LorebookEntry' as const, sourceKind: 'planned_story_bible_asset' as const, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validValidation = {
    valid: true,
    issueCount: 0,
    issues: [],
    accepted: [{ candidateId: 'sbc_cross', title: 'Cross Ref', entryType: 'setting', action: 'create' as const, existingEntryId: null, sourceTrace: preview.candidates[0].sourceTrace }],
    rejected: [],
    writePreview: {
      target: 'LorebookEntry' as const,
      projectScope: 'context.projectId' as const,
      sourceKind: 'planned_story_bible_asset' as const,
      summary: { createCount: 1, updateCount: 0, rejectCount: 0 },
      entries: [
        { candidateId: 'sbc_cross', title: 'Cross Ref', entryType: 'setting', action: 'create' as const, existingEntryId: null, existingStatus: null, before: null, after: {}, fieldDiff: {}, sourceTrace: preview.candidates[0].sourceTrace },
      ],
      approvalMessage: 'ok',
    },
  };
  const tool = new PersistStoryBibleTool(prisma as never, cache as never);
  const unacceptedPreview = {
    ...preview,
    candidates: [
      ...preview.candidates,
      {
        ...preview.candidates[0],
        candidateId: 'sbc_unaccepted',
        title: 'Unaccepted Ref',
        relatedEntityIds: [],
        sourceTrace: { ...preview.candidates[0].sourceTrace, candidateIndex: 1 },
      },
    ],
  };
  const mismatchedValidation = {
    ...validValidation,
    accepted: [{ ...validValidation.accepted[0], title: 'Other Title' }],
  };

  await assert.rejects(() => tool.run({ preview: preview as never, validation: validValidation as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: true, outputs: {}, policy: {} }), /act mode/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validValidation as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} }), /approval/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: { ...validValidation, valid: false } as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /did not pass/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validValidation as never, selectedCandidateIds: ['sbc_missing'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /Unknown Story Bible candidateId/);
  await assert.rejects(() => tool.run({ preview: unacceptedPreview as never, validation: validValidation as never, selectedCandidateIds: ['sbc_unaccepted'] }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /does not approve selected candidates/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: mismatchedValidation as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /does not match/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validValidation as never }, { agentRunId: 'run2', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /current agent run/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validValidation as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }), /outside the current project/);
  assert.equal(transactionCount, 1);
});

test('GenerateContinuityPreviewTool normalizes relationship/timeline candidates and stays read-only', async () => {
  const counters = { relationshipCreate: 0, relationshipUpdate: 0, relationshipDelete: 0, timelineCreate: 0, timelineUpdate: 0, timelineDelete: 0 };
  const progress: Array<Record<string, unknown>> = [];
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(_messages: unknown, options: Record<string, unknown>) {
      receivedOptions = options;
      return {
        data: {
          relationships: [{
            characterAId: '11111111-1111-4111-8111-111111111111',
            characterAName: 'Lin',
            characterBId: '22222222-2222-4222-8222-222222222222',
            characterBName: 'Shen',
            relationType: 'ally',
            publicState: 'tense trust',
            turnChapterNos: [3, 3, 4],
          }],
          timeline: [{
            chapterNo: 7,
            title: 'Archive Fire',
            eventTime: 'night',
            participants: ['Lin', 'Shen'],
            knownBy: ['Lin'],
            unknownBy: ['Council'],
          }],
          assumptions: ['preview only'],
          risks: ['needs validation'],
        },
      };
    },
  };
  const tool = new GenerateContinuityPreviewTool(llm as never);

  const result = await tool.run(
    {
      instruction: 'repair continuity',
      focus: ['relationship_graph', 'timeline_events'],
      context: {
        relationshipGraph: [{ id: 'rel-src-1', title: 'Old alliance' }],
        timelineEvents: [{ id: 'evt-src-1', title: 'Old fire' }],
      },
    },
    {
      agentRunId: 'run-cont',
      projectId: 'p1',
      mode: 'plan',
      approved: false,
      outputs: {},
      policy: {},
      async updateProgress(patch: unknown) { progress.push(patch as Record<string, unknown>); },
    },
  );

  assert.equal(result.relationshipCandidates.length, 1);
  assert.equal(result.timelineCandidates.length, 1);
  assert.equal(result.relationshipCandidates[0].action, 'create');
  assert.equal(result.relationshipCandidates[0].candidateId.startsWith('relc_'), true);
  assert.deepEqual(result.relationshipCandidates[0].turnChapterNos, [3, 4]);
  assert.equal(result.relationshipCandidates[0].metadata.sourceKind, 'planned_continuity_change');
  assert.equal(result.relationshipCandidates[0].sourceTrace.agentRunId, 'run-cont');
  assert.equal(result.relationshipCandidates[0].sourceTrace.candidateType, 'relationship');
  assert.equal(result.timelineCandidates[0].candidateId.startsWith('tlc_'), true);
  assert.equal(result.timelineCandidates[0].sourceTrace.candidateType, 'timeline');
  assert.equal(result.timelineCandidates[0].proposedFields.chapterNo, 7);
  assert.equal(result.writePlan.relationshipCandidates.count, 1);
  assert.equal(result.writePlan.timelineCandidates.count, 1);
  assert.equal(result.writePlan.requiresApprovalBeforePersist, true);
  assert.deepEqual(counters, { relationshipCreate: 0, relationshipUpdate: 0, relationshipDelete: 0, timelineCreate: 0, timelineUpdate: 0, timelineDelete: 0 });
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000 + 60_000);
  assert.equal(receivedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(receivedOptions?.retries, 1);
  assert.equal(progress[0].phase, 'calling_llm');
  assert.equal(progress[0].timeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000);
  assert.equal(progress.some((item) => item.phase === 'validating'), true);
});

test('ValidateContinuityChangesTool accepts same-project candidates and rejects cross-project character/chapter mismatches', async () => {
  const charA = '11111111-1111-4111-8111111111111';
  const charB = '22222222-2222-4222-8222222222222';
  const foreignChar = '33333333-3333-4333-8333333333333';
  const chapter1 = '44444444-4444-4444-8444444444444';
  const foreignChapter = '55555555-5555-4555-8555555555555';
  const prisma = {
    relationshipEdge: { async findMany() { return []; } },
    timelineEvent: { async findMany() { return []; } },
    character: {
      async findMany() {
        return [
          { id: charA, name: 'Lin' },
          { id: charB, name: 'Shen' },
        ];
      },
    },
    chapter: {
      async findMany(args: { where: Record<string, unknown> }) {
        if (Object.prototype.hasOwnProperty.call(args.where, 'id')) return [{ id: chapter1, chapterNo: 7 }];
        return [{ id: chapter1, chapterNo: 7 }];
      },
    },
  };
  const tool = new ValidateContinuityChangesTool(prisma as never);
  const preview = {
    relationshipCandidates: [
      {
        candidateId: 'rel_valid',
        action: 'create' as const,
        characterAId: charA,
        characterAName: 'Lin',
        characterBId: charB,
        characterBName: 'Shen',
        relationType: 'ally',
        turnChapterNos: [7],
        impactAnalysis: 'ok',
        conflictRisk: 'low',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { characterAName: 'Lin', characterBName: 'Shen', relationType: 'ally' },
        proposedFields: {},
      },
      {
        candidateId: 'rel_cross',
        action: 'create' as const,
        characterAId: foreignChar,
        characterAName: 'Foreign',
        characterBId: charB,
        characterBName: 'Shen',
        relationType: 'enemy',
        turnChapterNos: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 1, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { characterAName: 'Foreign', characterBName: 'Shen', relationType: 'enemy' },
        proposedFields: {},
      },
      {
        candidateId: 'rel_mismatch',
        action: 'create' as const,
        characterAId: charA,
        characterAName: 'Wrong Name',
        characterBId: charB,
        characterBName: 'Shen',
        relationType: 'mentor',
        turnChapterNos: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 2, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { characterAName: 'Wrong Name', characterBName: 'Shen', relationType: 'mentor' },
        proposedFields: {},
      },
      {
        candidateId: 'rel_project',
        action: 'create' as const,
        projectId: 'p1',
        characterAId: charA,
        characterAName: 'Lin',
        characterBId: charB,
        characterBName: 'Shen',
        relationType: 'rival',
        turnChapterNos: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 3, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { characterAName: 'Lin', characterBName: 'Shen', relationType: 'rival' },
        proposedFields: {},
      },
    ],
    timelineCandidates: [
      {
        candidateId: 'time_valid',
        action: 'create' as const,
        chapterId: chapter1,
        chapterNo: 7,
        title: 'Archive Fire',
        participants: ['Lin'],
        participantIds: [charA],
        knownBy: ['Lin'],
        knownByIds: [charA],
        unknownBy: ['Shen'],
        unknownByIds: [charB],
        impactAnalysis: 'ok',
        conflictRisk: 'low',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { chapterNo: 7, title: 'Archive Fire', existingTimelineEventId: undefined, eventTime: undefined },
        proposedFields: {},
      },
      {
        candidateId: 'time_mismatch',
        action: 'create' as const,
        chapterId: chapter1,
        chapterNo: 8,
        title: 'Bad Chapter No',
        participants: ['Lin'],
        knownBy: [],
        unknownBy: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 1, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { chapterNo: 8, title: 'Bad Chapter No', existingTimelineEventId: undefined, eventTime: undefined },
        proposedFields: {},
      },
      {
        candidateId: 'time_cross',
        action: 'create' as const,
        chapterId: foreignChapter,
        chapterNo: 9,
        title: 'Foreign Chapter',
        participants: ['Lin'],
        knownBy: [],
        unknownBy: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 2, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { chapterNo: 9, title: 'Foreign Chapter', existingTimelineEventId: undefined, eventTime: undefined },
        proposedFields: {},
      },
      {
        candidateId: 'time_id_name_mismatch',
        action: 'create' as const,
        chapterId: chapter1,
        chapterNo: 7,
        title: 'Wrong Participant Name',
        participants: ['Shen'],
        participantIds: [charA],
        knownBy: [],
        unknownBy: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 3, instruction: 'Plan', focus: [], contextSources: [] },
        diffKey: { chapterNo: 7, title: 'Wrong Participant Name', existingTimelineEventId: undefined, eventTime: undefined },
        proposedFields: {},
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, sourceKind: 'planned_continuity_change' as const, targets: ['RelationshipEdge', 'TimelineEvent'] as ['RelationshipEdge', 'TimelineEvent'], relationshipCandidates: { target: 'RelationshipEdge' as const, count: 4, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, timelineCandidates: { target: 'TimelineEvent' as const, count: 4, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, requiresValidation: true, requiresApprovalBeforePersist: true },
  };

  const result = await tool.run({ preview: preview as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.equal(result.valid, false);
  assert.deepEqual(result.accepted.relationshipCandidates.map((item) => item.candidateId), ['rel_valid']);
  assert.deepEqual(result.accepted.timelineCandidates.map((item) => item.candidateId), ['time_valid']);
  assert.equal(result.writePreview.relationshipCandidates.summary.createCount, 1);
  assert.equal(result.writePreview.relationshipCandidates.summary.rejectCount, 3);
  assert.equal(result.writePreview.timelineCandidates.summary.createCount, 1);
  assert.equal(result.writePreview.timelineCandidates.summary.rejectCount, 3);
  assert.ok(result.issues.some((issue) => issue.message.includes('characterAId does not belong to current project')));
  assert.ok(result.issues.some((issue) => issue.message.includes('characterAId/name mismatch')));
  assert.ok(result.issues.some((issue) => issue.message.includes('must not include projectId')));
  assert.ok(result.issues.some((issue) => issue.message.includes('chapterNo does not match chapterId')));
  assert.ok(result.issues.some((issue) => issue.message.includes('chapterId does not belong to current project')));
  assert.ok(result.issues.some((issue) => issue.message.includes('participantIds/participants mismatch')));
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
});

test('ValidateContinuityChangesTool compares duplicate keys against existing rows and rejects relationship id without name', async () => {
  const charA = '11111111-1111-4111-8111111111111';
  const charB = '22222222-2222-4222-8222222222222';
  const charC = '33333333-3333-4333-8333333333333';
  const charD = '44444444-4444-4444-8444444444444';
  const relId = '55555555-5555-4555-8555555555555';
  const chapter1 = '66666666-6666-4666-8666666666666';
  const timeId = '77777777-7777-4777-8777777777777';
  const prisma = {
    relationshipEdge: {
      async findMany() {
        return [{
          id: relId,
          characterAId: charC,
          characterBId: charD,
          characterAName: 'Mo',
          characterBName: 'Ye',
          relationType: 'rival',
          publicState: null,
          hiddenState: null,
          conflictPoint: null,
          emotionalArc: null,
          turnChapterNos: [],
          finalState: null,
          status: 'active',
          sourceType: 'manual',
          metadata: {},
        }];
      },
    },
    timelineEvent: {
      async findMany() {
        return [{
          id: timeId,
          chapterId: chapter1,
          chapterNo: 7,
          title: 'Old Fire',
          eventTime: null,
          locationName: null,
          participants: [],
          cause: null,
          result: null,
          impactScope: null,
          isPublic: false,
          knownBy: [],
          unknownBy: [],
          eventStatus: 'planned',
          sourceType: 'manual',
          metadata: {},
        }];
      },
    },
    character: {
      async findMany() {
        return [
          { id: charA, name: 'Lin' },
          { id: charB, name: 'Shen' },
          { id: charC, name: 'Mo' },
          { id: charD, name: 'Ye' },
        ];
      },
    },
    chapter: {
      async findMany() {
        return [{ id: chapter1, chapterNo: 7 }];
      },
    },
  };
  const tool = new ValidateContinuityChangesTool(prisma as never);
  const trace = (candidateType: 'relationship' | 'timeline', candidateIndex: number) => ({
    sourceKind: 'planned_continuity_change' as const,
    originTool: 'generate_continuity_preview' as const,
    agentRunId: 'run1',
    candidateType,
    candidateIndex,
    instruction: 'Plan',
    focus: [],
    contextSources: [],
  });
  const preview = {
    relationshipCandidates: [
      {
        candidateId: 'rel_create_ok',
        action: 'create' as const,
        characterAId: charA,
        characterAName: 'Lin',
        characterBId: charB,
        characterBName: 'Shen',
        relationType: 'ally',
        turnChapterNos: [],
        impactAnalysis: 'ok',
        conflictRisk: 'low',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: trace('relationship', 0),
        diffKey: { characterAName: 'Lin', characterBName: 'Shen', relationType: 'ally' },
        proposedFields: {},
      },
      {
        candidateId: 'rel_duplicate',
        action: 'create' as const,
        characterAId: charC,
        characterAName: 'Mo',
        characterBId: charD,
        characterBName: 'Ye',
        relationType: 'rival',
        turnChapterNos: [],
        impactAnalysis: 'duplicate',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: trace('relationship', 1),
        diffKey: { characterAName: 'Mo', characterBName: 'Ye', relationType: 'rival' },
        proposedFields: {},
      },
      {
        candidateId: 'rel_update_missing_name',
        action: 'update' as const,
        existingRelationshipId: relId,
        characterAId: charA,
        turnChapterNos: [],
        impactAnalysis: 'bad',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: trace('relationship', 2),
        diffKey: { existingRelationshipId: relId },
        proposedFields: {},
      },
    ],
    timelineCandidates: [
      {
        candidateId: 'time_create_ok',
        action: 'create' as const,
        chapterNo: 7,
        title: 'Archive Fire',
        participants: [],
        knownBy: [],
        unknownBy: [],
        impactAnalysis: 'ok',
        conflictRisk: 'low',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: trace('timeline', 0),
        diffKey: { chapterNo: 7, title: 'Archive Fire' },
        proposedFields: {},
      },
      {
        candidateId: 'time_duplicate',
        action: 'create' as const,
        chapterNo: 7,
        title: 'Old Fire',
        participants: [],
        knownBy: [],
        unknownBy: [],
        impactAnalysis: 'duplicate',
        conflictRisk: 'high',
        metadata: { sourceKind: 'planned_continuity_change' as const },
        sourceTrace: trace('timeline', 1),
        diffKey: { chapterNo: 7, title: 'Old Fire' },
        proposedFields: {},
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, sourceKind: 'planned_continuity_change' as const, targets: ['RelationshipEdge', 'TimelineEvent'] as ['RelationshipEdge', 'TimelineEvent'], relationshipCandidates: { target: 'RelationshipEdge' as const, count: 3, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, timelineCandidates: { target: 'TimelineEvent' as const, count: 2, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, requiresValidation: true, requiresApprovalBeforePersist: true },
  };

  const result = await tool.run({ preview: preview as never }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.deepEqual(result.accepted.relationshipCandidates.map((item) => item.candidateId), ['rel_create_ok']);
  assert.deepEqual(result.accepted.timelineCandidates.map((item) => item.candidateId), ['time_create_ok']);
  assert.ok(result.issues.some((issue) => issue.candidateId === 'rel_duplicate' && issue.message.includes(relId)));
  assert.ok(result.issues.some((issue) => issue.candidateId === 'rel_update_missing_name' && issue.message.includes('requires matching characterAName')));
  assert.ok(result.issues.some((issue) => issue.candidateId === 'time_duplicate' && issue.message.includes(timeId)));
});

test('Read-only preview validate and analysis tools never call Prisma write methods', async () => {
  const writeCalls: string[] = [];
  const writeMethods = new Set(['create', 'update', 'delete', 'upsert', 'updateMany', 'deleteMany', 'createMany']);
  const readDefaults: Record<string, unknown> = {
    findMany: [],
    findUnique: null,
    findFirst: null,
    count: 0,
  };
  const prisma = new Proxy({}, {
    get(_target, model: string | symbol) {
      const modelName = String(model);
      if (modelName === '$transaction') {
        return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
      }
      const overrides: Record<string, Record<string, unknown>> = {
        project: { findUnique: { id: 'p1', title: 'Read Only Project', genre: null, theme: null, tone: null, synopsis: null, outline: null } },
        volume: { findMany: [], findFirst: { id: 'v1', volumeNo: 1, title: 'Volume One', objective: null } },
        chapter: { findMany: [], findFirst: { id: 'c1', volumeId: 'v1', chapterNo: 1, title: 'Chapter One', objective: null } },
        chapterPattern: { findMany: [] },
        pacingBeat: { findMany: [] },
        sceneCard: { findMany: [] },
        lorebookEntry: { findMany: [] },
        character: { findMany: [] },
        relationshipEdge: { findMany: [] },
        timelineEvent: { findMany: [] },
        memoryChunk: { findMany: [] },
        validationIssue: { findMany: [] },
        characterStateSnapshot: { findMany: [] },
        storyEvent: { findMany: [] },
      };
      return new Proxy({}, {
        get(_modelTarget, method: string | symbol) {
          const methodName = String(method);
          if (writeMethods.has(methodName)) {
            return async () => {
              writeCalls.push(`${modelName}.${methodName}`);
              throw new Error(`Unexpected write: ${modelName}.${methodName}`);
            };
          }
          if (Object.prototype.hasOwnProperty.call(overrides[modelName] ?? {}, methodName)) {
            return async () => overrides[modelName][methodName];
          }
          if (Object.prototype.hasOwnProperty.call(readDefaults, methodName)) {
            return async () => readDefaults[methodName];
          }
          return undefined;
        },
      });
    },
  });
  const llm = {
    async chatJson(_messages: unknown, options: Record<string, unknown>) {
      if (options.appStep === 'planner') {
        return { data: { candidates: [{ title: 'Archive Rule', entryType: 'world_rule', summary: 'Rule', content: 'Rule content', tags: ['rule'], triggerKeywords: ['archive'] }] } };
      }
      return { data: { relationshipCandidates: [], timelineCandidates: [] } };
    },
  };
  const context = { agentRunId: 'run-readonly', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const storyPreviewTool = new GenerateStoryBiblePreviewTool(llm as never);
  const storyValidationTool = new ValidateStoryBibleTool(prisma as never);
  const continuityPreviewTool = new GenerateContinuityPreviewTool(llm as never);
  const continuityValidationTool = new ValidateContinuityChangesTool(prisma as never);
  const collectTool = new CollectTaskContextTool(prisma as never);
  const inspectTool = new InspectProjectContextTool(prisma as never);
  const guidedPreviewTool = new GenerateGuidedStepPreviewTool(llm as never, prisma as never);
  const craftBriefPreviewTool = new GenerateChapterCraftBriefPreviewTool(llm as never, prisma as never);
  const craftBriefValidationTool = new ValidateChapterCraftBriefTool(prisma as never);

  const storyPreview = await storyPreviewTool.run({ instruction: 'Plan archive rules.' }, context);
  await storyValidationTool.run({ preview: storyPreview }, context);
  const continuityPreview = await continuityPreviewTool.run({ instruction: 'Check continuity.' }, context);
  await continuityValidationTool.run({ preview: continuityPreview }, context);
  await collectTool.run({ taskType: 'general' }, context);
  await inspectTool.run({}, context);
  await guidedPreviewTool.run({ stepKey: 'guided_chapter', volumeNo: 1, chapterNo: 1, projectContext: { seed: true } }, context);

  assert.deepEqual(writeCalls, []);
  for (const tool of [storyPreviewTool, storyValidationTool, continuityPreviewTool, continuityValidationTool, collectTool, inspectTool, guidedPreviewTool, craftBriefPreviewTool, craftBriefValidationTool]) {
    assert.equal(tool.requiresApproval, false);
    assert.deepEqual(tool.sideEffects, []);
  }
  assert.equal(new PersistStoryBibleTool(prisma as never, { async deleteProjectRecallResults() {} } as never).requiresApproval, true);
  assert.equal(new PersistContinuityChangesTool(prisma as never, { async deleteProjectRecallResults() {} } as never).requiresApproval, true);
  assert.equal(new PersistChapterCraftBriefTool(prisma as never, { async deleteChapterContext() {}, async deleteProjectRecallResults() {} } as never).requiresApproval, true);
});

test('PersistContinuityChangesTool rejects plan/unapproved/invalid/unknown selection/sourceTrace mismatch', async () => {
  let transactionCount = 0;
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      transactionCount += 1;
      return callback({
        relationshipEdge: { async findMany() { return []; }, async create() { throw new Error('should not write'); }, async update() { throw new Error('should not write'); }, async delete() { throw new Error('should not write'); } },
        timelineEvent: { async findMany() { return []; }, async create() { throw new Error('should not write'); }, async update() { throw new Error('should not write'); }, async delete() { throw new Error('should not write'); } },
        character: { async findMany() { return []; } },
        chapter: { async findMany() { return []; } },
      });
    },
  };
  const cache = { async deleteProjectRecallResults() { throw new Error('should not invalidate'); } };
  const preview = {
    relationshipCandidates: [{
      candidateId: 'relc_1',
      action: 'create' as const,
      characterAName: 'Lin',
      characterBName: 'Shen',
      relationType: 'ally',
      turnChapterNos: [],
      impactAnalysis: 'ok',
      conflictRisk: 'low',
      metadata: { sourceKind: 'planned_continuity_change' as const },
      sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
      diffKey: { characterAName: 'Lin', characterBName: 'Shen', relationType: 'ally' },
      proposedFields: {},
    }],
    timelineCandidates: [],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, sourceKind: 'planned_continuity_change' as const, targets: ['RelationshipEdge', 'TimelineEvent'] as ['RelationshipEdge', 'TimelineEvent'], relationshipCandidates: { target: 'RelationshipEdge' as const, count: 1, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, timelineCandidates: { target: 'TimelineEvent' as const, count: 0, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validation = {
    valid: true,
    issueCount: 0,
    issues: [],
    accepted: { relationshipCandidates: [{ candidateId: 'relc_1', action: 'create' as const, existingId: null, label: 'Lin -> Shen (ally)', sourceTrace: preview.relationshipCandidates[0].sourceTrace }], timelineCandidates: [] },
    rejected: { relationshipCandidates: [], timelineCandidates: [] },
    writePreview: {
      projectScope: 'context.projectId' as const,
      sourceKind: 'planned_continuity_change' as const,
      relationshipCandidates: { target: 'RelationshipEdge' as const, summary: { createCount: 1, updateCount: 0, deleteCount: 0, rejectCount: 0 }, entries: [{ candidateId: 'relc_1', action: 'create' as const, existingId: null, label: 'Lin -> Shen (ally)', before: null, after: { relationType: 'ally' }, fieldDiff: { relationType: true }, sourceTrace: preview.relationshipCandidates[0].sourceTrace }] },
      timelineCandidates: { target: 'TimelineEvent' as const, summary: { createCount: 0, updateCount: 0, deleteCount: 0, rejectCount: 0 }, entries: [] },
      approvalMessage: 'ok',
    },
  };
  const tool = new PersistContinuityChangesTool(prisma as never, cache as never);
  const mismatchedPreview = { ...preview, relationshipCandidates: [{ ...preview.relationshipCandidates[0], sourceTrace: { ...preview.relationshipCandidates[0].sourceTrace, agentRunId: 'run-other' } }] };
  const contextFor = (previewOutput: unknown = preview, validationOutput: unknown = validation, overrides: Record<string, unknown> = {}) => ({
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: { 2: previewOutput, 3: validationOutput },
    stepTools: { 2: 'generate_continuity_preview', 3: 'validate_continuity_changes' },
    policy: {},
    ...overrides,
  });

  await assert.rejects(() => tool.run({ preview: preview as never, validation: validation as never }, contextFor(preview, validation, { mode: 'plan' }) as never), /act mode/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validation as never }, contextFor(preview, validation, { approved: false }) as never), /explicit user approval/);
  const invalidValidation = { ...validation, valid: false };
  await assert.rejects(() => tool.run({ preview: preview as never, validation: invalidValidation as never }, contextFor(preview, invalidValidation) as never), /did not pass/);
  await assert.rejects(() => tool.run({ preview: preview as never, validation: validation as never, selectedCandidateIds: ['missing_candidate'] }, contextFor() as never), /Unknown continuity candidate selection/);
  await assert.rejects(() => tool.run({ preview: JSON.parse(JSON.stringify(preview)) as never, validation: JSON.parse(JSON.stringify(validation)) as never }, contextFor() as never), /must reference previous generate_continuity_preview output/);
  await assert.rejects(() => tool.run({ preview: mismatchedPreview as never, validation: validation as never }, contextFor(mismatchedPreview, validation) as never), /sourceTrace\.agentRunId does not match current agent run/);
  assert.equal(transactionCount, 0);
});

test('PersistContinuityChangesTool writes selected relationship/timeline candidates, invalidates cache, and supports dryRun', async () => {
  const charA = '11111111-1111-4111-8111111111111';
  const charB = '22222222-2222-4222-8222222222222';
  const chapter1 = '44444444-4444-4444-8444444444444';
  const createdRelationships: Array<Record<string, unknown>> = [];
  const createdTimeline: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const txFactory = () => ({
    relationshipEdge: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdRelationships.push(args.data);
        return { id: 'rel-created-1' };
      },
      async update() { throw new Error('should not update'); },
      async delete() { throw new Error('should not delete'); },
    },
    timelineEvent: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdTimeline.push(args.data);
        return { id: 'time-created-1' };
      },
      async update() { throw new Error('should not update'); },
      async delete() { throw new Error('should not delete'); },
    },
    character: {
      async findMany() {
        return [
          { id: charA, name: 'Lin' },
          { id: charB, name: 'Shen' },
        ];
      },
    },
    chapter: {
      async findMany() {
        return [{ id: chapter1, chapterNo: 7 }];
      },
    },
  });
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(txFactory());
    },
  };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const preview = {
    relationshipCandidates: [{
      candidateId: 'relc_create',
      action: 'create' as const,
      characterAId: charA,
      characterAName: 'Lin',
      characterBId: charB,
      characterBName: 'Shen',
      relationType: 'ally',
      publicState: 'fragile',
      turnChapterNos: [7],
      impactAnalysis: 'ok',
      conflictRisk: 'low',
      metadata: { sourceKind: 'planned_continuity_change' as const },
      sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
      diffKey: { characterAName: 'Lin', characterBName: 'Shen', relationType: 'ally' },
      proposedFields: {},
    }],
    timelineCandidates: [{
      candidateId: 'tlc_create',
      action: 'create' as const,
      chapterId: chapter1,
      chapterNo: 7,
      title: 'Archive Fire',
      eventTime: 'night',
      participants: ['Lin', 'Shen'],
      participantIds: [charA, charB],
      knownBy: ['Lin'],
      knownByIds: [charA],
      unknownBy: ['Council'],
      impactAnalysis: 'ok',
      conflictRisk: 'low',
      metadata: { sourceKind: 'planned_continuity_change' as const },
      sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
      diffKey: { chapterNo: 7, title: 'Archive Fire', existingTimelineEventId: undefined, eventTime: 'night' },
      proposedFields: {},
    }],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, sourceKind: 'planned_continuity_change' as const, targets: ['RelationshipEdge', 'TimelineEvent'] as ['RelationshipEdge', 'TimelineEvent'], relationshipCandidates: { target: 'RelationshipEdge' as const, count: 1, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, timelineCandidates: { target: 'TimelineEvent' as const, count: 1, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validation = {
    valid: true,
    issueCount: 0,
    issues: [],
    accepted: {
      relationshipCandidates: [{ candidateId: 'relc_create', action: 'create' as const, existingId: null, label: 'Lin -> Shen (ally)', sourceTrace: preview.relationshipCandidates[0].sourceTrace }],
      timelineCandidates: [{ candidateId: 'tlc_create', action: 'create' as const, existingId: null, label: 'Archive Fire', sourceTrace: preview.timelineCandidates[0].sourceTrace }],
    },
    rejected: { relationshipCandidates: [], timelineCandidates: [] },
    writePreview: {
      projectScope: 'context.projectId' as const,
      sourceKind: 'planned_continuity_change' as const,
      relationshipCandidates: { target: 'RelationshipEdge' as const, summary: { createCount: 1, updateCount: 0, deleteCount: 0, rejectCount: 0 }, entries: [{ candidateId: 'relc_create', action: 'create' as const, existingId: null, label: 'Lin -> Shen (ally)', before: null, after: { relationType: 'ally' }, fieldDiff: { relationType: true }, sourceTrace: preview.relationshipCandidates[0].sourceTrace }] },
      timelineCandidates: { target: 'TimelineEvent' as const, summary: { createCount: 1, updateCount: 0, deleteCount: 0, rejectCount: 0 }, entries: [{ candidateId: 'tlc_create', action: 'create' as const, existingId: null, label: 'Archive Fire', before: null, after: { title: 'Archive Fire' }, fieldDiff: { title: true }, sourceTrace: preview.timelineCandidates[0].sourceTrace }] },
      approvalMessage: 'ok',
    },
  };
  const tool = new PersistContinuityChangesTool(prisma as never, cache as never);
  const progress: Array<Record<string, unknown>> = [];
  const contextFor = (previewOutput: unknown = preview, validationOutput: unknown = validation) => ({
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: { 2: previewOutput, 3: validationOutput },
    stepTools: { 2: 'generate_continuity_preview', 3: 'validate_continuity_changes' },
    policy: {},
    async updateProgress(patch: unknown) { progress.push(patch as Record<string, unknown>); },
    async heartbeat(patch?: unknown) { if (patch) progress.push(patch as Record<string, unknown>); },
  });

  const persisted = await tool.run(
    { preview: preview as never, validation: validation as never, selectedCandidateIds: ['relc_create', 'tlc_create'] },
    contextFor() as never,
  );

  assert.equal(persisted.dryRun, false);
  assert.equal(persisted.relationshipResults.createdCount, 1);
  assert.equal(persisted.timelineResults.createdCount, 1);
  assert.equal(createdRelationships[0].projectId, 'p1');
  assert.equal(createdRelationships[0].sourceType, 'agent_continuity');
  assert.equal((createdRelationships[0].metadata as Record<string, unknown>).agentRunId, 'run1');
  assert.equal(createdTimeline[0].projectId, 'p1');
  assert.equal(createdTimeline[0].chapterId, chapter1);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
  assert.equal(progress.some((item) => item.phase === 'validating' && item.timeoutMs === 60_000), true);
  assert.equal(progress.some((item) => item.phase === 'persisting' && item.timeoutMs === 120_000), true);
  assert.equal(progress.some((item) => item.phase === 'persisting' && item.progressCurrent === 2), true);

  createdRelationships.length = 0;
  createdTimeline.length = 0;
  invalidatedProjectIds.length = 0;

  const dryRun = await tool.run(
    { preview: preview as never, validation: validation as never, dryRun: true },
    contextFor() as never,
  );

  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.persistedAt, null);
  assert.equal(dryRun.relationshipResults.createdCount, 0);
  assert.equal(dryRun.timelineResults.createdCount, 0);
  assert.equal(createdRelationships.length, 0);
  assert.equal(createdTimeline.length, 0);
  assert.deepEqual(invalidatedProjectIds, []);

  const mismatchedTimelinePreview = {
    ...preview,
    timelineCandidates: [{ ...preview.timelineCandidates[0], participants: ['Wrong Name'], participantIds: [charA] }],
  };
  const mismatchedTimelineValidation = {
    ...validation,
    accepted: {
      relationshipCandidates: validation.accepted.relationshipCandidates,
      timelineCandidates: [{ ...validation.accepted.timelineCandidates[0], sourceTrace: mismatchedTimelinePreview.timelineCandidates[0].sourceTrace }],
    },
    writePreview: {
      ...validation.writePreview,
      timelineCandidates: {
        ...validation.writePreview.timelineCandidates,
        entries: [{ ...validation.writePreview.timelineCandidates.entries[0], sourceTrace: mismatchedTimelinePreview.timelineCandidates[0].sourceTrace }],
      },
    },
  };
  await assert.rejects(
    () => tool.run({ preview: mismatchedTimelinePreview as never, validation: mismatchedTimelineValidation as never, selectedTimelineCandidateIds: ['tlc_create'] }, contextFor(mismatchedTimelinePreview, mismatchedTimelineValidation) as never),
    /participantIds\/participants mismatch/,
  );
});

test('ProjectsService 读取默认创作定位并 upsert 保存配置', async () => {
  const upserts: Array<Record<string, unknown>> = [];
  let findUniqueCount = 0;
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    projectCreativeProfile: {
      async findUnique() {
        findUniqueCount += 1;
        return null;
      },
      async upsert(args: Record<string, unknown>) {
        upserts.push(args);
        return { id: 'profile1', projectId: 'p1', ...((args.update as Record<string, unknown>) ?? (args.create as Record<string, unknown>)) };
      },
    },
  };
  const service = new ProjectsService(prisma as never, {} as never);

  const created = await service.getCreativeProfile('p1');
  const updated = await service.updateCreativeProfile('p1', {
    audienceType: '男频长篇读者',
    platformTarget: 'Web',
    sellingPoints: ['升级', '悬疑'],
    targetWordCount: 1_200_000,
    centralConflict: { protagonistGoal: '破局' },
  });

  assert.equal(created.projectId, 'p1');
  assert.equal(created.audienceType, null);
  assert.equal(findUniqueCount, 1);
  assert.equal(upserts.length, 1);
  assert.equal(updated.audienceType, '男频长篇读者');
  assert.deepEqual((upserts[0].update as Record<string, unknown>).sellingPoints, ['升级', '悬疑']);
  assert.deepEqual((upserts[0].update as Record<string, unknown>).centralConflict, { protagonistGoal: '破局' });
});

test('PersistContinuityChangesTool scopes relationship update and timeline delete mutations by projectId', async () => {
  const charA = '11111111-1111-4111-8111111111111';
  const charB = '22222222-2222-4222-8222222222222';
  const relId = '66666666-6666-4666-8666666666666';
  const timeId = '77777777-7777-4777-8777777777777';
  const updateWhere: Array<Record<string, unknown>> = [];
  const deleteWhere: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const existingRelationship = {
    id: relId,
    characterAId: charA,
    characterBId: charB,
    characterAName: 'Lin',
    characterBName: 'Shen',
    relationType: 'ally',
    publicState: null,
    hiddenState: null,
    conflictPoint: null,
    emotionalArc: null,
    turnChapterNos: [],
    finalState: null,
    status: 'active',
    sourceType: 'manual',
    metadata: {},
  };
  const existingTimeline = {
    id: timeId,
    chapterId: null,
    chapterNo: 7,
    title: 'Old Fire',
    eventTime: null,
    locationName: null,
    participants: ['Lin'],
    cause: null,
    result: null,
    impactScope: null,
    isPublic: false,
    knownBy: [],
    unknownBy: [],
    eventStatus: 'planned',
    sourceType: 'manual',
    metadata: {},
  };
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        relationshipEdge: {
          async findMany() { return [existingRelationship]; },
          async create() { throw new Error('should not create relationship'); },
          async updateMany(args: { where: Record<string, unknown> }) { updateWhere.push(args.where); return { count: 1 }; },
          async deleteMany() { throw new Error('should not delete relationship'); },
        },
        timelineEvent: {
          async findMany() { return [existingTimeline]; },
          async create() { throw new Error('should not create timeline'); },
          async updateMany() { throw new Error('should not update timeline'); },
          async deleteMany(args: { where: Record<string, unknown> }) { deleteWhere.push(args.where); return { count: 1 }; },
        },
        character: {
          async findMany() {
            return [
              { id: charA, name: 'Lin' },
              { id: charB, name: 'Shen' },
            ];
          },
        },
        chapter: { async findMany() { return []; } },
      });
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const preview = {
    relationshipCandidates: [{
      candidateId: 'relc_update',
      action: 'update' as const,
      existingRelationshipId: relId,
      characterAId: charA,
      characterAName: 'Lin',
      characterBId: charB,
      characterBName: 'Shen',
      relationType: 'enemy',
      turnChapterNos: [],
      impactAnalysis: 'ok',
      conflictRisk: 'low',
      metadata: { sourceKind: 'planned_continuity_change' as const },
      sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'relationship' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
      diffKey: { existingRelationshipId: relId },
      proposedFields: {},
    }],
    timelineCandidates: [{
      candidateId: 'tlc_delete',
      action: 'delete' as const,
      existingTimelineEventId: timeId,
      participants: [],
      knownBy: [],
      unknownBy: [],
      impactAnalysis: 'ok',
      conflictRisk: 'low',
      metadata: { sourceKind: 'planned_continuity_change' as const },
      sourceTrace: { sourceKind: 'planned_continuity_change' as const, originTool: 'generate_continuity_preview' as const, agentRunId: 'run1', candidateType: 'timeline' as const, candidateIndex: 0, instruction: 'Plan', focus: [], contextSources: [] },
      diffKey: { existingTimelineEventId: timeId },
      proposedFields: {},
    }],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, sourceKind: 'planned_continuity_change' as const, targets: ['RelationshipEdge', 'TimelineEvent'] as ['RelationshipEdge', 'TimelineEvent'], relationshipCandidates: { target: 'RelationshipEdge' as const, count: 1, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, timelineCandidates: { target: 'TimelineEvent' as const, count: 1, allowedActions: ['create', 'update', 'delete'] as Array<'create' | 'update' | 'delete'> }, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
  const validation = {
    valid: true,
    issueCount: 0,
    issues: [],
    accepted: {
      relationshipCandidates: [{ candidateId: 'relc_update', action: 'update' as const, existingId: relId, label: 'Lin -> Shen (enemy)', sourceTrace: preview.relationshipCandidates[0].sourceTrace }],
      timelineCandidates: [{ candidateId: 'tlc_delete', action: 'delete' as const, existingId: timeId, label: 'Old Fire', sourceTrace: preview.timelineCandidates[0].sourceTrace }],
    },
    rejected: { relationshipCandidates: [], timelineCandidates: [] },
    writePreview: {
      projectScope: 'context.projectId' as const,
      sourceKind: 'planned_continuity_change' as const,
      relationshipCandidates: { target: 'RelationshipEdge' as const, summary: { createCount: 0, updateCount: 1, deleteCount: 0, rejectCount: 0 }, entries: [{ candidateId: 'relc_update', action: 'update' as const, existingId: relId, label: 'Lin -> Shen (enemy)', before: {}, after: { relationType: 'enemy' }, fieldDiff: { relationType: true }, sourceTrace: preview.relationshipCandidates[0].sourceTrace }] },
      timelineCandidates: { target: 'TimelineEvent' as const, summary: { createCount: 0, updateCount: 0, deleteCount: 1, rejectCount: 0 }, entries: [{ candidateId: 'tlc_delete', action: 'delete' as const, existingId: timeId, label: 'Old Fire', before: {}, after: null, fieldDiff: {}, sourceTrace: preview.timelineCandidates[0].sourceTrace }] },
      approvalMessage: 'ok',
    },
  };
  const tool = new PersistContinuityChangesTool(prisma as never, cache as never);

  const result = await tool.run(
    { preview: preview as never, validation: validation as never },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: { 2: preview, 3: validation }, stepTools: { 2: 'generate_continuity_preview', 3: 'validate_continuity_changes' }, policy: {} },
  );

  assert.deepEqual(updateWhere, [{ id: relId, projectId: 'p1' }]);
  assert.deepEqual(deleteWhere, [{ id: timeId, projectId: 'p1' }]);
  assert.equal(result.relationshipResults.updatedCount, 1);
  assert.equal(result.timelineResults.deletedCount, 1);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
});

test('GenerationProfileService reads defaults and upserts project generation strategy with cache invalidation', async () => {
  const upserts: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    generationProfile: {
      async findUnique() {
        return null;
      },
      async upsert(args: Record<string, unknown>) {
        upserts.push(args);
        return { id: 'gp1', projectId: 'p1', ...(args.create as Record<string, unknown>), ...(args.update as Record<string, unknown>) };
      },
    },
  };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const service = new GenerationProfileService(prisma as never, cache as never);

  const defaults = await service.get('p1');
  const updated = await service.update('p1', {
    defaultChapterWordCount: 2600,
    allowNewCharacters: false,
    allowNewLocations: false,
    preGenerationChecks: ['blockNewEntities'],
    promptBudget: { lorebook: 6 },
  });

  assert.equal(defaults.projectId, 'p1');
  assert.equal(defaults.autoSummarize, true);
  assert.equal(defaults.allowNewCharacters, false);
  assert.equal(updated.defaultChapterWordCount, 2600);
  assert.deepEqual((upserts[0].create as Record<string, unknown>).preGenerationChecks, ['blockNewEntities']);
  assert.deepEqual((upserts[0].update as Record<string, unknown>).promptBudget, { lorebook: 6 });
  assert.deepEqual(invalidatedProjectIds, ['p1']);

  await assert.rejects(() => service.update('p1', { metadata: null } as never), /metadata must be a JSON object/);
  await assert.rejects(() => service.update('p1', { promptBudget: null } as never), /promptBudget must be a JSON object/);
  await assert.rejects(() => service.update('p1', { preGenerationChecks: ['blockNewEntities', 7] } as never), /preGenerationChecks must contain only strings/);

  const invalidDto = plainToInstance(UpdateGenerationProfileDto, {
    preGenerationChecks: ['blockNewEntities', 7],
    promptBudget: null,
    metadata: null,
  });
  const dtoErrors = await validate(invalidDto, { whitelist: true });
  assert.equal(dtoErrors.some((error) => error.property === 'preGenerationChecks'), true);
  assert.equal(dtoErrors.some((error) => error.property === 'promptBudget'), true);
  assert.equal(dtoErrors.some((error) => error.property === 'metadata'), true);
});

test('LorebookService update/delete 写入后清理项目召回缓存', async () => {
  const invalidatedProjectIds: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    lorebookEntry: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.projectId !== 'p1') return null;
        return { id: 'l1', projectId: 'p1', title: '旧地点', metadata: {} };
      },
      async findMany() { return []; },
      async update(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        return { id: 'l1', projectId: 'p1', ...args.data };
      },
      async delete(args: { where: { id: string } }) {
        deletes.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new LorebookService(prisma as never, cache as never);

  const updated = await service.update('p1', 'l1', { entryType: 'location', metadata: { region: '北境' }, priority: 80 });
  const removed = await service.remove('p1', 'l1');

  assert.equal(updated.id, 'l1');
  assert.deepEqual(updates[0].metadata, { region: '北境' });
  assert.equal(updates[0].priority, 80);
  assert.equal(updates[0].entryType, 'location');
  assert.deepEqual(deletes, ['l1']);
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1']);
  assert.deepEqual(removed, { deleted: true, id: 'l1' });
  await assert.rejects(() => service.update('other-project', 'l1', { title: '越权' }), /设定条目不存在/);
});

test('PersistOutlineTool 阻止重复章节编号写入', async () => {
  const tool = new PersistOutlineTool({} as never);
  await assert.rejects(
    () => tool.run({ preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 2 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }, { chapterNo: 1, title: '重复', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
    /章节编号重复/,
  );
});

test('VCC persist_outline rejects invalid character planning validation', async () => {
  const tool = new PersistOutlineTool({} as never);
  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1), validation: { valid: false } },
      { agentRunId: 'run-vcc-persist-invalid-validation', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /validate_outline.*valid=true/,
  );
});

test('VCC persist_outline rejects missing characterExecution without validation', async () => {
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
  };
  const craftBrief = { ...createOutlineCraftBrief(), characterExecution: undefined };
  const tool = new PersistOutlineTool(prisma as never);

  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1, { chapters: [createOutlineChapter(1, 1, { craftBrief })] }) },
      { agentRunId: 'run-vcc-persist-missing-execution', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /characterExecution/,
  );
});

test('VCC persist_outline rejects self-declared existing characters without catalog', async () => {
  const prisma = {
    character: { async findMany() { return []; } },
  };
  const tool = new PersistOutlineTool(prisma as never);

  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1), validation: { valid: true } },
      { agentRunId: 'run-vcc-persist-self-existing', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /未知既有角色|existingCharacterArcs/,
  );
});

test('VCC persist_outline does not create Character', async () => {
  const createdChapters: Array<Record<string, unknown>> = [];
  const characterCreates: Array<Record<string, unknown>> = [];
  const prisma = {
    character: {
      async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; },
      async create(args: Record<string, unknown>) {
        characterCreates.push(args);
        throw new Error('persist_outline must not create Character');
      },
    },
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      return callback({
        volume: {
          async upsert() { return { id: 'v1' }; },
        },
        chapter: {
          async findUnique() { return null; },
          async create(args: { data: Record<string, unknown> }) {
            createdChapters.push(args.data);
            return { id: 'c1' };
          },
          async update() {
            throw new Error('planned chapter should be created, not updated');
          },
        },
      });
    },
  };
  const tool = new PersistOutlineTool(prisma as never);

  const result = await tool.run(
    { preview: createVccOutlinePreview(1), validation: { valid: true } },
    { agentRunId: 'run-vcc-persist-no-character', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(createdChapters.length, 1);
  assert.equal(characterCreates.length, 0);
});

test('persist_volume_outline writes only Volume narrativePlan after approval', async () => {
  const upserts: Array<Record<string, unknown>> = [];
  const prisma = {
    character: {
      async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; },
    },
    volume: {
      async findUnique() { return null; },
      async upsert(args: Record<string, unknown>) {
        upserts.push(args);
        return { id: 'v1' };
      },
    },
  };
  const tool = new PersistVolumeOutlineTool(prisma as never);
  const preview = {
    volume: {
      volumeNo: 1,
      title: '罪桥初潮',
      synopsis: '卷简介',
      objective: '卷目标',
      chapterCount: 4,
      narrativePlan: createVccNarrativePlanForChapterCount(4),
    },
    risks: [],
  };

  const result = await tool.run(
    { preview },
    { agentRunId: 'run-persist-volume-outline', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.volumeId, 'v1');
  assert.equal(result.updatedVolumeOnly, true);
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].where, { projectId_volumeNo: { projectId: 'p1', volumeNo: 1 } });
  assert.equal((upserts[0].update as Record<string, unknown>).chapterCount, 4);
});

test('persist_volume_outline preserves existing storyUnitPlan on update', async () => {
  const upserts: Array<Record<string, unknown>> = [];
  const existingStoryUnitPlan = createVccStoryUnitPlan(4);
  const prisma = {
    character: {
      async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; },
    },
    volume: {
      async findUnique() {
        return {
          narrativePlan: {
            ...createVccNarrativePlanForChapterCount(4),
            storyUnitPlan: existingStoryUnitPlan,
          },
        };
      },
      async upsert(args: Record<string, unknown>) {
        upserts.push(args);
        return { id: 'v1' };
      },
    },
  };
  const tool = new PersistVolumeOutlineTool(prisma as never);
  const preview = {
    volume: {
      volumeNo: 1,
      title: '罪桥初潮',
      synopsis: '卷简介',
      objective: '卷目标',
      chapterCount: 4,
      narrativePlan: createVccNarrativePlanForChapterCount(4),
    },
    risks: [],
  };

  const result = await tool.run(
    { preview },
    { agentRunId: 'run-persist-volume-outline-preserve-story-units', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.preservedStoryUnitPlan, true);
  const update = upserts[0].update as Record<string, unknown>;
  const updatedNarrativePlan = update.narrativePlan as Record<string, unknown>;
  assert.deepEqual(updatedNarrativePlan.storyUnitPlan, existingStoryUnitPlan);
});

test('persist_volume_outline requires approval and blocks incomplete narrativePlan', async () => {
  const tool = new PersistVolumeOutlineTool({} as never);

  await assert.rejects(
    () => tool.run(
      { preview: { volume: { volumeNo: 1, title: '卷', synopsis: '简介', objective: '目标', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4) }, risks: [] } },
      { agentRunId: 'run-persist-volume-outline-no-approval', projectId: 'p1', mode: 'plan', approved: true, outputs: {}, policy: {} },
    ),
    /act mode/,
  );
  await assert.rejects(
    () => tool.run(
      { preview: { volume: { volumeNo: 1, title: '卷', synopsis: '简介', objective: '目标', chapterCount: 4, narrativePlan: { globalMainlineStage: '阶段' } }, risks: [] } },
      { agentRunId: 'run-persist-volume-outline-incomplete', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /storyUnits|narrativePlan/,
  );
});

test('VCC persist_volume_character_candidates requires approval', async () => {
  const tool = new PersistVolumeCharacterCandidatesTool({} as never, {} as never);
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.riskLevel, 'high');
  assert.equal(tool.sideEffects.includes('create_or_update_volume_characters'), true);
  assert.match(tool.description, /不会覆盖手工角色/);

  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1) },
      { agentRunId: 'run-vcc-character-approval', projectId: 'p1', mode: 'plan', approved: true, outputs: {}, policy: {} },
    ),
    /act mode/,
  );
  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1) },
      { agentRunId: 'run-vcc-character-approval', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} },
    ),
    /explicit user approval/,
  );
});

test('VCC persist_volume_character_candidates requires explicit candidate selection', async () => {
  let transactionCalled = false;
  const prisma = {
    async $transaction() {
      transactionCalled = true;
      return {};
    },
  };
  const tool = new PersistVolumeCharacterCandidatesTool(prisma as never, {} as never);

  await assert.rejects(
    () => tool.run(
      { preview: createVccOutlinePreview(1) },
      { agentRunId: 'run-vcc-character-selection', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /approvedCandidateIds\/approvedCandidateNames|approveAll/,
  );
  assert.equal(transactionCalled, false);
});

test('VCC persist_volume_character_candidates creates skips existing characters and writes relationships', async () => {
  const baseCandidate = createVccCharacterPlanForChapterCount(4).newCharacterCandidates[0] as Record<string, unknown>;
  const candidateManualConflict = { ...baseCandidate, candidateId: 'cand_manual', name: '邵衡', firstAppearChapter: 1 };
  const candidateNew = { ...baseCandidate, candidateId: 'cand_gulin', name: '顾临', firstAppearChapter: 2, expectedArc: '从旁观证人转为公开递交证词的人' };
  const candidateAgentExisting = { ...baseCandidate, candidateId: 'cand_fangchi', name: '方迟', firstAppearChapter: 3, expectedArc: '更新旧的 agent_outline 候选弧线' };
  const characterPlan = createVccCharacterPlanForChapterCount(4, {
    newCharacterCandidates: [candidateManualConflict, candidateNew, candidateAgentExisting],
    relationshipArcs: [{ participants: ['林澈', '顾临'], startState: '互相试探', turnChapterNos: [2], endState: '形成证词合作' }],
  });
  const preview = createVccOutlinePreview(4, {
    volume: { narrativePlan: createVccNarrativePlanForChapterCount(4, { characterPlan }) },
  });
  const createdCharacters: Array<Record<string, unknown>> = [];
  const updatedCharacters: Array<Record<string, unknown>> = [];
  const createdRelationships: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  const existingCharacters = [
    { id: 'char-lin', name: '林澈', alias: [], source: 'manual', metadata: {} },
    { id: 'char-shen', name: '沈栖', alias: [], source: 'manual', metadata: {} },
    { id: 'char-manual-shao', name: '邵衡', alias: ['旧名邵衡'], source: 'manual', metadata: { userEdited: true } },
    { id: 'char-agent-fang', name: '方迟', alias: [], source: 'agent_outline', metadata: { old: true } },
  ];
  const prisma = {
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      const tx = {
        character: {
          async findMany() { return existingCharacters; },
          async create(args: { data: Record<string, unknown> }) {
            createdCharacters.push(args.data);
            return { id: 'char-gulin', alias: [], ...args.data };
          },
          async update(args: { where: { id: string }; data: Record<string, unknown> }) {
            updatedCharacters.push({ id: args.where.id, ...args.data });
            return { id: args.where.id, name: '方迟', alias: [], source: 'agent_outline', metadata: args.data.metadata };
          },
        },
        relationshipEdge: {
          async findMany() { return []; },
          async create(args: { data: Record<string, unknown> }) {
            createdRelationships.push(args.data);
            return { id: 'rel-gulin' };
          },
        },
      };
      return callback(tx);
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const tool = new PersistVolumeCharacterCandidatesTool(prisma as never, cache as never);

  const result = await tool.run(
    { preview, approveAll: true, includeRelationshipArcs: true },
    { agentRunId: 'run-vcc-character-write', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.relationshipCreatedCount, 1);
  assert.equal(createdCharacters[0].name, '顾临');
  assert.equal(createdCharacters[0].source, 'agent_outline');
  assert.equal(createdCharacters[0].scope, 'volume');
  assert.equal(createdCharacters[0].activeFromChapter, 2);
  assert.equal((createdCharacters[0].metadata as Record<string, unknown>).candidateId, 'cand_gulin');
  assert.equal(updatedCharacters.length, 0);
  assert.equal(updatedCharacters.some((item) => item.id === 'char-manual-shao'), false);
  assert.equal(result.characterResults.find((item) => item.name === '邵衡')?.action, 'skipped');
  assert.equal(result.characterResults.find((item) => item.name === '方迟')?.action, 'skipped');
  assert.equal(createdRelationships[0].characterAId, 'char-lin');
  assert.equal(createdRelationships[0].characterBId, 'char-gulin');
  assert.equal(createdRelationships[0].sourceType, 'agent_outline');
  assert.match(result.approvalMessage, /minor_temporary characters are not written/);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
});

test('VCC persist_volume_character_candidates rejects incomplete candidate', async () => {
  const incompletePlan = createVccCharacterPlanForChapterCount(1, {
    newCharacterCandidates: [
      { ...createVccCharacterPlanForChapterCount(1).newCharacterCandidates[0], motivation: '' },
    ],
    relationshipArcs: [],
  });
  const preview = createVccOutlinePreview(1, {
    volume: { narrativePlan: createVccNarrativePlanForChapterCount(1, { characterPlan: incompletePlan }) },
  });
  const prisma = {
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      return callback({
        character: { async findMany() { return [{ id: 'char-lin', name: '林澈', alias: [], source: 'manual', metadata: {} }, { id: 'char-shen', name: '沈栖', alias: [], source: 'manual', metadata: {} }]; } },
        relationshipEdge: { async findMany() { return []; } },
      });
    },
  };
  const tool = new PersistVolumeCharacterCandidatesTool(prisma as never, {} as never);

  await assert.rejects(
    () => tool.run(
      { preview, approveAll: true },
      { agentRunId: 'run-vcc-character-incomplete', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /motivation/,
  );
});

test('PersistOutlineTool 写入新建和 planned 章节 craftBrief 并跳过 drafted', async () => {
  const upsertedVolumes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const createdChapters: Array<Record<string, unknown>> = [];
  const updatedChapters: Array<Record<string, unknown>> = [];
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      return callback({
        volume: {
          async upsert(args: { create: Record<string, unknown>; update: Record<string, unknown> }) {
            upsertedVolumes.push(args);
            return { id: 'v1' };
          },
        },
        chapter: {
          async findUnique(args: { where: { projectId_chapterNo: { chapterNo: number } } }) {
            const chapterNo = args.where.projectId_chapterNo.chapterNo;
            if (chapterNo === 2) return { id: 'c2', status: 'planned' };
            if (chapterNo === 3) return { id: 'c3', status: 'drafted', craftBrief: { visibleGoal: '旧执行卡' } };
            return null;
          },
          async create(args: { data: Record<string, unknown> }) {
            createdChapters.push(args.data);
            return { id: 'c1' };
          },
          async update(args: { where: { id: string }; data: Record<string, unknown> }) {
            updatedChapters.push({ id: args.where.id, ...args.data });
            return { id: args.where.id };
          },
        },
      });
    },
  };
  const tool = new PersistOutlineTool(prisma as never);
  const preview = createVccOutlinePreview(3);
  preview.chapters[0].craftBrief = createOutlineCraftBrief({ visibleGoal: '拿到旧档案' });
  preview.chapters[1].craftBrief = createOutlineCraftBrief({ visibleGoal: '确认档案被换' });
  preview.chapters[2].craftBrief = createOutlineCraftBrief({ visibleGoal: '不应覆盖 drafted' });
  const result = await tool.run(
    { preview },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(Boolean((upsertedVolumes[0].create.narrativePlan as Record<string, unknown>).characterPlan), true);
  assert.equal(Boolean((upsertedVolumes[0].update.narrativePlan as Record<string, unknown>).characterPlan), true);
  assert.equal((createdChapters[0].craftBrief as Record<string, unknown>).visibleGoal, '拿到旧档案');
  assert.equal((updatedChapters[0].craftBrief as Record<string, unknown>).visibleGoal, '确认档案被换');
  assert.equal(updatedChapters.some((chapter) => chapter.id === 'c3'), false);
});

test('PersistOutlineTool 拒绝旧 outline_preview 缺 craftBrief', async () => {
  const updatedChapters: Array<Record<string, unknown>> = [];
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      return callback({
        volume: {
          async upsert() { return { id: 'v1' }; },
        },
        chapter: {
          async findUnique() { return { id: 'c1', status: 'planned', craftBrief: { visibleGoal: '旧执行卡' } }; },
          async create() { throw new Error('不应创建章节'); },
          async update(args: { where: { id: string }; data: Record<string, unknown> }) {
            updatedChapters.push(args.data);
            return { id: args.where.id };
          },
        },
      });
    },
  };
  const tool = new PersistOutlineTool(prisma as never);

  await assert.rejects(
    () => tool.run(
      { preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 1, narrativePlan: createVccNarrativePlanForChapterCount(1) }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } },
      { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
    ),
    /characterExecution/,
  );

  assert.equal(updatedChapters.length, 0);
});

test('VCC validate_outline and persist_outline reject incomplete volume narrativePlan', async () => {
  let transactionCalled = false;
  const prisma = {
    character: { async findMany() { return [{ name: '林澈', alias: [] }, { name: '沈栖', alias: [] }]; } },
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
    async $transaction() {
      transactionCalled = true;
      return {};
    },
  };
  const preview = createVccOutlinePreview(3, {
    volume: {
      narrativePlan: { ...createVccNarrativePlanForChapterCount(3), foreshadowPlan: undefined },
    },
  });
  const validateTool = new ValidateOutlineTool(prisma as never);
  const persistTool = new PersistOutlineTool(prisma as never);
  const context = { agentRunId: 'run-vcc-outline-narrative-persist', projectId: 'p1', mode: 'act' as const, approved: true, outputs: {}, policy: {} };

  const validation = await validateTool.run({ preview }, context);
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((issue) => /foreshadowPlan|narrativePlan/.test(issue.message)), true);

  await assert.rejects(
    () => persistTool.run({ preview, validation: { valid: true } }, context),
    /foreshadowPlan|narrative planning|narrativePlan/,
  );
  assert.equal(transactionCalled, false);
});

test('GenerateOutlinePreviewTool keeps long outer timeout without output token cap', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  let receivedMessages: Array<{ role: string; content: string }> | undefined;
  const llmUsages: Array<{ model?: string }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      receivedMessages = messages;
      receivedOptions = options;
      return {
        data: {
          volume: { volumeNo: 2, title: '盐风峡路', synopsis: '夺取通路权', objective: '建立稳定商路', chapterCount: 1, narrativePlan: createVccNarrativePlanForChapterCount(1) },
          chapters: [createOutlineChapter(1, 2, { title: '峡口税旗', objective: '拆解垄断', conflict: '浮税盟施压', hook: '盐风暴将至', outline: '工队抵达峡口。', expectedWordCount: 2600 })],
          risks: [],
        },
        result: { model: 'mock-outline-model', usage: { total_tokens: 31 }, elapsedMs: 123, rawPayloadSummary: { id: 'chatcmpl_mock' } },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  const output = await tool.run(
    {
      instruction: '把第二卷拆成 1 章',
      volumeNo: 2,
      chapterCount: 1,
      context: {
        project: { title: '逆潮脊梁', genre: '工业奇幻', outline: '修成逆潮工程，建立共承制度。' },
        volumes: [{ volumeNo: 2, title: '盐风峡路', objective: '建立稳定商路', synopsis: '峡谷商路争夺。', narrativePlan: { volumeMainline: '夺取通路权' } }],
        existingChapters: [{ chapterNo: 1, title: '旧章', objective: '旧目标' }],
        characters: [{ name: '林澈', roleType: 'protagonist', motivation: '保护工队' }, { name: '沈栖', roleType: 'supporting', motivation: '保护旧记录' }],
        lorebookEntries: [{ title: '盐风峡', entryType: 'location', content: '峡谷会周期性爆发盐风暴。' }],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {}, recordLlmUsage: (usage) => llmUsages.push(usage) },
  );

  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 80 + 60_000);
  assert.equal(receivedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(receivedOptions?.retries, 0);
  assert.equal(receivedOptions?.maxTokens, undefined);
  assert.equal(receivedOptions?.jsonMode, true);
  assert.match(receivedMessages?.[0]?.content ?? '', /actionBeats 至少 3 个节点/);
  assert.match(receivedMessages?.[0]?.content ?? '', /concreteClues 至少 1 个/);
  assert.match(receivedMessages?.[0]?.content ?? '', /sceneBeats/);
  assert.match(receivedMessages?.[0]?.content ?? '', /handoffToNextChapter/);
  assert.match(receivedMessages?.[0]?.content ?? '', /不可逆后果/);
  assert.match(receivedMessages?.[1]?.content ?? '', /目标卷纲/);
  assert.match(receivedMessages?.[1]?.content ?? '', /夺取通路权/);
  assert.match(receivedMessages?.[1]?.content ?? '', /已有章节摘要/);
  assert.match(receivedMessages?.[1]?.content ?? '', /角色摘要/);
  assert.match(receivedMessages?.[1]?.content ?? '', /设定摘要/);
  assert.equal(output.volume.volumeNo, 2);
  assert.equal(output.chapters.length, 1);
  assert.equal(llmUsages[0].model, 'mock-outline-model');
});

test('generate_outline_preview 重新规划时不把原有卷纲、章节细纲和 craftBrief 传给 LLM', async () => {
  const prompts: string[] = [];
  const oldChapters = Array.from({ length: 20 }, (_item, index) => {
    const chapterNo = index + 1;
    return {
      chapterNo,
      volumeNo: 1,
      title: `旧第 ${chapterNo} 章`,
      objective: `第${chapterNo}章旧目标`,
      conflict: `第${chapterNo}章旧冲突`,
      outline: `旧第 ${chapterNo} 章细纲：陆沉舟在旧桥墩下检查盐蚀铆钉，曹钧拦住催工的差役，闻青栀拿出被浮税盟涂改的料账，章末留下第${chapterNo}个旧伏笔。`,
      craftBrief: createOutlineCraftBrief({
        visibleGoal: `第${chapterNo}章旧执行目标`,
        handoffToNextChapter: `第${chapterNo}章旧交接压力`,
      }),
    };
  });
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      prompts.push(prompt);
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      assert.ok(match, '逐章 prompt 应包含本次章节范围');
      const start = Number(match[1]);
      const end = Number(match[2]);
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '重写后卷简介',
            objective: '重写后卷目标',
            chapterCount: 20,
            narrativePlan: createVccNarrativePlanForChapterCount(20),
          },
          chapters: Array.from({ length: end - start + 1 }, (_chapter, index) => createOutlineChapter(start + index, 1)),
          risks: [],
        },
        result: { model: 'mock-outline' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);

  await tool.run(
    {
      instruction: '重新编写第 1 卷 20 章细纲',
      volumeNo: 1,
      chapterCount: 20,
      context: {
        project: { title: '逆潮脊梁', outline: '修成逆潮脊梁，但最终改为活承网。' },
        volumes: [{ volumeNo: 1, title: '罪桥初潮', synopsis: '旧卷简介', objective: '旧卷目标', chapterCount: 20, narrativePlan: { storyUnits: [{ unitId: 'old_unit_01', title: '旧单元总图' }] } }],
        existingChapters: oldChapters,
        characters: [{ name: '林澈' }, { name: '沈栖' }],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.match(prompts[0], /目标卷信息（重规划模式/);
  assert.match(prompts[0], /已省略原有卷纲、章节 outline 和 craftBrief/);
  assert.doesNotMatch(prompts[0], /旧卷简介/);
  assert.doesNotMatch(prompts[0], /旧卷目标/);
  assert.doesNotMatch(prompts[0], /旧单元总图/);
  assert.doesNotMatch(prompts[0], /旧第 1 章细纲/);
  assert.doesNotMatch(prompts[0], /旧第 20 章细纲/);
  assert.doesNotMatch(prompts[0], /第1章旧执行目标/);
  assert.doesNotMatch(prompts[0], /第20章旧执行目标/);
});

test('GenerateOutlinePreviewTool LLM failure 直接抛错，不生成确定性预览', async () => {
  const llm = {
    async chatJson() {
      throw new Error('LLM request timed out');
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      {
        instruction: '帮我生成卷1 的细纲，目标60章节。',
        volumeNo: 1,
        chapterCount: 60,
        context: {
          project: { title: '逆潮脊梁', outline: '修成逆潮工程，建立共承制度。' },
          volumes: [{ volumeNo: 1, title: '罪桥初潮', objective: '完成开局灾难、罪名抛出、承重眼暴露与沉舟工队雏形建立。' }],
        },
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /LLM request timed out/,
  );
});

test('BuildImportBriefTool 生成只读导入简报并规范化字段', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          requestedAssetTypes: ['characters'],
          coreSettings: [{ summary: '雾城档案馆保存旧案卷宗' }, '记忆可被篡改'],
          mainline: { goal: '档案员追查不存在的死亡记录' },
          theme: { primary: '记忆与真相' },
          keyCharacters: [{ name: '许知微' }, '周砚'],
          worldRules: [{ rule: '缺页索引指向被抹除的人' }],
          tone: ['冷静', '悬疑'],
          risks: [{ message: '旧案时间线需复核' }, '  保留风险  '],
        },
        result: { model: 'mock-import-brief', usage: { total_tokens: 21 } },
      };
    },
  };
  const tool = new BuildImportBriefTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案员追查不存在的死亡记录，档案缺页牵出城市记忆篡改。',
        length: 33,
        paragraphs: ['档案员追查死亡记录', '城市记忆可被篡改'],
        keywords: ['雾城', '记忆'],
      },
      instruction: '只导入大纲和角色',
      requestedAssetTypes: ['outline', 'characters'],
      projectContext: { title: '旧档' },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(tool.name, 'build_import_brief');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(output.requestedAssetTypes, ['outline', 'characters']);
  assert.deepEqual(output.coreSettings, ['雾城档案馆保存旧案卷宗', '记忆可被篡改']);
  assert.equal(output.mainline, '档案员追查不存在的死亡记录');
  assert.equal(output.theme, '记忆与真相');
  assert.deepEqual(output.keyCharacters, ['许知微', '周砚']);
  assert.deepEqual(output.worldRules, ['缺页索引指向被抹除的人']);
  assert.equal(output.tone, '冷静、悬疑');
  assert.deepEqual(output.risks, ['旧案时间线需复核', '保留风险']);
  assert.match(promptText, /read-only global brief/);
  assert.match(promptText, /Requested asset types: outline, characters/);
  assert.equal(receivedOptions?.appStep, 'agent_import_brief');
});

test('build_import_brief mainline 包装错误可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: calls.length === 1
          ? { summary: '档案员追查不存在的死亡记录', coreSettings: ['雾城档案馆'], keyCharacters: ['许知微'], worldRules: ['记忆可被篡改'], risks: [] }
          : { mainline: '档案员追查不存在的死亡记录', coreSettings: ['雾城档案馆'], keyCharacters: ['许知微'], worldRules: ['记忆可被篡改'], risks: [] },
        result: { model: `mock-import-brief-${calls.length}` },
      };
    },
  };
  const tool = new BuildImportBriefTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案员追查不存在的死亡记录。',
        length: 16,
        paragraphs: ['档案员追查不存在的死亡记录'],
        keywords: ['雾城'],
      },
      instruction: '只导入大纲',
      requestedAssetTypes: ['outline'],
    },
    { agentRunId: 'run-import-brief-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /mainline/);
  assert.equal(output.mainline, '档案员追查不存在的死亡记录');
});

test('build_import_brief 输出可写入资产时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          mainline: '档案员追查不存在的死亡记录',
          coreSettings: ['雾城档案馆'],
          keyCharacters: ['许知微'],
          worldRules: ['记忆可被篡改'],
          chapters: [{ chapterNo: 1, title: '不应生成章节资产' }],
          risks: [],
        },
        result: { model: 'mock-import-brief-scope' },
      };
    },
  };
  const tool = new BuildImportBriefTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '雾城档案员追查不存在的死亡记录。',
          length: 16,
          paragraphs: ['档案员追查不存在的死亡记录'],
          keywords: ['雾城'],
        },
        instruction: '只导入大纲',
        requestedAssetTypes: ['outline'],
      },
      { agentRunId: 'run-import-brief-scope', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );
  assert.equal(callCount, 1);
});

test('GenerateImportOutlinePreviewTool 只生成导入大纲预览并保持只读', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          projectProfile: { outline: { mainline: '雾城档案员追查记忆篡改主线' } },
          volumes: [{ volumeNo: 1, title: { primary: '灰楼旧灯' }, synopsis: ['发现异常'], objective: { goal: '确认旧案存在' } }],
          chapters: [
            { chapterNo: 1, volumeNo: 1, title: { primary: '失踪的页码' }, objective: ['发现缺页'], conflict: { pressure: '馆方阻止' }, hook: true, outline: { summary: '夜查档案库' }, expectedWordCount: 3200 },
          ],
          risks: [{ message: '章节数需复核' }, '  保留风险  '],
        },
        result: { model: 'mock-outline-import', usage: { total_tokens: 34 } },
      };
    },
  };
  const tool = new GenerateImportOutlinePreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案员发现档案缺页，并追查一场记忆篡改。',
        length: 24,
        paragraphs: ['发现档案缺页', '追查记忆篡改'],
        keywords: ['雾城', '档案'],
      },
      instruction: '只生成剧情大纲',
      projectContext: { title: '雾城旧档' },
      chapterCount: 1,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const outputRecord = output as unknown as Record<string, unknown>;

  assert.equal(tool.name, 'generate_import_outline_preview');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.equal(output.projectProfile.outline, '雾城档案员追查记忆篡改主线');
  assert.deepEqual(output.volumes[0], { volumeNo: 1, title: '灰楼旧灯', synopsis: '发现异常', objective: '确认旧案存在', chapterCount: 1 });
  assert.deepEqual(output.chapters[0], { chapterNo: 1, volumeNo: 1, title: '失踪的页码', objective: '发现缺页', conflict: '馆方阻止', hook: 'true', outline: '夜查档案库', expectedWordCount: 3200 });
  assert.deepEqual(output.risks, ['章节数需复核', '保留风险']);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'characters'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'lorebookEntries'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'writingRules'), false);
  assert.match(promptText, /mainline progression/);
  assert.match(promptText, /Do not output characters/);
  assert.equal(receivedOptions?.appStep, 'agent_import_outline_preview');
});

test('generate_import_outline_preview 顶层 outline 包装错误可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const baseOutline = {
    volumes: [{ volumeNo: 1, title: '灰楼旧灯', synopsis: '发现异常', objective: '确认旧案存在' }],
    chapters: [{ chapterNo: 1, volumeNo: 1, title: '失踪的页码', objective: '发现缺页', conflict: '馆方阻止', hook: '湿钥匙出现', outline: '夜查档案库', expectedWordCount: 3200 }],
    risks: [],
  };
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: calls.length === 1
          ? { outline: '雾城档案员追查记忆篡改主线', ...baseOutline }
          : { projectProfile: { outline: '雾城档案员追查记忆篡改主线' }, ...baseOutline },
        result: { model: `mock-outline-import-${calls.length}` },
      };
    },
  };
  const tool = new GenerateImportOutlinePreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案员发现档案缺页，并追查一场记忆篡改。',
        length: 24,
        paragraphs: ['发现档案缺页'],
        keywords: ['雾城'],
      },
      instruction: '只生成剧情大纲',
      chapterCount: 1,
    },
    { agentRunId: 'run-import-outline-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /projectProfile\.outline/);
  assert.equal(output.projectProfile.outline, '雾城档案员追查记忆篡改主线');
});

test('generate_import_outline_preview 章节数量不足时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          projectProfile: { outline: '雾城档案员追查记忆篡改主线' },
          volumes: [{ volumeNo: 1, title: '灰楼旧灯' }],
          chapters: [],
          risks: [],
        },
        result: { model: 'mock-outline-import-missing' },
      };
    },
  };
  const tool = new GenerateImportOutlinePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '雾城档案员发现档案缺页，并追查一场记忆篡改。',
          length: 24,
          paragraphs: ['发现档案缺页'],
          keywords: ['雾城'],
        },
        instruction: '只生成剧情大纲',
        chapterCount: 1,
      },
      { agentRunId: 'run-import-outline-missing', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /returned chapters 0\/1/,
  );
  assert.equal(callCount, 1);
});

test('GenerateImportCharactersPreviewTool 只生成导入角色预览并保持只读', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          characters: [
            {
              name: { primary: '许知微' },
              roleType: ['protagonist', 'investigator'],
              personalityCore: { core: '谨慎但害怕失控' },
              motivation: { goal: '查清父亲旧案' },
              backstory: { history: '旧档案馆长大的调查员' },
            },
          ],
          risks: [{ message: '人物关系需复核' }, '  保留风险  '],
        },
        result: { model: 'mock-characters', usage: { total_tokens: 22 } },
      };
    },
  };
  const tool = new GenerateImportCharactersPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '许知微在旧档案馆追查父亲旧案，她谨慎但害怕失控。',
        length: 26,
        paragraphs: ['许知微追查父亲旧案', '她谨慎但害怕失控'],
        keywords: ['许知微', '档案馆'],
      },
      instruction: '只生成角色人设',
      projectContext: { existingCharacters: [{ name: '周砚' }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const outputRecord = output as unknown as Record<string, unknown>;

  assert.equal(tool.name, 'generate_import_characters_preview');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(output.characters, [{
    name: '许知微',
    roleType: 'protagonist、investigator',
    personalityCore: '谨慎但害怕失控',
    motivation: '查清父亲旧案',
    backstory: '旧档案馆长大的调查员',
  }]);
  assert.deepEqual(output.risks, ['人物关系需复核', '保留风险']);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'lorebookEntries'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'writingRules'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'volumes'), false);
  assert.match(promptText, /character motivation/);
  assert.match(promptText, /Do not output lorebookEntries/);
  assert.equal(receivedOptions?.appStep, 'agent_import_characters_preview');
});

test('generate_import_characters_preview roleType 局部缺失可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          characters: [{
            name: '许知微',
            ...(calls.length === 1 ? {} : { roleType: 'protagonist' }),
            personalityCore: '谨慎但害怕失控',
            motivation: '查清父亲旧案',
            backstory: '旧档案馆长大的调查员',
          }],
          risks: [],
        },
        result: { model: `mock-characters-${calls.length}` },
      };
    },
  };
  const tool = new GenerateImportCharactersPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '许知微在旧档案馆追查父亲旧案，她谨慎但害怕失控。',
        length: 26,
        paragraphs: ['许知微追查父亲旧案'],
        keywords: ['许知微'],
      },
      instruction: '只生成角色人设',
    },
    { agentRunId: 'run-import-characters-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /roleType/);
  assert.equal(output.characters[0].roleType, 'protagonist');
});

test('generate_import_characters_preview 目标范围扩大时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          characters: [{
            name: '许知微',
            roleType: 'protagonist',
            personalityCore: '谨慎但害怕失控',
            motivation: '查清父亲旧案',
            backstory: '旧档案馆长大的调查员',
          }],
          lorebookEntries: [{ title: '不应扩大到设定', entryType: 'setting', content: '不应出现' }],
          risks: [],
        },
        result: { model: 'mock-characters-scope' },
      };
    },
  };
  const tool = new GenerateImportCharactersPreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '许知微在旧档案馆追查父亲旧案。',
          length: 16,
          paragraphs: ['许知微追查父亲旧案'],
          keywords: ['许知微'],
        },
        instruction: '只生成角色人设',
      },
      { agentRunId: 'run-import-characters-scope', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );
  assert.equal(callCount, 1);
});

test('GenerateImportWorldbuildingPreviewTool 只生成导入世界设定预览并读取 locked facts', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          lorebookEntries: [
            {
              title: { primary: '雾城档案馆' },
              entryType: ['location'],
              content: { detail: '保存旧案卷宗的灰楼，地下库房藏有缺页索引。' },
              summary: { summary: '旧案卷宗中心地点' },
              tags: ['地点', { title: '档案' }],
            },
          ],
          risks: [{ message: '与 locked fact 需人工复核' }, '  保留风险  '],
        },
        result: { model: 'mock-worldbuilding', usage: { total_tokens: 23 } },
      };
    },
  };
  const tool = new GenerateImportWorldbuildingPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案馆保存旧案卷宗，地下库房藏有缺页索引。',
        length: 25,
        paragraphs: ['雾城档案馆保存旧案卷宗', '地下库房藏有缺页索引'],
        keywords: ['雾城档案馆', '地下库房'],
      },
      instruction: '只生成世界设定，不能覆盖锁定事实',
      projectContext: { worldFacts: [{ title: '旧案不能公开', locked: true }] },
      maxEntries: 1,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const outputRecord = output as unknown as Record<string, unknown>;

  assert.equal(tool.name, 'generate_import_worldbuilding_preview');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(output.lorebookEntries, [{
    title: '雾城档案馆',
    entryType: 'location',
    content: '保存旧案卷宗的灰楼，地下库房藏有缺页索引。',
    summary: '旧案卷宗中心地点',
    tags: ['地点', '档案'],
  }]);
  assert.deepEqual(output.risks, ['与 locked fact 需人工复核', '保留风险']);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'characters'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'writingRules'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'chapters'), false);
  assert.match(promptText, /locations, factions, rules, history, power systems/);
  assert.match(promptText, /locked facts/);
  assert.match(promptText, /旧案不能公开/);
  assert.equal(receivedOptions?.appStep, 'agent_import_worldbuilding_preview');
});

test('generate_import_worldbuilding_preview entryType 局部缺失可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          lorebookEntries: [{
            title: '雾城档案馆',
            ...(calls.length === 1 ? {} : { entryType: 'location' }),
            content: '保存旧案卷宗的灰楼，地下库房藏有缺页索引。',
            summary: '旧案卷宗中心地点',
            tags: ['地点'],
          }],
          risks: [],
        },
        result: { model: `mock-worldbuilding-${calls.length}` },
      };
    },
  };
  const tool = new GenerateImportWorldbuildingPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城档案馆保存旧案卷宗，地下库房藏有缺页索引。',
        length: 25,
        paragraphs: ['雾城档案馆保存旧案卷宗'],
        keywords: ['雾城档案馆'],
      },
      instruction: '只生成世界设定',
      maxEntries: 1,
    },
    { agentRunId: 'run-import-worldbuilding-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /entryType/);
  assert.equal(output.lorebookEntries[0].entryType, 'location');
});

test('generate_import_worldbuilding_preview 目标范围扩大时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          lorebookEntries: [{ title: '雾城档案馆', entryType: 'location', content: '保存旧案卷宗的灰楼。' }],
          characters: [{ name: '不应扩大到角色' }],
          risks: [],
        },
        result: { model: 'mock-worldbuilding-scope' },
      };
    },
  };
  const tool = new GenerateImportWorldbuildingPreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '雾城档案馆保存旧案卷宗。',
          length: 12,
          paragraphs: ['雾城档案馆保存旧案卷宗'],
          keywords: ['雾城档案馆'],
        },
        instruction: '只生成世界设定',
      },
      { agentRunId: 'run-import-worldbuilding-scope', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );
  assert.equal(callCount, 1);
});

test('GenerateImportWritingRulesPreviewTool 只生成导入写作规则预览并避免 lorebook 污染', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          writingRules: [
            {
              title: { primary: '第三人称有限视角' },
              ruleType: ['pov'],
              content: { rule: '只写当前视角角色可感知的信息。' },
              severity: 'warn',
              appliesFromChapterNo: 1,
              appliesToChapterNo: 12.8,
              entityType: { value: 'chapter' },
              entityRef: ['第一卷'],
              status: '',
            },
          ],
          risks: [{ message: '适用章节需复核' }, '  保留风险  '],
        },
        result: { model: 'mock-writing-rules', usage: { total_tokens: 24 } },
      };
    },
  };
  const tool = new GenerateImportWritingRulesPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '全文采用第三人称有限视角，不写角色无法感知的信息。',
        length: 24,
        paragraphs: ['全文采用第三人称有限视角', '不写角色无法感知的信息'],
        keywords: ['第三人称', '视角'],
      },
      instruction: '只生成写作规则',
      projectContext: { writingRules: [{ title: '禁止现代网络词' }] },
      maxRules: 1,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const outputRecord = output as unknown as Record<string, unknown>;

  assert.equal(tool.name, 'generate_import_writing_rules_preview');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(output.writingRules, [{
    title: '第三人称有限视角',
    ruleType: 'pov',
    content: '只写当前视角角色可感知的信息。',
    severity: 'warning',
    appliesFromChapterNo: 1,
    appliesToChapterNo: 13,
    entityType: 'chapter',
    entityRef: '第一卷',
    status: 'active',
  }]);
  assert.deepEqual(output.risks, ['适用章节需复核', '保留风险']);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'lorebookEntries'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'characters'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'chapters'), false);
  assert.match(promptText, /prose style, POV, tense\/person/);
  assert.match(promptText, /Do not put worldbuilding facts/);
  assert.equal(receivedOptions?.appStep, 'agent_import_writing_rules_preview');
});

test('generate_import_writing_rules_preview severity 局部缺失可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          writingRules: [{
            title: '第三人称有限视角',
            ruleType: 'pov',
            content: '只写当前视角角色可感知的信息。',
            ...(calls.length === 1 ? {} : { severity: 'warning' }),
          }],
          risks: [],
        },
        result: { model: `mock-writing-rules-${calls.length}` },
      };
    },
  };
  const tool = new GenerateImportWritingRulesPreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '全文采用第三人称有限视角，不写角色无法感知的信息。',
        length: 24,
        paragraphs: ['全文采用第三人称有限视角'],
        keywords: ['第三人称'],
      },
      instruction: '只生成写作规则',
      maxRules: 1,
    },
    { agentRunId: 'run-import-writing-rules-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /severity/);
  assert.equal(output.writingRules[0].severity, 'warning');
});

test('generate_import_writing_rules_preview 目标范围扩大时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          writingRules: [{ title: '第三人称有限视角', ruleType: 'pov', content: '只写当前视角角色可感知的信息。', severity: 'warning' }],
          lorebookEntries: [{ title: '不应扩大到设定', entryType: 'setting', content: '不应出现' }],
          risks: [],
        },
        result: { model: 'mock-writing-rules-scope' },
      };
    },
  };
  const tool = new GenerateImportWritingRulesPreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '全文采用第三人称有限视角。',
          length: 12,
          paragraphs: ['全文采用第三人称有限视角'],
          keywords: ['第三人称'],
        },
        instruction: '只生成写作规则',
      },
      { agentRunId: 'run-import-writing-rules-scope', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );
  assert.equal(callCount, 1);
});

test('GenerateImportProjectProfilePreviewTool 只生成项目资料且不生成 outline', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          projectProfile: {
            title: { primary: '雾城旧档' },
            genre: ['悬疑', '都市奇幻'],
            theme: { summary: '记忆与真相' },
            tone: { value: '冷静克制' },
            logline: { premise: '档案员追查一份不存在的死亡记录。' },
            synopsis: { content: '档案缺页牵出城市记忆篡改。' },
          },
          risks: [{ message: '标题需用户确认' }, '  保留风险  '],
        },
        result: { model: 'mock-project-profile', usage: { total_tokens: 25 } },
      };
    },
  };
  const tool = new GenerateImportProjectProfilePreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城旧档讲述档案员追查不存在的死亡记录，档案缺页牵出城市记忆篡改。',
        length: 36,
        paragraphs: ['档案员追查不存在的死亡记录', '档案缺页牵出城市记忆篡改'],
        keywords: ['雾城旧档', '记忆'],
      },
      instruction: '只生成项目资料',
      projectContext: { title: '旧标题' },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  const outputRecord = output as unknown as Record<string, unknown>;
  const profileRecord = output.projectProfile as Record<string, unknown>;

  assert.equal(tool.name, 'generate_import_project_profile_preview');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(output.projectProfile, {
    title: '雾城旧档',
    genre: '悬疑、都市奇幻',
    theme: '记忆与真相',
    tone: '冷静克制',
    logline: '档案员追查一份不存在的死亡记录。',
    synopsis: '档案缺页牵出城市记忆篡改。',
  });
  assert.deepEqual(output.risks, ['标题需用户确认', '保留风险']);
  assert.equal(Object.prototype.hasOwnProperty.call(profileRecord, 'outline'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'characters'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'lorebookEntries'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRecord, 'writingRules'), false);
  assert.match(promptText, /work positioning/);
  assert.match(promptText, /Do not output projectProfile\.outline/);
  assert.equal(receivedOptions?.appStep, 'agent_import_project_profile_preview');
});

test('generate_import_project_profile_preview 顶层包装错误可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: calls.length === 1
          ? { title: '雾城旧档', synopsis: '档案缺页牵出城市记忆篡改。', risks: [] }
          : { projectProfile: { title: '雾城旧档', synopsis: '档案缺页牵出城市记忆篡改。' }, risks: [] },
        result: { model: `mock-project-profile-${calls.length}` },
      };
    },
  };
  const tool = new GenerateImportProjectProfilePreviewTool(llm as never);
  const output = await tool.run(
    {
      analysis: {
        sourceText: '雾城旧档讲述档案员追查不存在的死亡记录。',
        length: 22,
        paragraphs: ['档案员追查不存在的死亡记录'],
        keywords: ['雾城旧档'],
      },
      instruction: '只生成项目资料',
    },
    { agentRunId: 'run-import-project-profile-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /projectProfile/);
  assert.equal(output.projectProfile.title, '雾城旧档');
});

test('generate_import_project_profile_preview 目标范围扩大时直接失败且不修复', async () => {
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: {
          projectProfile: { title: '雾城旧档', synopsis: '档案缺页牵出城市记忆篡改。', outline: '不应生成大纲' },
          risks: [],
        },
        result: { model: 'mock-project-profile-scope' },
      };
    },
  };
  const tool = new GenerateImportProjectProfilePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        analysis: {
          sourceText: '雾城旧档讲述档案员追查不存在的死亡记录。',
          length: 22,
          paragraphs: ['档案员追查不存在的死亡记录'],
          keywords: ['雾城旧档'],
        },
        instruction: '只生成项目资料',
      },
      { agentRunId: 'run-import-project-profile-scope', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );
  assert.equal(callCount, 1);
});

test('BuildImportPreviewTool normalizes non-string risks', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(_messages: unknown, options: Record<string, unknown>) {
      receivedOptions = options;
      return {
        data: {
          projectProfile: { title: '导入项目' },
          characters: [],
          lorebookEntries: [],
          volumes: [],
          chapters: [],
          risks: [{ code: 'schema', message: '需要复核' }, 42, '  保留  ', null],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new BuildImportPreviewTool(llm as never);
  const output = await tool.run(
    { analysis: { sourceText: '正文', length: 2, paragraphs: ['正文'], keywords: ['正文'] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.deepEqual(output.risks, ['{"code":"schema","message":"需要复核"}', '42', '保留']);
  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 3 + 5_000 + 60_000);
  assert.equal(receivedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
});

test('BuildImportPreviewTool normalizes LLM object and array scalar fields', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          projectProfile: {
            title: { primary: 'Bridge', alternatives: ['Alt Bridge'] },
            genre: ['fantasy', 'engineering'],
            tone: { primary: 'epic', secondary: ['survival'] },
          },
          characters: [{ name: { value: 'Lu' }, roleType: ['lead', 'engineer'] }],
          lorebookEntries: [{ title: { name: 'Sea' }, entryType: ['setting'], content: { summary: 'inverted sea' }, tags: ['sky', { value: 'tide' }] }],
          writingRules: [{ title: { primary: 'No Slang' }, ruleType: ['style'], content: { summary: 'avoid memes' }, severity: 'warn' }],
          volumes: [{ volumeNo: '1', title: { primary: 'First Tide' } }],
          chapters: [{ chapterNo: '1', volumeNo: '1', title: { primary: 'Escape' }, outline: { summary: 'fix bridge' } }],
          risks: [],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new BuildImportPreviewTool(llm as never);
  const output = await tool.run(
    { analysis: { sourceText: 'source synopsis', length: 15, paragraphs: ['source synopsis'], keywords: ['bridge'] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(output.projectProfile.title, 'Bridge');
  assert.equal(output.projectProfile.genre, 'fantasy、engineering');
  assert.equal(output.projectProfile.tone, 'epic');
  assert.equal(output.projectProfile.synopsis, undefined);
  assert.deepEqual(output.characters[0], { name: 'Lu', roleType: 'lead、engineer', personalityCore: undefined, motivation: undefined, backstory: undefined });
  assert.deepEqual(output.lorebookEntries[0], { title: 'Sea', entryType: 'setting', content: 'inverted sea', summary: undefined, tags: ['sky', '{"value":"tide"}'] });
  assert.deepEqual(output.writingRules[0], { title: 'No Slang', ruleType: 'style', content: 'avoid memes', severity: 'warning', appliesFromChapterNo: undefined, appliesToChapterNo: undefined, entityType: undefined, entityRef: undefined, status: 'active' });
  assert.equal(output.projectProfile.outline, undefined);
  assert.equal(output.volumes[0].title, 'First Tide');
  assert.equal(output.chapters[0].outline, 'fix bridge');
});

test('build_import_preview risks 包装错误可由 LLM 修复', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          projectProfile: { title: 'Bridge', synopsis: 'source synopsis' },
          characters: [],
          lorebookEntries: [],
          writingRules: [],
          volumes: [],
          chapters: [],
          risks: calls.length === 1 ? '需要复核' : ['需要复核'],
        },
        result: { model: `mock-import-preview-${calls.length}` },
      };
    },
  };
  const tool = new BuildImportPreviewTool(llm as never);
  const output = await tool.run(
    { analysis: { sourceText: 'source synopsis', length: 15, paragraphs: ['source synopsis'], keywords: ['bridge'] }, requestedAssetTypes: ['projectProfile'] },
    { agentRunId: 'run-import-preview-repair', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.deepEqual(output.risks, ['需要复核']);
});

test('build_import_preview 目标范围扩大时直接失败且不修复', async () => {
  let promptText = '';
  let callCount = 0;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      callCount += 1;
      promptText = messages.map((item) => item.content).join('\n');
      return {
        data: {
          projectProfile: { title: 'Bridge', outline: 'main line' },
          characters: [{ name: 'Lu' }],
          lorebookEntries: [{ title: 'Sea', entryType: 'setting', content: 'inverted sea' }],
          writingRules: [{ title: 'No Slang', ruleType: 'style', content: 'avoid memes' }],
          volumes: [{ volumeNo: 1, title: 'First Tide' }],
          chapters: [{ chapterNo: 1, title: 'Escape', outline: 'fix bridge' }],
          risks: [],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new BuildImportPreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      { analysis: { sourceText: 'source', length: 6, paragraphs: ['source'], keywords: [] }, instruction: '只生成故事大纲', requestedAssetTypes: ['outline'] },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /unrequested import targets/,
  );

  assert.match(promptText, /Requested asset types: outline/);
  assert.equal(callCount, 1);
});

test('CrossTargetConsistencyCheckTool 检出角色动机冲突和目标混放', async () => {
  const tool = new CrossTargetConsistencyCheckTool();
  const output = await tool.run(
    {
      preview: {
        requestedAssetTypes: ['outline', 'characters', 'worldbuilding', 'writingRules'],
        projectProfile: { outline: '林澈拒绝杀人，但危机将迫使他面对底线。' },
        characters: [{ name: '林澈', roleType: 'protagonist', motivation: '拒绝杀人，害怕再次动手。' }],
        lorebookEntries: [{ title: '禁止现代网络词', entryType: 'style', content: '不要使用网络流行语，保持冷峻口吻。' }],
        writingRules: [{ title: '雾城记忆规则', ruleType: 'setting', content: '雾城居民会记忆褪色。' }],
        volumes: [],
        chapters: [{ chapterNo: 1, title: '雨夜守卫', outline: '林澈主动杀死守卫并进入档案馆。' }],
        risks: [],
      },
      instruction: '检查目标产物是否冲突',
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(tool.name, 'cross_target_consistency_check');
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.equal(tool.riskLevel, 'low');
  assert.equal(output.valid, false);
  assert.equal(output.summary.status, 'likely_conflict');
  assert.ok(output.issues.some((issue) => issue.dimension === 'character_outline' && issue.severity === 'error' && issue.message.includes('林澈')));
  assert.ok(output.issues.some((issue) => issue.dimension === 'worldbuilding_writing_rules' && issue.message.includes('写作规则')));
  assert.ok(output.issues.some((issue) => issue.dimension === 'worldbuilding_writing_rules' && issue.message.includes('世界设定')));
});

test('MergeImportPreviewsTool 未选择目标产物时输出空预览', async () => {
  const tool = new MergeImportPreviewsTool();
  const output = await tool.run(
    {
      outlinePreview: { projectProfile: { outline: 'main line' }, chapters: [{ chapterNo: 1, title: '一' }] },
      charactersPreview: { characters: [{ name: 'Lu' }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.deepEqual(output.requestedAssetTypes, []);
  assert.deepEqual(output.projectProfile, {});
  assert.deepEqual(output.characters, []);
  assert.deepEqual(output.chapters, []);
});

test('MergeImportPreviewsTool 单选大纲只合并 outline/volumes/chapters', async () => {
  const tool = new MergeImportPreviewsTool();
  const output = await tool.run(
    {
      requestedAssetTypes: ['outline'],
      projectProfilePreview: { projectProfile: { title: 'Should not leak' } },
      outlinePreview: {
        projectProfile: { title: 'Ignore title', outline: 'main line' },
        volumes: [{ volumeNo: '1', title: { primary: '第一卷' } }],
        chapters: [{ chapterNo: '1', title: '开局', outline: { summary: '逃离' } }],
        risks: ['章节数量需复核'],
      },
      charactersPreview: { characters: [{ name: 'Lu' }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.deepEqual(output.requestedAssetTypes, ['outline']);
  assert.equal(output.projectProfile.title, undefined);
  assert.equal(output.projectProfile.outline, 'main line');
  assert.equal(output.volumes[0].title, '第一卷');
  assert.equal(output.chapters[0].outline, '逃离');
  assert.deepEqual(output.characters, []);
  assert.deepEqual(output.risks, ['[outline] 章节数量需复核']);
});

test('MergeImportPreviewsTool 双目标合并并对写作规则去重', async () => {
  const tool = new MergeImportPreviewsTool();
  const output = await tool.run(
    {
      requestedAssetTypes: ['outline', 'writingRules'],
      outlinePreview: { projectProfile: { outline: 'main line' }, chapters: [{ chapterNo: 1, title: '开局' }] },
      writingRulesPreview: {
        writingRules: [
          { title: 'No Slang', ruleType: 'style', content: 'avoid memes', severity: 'warn' },
          { title: 'No Slang', ruleType: 'style', content: 'duplicate' },
        ],
      },
      worldbuildingPreview: { lorebookEntries: [{ title: 'Sea', entryType: 'setting', content: 'inverted sea' }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.deepEqual(output.requestedAssetTypes, ['outline', 'writingRules']);
  assert.equal(output.writingRules.length, 1);
  assert.equal(output.writingRules[0].severity, 'warning');
  assert.deepEqual(output.lorebookEntries, []);
  assert.ok(output.risks.some((risk) => risk.includes('写作规则存在同名预览')));
});

test('MergeImportPreviewsTool 全套合并并对角色和世界设定去重', async () => {
  const tool = new MergeImportPreviewsTool();
  const output = await tool.run(
    {
      requestedAssetTypes: ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'],
      projectProfilePreview: { projectProfile: { title: 'Bridge', genre: ['fantasy', 'engineering'], outline: 'ignore outline' } },
      outlinePreview: { projectProfile: { outline: 'main line' }, volumes: [{ volumeNo: 1, title: '第一卷' }], chapters: [{ chapterNo: 1, title: '开局' }] },
      charactersPreview: { characters: [{ name: 'Lu' }, { name: 'Lu', roleType: 'duplicate' }] },
      worldbuildingPreview: { lorebookEntries: [{ title: 'Sea', entryType: 'setting', content: 'inverted sea' }, { title: 'Sea', entryType: 'setting', content: 'duplicate' }] },
      writingRulesPreview: { writingRules: [{ title: 'No Slang', ruleType: 'style', content: 'avoid memes' }] },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(output.projectProfile.title, 'Bridge');
  assert.equal(output.projectProfile.genre, 'fantasy、engineering');
  assert.equal(output.projectProfile.outline, 'main line');
  assert.equal(output.characters.length, 1);
  assert.equal(output.lorebookEntries.length, 1);
  assert.equal(output.writingRules.length, 1);
  assert.ok(output.risks.some((risk) => risk.includes('角色存在同名预览')));
  assert.ok(output.risks.some((risk) => risk.includes('世界设定存在同名预览')));
});

test('MergeImportPreviewsTool Manifest 向 Planner 声明只合并不写库', () => {
  const tool = new MergeImportPreviewsTool();
  assert.equal(tool.requiresApproval, false);
  assert.deepEqual(tool.sideEffects, []);
  assert.deepEqual(tool.allowedModes, ['plan', 'act']);
  assert.equal(tool.manifest?.riskLevel, 'low');
  assert.ok(tool.manifest?.whenNotToUse.some((item) => item.includes('不写库')));
  assert.ok(tool.manifest?.examples?.[0]?.plan.some((step) => step.tool === 'merge_import_previews'));
});

test('PersistProjectAssetsTool normalizes legacy object and array scalar fields before writing', async () => {
  const projectUpdates: Array<{ data: Record<string, unknown> }> = [];
  const createdCharacters: Array<Record<string, unknown>> = [];
  const createdLorebookEntries: Array<Record<string, unknown>> = [];
  const createdWritingRules: Array<Record<string, unknown>> = [];
  const upsertedVolumes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const createdChapters: Array<Record<string, unknown>> = [];
  const tx = {
    project: { async update(args: { data: Record<string, unknown> }) { projectUpdates.push(args); } },
    character: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdCharacters.push(args.data);
        return args.data;
      },
    },
    lorebookEntry: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdLorebookEntries.push(args.data);
        return args.data;
      },
    },
    writingRule: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdWritingRules.push(args.data);
        return args.data;
      },
    },
    volume: {
      async upsert(args: { create: Record<string, unknown>; update: Record<string, unknown> }) {
        upsertedVolumes.push(args);
        return { id: `v${args.create.volumeNo}` };
      },
    },
    chapter: {
      async findUnique() { return null; },
      async create(args: { data: Record<string, unknown> }) {
        createdChapters.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    async $transaction<T>(fn: (txClient: typeof tx) => Promise<T>) {
      return fn(tx);
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const tool = new PersistProjectAssetsTool(prisma as never, cache as never);
  const result = await tool.run(
    {
      preview: {
        projectProfile: {
          title: { primary: 'Bridge', alternatives: ['Alt Bridge'] } as unknown as string,
          genre: ['fantasy', 'engineering'] as unknown as string,
          tone: { primary: 'epic', secondary: ['survival'] } as unknown as string,
        },
        characters: [{ name: { value: 'Lu' } as unknown as string, roleType: ['lead', 'engineer'] as unknown as string }],
        lorebookEntries: [{ title: { name: 'Sea' } as unknown as string, entryType: ['setting'] as unknown as string, content: { summary: 'inverted sea' } as unknown as string }],
        writingRules: [{ title: { primary: 'No Modern Slang' } as unknown as string, ruleType: ['style'] as unknown as string, content: { summary: 'avoid memes' } as unknown as string, severity: 'warn' as unknown as 'warning' }],
        volumes: [{ volumeNo: '1' as unknown as number, title: { primary: 'First Tide' } as unknown as string }],
        chapters: [{ chapterNo: '1' as unknown as number, volumeNo: '1' as unknown as number, title: { primary: 'Escape' } as unknown as string, outline: { summary: 'fix bridge' } as unknown as string }],
        risks: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(projectUpdates[0].data.title, 'Bridge');
  assert.equal(projectUpdates[0].data.genre, 'fantasy、engineering');
  assert.equal(projectUpdates[0].data.tone, 'epic');
  assert.equal(createdCharacters[0].name, 'Lu');
  assert.equal(createdCharacters[0].roleType, 'lead、engineer');
  assert.equal(createdLorebookEntries[0].title, 'Sea');
  assert.equal(createdLorebookEntries[0].content, 'inverted sea');
  assert.equal(createdWritingRules[0].title, 'No Modern Slang');
  assert.equal(createdWritingRules[0].severity, 'warning');
  assert.equal(upsertedVolumes[0].create.title, 'First Tide');
  assert.equal(createdChapters[0].title, 'Escape');
  assert.equal(createdChapters[0].outline, 'fix bridge');
  assert.equal(result.characterCreatedCount, 1);
});

test('PersistProjectAssetsTool 按 requestedAssetTypes 阻止未选择资产写入', async () => {
  const projectUpdates: Array<{ data: Record<string, unknown> }> = [];
  const createdCharacters: Array<Record<string, unknown>> = [];
  const createdLorebookEntries: Array<Record<string, unknown>> = [];
  const createdWritingRules: Array<Record<string, unknown>> = [];
  const upsertedVolumes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const createdChapters: Array<Record<string, unknown>> = [];
  const tx = {
    project: { async update(args: { data: Record<string, unknown> }) { projectUpdates.push(args); } },
    character: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdCharacters.push(args.data);
        return args.data;
      },
    },
    lorebookEntry: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdLorebookEntries.push(args.data);
        return args.data;
      },
    },
    writingRule: {
      async findMany() { return []; },
      async create(args: { data: Record<string, unknown> }) {
        createdWritingRules.push(args.data);
        return args.data;
      },
    },
    volume: {
      async upsert(args: { create: Record<string, unknown>; update: Record<string, unknown> }) {
        upsertedVolumes.push(args);
        return { id: `v${args.create.volumeNo}` };
      },
    },
    chapter: {
      async findUnique() { return null; },
      async create(args: { data: Record<string, unknown> }) {
        createdChapters.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    async $transaction<T>(fn: (txClient: typeof tx) => Promise<T>) {
      return fn(tx);
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const tool = new PersistProjectAssetsTool(prisma as never, cache as never);
  const result = await tool.run(
    {
      preview: {
        requestedAssetTypes: ['outline'],
        projectProfile: { title: '不应写入标题', outline: '主线' },
        characters: [{ name: '不应写入角色' }],
        lorebookEntries: [{ title: '不应写入设定', entryType: 'setting', content: '设定' }],
        writingRules: [{ title: '不应写入规则', ruleType: 'style', content: '规则' }],
        volumes: [{ volumeNo: 1, title: '卷一' }],
        chapters: [{ chapterNo: 1, volumeNo: 1, title: '第一章', outline: '起点' }],
        risks: [],
      },
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} },
  );

  assert.equal(projectUpdates[0].data.title, undefined);
  assert.equal(projectUpdates[0].data.outline, '主线');
  assert.equal(createdCharacters.length, 0);
  assert.equal(createdLorebookEntries.length, 0);
  assert.equal(createdWritingRules.length, 0);
  assert.equal(upsertedVolumes.length, 1);
  assert.equal(createdChapters.length, 1);
  assert.equal(result.characterCreatedCount, 0);
  assert.equal(result.lorebookCreatedCount, 0);
  assert.equal(result.writingRuleCreatedCount, 0);
  assert.equal(result.chapterCreatedCount, 1);
});

test('Planner 归一化 LLM Plan 时强制使用 act mode', () => {
  const tools = { list: () => [createTool({ name: 'echo_report', requiresApproval: false, sideEffects: [] })] } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ mode: string }> };
  };
  const plan = planner.validateAndNormalizeLlmPlan(
    { taskType: 'general', summary: '测试', assumptions: [], risks: [], steps: [{ stepNo: 1, name: '报告', tool: 'echo_report', mode: 'plan', requiresApproval: false, args: { message: 'ok' } }] },
    { taskType: 'general', summary: 'baseline', assumptions: [], risks: [] },
  );

  assert.equal(plan.steps[0].mode, 'act');
});

test('Planner rejects unknown exact template references', () => {
  const tools = { list: () => [createTool({ name: 'analyze_source_text', requiresApproval: false, sideEffects: [] })] } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => void;
  };

  assert.throws(
    () => planner.validateAndNormalizeLlmPlan(
      {
        taskType: 'project_import_preview',
        summary: '导入预览',
        assumptions: [],
        risks: [],
        steps: [{ stepNo: 1, name: '分析文案', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{user.providedSourceText}}' } }],
      },
      { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    ),
    /未知模板引用/,
  );
});

test('Planner 为导入预览计划补齐审批后写入步骤，避免确认执行只跑只读预览', () => {
  const tools = {
    list: () => [
      createTool({ name: 'read_source_document', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'analyze_source_text', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'build_import_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'validate_imported_assets', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'persist_project_assets', requiresApproval: true, sideEffects: ['update_project_profile'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ stepNo: number; tool: string; requiresApproval: boolean; args: Record<string, unknown> }>; requiredApprovals: Array<{ target?: { stepNos?: number[]; tools?: string[] } }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '导入预览',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
        { stepNo: 3, name: '生成导入预览', tool: 'build_import_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}', requestedAssetTypes: ['outline'] } },
        { stepNo: 4, name: '校验导入预览', tool: 'validate_imported_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_preview', 'validate_imported_assets', 'persist_project_assets']);
  assert.equal(plan.steps[4].requiresApproval, true);
  assert.deepEqual(plan.steps[4].args, { preview: '{{steps.3.output}}' });
  assert.deepEqual(plan.requiredApprovals[0].target?.stepNos, [5]);
  assert.deepEqual(plan.requiredApprovals[0].target?.tools, ['persist_project_assets']);
});

test('Planner 为分目标导入计划补齐 merge 后校验和审批写入步骤', () => {
  const tools = {
    list: () => [
      createTool({ name: 'read_source_document', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'analyze_source_text', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_import_outline_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_import_writing_rules_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'merge_import_previews', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'validate_imported_assets', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'persist_project_assets', requiresApproval: true, sideEffects: ['update_project_profile'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ stepNo: number; tool: string; requiresApproval: boolean; args: Record<string, unknown> }>; requiredApprovals: Array<{ target?: { stepNos?: number[]; tools?: string[] } }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '分目标导入预览',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
        { stepNo: 3, name: '生成大纲预览', tool: 'generate_import_outline_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 4, name: '生成写作规则预览', tool: 'generate_import_writing_rules_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 5, name: '合并预览', tool: 'merge_import_previews', mode: 'act', requiresApproval: false, args: { requestedAssetTypes: ['outline', 'writingRules'], outlinePreview: '{{steps.3.output}}', writingRulesPreview: '{{steps.4.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'generate_import_outline_preview', 'generate_import_writing_rules_preview', 'merge_import_previews', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[4].args, { requestedAssetTypes: ['outline', 'writingRules'], outlinePreview: '{{steps.3.output}}', writingRulesPreview: '{{steps.4.output}}' });
  assert.deepEqual(plan.steps[5].args, { preview: '{{steps.5.output}}' });
  assert.deepEqual(plan.steps[6].args, { preview: '{{steps.5.output}}' });
  assert.equal(plan.steps[6].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0].target?.stepNos, [7]);
});

test('Planner 按结构化 requestedAssetTypes 裁掉未选择的导入目标 Tool', () => {
  const tools = {
    list: () => [
      createTool({ name: 'read_source_document', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'analyze_source_text', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_import_outline_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_import_characters_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'merge_import_previews', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'validate_imported_assets', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'persist_project_assets', requiresApproval: true, sideEffects: ['update_project_profile'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => { steps: Array<{ stepNo: number; tool: string; requiresApproval: boolean; args: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '只导入大纲',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
        { stepNo: 3, name: '生成大纲预览', tool: 'generate_import_outline_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 4, name: '错误生成角色预览', tool: 'generate_import_characters_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 5, name: '合并预览', tool: 'merge_import_previews', mode: 'act', requiresApproval: false, args: { requestedAssetTypes: ['outline', 'characters'], outlinePreview: '{{steps.3.output}}', charactersPreview: '{{steps.4.output}}' } },
        { stepNo: 6, name: '校验预览', tool: 'validate_imported_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.5.output}}' } },
        { stepNo: 7, name: '审批写入', tool: 'persist_project_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.5.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline'] } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'generate_import_outline_preview', 'merge_import_previews', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[3].args, { requestedAssetTypes: ['outline'], outlinePreview: '{{steps.3.output}}' });
  assert.deepEqual(plan.steps[4].args, { preview: '{{steps.4.output}}' });
  assert.deepEqual(plan.steps[5].args, { preview: '{{steps.4.output}}' });
  assert.equal(plan.steps[5].requiresApproval, true);
});

test('Planner 单选大纲只编排对应目标 Tool', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '只导入大纲',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline'] } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_brief', 'generate_import_outline_preview', 'merge_import_previews', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[2].args, { analysis: '{{steps.2.output}}', instruction: '{{context.userMessage}}', requestedAssetTypes: ['outline'], projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[3].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[4].args, { requestedAssetTypes: ['outline'], outlinePreview: '{{steps.4.output}}' });
  assert.deepEqual(plan.steps[5].args, { preview: '{{steps.5.output}}', instruction: '{{context.userMessage}}' });
  assert.deepEqual(plan.steps[6].args, { preview: '{{steps.5.output}}' });
  assert.deepEqual(plan.steps[7].args, { preview: '{{steps.5.output}}' });
  assert.equal(plan.steps[7].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0].target?.tools, ['persist_project_assets']);
  assert.equal(plan.steps.some((step) => ['generate_import_characters_preview', 'generate_import_worldbuilding_preview', 'generate_import_writing_rules_preview', 'build_import_preview'].includes(step.tool)), false);
});

test('Planner 替换 fallback 时保持 validate 后审批写入顺序', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: 'LLM 使用旧导入 fallback',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
        { stepNo: 3, name: '旧预览', tool: 'build_import_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}', requestedAssetTypes: ['outline'] } },
        { stepNo: 4, name: '旧校验', tool: 'validate_imported_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
        { stepNo: 5, name: '旧写入', tool: 'persist_project_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline'] } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_brief', 'generate_import_outline_preview', 'merge_import_previews', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[3].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[5].args, { preview: '{{steps.5.output}}', instruction: '{{context.userMessage}}' });
  assert.deepEqual(plan.steps[6].args, { preview: '{{steps.5.output}}' });
  assert.deepEqual(plan.steps[7].args, { preview: '{{steps.5.output}}' });
  assert.equal(plan.steps[7].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0].target?.stepNos, [8]);
});

test('Planner 双选大纲和写作规则只编排两个对应目标 Tool', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '只导入大纲和写作规则',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline', 'writingRules'] } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_brief', 'generate_import_outline_preview', 'generate_import_writing_rules_preview', 'merge_import_previews', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[2].args, { analysis: '{{steps.2.output}}', instruction: '{{context.userMessage}}', requestedAssetTypes: ['outline', 'writingRules'], projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[3].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[4].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[5].args, { requestedAssetTypes: ['outline', 'writingRules'], outlinePreview: '{{steps.4.output}}', writingRulesPreview: '{{steps.5.output}}' });
  assert.deepEqual(plan.steps[6].args, { preview: '{{steps.6.output}}', instruction: '{{context.userMessage}}' });
  assert.deepEqual(plan.steps[7].args, { preview: '{{steps.6.output}}' });
  assert.deepEqual(plan.steps[8].args, { preview: '{{steps.6.output}}' });
  assert.equal(plan.steps[8].requiresApproval, true);
  assert.equal(plan.steps.some((step) => ['generate_import_project_profile_preview', 'generate_import_characters_preview', 'generate_import_worldbuilding_preview', 'build_import_preview'].includes(step.tool)), false);
});

test('Planner 全套目标可编排五个专用导入 Tool', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const requestedAssetTypes = ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'];
  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '导入全套目标产物',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes, importPreviewMode: 'deep' } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'read_source_document',
    'analyze_source_text',
    'build_import_brief',
    'generate_import_project_profile_preview',
    'generate_import_outline_preview',
    'generate_import_characters_preview',
    'generate_import_worldbuilding_preview',
    'generate_import_writing_rules_preview',
    'merge_import_previews',
    'cross_target_consistency_check',
    'validate_imported_assets',
    'persist_project_assets',
  ]);
  assert.deepEqual(plan.steps[2].args, {
    analysis: '{{steps.2.output}}',
    instruction: '{{context.userMessage}}',
    requestedAssetTypes,
    projectContext: '{{context.project}}',
  });
  assert.deepEqual(plan.steps[3].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[4].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[5].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[6].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[7].args, { analysis: '{{steps.2.output}}', importBrief: '{{steps.3.output}}', instruction: '{{context.userMessage}}', projectContext: '{{context.project}}' });
  assert.deepEqual(plan.steps[8].args, {
    requestedAssetTypes,
    projectProfilePreview: '{{steps.4.output}}',
    outlinePreview: '{{steps.5.output}}',
    charactersPreview: '{{steps.6.output}}',
    worldbuildingPreview: '{{steps.7.output}}',
    writingRulesPreview: '{{steps.8.output}}',
  });
  assert.deepEqual(plan.steps[9].args, { preview: '{{steps.9.output}}', instruction: '{{context.userMessage}}' });
  assert.deepEqual(plan.steps[10].args, { preview: '{{steps.9.output}}' });
  assert.deepEqual(plan.steps[11].args, { preview: '{{steps.9.output}}' });
  assert.deepEqual(plan.requiredApprovals[0].target?.stepNos, [12]);
});

test('Planner quick importPreviewMode prefers build_import_preview even when target tools are available', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };
  const requestedAssetTypes = ['outline', 'writingRules'];

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: 'Quick import preview',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: 'Read', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: 'Analyze', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
        { stepNo: 3, name: 'Outline', tool: 'generate_import_outline_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 4, name: 'Rules', tool: 'generate_import_writing_rules_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.2.output}}' } },
        { stepNo: 5, name: 'Merge', tool: 'merge_import_previews', mode: 'act', requiresApproval: false, args: { requestedAssetTypes, outlinePreview: '{{steps.3.output}}', writingRulesPreview: '{{steps.4.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes, importPreviewMode: 'quick' } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_preview', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[2].args, { analysis: '{{steps.2.output}}', instruction: '{{context.userMessage}}', requestedAssetTypes });
  assert.equal(plan.steps.some((step) => step.tool.startsWith('generate_import_') || step.tool === 'merge_import_previews' || step.tool === 'build_import_brief'), false);
  assert.equal(plan.steps[5].requiresApproval, true);
});

test('Planner auto importPreviewMode uses deep for one or two targets', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: 'Auto single target',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: 'Read', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: 'Analyze', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline'], importPreviewMode: 'auto' } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_brief', 'generate_import_outline_preview', 'merge_import_previews', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.equal(plan.steps.some((step) => step.tool === 'build_import_preview'), false);
});

test('Planner auto importPreviewMode uses quick fallback for more than two targets', () => {
  const tools = createProjectImportToolRegistry();
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };
  const requestedAssetTypes = ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'];

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: 'Auto multi target',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: 'Read', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: 'Analyze', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes, importPreviewMode: 'auto' } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_preview', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[2].args, { analysis: '{{steps.2.output}}', instruction: '{{context.userMessage}}', requestedAssetTypes });
  assert.equal(plan.steps.some((step) => step.tool.startsWith('generate_import_') || step.tool === 'merge_import_previews' || step.tool === 'build_import_brief'), false);
});

test('Planner 缺少专用目标 Tool 时回退到 build_import_preview 且保持目标范围', () => {
  const tools = createProjectImportToolRegistry([], true);
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }, context?: unknown) => ImportPlannerTestPlan;
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'project_import_preview',
      summary: '专用工具缺失时导入',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取文档', tool: 'read_source_document', mode: 'act', requiresApproval: false, args: { attachmentUrl: '{{context.attachments.0.url}}' } },
        { stepNo: 2, name: '分析文档', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{steps.1.output.sourceText}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    { session: { requestedAssetTypes: ['outline', 'writingRules'] } },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['read_source_document', 'analyze_source_text', 'build_import_preview', 'cross_target_consistency_check', 'validate_imported_assets', 'persist_project_assets']);
  assert.deepEqual(plan.steps[2].args, { analysis: '{{steps.2.output}}', instruction: '{{context.userMessage}}', requestedAssetTypes: ['outline', 'writingRules'] });
  assert.deepEqual(plan.steps[3].args, { preview: '{{steps.3.output}}', instruction: '{{context.userMessage}}' });
  assert.deepEqual(plan.steps[4].args, { preview: '{{steps.3.output}}' });
  assert.deepEqual(plan.steps[5].args, { preview: '{{steps.3.output}}' });
  assert.equal(plan.steps[5].requiresApproval, true);
});

test('Planner 接受 LLM 语义判定的 taskType，不再被后端 baseline 锁死', () => {
  const toolNames = ['resolve_chapter', 'collect_chapter_context', 'write_chapter', 'polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'];
  const tools = { list: () => toolNames.map((name) => createTool({ name, requiresApproval: !['resolve_chapter', 'collect_chapter_context'].includes(name), sideEffects: name === 'resolve_chapter' || name === 'collect_chapter_context' ? [] : ['write'] })) } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string }> };
  };
  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'chapter_write',
      summary: '章节写作计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '解析章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterNo: 1 } },
        { stepNo: 2, name: '收集上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
        { stepNo: 3, name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: '帮我写第一章内容' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'chapter_write');
  assert.deepEqual(plan.steps.slice(0, 3).map((step) => step.tool), ['resolve_chapter', 'collect_chapter_context', 'write_chapter']);
});

test('Planner prompt 将长章节细纲引导到 outline_design 而非正文写作', async () => {
  let capturedMessages: Array<{ role: string; content: string }> = [];
  let capturedOptions: { timeoutMs?: number } | undefined;
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_outline_preview', description: '生成卷/章节细纲与执行卡预览，章节细纲每章一次 LLM。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', description: '生成卷大纲与卷内支线，不固定单元故事章节。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', description: '独立生成单元故事计划和章节分配。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'segment_chapter_outline_batches', description: '把整卷章节细纲按 storyUnit 或连续章节段切成可见批次。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_batch_preview', description: '一次生成连续 3-5 章章节细纲与完整 craftBrief。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_batch_previews', description: '合并批次章节细纲预览为标准 OutlinePreviewOutput。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_preview', description: '生成单章章节细纲与执行卡预览。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_previews', description: '合并单章章节细纲预览。', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_outline', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_chapters', 'update_chapters'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: () => toolList.map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: tool.name === 'generate_volume_outline_preview'
        ? ['卷大纲', '卷细纲', 'storyUnits']
        : tool.name === 'generate_chapter_outline_preview'
          ? ['卷细纲', '章节细纲', '60 章细纲', '执行卡预览']
          : tool.name === 'generate_chapter_outline_batch_preview'
            ? ['60 章细纲', 'chapterCount > 12', 'batch chapter outline']
          : [],
      whenNotToUse: [],
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: { timeoutMs?: number }) {
      capturedMessages = messages;
      capturedOptions = options;
      const batchSteps = Array.from({ length: 15 }, (_, index) => {
        const start = index * 4 + 1;
        const end = start + 3;
        const stepNo = index + 3;
        return {
          stepNo,
          name: `生成第 ${start}-${end} 章细纲批次`,
          tool: 'generate_chapter_outline_batch_preview',
          mode: 'act',
          requiresApproval: false,
          args: {
            context: '{{steps.1.output}}',
            batchPlan: '{{steps.2.output}}',
            instruction: '{{context.userMessage}}',
            volumeNo: 1,
            chapterCount: 60,
            chapterRange: { start, end },
            ...(index > 0 ? { previousBatchTail: `{{steps.${stepNo - 1}.output.chapters.3}}` } : {}),
          },
        };
      });
      return {
        data: {
          taskType: 'outline_design',
          summary: '生成 60 章细纲',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: '巡检上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes', 'chapters'] } },
            { stepNo: 2, name: '切分章节细纲批次', tool: 'segment_chapter_outline_batches', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
            ...batchSteps,
            { stepNo: 18, name: '合并 60 章批次细纲', tool: 'merge_chapter_outline_batch_previews', mode: 'act', requiresApproval: false, args: { batchPreviews: batchSteps.map((step) => `{{steps.${step.stepNo}.output}}`), volumeNo: 1, chapterCount: 60 } },
            { stepNo: 19, name: '校验细纲', tool: 'validate_outline', mode: 'act', requiresApproval: false, args: { preview: '{{steps.18.output}}' } },
            { stepNo: 20, name: '审批后写入细纲', tool: 'persist_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.18.output}}', validation: '{{steps.19.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);

  const plan = await planner.createPlan('为第 1 卷生成 60 章细纲');
  const promptPayload = JSON.parse(capturedMessages[1].content);

  assert.equal(plan.taskType, 'outline_design');
  assert.equal(plan.steps.filter((step) => step.tool === 'generate_chapter_outline_batch_preview').length, 15);
  assert.equal(plan.steps.filter((step) => step.tool === 'generate_chapter_outline_preview').length, 0);
  assert.deepEqual(plan.steps.slice(0, 4).map((step) => step.tool), ['inspect_project_context', 'segment_chapter_outline_batches', 'generate_chapter_outline_batch_preview', 'generate_chapter_outline_batch_preview']);
  assert.equal(plan.steps[1].args.chapterCount, 60);
  assert.deepEqual(plan.steps[2].args.chapterRange, { start: 1, end: 4 });
  assert.deepEqual(plan.steps[16].args.chapterRange, { start: 57, end: 60 });
  assert.equal(plan.steps[17].tool, 'merge_chapter_outline_batch_previews');
  assert.equal((plan.steps[17].args.batchPreviews as unknown[]).length, 15);
  assert.deepEqual(plan.steps[18].args, { preview: '{{steps.18.output}}' });
  assert.deepEqual(plan.steps[19].args, { preview: '{{steps.18.output}}', validation: '{{steps.19.output}}' });
  assert.equal(plan.steps[19].requiresApproval, true);
  assert.equal(capturedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.match(capturedMessages[0].content, /章节细纲 \/ 第 N 卷章节细纲/);
  assert.match(capturedMessages[0].content, /卷细纲 \/ 60 章细纲/);
  assert.match(capturedMessages[0].content, /UPDATED chapter-outline batching rule/);
  assert.match(capturedMessages[0].content, /不要误判为 write_chapter/);
  assert.match(promptPayload.taskTypeGuidance.outline_design, /60章细纲/);
  assert.match(promptPayload.taskTypeGuidance.outline_chapter_batching, /segment_chapter_outline_batches/);
  assert.match(promptPayload.taskTypeGuidance.outline_chapter_batching, /merge_chapter_outline_batch_previews/);
  assert.match(JSON.stringify(promptPayload.availableTools), /generate_chapter_outline_batch_preview/);
});

test('Planner 保留 LLM 返回的卷纲聚合计划', () => {
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_previews', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_outline', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_chapters', 'update_chapters'] }),
    createTool({ name: 'persist_volume_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['upsert_volume'] }),
    createTool({ name: 'persist_volume_character_candidates', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_or_update_volume_characters'] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean; runIf?: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'outline_design',
      summary: '重写卷 1 大纲',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes'] } },
        { stepNo: 2, name: '生成卷 1 新版大纲预览', tool: 'generate_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1 } },
        { stepNo: 3, name: '校验卷 1 大纲预览', tool: 'validate_outline', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
        { stepNo: 4, name: '审批后写入卷 1 大纲', tool: 'persist_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), ['inspect_project_context', 'generate_outline_preview', 'validate_outline', 'persist_outline']);
  assert.equal(plan.steps[1].args.volumeNo, 1);
  assert.equal(plan.steps[1].args.chapterCount, undefined);
  assert.deepEqual(plan.steps[2].args, { preview: '{{steps.2.output}}' });
  assert.equal(plan.steps[2].requiresApproval, false);
  assert.deepEqual(plan.steps[3].args, { preview: '{{steps.2.output}}' });
  assert.equal(plan.steps[3].requiresApproval, true);
  assert.ok(!plan.steps.some((step) => step.tool === 'persist_volume_outline'));
  assert.ok(!plan.steps.some((step) => step.tool === 'persist_volume_character_candidates'));
});

test('Planner 保留 LLM 返回的单元故事预览计划', async () => {
  let promptPayload: Record<string, any> | undefined;
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_story_units', requiresApproval: true, riskLevel: 'high', sideEffects: ['update_volume_story_unit_plan'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolList.filter((tool) => toolNames.includes(tool.name)) : toolList).map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: tool.name === 'generate_story_units_preview' ? ['单元故事', '支线故事', '人物登场', '人物情感', '背景故事'] : [],
      whenNotToUse: [],
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayload = JSON.parse(messages[1].content);
      return {
        data: {
          taskType: 'outline_design',
          summary: '丰富第 1 卷单元故事。',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: '读取上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'characters'] } },
            { stepNo: 2, name: '生成单元故事计划', tool: 'generate_story_units_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1 } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);

  const plan = await planner.createPlan('丰富第 1 卷单元故事，加入人物登场、人物情感和背景故事');

  assert.equal(plan.taskType, 'outline_design');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['inspect_project_context', 'generate_story_units_preview']);
  assert.ok(!plan.steps.some((step) => step.tool === 'generate_chapter_outline_preview'));
  assert.match(promptPayload?.taskTypeGuidance.outline_design, /persist_story_units/);
});

test('Planner 不根据 summary 文本剥掉 LLM 返回的卷纲和单元故事步骤', () => {
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_previews', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_outline', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_chapters', 'update_chapters'] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'outline_design',
      userGoal: '帮我生成第一卷的章节细纲。',
      summary: '基于现有第一卷规划生成章节细纲，在不重写卷纲、不新增单元故事的前提下承接既有规划。',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '巡检上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes', 'chapters'] } },
        { stepNo: 2, name: '错误重跑卷纲', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 3 } },
        { stepNo: 3, name: '错误重跑单元故事', tool: 'generate_story_units_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterCount: 3 } },
        { stepNo: 4, name: '生成第一章细纲', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
      ],
    },
    { taskType: 'general', summary: '处理目标：帮我生成第一卷的章节细纲。', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'inspect_project_context',
    'generate_volume_outline_preview',
    'generate_story_units_preview',
    'generate_chapter_outline_preview',
  ]);
  assert.equal(plan.steps[3].args.volumeOutline, '{{steps.2.output.volume}}');
  assert.equal(plan.steps[3].args.storyUnitPlan, '{{steps.3.output.storyUnitPlan}}');
});

test('Planner 保留单元故事链路中 LLM 返回的写入步骤', async () => {
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_story_units', requiresApproval: true, riskLevel: 'high', sideEffects: ['update_volume_story_unit_plan'] }),
    createTool({ name: 'persist_volume_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['upsert_volume'] }),
    createTool({ name: 'persist_volume_character_candidates', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_or_update_volume_characters'] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean; runIf?: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'outline_design',
      summary: '丰富第 1 卷单元故事',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '读取上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'characters'] } },
        { stepNo: 2, name: '生成卷纲预览', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 60 } },
        { stepNo: 3, name: '生成单元故事计划', tool: 'generate_story_units_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 60 } },
        { stepNo: 4, name: '审批后写入单元故事计划', tool: 'persist_story_units', mode: 'act', requiresApproval: true, args: { preview: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'inspect_project_context',
    'generate_volume_outline_preview',
    'generate_story_units_preview',
    'persist_story_units',
  ]);
  assert.deepEqual(plan.steps[3].args, { preview: '{{steps.3.output}}' });
  assert.ok(!plan.steps.some((step) => step.tool === 'persist_volume_outline'));
  assert.ok(!plan.steps.some((step) => step.tool === 'persist_volume_character_candidates'));
});

test('Planner 不再将残缺单章细纲计划自动展开', () => {
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_previews', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_outline', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_chapters', 'update_chapters'] }),
    createTool({ name: 'persist_volume_character_candidates', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_or_update_volume_characters'] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean; runIf?: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'outline_design',
      summary: '生成 3 章细纲',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '巡检上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline'] } },
        { stepNo: 2, name: '生成第一章细纲', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
        { stepNo: 3, name: '错误提前合并', tool: 'merge_chapter_outline_previews', mode: 'act', requiresApproval: false, args: { previews: ['{{steps.2.output}}'], volumeNo: 1, chapterCount: 3 } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'inspect_project_context',
    'generate_chapter_outline_preview',
    'merge_chapter_outline_previews',
  ]);
  assert.equal(plan.steps[1].args.chapterNo, 1);
  assert.equal(plan.steps[1].args.chapterCount, 3);
  assert.deepEqual(plan.steps[2].args.previews, ['{{steps.2.output}}']);
});

test('Planner does not auto-connect outline artifacts to planned timeline preview', () => {
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_story_units_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'merge_chapter_outline_previews', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_outline', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_chapters', 'update_chapters'] }),
    createTool({ name: 'generate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'outline_design',
      summary: 'Generate outline with planned timeline candidates',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: 'Inspect context', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline'] } },
        { stepNo: 2, name: 'Generate outline', tool: 'generate_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 3 } },
        { stepNo: 3, name: 'Validate outline', tool: 'validate_outline', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
        { stepNo: 4, name: 'Persist outline', tool: 'persist_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'inspect_project_context',
    'generate_outline_preview',
    'validate_outline',
    'persist_outline',
  ]);
  assert.deepEqual(plan.steps[1].args, { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterCount: 3 });
  assert.deepEqual(plan.steps[2].args, { preview: '{{steps.2.output}}' });
  assert.deepEqual(plan.steps[3].args, { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' });
  assert.equal(plan.steps[3].requiresApproval, true);
});

test('Planner connects craftBrief artifacts to planned timeline preview when timeline tools are available', () => {
  const toolList = [
    createTool({ name: 'resolve_chapter', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'collect_chapter_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_craft_brief_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_chapter_craft_brief', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_chapter_craft_brief', requiresApproval: true, riskLevel: 'high', sideEffects: ['update_chapter_craft_brief'] }),
    createTool({ name: 'generate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
  ];
  const tools = { list: () => toolList } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'chapter_craft_brief',
      summary: 'Generate craftBrief and planned timeline candidates',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: 'Resolve chapter', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterNo: 3 } },
        { stepNo: 2, name: 'Collect context', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
        { stepNo: 3, name: 'Generate craftBrief', tool: 'generate_chapter_craft_brief_preview', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: '{{context.userMessage}}' } },
        { stepNo: 4, name: 'Validate craftBrief', tool: 'validate_chapter_craft_brief', mode: 'act', requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
        { stepNo: 5, name: 'Persist craftBrief', tool: 'persist_chapter_craft_brief', mode: 'act', requiresApproval: true, args: { preview: '{{steps.3.output}}', validation: '{{steps.4.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'resolve_chapter',
    'collect_chapter_context',
    'generate_chapter_craft_brief_preview',
    'validate_chapter_craft_brief',
    'generate_timeline_preview',
    'validate_timeline_preview',
    'persist_chapter_craft_brief',
  ]);
  assert.deepEqual(plan.steps[4].args, {
    context: { craftBriefPreview: '{{steps.3.output}}', craftBriefValidation: '{{steps.4.output}}' },
    instruction: '{{context.userMessage}}',
    sourceType: 'craft_brief',
  });
  assert.deepEqual(plan.steps[5].args, {
    preview: '{{steps.5.output}}',
    taskContext: { craftBriefPreview: '{{steps.3.output}}', craftBriefValidation: '{{steps.4.output}}' },
  });
  assert.deepEqual(plan.steps[6].args, { preview: '{{steps.3.output}}', validation: '{{steps.4.output}}' });
  assert.equal(plan.steps[4].requiresApproval, false);
  assert.equal(plan.steps[5].requiresApproval, false);
  assert.equal(plan.steps[6].requiresApproval, true);
});

test('Planner exposes timeline_plan for read-only planned timeline candidates', async () => {
  let promptPayload: Record<string, any> | undefined;
  const toolList = [
    createTool({ name: 'collect_task_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'align_chapter_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_timeline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_timeline_events', requiresApproval: true, riskLevel: 'high', sideEffects: ['Writes TimelineEvent rows after validation and approval.'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: () => toolList.map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: tool.name === 'generate_timeline_preview' ? ['planned timeline from outline/craftBrief artifacts'] : [],
      whenNotToUse: [],
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayload = JSON.parse(messages[1].content);
      return {
        data: {
          taskType: 'timeline_plan',
          summary: 'Generate planned timeline candidates',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Collect planning artifacts', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'timeline_plan', focus: ['outline', 'chapters', 'craftBrief'] } },
            { stepNo: 2, name: 'Generate planned timeline preview', tool: 'generate_timeline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', sourceType: 'book_outline' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);

  const plan = await planner.createPlan('从现有大纲和 craftBrief 生成计划时间线候选');

  assert.equal(plan.taskType, 'timeline_plan');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['collect_task_context', 'generate_timeline_preview', 'validate_timeline_preview']);
  assert.deepEqual(plan.steps[2].args, { preview: '{{steps.2.output}}', taskContext: '{{steps.1.output}}' });
  assert.deepEqual(plan.requiredApprovals, []);
  assert.ok(promptPayload?.availableTaskTypes.includes('timeline_plan'));
  assert.match(promptPayload?.taskTypeGuidance.timeline_plan, /generate_timeline_preview/);
  assert.match(promptPayload?.taskTypeGuidance.timeline_plan, /validate_timeline_preview/);
});

test('Planner graph feature flag scopes createPlan to selected bundle tools', async () => {
  const previousFlag = process.env.AGENT_PLANNER_GRAPH_ENABLED;
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const promptPayloads: Array<Record<string, any>> = [];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({
      name,
      requiresApproval: name.startsWith('persist_') || name === 'write_chapter' || name === 'rewrite_chapter' || name === 'write_chapter_series',
      riskLevel: name.startsWith('persist_') || name === 'write_chapter' ? 'high' : 'low',
      sideEffects: name.startsWith('persist_') || name === 'write_chapter' ? ['write'] : [],
    })),
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : allBundleToolNames).map((name) => ({
      name,
      displayName: name,
      description: name,
      whenToUse: [`Use ${name}`],
      whenNotToUse: [],
      allowedModes: ['plan', 'act'],
      riskLevel: name.startsWith('persist_') || name === 'write_chapter' ? 'high' : 'low',
      requiresApproval: name.startsWith('persist_') || name === 'write_chapter' || name === 'rewrite_chapter' || name === 'write_chapter_series',
      sideEffects: name.startsWith('persist_') || name === 'write_chapter' ? ['write'] : [],
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayloads.push(JSON.parse(messages[1].content));
      return {
        data: {
          taskType: 'outline_design',
          summary: 'Volume outline plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect project context', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline'] } },
            { stepNo: 2, name: 'Generate volume outline preview', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}' } },
            { stepNo: 3, name: 'Persist approved volume outline', tool: 'persist_volume_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          ],
        },
        result: { model: 'planner-mock', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      };
    },
  };

  try {
    process.env.AGENT_PLANNER_GRAPH_ENABLED = 'true';
    const graphPlanner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never, new AgentPlannerGraphService(), new PlanValidatorService());
    const graphPlan = await graphPlanner.createPlan('重写第1卷卷大纲，不生成章节细纲');

    assert.equal(promptPayloads.length, 1);
    const promptToolNames = (promptPayloads[0].availableTools as Array<Record<string, unknown>>).map((tool) => tool.name);
    assert.deepEqual(promptToolNames, ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates']);
    assert.ok(!promptToolNames.includes('write_chapter'));
    assert.equal(graphPlan.plannerDiagnostics?.source, 'langgraph_supervisor');
    assert.equal(graphPlan.plannerDiagnostics?.legacySource, 'llm');
    assert.equal((graphPlan.plannerDiagnostics?.toolBundle as Record<string, any>).name, 'outline.volume');
    assert.deepEqual(graphPlan.plannerDiagnostics?.selectedToolNames, ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates']);
    assert.deepEqual(
      (graphPlan.plannerDiagnostics?.graphNodes as Array<{ name: string }>).map((node) => node.name),
      ['classifyIntent', 'outlineSupervisor', 'selectToolBundle', 'domainPlanner'],
    );
  } finally {
    if (previousFlag === undefined) delete process.env.AGENT_PLANNER_GRAPH_ENABLED;
    else process.env.AGENT_PLANNER_GRAPH_ENABLED = previousFlag;
  }
});

test('ASP-P9-001 graph planner defaults on for test/local and remains closable', async () => {
  const previousFlag = process.env.AGENT_PLANNER_GRAPH_ENABLED;
  const previousNodeEnv = process.env.NODE_ENV;
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({
      name,
      requiresApproval: name.startsWith('persist_') || name === 'write_chapter' || name === 'rewrite_chapter' || name === 'write_chapter_series',
      riskLevel: name.startsWith('persist_') || name === 'write_chapter' ? 'high' : 'low',
      sideEffects: name.startsWith('persist_') || name === 'write_chapter' ? ['write'] : [],
    })),
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : allBundleToolNames).map((name) => ({
      name,
      displayName: name,
      description: name,
      whenToUse: [`Use ${name}`],
      whenNotToUse: [],
      allowedModes: ['plan', 'act'],
      riskLevel: name.startsWith('persist_') || name === 'write_chapter' ? 'high' : 'low',
      requiresApproval: name.startsWith('persist_') || name === 'write_chapter' || name === 'rewrite_chapter' || name === 'write_chapter_series',
      sideEffects: name.startsWith('persist_') || name === 'write_chapter' ? ['write'] : [],
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson() {
      return {
        data: {
          taskType: 'outline_design',
          summary: 'Graph default volume outline plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect project context', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline'] } },
            { stepNo: 2, name: 'Generate volume outline preview', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}' } },
            { stepNo: 3, name: 'Persist approved volume outline', tool: 'persist_volume_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          ],
        },
        result: { model: 'planner-mock', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      };
    },
  };
  const createPlanner = () => new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never, new AgentPlannerGraphService(), new PlanValidatorService());

  try {
    delete process.env.AGENT_PLANNER_GRAPH_ENABLED;
    process.env.NODE_ENV = 'test';
    const testDefault = await createPlanner().createPlan('重写第1卷卷大纲，不生成章节细纲');
    assert.equal(testDefault.plannerDiagnostics?.source, 'langgraph_supervisor');

    process.env.AGENT_PLANNER_GRAPH_ENABLED = 'false';
    const forcedLegacy = await createPlanner().createPlan('重写第1卷卷大纲，不生成章节细纲');
    assert.equal(forcedLegacy.plannerDiagnostics?.source, 'llm');

    delete process.env.AGENT_PLANNER_GRAPH_ENABLED;
    process.env.NODE_ENV = 'production';
    const productionDefault = await createPlanner().createPlan('重写第1卷卷大纲，不生成章节细纲');
    assert.equal(productionDefault.plannerDiagnostics?.source, 'llm');
  } finally {
    if (previousFlag === undefined) delete process.env.AGENT_PLANNER_GRAPH_ENABLED;
    else process.env.AGENT_PLANNER_GRAPH_ENABLED = previousFlag;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('ToolBundleRegistry resolves core bundles and rejects missing registered tools', () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({
      name,
      requiresApproval: name.startsWith('persist_') || name === 'write_chapter' || name === 'rewrite_chapter' || name === 'write_chapter_series',
      riskLevel: name.startsWith('persist_') ? 'high' : 'low',
      sideEffects: name.startsWith('persist_') ? ['write'] : [],
    })),
  } as unknown as ToolRegistryService;
  const registry = new ToolBundleRegistry(tools);

  registry.assertAllBundlesRegistered();
  for (const bundleName of ['outline.volume', 'outline.chapter', 'writing.chapter', 'writing.series', 'revision.polish', 'revision.rewrite', 'import.project_assets', 'guided.step']) {
    assert.ok(TOOL_BUNDLE_DEFINITIONS.some((definition) => definition.name === bundleName));
    assert.equal(registry.resolveBundle(bundleName).bundleName, bundleName);
  }
  assert.equal(registry.resolveForRoute({ domain: 'outline', intent: 'generate_volume_outline' }).bundleName, 'outline.volume');
  assert.equal(registry.resolveForRoute({ domain: 'outline', intent: 'split_volume_to_chapters' }).bundleName, 'outline.chapter');
  assert.equal(registry.resolveForRoute({ domain: 'guided', intent: 'guided_step_consultation' }).bundleName, 'guided.step');

  const missingVolumePersistTools = {
    list: () => allBundleToolNames
      .filter((name) => name !== 'persist_volume_outline')
      .map((name) => createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [] })),
  } as unknown as ToolRegistryService;
  assert.throws(
    () => new ToolBundleRegistry(missingVolumePersistTools).resolveBundle('outline.volume'),
    /ToolBundle outline\.volume references unregistered tools: persist_volume_outline/,
  );
});

test('ASP-P7-001 writing and revision bundles stay separated by intent', () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({ name, requiresApproval: name.startsWith('write_') || name === 'rewrite_chapter' || name === 'polish_chapter', riskLevel: 'low', sideEffects: [] })),
  } as unknown as ToolRegistryService;
  const registry = new ToolBundleRegistry(tools);

  const singleWrite = registry.resolveForRoute({ domain: 'writing', intent: 'chapter_write' });
  assert.equal(singleWrite.bundleName, 'writing.chapter');
  assert.ok(singleWrite.strictToolNames.includes('write_chapter'));
  assert.ok(!singleWrite.strictToolNames.includes('write_chapter_series'));
  assert.ok(singleWrite.deniedToolNames?.includes('rewrite_chapter'));

  const seriesWrite = registry.resolveForRoute({ domain: 'writing', intent: 'multi_chapter_write' });
  assert.equal(seriesWrite.bundleName, 'writing.series');
  assert.ok(seriesWrite.strictToolNames.includes('write_chapter_series'));
  assert.ok(seriesWrite.deniedToolNames?.includes('write_chapter'));

  const rewrite = registry.resolveForRoute({ domain: 'revision', intent: 'chapter_rewrite' });
  assert.equal(rewrite.bundleName, 'revision.rewrite');
  assert.ok(rewrite.strictToolNames.includes('rewrite_chapter'));
  assert.ok(rewrite.deniedToolNames?.includes('polish_chapter'));

  const polish = registry.resolveForRoute({ domain: 'revision', intent: 'chapter_polish' });
  assert.equal(polish.bundleName, 'revision.polish');
  assert.ok(polish.strictToolNames.includes('polish_chapter'));
  assert.ok(polish.deniedToolNames?.includes('rewrite_chapter'));
});

test('ASP-P7-002 import bundle scopes tools by mode and requested assets', () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const createRegistry = (toolNames = allBundleToolNames) => new ToolBundleRegistry({
    list: () => toolNames.map((name) => createTool({ name, requiresApproval: name.startsWith('persist_'), riskLevel: 'low', sideEffects: [] })),
  } as unknown as ToolRegistryService);
  const route = { domain: 'import' as const, intent: 'project_import_preview' };

  const deepOutline = createRegistry().resolveForRoute(route, { session: { requestedAssetTypes: ['outline'], importPreviewMode: 'deep' } } as AgentContextV2);
  assert.ok(deepOutline.strictToolNames.includes('generate_import_outline_preview'));
  assert.ok(deepOutline.strictToolNames.includes('merge_import_previews'));
  assert.ok(!deepOutline.strictToolNames.includes('build_import_preview'));
  assert.ok(!deepOutline.strictToolNames.includes('generate_import_characters_preview'));

  const quickFull = createRegistry().resolveForRoute(route, { session: { requestedAssetTypes: ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'], importPreviewMode: 'quick' } } as AgentContextV2);
  assert.ok(quickFull.strictToolNames.includes('build_import_preview'));
  assert.ok(!quickFull.strictToolNames.includes('build_import_brief'));
  assert.ok(!quickFull.strictToolNames.includes('generate_import_outline_preview'));

  const autoDual = createRegistry().resolveForRoute(route, { session: { requestedAssetTypes: ['outline', 'writingRules'], importPreviewMode: 'auto' } } as AgentContextV2);
  assert.ok(autoDual.strictToolNames.includes('generate_import_outline_preview'));
  assert.ok(autoDual.strictToolNames.includes('generate_import_writing_rules_preview'));
  assert.ok(!autoDual.strictToolNames.includes('generate_import_characters_preview'));

  assert.throws(
    () => createRegistry(allBundleToolNames.filter((name) => name !== 'generate_import_outline_preview')).resolveForRoute(route, { session: { requestedAssetTypes: ['outline'], importPreviewMode: 'deep' } } as AgentContextV2),
    /ToolBundle import\.project_assets references unregistered tools: generate_import_outline_preview/,
  );
});

test('ASP-P7-003 quality timeline and worldbuilding bundles stay isolated', () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const registry = new ToolBundleRegistry({
    list: () => allBundleToolNames.map((name) => createTool({ name, requiresApproval: name.startsWith('persist_'), riskLevel: 'low', sideEffects: [] })),
  } as unknown as ToolRegistryService);

  const quality = registry.resolveForRoute({ domain: 'quality', intent: 'character_consistency_check' });
  assert.ok(quality.strictToolNames.includes('character_consistency_check'));
  assert.ok(!quality.strictToolNames.includes('write_chapter'));
  assert.ok(!quality.strictToolNames.includes('rewrite_chapter'));
  assert.ok(quality.deniedToolNames?.includes('polish_chapter'));

  const timelinePreview = registry.resolveForRoute({ domain: 'timeline', intent: 'timeline_plan', needsPersistence: false });
  assert.ok(timelinePreview.strictToolNames.includes('generate_timeline_preview'));
  assert.ok(!timelinePreview.strictToolNames.includes('persist_timeline_events'));

  const timelinePersist = registry.resolveForRoute({ domain: 'timeline', intent: 'timeline_plan', needsPersistence: true });
  assert.ok(timelinePersist.strictToolNames.includes('persist_timeline_events'));

  const worldbuilding = registry.resolveForRoute({ domain: 'worldbuilding', intent: 'worldbuilding_expand' });
  assert.equal(worldbuilding.bundleName, 'worldbuilding.expand');
  assert.deepEqual(worldbuilding.strictToolNames.slice(-3), ['generate_worldbuilding_preview', 'validate_worldbuilding', 'persist_worldbuilding']);
  assert.ok(!worldbuilding.strictToolNames.includes('generate_story_bible_preview'));

  const storyBible = registry.resolveForRoute({ domain: 'worldbuilding', intent: 'story_bible_expand' });
  assert.equal(storyBible.bundleName, 'worldbuilding.story_bible');
  assert.deepEqual(storyBible.strictToolNames.slice(-3), ['generate_story_bible_preview', 'validate_story_bible', 'persist_story_bible']);
  assert.ok(!storyBible.strictToolNames.includes('generate_worldbuilding_preview'));
});

test('selectToolBundleNode selects outline and guided bundles with diagnostics', async () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [] })),
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : allBundleToolNames).map((name) => ({
      name,
      displayName: name,
      description: name,
      whenToUse: [],
      whenNotToUse: [],
      allowedModes: ['plan', 'act'],
      riskLevel: 'low',
      requiresApproval: false,
      sideEffects: [],
    })),
  } as unknown as ToolRegistryService;
  const node = createSelectToolBundleNode(new ToolBundleRegistry(tools));
  const baseState = {
    goal: 'route smoke',
    defaults: { taskType: 'general', summary: 'smoke', assumptions: [], risks: [] },
    diagnostics: { graphVersion: 'test', nodes: [] },
  };

  const volume = await node({ ...baseState, route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'] } });
  assert.equal(volume.selectedBundle?.bundleName, 'outline.volume');
  assert.deepEqual(volume.selectedTools?.map((tool) => tool.name), ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates']);
  assert.equal(volume.diagnostics?.selectedToolCount, 4);

  const chapter = await node({ ...baseState, route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'] } });
  assert.equal(chapter.selectedBundle?.bundleName, 'outline.chapter');
  assert.ok(chapter.selectedTools?.some((tool) => tool.name === 'generate_chapter_outline_preview'));

  const guided = await node({
    ...baseState,
    route: { domain: 'writing', intent: 'chapter_write', confidence: 0.9, reasons: ['test'] },
    context: { session: { guided: { currentStep: 'guided_volume' } } } as AgentContextV2,
  });
  assert.equal(guided.selectedBundle?.bundleName, 'guided.step');
  assert.ok(guided.selectedTools?.every((tool) => ['generate_guided_step_preview', 'validate_guided_step_preview', 'persist_guided_step_result', 'inspect_project_context'].includes(tool.name)));
  assert.ok(guided.selectedTools?.some((tool) => tool.name === 'generate_guided_step_preview'));
  assert.ok(guided.selectedTools?.some((tool) => tool.name === 'validate_guided_step_preview'));
  assert.ok(guided.selectedTools?.some((tool) => tool.name === 'persist_guided_step_result'));
});

test('DomainPlanner route prompt uses selected tools and records diagnostics', async () => {
  let promptPayload: Record<string, any> | undefined;
  const toolList = [
    createTool({ name: 'echo_report', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'write_chapter', requiresApproval: true, riskLevel: 'high', sideEffects: ['draft_write'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolNames : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayload = JSON.parse(messages[1].content);
      return {
        data: {
          taskType: 'general',
          summary: 'Selected tool plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Report', tool: 'echo_report', mode: 'act', requiresApproval: false, args: { message: 'ok' } },
          ],
        },
        result: { model: 'planner-mock', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);
  const node = createDomainPlannerNode(planner);
  const selectedBundle = {
    bundleName: 'general.echo',
    strictToolNames: ['echo_report'],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter'],
    selectionReason: 'test',
  };
  const update = await node({
    goal: '需要澄清',
    defaults: { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
    route: { domain: 'general', intent: 'clarify', confidence: 0.4, reasons: ['test'] },
    selectedBundle,
    selectedTools: tools.listManifestsForPlanner(['echo_report']),
    diagnostics: { graphVersion: 'test', nodes: [] },
  });

  assert.deepEqual(promptPayload?.routeDecision, { domain: 'general', intent: 'clarify', confidence: 0.4, reasons: ['test'] });
  assert.deepEqual(promptPayload?.toolBundle, {
    name: 'general.echo',
    selectedToolNames: ['echo_report'],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter'],
  });
  assert.deepEqual((promptPayload?.availableTools as Array<Record<string, unknown>>).map((tool) => tool.name), ['echo_report']);
  assert.doesNotMatch(JSON.stringify(promptPayload?.availableTools), /write_chapter/);
  const diagnostics = update.plan?.plannerDiagnostics as Record<string, any>;
  assert.equal(diagnostics.route.domain, 'general');
  assert.equal(diagnostics.toolBundle.name, 'general.echo');
  assert.ok(update.diagnostics?.nodes.some((item) => item.name === 'domainPlanner'));
});

test('ASP-P8-001 planner diagnostics include scoped route bundle and prompt budget', async () => {
  const toolList = [
    createTool({ name: 'echo_report', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'write_chapter', requiresApproval: true, riskLevel: 'high', sideEffects: ['draft_write'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolNames : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [`Use ${tool.name}`],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson() {
      return {
        data: {
          taskType: 'general',
          summary: 'Selected diagnostics plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Report', tool: 'echo_report', mode: 'act', requiresApproval: false, args: { message: 'ok' } },
          ],
        },
        result: { model: 'planner-mock', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);
  const plan = await planner.createPlanWithTools({
    goal: 'report diagnostics',
    route: { domain: 'general', intent: 'clarify', confidence: 0.41, reasons: ['test'] },
    selectedBundle: {
      bundleName: 'general.echo',
      strictToolNames: ['echo_report'],
      optionalToolNames: [],
      deniedToolNames: ['write_chapter'],
      selectionReason: 'test',
    },
    selectedTools: tools.listManifestsForPlanner(['echo_report']),
  });

  const diagnostics = plan.plannerDiagnostics as Record<string, any>;
  assert.equal(diagnostics.route.domain, 'general');
  assert.equal(diagnostics.route.intent, 'clarify');
  assert.equal(diagnostics.toolBundle.name, 'general.echo');
  assert.equal(diagnostics.toolBundle.selectedToolCount, 1);
  assert.equal(diagnostics.toolBundle.allToolCount, 2);
  assert.deepEqual(diagnostics.selectedToolNames, ['echo_report']);
  assert.deepEqual(diagnostics.allowedToolNames, ['echo_report']);
  assert.ok(diagnostics.promptBudget.selectedToolsChars > 0);
  assert.ok(diagnostics.promptBudget.allToolsChars > diagnostics.promptBudget.selectedToolsChars);
});

test('ASP-P8-001 selectToolBundleNode records graph route bundle and selected tools', async () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [] })),
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : allBundleToolNames).map((name) => ({
      name,
      displayName: name,
      description: name,
      whenToUse: [],
      whenNotToUse: [],
      allowedModes: ['plan', 'act'],
      riskLevel: 'low',
      requiresApproval: false,
      sideEffects: [],
    })),
  } as unknown as ToolRegistryService;
  const node = createSelectToolBundleNode(new ToolBundleRegistry(tools));

  const result = await node({
    goal: 'diagnostics route smoke',
    defaults: { taskType: 'general', summary: 'smoke', assumptions: [], risks: [] },
    route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'] },
    diagnostics: { graphVersion: 'test', nodes: [] },
  });

  const diagnostics = result.diagnostics as Record<string, any>;
  assert.equal(diagnostics.route.domain, 'outline');
  assert.equal(diagnostics.route.intent, 'generate_volume_outline');
  assert.equal(diagnostics.toolBundleName, 'outline.volume');
  assert.deepEqual(diagnostics.selectedToolNames, ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates']);
  assert.ok(diagnostics.allowedToolNames.includes('persist_volume_outline'));
  assert.ok(diagnostics.allowedToolNames.includes('persist_volume_character_candidates'));
  assert.ok(diagnostics.selectedToolsChars > 0);
  assert.ok(diagnostics.allToolsChars > diagnostics.selectedToolsChars);
  assert.deepEqual((diagnostics.nodes as Array<{ name: string }>).map((node) => node.name), ['selectToolBundle']);
});

test('ASP-P8-001 planner failure diagnostics identify validator stage', async () => {
  const toolList = [
    createTool({ name: 'echo_report', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'write_chapter', requiresApproval: true, riskLevel: 'high', sideEffects: ['draft_write'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolNames : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [`Use ${tool.name}`],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson() {
      return {
        data: {
          taskType: 'general',
          summary: 'Invalid selected diagnostics plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Write outside bundle', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: { chapterId: 'c1' } },
          ],
        },
        result: { model: 'planner-mock', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);

  try {
    await planner.createPlanWithTools({
      goal: 'invalid diagnostics',
      route: { domain: 'general', intent: 'clarify', confidence: 0.41, reasons: ['test'] },
      selectedBundle: {
        bundleName: 'general.echo',
        strictToolNames: ['echo_report'],
        optionalToolNames: [],
        deniedToolNames: ['write_chapter'],
        selectionReason: 'test',
      },
      selectedTools: tools.listManifestsForPlanner(['echo_report']),
    });
    assert.fail('Expected scoped planner validation to fail');
  } catch (error) {
    assert.ok(error instanceof AgentPlannerFailedError);
    const diagnostics = error.diagnostics as Record<string, any>;
    assert.equal(diagnostics.route.domain, 'general');
    assert.equal(diagnostics.toolBundle.name, 'general.echo');
    assert.deepEqual(diagnostics.selectedToolNames, ['echo_report']);
    assert.ok(diagnostics.promptBudget.selectedToolsChars > 0);
    assert.ok((diagnostics.failures as Array<Record<string, string>>).some((failure) => failure.stage === 'validator'));
    assert.ok((diagnostics.failures as Array<Record<string, string>>).some((failure) => failure.stage === 'repair_validator'));
  }
});

test('Planner repair selected tools prompt does not return to full manifests', async () => {
  const payloads: Array<Record<string, any>> = [];
  const toolList = [
    createTool({ name: 'echo_report', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'write_chapter', requiresApproval: true, riskLevel: 'high', sideEffects: ['draft_write'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolNames : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      payloads.push(JSON.parse(messages[1].content));
      if (payloads.length === 1) {
        return {
          data: {
            taskType: 'not_allowed',
            summary: 'Invalid first plan.',
            assumptions: [],
            risks: [],
            steps: [
              { stepNo: 1, name: 'Report', tool: 'echo_report', mode: 'act', requiresApproval: false, args: { message: 'invalid' } },
            ],
          },
          result: { model: 'planner-mock' },
        };
      }
      return {
        data: {
          taskType: 'general',
          summary: 'Repaired selected tool plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Report', tool: 'echo_report', mode: 'act', requiresApproval: false, args: { message: 'ok' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);
  const plan = await planner.createPlanWithTools({
    goal: 'repair selected tools',
    route: { domain: 'general', intent: 'clarify', confidence: 0.4, reasons: ['test'] },
    selectedBundle: { bundleName: 'general.echo', strictToolNames: ['echo_report'], optionalToolNames: [], deniedToolNames: ['write_chapter'], selectionReason: 'test' },
    selectedTools: tools.listManifestsForPlanner(['echo_report']),
  });

  assert.equal(plan.plannerDiagnostics?.source, 'llm_repair');
  assert.equal(payloads.length, 2);
  assert.deepEqual((payloads[1].registeredTools as Array<Record<string, unknown>>).map((tool) => tool.name), ['echo_report']);
  assert.deepEqual(payloads[1].toolBundle.selectedToolNames, ['echo_report']);
  assert.doesNotMatch(JSON.stringify(payloads[1].registeredTools), /write_chapter/);
});

function createPlanValidatorPlan(steps: Array<{ tool: string; requiresApproval?: boolean; args?: Record<string, unknown> }>, overrides: Partial<AgentPlanSpec> = {}): AgentPlanSpec {
  return {
    taskType: 'general',
    summary: 'validator test',
    assumptions: [],
    risks: [],
    requiredApprovals: [],
    steps: steps.map((step, index) => ({
      stepNo: index + 1,
      name: step.tool,
      tool: step.tool,
      mode: 'act',
      requiresApproval: step.requiresApproval ?? false,
      args: step.args ?? {},
    })),
    ...overrides,
  };
}

test('PlanValidatorService rejects bundle-outside tools', () => {
  const validator = new PlanValidatorService();
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'echo_report' },
        { tool: 'write_chapter', requiresApproval: true },
      ]),
      selectedBundle: { bundleName: 'general.echo', strictToolNames: ['echo_report'], optionalToolNames: [], selectionReason: 'test' },
    }),
    /bundle-outside tools.*write_chapter/,
  );
});

test('PlanValidatorService rejects write tools without approval', () => {
  const validator = new PlanValidatorService();
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([{ tool: 'write_chapter', requiresApproval: false }]),
    }),
    /write tools without approval: write_chapter/,
  );
});

test('PlanValidatorService rejects route and tool mismatches', () => {
  const validator = new PlanValidatorService();
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([{ tool: 'generate_chapter_outline_preview' }]),
      route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'] },
    }),
    /volume outline route tools: generate_chapter_outline_preview/,
  );
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([{ tool: 'persist_timeline_events', requiresApproval: true }]),
      route: { domain: 'timeline', intent: 'plan_timeline', confidence: 0.9, reasons: ['test'], needsPersistence: false },
    }),
    /timeline preview route tools: persist_timeline_events/,
  );
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([{ tool: 'write_chapter', requiresApproval: true }]),
      route: { domain: 'guided', intent: 'guided_step_consultation', confidence: 0.9, reasons: ['test'] },
    }),
    /guided route tools: write_chapter/,
  );
});

test('PlanValidatorService rejects incomplete outline chapter split plans', () => {
  const validator = new PlanValidatorService();
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
        { tool: 'merge_chapter_outline_previews', args: { previews: ['{{steps.2.output}}'], volumeNo: 1, chapterCount: 3 } },
      ]),
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1 },
    }),
    /expected 3 generate_chapter_outline_preview steps, got 1/,
  );
});

test('PlanValidatorService allows explicit single chapter outline plans', () => {
  const validator = new PlanValidatorService();
  assert.doesNotThrow(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 2, chapterCount: 60 } },
      ]),
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterNo: 2 },
    }),
  );
});

test('PlanValidatorService rejects import asset scope expansion', () => {
  const validator = new PlanValidatorService();
  const context = { session: { requestedAssetTypes: ['outline'] } } as AgentContextV2;
  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'build_import_preview', args: { requestedAssetTypes: ['outline', 'characters'] } },
      ]),
      context,
      route: { domain: 'import', intent: 'project_assets', confidence: 0.9, reasons: ['test'] },
    }),
    /import requestedAssetTypes mismatch/,
  );
});

test('PlanValidatorService blocks invalid scoped planner output without fallback plan', async () => {
  let calls = 0;
  const toolList = [
    createTool({ name: 'echo_report', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolNames : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson() {
      calls += 1;
      return {
        data: {
          taskType: 'general',
          summary: 'Invalid selected tool plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: {} },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never, undefined, new PlanValidatorService());

  await assert.rejects(
    () => planner.createPlanWithTools({
      goal: 'selected tools only',
      route: { domain: 'general', intent: 'clarify', confidence: 0.4, reasons: ['test'] },
      selectedBundle: { bundleName: 'general.echo', strictToolNames: ['echo_report'], optionalToolNames: [], deniedToolNames: ['inspect_project_context'], selectionReason: 'test' },
      selectedTools: tools.listManifestsForPlanner(['echo_report']),
    }),
    /Agent Planner .*bundle-outside tools.*inspect_project_context/,
  );
  assert.equal(calls, 2);
});

function createScopedPlannerHarness(toolNames: string[], llm: unknown) {
  const toolList = toolNames.map((name) => createTool({
    name,
    requiresApproval: name.startsWith('persist_') || name.startsWith('write_'),
    riskLevel: name.startsWith('persist_') || name.startsWith('write_') ? 'high' : 'low',
    sideEffects: name.startsWith('persist_') || name.startsWith('write_') ? ['write'] : [],
  }));
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : toolList.map((tool) => tool.name)).map((name) => {
      const tool = toolList.find((item) => item.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return {
        name: tool.name,
        displayName: tool.name,
        description: tool.description,
        whenToUse: [],
        whenNotToUse: [],
        allowedModes: tool.allowedModes,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        sideEffects: tool.sideEffects,
      };
    }),
  } as unknown as ToolRegistryService;
  return {
    tools,
    planner: new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never, undefined, new PlanValidatorService()),
  };
}

function createOutlinePlannerHarness(llm: unknown) {
  return createScopedPlannerHarness([
    'inspect_project_context',
    'generate_volume_outline_preview',
    'generate_story_units_preview',
    'generate_chapter_outline_preview',
    'merge_chapter_outline_previews',
    'validate_outline',
    'persist_outline',
    'persist_volume_outline',
    'persist_volume_character_candidates',
    'write_chapter',
    'write_chapter_series',
  ], llm);
}

test('Scoped planner prompt only carries lightweight context before tools upload project context', async () => {
  let promptPayload: Record<string, any> | undefined;
  const toolList = [
    createTool({ name: 'inspect_project_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_volume_outline_preview', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_volume_outline', requiresApproval: true, riskLevel: 'high', sideEffects: ['upsert_volume'] }),
    createTool({ name: 'persist_volume_character_candidates', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_or_update_volume_characters'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? toolList.filter((tool) => toolNames.includes(tool.name)) : toolList).map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: [],
      whenNotToUse: [],
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayload = JSON.parse(messages[1].content);
      return {
        data: {
          taskType: 'outline_design',
          summary: '生成第一卷大纲',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: '巡检上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: {} },
            { stepNo: 2, name: '生成卷纲', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', volumeNo: 1 } },
            { stepNo: 3, name: '审批写入卷纲', tool: 'persist_volume_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never, undefined, new PlanValidatorService());
  const selectedBundle = {
    bundleName: 'outline.volume',
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates'],
    optionalToolNames: [],
    deniedToolNames: ['generate_chapter_outline_preview'],
    selectionReason: 'test',
  };
  const context: AgentContextV2 = {
    schemaVersion: 2,
    userMessage: '生成第一卷大纲',
    runtime: { mode: 'plan', locale: 'zh-CN', maxSteps: 80, maxLlmCalls: 3 },
    session: { currentProjectId: 'p1', currentProjectTitle: '长篇项目' },
    project: { id: 'p1', title: '长篇项目', genre: '奇幻', style: '厚重', synopsis: '这是一段很长的项目剧情简介，不应在分域 Planner 阶段上传。', defaultWordCount: 2500, status: 'draft' },
    volumes: [{ id: 'v1', volumeNo: 1, title: '第一卷', objective: '完成第一卷目标', chapterCount: 60, status: 'planned', hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }],
    currentChapter: { id: 'c1', title: '第一章', index: 1, status: 'planned', outline: '不应上传的章节细纲', summary: '不应上传的章节摘要' },
    recentChapters: [{ id: 'c1', title: '第一章', index: 1, summary: '不应上传的最近章节摘要' }],
    knownCharacters: [{ id: 'ch1', name: '林澈', aliases: [], role: '主角', currentState: '不应上传的人物状态' }],
    worldFacts: [{ id: 'w1', type: 'setting', title: '潮陆', content: '不应上传的世界观正文' }],
    memoryHints: [{ id: 'm1', type: 'plot', content: '不应上传的记忆内容', relevance: 1 }],
    attachments: [],
    constraints: { hardRules: ['小说内容失败即失败'], styleRules: ['厚重'], approvalRules: ['写入需审批'], idPolicy: ['不要编造 ID'] },
    availableTools: [],
  };

  await planner.createPlanWithTools({
    goal: '生成第一卷大纲',
    context,
    route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'], volumeNo: 1, needsApproval: true, needsPersistence: true },
    selectedBundle,
    selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
  });

  assert.equal(promptPayload?.agentContext.project.synopsis, undefined);
  assert.deepEqual(promptPayload?.agentContext.volumes, [{ id: 'v1', volumeNo: 1, title: '第一卷', objective: '完成第一卷目标', chapterCount: 60, status: 'planned', hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }]);
  assert.equal(promptPayload?.agentContext.volumes[0].narrativePlan, undefined);
  assert.equal(promptPayload?.agentContext.currentChapter.outline, undefined);
  assert.deepEqual(promptPayload?.agentContext.recentChapters, []);
  assert.deepEqual(promptPayload?.agentContext.knownCharacters, []);
  assert.deepEqual(promptPayload?.agentContext.worldFacts, []);
  assert.deepEqual(promptPayload?.agentContext.memoryHints, []);
  assert.equal(promptPayload?.agentContext.session.currentProjectId, 'p1');
  assert.equal(promptPayload?.routeDecision.intent, 'generate_volume_outline');
});

test('ASP-P4-002 volume outline scoped plan forbids chapter outline tools', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          taskType: 'outline_design',
          summary: 'Generate first volume outline.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes'] } },
            { stepNo: 2, name: 'Volume outline', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1 } },
            { stepNo: 3, name: 'Persist volume outline', tool: 'persist_volume_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const { planner, tools } = createOutlinePlannerHarness(llm);
  const selectedBundle = {
    bundleName: 'outline.volume',
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates'],
    optionalToolNames: [],
    deniedToolNames: ['generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline', 'write_chapter', 'write_chapter_series'],
    selectionReason: 'test',
  };
  const plan = await planner.createPlanWithTools({
    goal: '生成第一卷大纲',
    route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'], volumeNo: 1, needsApproval: true, needsPersistence: true },
    selectedBundle,
    selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
  });

  assert.deepEqual(plan.steps.map((step) => step.tool), ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline']);
  assert.ok(!plan.steps.some((step) => step.tool === 'generate_chapter_outline_preview'));
});

test('ASP-P4-002 chapter split scoped plan keeps chapter outline chain', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      if (calls === 1) {
        return {
          data: {
            taskType: 'outline_design',
            summary: 'Split volume one into three chapters.',
            assumptions: [],
            risks: [],
            steps: [
              { stepNo: 1, name: 'Inspect', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes', 'chapters'] } },
              { stepNo: 2, name: 'First chapter outline', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
              { stepNo: 3, name: 'Merge incomplete chapters', tool: 'merge_chapter_outline_previews', mode: 'act', requiresApproval: false, args: { previews: ['{{steps.2.output}}'], volumeNo: 1, chapterCount: 3 } },
            ],
          },
          result: { model: 'planner-mock' },
        };
      }
      return {
        data: {
          taskType: 'outline_design',
          summary: 'Split volume one into three chapters.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline', 'volumes', 'chapters'] } },
            { stepNo: 2, name: 'Chapter 1 outline', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
            { stepNo: 3, name: 'Chapter 2 outline', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 2, chapterCount: 3, previousChapter: '{{steps.2.output.chapter}}' } },
            { stepNo: 4, name: 'Chapter 3 outline', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 3, chapterCount: 3, previousChapter: '{{steps.3.output.chapter}}' } },
            { stepNo: 5, name: 'Merge chapters', tool: 'merge_chapter_outline_previews', mode: 'act', requiresApproval: false, args: { previews: ['{{steps.2.output}}', '{{steps.3.output}}', '{{steps.4.output}}'], volumeNo: 1, chapterCount: 3 } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const { planner, tools } = createOutlinePlannerHarness(llm);
  const selectedBundle = {
    bundleName: 'outline.chapter',
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'generate_story_units_preview', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'validate_outline', 'persist_outline'],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_volume_outline'],
    selectionReason: 'test',
  };
  const plan = await planner.createPlanWithTools({
    goal: '把第一卷拆成 3 章',
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, needsApproval: true, needsPersistence: true },
    selectedBundle,
    selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
  });

  assert.equal(calls, 2);
  assert.equal(plan.plannerDiagnostics?.source, 'llm_repair');
  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'inspect_project_context',
    'generate_chapter_outline_preview',
    'generate_chapter_outline_preview',
    'generate_chapter_outline_preview',
    'merge_chapter_outline_previews',
  ]);
  assert.equal(plan.steps[1].args.chapterNo, 1);
  assert.equal(plan.steps[2].args.chapterNo, 2);
  assert.equal(plan.steps[3].args.chapterNo, 3);
  assert.equal(plan.steps[4].args.chapterCount, 3);
  assert.deepEqual(plan.steps[4].args.previews, ['{{steps.2.output}}', '{{steps.3.output}}', '{{steps.4.output}}']);
});

test('ASP-P4-002 volume outline repair cannot switch to chapter outline', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      if (calls === 1) {
        return {
          data: {
            taskType: 'not_allowed',
            summary: 'Invalid first plan.',
            assumptions: [],
            risks: [],
            steps: [
              { stepNo: 1, name: 'Volume outline', tool: 'generate_volume_outline_preview', mode: 'act', requiresApproval: false, args: { volumeNo: 1 } },
            ],
          },
          result: { model: 'planner-mock' },
        };
      }
      return {
        data: {
          taskType: 'outline_design',
          summary: 'Wrong repaired chapter outline.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Inspect', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: { focus: ['outline'] } },
            { stepNo: 2, name: 'Chapter outline', tool: 'generate_chapter_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', volumeNo: 1, chapterNo: 1, chapterCount: 30 } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const { planner, tools } = createOutlinePlannerHarness(llm);
  const selectedBundle = {
    bundleName: 'outline.volume',
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates'],
    optionalToolNames: [],
    deniedToolNames: ['generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline', 'write_chapter', 'write_chapter_series'],
    selectionReason: 'test',
  };

  await assert.rejects(
    () => planner.createPlanWithTools({
      goal: '生成卷大纲',
      route: { domain: 'outline', intent: 'generate_volume_outline', confidence: 0.9, reasons: ['test'], volumeNo: 1, needsApproval: true, needsPersistence: true },
      selectedBundle,
      selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
    }),
    /Agent Planner .*bundle-outside tools.*generate_chapter_outline_preview/,
  );
  assert.equal(calls, 2);
});

test('ASP-P4-003 import scoped plan rejects expanded asset targets', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      return {
        data: {
          taskType: 'project_import_preview',
          summary: 'Invalid expanded import plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Analyze', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: '{{context.session.selectedText}}' } },
            { stepNo: 2, name: 'Brief', tool: 'build_import_brief', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.1.output}}', requestedAssetTypes: ['outline', 'characters'] } },
            { stepNo: 3, name: 'Outline', tool: 'generate_import_outline_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.1.output}}', importBrief: '{{steps.2.output}}' } },
            { stepNo: 4, name: 'Characters', tool: 'generate_import_characters_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.1.output}}', importBrief: '{{steps.2.output}}' } },
            { stepNo: 5, name: 'Merge', tool: 'merge_import_previews', mode: 'act', requiresApproval: false, args: { requestedAssetTypes: ['outline', 'characters'], outlinePreview: '{{steps.3.output}}', charactersPreview: '{{steps.4.output}}' } },
            { stepNo: 6, name: 'Validate', tool: 'validate_imported_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.5.output}}' } },
            { stepNo: 7, name: 'Persist', tool: 'persist_project_assets', mode: 'act', requiresApproval: true, args: { preview: '{{steps.5.output}}', validation: '{{steps.6.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const importTools = [
    'read_source_document',
    'analyze_source_text',
    'build_import_brief',
    'build_import_preview',
    'generate_import_project_profile_preview',
    'generate_import_outline_preview',
    'generate_import_characters_preview',
    'generate_import_worldbuilding_preview',
    'generate_import_writing_rules_preview',
    'merge_import_previews',
    'cross_target_consistency_check',
    'validate_imported_assets',
    'persist_project_assets',
    'write_chapter',
    'write_chapter_series',
    'persist_outline',
  ];
  const { planner, tools } = createScopedPlannerHarness(importTools, llm);
  const selectedBundle = {
    bundleName: 'import.project_assets',
    strictToolNames: importTools.filter((tool) => !['write_chapter', 'write_chapter_series', 'persist_outline'].includes(tool)),
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    selectionReason: 'test',
  };

  await assert.rejects(
    () => planner.createPlanWithTools({
      goal: 'Targeted import eval: generate only the outline from this source.',
      context: { session: { selectedText: 'source', requestedAssetTypes: ['outline'], importPreviewMode: 'deep' } } as AgentContextV2,
      route: { domain: 'import', intent: 'project_import_preview', confidence: 0.9, reasons: ['test'], needsApproval: true, needsPersistence: true },
      selectedBundle,
      selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
    }),
    /Agent Planner .*import target expansion.*characters|Agent Planner .*requestedAssetTypes mismatch/,
  );
  assert.equal(calls, 2);
});

test('ASP-P4-003 guided scoped plan rejects chapter writing', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      return {
        data: {
          taskType: 'chapter_write',
          summary: 'Wrong guided writing plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Write', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{context.session.currentChapterId}}', instruction: '{{context.userMessage}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const guidedTools = [
    'generate_guided_step_preview',
    'validate_guided_step_preview',
    'persist_guided_step_result',
    'inspect_project_context',
    'write_chapter',
    'write_chapter_series',
    'polish_chapter',
    'fact_validation',
    'auto_repair_chapter',
    'extract_chapter_facts',
    'rebuild_memory',
    'review_memory',
    'persist_outline',
  ];
  const { planner, tools } = createScopedPlannerHarness(guidedTools, llm);
  const selectedBundle = {
    bundleName: 'guided.step',
    strictToolNames: ['generate_guided_step_preview', 'validate_guided_step_preview', 'persist_guided_step_result'],
    optionalToolNames: ['inspect_project_context'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    selectionReason: 'test',
  };

  await assert.rejects(
    () => planner.createPlanWithTools({
      goal: '当前引导步骤怎么填？',
      context: { session: { guided: { currentStep: 'guided_volume', currentStepLabel: 'Volume setup', currentStepData: {} } } } as AgentContextV2,
      route: { domain: 'guided', intent: 'guided_step_consultation', confidence: 0.94, reasons: ['test'], needsApproval: false, needsPersistence: false },
      selectedBundle,
      selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
    }),
    /Agent Planner .*bundle-outside tools.*write_chapter/,
  );
  assert.equal(calls, 2);
});

test('ASP-P4-003 timeline preview scoped plan rejects implicit persistence', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      return {
        data: {
          taskType: 'timeline_plan',
          summary: 'Invalid timeline persistence plan.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Collect', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'timeline_plan' } },
            { stepNo: 2, name: 'Preview', tool: 'generate_timeline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', sourceType: 'craft_brief' } },
            { stepNo: 3, name: 'Validate', tool: 'validate_timeline_preview', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
            { stepNo: 4, name: 'Persist', tool: 'persist_timeline_events', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const { planner, tools } = createScopedPlannerHarness([
    'collect_task_context',
    'generate_timeline_preview',
    'align_chapter_timeline_preview',
    'validate_timeline_preview',
    'persist_timeline_events',
    'write_chapter',
    'write_chapter_series',
    'persist_outline',
  ], llm);
  const selectedBundle = {
    bundleName: 'timeline.plan',
    strictToolNames: ['collect_task_context', 'generate_timeline_preview', 'align_chapter_timeline_preview', 'validate_timeline_preview'],
    optionalToolNames: ['persist_timeline_events'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    selectionReason: 'test',
  };

  await assert.rejects(
    () => planner.createPlanWithTools({
      goal: '生成计划时间线候选，只预览不要写入',
      route: { domain: 'timeline', intent: 'planned_timeline_preview', confidence: 0.88, reasons: ['test'], needsApproval: false, needsPersistence: false },
      selectedBundle,
      selectedTools: tools.listManifestsForPlanner(selectedBundle.strictToolNames),
    }),
    /Agent Planner .*timeline preview route tools: persist_timeline_events/,
  );
  assert.equal(calls, 2);
});

test('Tool manifest filtering preserves requested order and fails on unknown tools', () => {
  const registry = Object.create(ToolRegistryService.prototype) as ToolRegistryService;
  (registry as unknown as { tools: Map<string, BaseTool> }).tools = new Map<string, BaseTool>();
  registry.register(createTool({ name: 'alpha_tool', description: 'Alpha tool', requiresApproval: false, riskLevel: 'low', sideEffects: [] }));
  registry.register(createTool({ name: 'beta_tool', description: 'Beta tool', requiresApproval: false, riskLevel: 'low', sideEffects: [] }));
  registry.register(createTool({ name: 'gamma_tool', description: 'Gamma tool', requiresApproval: false, riskLevel: 'low', sideEffects: [] }));

  assert.deepEqual(registry.listManifestsForPlanner().map((manifest) => manifest.name), ['alpha_tool', 'beta_tool', 'gamma_tool']);
  assert.deepEqual(registry.listManifestsForPlanner(['gamma_tool', 'alpha_tool', 'gamma_tool']).map((manifest) => manifest.name), ['gamma_tool', 'alpha_tool']);
  assert.throws(() => registry.listManifestsForPlanner(['missing_tool']), /Planner requested unregistered tool manifest: missing_tool/);

  const planner = new AgentPlannerService(new SkillRegistryService(), registry, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    toolManifestsForPrompt: (toolNames?: string[]) => Array<{ name: string; outputFields?: string[] }>;
  };
  assert.deepEqual(planner.toolManifestsForPrompt(['beta_tool']).map((manifest) => manifest.name), ['beta_tool']);
});

test('RootSupervisor classifies planner domains without tool manifests', () => {
  const supervisor = new RootSupervisor();
  const cases: Array<{ goal: string; domain: string; intent: string }> = [
    { goal: '帮我重写第一卷大纲。', domain: 'outline', intent: 'outline' },
    { goal: '把第一卷拆成 30 章。', domain: 'outline', intent: 'outline' },
    { goal: '帮我写第十二章正文。', domain: 'writing', intent: 'chapter_write' },
    { goal: '重写第十二章，不沿用旧稿。', domain: 'revision', intent: 'chapter_rewrite' },
    { goal: '导入文档，只要故事大纲。', domain: 'import', intent: 'project_import_preview' },
    { goal: '检查男主人设是不是崩了。', domain: 'quality', intent: 'character_consistency_check' },
    { goal: '基于当前大纲生成计划时间线候选，不要写入。', domain: 'timeline', intent: 'timeline_plan' },
    { goal: '补充宗门体系，但不要影响已有剧情。', domain: 'worldbuilding', intent: 'worldbuilding_expand' },
  ];

  for (const item of cases) {
    const route = supervisor.classify({ goal: item.goal });
    assert.equal(route.domain, item.domain);
    assert.equal(route.intent, item.intent);
    assert.equal(route.ambiguity?.needsClarification, undefined);
    assert.ok(route.confidence >= 0.8);
    assert.doesNotThrow(() => validateRouteDecision(route));
  }

  const guidedRoute = supervisor.classify({
    goal: '帮我解释当前步骤应该怎么填。',
    context: {
      session: { guided: { currentStep: 'guided_volume', currentStepLabel: '卷规划' } },
    } as AgentContextV2,
  });
  assert.equal(guidedRoute.domain, 'guided');
  assert.equal(guidedRoute.intent, 'guided_step_consultation');
  assert.ok(guidedRoute.confidence >= 0.9);

  const unclear = supervisor.classify({ goal: '帮我弄一下。' });
  assert.equal(unclear.domain, 'general');
  assert.equal(unclear.intent, 'clarify');
  assert.equal(unclear.ambiguity?.needsClarification, true);
  assert.ok(unclear.confidence < 0.5);
});

test('ASP-P6-001 OutlineSupervisor classifies outline sub-intents without tools', () => {
  const supervisor = new OutlineSupervisor();
  const cases: Array<{ goal: string; outlineIntent: string; intent: string }> = [
    { goal: '帮我重写第一卷大纲。', outlineIntent: 'volume_outline', intent: 'generate_volume_outline' },
    { goal: '把第一卷拆成 30 章。', outlineIntent: 'chapter_outline', intent: 'split_volume_to_chapters' },
    { goal: '给第十二章补一张 Chapter.craftBrief 推进卡。', outlineIntent: 'craft_brief', intent: 'chapter_craft_brief' },
    { goal: '把第十二章拆成场景卡。', outlineIntent: 'scene_card', intent: 'scene_card_planning' },
  ];

  for (const item of cases) {
    const route = supervisor.classify({ goal: item.goal });
    assert.equal(route.domain, 'outline');
    assert.equal(route.outlineIntent, item.outlineIntent);
    assert.equal(route.intent, item.intent);
    assert.ok(route.confidence >= 0.86);
    assert.doesNotThrow(() => validateRouteDecision(route));
  }
});

test('ASP-P6-001 outline subgraph returns RouteDecision diagnostics only', async () => {
  const result = await invokeOutlineSubgraph({ goal: '给第十二章拆成场景卡。' });

  assert.equal(result.route?.domain, 'outline');
  assert.equal(result.route?.intent, 'scene_card_planning');
  assert.deepEqual(result.diagnostics.nodes.map((node) => node.name), ['outlineSupervisor']);
  const resultRecord = result as unknown as Record<string, unknown>;
  assert.equal(resultRecord.selectedTools, undefined);
  assert.equal(resultRecord.plan, undefined);
});

test('ASP-P6-002 selectToolBundleNode refines outline route through outline subgraph', async () => {
  const allBundleToolNames = [...new Set(TOOL_BUNDLE_DEFINITIONS.flatMap((definition) => [
    ...definition.strictToolNames,
    ...(definition.optionalToolNames ?? []),
    ...(definition.deniedToolNames ?? []),
  ]))];
  const tools = {
    list: () => allBundleToolNames.map((name) => createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [] })),
    listManifestsForPlanner: (toolNames?: string[]) => (toolNames?.length ? [...new Set(toolNames)] : allBundleToolNames).map((name) => ({
      name,
      displayName: name,
      description: name,
      whenToUse: [],
      whenNotToUse: [],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      allowedModes: ['plan', 'act'] as const,
      riskLevel: 'low' as const,
      requiresApproval: false,
      sideEffects: [],
    })),
  } as unknown as ToolRegistryService;
  const goal = '把第一卷拆成 30 章。';
  const rootRoute = new RootSupervisor().classify({ goal });
  const node = createSelectToolBundleNode(new ToolBundleRegistry(tools));

  const result = await node({
    goal,
    route: rootRoute,
    context: { volumes: [{ id: 'v1', volumeNo: 1, title: '第一卷', chapterCount: 30, hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }] } as AgentContextV2,
    defaults: { taskType: 'general', summary: 'smoke', assumptions: [], risks: [] },
    diagnostics: { graphVersion: 'test', nodes: [] },
  });

  assert.equal(rootRoute.intent, 'outline');
  assert.equal(result.route?.intent, 'split_volume_to_chapters');
  assert.equal(result.route?.chapterCount, 30);
  assert.equal(result.selectedBundle?.bundleName, 'outline.chapter');
  assert.ok(result.selectedTools?.some((tool) => tool.name === 'generate_chapter_outline_preview'));
  assert.deepEqual(result.diagnostics?.nodes.map((node) => node.name), ['outlineSupervisor', 'selectToolBundle']);
});

test('Planner prompt compacts tool manifests without losing callable input schema', async () => {
  let promptPayload: Record<string, any> | undefined;
  const inputSchema: NonNullable<BaseTool['inputSchema']> = {
    type: 'object',
    required: ['characterId', 'experimentalLlmEvidenceSummary'],
    properties: {
      characterId: { type: 'string' },
      instruction: { type: 'string' },
      experimentalLlmEvidenceSummary: { type: 'boolean' },
    },
  };
  const outputSchema: NonNullable<BaseTool['outputSchema']> = {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: { type: 'object' },
      llmEvidenceSummary: { type: 'object' },
    },
  };
  const toolList = [
    createTool({
      name: 'character_consistency_check',
      requiresApproval: false,
      riskLevel: 'low',
      sideEffects: [],
      inputSchema,
      outputSchema,
      manifest: {
        name: 'character_consistency_check',
        displayName: 'Character consistency check',
        description: 'Check character consistency.',
        whenToUse: ['check character consistency'],
        whenNotToUse: [],
        inputSchema,
        outputSchema,
        parameterHints: {
          characterId: { source: 'resolver', resolverTool: 'resolve_character', description: 'Resolved character id.' },
          instruction: { source: 'user_message', description: 'User focus.' },
          experimentalLlmEvidenceSummary: { source: 'runtime', description: 'Runtime-only experiment flag.' },
        },
        examples: [{ user: 'check him', plan: [{ tool: 'character_consistency_check', args: { characterId: '{{steps.1.output.characterId}}', experimentalLlmEvidenceSummary: true } }] }],
        allowedModes: ['plan', 'act'],
        riskLevel: 'low',
        requiresApproval: false,
        sideEffects: [],
      },
    }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: () => toolList.map((tool) => ({
      name: tool.manifest?.name ?? tool.name,
      displayName: tool.manifest?.displayName ?? tool.name,
      description: tool.manifest?.description ?? tool.description,
      whenToUse: tool.manifest?.whenToUse ?? [],
      whenNotToUse: tool.manifest?.whenNotToUse ?? [],
      inputSchema: tool.manifest?.inputSchema ?? tool.inputSchema,
      outputSchema: tool.manifest?.outputSchema ?? tool.outputSchema,
      parameterHints: tool.manifest?.parameterHints,
      examples: tool.manifest?.examples,
      allowedModes: tool.manifest?.allowedModes ?? tool.allowedModes,
      riskLevel: tool.manifest?.riskLevel ?? tool.riskLevel,
      requiresApproval: tool.manifest?.requiresApproval ?? tool.requiresApproval,
      sideEffects: tool.manifest?.sideEffects ?? tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      promptPayload = JSON.parse(messages[1].content);
      return {
        data: {
          taskType: 'general',
          summary: 'Check character consistency.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Check character', tool: 'character_consistency_check', mode: 'act', requiresApproval: false, args: { characterId: 'char1', instruction: '{{context.userMessage}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);
  const context = {
    schemaVersion: 2,
    userMessage: 'check character',
    runtime: { mode: 'plan', locale: 'zh-CN', maxSteps: 6, maxLlmCalls: 2 },
    session: {},
    recentChapters: [],
    knownCharacters: [],
    worldFacts: [],
    memoryHints: [],
    attachments: [],
    constraints: { hardRules: [], styleRules: [], approvalRules: [], idPolicy: [] },
    availableTools: tools.listManifestsForPlanner(),
  };

  const previousGraphFlag = process.env.AGENT_PLANNER_GRAPH_ENABLED;
  process.env.AGENT_PLANNER_GRAPH_ENABLED = 'false';
  try {
    await planner.createPlan('check character', context as never);
  } finally {
    if (previousGraphFlag === undefined) delete process.env.AGENT_PLANNER_GRAPH_ENABLED;
    else process.env.AGENT_PLANNER_GRAPH_ENABLED = previousGraphFlag;
  }

  assert.ok(promptPayload);
  assert.equal((promptPayload.agentContext as Record<string, unknown>).availableTools, undefined);
  const manifest = (promptPayload.availableTools as Array<Record<string, any>>).find((item) => item.name === 'character_consistency_check');
  assert.ok(manifest);
  assert.equal('outputSchema' in manifest, false);
  assert.deepEqual(manifest.outputFields, ['verdict', 'llmEvidenceSummary']);
  assert.deepEqual(manifest.inputSchema.required, ['characterId']);
  assert.ok(manifest.inputSchema.properties.characterId);
  assert.equal(manifest.inputSchema.properties.experimentalLlmEvidenceSummary, undefined);
  assert.equal(manifest.parameterHints.experimentalLlmEvidenceSummary, undefined);
  assert.doesNotMatch(JSON.stringify(promptPayload), /experimentalLlmEvidenceSummary/);
});

test('Planner routes chapter progress card requests to craft brief tools and keeps SceneCard boundary', async () => {
  const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
  const toolList = [
    createTool({ name: 'resolve_chapter', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'collect_chapter_context', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_chapter_craft_brief_preview', description: 'Generate Chapter.craftBrief progress card previews.', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_chapter_craft_brief', description: 'Validate Chapter.craftBrief previews.', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_chapter_craft_brief', description: 'Persist approved Chapter.craftBrief previews.', requiresApproval: true, riskLevel: 'high', sideEffects: ['update_chapter_craft_brief'] }),
    createTool({ name: 'list_scene_cards', description: 'List SceneCards.', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'collect_task_context', description: 'Collect task context.', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'generate_scene_cards_preview', description: 'Generate SceneCard previews.', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'validate_scene_cards', requiresApproval: false, riskLevel: 'low', sideEffects: [] }),
    createTool({ name: 'persist_scene_cards', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_scene_cards'] }),
    createTool({ name: 'update_scene_card', requiresApproval: true, riskLevel: 'high', sideEffects: ['update_scene_card'] }),
  ];
  const tools = {
    list: () => toolList,
    listManifestsForPlanner: () => toolList.map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: tool.name === 'generate_chapter_craft_brief_preview' ? ['章节推进卡', '推进卡', '执行卡', 'craftBrief', '行动链'] : tool.name === 'generate_scene_cards_preview' ? ['拆成场景', '场景卡', 'SceneCard'] : [],
      whenNotToUse: tool.name === 'generate_scene_cards_preview' ? ['Chapter.craftBrief progress cards'] : [],
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    })),
  } as unknown as ToolRegistryService;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      capturedMessages.push(messages);
      const payload = JSON.parse(messages[1].content);
      if (String(payload.userGoal).includes('拆成')) {
        return {
          data: {
            taskType: 'scene_card_planning',
            summary: 'Split chapter into scene cards.',
            assumptions: [],
            risks: [],
            steps: [
              { stepNo: 1, name: 'Collect scene context', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'scene_card_planning', chapterNo: 3, focus: ['outline', 'characters', 'pacing'] } },
              { stepNo: 2, name: 'Generate scene cards', tool: 'generate_scene_cards_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '{{context.userMessage}}', chapterNo: 3, maxScenes: 5 } },
              { stepNo: 3, name: 'Validate scene cards', tool: 'validate_scene_cards', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
            ],
          },
          result: { model: 'planner-mock' },
        };
      }
      return {
        data: {
          taskType: 'chapter_craft_brief',
          summary: 'Generate chapter progress card.',
          assumptions: [],
          risks: [],
          steps: [
            { stepNo: 1, name: 'Resolve chapter', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterRef: '第 3 章' } },
            { stepNo: 2, name: 'Collect context', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
            { stepNo: 3, name: 'Generate craft brief', tool: 'generate_chapter_craft_brief_preview', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: '{{context.userMessage}}' } },
            { stepNo: 4, name: 'Validate craft brief', tool: 'validate_chapter_craft_brief', mode: 'act', requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
            { stepNo: 5, name: 'Persist after approval', tool: 'persist_chapter_craft_brief', mode: 'act', requiresApproval: true, args: { preview: '{{steps.3.output}}', validation: '{{steps.4.output}}' } },
          ],
        },
        result: { model: 'planner-mock' },
      };
    },
  };
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), llm as never);

  const craftPlan = await planner.createPlan('给第 3 章生成章节推进卡');
  const scenePlan = await planner.createPlan('把第 3 章拆成 5 个场景');
  const craftPromptPayload = JSON.parse(capturedMessages[0][1].content);

  assert.equal(craftPlan.taskType, 'chapter_craft_brief');
  assert.deepEqual(craftPlan.steps.map((step) => step.tool), ['resolve_chapter', 'collect_chapter_context', 'generate_chapter_craft_brief_preview', 'validate_chapter_craft_brief', 'persist_chapter_craft_brief']);
  assert.equal(craftPlan.steps[4].requiresApproval, true);
  assert.equal(scenePlan.taskType, 'scene_card_planning');
  assert.deepEqual(scenePlan.steps.map((step) => step.tool), ['collect_task_context', 'generate_scene_cards_preview', 'validate_scene_cards']);
  assert.match(craftPromptPayload.taskTypeGuidance.chapter_craft_brief, /generate_chapter_craft_brief_preview/);
  assert.match(craftPromptPayload.taskTypeGuidance.chapter_craft_brief, /chapter_write/);
  assert.match(craftPromptPayload.taskTypeGuidance.scene_card_planning, /not for Chapter\.craftBrief/);
});

test('Planner 接受创作引导 guided taskType', () => {
  const tools = { list: () => [createTool({ name: 'report_result', requiresApproval: false, sideEffects: [] })] } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'guided_step_consultation',
      summary: '回答当前引导步骤问题',
      assumptions: ['当前页面已提供 guided context'],
      risks: [],
      steps: [{ stepNo: 1, name: '整理当前步骤建议', tool: 'report_result', mode: 'act', requiresApproval: false, args: { taskType: 'guided_step_consultation', summary: '围绕当前 guided step 给出填写建议' } }],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'guided_step_consultation');
  assert.equal(plan.steps[0].tool, 'report_result');
  assert.equal(plan.steps[0].args.taskType, 'guided_step_consultation');
});

test('Planner 接受 AI 审稿 taskType 并以后端 Tool 元数据要求审批', () => {
  const tools = {
    list: () => [
      createTool({ name: 'resolve_chapter', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'ai_quality_review', requiresApproval: true, sideEffects: ['create_quality_report'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; requiresApproval: boolean }>; requiredApprovals: Array<Record<string, unknown>>; riskReview?: { requiresApproval: boolean } };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'ai_quality_review',
      summary: 'AI 审稿计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '解析章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterRef: '当前章' } },
        { stepNo: 2, name: '写入 AI 审稿报告', tool: 'ai_quality_review', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}', instruction: '重点看节奏和伏笔' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'ai_quality_review');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['resolve_chapter', 'ai_quality_review']);
  assert.equal(plan.steps[1].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0], { approvalType: 'plan', target: { stepNos: [2], tools: ['ai_quality_review'] } });
  assert.equal(plan.riskReview?.requiresApproval, true);
});

test('Planner 接受 Story Bible 扩展 taskType 并以后端 Tool 元数据要求 persist 审批', () => {
  const tools = {
    list: () => [
      createTool({ name: 'collect_task_context', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_story_bible_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'validate_story_bible', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'persist_story_bible', requiresApproval: true, sideEffects: ['create_lorebook_entries', 'update_lorebook_entries'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; requiresApproval: boolean }>; requiredApprovals: Array<Record<string, unknown>>; riskReview?: { requiresApproval: boolean } };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'story_bible_expand',
      summary: 'Story Bible 扩展计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '收集上下文', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'story_bible_expand' } },
        { stepNo: 2, name: '生成预览', tool: 'generate_story_bible_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '扩展宗门戒律' } },
        { stepNo: 3, name: '校验预览', tool: 'validate_story_bible', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}', taskContext: '{{steps.1.output}}' } },
        { stepNo: 4, name: '写入 Story Bible', tool: 'persist_story_bible', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'story_bible_expand');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['collect_task_context', 'generate_story_bible_preview', 'validate_story_bible', 'persist_story_bible']);
  assert.equal(plan.steps[3].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0], { approvalType: 'plan', target: { stepNos: [4], tools: ['persist_story_bible'] } });
  assert.equal(plan.riskReview?.requiresApproval, true);
});

test('Planner accepts continuity_check taskType and requires approval for persist step', () => {
  const tools = {
    list: () => [
      createTool({ name: 'collect_task_context', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'generate_continuity_preview', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'validate_continuity_changes', requiresApproval: false, sideEffects: [] }),
      createTool({ name: 'persist_continuity_changes', requiresApproval: true, sideEffects: ['create_relationship_edge', 'update_relationship_edge', 'create_timeline_event', 'update_timeline_event'] }),
    ],
  } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; requiresApproval: boolean }>; requiredApprovals: Array<Record<string, unknown>>; riskReview?: { requiresApproval: boolean } };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'continuity_check',
      summary: '连续性修复计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '收集上下文', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'continuity_check' } },
        { stepNo: 2, name: '生成连续性预览', tool: 'generate_continuity_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: '修复角色关系与时间线冲突' } },
        { stepNo: 3, name: '校验连续性变更', tool: 'validate_continuity_changes', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}', taskContext: '{{steps.1.output}}' } },
        { stepNo: 4, name: '写入连续性变更', tool: 'persist_continuity_changes', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'continuity_check');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['collect_task_context', 'generate_continuity_preview', 'validate_continuity_changes', 'persist_continuity_changes']);
  assert.equal(plan.steps[3].requiresApproval, true);
  assert.deepEqual(plan.requiredApprovals[0], { approvalType: 'plan', target: { stepNos: [4], tools: ['persist_continuity_changes'] } });
  assert.equal(plan.riskReview?.requiresApproval, true);
});

test('Planner 为 write_chapter 强制追加章节质量门禁链路', () => {
  const toolNames = ['resolve_chapter', 'collect_chapter_context', 'write_chapter', 'polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'];
  const tools = { list: () => toolNames.map((name) => createTool({ name, requiresApproval: !['resolve_chapter', 'collect_chapter_context'].includes(name), sideEffects: name === 'resolve_chapter' || name === 'collect_chapter_context' ? [] : ['write'] })) } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ stepNo: number; tool: string; args: Record<string, unknown>; runIf?: { ref: string; operator: string; value?: unknown } }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'chapter_write',
      summary: '章节写作计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '解析章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterNo: 1 } },
        { stepNo: 2, name: '收集上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
        { stepNo: 3, name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: '帮我写第一章内容' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'resolve_chapter',
    'collect_chapter_context',
    'write_chapter',
    'polish_chapter',
    'fact_validation',
    'auto_repair_chapter',
    'polish_chapter',
    'fact_validation',
    'auto_repair_chapter',
    'extract_chapter_facts',
    'rebuild_memory',
    'review_memory',
  ]);
  assert.equal(plan.steps[3].args.draftId, '{{runtime.currentDraftId}}');
  assert.deepEqual(plan.steps[6].runIf, { ref: '{{steps.5.output.createdCount}}', operator: 'gt', value: 0 });
  assert.equal(plan.steps[8].args.issues, '{{steps.8.output.issues}}');
});

test('Planner 支持多章写作任务并保持 write_chapter_series 为单步批量工具', () => {
  const toolNames = ['write_chapter_series', 'write_chapter', 'polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'];
  const tools = { list: () => toolNames.map((name) => createTool({ name, requiresApproval: true, sideEffects: ['write'] })) } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { taskType: string; steps: Array<{ tool: string; args: Record<string, unknown> }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'multi_chapter_write',
      summary: '连续写三章',
      assumptions: [],
      risks: [],
      steps: [{ stepNo: 1, name: '连续生成多章', tool: 'write_chapter_series', mode: 'act', requiresApproval: true, args: { startChapterNo: 3, endChapterNo: 5, instruction: '保持剧情连续，压迫感强一点' } }],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.equal(plan.taskType, 'multi_chapter_write');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['write_chapter_series']);
  assert.equal(plan.steps[0].args.endChapterNo, 5);
});

test('WriteChapterSeriesTool 按章节升序连续生成并限制批量数量', async () => {
  const generatedChapterIds: string[] = [];
  const pipelineCalls: string[] = [];
  const generatedInputs: Array<Record<string, unknown>> = [];
  const progress: Array<Record<string, unknown>> = [];
  const prisma = {
    chapter: {
      async findMany() {
        return [
          { id: 'c3', chapterNo: 3, title: '三' },
          { id: 'c4', chapterNo: 4, title: '四' },
        ];
      },
    },
  };
  const generateChapter = {
    async run(_projectId: string, chapterId: string, input: { progress?: { updateProgress?: (patch: Record<string, unknown>) => Promise<void>; heartbeat?: (patch?: Record<string, unknown>) => Promise<void> } }) {
      generatedChapterIds.push(chapterId);
      generatedInputs.push(input as Record<string, unknown>);
      await input.progress?.updateProgress?.({ phase: 'calling_llm', phaseMessage: `mock ${chapterId}` });
      return { draftId: `d-${chapterId}`, chapterId, versionNo: 1, actualWordCount: 1200, summary: `summary-${chapterId}` };
    },
  };
  const polish = { async run(args: Record<string, unknown>) { pipelineCalls.push(`polish:${args.chapterId}:${args.draftId}`); return { chapterId: args.chapterId, draftId: `p-${args.chapterId}`, polishedWordCount: 1200 }; } };
  const validation = { async run(args: Record<string, unknown>) { pipelineCalls.push(`validation:${args.chapterId}`); return { deletedCount: 0, createdCount: 0, factCounts: {}, issues: [] }; } };
  const repair = { async run(args: Record<string, unknown>) { pipelineCalls.push(`repair:${args.chapterId}:${args.draftId}`); return { chapterId: args.chapterId, draftId: args.draftId, repairedWordCount: 1200 }; } };
  const facts = { async run(args: Record<string, unknown>) { pipelineCalls.push(`facts:${args.chapterId}:${args.draftId}`); return { chapterId: args.chapterId, draftId: args.draftId, summary: '事实', createdEvents: 1, createdCharacterStates: 0, createdForeshadows: 0, createdMemoryChunks: 1, pendingReviewMemoryChunks: 0 }; } };
  const memory = { async run(args: Record<string, unknown>) { pipelineCalls.push(`memory:${args.chapterId}:${args.draftId}`); return { createdCount: 1, deletedCount: 0, embeddingAttachedCount: 0, chunks: [] }; } };
  const review = { async run(args: Record<string, unknown>) { pipelineCalls.push(`review:${args.chapterId}`); return { reviewedCount: 0, confirmedCount: 0, rejectedCount: 0, skippedCount: 0, decisions: [] }; } };
  const tool = new WriteChapterSeriesTool(prisma as never, generateChapter as never, polish as never, validation as never, repair as never, facts as never, memory as never, review as never);
  const context = {
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: {},
    policy: {},
    async updateProgress(patch: unknown) { progress.push(patch as Record<string, unknown>); },
    async heartbeat(patch?: unknown) { if (patch) progress.push(patch as Record<string, unknown>); },
  };

  const result = await tool.run({ startChapterNo: 3, endChapterNo: 4, instruction: '连续写两章' }, context);

  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
  assert.equal(Boolean(generatedInputs[0].progress), true);
  assert.deepEqual(pipelineCalls, [
    'polish:c3:d-c3',
    'validation:c3',
    'repair:c3:p-c3',
    'facts:c3:p-c3',
    'memory:c3:p-c3',
    'review:c3',
    'polish:c4:d-c4',
    'validation:c4',
    'repair:c4:p-c4',
    'facts:c4:p-c4',
    'memory:c4:p-c4',
    'review:c4',
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.chapters.map((item) => item.draftId), ['p-c3', 'p-c4']);
  assert.ok(result.chapters.every((item) => item.pipeline?.facts && item.pipeline.memory && item.pipeline.memoryReview));
  assert.equal(progress.some((item) => item.phase === 'preparing_context'), true);
  assert.equal(progress.some((item) => item.phase === 'writing_chapter' && item.progressTotal === 2), true);
  assert.equal(progress.some((item) => item.phase === 'calling_llm'), true);

  generatedChapterIds.length = 0;
  pipelineCalls.length = 0;
  const maxChaptersResult = await tool.run({ startChapterNo: 3, maxChapters: 2, instruction: '从第 3 章开始连续写两章', qualityPipeline: 'draft_only' }, context);
  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
  assert.equal(pipelineCalls.length, 0);
  assert.equal(maxChaptersResult.total, 2);
  assert.deepEqual(maxChaptersResult.chapters.map((item) => item.chapterNo), [3, 4]);

  generatedChapterIds.length = 0;
  pipelineCalls.length = 0;
  const instructionRangeResult = await tool.run({ chapterNos: [3], maxChapters: 1, instruction: '帮我生成第3-4章正文的编写。', qualityPipeline: 'draft_only' }, context);
  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
  assert.equal(pipelineCalls.length, 0);
  assert.equal(instructionRangeResult.total, 2);
  assert.deepEqual(instructionRangeResult.chapters.map((item) => item.chapterNo), [3, 4]);

  generatedChapterIds.length = 0;
  pipelineCalls.length = 0;
  const failingPolish = {
    async run(args: Record<string, unknown>) {
      pipelineCalls.push(`polish:${args.chapterId}:${args.draftId}`);
      if (args.chapterId === 'c3') throw new Error('mock polish failed');
      return { chapterId: args.chapterId, draftId: `p-${args.chapterId}`, polishedWordCount: 1200 };
    },
  };
  const resilientTool = new WriteChapterSeriesTool(prisma as never, generateChapter as never, failingPolish as never, validation as never, repair as never, facts as never, memory as never, review as never);
  const resilientResult = await resilientTool.run({ startChapterNo: 3, endChapterNo: 4, instruction: '连续写两章' }, context);
  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
  assert.equal(resilientResult.succeeded, 2);
  assert.equal(resilientResult.failed, 0);
  assert.equal(resilientResult.stoppedEarly, false);
  assert.match(resilientResult.chapters[0].pipelineError ?? '', /mock polish failed/);
  assert.equal(resilientResult.chapters[1].pipelineError, undefined);

  await assert.rejects(
    () => tool.run({ startChapterNo: 1, endChapterNo: 6, instruction: '太多章' }, context),
    /最多允许 5 章/,
  );
  await assert.rejects(
    () => tool.run({ maxChapters: 2, instruction: '缺少起始章节' }, context),
    /需要 chapterNos/,
  );
});

test('Executor 使用运行时最新草稿指针并跳过无问题的二次修复链路', async () => {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const skipped: number[] = [];
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
  };
  const outputsByTool: Record<string, unknown> = {
    write_chapter: { chapterId: 'c1', draftId: 'draft-write', versionNo: 1, actualWordCount: 1000 },
    polish_chapter: { chapterId: 'c1', draftId: 'draft-polish', polishedWordCount: 1000 },
    fact_validation: { deletedCount: 0, createdCount: 0, factCounts: {}, issues: [] },
    auto_repair_chapter: { skipped: true, reason: 'no_repairable_issues', chapterId: 'c1', draftId: 'draft-polish', repairedWordCount: 1000, repairedIssueCount: 0, maxRounds: 1 },
    extract_chapter_facts: { chapterId: 'c1', draftId: 'draft-polish', summary: '摘要', createdEvents: 1, createdCharacterStates: 0, createdForeshadows: 0, createdMemoryChunks: 1, pendingReviewMemoryChunks: 0 },
    rebuild_memory: { createdCount: 1, deletedCount: 0, embeddingAttachedCount: 0, chunks: [] },
    review_memory: { reviewedCount: 0, confirmedCount: 0, rejectedCount: 0, skippedCount: 0, decisions: [] },
  };
  const tools = {
    get(name: string) {
      return createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [], outputSchema: { type: 'object' }, async run(args: Record<string, unknown>) { executed.push({ name, args }); return outputsByTool[name] ?? {}; } });
    },
  };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep() {}, skipStep(_agentRunId: string, stepNo: number) { skipped.push(stepNo); } };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);
  await executor.execute(
    'run1',
    [
      { stepNo: 1, name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: false, args: {} },
      { stepNo: 2, name: '润色', tool: 'polish_chapter', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}', draftId: '{{runtime.currentDraftId}}' } },
      { stepNo: 3, name: '校验', tool: 'fact_validation', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}' } },
      { stepNo: 4, name: '修复', tool: 'auto_repair_chapter', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}', draftId: '{{runtime.currentDraftId}}', issues: '{{steps.3.output.issues}}', maxRounds: 1 } },
      { stepNo: 5, name: '二次润色', tool: 'polish_chapter', mode: 'act', requiresApproval: false, runIf: { ref: '{{steps.3.output.createdCount}}', operator: 'gt', value: 0 }, args: { chapterId: '{{runtime.currentChapterId}}', draftId: '{{runtime.currentDraftId}}' } },
      { stepNo: 6, name: '抽取事实', tool: 'extract_chapter_facts', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}', draftId: '{{runtime.currentDraftId}}' } },
      { stepNo: 7, name: '重建记忆', tool: 'rebuild_memory', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}', draftId: '{{runtime.currentDraftId}}' } },
      { stepNo: 8, name: '复核记忆', tool: 'review_memory', mode: 'act', requiresApproval: false, args: { chapterId: '{{runtime.currentChapterId}}' } },
    ],
    { mode: 'act', approved: true },
  );

  assert.deepEqual(skipped, [5]);
  assert.equal(executed.find((item) => item.name === 'polish_chapter')?.args.draftId, 'draft-write');
  assert.equal(executed.find((item) => item.name === 'auto_repair_chapter')?.args.draftId, 'draft-polish');
  assert.equal(executed.find((item) => item.name === 'extract_chapter_facts')?.args.draftId, 'draft-polish');
});

function makeGenerationServiceTimelineHarness(options: {
  autoUpdateTimeline: boolean;
  validationValid?: boolean;
  timelineAutoWritePolicy?: 'preview_only' | 'validated_auto_write';
  validationIssues?: Array<{ severity: string; message: string }>;
}) {
  const calls: string[] = [];
  let completedPayload: Record<string, unknown> | undefined;
  let failedMessage: string | undefined;
  const preview = { candidates: [{ candidateId: 'tl_align_1' }], assumptions: [], risks: [], writePlan: { mode: 'preview_only' } };
  const validationIssues = options.validationValid === false
    ? [{ severity: 'error', message: 'bad sourceTrace' }]
    : (options.validationIssues ?? []);
  const validation = {
    valid: options.validationValid ?? true,
    issueCount: validationIssues.length,
    issues: validationIssues,
    accepted: options.validationValid === false ? [] : [{ candidateId: 'tl_align_1' }],
    rejected: [],
    writePreview: { entries: [] },
  };
  const service = new GenerationService(
    { async getById() { return { id: 'c1', projectId: 'p1' }; } } as never,
    {
      async create() { calls.push('job.create'); return { id: 'job-1' }; },
      async markRunning() { calls.push('job.running'); },
      async markCompleted(_jobId: string, payload: Record<string, unknown>) { calls.push('job.completed'); completedPayload = payload; },
      async markFailed(_jobId: string, message: string) { calls.push('job.failed'); failedMessage = message; },
      async getById() { return { id: 'job-1', status: failedMessage ? 'failed' : 'completed', responsePayload: completedPayload, errorMessage: failedMessage }; },
    } as never,
    {
      async run() { calls.push('write'); return { draftId: 'draft-write', retrievalPayload: { context: true } }; },
      async loadGenerationProfileSnapshot() {
        calls.push('profile');
        return createGenerationProfile({
          autoUpdateTimeline: options.autoUpdateTimeline,
          metadata: options.timelineAutoWritePolicy ? { timelineAutoWritePolicy: options.timelineAutoWritePolicy } : {},
        });
      },
    } as never,
    { async run() { calls.push('postprocess'); return { draftId: 'draft-post' }; } } as never,
    { async run() { calls.push('polish'); return { draftId: 'draft-final', polishedWordCount: 1200 }; } } as never,
    {
      async extractChapterFacts() {
        calls.push('facts');
        return { chapterId: 'c1', draftId: 'draft-final', summary: 'facts summary', createdEvents: 1 };
      },
    } as never,
    { async rebuildChapter() { calls.push('memory'); return { createdCount: 1 }; } } as never,
    { async reviewPending() { calls.push('memoryReview'); return { reviewedCount: 0 }; } } as never,
    { async runFactRules() { calls.push('factValidation'); return { valid: true }; } } as never,
    {
      async run(args: Record<string, unknown>, context: Record<string, unknown>) {
        calls.push(`align:${args.draftId}:${context.agentRunId}`);
        return preview;
      },
    } as never,
    {
      async run() {
        calls.push('timelineValidate');
        return validation;
      },
    } as never,
    {
      async run(_args: Record<string, unknown>, context: { policy: { timelineAutoWrite?: { strategy?: string } } }) {
        calls.push(`timelinePersist:${context.policy.timelineAutoWrite?.strategy ?? 'missing_policy'}`);
        return { createdCount: 1, confirmedCount: 0, updatedCount: 0, archivedCount: 0, skippedUnselectedCount: 0, events: [{ candidateId: 'tl_align_1' }] };
      },
    } as never,
  );
  return { service, calls, preview, validation };
}

test('GenerationService skips chapter timeline alignment when autoUpdateTimeline is false', async () => {
  const { service, calls } = makeGenerationServiceTimelineHarness({ autoUpdateTimeline: false });

  const result = await service.generateChapter('c1', { mode: 'draft' });
  const responsePayload = (result as { responsePayload: Record<string, unknown> }).responsePayload;
  const timelineAlignment = responsePayload.timelineAlignment as Record<string, unknown>;

  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(timelineAlignment.skipped, true);
  assert.equal(timelineAlignment.reason, 'autoUpdateTimeline_disabled');
  assert.equal(calls.some((call) => call.startsWith('align:')), false);
  assert.equal(calls.includes('timelineValidate'), false);
});

test('GenerationService runs read-only chapter timeline preview and validation when autoUpdateTimeline is true', async () => {
  const { service, calls, preview, validation } = makeGenerationServiceTimelineHarness({ autoUpdateTimeline: true });

  const result = await service.generateChapter('c1', { mode: 'draft' });
  const responsePayload = (result as { responsePayload: Record<string, unknown> }).responsePayload;
  const timelineAlignment = responsePayload.timelineAlignment as Record<string, unknown>;

  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(timelineAlignment.skipped, false);
  assert.equal(timelineAlignment.preview, preview);
  assert.equal(timelineAlignment.validation, validation);
  assert.equal(timelineAlignment.autoWritePolicy, 'preview_only');
  assert.ok(calls.includes('align:draft-final:job-1'));
  assert.ok(calls.includes('timelineValidate'));
  assert.equal(calls.some((call) => call.startsWith('timelinePersist:')), false);
});

test('GenerationService applies autoUpdateTimeline true and false behavior after polish', async () => {
  const disabled = makeGenerationServiceTimelineHarness({ autoUpdateTimeline: false });
  const disabledResult = await disabled.service.polishChapter('c1', { userInstruction: '润色当前章' });
  const disabledAlignment = disabledResult.timelineAlignment;

  assert.equal(disabledAlignment.skipped, true);
  assert.equal(disabledAlignment.reason, 'autoUpdateTimeline_disabled');
  assert.equal(disabled.calls.some((call) => call.startsWith('align:')), false);
  assert.equal(disabled.calls.includes('timelineValidate'), false);

  const enabled = makeGenerationServiceTimelineHarness({ autoUpdateTimeline: true });
  const enabledResult = await enabled.service.polishChapter('c1', { userInstruction: '润色当前章' });
  const enabledAlignment = enabledResult.timelineAlignment;

  assert.equal(enabledAlignment.skipped, false);
  assert.equal(enabledAlignment.preview, enabled.preview);
  assert.equal(enabledAlignment.validation, enabled.validation);
  assert.ok(enabled.calls.includes('align:draft-final:chapter_generation:draft-final'));
  assert.ok(enabled.calls.includes('timelineValidate'));
  assert.equal(enabled.calls.some((call) => call.startsWith('timelinePersist:')), false);
});

test('GenerationService fails chapter generation when timeline validation rejects auto alignment', async () => {
  const { service, calls } = makeGenerationServiceTimelineHarness({ autoUpdateTimeline: true, validationValid: false });

  const result = await service.generateChapter('c1', { mode: 'draft' });

  assert.equal((result as { status: string }).status, 'failed');
  assert.match((result as { errorMessage: string }).errorMessage, /timeline alignment validation failed/);
  assert.ok(calls.includes('align:draft-final:job-1'));
  assert.ok(calls.includes('timelineValidate'));
  assert.equal(calls.includes('job.completed'), false);
});

test('GenerationService auto persists timeline only with explicit validated_auto_write policy', async () => {
  const { service, calls } = makeGenerationServiceTimelineHarness({
    autoUpdateTimeline: true,
    timelineAutoWritePolicy: 'validated_auto_write',
  });

  const result = await service.generateChapter('c1', { mode: 'draft' });
  const responsePayload = (result as { responsePayload: Record<string, unknown> }).responsePayload;
  const timelineAlignment = responsePayload.timelineAlignment as Record<string, unknown>;
  const persist = timelineAlignment.persist as Record<string, unknown>;

  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(timelineAlignment.autoWritePolicy, 'validated_auto_write');
  assert.equal(persist.createdCount, 1);
  assert.ok(calls.includes('timelinePersist:validated_auto_write'));
});

test('GenerationService rejects timeline auto write when validation has warnings', async () => {
  const { service, calls } = makeGenerationServiceTimelineHarness({
    autoUpdateTimeline: true,
    timelineAutoWritePolicy: 'validated_auto_write',
    validationIssues: [{ severity: 'warning', message: 'needs review' }],
  });

  const result = await service.generateChapter('c1', { mode: 'draft' });

  assert.equal((result as { status: string }).status, 'failed');
  assert.match((result as { errorMessage: string }).errorMessage, /zero validation issues/);
  assert.equal(calls.some((call) => call.startsWith('timelinePersist:')), false);
});

test('FactExtractorService 抽取事实后同步生成 pending_review 记忆且不写 TimelineEvent', async () => {
  const memoryInputs: Array<Record<string, unknown>> = [];
  const createdStoryEvents: Array<Record<string, unknown>> = [];
  const createdCharacters: Array<Record<string, unknown>> = [];
  const createdLorebookEntries: Array<Record<string, unknown>> = [];
  const timelineEventWrites: string[] = [];
  const timelineEventWriteGuard = {
    async create() { timelineEventWrites.push('create'); return { id: 'timeline-created' }; },
    async createMany() { timelineEventWrites.push('createMany'); return { count: 1 }; },
    async update() { timelineEventWrites.push('update'); return { id: 'timeline-updated' }; },
    async updateMany() { timelineEventWrites.push('updateMany'); return { count: 1 }; },
    async delete() { timelineEventWrites.push('delete'); return { id: 'timeline-deleted' }; },
    async deleteMany() { timelineEventWrites.push('deleteMany'); return { count: 1 }; },
    async upsert() { timelineEventWrites.push('upsert'); return { id: 'timeline-upserted' }; },
  };
  const prisma = {
    chapter: {
      async findFirst() {
        return { id: 'c1', projectId: 'p1', chapterNo: 12, title: '雨夜', objective: '推进冲突', conflict: '师徒对峙', timelineSeq: 12, project: { title: '测试书', generationProfile: { allowNewCharacters: true, allowNewLocations: true, allowNewForeshadows: true, preGenerationChecks: [] } } };
      },
    },
    chapterDraft: { async findFirst() { return { id: 'draft1', chapterId: 'c1', content: '林烬在雨夜得知真相，压下怒意，并注意到旧玉佩再次发光。' }; } },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    timelineEvent: timelineEventWriteGuard,
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        storyEvent: {
          async deleteMany() { return { count: 0 }; },
          async createMany(args: { data: unknown[] }) {
            createdStoryEvents.push(...(args.data as Array<Record<string, unknown>>));
            return { count: args.data.length };
          },
        },
        characterStateSnapshot: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        foreshadowTrack: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        timelineEvent: timelineEventWriteGuard,
        character: {
          async update(args: { data: Record<string, unknown> }) { return { id: 'character-existing', ...args.data }; },
          async create(args: { data: Record<string, unknown> }) {
            createdCharacters.push(args.data);
            return { id: 'character-new', ...args.data };
          },
        },
        lorebookEntry: {
          async create(args: { data: Record<string, unknown> }) {
            createdLorebookEntries.push(args.data);
            return { id: 'lore-new', ...args.data };
          },
        },
      });
    },
  };
  const llm = {
    async chat() { return { text: '雨夜中，林烬压下怒意并发现旧玉佩再度发光。' }; },
    async chatJson(_messages: unknown, options: { appStep: string }) {
      if (options.appStep === 'fact_extractor.events') return { data: [{ title: '雨夜发现', eventType: 'revelation', description: '林烬发现旧玉佩再度发光。', participants: ['林烬'], timelineSeq: 12 }] };
      if (options.appStep === 'fact_extractor.states') return { data: [{ character: '林烬', stateType: 'mental_state', stateValue: '压下怒意', summary: '林烬保持克制' }] };
      if (options.appStep === 'fact_extractor.foreshadows') return { data: [{ title: '旧玉佩异动', detail: '旧玉佩在雨夜再次发光', status: 'planted' }] };
      // 覆盖 P2 写入层增强：首次出现候选沉淀到 Character/Lorebook，并同步交给 MemoryWriter。
      if (options.appStep === 'fact_extractor.first_appearances') return {
        data: [
          { entityType: 'character', title: '沈砚', detail: '沈砚首次在雨夜现身。', significance: 'minor', evidence: '沈砚从雨幕中走出。' },
          { entityType: 'location', title: '地下档案库', detail: '地下档案库首次出现，存放旧案卷宗。', significance: 'major', evidence: '林烬进入地下档案库。' },
        ],
      };
      if (options.appStep === 'fact_extractor.relationships') return { data: [{ characterA: '林烬', characterB: '沈砚', relationType: 'trust_shift', change: '二人信任下降。', evidence: '沈砚隐瞒真相。', summary: '林烬与沈砚信任下降' }] };
      return { data: [] };
    },
  };
  const memoryWriter = {
    async replaceGeneratedChapterFactMemories(input: Record<string, unknown>) {
      memoryInputs.push(input);
      const events = input.events as unknown[];
      const characterStates = input.characterStates as unknown[];
      const foreshadows = input.foreshadows as unknown[];
      const firstAppearances = input.firstAppearances as Array<{ entityType: string; title: string; status: string }>;
      const chunks = [
        { id: 'm-summary', memoryType: 'summary', summary: '摘要', status: 'auto' },
        ...events.map((_, index) => ({ id: `m-event-${index}`, memoryType: 'event', summary: '事件', status: 'auto' })),
        ...characterStates.map((_, index) => ({ id: `m-state-${index}`, memoryType: 'character_state', summary: '状态', status: 'pending_review' })),
        ...foreshadows.map((_, index) => ({ id: `m-foreshadow-${index}`, memoryType: 'foreshadow', summary: '伏笔', status: 'pending_review' })),
        ...firstAppearances.map((item, index) => ({ id: `m-first-${index}`, memoryType: `first_appearance_${item.entityType}`, summary: `${item.title} 首次出现`, status: item.status })),
      ];
      return {
        deletedCount: 0,
        createdCount: chunks.length,
        embeddingAttachedCount: chunks.length,
        chunks,
      };
    },
  };
  const invalidatedProjectIds: string[] = [];
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new FactExtractorService(prisma as never, llm as never, memoryWriter as never, cache as never);

  const result = await service.extractChapterFacts('p1', 'c1', 'draft1');

  assert.equal(memoryInputs.length, 1);
  assert.equal(memoryInputs[0].generatedBy, 'agent_fact_extractor');
  assert.equal((memoryInputs[0].events as unknown[]).length, 2);
  assert.equal((memoryInputs[0].characterStates as unknown[]).length, 1);
  assert.equal((memoryInputs[0].foreshadows as unknown[]).length, 1);
  assert.equal((memoryInputs[0].firstAppearances as unknown[]).length, 2);
  assert.equal(result.createdEvents, 2);
  assert.equal(createdStoryEvents.length, 2);
  for (const createdStoryEvent of createdStoryEvents) {
    const metadata = createdStoryEvent.metadata as Record<string, unknown>;
    const sourceTrace = metadata.sourceTrace as Record<string, unknown>;
    const contextSources = sourceTrace.contextSources as Array<Record<string, unknown>>;
    assert.equal(createdStoryEvent.sourceDraftId, 'draft1');
    assert.equal(metadata.generatedBy, 'agent_fact_extractor');
    assert.equal(metadata.draftId, 'draft1');
    assert.equal(metadata.summary, result.summary);
    assert.equal(sourceTrace.sourceKind, 'chapter_fact_extraction');
    assert.equal(sourceTrace.projectId, 'p1');
    assert.equal(sourceTrace.chapterId, 'c1');
    assert.equal(sourceTrace.chapterNo, 12);
    assert.equal(sourceTrace.draftId, 'draft1');
    assert.equal(sourceTrace.toolName, 'extract_chapter_facts');
    assert.equal(sourceTrace.generatedBy, 'agent_fact_extractor');
    assert.equal(sourceTrace.summary, result.summary);
    assert.deepEqual(contextSources[0], { sourceType: 'chapter_draft', sourceId: 'draft1', chapterId: 'c1', chapterNo: 12 });
  }
  assert.equal(result.createdCharacterStates, 1);
  assert.equal(result.createdForeshadows, 1);
  assert.equal(result.createdCharacters, 1);
  assert.equal(result.createdLorebookCandidates, 1);
  assert.equal(result.firstAppearanceCandidates, 2);
  assert.equal(result.relationshipChanges.length, 1);
  assert.equal(result.createdMemoryChunks, 7);
  assert.equal(result.pendingReviewMemoryChunks, 3);
  assert.equal(createdCharacters[0].name, '沈砚');
  assert.equal(createdLorebookEntries[0].title, '地下档案库');
  assert.equal(createdLorebookEntries[0].status, 'pending_review');
  assert.equal((createdLorebookEntries[0].metadata as Record<string, unknown>).firstSeenChapterNo, 12);
  assert.equal((createdLorebookEntries[0].metadata as Record<string, unknown>).evidence, '林烬进入地下档案库。');
  assert.equal((createdLorebookEntries[0].metadata as Record<string, unknown>).significance, 'major');
  assert.deepEqual(timelineEventWrites, []);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
});

test('FactExtractorService respects GenerationProfile by keeping disallowed new characters pending review', async () => {
  const memoryInputs: Array<Record<string, unknown>> = [];
  let characterCreateCalled = false;
  const prisma = {
    chapter: {
      async findFirst() {
        return {
          id: 'c1',
          projectId: 'p1',
          chapterNo: 6,
          title: '暗巷',
          objective: '引出陌生人',
          conflict: '主角被跟踪',
          timelineSeq: 6,
          project: { title: '测试书', generationProfile: { allowNewCharacters: false, allowNewLocations: true, allowNewForeshadows: true, preGenerationChecks: [] } },
        };
      },
    },
    chapterDraft: { async findFirst() { return { id: 'draft1', chapterId: 'c1', content: '沈砚第一次在暗巷中现身。' }; } },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        storyEvent: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        characterStateSnapshot: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        foreshadowTrack: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        character: {
          async update() { return { id: 'character-existing' }; },
          async create() {
            characterCreateCalled = true;
            return { id: 'character-new' };
          },
        },
        lorebookEntry: { async create() { return { id: 'lore-new' }; } },
      });
    },
  };
  const llm = {
    async chat() { return { text: '沈砚在暗巷现身，主角无法判断他的立场。' }; },
    async chatJson(_messages: unknown, options: { appStep: string }) {
      if (options.appStep === 'fact_extractor.first_appearances') return { data: [{ entityType: 'character', title: '沈砚', detail: '沈砚首次现身。', significance: 'minor', evidence: '沈砚第一次在暗巷中现身。' }] };
      return { data: [] };
    },
  };
  const memoryWriter = {
    async replaceGeneratedChapterFactMemories(input: Record<string, unknown>) {
      memoryInputs.push(input);
      const firstAppearances = input.firstAppearances as Array<{ entityType: string; status: string }>;
      return {
        deletedCount: 0,
        createdCount: firstAppearances.length + 1,
        embeddingAttachedCount: firstAppearances.length + 1,
        chunks: [
          { id: 'm-summary', memoryType: 'summary', summary: '摘要', status: 'auto' },
          ...firstAppearances.map((item, index) => ({ id: `m-first-${index}`, memoryType: `first_appearance_${item.entityType}`, summary: '首现', status: item.status })),
        ],
      };
    },
  };
  const service = new FactExtractorService(prisma as never, llm as never, memoryWriter as never, { async deleteProjectRecallResults() {} } as never);

  const result = await service.extractChapterFacts('p1', 'c1', 'draft1');
  const firstAppearances = memoryInputs[0].firstAppearances as Array<{ status: string; entityType: string }>;

  assert.equal(characterCreateCalled, false);
  assert.equal(result.createdCharacters, 0);
  assert.equal(firstAppearances[0].entityType, 'character');
  assert.equal(firstAppearances[0].status, 'pending_review');
  assert.equal(result.pendingReviewMemoryChunks, 1);
});

function makeTimelineCandidateRaw(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 'tlc_plan_7',
    action: 'create_planned',
    chapterNo: 7,
    title: '雨夜发现旧玉佩异动',
    eventTime: '第七日傍晚',
    locationName: '旧档案库',
    participants: ['林烬', '沈砚'],
    cause: '林烬追查缺页档案',
    result: '旧玉佩在雨夜发光，指向被封存的旧案',
    impactScope: '主线线索',
    isPublic: false,
    knownBy: ['林烬'],
    unknownBy: ['沈砚'],
    eventStatus: 'planned',
    sourceType: 'agent_timeline_plan',
    impactAnalysis: '为下一章进入旧案线做事实约束。',
    conflictRisk: '需要避免让沈砚提前知道玉佩异动。',
    sourceTrace: {
      sourceKind: 'planned_timeline_event',
      projectId: 'p1',
      originTool: 'generate_timeline_preview',
      candidateId: 'tlc_plan_7',
      candidateAction: 'create_planned',
      chapterNo: 7,
      contextSources: [{ sourceType: 'chapter_outline', sourceId: 'outline-7', title: '第七章细纲', chapterNo: 7 }],
      evidence: '第七章细纲要求旧玉佩在雨夜异动。',
      generatedAt: '2026-05-08T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeAlignmentTimelineCandidateRaw(overrides: Record<string, unknown> = {}) {
  const candidateOverrides = { ...overrides };
  const sourceTraceOverrides = candidateOverrides.sourceTrace && typeof candidateOverrides.sourceTrace === 'object' && !Array.isArray(candidateOverrides.sourceTrace)
    ? candidateOverrides.sourceTrace as Record<string, unknown>
    : {};
  delete candidateOverrides.sourceTrace;
  const candidateId = typeof candidateOverrides.candidateId === 'string' ? candidateOverrides.candidateId : 'tl_align_confirm_7';
  const action = typeof candidateOverrides.action === 'string' ? candidateOverrides.action : 'confirm_planned';
  return makeTimelineCandidateRaw({
    candidateId,
    action,
    existingTimelineEventId: 'timeline-planned-7',
    chapterId: 'chapter-7',
    chapterNo: 7,
    title: 'Archive key revealed',
    eventTime: 'Chapter 7 night',
    locationName: 'Archive',
    participants: ['Lin Che'],
    cause: 'Lin Che follows the false key.',
    result: 'The planned archive breach happens in the draft.',
    impactScope: 'archive',
    isPublic: false,
    knownBy: ['Lin Che'],
    unknownBy: ['Shen Yan'],
    eventStatus: 'active',
    sourceType: 'agent_timeline_alignment',
    impactAnalysis: 'Confirms planned timeline from chapter evidence.',
    conflictRisk: 'No leak beyond knownBy.',
    ...candidateOverrides,
    sourceTrace: {
      sourceKind: 'chapter_timeline_alignment',
      projectId: 'p1',
      originTool: 'align_chapter_timeline_preview',
      agentRunId: 'run-align',
      toolName: 'align_chapter_timeline_preview',
      candidateId,
      candidateAction: action,
      chapterId: 'chapter-7',
      chapterNo: 7,
      draftId: 'draft-7',
      contextSources: [
        { sourceType: 'story_event', sourceId: 'story-1', title: 'Archive key revealed', chapterId: 'chapter-7', chapterNo: 7 },
        { sourceType: 'timeline_event', sourceId: 'timeline-planned-7', title: 'Archive key revealed', chapterId: 'chapter-7', chapterNo: 7 },
      ],
      evidence: 'StoryEvent story-1 confirms the planned archive breach.',
      generatedAt: '2026-05-08T00:00:00.000Z',
      ...sourceTraceOverrides,
    },
  });
}

function makeAlignmentTimelinePrisma(reads: string[], writes: string[], options: { storyEvents?: Array<Record<string, unknown>>; timelineEvents?: Array<Record<string, unknown>> } = {}) {
  const writeGuard = (name: string) => async () => {
    writes.push(name);
    throw new Error(`should not write ${name}`);
  };
  const storyEvents = options.storyEvents ?? [{
    id: 'story-1',
    projectId: 'p1',
    chapterId: 'chapter-7',
    chapterNo: 7,
    sourceDraftId: 'draft-7',
    title: 'Archive key revealed',
    eventType: 'plot',
    description: 'Lin Che confirms that the archive key is false.',
    participants: ['Lin Che'],
    timelineSeq: 1,
    status: 'detected',
    metadata: { sourceTrace: { draftId: 'draft-7' } },
    updatedAt: new Date('2026-05-08T00:00:00.000Z'),
  }];
  const timelineEvents = options.timelineEvents ?? [{
    id: 'timeline-planned-7',
    projectId: 'p1',
    chapterId: 'chapter-7',
    chapterNo: 7,
    title: 'Archive key revealed',
    eventTime: 'Chapter 7 night',
    locationName: 'Archive',
    participants: ['Lin Che'],
    cause: 'Lin Che follows the false key.',
    result: 'The archive gate opens.',
    impactScope: 'archive',
    isPublic: false,
    knownBy: ['Lin Che'],
    unknownBy: ['Shen Yan'],
    eventStatus: 'planned',
    sourceType: 'agent_timeline_plan',
    metadata: {},
    updatedAt: new Date('2026-05-08T00:00:00.000Z'),
  }];
  return {
    chapter: {
      async findFirst() {
        reads.push('chapter.findFirst');
        return { id: 'chapter-7', projectId: 'p1', chapterNo: 7, title: 'Chapter 7' };
      },
      async findMany() {
        reads.push('chapter.findMany');
        return [{ id: 'chapter-7', projectId: 'p1', chapterNo: 7, title: 'Chapter 7' }];
      },
      create: writeGuard('chapter.create'),
      createMany: writeGuard('chapter.createMany'),
      update: writeGuard('chapter.update'),
      delete: writeGuard('chapter.delete'),
      upsert: writeGuard('chapter.upsert'),
      updateMany: writeGuard('chapter.updateMany'),
      deleteMany: writeGuard('chapter.deleteMany'),
    },
    storyEvent: {
      async findMany() {
        reads.push('storyEvent.findMany');
        return storyEvents;
      },
      create: writeGuard('storyEvent.create'),
      createMany: writeGuard('storyEvent.createMany'),
      update: writeGuard('storyEvent.update'),
      delete: writeGuard('storyEvent.delete'),
      upsert: writeGuard('storyEvent.upsert'),
      updateMany: writeGuard('storyEvent.updateMany'),
      deleteMany: writeGuard('storyEvent.deleteMany'),
    },
    timelineEvent: {
      async findMany() {
        reads.push('timelineEvent.findMany');
        return timelineEvents;
      },
      create: writeGuard('timelineEvent.create'),
      createMany: writeGuard('timelineEvent.createMany'),
      update: writeGuard('timelineEvent.update'),
      delete: writeGuard('timelineEvent.delete'),
      upsert: writeGuard('timelineEvent.upsert'),
      updateMany: writeGuard('timelineEvent.updateMany'),
      deleteMany: writeGuard('timelineEvent.deleteMany'),
    },
  };
}

test('timeline preview normalize preserves supplied fields and sourceTrace without content fallback', () => {
  const candidate = normalizeTimelineCandidate(makeTimelineCandidateRaw(), {
    expectedProjectId: 'p1',
    expectedSourceKind: 'planned_timeline_event',
    expectedOriginTool: 'generate_timeline_preview',
  });
  const candidates = normalizeTimelineCandidates([makeTimelineCandidateRaw()], {
    expectedProjectId: 'p1',
    minCandidates: 1,
    maxCandidates: 1,
  });

  assert.equal(candidate.candidateId, 'tlc_plan_7');
  assert.equal(candidate.title, '雨夜发现旧玉佩异动');
  assert.equal(candidate.cause, '林烬追查缺页档案');
  assert.equal(candidate.result, '旧玉佩在雨夜发光，指向被封存的旧案');
  assert.equal(candidate.impactScope, '主线线索');
  assert.deepEqual(candidate.knownBy, ['林烬']);
  assert.deepEqual(candidate.unknownBy, ['沈砚']);
  assert.equal(candidate.sourceTrace.projectId, 'p1');
  assert.equal(candidate.metadata.sourceTrace.candidateId, 'tlc_plan_7');
  assert.equal(candidate.proposedFields.metadata.candidateAction, 'create_planned');
  assert.equal(candidates.length, 1);
});

test('timeline preview normalize fails when required content fields or trusted trace are missing', () => {
  for (const field of ['candidateId', 'title', 'eventTime', 'cause', 'result', 'impactScope', 'eventStatus', 'sourceType', 'impactAnalysis', 'conflictRisk']) {
    const raw = makeTimelineCandidateRaw({ [field]: '' });
    assert.throws(() => normalizeTimelineCandidate(raw), new RegExp(`timelineCandidate\\.${field}`));
  }

  for (const field of ['participants', 'knownBy', 'unknownBy']) {
    const raw = makeTimelineCandidateRaw({ [field]: [] });
    assert.throws(() => normalizeTimelineCandidate(raw), new RegExp(`timelineCandidate\\.${field}`));
  }

  assert.throws(() => normalizeTimelineCandidate(makeTimelineCandidateRaw({ chapterNo: undefined })), /chapterId or timelineCandidate\.chapterNo is required/);
  assert.throws(() => normalizeTimelineCandidate(makeTimelineCandidateRaw({ sourceTrace: undefined })), /timelineCandidate\.sourceTrace must be a JSON object/);
  assert.throws(
    () => normalizeTimelineCandidate(makeTimelineCandidateRaw({ sourceTrace: { ...(makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>), projectId: 'p2' } }), { expectedProjectId: 'p1' }),
    /cross-project or mismatched/,
  );
  assert.throws(() => normalizeTimelineCandidates([], { minCandidates: 1 }), /below required minimum 1/);
});

test('timeline preview chapter ref validation rejects missing cross-project and mismatched chapter refs', () => {
  const chapters = [
    { id: 'chapter-7', projectId: 'p1', chapterNo: 7 },
    { id: 'chapter-8', projectId: 'p1', chapterNo: 8 },
  ];
  const byNo = normalizeTimelineCandidate(makeTimelineCandidateRaw());
  const byId = normalizeTimelineCandidate(makeTimelineCandidateRaw({ chapterId: 'chapter-7' }));
  const resolved = validateTimelineCandidateChapterRefs([byNo, byId], chapters, 'p1');

  assert.deepEqual(resolved, [
    { candidateId: 'tlc_plan_7', chapterId: 'chapter-7', chapterNo: 7 },
    { candidateId: 'tlc_plan_7', chapterId: 'chapter-7', chapterNo: 7 },
  ]);
  assert.throws(
    () => validateTimelineCandidateChapterRefs([normalizeTimelineCandidate(makeTimelineCandidateRaw({ chapterId: 'chapter-7', chapterNo: 8 }))], chapters, 'p1'),
    /chapterId and chapterNo do not match/,
  );
  assert.throws(
    () => validateTimelineCandidateChapterRefs([normalizeTimelineCandidate(makeTimelineCandidateRaw({ chapterId: 'foreign-chapter' }))], chapters, 'p1'),
    /chapterId does not belong to current project/,
  );
  assert.throws(
    () => validateTimelineCandidateChapterRefs([normalizeTimelineCandidate(makeTimelineCandidateRaw({ chapterNo: 99 }))], chapters, 'p1'),
    /chapterNo does not belong to current project/,
  );
  assert.throws(
    () => validateTimelineCandidateChapterRefs([byNo], [{ id: 'foreign', projectId: 'p2', chapterNo: 7 }], 'p1'),
    /cross-project chapter/,
  );
});

test('timeline preview duplicate detection rejects same project same chapter title and time', () => {
  const base = normalizeTimelineCandidate(makeTimelineCandidateRaw());
  const duplicate = normalizeTimelineCandidate(makeTimelineCandidateRaw({
    candidateId: 'tlc_plan_dup',
    sourceTrace: { ...(makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>), candidateId: 'tlc_plan_dup' },
  }));
  const changedOwnEvent = normalizeTimelineCandidate(makeTimelineCandidateRaw({
    action: 'update_event',
    existingTimelineEventId: 'existing-1',
    sourceTrace: { ...(makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>), candidateAction: 'update_event' },
  }));
  const resolved = [{ candidateId: base.candidateId, chapterId: 'chapter-7', chapterNo: 7 }];

  assert.throws(
    () => assertNoTimelineDuplicateConflicts([base, duplicate], [], { expectedProjectId: 'p1' }),
    /Duplicate timeline candidates/,
  );
  assert.throws(
    () => assertNoTimelineDuplicateConflicts([base], [{ id: 'existing-1', projectId: 'p1', chapterNo: 7, title: base.title, eventTime: base.eventTime }], { expectedProjectId: 'p1', resolvedChapterRefs: resolved }),
    /would duplicate existing same-project TimelineEvent/,
  );
  assert.doesNotThrow(() => assertNoTimelineDuplicateConflicts(
    [changedOwnEvent],
    [{ id: 'existing-1', projectId: 'p1', chapterNo: 7, title: base.title, eventTime: base.eventTime }],
    { expectedProjectId: 'p1' },
  ));
  assert.throws(
    () => assertNoTimelineDuplicateConflicts([base], [{ id: 'foreign-existing', projectId: 'p2', chapterNo: 7, title: base.title, eventTime: base.eventTime }], { expectedProjectId: 'p1' }),
    /cross-project event/,
  );
});

test('timeline preview LLM normalization fails fast on LLM errors incomplete JSON missing fields and low counts', async () => {
  const options = {
    expectedProjectId: 'p1',
    expectedSourceKind: 'planned_timeline_event' as const,
    expectedOriginTool: 'generate_timeline_preview' as const,
    sourceKind: 'planned_timeline_event' as const,
    minCandidates: 1,
  };

  await assert.rejects(
    () => normalizeTimelinePreviewFromLlmCall(async () => { throw new Error('timeline LLM timeout'); }, options),
    /timeline LLM timeout/,
  );
  await assert.rejects(
    () => normalizeTimelinePreviewFromLlmCall(async () => ({ data: { assumptions: [], risks: [] } }), options),
    /timelinePreview\.candidates must be an array/,
  );
  await assert.rejects(
    () => normalizeTimelinePreviewFromLlmCall(async () => ({ data: { candidates: [makeTimelineCandidateRaw({ title: '' })], assumptions: [], risks: [] } }), options),
    /timelineCandidates\[0\]\.title/,
  );
  await assert.rejects(
    () => normalizeTimelinePreviewFromLlmCall(async () => ({ data: { candidates: [makeTimelineCandidateRaw()], assumptions: [], risks: [] } }), { ...options, minCandidates: 2 }),
    /below required minimum 2/,
  );

  const valid = await normalizeTimelinePreviewFromLlmCall(async () => ({ data: { candidates: [makeTimelineCandidateRaw()], assumptions: [], risks: [] } }), options);
  assert.equal(valid.writePlan.mode, 'preview_only');
  assert.equal(valid.writePlan.requiresValidation, true);
  assert.equal(valid.writePlan.requiresApprovalBeforePersist, true);
  assert.equal(valid.candidates.length, 1);
});

test('generate_timeline_preview tool returns planned read-only candidates and rejects non-planned output', async () => {
  const writes: string[] = [];
  const reads: string[] = [];
  const writeGuard = (name: string) => async () => {
    writes.push(name);
    throw new Error(`should not write ${name}`);
  };
  const baseTrace = makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>;
  const plannedCandidate = makeTimelineCandidateRaw({
    chapterId: 'chapter-7',
    sourceTrace: {
      ...baseTrace,
      agentRunId: 'run-timeline',
      toolName: 'generate_timeline_preview',
      chapterId: 'chapter-7',
    },
  });
  const prisma = {
    chapter: {
      async findMany() {
        reads.push('chapter.findMany');
        return [{ id: 'chapter-7', projectId: 'p1', chapterNo: 7 }];
      },
      create: writeGuard('chapter.create'),
      createMany: writeGuard('chapter.createMany'),
      update: writeGuard('chapter.update'),
      delete: writeGuard('chapter.delete'),
      upsert: writeGuard('chapter.upsert'),
      updateMany: writeGuard('chapter.updateMany'),
      deleteMany: writeGuard('chapter.deleteMany'),
    },
    timelineEvent: {
      async findMany() {
        reads.push('timelineEvent.findMany');
        return [];
      },
      create: writeGuard('timelineEvent.create'),
      createMany: writeGuard('timelineEvent.createMany'),
      update: writeGuard('timelineEvent.update'),
      delete: writeGuard('timelineEvent.delete'),
      upsert: writeGuard('timelineEvent.upsert'),
      updateMany: writeGuard('timelineEvent.updateMany'),
      deleteMany: writeGuard('timelineEvent.deleteMany'),
    },
  };
  const llmCalls: Array<{ options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(_messages: unknown, options: Record<string, unknown>) {
      llmCalls.push({ options });
      return {
        data: { candidates: [plannedCandidate], assumptions: ['来源为第七章细纲。'], risks: ['需在 validate 阶段检查知识范围。'] },
        result: { model: 'mock-timeline', usage: { total_tokens: 42 }, elapsedMs: 5 },
      };
    },
  };
  const usages: Array<Record<string, unknown>> = [];
  const context = {
    agentRunId: 'run-timeline',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
    recordLlmUsage: (usage: Record<string, unknown>) => usages.push(usage),
  };
  const tool = new GenerateTimelinePreviewTool(llm as never, prisma as never);

  const result = await tool.run({ instruction: '为第七章生成计划时间线', sourceType: 'chapter_outline', minCandidates: 1, maxCandidates: 1 }, context as never);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].action, 'create_planned');
  assert.equal(result.candidates[0].eventStatus, 'planned');
  assert.equal(result.candidates[0].sourceType, 'agent_timeline_plan');
  assert.equal(result.writePlan.mode, 'preview_only');
  assert.deepEqual(reads, ['chapter.findMany', 'timelineEvent.findMany']);
  assert.deepEqual(writes, []);
  assert.equal(llmCalls[0].options.jsonMode, true);
  assert.equal(usages[0].appStep, 'generate_timeline_preview');

  const invalidTool = new GenerateTimelinePreviewTool({
    async chatJson() {
      return {
        data: { candidates: [makeTimelineCandidateRaw({ ...plannedCandidate, eventStatus: 'active' })], assumptions: [], risks: [] },
        result: null,
      };
    },
  } as never, prisma as never);
  await assert.rejects(
    () => invalidTool.run({ instruction: '非法非计划输出', minCandidates: 1, maxCandidates: 1 }, context as never),
    /eventStatus must be planned/,
  );
  assert.deepEqual(writes, []);
});

test('align_chapter_timeline_preview returns read-only alignment candidates from StoryEvent evidence', async () => {
  const writes: string[] = [];
  const reads: string[] = [];
  const usages: Array<Record<string, unknown>> = [];
  const llmCalls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const candidate = makeAlignmentTimelineCandidateRaw();
  const prisma = makeAlignmentTimelinePrisma(reads, writes);
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      llmCalls.push({ messages, options });
      return {
        data: { candidates: [candidate], assumptions: [], risks: [] },
        result: { model: 'mock-align', usage: { total_tokens: 20 } },
      };
    },
  };
  const context = {
    agentRunId: 'run-align',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
    recordLlmUsage: (usage: Record<string, unknown>) => usages.push(usage),
  };
  const tool = new AlignChapterTimelinePreviewTool(llm as never, prisma as never);

  const result = await tool.run({ chapterId: 'chapter-7', draftId: 'draft-7', maxCandidates: 1 }, context as never);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].action, 'confirm_planned');
  assert.equal(result.candidates[0].existingTimelineEventId, 'timeline-planned-7');
  assert.equal(result.candidates[0].eventStatus, 'active');
  assert.equal(result.candidates[0].sourceType, 'agent_timeline_alignment');
  assert.equal(result.writePlan.mode, 'preview_only');
  assert.equal(result.writePlan.sourceKind, 'chapter_timeline_alignment');
  assert.deepEqual(reads, ['chapter.findFirst', 'storyEvent.findMany', 'timelineEvent.findMany']);
  assert.deepEqual(writes, []);
  assert.equal(llmCalls[0].options.jsonMode, true);
  assert.match(llmCalls[0].messages[1].content, /story-1/);
  assert.match(llmCalls[0].messages[1].content, /timeline-planned-7/);
  assert.equal(usages[0].appStep, 'align_chapter_timeline_preview');
});

test('align_chapter_timeline_preview supports confirm update create_discovered and archive actions', async () => {
  const writes: string[] = [];
  const reads: string[] = [];
  const storySource = { sourceType: 'story_event', sourceId: 'story-1', title: 'Archive key revealed', chapterId: 'chapter-7', chapterNo: 7 };
  const candidates = [
    makeAlignmentTimelineCandidateRaw(),
    makeAlignmentTimelineCandidateRaw({
      candidateId: 'tl_align_update_7',
      action: 'update_event',
      existingTimelineEventId: 'timeline-active-7',
      title: 'Guard identifies Lin Che',
      eventTime: 'Chapter 7 dawn',
      result: 'The guard now knows Lin Che used the false pass.',
      eventStatus: 'changed',
      sourceTrace: {
        contextSources: [
          storySource,
          { sourceType: 'timeline_event', sourceId: 'timeline-active-7', title: 'Guard identifies Lin Che', chapterId: 'chapter-7', chapterNo: 7 },
        ],
      },
    }),
    makeAlignmentTimelineCandidateRaw({
      candidateId: 'tl_align_create_7',
      action: 'create_discovered',
      existingTimelineEventId: undefined,
      title: 'Hidden seal breaks',
      eventTime: 'Chapter 7 late night',
      cause: 'Lin Che turns the false key twice.',
      result: 'A hidden seal breaks and reveals a fresh clue.',
      eventStatus: 'active',
      sourceTrace: { contextSources: [storySource] },
    }),
    makeAlignmentTimelineCandidateRaw({
      candidateId: 'tl_align_archive_7',
      action: 'archive_event',
      existingTimelineEventId: 'timeline-stale-7',
      title: 'Unused decoy path',
      eventTime: 'Chapter 7 noon',
      result: 'The planned decoy path is contradicted by the draft.',
      eventStatus: 'archived',
      sourceTrace: {
        contextSources: [
          storySource,
          { sourceType: 'timeline_event', sourceId: 'timeline-stale-7', title: 'Unused decoy path', chapterId: 'chapter-7', chapterNo: 7 },
        ],
      },
    }),
  ];
  const prisma = makeAlignmentTimelinePrisma(reads, writes, {
    timelineEvents: [
      {
        id: 'timeline-planned-7',
        projectId: 'p1',
        chapterId: 'chapter-7',
        chapterNo: 7,
        title: 'Archive key revealed',
        eventTime: 'Chapter 7 night',
        participants: ['Lin Che'],
        eventStatus: 'planned',
        sourceType: 'agent_timeline_plan',
      },
      {
        id: 'timeline-active-7',
        projectId: 'p1',
        chapterId: 'chapter-7',
        chapterNo: 7,
        title: 'Guard identifies Lin Che',
        eventTime: 'Chapter 7 dawn',
        participants: ['Lin Che'],
        eventStatus: 'active',
        sourceType: 'manual',
      },
      {
        id: 'timeline-stale-7',
        projectId: 'p1',
        chapterId: 'chapter-7',
        chapterNo: 7,
        title: 'Unused decoy path',
        eventTime: 'Chapter 7 noon',
        participants: ['Lin Che'],
        eventStatus: 'planned',
        sourceType: 'agent_timeline_plan',
      },
    ],
  });
  const llm = {
    async chatJson() {
      return { data: { candidates, assumptions: [], risks: [] }, result: null };
    },
  };
  const context = { agentRunId: 'run-align', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const previewTool = new AlignChapterTimelinePreviewTool(llm as never, prisma as never);
  const validateTool = new ValidateTimelinePreviewTool(prisma as never);

  const preview = await previewTool.run({ chapterId: 'chapter-7', draftId: 'draft-7', maxCandidates: 4 }, context as never);
  const validation = await validateTool.run({ preview }, context as never);

  assert.deepEqual(preview.candidates.map((candidate) => candidate.action), ['confirm_planned', 'update_event', 'create_discovered', 'archive_event']);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.accepted.map((candidate) => candidate.action), ['confirm_planned', 'update_event', 'create_discovered', 'archive_event']);
  assert.equal(validation.writePreview.summary.confirmPlannedCount, 1);
  assert.equal(validation.writePreview.summary.updateCount, 1);
  assert.equal(validation.writePreview.summary.createDiscoveredCount, 1);
  assert.equal(validation.writePreview.summary.archiveCount, 1);
  assert.equal(validation.writePreview.entries.find((entry) => entry.candidateId === 'tl_align_confirm_7')?.after?.eventStatus, 'active');
  assert.equal(validation.writePreview.entries.find((entry) => entry.candidateId === 'tl_align_update_7')?.after?.eventStatus, 'changed');
  assert.equal(validation.writePreview.entries.find((entry) => entry.candidateId === 'tl_align_create_7')?.after?.eventStatus, 'active');
  assert.equal(validation.writePreview.entries.find((entry) => entry.candidateId === 'tl_align_archive_7')?.after?.eventStatus, 'archived');
  assert.deepEqual(writes, []);
});

test('align_chapter_timeline_preview fails fast on LLM errors incomplete output and illegal trace refs', async () => {
  const allWrites: string[] = [];
  const context = {
    agentRunId: 'run-align',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
  };
  const makeTool = (dataOrError: unknown, options: { storyEvents?: Array<Record<string, unknown>> } = {}) => {
    const reads: string[] = [];
    const llm = {
      async chatJson() {
        if (dataOrError instanceof Error) throw dataOrError;
        return { data: dataOrError, result: null };
      },
    };
    return { tool: new AlignChapterTimelinePreviewTool(llm as never, makeAlignmentTimelinePrisma(reads, allWrites, options) as never) };
  };

  await assert.rejects(
    () => makeTool(new Error('alignment LLM timeout')).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /alignment LLM timeout/,
  );
  await assert.rejects(
    () => makeTool({ candidates: [], assumptions: [], risks: [] }).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /below required minimum/,
  );
  await assert.rejects(
    () => makeTool({ candidates: [makeAlignmentTimelineCandidateRaw({ cause: '' })], assumptions: [], risks: [] }).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /timelineCandidates\[0\]\.cause/,
  );
  await assert.rejects(
    () => makeTool({ candidates: [makeAlignmentTimelineCandidateRaw({ sourceTrace: { projectId: 'p2' } })], assumptions: [], risks: [] }).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /cross-project or mismatched/,
  );
  await assert.rejects(
    () => makeTool({ candidates: [makeAlignmentTimelineCandidateRaw({ chapterNo: 8, sourceTrace: { chapterNo: 8 } })], assumptions: [], risks: [] }).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /chapterNo must match current chapter/,
  );
  await assert.rejects(
    () => makeTool({ candidates: [makeAlignmentTimelineCandidateRaw()], assumptions: [], risks: [] }, { storyEvents: [] }).tool.run({ chapterId: 'chapter-7', draftId: 'draft-7' }, context as never),
    /requires current chapter StoryEvent evidence/,
  );
  assert.deepEqual(allWrites, []);
});

test('validate_timeline_preview returns accepted rejected writePreview and stays read-only', async () => {
  const writes: string[] = [];
  const reads: string[] = [];
  const writeGuard = (name: string) => async () => {
    writes.push(name);
    throw new Error(`should not write ${name}`);
  };
  const baseTrace = makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>;
  const acceptedRaw = makeTimelineCandidateRaw({
    chapterId: 'chapter-7',
    sourceTrace: {
      ...baseTrace,
      agentRunId: 'run-timeline',
      toolName: 'generate_timeline_preview',
      chapterId: 'chapter-7',
    },
  });
  const rejectedRaw = makeTimelineCandidateRaw({
    candidateId: 'tlc_update_8',
    action: 'update_event',
    chapterId: 'chapter-8',
    chapterNo: 8,
    title: '第八章计划修正旧档案线',
    eventTime: '第八日清晨',
    sourceTrace: {
      ...baseTrace,
      candidateId: 'tlc_update_8',
      candidateAction: 'update_event',
      agentRunId: 'run-timeline',
      toolName: 'generate_timeline_preview',
      chapterId: 'chapter-8',
      chapterNo: 8,
      contextSources: [{ sourceType: 'chapter_outline', sourceId: 'outline-8', title: '第八章细纲', chapterNo: 8 }],
    },
  });
  const preview = await normalizeTimelinePreviewFromLlmCall(
    async () => ({ data: { candidates: [acceptedRaw, rejectedRaw], assumptions: [], risks: [] } }),
    {
      expectedProjectId: 'p1',
      expectedSourceKind: 'planned_timeline_event',
      expectedOriginTool: 'generate_timeline_preview',
      sourceKind: 'planned_timeline_event',
      minCandidates: 1,
    },
  );
  const prisma = {
    chapter: {
      async findMany() {
        reads.push('chapter.findMany');
        return [
          { id: 'chapter-7', projectId: 'p1', chapterNo: 7 },
          { id: 'chapter-8', projectId: 'p1', chapterNo: 8 },
        ];
      },
      create: writeGuard('chapter.create'),
      createMany: writeGuard('chapter.createMany'),
      update: writeGuard('chapter.update'),
      delete: writeGuard('chapter.delete'),
      upsert: writeGuard('chapter.upsert'),
      updateMany: writeGuard('chapter.updateMany'),
      deleteMany: writeGuard('chapter.deleteMany'),
    },
    timelineEvent: {
      async findMany() {
        reads.push('timelineEvent.findMany');
        return [];
      },
      create: writeGuard('timelineEvent.create'),
      createMany: writeGuard('timelineEvent.createMany'),
      update: writeGuard('timelineEvent.update'),
      delete: writeGuard('timelineEvent.delete'),
      upsert: writeGuard('timelineEvent.upsert'),
      updateMany: writeGuard('timelineEvent.updateMany'),
      deleteMany: writeGuard('timelineEvent.deleteMany'),
    },
  };
  const context = {
    agentRunId: 'run-timeline',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
  };
  const tool = new ValidateTimelinePreviewTool(prisma as never);

  const result = await tool.run({ preview }, context as never);

  assert.equal(result.valid, false);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].candidateId, 'tlc_update_8');
  assert.match(result.rejected[0].reason, /requires existingTimelineEventId/);
  assert.equal(result.writePreview.summary.createPlannedCount, 1);
  assert.equal(result.writePreview.summary.updateCount, 1);
  assert.equal(result.writePreview.summary.rejectCount, 1);
  assert.equal(result.writePreview.entries[0].after?.title, acceptedRaw.title);
  assert.equal(result.writePreview.entries[1].action, 'reject');
  assert.deepEqual(reads, ['chapter.findMany', 'timelineEvent.findMany']);
  assert.deepEqual(writes, []);

  const forgedPreview = JSON.parse(JSON.stringify(preview));
  forgedPreview.candidates[0].sourceTrace.agentRunId = 'foreign-run';
  forgedPreview.candidates[0].metadata.sourceTrace.agentRunId = 'foreign-run';
  forgedPreview.candidates[0].proposedFields.metadata.sourceTrace.agentRunId = 'foreign-run';
  await assert.rejects(
    () => tool.run({ preview: forgedPreview }, context as never),
    /sourceTrace\.agentRunId must match current agent run/,
  );
  assert.deepEqual(writes, []);
});

test('persist_timeline_events requires approved act validation and writes only current project events', async () => {
  const baseTrace = makeTimelineCandidateRaw().sourceTrace as Record<string, unknown>;
  const candidateRaw = makeTimelineCandidateRaw({
    chapterId: 'chapter-7',
    sourceTrace: {
      ...baseTrace,
      agentRunId: 'run-timeline',
      toolName: 'generate_timeline_preview',
      chapterId: 'chapter-7',
    },
  });
  const preview = await normalizeTimelinePreviewFromLlmCall(
    async () => ({ data: { candidates: [candidateRaw], assumptions: [], risks: [] } }),
    {
      expectedProjectId: 'p1',
      expectedSourceKind: 'planned_timeline_event',
      expectedOriginTool: 'generate_timeline_preview',
      sourceKind: 'planned_timeline_event',
      minCandidates: 1,
    },
  );
  const createdData: Array<Record<string, unknown>> = [];
  const prisma = {
    chapter: {
      async findMany() {
        return [{ id: 'chapter-7', projectId: 'p1', chapterNo: 7 }];
      },
    },
    timelineEvent: {
      async findMany() {
        return [];
      },
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        chapter: {
          async findMany() {
            return [{ id: 'chapter-7', projectId: 'p1', chapterNo: 7 }];
          },
        },
        timelineEvent: {
          async findMany() {
            return [];
          },
          async create(args: { data: Record<string, unknown> }) {
            createdData.push(args.data);
            return { id: 'timeline-created', eventStatus: args.data.eventStatus };
          },
          async updateMany() {
            throw new Error('should not update');
          },
          async deleteMany() {
            throw new Error('should not delete');
          },
        },
      });
    },
  };
  const validateTool = new ValidateTimelinePreviewTool(prisma as never);
  const validation = await validateTool.run({
    preview,
  }, {
    agentRunId: 'run-timeline',
    projectId: 'p1',
    mode: 'plan',
    approved: false,
    outputs: {},
    policy: {},
  } as never);
  assert.equal(validation.valid, true);
  const invalidatedProjectIds: string[] = [];
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const persistTool = new PersistTimelineEventsTool(prisma as never, cache as never);
  const actContext = {
    agentRunId: 'run-timeline',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: { 1: preview, 2: validation },
    stepTools: { 1: 'generate_timeline_preview', 2: 'validate_timeline_preview' },
    policy: {},
  };

  await assert.rejects(
    () => persistTool.run({ preview, validation }, { ...actContext, mode: 'plan' } as never),
    /act mode/,
  );
  await assert.rejects(
    () => persistTool.run({ preview, validation }, { ...actContext, approved: false } as never),
    /requires explicit user approval/,
  );
  const clonedPreview = JSON.parse(JSON.stringify(preview));
  await assert.rejects(
    () => persistTool.run({ preview: clonedPreview, validation }, actContext as never),
    /preview must reference previous generate_timeline_preview output/,
  );
  const clonedValidation = JSON.parse(JSON.stringify(validation));
  await assert.rejects(
    () => persistTool.run({ preview, validation: clonedValidation }, actContext as never),
    /validation must reference previous validate_timeline_preview output/,
  );
  assert.equal(createdData.length, 0);
  await assert.rejects(
    () => persistTool.run(
      { preview, validation, dryRun: true },
      { ...actContext, approved: false, policy: { timelineAutoWrite: { source: 'generation_profile', strategy: 'validated_auto_write', projectId: 'p2' } } } as never,
    ),
    /projectId must match current project/,
  );
  const autoPolicyDryRun = await persistTool.run(
    { preview, validation, dryRun: true },
    { ...actContext, approved: false, policy: { timelineAutoWrite: { source: 'generation_profile', strategy: 'validated_auto_write', projectId: 'p1' } } } as never,
  );
  assert.equal(autoPolicyDryRun.createdCount, 0);
  assert.equal(createdData.length, 0);
  assert.deepEqual(invalidatedProjectIds, []);

  const result = await persistTool.run({ preview, validation }, actContext as never);

  assert.equal(result.createdCount, 1);
  assert.equal(result.confirmedCount, 0);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.archivedCount, 0);
  assert.equal(result.skippedUnselectedCount, 0);
  assert.deepEqual(result.events, [{ candidateId: 'tlc_plan_7', action: 'create_planned', timelineEventId: 'timeline-created', eventStatus: 'planned' }]);
  assert.equal(createdData.length, 1);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
  assert.deepEqual(createdData[0].project, { connect: { id: 'p1' } });
  assert.deepEqual(createdData[0].chapter, { connect: { id: 'chapter-7' } });
  assert.equal(createdData[0].sourceType, 'agent_timeline_plan');

  const forgedValidation = JSON.parse(JSON.stringify(validation));
  forgedValidation.accepted[0].sourceTrace.agentRunId = 'foreign-run';
  forgedValidation.writePreview.entries[0].sourceTrace.agentRunId = 'foreign-run';
  forgedValidation.writePreview.entries[0].after.metadata.sourceTrace.agentRunId = 'foreign-run';
  await assert.rejects(
    () => persistTool.run(
      { preview, validation: forgedValidation },
      { ...actContext, outputs: { 1: preview, 2: forgedValidation } } as never,
    ),
    /sourceTrace does not match validation\.accepted/,
  );
  assert.equal(createdData.length, 1);
  assert.deepEqual(invalidatedProjectIds, ['p1']);
});

test('RetrievalService 使用 querySpec hash 缓存召回并按开关和 Planner 查询隔离', async () => {
  const cacheStore = new Map<string, unknown>();
  const setHashes: string[] = [];
  let lorebookReadCount = 0;
  let structuredReadCount = 0;
  const prisma = {
    lorebookEntry: {
      async findMany() {
        lorebookReadCount += 1;
        return [{ id: 'l1', title: '雾城', entryType: 'location', summary: '雾城秘钥', content: '雾城秘钥藏在旧档案库。', tags: ['雾城'], priority: 80, metadata: { region: '北境', dangerLevel: 'high' } }];
      },
    },
    memoryChunk: { async count() { return 0; } },
    storyEvent: { async findMany() { structuredReadCount += 1; return []; } },
    characterStateSnapshot: { async findMany() { structuredReadCount += 1; return []; } },
    foreshadowTrack: { async findMany() { structuredReadCount += 1; return []; } },
  };
  const cache = {
    async getRecallResult(projectId: string, hash: string) {
      return cacheStore.get(`${projectId}:${hash}`) ?? null;
    },
    async setRecallResult(projectId: string, hash: string, result: unknown) {
      // 测试缓存存储序列化后的纯 JSON，模拟 Redis 往返，防止引用复用掩盖问题。
      cacheStore.set(`${projectId}:${hash}`, JSON.parse(JSON.stringify(result)));
      setHashes.push(hash);
    },
  };
  const service = new RetrievalService(prisma as never, {} as never, cache as never);
  const baseContext = {
    queryText: '雾城',
    chapterId: 'c1',
    chapterNo: 3,
    requestId: 'req-1',
    plannerQueries: { lorebook: [{ query: '雾城秘钥', importance: 'must', reason: '本章涉及雾城线索' }] },
  };

  const first = await service.retrieveBundleWithCacheMeta('p1', baseContext, { includeLorebook: true, includeMemory: false });
  const second = await service.retrieveBundleWithCacheMeta('p1', { ...baseContext, requestId: 'req-2' }, { includeLorebook: true, includeMemory: false });
  const withoutLorebook = await service.retrieveBundleWithCacheMeta('p1', baseContext, { includeLorebook: false, includeMemory: false });
  const changedPlannerQuery = await service.retrieveBundleWithCacheMeta(
    'p1',
    { ...baseContext, plannerQueries: { lorebook: [{ query: '完全不同的查询', importance: 'must', reason: '验证 Planner query 隔离' }] } },
    { includeLorebook: true, includeMemory: false },
  );

  assert.equal(first.cache.hit, false);
  assert.equal(first.lorebookHits[0].metadata.entryType, 'location');
  assert.equal(first.lorebookHits[0].metadata.priority, 80);
  assert.equal(first.lorebookHits[0].metadata.region, '北境');
  assert.equal(first.lorebookHits[0].metadata.dangerLevel, 'high');
  assert.equal(second.cache.hit, true);
  assert.equal(first.cache.querySpecHash, second.cache.querySpecHash);
  assert.equal(withoutLorebook.cache.hit, false);
  assert.notEqual(withoutLorebook.cache.querySpecHash, first.cache.querySpecHash);
  assert.equal(changedPlannerQuery.cache.hit, false);
  assert.notEqual(changedPlannerQuery.cache.querySpecHash, first.cache.querySpecHash);
  assert.equal(lorebookReadCount, 2);
  assert.equal(structuredReadCount, 9);
  assert.equal(setHashes.length, 3);
});

test('Executor 将缺 chapterId 的 Schema 失败包装为可重规划 Observation', async () => {
  const failed: unknown[] = [];
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
  };
  const tools = { get: () => createTool({ name: 'write_chapter', requiresApproval: false, riskLevel: 'low', sideEffects: [], inputSchema: { type: 'object', required: ['chapterId'], properties: { chapterId: { type: 'string' } } } }) };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep(_runId: string, _stepNo: number, error: unknown) { failed.push(error); } };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  await assert.rejects(
    () => executor.execute('run1', [{ stepNo: 1, id: 'write', name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: false, args: { instruction: '写第十二章' } }], { mode: 'act', approved: true }),
    AgentExecutionObservationError,
  );

  const observation = failed[0] as { error: { code: string; missing?: string[]; retryable: boolean } };
  assert.equal(observation.error.code, 'MISSING_REQUIRED_ARGUMENT');
  assert.deepEqual(observation.error.missing, ['chapterId']);
  assert.equal(observation.error.retryable, true);
});

test('Executor 将自然语言 chapterId 的 ID Policy 失败包装为可修复 Observation', async () => {
  const failed: unknown[] = [];
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
  };
  const tools = {
    get: () => createTool({
      name: 'write_chapter',
      requiresApproval: false,
      riskLevel: 'low',
      sideEffects: [],
      inputSchema: { type: 'object', required: ['chapterId'], properties: { chapterId: { type: 'string' }, instruction: { type: 'string' } } },
      manifest: { idPolicy: { allowedSources: ['resolve_chapter.output.chapterId'] } } as never,
    }),
  };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep(_runId: string, _stepNo: number, error: unknown) { failed.push(error); } };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  await assert.rejects(
    () => executor.execute('run1', [{ stepNo: 1, id: 'write', name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: false, args: { chapterId: '第十二章', instruction: '压迫感强一点' } }], { mode: 'act', approved: true }),
    AgentExecutionObservationError,
  );

  const observation = failed[0] as { args: Record<string, unknown>; error: { code: string; retryable: boolean } };
  assert.equal(observation.args.chapterId, '第十二章');
  assert.equal(observation.error.code, 'SCHEMA_VALIDATION_FAILED');
  assert.equal(observation.error.retryable, true);
});

test('Executor 将润色缺少草稿识别为业务对象缺失而非内部错误', async () => {
  const failed: unknown[] = [];
  const prisma = {
    agentRun: {
      async findUnique(args: { select?: { status?: boolean } }) {
        return args.select?.status ? { status: 'acting' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'acting' };
      },
    },
  };
  const tools = {
    get: () => createTool({
      name: 'polish_chapter',
      requiresApproval: false,
      riskLevel: 'low',
      sideEffects: [],
      async run() {
        throw new NotFoundException('章节 11111111-1111-4111-8111-111111111111 没有可润色草稿，请先生成正文。');
      },
    }),
  };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = { startStep() {}, finishStep() {}, failStep(_runId: string, _stepNo: number, error: unknown) { failed.push(error); } };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  await assert.rejects(
    () => executor.execute('run1', [{ stepNo: 1, id: 'polish', name: '润色', tool: 'polish_chapter', mode: 'act', requiresApproval: false, args: { chapterId: '11111111-1111-4111-8111-111111111111' } }], { mode: 'act', approved: true }),
    AgentExecutionObservationError,
  );

  const observation = failed[0] as { error: { code: string; retryable: boolean } };
  assert.equal(observation.error.code, 'ENTITY_NOT_FOUND');
  assert.equal(observation.error.retryable, true);
});

test('Replanner 针对缺 chapterId 生成插入 resolve_chapter 的最小 patch', () => {
  const replanner = new AgentReplannerService({ get: (name: string) => createTool({ name, requiresApproval: false, sideEffects: [], riskLevel: 'low' }) } as never);
  const patch = replanner.createPatch({
    userGoal: '帮我写第十二章，压迫感强一点',
    agentContext: { session: { currentProjectId: 'p1' } } as never,
    currentPlanSteps: [{ stepNo: 1, id: 'write', name: '写正文', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: { instruction: '压迫感强一点' } }],
    failedObservation: { stepId: 'write', stepNo: 1, tool: 'write_chapter', mode: 'act', args: { instruction: '压迫感强一点' }, error: { code: 'MISSING_REQUIRED_ARGUMENT', message: 'write_chapter.input.chapterId 是必填字段', missing: ['chapterId'], retryable: true }, previousOutputs: {} },
  });

  assert.equal(patch.action, 'patch_plan');
  assert.equal(patch.insertStepsBeforeFailedStep?.[0].tool, 'resolve_chapter');
  assert.deepEqual(patch.replaceFailedStepArgs, { chapterId: '{{steps.resolve_chapter_for_failed_step_1.output.chapterId}}' });
});

test('Replanner 针对自然语言 characterId 生成插入 resolve_character 的最小 patch', () => {
  const replanner = new AgentReplannerService({ get: (name: string) => createTool({ name, requiresApproval: false, sideEffects: [], riskLevel: 'low' }) } as never);
  const patch = replanner.createPatch({
    userGoal: '检查男主有没有崩',
    agentContext: { session: { currentProjectId: 'p1' } } as never,
    currentPlanSteps: [{ stepNo: 1, id: 'check', name: '检查角色', tool: 'character_consistency_check', mode: 'act', requiresApproval: false, args: { characterId: '男主' } }],
    failedObservation: { stepId: 'check', stepNo: 1, tool: 'character_consistency_check', mode: 'act', args: { characterId: '男主' }, error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'character_consistency_check.characterId 必须来自上下文或 resolver，不能使用自然语言/伪造 ID：男主', retryable: true }, previousOutputs: {} },
  });

  assert.equal(patch.action, 'patch_plan');
  assert.equal(patch.insertStepsBeforeFailedStep?.[0].tool, 'resolve_character');
  assert.deepEqual(patch.replaceFailedStepArgs, { characterId: '{{steps.resolve_character_for_failed_step_1.output.characterId}}' });
});

test('Replanner 达到自动修复上限后不再生成 patch_plan', () => {
  const replanner = new AgentReplannerService({ get: (name: string) => createTool({ name, requiresApproval: false, sideEffects: [], riskLevel: 'low' }) } as never);
  const baseInput = {
    userGoal: '帮我写第十二章',
    agentContext: { session: { currentProjectId: 'p1' } } as never,
    currentPlanSteps: [{ stepNo: 1, id: 'write', name: '写正文', tool: 'write_chapter', mode: 'act' as const, requiresApproval: true, args: {} }],
    failedObservation: { stepId: 'write', stepNo: 1, tool: 'write_chapter', mode: 'act' as const, args: {}, error: { code: 'MISSING_REQUIRED_ARGUMENT' as const, message: 'write_chapter.input.chapterId 是必填字段', missing: ['chapterId'], retryable: true }, previousOutputs: {} },
  };

  assert.equal(replanner.createPatch({ ...baseInput, replanStats: { previousAutoPatchCount: 2, sameStepErrorPatchCount: 0 } }).action, 'fail_with_reason');
  assert.equal(replanner.createPatch({ ...baseInput, replanStats: { previousAutoPatchCount: 1, sameStepErrorPatchCount: 1 } }).action, 'fail_with_reason');
});

test('Replanner LLM 实验开关仅在确定性失败时生成安全只读 patch', async () => {
  const previous = process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
  process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = 'true';
  const llm = {
    async chatJson() {
      return {
        data: { action: 'patch_plan', reason: '补一次只读上下文收集', insertStepsBeforeFailedStep: [{ id: 'collect_context_for_failure', stepNo: 2, name: '补上下文', purpose: '补充只读上下文', tool: 'collect_task_context', mode: 'act', requiresApproval: false, args: { taskType: 'plot_consistency_check' } }], replaceFailedStepArgs: { context: '{{steps.collect_context_for_failure.output}}' } },
        result: { model: 'mock-replanner' },
      };
    },
  };
  const replanner = new AgentReplannerService({ get: (name: string) => createTool({ name, requiresApproval: false, sideEffects: [], riskLevel: 'low' }) } as never, llm as never);
  try {
    const patch = await replanner.createPatchWithExperimentalFallback({
      userGoal: '检查剧情是否矛盾',
      agentContext: { session: { currentProjectId: 'p1' } } as never,
      currentPlanSteps: [{ stepNo: 2, id: 'plot_check', name: '检查剧情', tool: 'plot_consistency_check', mode: 'act', requiresApproval: false, args: { context: '{{steps.missing.output}}' } }],
      failedObservation: { stepId: 'plot_check', stepNo: 2, tool: 'plot_consistency_check', mode: 'act', args: { context: '{{steps.missing.output}}' }, error: { code: 'TOOL_INTERNAL_ERROR', message: '缺少可用上下文', retryable: true }, previousOutputs: {} },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
    });
    assert.equal(patch.action, 'patch_plan');
    assert.equal(patch.insertStepsBeforeFailedStep?.[0].tool, 'collect_task_context');
    assert.equal(patch.insertStepsBeforeFailedStep?.[0].requiresApproval, false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
    else process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = previous;
  }
});

test('Replanner LLM 实验拒绝插入写入类或需审批步骤', async () => {
  const previous = process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
  process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = 'true';
  const llm = { async chatJson() { return { data: { action: 'patch_plan', reason: '危险写入', insertStepsBeforeFailedStep: [{ id: 'write_anyway', stepNo: 1, name: '写入', purpose: '绕过', tool: 'write_chapter', mode: 'act', requiresApproval: true, args: {} }] }, result: { model: 'mock-replanner' } }; } };
  const replanner = new AgentReplannerService({ get: (name: string) => createTool({ name, requiresApproval: name === 'write_chapter', sideEffects: name === 'write_chapter' ? ['create_chapter_draft'] : [], riskLevel: name === 'write_chapter' ? 'medium' : 'low' }) } as never, llm as never);
  try {
    const patch = await replanner.createPatchWithExperimentalFallback({
      userGoal: '写章节',
      currentPlanSteps: [{ stepNo: 1, id: 'check', name: '检查', tool: 'plot_consistency_check', mode: 'act', requiresApproval: false, args: {} }],
      failedObservation: { stepId: 'check', stepNo: 1, tool: 'plot_consistency_check', mode: 'act', args: {}, error: { code: 'TOOL_INTERNAL_ERROR', message: '未知错误', retryable: true }, previousOutputs: {} },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
    });
    assert.equal(patch.action, 'fail_with_reason');
    assert.match(patch.reason, /没有匹配到可自动修复/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
    else process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = previous;
  }
});

test('AgentRunsService 全选 requiredApprovals 时将重试审批提升为整份计划审批', async () => {
  let receivedApprovedStepNos: number[] | undefined = [0];
  const prisma = {
    agentRun: { async findUnique() { return { id: 'run1', status: 'failed' }; } },
    agentPlan: { async findFirst() { return { requiredApprovals: [{ target: { stepNos: [3, 4] } }] }; } },
    agentApproval: { async create() { return {}; } },
  };
  const runtime = {
    async resumeFromFailedStep(_id: string, approvedStepNos?: number[]) {
      receivedApprovedStepNos = approvedStepNos;
      return { id: 'run1', status: 'succeeded' };
    },
  };
  const service = new AgentRunsService(prisma as never, runtime as never, {} as never);
  await service.retry('run1', { approval: true, approvedStepNos: [3, 4], confirmation: { confirmHighRisk: true } });

  assert.equal(receivedApprovedStepNos, undefined);
});

test('AgentRuntime 世界观 selectedTitles 局部重规划只 patch 持久化步骤并回到审批态', async () => {
  const createdPlans: Array<Record<string, unknown>> = [];
  const createdArtifacts: Array<Record<string, unknown>> = [];
  let updatedRun: Record<string, unknown> | undefined;
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', goal: '扩展宗门体系', input: {} }; },
      async update(args: { data: Record<string, unknown> }) { updatedRun = args.data; return { id: 'run1', ...args.data }; },
    },
    agentPlan: {
      async findFirst() {
        return {
          id: 'plan1',
          version: 2,
          taskType: 'worldbuilding_expand',
          summary: '世界观扩展计划',
          assumptions: [],
          risks: [],
          requiredApprovals: [],
          steps: [
            { stepNo: 1, id: 'preview', name: '预览', tool: 'generate_worldbuilding_preview', mode: 'act', requiresApproval: false, args: {} },
            { stepNo: 2, id: 'validate', name: '校验', tool: 'validate_worldbuilding', mode: 'act', requiresApproval: false, args: { preview: '{{steps.preview.output}}' } },
            { stepNo: 3, id: 'persist', name: '写入', tool: 'persist_worldbuilding', mode: 'act', requiresApproval: true, args: { preview: '{{steps.preview.output}}', validation: '{{steps.validate.output}}' } },
          ],
        };
      },
      async create(args: { data: Record<string, unknown> }) { createdPlans.push(args.data); return { id: 'plan2', version: args.data.version }; },
    },
    agentArtifact: { async create(args: { data: Record<string, unknown> }) { createdArtifacts.push(args.data); return args.data; } },
  };
  const trace = { async recordDecision() {} };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, {} as never, {} as never, trace as never);

  await runtime.replanWorldbuildingSelection('run1', ['新戒律', '山门制度'], '用户选择部分世界观条目');

  assert.equal(createdPlans[0].version, 3);
  assert.equal(createdPlans[0].status, 'waiting_approval');
  const steps = createdPlans[0].steps as Array<{ tool: string; args: Record<string, unknown> }>;
  assert.deepEqual(steps.find((step) => step.tool === 'persist_worldbuilding')?.args.selectedTitles, ['新戒律', '山门制度']);
  assert.equal(createdArtifacts[0].artifactType, 'agent_plan_preview');
  assert.equal(updatedRun?.status, 'waiting_approval');
});

test('AgentRunsService 澄清候选选择通过专用入口回到待审批计划', async () => {
  let receivedChoice: Record<string, unknown> | undefined;
  const prisma = {
    agentRun: { async findUnique() { return { id: 'run1', status: 'waiting_review' }; } },
  };
  const runtime = {
    async answerClarificationChoice(_id: string, choice: Record<string, unknown>, _message?: string) {
      receivedChoice = choice;
      return { id: 'run1', status: 'waiting_approval' };
    },
  };
  const service = new AgentRunsService(prisma as never, runtime as never, {} as never);
  (service as unknown as { get: (id: string) => Promise<unknown> }).get = async () => ({ id: 'run1', status: 'waiting_approval' });

  const result = await service.submitClarificationChoice('run1', { choice: { id: 'candidate_1', label: '林烬', payload: { characterId: 'char_1', name: '林烬' } }, message: '选择林烬' });

  assert.deepEqual(receivedChoice, { id: 'candidate_1', label: '林烬', payload: { characterId: 'char_1', name: '林烬' } });
  assert.equal((result as { status: string }).status, 'waiting_approval');
});

test('AgentRuntime 澄清候选选择写入上下文并重新规划而不执行工具', async () => {
  let inputAfterChoice: Record<string, unknown> | undefined;
  let plannerGoal = '';
  let previewOnly = false;
  let currentInput: Record<string, unknown> = { context: { currentProjectId: 'p1' } };
  const createdPlans: Array<Record<string, unknown>> = [];
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: '检查小林的人设', input: currentInput }; },
      async update(args: { data: Record<string, unknown> }) { if (args.data.input) { inputAfterChoice = args.data.input as Record<string, unknown>; currentInput = inputAfterChoice; } return { id: 'run1', ...args.data }; },
    },
    agentPlan: {
      async findFirst() { return { id: 'plan1', version: 1 }; },
      async create(args: { data: Record<string, unknown> }) { createdPlans.push(args.data); return { id: 'plan2', version: args.data.version }; },
    },
    agentArtifact: {
      async findFirst() { return { sourceStepNo: 1, content: { observation: { stepNo: 1, tool: 'resolve_character', error: { code: 'AMBIGUOUS_ENTITY' } }, replanPatch: { action: 'ask_user', questionForUser: '你说的小林是哪位角色？', choices: [{ id: 'candidate_1', label: '林烬' }] } } }; },
      async create() { return {}; },
      async createMany() { return {}; },
      async findMany() { return []; },
    },
  };
  const planner = {
    async createPlan(goal: string) {
      plannerGoal = goal;
      return { taskType: 'character_consistency_check', summary: '重新规划', assumptions: [], risks: [], steps: [{ stepNo: 1, id: 'resolve', name: '解析角色', tool: 'resolve_character', mode: 'act', requiresApproval: false, args: {} }], requiredApprovals: [], plannerDiagnostics: {} };
    },
  };
  const contextBuilder = { async buildForPlan() { return { schemaVersion: 2, session: { currentProjectId: 'p1' }, constraints: {}, availableTools: [] }; }, createDigest() { return 'digest'; } };
  const executor = { async execute(_agentRunId: string, _steps: unknown[], options: { previewOnly?: boolean }) { previewOnly = Boolean(options.previewOnly); return {}; } };
  const trace = { async recordDecision() {} };
  const runtime = new AgentRuntimeService(prisma as never, planner as never, contextBuilder as never, executor as never, {} as never, trace as never);

  await runtime.answerClarificationChoice('run1', { id: 'candidate_1', label: '林烬', payload: { characterId: 'char_1', name: '林烬' } }, '用户选择林烬');

  const choiceContext = inputAfterChoice?.context as Record<string, unknown> | undefined;
  const clarificationState = inputAfterChoice?.clarificationState as { history?: Array<Record<string, unknown>> } | undefined;
  assert.equal(typeof choiceContext?.clarificationChoice, 'object');
  assert.equal(clarificationState?.history?.length, 1);
  assert.equal(clarificationState?.history?.[0].question, '你说的小林是哪位角色？');
  assert.ok(plannerGoal.includes('澄清选择专用 API'));
  assert.equal(createdPlans[0].status, 'waiting_approval');
  assert.equal(previewOnly, true);
});

test('AgentRuntime 多轮澄清状态保留问题候选和最新选择', async () => {
  let currentInput: Record<string, unknown> = {
    context: { currentProjectId: 'p1' },
    clarificationState: {
      latestChoice: { id: 'chapter_12', label: '第十二章', payload: { chapterId: 'c12' }, answeredAt: '2026-04-28T00:00:00.000Z' },
      history: [{ roundNo: 1, question: '你要修改哪一章？', selectedChoice: { id: 'chapter_12', label: '第十二章', payload: { chapterId: 'c12' } }, answeredAt: '2026-04-28T00:00:00.000Z' }],
    },
  };
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: '继续澄清角色', input: currentInput }; },
      async update(args: { data: Record<string, unknown> }) { if (args.data.input) currentInput = args.data.input as Record<string, unknown>; return { id: 'run1', ...args.data }; },
    },
    agentPlan: { async findFirst() { return { id: 'plan1', version: 1 }; }, async create(args: { data: Record<string, unknown> }) { return { id: 'plan2', version: args.data.version }; } },
    agentArtifact: {
      async findFirst() { return { sourceStepNo: 2, content: { observation: { stepNo: 2, tool: 'resolve_character', error: { code: 'AMBIGUOUS_ENTITY' } }, replanPatch: { action: 'ask_user', questionForUser: '你说的男主是哪位？', choices: [{ id: 'char_1', label: '林烬' }, { id: 'char_2', label: '沈怀舟' }] } } }; },
      async create() { return {}; },
      async createMany() { return {}; },
      async findMany() { return []; },
    },
  };
  const planner = { async createPlan() { return { taskType: 'character_consistency_check', summary: '重新规划', assumptions: [], risks: [], steps: [], requiredApprovals: [] }; } };
  const contextBuilder = { async buildForPlan(run: { input: Record<string, unknown> }) { return { schemaVersion: 2, session: { clarification: (run.input.clarificationState as Record<string, unknown>) }, constraints: {}, availableTools: [] }; }, createDigest() { return 'digest'; } };
  const executor = { async execute() { return {}; } };
  const trace = { async recordDecision() {} };
  const runtime = new AgentRuntimeService(prisma as never, planner as never, contextBuilder as never, executor as never, {} as never, trace as never);

  await runtime.answerClarificationChoice('run1', { id: 'char_1', label: '林烬', payload: { characterId: 'char_1' } }, '选择男主林烬');

  const state = currentInput.clarificationState as { latestChoice: Record<string, unknown>; history: Array<Record<string, unknown>> };
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].question, '你要修改哪一章？');
  assert.equal(state.history[1].question, '你说的男主是哪位？');
  assert.equal((state.latestChoice.payload as Record<string, unknown>).characterId, 'char_1');
});

test('AgentContextBuilder 将多轮澄清状态注入 Planner session', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: '测试项目', genre: null, tone: null, synopsis: null, targetWordCount: 3000, status: 'active' }; } },
    chapter: { async findFirst() { return null; }, async findMany() { return []; } },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async findMany() { return []; } },
  };
  const tools = { listManifestsForPlanner() { return []; } };
  const builder = new (await import('./agent-context-builder.service')).AgentContextBuilderService(prisma as never, tools as never, new RuleEngineService());

  const context = await builder.buildForPlan({
    id: 'run1',
    projectId: 'p1',
    chapterId: null,
    goal: '继续处理澄清后的任务',
    input: {
      context: { requestedAssetTypes: ['outline', 'writingRules', 'unknown'], importPreviewMode: 'deep' },
      clarificationState: { latestChoice: { id: 'char_1', label: '林烬', payload: { characterId: 'char_1' } }, history: [{ roundNo: 1, question: '你说的小林是哪位？', selectedChoice: { id: 'char_1', label: '林烬' }, answeredAt: '2026-04-28T00:00:00.000Z' }] },
    } as never,
  });

  assert.equal(context.session.clarification?.history.length, 1);
  assert.equal(context.session.clarification?.latestChoice?.label, '林烬');
  assert.deepEqual(context.session.clarification?.latestChoice?.payload, { characterId: 'char_1' });
  assert.deepEqual(context.session.requestedAssetTypes, ['outline', 'writingRules']);
  assert.equal(context.session.importPreviewMode, 'deep');
});

test('WritingRulesService create update remove invalidate recall cache', async () => {
  const invalidatedProjectIds: string[] = [];
  const createdRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedRuleIds: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    writingRule: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'wr1', ...args.data };
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.id === 'missing') return null;
        return { id: 'wr1', projectId: 'p1', title: 'No spoilers', metadata: {} };
      },
      async update(args: { data: Record<string, unknown> }) {
        updatedRows.push(args.data);
        return { id: 'wr1', projectId: 'p1', ...args.data };
      },
      async delete(args: { where: { id: string } }) {
        deletedRuleIds.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  const cache = {
    async deleteProjectRecallResults(projectId: string) {
      invalidatedProjectIds.push(projectId);
    },
  };
  const service = new WritingRulesService(prisma as never, cache as never);

  const created = await service.create('p1', {
    ruleType: 'no_appearance',
    title: 'No spoilers',
    content: 'Do not let Shen Yan appear before chapter 8.',
    severity: 'error',
    appliesFromChapterNo: 1,
    entityRef: 'Shen Yan',
  });
  const updated = await service.update('p1', 'wr1', {
    content: 'Do not let Shen Yan appear before chapter 10.',
    appliesToChapterNo: 9,
  });
  const removed = await service.remove('p1', 'wr1');

  assert.equal(created.id, 'wr1');
  assert.equal(createdRows[0].projectId, 'p1');
  assert.equal(createdRows[0].entityRef, 'Shen Yan');
  assert.equal(updated.id, 'wr1');
  assert.equal(updatedRows[0].appliesToChapterNo, 9);
  assert.deepEqual(deletedRuleIds, ['wr1']);
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1', 'p1']);
  assert.deepEqual(removed, { deleted: true, id: 'wr1' });
});

test('RetrievalService returns phase2 structured hits and filters future chapter facts', async () => {
  const prisma = {
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: { async count() { return 0; } },
    storyEvent: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    relationshipEdge: {
      async findMany() {
        return [
          {
            id: 'rel-visible',
            characterAId: 'char-1',
            characterBId: 'char-2',
            characterAName: 'Lin Che',
            characterBName: 'Shen Yan',
            relationType: 'allies',
            publicState: 'fragile trust',
            hiddenState: null,
            conflictPoint: 'the stolen key',
            emotionalArc: null,
            turnChapterNos: [2],
            finalState: null,
            status: 'active',
            sourceType: 'relationship_edge',
            metadata: {},
          },
          {
            id: 'rel-future',
            characterAId: 'char-1',
            characterBId: 'char-3',
            characterAName: 'Lin Che',
            characterBName: 'Mu Qin',
            relationType: 'betrayal',
            publicState: 'future reveal',
            hiddenState: null,
            conflictPoint: null,
            emotionalArc: null,
            turnChapterNos: [5],
            finalState: null,
            status: 'active',
            sourceType: 'relationship_edge',
            metadata: {},
          },
        ];
      },
    },
    timelineEvent: {
      async findMany() {
        return [
          {
            id: 'time-previous-active',
            chapterId: 'c2',
            chapterNo: 2,
            title: 'Archive bell tolls',
            eventTime: '2',
            locationName: 'Archive',
            participants: ['Archivist'],
            cause: 'night watch',
            result: 'the archive is sealed before the key is exposed',
            impactScope: 'archive',
            isPublic: true,
            knownBy: ['Archivist'],
            unknownBy: ['Lin Che'],
            eventStatus: 'active',
            sourceType: 'agent_timeline_plan',
            metadata: {},
          },
          {
            id: 'time-visible',
            chapterId: 'c3',
            chapterNo: 3,
            title: 'Stolen key exposed',
            eventTime: '3',
            locationName: 'Archive',
            participants: ['Lin Che', 'Shen Yan'],
            cause: 'archive break-in',
            result: 'the stolen key is exposed',
            impactScope: 'city',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'active',
            sourceType: 'timeline_event',
            metadata: {},
          },
          {
            id: 'time-planned',
            chapterId: 'c2',
            chapterNo: 2,
            title: 'Planned key rehearsal',
            eventTime: '2',
            locationName: 'Archive',
            participants: ['Lin Che'],
            cause: 'outline plan',
            result: 'planned event is not verified',
            impactScope: 'city',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'planned',
            sourceType: 'agent_timeline_plan',
            metadata: {},
          },
          {
            id: 'time-future-active',
            chapterId: 'c5',
            chapterNo: 5,
            title: 'Future oath reveal',
            eventTime: '5',
            locationName: 'Archive',
            participants: ['Lin Che', 'Shen Yan'],
            cause: 'future scene',
            result: 'true name revealed later',
            impactScope: 'city',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'active',
            sourceType: 'agent_timeline_plan',
            metadata: {},
          },
          {
            id: 'time-unscoped-active',
            chapterId: null,
            chapterNo: null,
            title: 'Unscoped active timeline note',
            eventTime: 'unknown',
            locationName: 'Archive',
            participants: ['Lin Che'],
            cause: 'manual note',
            result: 'cannot prove chapter order',
            impactScope: 'city',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'active',
            sourceType: 'manual',
            metadata: {},
          },
        ];
      },
    },
    writingRule: {
      async findMany() {
        return [
          {
            id: 'rule-visible',
            ruleType: 'forbidden',
            title: 'No true name',
            content: 'Do not reveal Shen Yan true name before the oath scene.',
            severity: 'error',
            appliesFromChapterNo: 1,
            appliesToChapterNo: 3,
            entityType: 'character',
            entityRef: 'Shen Yan',
            status: 'active',
            metadata: {},
          },
        ];
      },
    },
  };
  const cache = {
    async getRecallResult() { return null; },
    async setRecallResult() {},
  };
  const service = new RetrievalService(prisma as never, {} as never, cache as never);

  const bundle = await service.retrieveBundleWithCacheMeta(
    'p1',
    {
      queryText: 'Lin Che Shen Yan stolen key true name',
      chapterNo: 3,
      characters: ['Lin Che', 'Shen Yan'],
      plannerQueries: {
        relationship: [{ query: 'Lin Che Shen Yan trust state', type: 'relationship_state', importance: 'should', reason: 'Need current relationship.' }],
        timeline: [{ query: 'stolen key event order and who knows it', type: 'timeline_event', importance: 'must', reason: 'Need timeline.' }],
        writingRule: [{ query: 'true name ban for Shen Yan', type: 'writing_rule', importance: 'must', reason: 'Need writing rule.' }],
      },
    },
    { includeLorebook: false, includeMemory: false },
  );

  assert.deepEqual(bundle.structuredHits.map((hit) => hit.sourceId).sort(), ['rel-visible', 'rule-visible', 'time-previous-active', 'time-visible']);
  assert.deepEqual(bundle.structuredHits.map((hit) => hit.sourceType).sort(), ['relationship_edge', 'timeline_event', 'timeline_event', 'writing_rule']);
  assert.equal(bundle.structuredHits.some((hit) => hit.sourceId === 'rel-future'), false);
  assert.equal(bundle.structuredHits.some((hit) => hit.sourceId === 'time-planned'), false);
  assert.equal(bundle.structuredHits.some((hit) => hit.sourceId === 'time-future-active'), false);
  assert.equal(bundle.structuredHits.some((hit) => hit.sourceId === 'time-unscoped-active'), false);
  const timelineHit = bundle.structuredHits.find((hit) => hit.sourceType === 'timeline_event');
  assert.ok(timelineHit);
  assert.equal([2, 3].includes(timelineHit.sourceTrace.chapterNo ?? 0), true);
  const previousTimelineHit = bundle.structuredHits.find((hit) => hit.sourceId === 'time-previous-active');
  assert.equal(previousTimelineHit?.sourceTrace.chapterNo, 2);
  assert.equal(previousTimelineHit?.metadata.eventStatus, 'active');
  assert.equal(bundle.diagnostics.qualityStatus, 'ok');

  const generationBundle = await service.retrieveBundleWithCacheMeta(
    'p1',
    {
      queryText: 'Lin Che Shen Yan stolen key true name',
      chapterId: 'c3',
      chapterNo: 3,
      excludeCurrentChapter: true,
      characters: ['Lin Che', 'Shen Yan'],
      plannerQueries: {
        relationship: [{ query: 'Lin Che Shen Yan trust state', type: 'relationship_state', importance: 'should', reason: 'Need previous relationship.' }],
        timeline: [{ query: 'stolen key event order and who knows it', type: 'timeline_event', importance: 'must', reason: 'Need previous timeline.' }],
        writingRule: [{ query: 'true name ban for Shen Yan', type: 'writing_rule', importance: 'must', reason: 'Need writing rule.' }],
      },
    },
    { includeLorebook: false, includeMemory: false },
  );

  assert.deepEqual(generationBundle.structuredHits.map((hit) => hit.sourceId).sort(), ['rel-visible', 'rule-visible', 'time-previous-active']);
  assert.equal(generationBundle.structuredHits.some((hit) => hit.sourceId === 'time-visible'), false);
  assert.equal(generationBundle.structuredHits.some((hit) => hit.sourceId === 'time-planned'), false);
  assert.equal(generationBundle.structuredHits.some((hit) => hit.sourceId === 'time-future-active'), false);
  assert.equal(generationBundle.structuredHits.some((hit) => hit.sourceId === 'time-unscoped-active'), false);
});

test('RetrievalPlannerService normalizes timeline and writing rule queries', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          chapterTasks: ['Trace what Shen Yan knows'],
          entities: { characters: ['Lin Che', 'Shen Yan'], locations: [], items: [], factions: [] },
          timelineQueries: [
            { query: '  stolen key knowledge  ', type: '', importance: 'invalid', reason: '' },
            { query: 'stolen key knowledge', type: 'timeline_event', importance: 'must', reason: 'duplicate should collapse' },
          ],
          writingRuleQueries: ['  true name ban  '],
        },
        result: { model: 'mock-planner' },
      };
    },
  };
  const service = new RetrievalPlannerService(llm as never);

  const result = await service.createPlan({
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 3, title: 'Archive Night', objective: 'Find the key', conflict: 'Shen Yan hides the truth', outline: 'The archive is opened.' },
    characters: [{ name: 'Lin Che', roleType: null, personalityCore: null, motivation: null }, { name: 'Shen Yan', roleType: null, personalityCore: null, motivation: null }],
    previousChapters: [],
  });

  assert.equal(result.diagnostics.status, 'ok');
  assert.equal(result.plan.timelineQueries.length, 2);
  assert.equal(result.plan.timelineQueries[0].type, 'timeline');
  assert.equal(result.plan.timelineQueries[0].importance, 'should');
  assert.ok(result.plan.timelineQueries[0].reason.length > 0);
  assert.equal(result.plan.timelineQueries[1].type, 'timeline_event');
  assert.equal(result.plan.writingRuleQueries.length, 1);
  assert.equal(result.plan.writingRuleQueries[0].query, 'true name ban');
  assert.equal(result.plan.writingRuleQueries[0].type, 'writing_rule');
});

test('RetrievalPlannerService fallback keeps timeline and writing rule queries', async () => {
  const llm = {
    async chatJson() {
      throw new Error('planner unavailable');
    },
  };
  const service = new RetrievalPlannerService(llm as never);

  const result = await service.createPlan({
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 4, title: 'Aftermath', objective: 'Hide the leak', conflict: 'The secret spreads', outline: 'The team covers the trail.', foreshadowPlan: null, revealPoints: null },
    characters: [{ name: 'Lin Che', roleType: null, personalityCore: null, motivation: null }],
    previousChapters: [],
    userInstruction: 'Avoid spoilers and respect knowledge boundaries.',
  });

  assert.equal(result.diagnostics.status, 'fallback');
  assert.equal(result.plan.timelineQueries.length > 0, true);
  assert.equal(result.plan.writingRuleQueries.length > 0, true);
  assert.equal(result.plan.writingRuleQueries[0].importance, 'must');
});

test('PromptBuilderService renders dedicated relationship timeline and writing rule blocks with trace', async () => {
  const prisma = {
    promptTemplate: {
      async findFirst() {
        return {
          systemPrompt: 'system prompt',
          userTemplate: 'user template',
        };
      },
    },
  };
  const service = new PromptBuilderService(prisma as never);
  const context = {
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 3, title: 'Archive Night', objective: 'Find the key', conflict: 'Trust breaks', outline: 'Outline', expectedWordCount: 3000 },
    characters: [],
    plannedForeshadows: [],
    previousChapters: [],
    hardFacts: [],
    contextPack: {
      schemaVersion: 1,
      verifiedContext: {
        lorebookHits: [],
        memoryHits: [],
        structuredHits: [
          {
            sourceType: 'relationship_edge',
            sourceId: 'rel-1',
            projectId: 'p1',
            title: 'Lin Che / Shen Yan',
            content: 'trust is collapsing',
            score: 0.71,
            searchMethod: 'structured_keyword',
            reason: 'relationship match',
            sourceTrace: { sourceType: 'relationship_edge', sourceId: 'rel-1', projectId: 'p1', score: 0.71, searchMethod: 'structured_keyword', reason: 'relationship match' },
            metadata: {},
          },
          {
            sourceType: 'timeline_event',
            sourceId: 'time-1',
            projectId: 'p1',
            title: 'Stolen key exposed',
            content: 'unknownBy: Shen Yan',
            score: 0.82,
            searchMethod: 'structured_keyword',
            reason: 'timeline match',
            sourceTrace: { sourceType: 'timeline_event', sourceId: 'time-1', projectId: 'p1', chapterNo: 3, score: 0.82, searchMethod: 'structured_keyword', reason: 'timeline match' },
            metadata: {},
          },
          {
            sourceType: 'writing_rule',
            sourceId: 'rule-1',
            projectId: 'p1',
            title: 'No true name',
            content: 'Do not reveal the true name.',
            score: 0.93,
            searchMethod: 'structured_keyword',
            reason: 'rule match',
            sourceTrace: { sourceType: 'writing_rule', sourceId: 'rule-1', projectId: 'p1', score: 0.93, searchMethod: 'structured_keyword', reason: 'rule match' },
            metadata: {},
          },
        ],
      },
      planningContext: {
        sceneCards: [],
        plannedTimelineEvents: [
          {
            id: 'planned-time-1',
            title: 'Planned archive breach',
            chapterId: 'c3',
            chapterNo: 3,
            eventTime: '第三章夜',
            locationName: 'Archive',
            participants: ['Lin Che'],
            cause: 'Lin Che follows the false key.',
            result: 'The archive gate opens.',
            impactScope: 'archive',
            isPublic: false,
            knownBy: ['Lin Che'],
            unknownBy: ['Shen Yan'],
            eventStatus: 'planned',
            sourceType: 'agent_timeline_plan',
            metadata: {},
            sourceTrace: { sourceType: 'timeline_event' as const, sourceId: 'planned-time-1', projectId: 'p1', chapterId: 'c3', chapterNo: 3, eventStatus: 'planned', sourceKind: 'planned_timeline_event' },
          },
        ],
      },
      userIntent: {},
      retrievalDiagnostics: {
        includeLorebook: true,
        includeMemory: true,
        diagnostics: { searchMethod: 'disabled', qualityScore: 0.5, qualityStatus: 'ok', memoryAvailableCount: 0, warnings: [] },
      },
    },
  };

  const result = await service.buildChapterPrompt(context as never);

  assert.match(result.user, /人物关系网/);
  assert.match(result.user, /时间线/);
  assert.match(result.user, /写作约束/);
  assert.match(result.user, /sourceType=relationship_edge/);
  assert.match(result.user, /sourceId=rel-1/);
  assert.match(result.user, /sourceType=timeline_event/);
  assert.match(result.user, /sourceId=time-1/);
  assert.match(result.user, /current_chapter_planned_timeline/);
  assert.match(result.user, /verified fact/);
  assert.match(result.user, /sourceId=planned-time-1/);
  assert.match(result.user, /eventStatus=planned/);
  assert.match(result.user, /sourceType=writing_rule/);
  assert.match(result.user, /sourceId=rule-1/);
  assert.equal(result.debug.timelineEventCount, 1);
  assert.equal(result.debug.verifiedTimelineEventCount, 1);
  assert.equal(result.debug.plannedTimelineEventCount, 1);
  assert.deepEqual(result.debug.timelineLayerCounts, { verifiedActive: 1, plannedCurrent: 1 });
  assert.equal((result.debug.verifiedTimelineSourceTrace as Array<Record<string, unknown>>)[0].sourceId, 'time-1');
  assert.equal((result.debug.plannedTimelineSourceTrace as Array<Record<string, unknown>>)[0].sourceId, 'planned-time-1');
});

test('PromptBuilderService renders GenerationProfile new entity boundaries', async () => {
  const prisma = {
    promptTemplate: {
      async findFirst() {
        return {
          systemPrompt: 'system prompt',
          userTemplate: 'user template',
        };
      },
    },
  };
  const service = new PromptBuilderService(prisma as never);
  const context = {
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 3, title: 'Archive Night', objective: 'Find the key', conflict: 'Trust breaks', outline: 'Outline', expectedWordCount: 3000 },
    characters: [],
    plannedForeshadows: [],
    previousChapters: [],
    hardFacts: [],
    generationProfile: createGenerationProfile({ allowNewCharacters: false, allowNewLocations: true, allowNewForeshadows: false }),
    contextPack: {
      schemaVersion: 1,
      verifiedContext: { lorebookHits: [], memoryHits: [], structuredHits: [] },
      userIntent: {},
      generationProfile: createGenerationProfile({ allowNewCharacters: false, allowNewLocations: true, allowNewForeshadows: false }),
      retrievalDiagnostics: {
        includeLorebook: true,
        includeMemory: true,
        diagnostics: { searchMethod: 'disabled', qualityScore: 0.5, qualityStatus: 'ok', memoryAvailableCount: 0, warnings: [] },
      },
    },
  };

  const result = await service.buildChapterPrompt(context as never);

  assert.match(result.user, /新增事实策略/);
  assert.match(result.user, /允许新增候选：地点/);
  assert.match(result.user, /禁止新增事实：角色、伏笔/);
  assert.match(result.user, /待复核候选/);
});

test('PromptBuilderService renders current chapter SceneCard execution block as planning context', async () => {
  const prisma = {
    promptTemplate: {
      async findFirst() {
        return {
          systemPrompt: 'system prompt',
          userTemplate: 'user template',
        };
      },
    },
  };
  const service = new PromptBuilderService(prisma as never);
  const context = {
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 3, title: 'Archive Night', objective: 'Find the key', conflict: 'Trust breaks', outline: 'Outline', expectedWordCount: 3000 },
    characters: [],
    plannedForeshadows: [],
    previousChapters: [],
    hardFacts: [],
    contextPack: {
      schemaVersion: 1,
      verifiedContext: { lorebookHits: [], memoryHits: [], structuredHits: [] },
      planningContext: {
        sceneCards: [{
          id: 'scene-1',
          sceneNo: 1,
          title: 'Archive Gate',
          locationName: 'Old archive',
          participants: ['Lin Che', 'Shen Yan'],
          purpose: 'Get inside the archive.',
          conflict: 'The guard hides the ledger key.',
          emotionalTone: 'cold dread',
          keyInformation: 'The ledger has a missing page.',
          result: 'Lin Che gets a false key.',
          relatedForeshadowIds: ['foreshadow-ledger'],
          status: 'planned',
          metadata: { beat: 'reveal', camera: 'close' },
          sourceTrace: { sourceType: 'scene_card', sourceId: 'scene-1', projectId: 'p1', chapterId: 'c3', chapterNo: 3, sceneNo: 1 },
        }],
      },
      userIntent: {},
      retrievalDiagnostics: {
        includeLorebook: true,
        includeMemory: true,
        diagnostics: { searchMethod: 'disabled', qualityScore: 0.5, qualityStatus: 'ok', memoryAvailableCount: 0, warnings: [] },
      },
    },
  };

  const result = await service.buildChapterPrompt(context as never);

  assert.match(result.user, /【场景执行】/);
  assert.match(result.user, /SceneCard 是本章写作计划资产/);
  assert.match(result.user, /sourceType=scene_card/);
  assert.match(result.user, /sourceId=scene-1/);
  assert.match(result.user, /Archive Gate/);
  assert.match(result.user, /relatedForeshadowIds/);
  assert.match(result.user, /foreshadow-ledger/);
  assert.match(result.user, /metadata/);
  assert.match(result.user, /camera/);
  assert.equal(result.debug.sceneCardCount, 1);
  assert.deepEqual(result.debug.sceneCardSourceTrace, [{ sourceType: 'scene_card', sourceId: 'scene-1', projectId: 'p1', chapterId: 'c3', chapterNo: 3, sceneNo: 1 }]);
});

test('PromptBuilderService truncates SceneCard prompt rendering with explicit trace notice', async () => {
  const prisma = {
    promptTemplate: {
      async findFirst() {
        return {
          systemPrompt: 'system prompt',
          userTemplate: 'user template',
        };
      },
    },
  };
  const service = new PromptBuilderService(prisma as never);
  const sceneCards = Array.from({ length: 9 }, (_, index) => ({
    id: `scene-${index + 1}`,
    sceneNo: index + 1,
    title: `Scene ${index + 1}`,
    locationName: null,
    participants: [],
    purpose: `Purpose ${index + 1}`,
    conflict: null,
    emotionalTone: null,
    keyInformation: null,
    result: null,
    relatedForeshadowIds: [],
    status: 'planned',
    metadata: {},
    sourceTrace: { sourceType: 'scene_card' as const, sourceId: `scene-${index + 1}`, projectId: 'p1', chapterId: 'c3', chapterNo: 3, sceneNo: index + 1 },
  }));
  const context = {
    project: { id: 'p1', title: 'Novel', genre: null, tone: null, synopsis: null, outline: null },
    chapter: { chapterNo: 3, title: 'Archive Night', objective: 'Find the key', conflict: 'Trust breaks', outline: 'Outline', expectedWordCount: 3000 },
    characters: [],
    plannedForeshadows: [],
    previousChapters: [],
    hardFacts: [],
    contextPack: {
      schemaVersion: 1,
      verifiedContext: { lorebookHits: [], memoryHits: [], structuredHits: [] },
      planningContext: { sceneCards },
      userIntent: {},
      retrievalDiagnostics: {
        includeLorebook: true,
        includeMemory: true,
        diagnostics: { searchMethod: 'disabled', qualityScore: 0.5, qualityStatus: 'ok', memoryAvailableCount: 0, warnings: [] },
      },
    },
  };

  const result = await service.buildChapterPrompt(context as never);

  assert.match(result.user, /showing first 8 of 9/);
  assert.match(result.user, /Scene 8/);
  assert.doesNotMatch(result.user, /Scene 9/);
  assert.equal(result.debug.sceneCardCount, 9);
  assert.equal((result.debug.sceneCardSourceTrace as unknown[]).length, 9);
});

test('ValidationService flags writing rule no appearance deterministically', async () => {
  let createdIssues: Array<Record<string, unknown>> = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: 'Novel' }; } },
    chapter: { async findMany() { return [{ id: 'c2', chapterNo: 2, title: 'Blocked scene', timelineSeq: null }]; } },
    storyEvent: {
      async findMany() {
        return [{
          id: 'se-1',
          chapterId: 'c2',
          chapterNo: 2,
          title: 'Shen Yan enters the archive',
          description: 'A normal on-stage appearance.',
          participants: ['Shen Yan'],
          timelineSeq: null,
        }];
      },
    },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
    writingRule: {
      async findMany() {
        return [{
          id: 'wr-1',
          ruleType: 'no_appearance',
          title: 'Shen Yan cannot appear',
          content: 'Shen Yan must stay off-stage before chapter 8.',
          severity: 'error',
          appliesFromChapterNo: 1,
          appliesToChapterNo: 7,
          entityType: 'character',
          entityRef: 'Shen Yan',
          status: 'active',
        }];
      },
    },
    timelineEvent: { async findMany() { return []; } },
    validationIssue: {
      async deleteMany() { return { count: 0 }; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        createdIssues = args.data;
        return { count: args.data.length };
      },
    },
  };
  const service = new ValidationService(prisma as never);

  const result = await service.runFactRules('p1');

  assert.equal(result.createdCount, 1);
  assert.equal(result.issues[0].issueType, 'writing_rule_no_appearance');
  assert.equal(result.issues[0].entityId, 'se-1');
  assert.equal(createdIssues[0].issueType, 'writing_rule_no_appearance');
  assert.equal(createdIssues[0].severity, 'error');
});

test('ValidationService flags timeline unknownBy knowledge leak deterministically', async () => {
  let createdIssues: Array<Record<string, unknown>> = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: 'Novel' }; } },
    chapter: {
      async findMany() {
        return [
          { id: 'c2', chapterNo: 2, title: 'Leak setup', timelineSeq: null },
          { id: 'c3', chapterNo: 3, title: 'Leak payoff', timelineSeq: null },
        ];
      },
    },
    storyEvent: {
      async findMany() {
        return [{
          id: 'se-2',
          chapterId: 'c3',
          chapterNo: 3,
          title: 'Shen Yan mentions the stolen key',
          description: 'Shen Yan explains how the stolen key vanished.',
          participants: ['Shen Yan'],
          timelineSeq: null,
        }];
      },
    },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
    writingRule: { async findMany() { return []; } },
    timelineEvent: {
      async findMany() {
        return [{
          id: 'te-1',
          chapterId: 'c2',
          chapterNo: 2,
          title: 'Stolen key',
          eventTime: '2',
          locationName: 'Archive',
          participants: ['Lin Che'],
          cause: 'break-in',
          result: 'stolen key vanished',
          isPublic: false,
          knownBy: ['Lin Che'],
          unknownBy: ['Shen Yan'],
          eventStatus: 'active',
        }];
      },
    },
    validationIssue: {
      async deleteMany() { return { count: 0 }; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        createdIssues = args.data;
        return { count: args.data.length };
      },
    },
  };
  const service = new ValidationService(prisma as never);

  const result = await service.runFactRules('p1');

  assert.equal(result.createdCount, 1);
  assert.equal(result.issues[0].issueType, 'timeline_knowledge_leak');
  assert.equal(result.issues[0].entityId, 'se-2');
  assert.equal(createdIssues[0].issueType, 'timeline_knowledge_leak');
  assert.equal(createdIssues[0].severity, 'error');
});

test('RetrievalService filters future MemoryChunk hits by sourceTrace chapterNo', async () => {
  const prisma = {
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: {
      async count() { return 2; },
      async findMany() {
        return [
          {
            id: 'mem-past',
            sourceType: 'story_event',
            sourceId: 'source-past',
            memoryType: 'event',
            content: 'Lin Che found the past key in chapter two.',
            summary: 'past key',
            tags: [],
            status: 'auto',
            importanceScore: 80,
            recencyScore: 40,
            sourceTrace: { chapterNo: 2, chapterId: 'c2' },
          },
          {
            id: 'mem-future',
            sourceType: 'story_event',
            sourceId: 'source-future',
            memoryType: 'event',
            content: 'The future betrayal is revealed in chapter five.',
            summary: 'future betrayal',
            tags: [],
            status: 'auto',
            importanceScore: 100,
            recencyScore: 100,
            sourceTrace: { chapterNo: 5, chapterId: 'c5' },
          },
        ];
      },
    },
    storyEvent: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
  };
  const embeddings = {
    async embedTexts() {
      throw new Error('embedding unavailable');
    },
  };
  const cache = {
    async getRecallResult() { return null; },
    async setRecallResult() {},
  };
  const service = new RetrievalService(prisma as never, embeddings as never, cache as never);

  const bundle = await service.retrieveBundleWithCacheMeta(
    'p1',
    { queryText: 'key betrayal', chapterNo: 3 },
    { includeLorebook: false, includeMemory: true },
  );

  assert.deepEqual(bundle.memoryHits.map((hit) => hit.sourceId), ['mem-past']);
  assert.equal(bundle.memoryHits.some((hit) => hit.sourceId === 'mem-future'), false);
});

test('RetrievalService treats current chapter MemoryChunk rows as unavailable for generation recall', async () => {
  const prisma = {
    lorebookEntry: { async findMany() { return []; } },
    memoryChunk: {
      async count() { return 1; },
      async findMany() {
        return [
          {
            id: 'mem-current',
            sourceType: 'chapter',
            sourceId: 'c1',
            memoryType: 'summary',
            content: 'Old chapter one draft content should not return.',
            summary: 'old chapter one',
            tags: [],
            status: 'auto',
            importanceScore: 100,
            recencyScore: 100,
            sourceTrace: { chapterNo: 1, chapterId: 'c1' },
          },
        ];
      },
    },
    storyEvent: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
  };
  const embeddings = {
    async embedTexts() {
      throw new Error('embedding unavailable');
    },
  };
  const cache = {
    async getRecallResult() { return null; },
    async setRecallResult() {},
  };
  const service = new RetrievalService(prisma as never, embeddings as never, cache as never);

  const bundle = await service.retrieveBundleWithCacheMeta(
    'p1',
    { queryText: 'old chapter one', chapterId: 'c1', chapterNo: 1, excludeCurrentChapter: true },
    { includeLorebook: false, includeMemory: true },
  );

  assert.deepEqual(bundle.memoryHits, []);
  assert.equal(bundle.diagnostics.memoryAvailableCount, 0);
  assert.notEqual(bundle.diagnostics.qualityStatus, 'blocked');
});

test('RelationshipsService rejects character ids outside the current project', async () => {
  let createCalled = false;
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    character: {
      async findMany() {
        return [{ id: 'char-a' }];
      },
    },
    relationshipEdge: {
      async create() {
        createCalled = true;
        return { id: 'rel-1' };
      },
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new RelationshipsService(prisma as never, cache as never);

  await assert.rejects(
    () => service.create('p1', {
      characterAId: 'char-a',
      characterBId: 'char-other-project',
      characterAName: 'Lin Che',
      characterBName: 'Shen Yan',
      relationType: 'ally',
    }),
    /do not belong to project/,
  );
  assert.equal(createCalled, false);
});

test('TimelineEventsService resolves chapterNo to chapterId and rejects missing chapters', async () => {
  const createdRows: Array<Record<string, unknown>> = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.chapterNo === 2 ? { id: 'c2', chapterNo: 2 } : null;
      },
    },
    timelineEvent: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'te-1', ...args.data };
      },
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new TimelineEventsService(prisma as never, cache as never);

  const created = await service.create('p1', { title: 'Archive break-in', chapterNo: 2 });
  assert.equal(created.chapterId, 'c2');
  assert.equal(created.chapterNo, 2);
  assert.equal(createdRows[0].chapterId, 'c2');

  await assert.rejects(
    () => service.create('p1', { title: 'Missing chapter event', chapterNo: 99 }),
    /Chapter number not found/,
  );
});

test('WritingRulesService rejects inverted chapter ranges on create and update', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    writingRule: {
      async create() {
        throw new Error('create should not be called for invalid ranges');
      },
      async findFirst() {
        return {
          id: 'wr-1',
          projectId: 'p1',
          appliesFromChapterNo: 2,
          appliesToChapterNo: 8,
        };
      },
      async update() {
        throw new Error('update should not be called for invalid ranges');
      },
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new WritingRulesService(prisma as never, cache as never);

  await assert.rejects(
    () => service.create('p1', {
      ruleType: 'forbidden',
      title: 'Invalid range',
      content: 'This should not be saved.',
      appliesFromChapterNo: 10,
      appliesToChapterNo: 3,
    }),
    /chapter range is invalid/,
  );

  await assert.rejects(
    () => service.update('p1', 'wr-1', { appliesFromChapterNo: 9 }),
    /chapter range is invalid/,
  );
});

test('ValidationService does not treat writing rule entityRef as forbidden text', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1', title: 'Novel' }; } },
    chapter: { async findMany() { return [{ id: 'c2', chapterNo: 2, title: 'Quiet scene', timelineSeq: null }]; } },
    storyEvent: {
      async findMany() {
        return [{
          id: 'se-safe',
          chapterId: 'c2',
          chapterNo: 2,
          title: 'Shen Yan talks in the corridor',
          description: 'Shen Yan argues about patrol routes without mentioning the true name.',
          participants: ['Shen Yan'],
          timelineSeq: null,
        }];
      },
    },
    characterStateSnapshot: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    character: { async findMany() { return []; } },
    writingRule: {
      async findMany() {
        return [{
          id: 'wr-secret',
          ruleType: 'forbidden',
          title: 'Do not reveal Shen Yan secret',
          content: 'The forbidden phrase is "blood heir", not the target character name.',
          severity: 'error',
          appliesFromChapterNo: 1,
          appliesToChapterNo: 5,
          entityType: 'character',
          entityRef: 'Shen Yan',
          status: 'active',
          metadata: { forbiddenTerms: ['blood heir'] },
        }];
      },
    },
    timelineEvent: { async findMany() { return []; } },
    validationIssue: {
      async deleteMany() { return { count: 0 }; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        return { count: args.data.length };
      },
    },
  };
  const service = new ValidationService(prisma as never);

  const result = await service.runFactRules('p1');

  assert.equal(result.createdCount, 0);
  assert.equal(result.issues.some((issue) => issue.issueType === 'writing_rule_forbidden_text'), false);
});

test('RelationshipsService rejects character id and name mismatches', async () => {
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    character: {
      async findMany() {
        return [{ id: 'char-a', name: 'Lin Che' }, { id: 'char-b', name: 'Shen Yan' }];
      },
    },
    relationshipEdge: {
      async create() {
        throw new Error('create should not be called for mismatched names');
      },
    },
  };
  const cache = { async deleteProjectRecallResults() {} };
  const service = new RelationshipsService(prisma as never, cache as never);

  await assert.rejects(
    () => service.create('p1', {
      characterAId: 'char-a',
      characterBId: 'char-b',
      characterAName: 'Wrong Name',
      characterBName: 'Shen Yan',
      relationType: 'ally',
    }),
    /id\/name mismatch/,
  );
});

test('ScenesService create update remove validate refs and invalidate recall cache', async () => {
  const invalidatedProjectIds: string[] = [];
  const createdRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedSceneIds: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return ['v1', 'v2'].includes(args.where.id as string) && args.where.projectId === 'p1' ? { id: args.where.id } : null;
      },
    },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.id === 'c1' && args.where.projectId === 'p1') return { id: 'c1', volumeId: 'v1' };
        if (args.where.chapterNo === 2 && args.where.projectId === 'p1') return { id: 'c1' };
        return null;
      },
    },
    sceneCard: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'scene-1', ...args.data };
      },
      async findFirst(args: { where: { id: string; projectId: string } }) {
        if (args.where.id === 'missing' || args.where.projectId !== 'p1') return null;
        return { id: args.where.id, projectId: 'p1', volumeId: 'v1', chapterId: 'c1' };
      },
      async findMany(args: { where: Record<string, unknown> }) {
        return [{ id: 'scene-1', ...args.where }];
      },
      async update(args: { data: Record<string, unknown> }) {
        updatedRows.push(args.data);
        return { id: 'scene-1', projectId: 'p1', ...args.data };
      },
      async delete(args: { where: { id: string } }) {
        deletedSceneIds.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new ScenesService(prisma as never, cache as never);

  const created = await service.create('p1', {
    volumeId: 'v1',
    chapterId: 'c1',
    sceneNo: 1,
    title: 'Archive ambush',
    participants: [' Lin Che ', '', 'Shen Yan'],
  });
  const listed = await service.list('p1', { chapterNo: 2 });
  const updated = await service.update('p1', 'scene-1', { status: 'drafted' });
  const removed = await service.remove('p1', 'scene-1');

  assert.equal(created.volumeId, 'v1');
  assert.equal(created.chapterId, 'c1');
  assert.deepEqual(createdRows[0].participants, ['Lin Che', 'Shen Yan']);
  assert.equal(listed[0].chapterId, 'c1');
  assert.equal(updatedRows[0].status, 'drafted');
  assert.deepEqual(deletedSceneIds, ['scene-1']);
  assert.deepEqual(removed, { deleted: true, id: 'scene-1' });
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1', 'p1']);

  await assert.rejects(
    () => service.update('p1', 'scene-1', { volumeId: 'v2' }),
    /does not belong to volumeId/,
  );
  await assert.rejects(() => service.create('p1', { volumeId: 'missing-volume', title: 'Bad volume' }), /Volume not found in project/);
  await assert.rejects(() => service.create('p1', { chapterId: 'missing-chapter', title: 'Bad chapter' }), /Chapter not found in project/);
  await assert.rejects(() => service.update('p1', 'scene-1', { metadata: null } as never), /metadata must be a JSON object/);
  await assert.rejects(() => service.update('p1', 'scene-1', { participants: ['Lin Che', 42] } as never), /participants must contain only strings/);
  assert.deepEqual(await service.list('p1', { chapterNo: 99 }), []);
  await assert.rejects(() => service.update('other-project', 'scene-1', { status: 'drafted' }), /SceneCard not found/);
  await assert.rejects(() => service.remove('other-project', 'scene-1'), /SceneCard not found/);
  await assert.rejects(() => service.remove('p1', 'missing'), /SceneCard not found/);

  const missingProjectService = new ScenesService(
    {
      project: { async findUnique() { return null; } },
    } as never,
    cache as never,
  );
  await assert.rejects(() => missingProjectService.create('missing-project', { title: 'No project' }), /Project not found/);
});

test('GenerateChapterCraftBriefPreviewTool creates chapter progress card preview without writing', async () => {
  const progressPhases: string[] = [];
  const context = {
    agentRunId: 'run-craft-preview',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
    async updateProgress(patch: { phase?: string }) {
      if (patch.phase) progressPhases.push(patch.phase);
    },
  };
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: { async findFirst() { return { id: 'v1' }; } },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.projectId !== 'p1') return null;
        if (args.where.chapterNo === 3 || args.where.id === 'c3') {
          return {
            id: 'c3',
            volumeId: 'v1',
            chapterNo: 3,
            title: 'Archive pressure',
            objective: 'Find the sealed ledger.',
            conflict: 'The archivist blocks access and tests the protagonist.',
            outline: 'The protagonist enters the archive, bargains for access, and leaves with a dangerous clue.',
            status: 'planned',
            craftBrief: {},
          };
        }
        return null;
      },
      async findMany() {
        return [{
          id: 'c3',
          volumeId: 'v1',
          chapterNo: 3,
          title: 'Archive pressure',
          objective: 'Find the sealed ledger.',
          conflict: 'The archivist blocks access and tests the protagonist.',
          outline: 'The protagonist enters the archive, bargains for access, and leaves with a dangerous clue.',
          status: 'planned',
          craftBrief: {},
        }];
      },
    },
  };
  const llmCalls: Array<{ options: { timeoutMs?: number } }> = [];
  const llm = {
    async chatJson(_messages: unknown, options: { timeoutMs?: number }) {
      llmCalls.push({ options });
      return {
        data: {
          candidates: [{
            chapterNo: 3,
            title: 'Archive pressure',
            proposedFields: {
              objective: 'Secure proof that the ledger was replaced.',
              conflict: 'The archivist delays access while a rival searches the same shelf.',
              outline: 'A concrete archive confrontation turns a missing ledger into a public accusation.',
              craftBrief: createOutlineCraftBrief({
                visibleGoal: 'Secure proof that the ledger was replaced.',
                hiddenEmotion: 'He hides panic behind procedural confidence.',
                coreConflict: 'The archivist delays access while a rival searches the same shelf.',
                mainlineTask: 'Enter the restricted archive and identify the swapped ledger.',
                subplotTasks: ['Test whether Shen will protect him under pressure.'],
                actionBeats: ['Lin requests access under a false pretext.', 'The rival moves toward the same shelf before Lin reaches it.', 'Lin forces the archivist to choose a side in front of witnesses.'],
                concreteClues: [{ name: 'salt-stained ledger thread', sensoryDetail: 'It leaves grit on his thumb.', laterUse: 'Matches the rope used in the bridge collapse file.' }],
                dialogueSubtext: 'The archivist talks about humidity while warning him to leave.',
                characterShift: 'He stops treating the archive as neutral ground.',
                irreversibleConsequence: 'The rival sees him identify the swapped ledger and can now frame his next move.',
                progressTypes: ['info', 'relationship'],
              }),
            },
          }],
          assumptions: ['Chapter 3 remains planned.'],
          risks: [],
        },
        result: { model: 'mock', usage: {} },
      };
    },
  };

  const tool = new GenerateChapterCraftBriefPreviewTool(llm as never, prisma as never);
  const preview = await tool.run({ chapterNo: 3, instruction: 'Give chapter 3 a progress card.', context: { chapters: [{ id: 'c3', title: 'Archive pressure' }] } }, context);

  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].chapterId, 'c3');
  assert.equal(preview.candidates[0].proposedFields.craftBrief.visibleGoal, 'Secure proof that the ledger was replaced.');
  assert.equal(preview.candidates[0].proposedFields.craftBrief.actionBeats.length, 3);
  assert.equal(preview.candidates[0].proposedFields.craftBrief.concreteClues[0].name, 'salt-stained ledger thread');
  assert.equal(preview.writePlan.target, 'Chapter.craftBrief');
  assert.equal(preview.writePlan.requiresApprovalBeforePersist, true);
  assert.equal(llmCalls[0].options.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.deepEqual(progressPhases, ['preparing_context', 'calling_llm', 'validating']);
});

test('GenerateChapterCraftBriefPreviewTool LLM failure 直接抛错，不生成 baseline craftBrief', async () => {
  const context = { agentRunId: 'run-craft-fallback', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: { async findFirst() { return { id: 'v1' }; } },
    chapter: {
      async findFirst() {
        return {
          id: 'c4',
          volumeId: 'v1',
          chapterNo: 4,
          title: 'Locked gate',
          objective: 'Open the locked gate.',
          conflict: 'The guard refuses to honor the old pass.',
          outline: 'The protagonist negotiates, improvises, and leaves marked by the guard.',
          status: 'planned',
          craftBrief: {},
        };
      },
      async findMany() { return []; },
    },
  };
  const llm = {
    async chatJson() {
      const error = new Error('LLM_TIMEOUT');
      error.name = 'LlmTimeoutError';
      throw error;
    },
  };

  const tool = new GenerateChapterCraftBriefPreviewTool(llm as never, prisma as never);
  await assert.rejects(
    () => tool.run({ chapterId: 'c4', instruction: 'Make an execution card.' }, context),
    /LLM_TIMEOUT/,
  );
});

test('generate_chapter_craft_brief_preview craftBrief 局部缺字段可由 LLM 修复', async () => {
  const progressPhases: string[] = [];
  const context = {
    agentRunId: 'run-craft-repair',
    projectId: 'p1',
    mode: 'plan' as const,
    approved: false,
    outputs: {},
    policy: {},
    async updateProgress(patch: { phase?: string }) {
      if (patch.phase) progressPhases.push(patch.phase);
    },
  };
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: { async findFirst() { return { id: 'v1' }; } },
    chapter: {
      async findFirst() {
        return {
          id: 'c3',
          volumeId: 'v1',
          chapterNo: 3,
          title: 'Archive pressure',
          objective: 'Find the sealed ledger.',
          conflict: 'The archivist blocks access and tests the protagonist.',
          outline: 'The protagonist enters the archive, bargains for access, and leaves with a dangerous clue.',
          status: 'planned',
          craftBrief: {},
        };
      },
      async findMany() { return []; },
    },
  };
  const incompleteCraftBrief = createOutlineCraftBrief({
    visibleGoal: 'Secure proof that the ledger was replaced.',
    coreConflict: 'The archivist delays access while a rival searches the same shelf.',
  });
  delete (incompleteCraftBrief as Record<string, unknown>).irreversibleConsequence;
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const craftBrief = calls.length === 1
        ? incompleteCraftBrief
        : createOutlineCraftBrief({
          visibleGoal: 'Secure proof that the ledger was replaced.',
          coreConflict: 'The archivist delays access while a rival searches the same shelf.',
          irreversibleConsequence: 'The rival sees Lin identify the swapped ledger and can now frame his next move.',
        });
      return {
        data: {
          candidates: [{
            chapterNo: 3,
            title: 'Archive pressure',
            proposedFields: {
              objective: 'Secure proof that the ledger was replaced.',
              conflict: 'The archivist delays access while a rival searches the same shelf.',
              outline: 'A concrete archive confrontation turns a missing ledger into a public accusation.',
              craftBrief,
            },
          }],
          assumptions: [],
          risks: [],
        },
        result: { model: `mock-craft-${calls.length}`, usage: {} },
      };
    },
  };

  const tool = new GenerateChapterCraftBriefPreviewTool(llm as never, prisma as never);
  const preview = await tool.run({
    chapterId: 'c3',
    instruction: 'Give chapter 3 a progress card.',
    context: {
      chapters: [{ id: 'c3', title: 'Archive pressure' }],
      characters: [{ name: 'Lin Che' }],
      volumeOutline: { narrativePlan: { characterPlan: { newCharacterCandidates: [{ name: 'Archivist Qiao' }] } } },
    },
  }, context);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.jsonMode, true);
  assert.match(calls[1].messages[1].content, /irreversibleConsequence/);
  assert.match(calls[1].messages[1].content, /Lin Che/);
  assert.match(calls[1].messages[1].content, /Archivist Qiao/);
  assert.match(preview.candidates[0].proposedFields.craftBrief.irreversibleConsequence, /rival sees Lin/);
  assert.deepEqual(progressPhases, ['preparing_context', 'calling_llm', 'validating', 'calling_llm']);
});

test('generate_chapter_craft_brief_preview 候选数量不足时直接失败且不修复', async () => {
  const context = { agentRunId: 'run-craft-missing-candidate', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: { async findFirst() { return { id: 'v1' }; } },
    chapter: {
      async findFirst() {
        return {
          id: 'c4',
          volumeId: 'v1',
          chapterNo: 4,
          title: 'Locked gate',
          objective: 'Open the locked gate.',
          conflict: 'The guard refuses to honor the old pass.',
          outline: 'The protagonist negotiates, improvises, and leaves marked by the guard.',
          status: 'planned',
          craftBrief: {},
        };
      },
      async findMany() { return []; },
    },
  };
  let callCount = 0;
  const llm = {
    async chatJson() {
      callCount += 1;
      return {
        data: { candidates: [], assumptions: [], risks: [] },
        result: { model: 'mock-craft-missing-candidate', usage: {} },
      };
    },
  };

  const tool = new GenerateChapterCraftBriefPreviewTool(llm as never, prisma as never);
  await assert.rejects(
    () => tool.run({ chapterId: 'c4', instruction: 'Make an execution card.' }, context),
    /returned candidates 0\/1/,
  );
  assert.equal(callCount, 1);
});

test('ValidateChapterCraftBriefTool checks field completeness and drafted skip preview', async () => {
  const context = { agentRunId: 'run-craft-validate', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const sourceTrace = {
    sourceKind: 'chapter_craft_brief' as const,
    originTool: 'generate_chapter_craft_brief_preview' as const,
    agentRunId: context.agentRunId,
    candidateIndex: 0,
    instruction: 'progress card',
    chapterNo: 3,
    contextSources: [],
  };
  const completeCraftBrief = createOutlineCraftBrief({
    visibleGoal: 'Find the ledger.',
    hiddenEmotion: 'He hides fear behind procedure.',
    coreConflict: 'The archivist blocks access.',
    mainlineTask: 'Enter the archive and identify the ledger.',
    subplotTasks: ['Test an ally.'],
    actionBeats: ['Lin asks for archive access under seal.', 'The archivist blocks him while the rival approaches the shelf.', 'Lin forces the archivist to expose the fake key.'],
    concreteClues: [{ name: 'salt thread', sensoryDetail: 'Grit on the thumb.', laterUse: 'Links to the bridge file.' }],
    dialogueSubtext: 'Humidity talk hides a threat.',
    characterShift: 'He distrusts the archive.',
    irreversibleConsequence: 'The rival sees the clue and can frame him.',
    progressTypes: ['info'],
  });
  const preview = {
    candidates: [
      {
        candidateId: 'ccb_3_ok',
        chapterId: 'c3',
        chapterNo: 3,
        title: 'Archive pressure',
        status: 'planned',
        hasExistingCraftBrief: false,
        proposedFields: { objective: 'Find the ledger.', conflict: 'The archivist blocks access.', outline: 'Archive confrontation.', craftBrief: completeCraftBrief },
        risks: [],
        sourceTrace,
      },
      {
        candidateId: 'ccb_4_drafted',
        chapterId: 'c4',
        chapterNo: 4,
        title: 'Drafted chapter',
        status: 'drafted',
        hasExistingCraftBrief: true,
        proposedFields: { craftBrief: completeCraftBrief },
        risks: ['Chapter is drafted.'],
        sourceTrace: { ...sourceTrace, candidateIndex: 1, chapterNo: 4 },
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, target: 'Chapter.craftBrief' as const, requiresValidation: true as const, requiresApprovalBeforePersist: true as const },
  };
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    chapter: {
      async findMany() {
        return [
          { id: 'c3', chapterNo: 3, title: 'Archive pressure', status: 'planned' },
          { id: 'c4', chapterNo: 4, title: 'Drafted chapter', status: 'drafted' },
        ];
      },
    },
  };

  const tool = new ValidateChapterCraftBriefTool(prisma as never);
  const result = await tool.run({ preview }, context);

  assert.equal(result.valid, true);
  assert.deepEqual(result.accepted.map((item) => item.action), ['update', 'skip_by_default']);
  assert.equal(result.writePreview.chapters[0].action, 'update');
  assert.equal(result.writePreview.chapters[1].action, 'skip_by_default');
  assert.match(result.warnings.join(' | '), /skip it by default/);

  const badPreview = {
    ...preview,
    candidates: [{
      ...preview.candidates[0],
      proposedFields: {
        craftBrief: {
          ...completeCraftBrief,
          visibleGoal: '',
          actionBeats: ['Ask once.'],
          concreteClues: [],
          irreversibleConsequence: '',
        },
      },
    }],
  };
  const rejected = await tool.run({ preview: badPreview }, context);
  assert.equal(rejected.valid, false);
  assert.match(rejected.rejected[0].reasons.join(' | '), /visibleGoal/);
  assert.match(rejected.rejected[0].reasons.join(' | '), /actionBeats/);
  assert.match(rejected.rejected[0].reasons.join(' | '), /concreteClues/);
  assert.match(rejected.rejected[0].reasons.join(' | '), /irreversibleConsequence/);
});

test('PersistChapterCraftBriefTool writes planned craftBrief and skips drafted by default', async () => {
  const context = { agentRunId: 'run-craft-persist', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const sourceTrace = {
    sourceKind: 'chapter_craft_brief' as const,
    originTool: 'generate_chapter_craft_brief_preview' as const,
    agentRunId: context.agentRunId,
    candidateIndex: 0,
    instruction: 'progress card',
    chapterNo: 3,
    contextSources: [],
  };
  const craftBrief = createOutlineCraftBrief({
    visibleGoal: 'Find the ledger.',
    hiddenEmotion: 'He hides fear behind procedure.',
    coreConflict: 'The archivist blocks access.',
    mainlineTask: 'Enter the archive and identify the ledger.',
    subplotTasks: ['Test an ally.'],
    actionBeats: ['Lin asks for archive access under seal.', 'The archivist blocks him while the rival approaches the shelf.', 'Lin forces the archivist to expose the fake key.'],
    concreteClues: [{ name: 'salt thread', sensoryDetail: 'Grit on the thumb.', laterUse: 'Links to the bridge file.' }],
    dialogueSubtext: 'Humidity talk hides a threat.',
    characterShift: 'He distrusts the archive.',
    irreversibleConsequence: 'The rival sees the clue and can frame him.',
    progressTypes: ['info'],
  });
  const preview = {
    candidates: [
      {
        candidateId: 'ccb_3_ok',
        chapterId: 'c3',
        chapterNo: 3,
        title: 'Archive pressure',
        status: 'planned',
        hasExistingCraftBrief: false,
        proposedFields: { objective: 'Find the ledger.', conflict: 'The archivist blocks access.', outline: 'Archive confrontation.', craftBrief },
        risks: [],
        sourceTrace,
      },
      {
        candidateId: 'ccb_4_drafted',
        chapterId: 'c4',
        chapterNo: 4,
        title: 'Drafted chapter',
        status: 'drafted',
        hasExistingCraftBrief: false,
        proposedFields: { craftBrief: { ...craftBrief, visibleGoal: 'Should not overwrite by default.' } },
        risks: ['Chapter is drafted.'],
        sourceTrace: { ...sourceTrace, candidateIndex: 1, chapterNo: 4 },
      },
    ],
    assumptions: [],
    risks: [],
    writePlan: { mode: 'preview_only' as const, target: 'Chapter.craftBrief' as const, requiresValidation: true as const, requiresApprovalBeforePersist: true as const },
  };
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedChapterContexts: string[] = [];
  const invalidatedProjects: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    chapter: {
      async findMany() {
        return [
          { id: 'c3', chapterNo: 3, title: 'Archive pressure', status: 'planned' },
          { id: 'c4', chapterNo: 4, title: 'Drafted chapter', status: 'drafted' },
        ];
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.id === 'c3') return { id: 'c3', chapterNo: 3, title: 'Archive pressure', status: 'planned' };
        if (args.where.id === 'c4') return { id: 'c4', chapterNo: 4, title: 'Drafted chapter', status: 'drafted' };
        return null;
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        updatedRows.push({ id: args.where.id, ...args.data });
        return { id: args.where.id, chapterNo: args.where.id === 'c3' ? 3 : 4, title: args.where.id === 'c3' ? 'Archive pressure' : 'Drafted chapter', status: args.where.id === 'c3' ? 'planned' : 'drafted' };
      },
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(prisma);
    },
  };
  const validateTool = new ValidateChapterCraftBriefTool(prisma as never);
  const validation = await validateTool.run({ preview }, context);
  const cache = {
    async deleteChapterContext(_projectId: string, chapterId: string) { deletedChapterContexts.push(chapterId); },
    async deleteProjectRecallResults(projectId: string) { invalidatedProjects.push(projectId); },
  };
  const persistTool = new PersistChapterCraftBriefTool(prisma as never, cache as never);
  const persisted = await persistTool.run({ preview, validation }, { ...context, mode: 'act', approved: true });

  assert.equal(persisted.updatedCount, 1);
  assert.equal(persisted.skippedCount, 1);
  assert.equal(persisted.updatedChapters[0].id, 'c3');
  assert.equal(persisted.skippedChapters[0].chapterId, 'c4');
  assert.equal((updatedRows[0].craftBrief as Record<string, unknown>).visibleGoal, 'Find the ledger.');
  assert.equal(Object.prototype.hasOwnProperty.call(updatedRows[0], 'objective'), false);
  assert.deepEqual(deletedChapterContexts, ['c3']);
  assert.deepEqual(invalidatedProjects, ['p1']);
  assert.match(persisted.approvalMessage, /skipped drafted/);
  await assert.rejects(() => persistTool.run({ preview, validation }, { ...context, mode: 'act', approved: false }), /requires explicit user approval/);
});

test('SceneCard agent tools preview validate persist and update with approval boundaries', async () => {
  const context = { agentRunId: 'run-scene', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
  const createdRows: Array<Record<string, unknown>> = [];
  const invalidatedProjectIds: string[] = [];
  let updateData: Record<string, unknown> | undefined;
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.projectId === 'p1' && args.where.id === 'v1' ? { id: 'v1' } : null;
      },
      async findMany() {
        return [{ id: 'v1' }];
      },
    },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.projectId !== 'p1') return null;
        if (args.where.chapterNo === 3 || args.where.id === 'c1') return { id: 'c1', volumeId: 'v1', chapterNo: 3, title: 'Chapter 3' };
        return null;
      },
      async findMany() {
        return [{ id: 'c1', volumeId: 'v1', chapterNo: 3, title: 'Chapter 3' }];
      },
    },
    foreshadowTrack: { async findMany() { return []; } },
    sceneCard: {
      async findMany(args: { where: Record<string, unknown> }) {
        if (args.where.chapterId && typeof args.where.chapterId === 'object') return [];
        return [{
          id: 'scene-existing',
          projectId: 'p1',
          volumeId: 'v1',
          chapterId: 'c1',
          sceneNo: 1,
          title: 'Existing scene',
          participants: ['Lin'],
          relatedForeshadowIds: [],
          status: 'planned',
          metadata: {},
        }];
      },
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.NOT) return null;
        if (args.where.id === 'scene-existing' && args.where.projectId === 'p1') return { id: 'scene-existing', projectId: 'p1', volumeId: 'v1', chapterId: 'c1', sceneNo: 1 };
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'scene-created', title: args.data.title, chapterId: args.data.chapterId, sceneNo: args.data.sceneNo };
      },
      async update(args: { data: Record<string, unknown> }) {
        updateData = args.data;
        return {
          id: 'scene-existing',
          projectId: 'p1',
          volumeId: 'v1',
          chapterId: 'c1',
          sceneNo: args.data.sceneNo ?? 2,
          title: args.data.title ?? 'Existing scene',
          locationName: null,
          participants: args.data.participants ?? ['Lin'],
          purpose: null,
          conflict: args.data.conflict ?? null,
          emotionalTone: args.data.emotionalTone ?? null,
          keyInformation: null,
          result: null,
          relatedForeshadowIds: [],
          status: args.data.status ?? 'planned',
          metadata: args.data.metadata ?? {},
        };
      },
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(prisma);
    },
  };
  const llm = {
    async chatJson() {
      return {
        data: {
          candidates: [{
            sceneNo: 2,
            title: 'Archive confrontation',
            locationName: 'Archive',
            participants: ['Lin', 'Shen'],
            purpose: 'Reveal the missing ledger.',
            conflict: 'Lin wants proof while Shen hides the clue.',
            emotionalTone: 'tense',
            keyInformation: 'The ledger page is torn.',
            result: 'Lin suspects Shen.',
            relatedForeshadowIds: [],
            status: 'planned',
          }],
          assumptions: ['Chapter target is resolved.'],
          risks: [],
        },
        result: { text: '{}', model: 'mock', usage: {} },
      };
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };

  const listTool = new ListSceneCardsTool(prisma as never);
  const listed = await listTool.run({ chapterNo: 3 }, context);
  const previewTool = new GenerateSceneCardsPreviewTool(llm as never, prisma as never);
  const preview = await previewTool.run({ instruction: 'Split chapter 3.', chapterNo: 3, maxScenes: 1 }, context);
  const validateTool = new ValidateSceneCardsTool(prisma as never);
  const validation = await validateTool.run({ preview }, context);
  const persistTool = new PersistSceneCardsTool(prisma as never, cache as never);
  const persisted = await persistTool.run({ preview, validation }, { ...context, mode: 'act', approved: true });
  const updateTool = new UpdateSceneCardTool(prisma as never, cache as never);
  const updated = await updateTool.run({ sceneId: 'scene-existing', sceneNo: 2, conflict: 'The clue now directly threatens Shen.' }, { ...context, mode: 'act', approved: true });

  assert.equal(listed.scenes[0].id, 'scene-existing');
  assert.equal(preview.candidates[0].chapterId, 'c1');
  assert.equal(preview.candidates[0].volumeId, 'v1');
  assert.equal(validation.valid, true);
  assert.equal(validation.accepted[0].candidateId, preview.candidates[0].candidateId);
  assert.equal(persisted.createdCount, 1);
  assert.equal(createdRows[0].projectId, 'p1');
  assert.equal(createdRows[0].chapterId, 'c1');
  assert.equal(updated.scene.sceneNo, 2);
  assert.equal(updateData?.conflict, 'The clue now directly threatens Shen.');
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1']);
  await assert.rejects(() => persistTool.run({ preview, validation }, { ...context, mode: 'act', approved: false }), /requires explicit user approval/);
});

test('ChapterPatternsService create update remove invalidate recall cache', async () => {
  const invalidatedProjectIds: string[] = [];
  const createdRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedPatternIds: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    chapterPattern: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'pattern-1', ...args.data };
      },
      async findFirst(args: { where: { id: string; projectId: string } }) {
        if (args.where.id === 'missing' || args.where.projectId !== 'p1') return null;
        return { id: args.where.id, projectId: 'p1' };
      },
      async findMany(args: { where: Record<string, unknown> }) {
        return [{ id: 'pattern-1', ...args.where }];
      },
      async update(args: { data: Record<string, unknown> }) {
        updatedRows.push(args.data);
        return { id: 'pattern-1', projectId: 'p1', ...args.data };
      },
      async delete(args: { where: { id: string } }) {
        deletedPatternIds.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new ChapterPatternsService(prisma as never, cache as never);

  const created = await service.create('p1', {
    patternType: 'reveal',
    name: 'Secret reveal',
    applicableScenes: [' reveal ', '', 'trial'],
    structure: { beats: ['setup', 'turn'] },
  });
  const listed = await service.list('p1', { patternType: 'reveal' });
  const updated = await service.update('p1', 'pattern-1', { pacingAdvice: { target: 'tight' } });
  const removed = await service.remove('p1', 'pattern-1');

  assert.equal(created.patternType, 'reveal');
  assert.deepEqual(createdRows[0].applicableScenes, ['reveal', 'trial']);
  assert.equal(listed[0].patternType, 'reveal');
  assert.deepEqual(updatedRows[0].pacingAdvice, { target: 'tight' });
  assert.equal(updated.id, 'pattern-1');
  assert.deepEqual(deletedPatternIds, ['pattern-1']);
  assert.deepEqual(removed, { deleted: true, id: 'pattern-1' });
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1', 'p1']);

  await assert.rejects(() => service.update('p1', 'missing', { status: 'archived' }), /ChapterPattern not found/);
  await assert.rejects(() => service.update('other-project', 'pattern-1', { status: 'archived' }), /ChapterPattern not found/);
  await assert.rejects(() => service.remove('other-project', 'pattern-1'), /ChapterPattern not found/);
  await assert.rejects(() => service.update('p1', 'pattern-1', { structure: null } as never), /structure must be a JSON object/);
  await assert.rejects(() => service.update('p1', 'pattern-1', { applicableScenes: ['reveal', 7] } as never), /applicableScenes must contain only strings/);

  const missingProjectService = new ChapterPatternsService(
    {
      project: { async findUnique() { return null; } },
    } as never,
    cache as never,
  );
  await assert.rejects(
    () => missingProjectService.create('missing-project', { patternType: 'reveal', name: 'No project' }),
    /Project not found/,
  );
});

test('PacingBeatsService resolves chapter refs validates levels and invalidates recall cache', async () => {
  const invalidatedProjectIds: string[] = [];
  const createdRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const deletedBeatIds: string[] = [];
  const prisma = {
    project: { async findUnique() { return { id: 'p1' }; } },
    volume: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.id === 'v1' && args.where.projectId === 'p1' ? { id: 'v1' } : null;
      },
    },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.id === 'c2' && args.where.projectId === 'p1') return { id: 'c2', chapterNo: 2, volumeId: 'v1' };
        if (args.where.chapterNo === 2 && args.where.projectId === 'p1') return { id: 'c2', chapterNo: 2, volumeId: 'v1' };
        return null;
      },
    },
    pacingBeat: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'beat-1', ...args.data };
      },
      async findFirst(args: { where: { id: string; projectId: string } }) {
        if (args.where.id === 'missing' || args.where.projectId !== 'p1') return null;
        return { id: args.where.id, projectId: 'p1', volumeId: 'v1', chapterId: 'c2', chapterNo: 2 };
      },
      async findMany(args: { where: Record<string, unknown> }) {
        return [{ id: 'beat-1', ...args.where }];
      },
      async update(args: { data: Record<string, unknown> }) {
        updatedRows.push(args.data);
        return { id: 'beat-1', projectId: 'p1', ...args.data };
      },
      async delete(args: { where: { id: string } }) {
        deletedBeatIds.push(args.where.id);
        return { id: args.where.id };
      },
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new PacingBeatsService(prisma as never, cache as never);

  const created = await service.create('p1', { chapterNo: 2, beatType: 'setup' });
  const listed = await service.list('p1', { chapterNo: 2 });
  const updated = await service.update('p1', 'beat-1', { tensionLevel: 80 });
  const removed = await service.remove('p1', 'beat-1');

  assert.equal(created.chapterId, 'c2');
  assert.equal(created.volumeId, 'v1');
  assert.equal(createdRows[0].emotionalIntensity, 50);
  assert.equal(createdRows[0].tensionLevel, 50);
  assert.equal(createdRows[0].payoffLevel, 50);
  assert.equal(listed[0].chapterNo, 2);
  assert.equal(updatedRows[0].tensionLevel, 80);
  assert.equal(updated.id, 'beat-1');
  assert.deepEqual(deletedBeatIds, ['beat-1']);
  assert.deepEqual(removed, { deleted: true, id: 'beat-1' });
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1', 'p1']);

  await assert.rejects(() => service.create('p1', { beatType: 'bad', emotionalIntensity: 101 }), /between 0 and 100/);
  await assert.rejects(() => service.update('p1', 'beat-1', { chapterId: 'c2', chapterNo: 3 }), /chapterNo does not match/);
  await assert.rejects(() => service.create('p1', { volumeId: 'missing-volume', beatType: 'bad-volume' }), /Volume not found in project/);
  await assert.rejects(() => service.create('p1', { chapterId: 'missing-chapter', beatType: 'bad-chapter' }), /Chapter not found in project/);
  await assert.rejects(() => service.create('p1', { chapterNo: 99, beatType: 'bad-chapter-no' }), /Chapter number not found in project/);
  await assert.rejects(() => service.update('p1', 'beat-1', { volumeId: 'missing-volume' }), /Volume not found in project/);
  await assert.rejects(() => service.update('p1', 'beat-1', { metadata: null } as never), /metadata must be a JSON object/);
  await assert.rejects(() => service.update('other-project', 'beat-1', { tensionLevel: 60 }), /PacingBeat not found/);
  await assert.rejects(() => service.remove('other-project', 'beat-1'), /PacingBeat not found/);
  await assert.rejects(() => service.remove('p1', 'missing'), /PacingBeat not found/);

  const missingProjectService = new PacingBeatsService(
    {
      project: { async findUnique() { return null; } },
    } as never,
    cache as never,
  );
  await assert.rejects(() => missingProjectService.create('missing-project', { beatType: 'No project' }), /Project not found/);
});

test('QualityReportsService create list update remove validates refs and invalidates recall cache', async () => {
  const chapterId = '11111111-1111-4111-8111-111111111111';
  const draftId = '22222222-2222-4222-8222-222222222222';
  const agentRunId = '33333333-3333-4333-8333-333333333333';
  const invalidatedProjectIds: string[] = [];
  const createdRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const listWheres: Array<Record<string, unknown>> = [];
  const deletedReportIds: string[] = [];
  const prisma = {
    project: { async findUnique(args: { where: { id: string } }) { return args.where.id === 'missing-project' ? null : { id: args.where.id }; } },
    chapter: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.id === chapterId && args.where.projectId === 'p1' ? { id: chapterId } : null;
      },
    },
    chapterDraft: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.id === draftId && JSON.stringify(args.where).includes('"projectId":"p1"') ? { id: draftId, chapterId } : null;
      },
    },
    agentRun: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return args.where.id === agentRunId && args.where.projectId === 'p1' ? { id: agentRunId } : null;
      },
    },
    qualityReport: {
      async create(args: { data: Record<string, unknown> }) {
        createdRows.push(args.data);
        return { id: 'report-1', ...args.data };
      },
      async findMany(args: { where: Record<string, unknown> }) {
        listWheres.push(args.where);
        return [{ id: 'report-1', ...args.where }];
      },
      async findFirst(args: { where: { id: string; projectId: string } }) {
        if (args.where.id === 'missing' || args.where.projectId !== 'p1') return null;
        return { id: args.where.id, projectId: args.where.projectId, chapterId, draftId, agentRunId };
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        assert.deepEqual(args.where, { id: 'report-1', projectId: 'p1' });
        updatedRows.push(args.data);
        return { count: 1 };
      },
      async deleteMany(args: { where: { id: string; projectId: string } }) {
        assert.deepEqual(args.where, { id: 'report-1', projectId: 'p1' });
        deletedReportIds.push(args.where.id);
        return { count: 1 };
      },
    },
  };
  const cache = { async deleteProjectRecallResults(projectId: string) { invalidatedProjectIds.push(projectId); } };
  const service = new QualityReportsService(prisma as never, cache as never);

  const created = await service.create('p1', {
    draftId,
    agentRunId,
    sourceType: 'generation',
    sourceId: draftId,
    reportType: 'generation_quality_gate',
    scores: { overall: 92 },
    issues: [],
    verdict: 'pass',
    summary: 'ok',
  });
  const listed = await service.list('p1', { chapterId, draftId, agentRunId, sourceType: 'generation', reportType: 'generation_quality_gate', verdict: 'pass' });
  const updated = await service.update('p1', 'report-1', { verdict: 'warn', issues: [{ severity: 'warning', message: 'thin pacing' }] });
  const removed = await service.remove('p1', 'report-1');

  assert.equal(created.chapterId, chapterId);
  assert.equal(createdRows[0].draftId, draftId);
  assert.equal(listed[0].chapterId, chapterId);
  assert.deepEqual(listWheres[0], { projectId: 'p1', chapterId, draftId, agentRunId, sourceType: 'generation', reportType: 'generation_quality_gate', verdict: 'pass' });
  assert.equal(updatedRows[0].verdict, 'warn');
  assert.deepEqual(updatedRows[0].issues, [{ severity: 'warning', message: 'thin pacing' }]);
  assert.equal(updated.projectId, 'p1');
  assert.deepEqual(removed, { deleted: true, id: 'report-1' });
  assert.deepEqual(deletedReportIds, ['report-1']);
  assert.deepEqual(invalidatedProjectIds, ['p1', 'p1', 'p1']);

  await assert.rejects(() => service.list('p1', { chapterId: 'not-a-uuid' }), /UUID/);
  await assert.rejects(() => service.list('p1', { chapterId: draftId, draftId }), /draftId does not belong to chapterId/);
  await assert.rejects(() => service.list('p1', { chapterId: '44444444-4444-4444-8444-444444444444' }), /Chapter not found in project/);
  await assert.rejects(() => service.list('p1', { draftId: '55555555-5555-4555-8555-555555555555' }), /Draft not found in project/);
  await assert.rejects(() => service.list('p1', { agentRunId: '66666666-6666-4666-8666-666666666666' }), /AgentRun not found in project/);
  await assert.rejects(() => service.create('p1', { sourceType: 'bad', reportType: 'manual', verdict: 'pass' } as never), /sourceType/);
  await assert.rejects(() => service.create('p1', { sourceType: 'manual', reportType: 'manual', verdict: 'bad' } as never), /verdict/);
  await assert.rejects(() => service.create('p1', { sourceType: 'manual', reportType: 'manual', verdict: 'pass', scores: null } as never), /scores must be a JSON object/);
  await assert.rejects(() => service.create('p1', { sourceType: 'manual', reportType: 'manual', verdict: 'pass', issues: {} } as never), /issues must be a JSON array/);
  await assert.rejects(() => service.update('other-project', 'report-1', { verdict: 'warn' }), /QualityReport not found/);
  await assert.rejects(() => service.remove('p1', 'missing'), /QualityReport not found/);
  await assert.rejects(() => service.list('missing-project', {}), /Project not found/);
});

test('QualityReportsController delegates project-scoped report operations', async () => {
  const calls: Array<{ method: string; projectId: string; reportId?: string; payload?: unknown }> = [];
  const service = {
    async list(projectId: string, query: unknown) {
      calls.push({ method: 'list', projectId, payload: query });
      return [];
    },
    async create(projectId: string, dto: unknown) {
      calls.push({ method: 'create', projectId, payload: dto });
      return { id: 'report-1' };
    },
    async update(projectId: string, reportId: string, dto: unknown) {
      calls.push({ method: 'update', projectId, reportId, payload: dto });
      return { id: reportId };
    },
    async remove(projectId: string, reportId: string) {
      calls.push({ method: 'remove', projectId, reportId });
      return { deleted: true, id: reportId };
    },
  };
  const controller = new QualityReportsController(service as never);

  await controller.list('p1', { sourceType: 'generation' } as never);
  await controller.create('p1', { sourceType: 'manual' } as never);
  await controller.update('p1', 'report-1', { verdict: 'warn' } as never);
  await controller.remove('p1', 'report-1');

  assert.deepEqual(calls.map((call) => call.method), ['list', 'create', 'update', 'remove']);
  assert.deepEqual(calls.map((call) => call.projectId), ['p1', 'p1', 'p1', 'p1']);
  assert.equal(calls[2].reportId, 'report-1');
});

test('AiQualityReviewService writes normalized ai_review QualityReport', async () => {
  const draftId = '22222222-2222-4222-8222-222222222222';
  const chapterId = '11111111-1111-4111-8111-111111111111';
  const agentRunId = '33333333-3333-4333-8333-333333333333';
  const createdReports: Array<{ projectId: string; dto: Record<string, unknown> }> = [];
  const prisma = {
    chapterDraft: {
      async findFirst() {
        return {
          id: draftId,
          versionNo: 2,
          content: '主角追到雨巷深处，发现旧伏笔留下的铜铃。'.repeat(30),
          source: 'ai',
          modelInfo: {},
          generationContext: {},
          createdAt: new Date('2026-05-05T00:00:00Z'),
          chapter: {
            id: chapterId,
            chapterNo: 12,
            title: '雨巷铜铃',
            objective: '追查铜铃线索',
            conflict: '守门人阻止主角靠近',
            revealPoints: '铜铃来自旧案',
            foreshadowPlan: '回收第 3 章铜铃伏笔',
            outline: '主角在雨巷追踪旧案线索。',
            craftBrief: {},
            expectedWordCount: 3000,
            volume: null,
          },
        };
      },
    },
    project: { async findUnique() { return { id: 'p1', title: '测试项目', genre: '悬疑', theme: '真相', tone: '冷峻', logline: null, synopsis: null, outline: null, creativeProfile: null }; } },
    validationIssue: { async findMany() { return []; } },
    writingRule: { async findMany() { return [{ ruleType: 'foreshadow', title: '伏笔要回收', content: '本章必须回应铜铃。', severity: 'warning', entityType: null, entityRef: null }]; } },
    relationshipEdge: { async findMany() { return []; } },
    timelineEvent: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return [{ title: '铜铃', detail: '第 3 章埋下', status: 'open', scope: 'arc', firstSeenChapterNo: 3, lastSeenChapterNo: null }]; } },
    sceneCard: { async findMany() { return []; } },
    pacingBeat: { async findMany() { return []; } },
    qualityReport: { async findMany() { return []; } },
  };
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      assert.equal(options.appStep, 'summary');
      assert.match(messages[1].content, /铜铃/);
      return {
        data: {
          summary: '伏笔回收明确，但节奏略急。',
          verdict: 'warn',
          scores: { overall: 82, plotProgress: 90, characterConsistency: 86, proseStyle: 80, pacing: 68, foreshadowing: 88, worldbuildingConsistency: 84, timelineKnowledge: 81, ruleCompliance: 79 },
          issues: [{ severity: 'warn', issueType: 'pacing_rush', dimension: 'pacing', message: '雨巷追踪转折过快。', evidence: '追到雨巷深处', suggestion: '增加一处阻碍。' }],
          strengths: ['铜铃伏笔有回收'],
        },
        result: { model: 'mock-review-model', usage: { total_tokens: 100 }, rawPayloadSummary: { id: 'mock' } },
      };
    },
  };
  const qualityReports = {
    async create(projectId: string, dto: Record<string, unknown>) {
      createdReports.push({ projectId, dto });
      return { id: 'report-1', projectId, ...dto };
    },
  };
  const service = new AiQualityReviewService(prisma as never, llm as never, qualityReports as never);

  const result = await service.reviewAndCreate('p1', { draftId, instruction: '重点看伏笔和节奏', focus: ['foreshadowing', 'pacing'] }, { agentRunId });

  assert.equal(result.reportId, 'report-1');
  assert.equal(result.verdict, 'warn');
  assert.equal(result.scores.overall, 82);
  assert.equal(result.issues[0].severity, 'warning');
  assert.equal(createdReports[0].projectId, 'p1');
  assert.equal(createdReports[0].dto.sourceType, 'ai_review');
  assert.equal(createdReports[0].dto.sourceId, draftId);
  assert.equal(createdReports[0].dto.reportType, 'ai_chapter_review');
  assert.equal(createdReports[0].dto.agentRunId, agentRunId);
  assert.deepEqual((createdReports[0].dto.metadata as Record<string, unknown>).sourceTrace, {
    sourceType: 'chapter_draft',
    sourceId: draftId,
    chapterId,
    chapterNo: 12,
    agentRunId,
  });
  assert.equal(((createdReports[0].dto.metadata as Record<string, unknown>).idempotency as Record<string, unknown>).strategy, 'reuse_same_draft_focus_instruction_prompt_version');
  assert.equal(((createdReports[0].dto.metadata as Record<string, unknown>).idempotency as Record<string, unknown>).requiresSchemaMigration, false);
});

test('AiQualityReviewService reuses duplicate same draft focus instruction and creates new trend points for changed inputs', async () => {
  const draftId = '22222222-2222-4222-8222-222222222222';
  const chapterId = '11111111-1111-4111-8111-111111111111';
  const storedReports: Array<Record<string, unknown>> = [];
  let llmCalls = 0;
  const prisma = {
    chapterDraft: {
      async findFirst() {
        return {
          id: draftId,
          versionNo: 1,
          content: 'The archive scene reveals a ledger clue and leaves the door half-open. '.repeat(60),
          source: 'ai',
          modelInfo: {},
          generationContext: {},
          createdAt: new Date('2026-05-05T00:00:00Z'),
          chapter: {
            id: chapterId,
            chapterNo: 4,
            title: 'Archive Gate',
            objective: 'Review the generated chapter.',
            conflict: 'The clue may be too easy.',
            revealPoints: null,
            foreshadowPlan: null,
            outline: null,
            craftBrief: {},
            expectedWordCount: null,
            volume: null,
          },
        };
      },
    },
    project: { async findUnique() { return { id: 'p1', title: 'Project', genre: null, theme: null, tone: null, logline: null, synopsis: null, outline: null, creativeProfile: null }; } },
    validationIssue: { async findMany() { return []; } },
    writingRule: { async findMany() { return []; } },
    relationshipEdge: { async findMany() { return []; } },
    timelineEvent: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    sceneCard: { async findMany() { return []; } },
    pacingBeat: { async findMany() { return []; } },
    qualityReport: {
      async findMany() {
        return storedReports;
      },
    },
  };
  const llm = {
    async chatJson() {
      llmCalls += 1;
      return {
        data: {
          summary: `review ${llmCalls}`,
          verdict: 'pass',
          scores: { overall: 91 },
          issues: [],
        },
        result: { model: `review-model-${llmCalls}` },
      };
    },
  };
  const qualityReports = {
    async create(projectId: string, dto: Record<string, unknown>) {
      const report = { id: `report-${storedReports.length + 1}`, projectId, ...dto };
      storedReports.unshift(report);
      return report;
    },
  };
  const service = new AiQualityReviewService(prisma as never, llm as never, qualityReports as never);

  const first = await service.reviewAndCreate('p1', { draftId, instruction: 'Focus pacing', focus: ['pacing', 'foreshadowing'] });
  const duplicate = await service.reviewAndCreate('p1', { draftId, instruction: 'Focus pacing', focus: ['foreshadowing', 'pacing'] });
  const changedInstruction = await service.reviewAndCreate('p1', { draftId, instruction: 'Focus prose', focus: ['foreshadowing', 'pacing'] });
  const changedFocus = await service.reviewAndCreate('p1', { draftId, instruction: 'Focus pacing', focus: ['pacing'] });

  assert.equal(first.reportId, 'report-1');
  assert.equal(duplicate.reportId, 'report-1');
  assert.equal(changedInstruction.reportId, 'report-2');
  assert.equal(changedFocus.reportId, 'report-3');
  assert.equal(llmCalls, 3);
  assert.equal(storedReports.length, 3);
});

test('AiQualityReviewService skips malformed LLM issues instead of creating default warnings', async () => {
  const createdReports: Array<{ projectId: string; dto: Record<string, unknown> }> = [];
  const prisma = {
    chapterDraft: {
      async findFirst() {
        return {
          id: 'draft-malformed',
          versionNo: 1,
          content: 'Draft content with enough words for review. '.repeat(80),
          source: 'ai',
          modelInfo: {},
          generationContext: {},
          createdAt: new Date('2026-05-05T00:00:00Z'),
          chapter: {
            id: 'chapter-malformed',
            chapterNo: 3,
            title: 'Malformed Review',
            objective: 'Check malformed issue handling',
            conflict: null,
            revealPoints: null,
            foreshadowPlan: null,
            outline: null,
            craftBrief: {},
            expectedWordCount: null,
            volume: null,
          },
        };
      },
    },
    project: { async findUnique() { return { id: 'p1', title: 'Project', genre: null, theme: null, tone: null, logline: null, synopsis: null, outline: null, creativeProfile: null }; } },
    validationIssue: { async findMany() { return []; } },
    writingRule: { async findMany() { return []; } },
    relationshipEdge: { async findMany() { return []; } },
    timelineEvent: { async findMany() { return []; } },
    foreshadowTrack: { async findMany() { return []; } },
    sceneCard: { async findMany() { return []; } },
    pacingBeat: { async findMany() { return []; } },
    qualityReport: { async findMany() { return []; } },
  };
  const llm = {
    async chatJson() {
      return {
        data: {
          summary: 'Only one actionable issue.',
          scores: { overall: 84 },
          issues: [null, {}, { severity: 'warn', issueType: 'pacing', dimension: 'pacing', message: 'Valid issue' }],
        },
        result: { model: 'mock-review-model' },
      };
    },
  };
  const qualityReports = {
    async create(projectId: string, dto: Record<string, unknown>) {
      createdReports.push({ projectId, dto });
      return { id: 'report-malformed', projectId, ...dto };
    },
  };
  const service = new AiQualityReviewService(prisma as never, llm as never, qualityReports as never);

  const result = await service.reviewAndCreate('p1', { chapterId: 'chapter-malformed' });

  assert.equal(result.verdict, 'warn');
  assert.deepEqual(result.issues.map((issue) => issue.message), ['Valid issue']);
  assert.deepEqual(result.normalizationWarnings, [
    'issues[0] skipped: missing issue object',
    'issues[1] skipped: missing non-empty message',
  ]);
  assert.deepEqual((createdReports[0].dto.metadata as Record<string, unknown>).normalizationWarnings, result.normalizationWarnings);
});

test('AiQualityReviewTool requires approval and Act mode before writing report', async () => {
  let callCount = 0;
  const progress: Array<Record<string, unknown>> = [];
  const tool = new AiQualityReviewTool({
    async reviewAndCreate(_projectId: string, _input: unknown, runtime?: { progress?: { updateProgress?: (patch: Record<string, unknown>) => Promise<void> } }) {
      callCount += 1;
      await runtime?.progress?.updateProgress?.({ phase: 'calling_llm' });
      return { reportId: 'report-1', projectId: 'p1', chapterId: 'c1', draftId: 'd1', sourceType: 'ai_review', reportType: 'ai_chapter_review', verdict: 'pass', summary: 'ok', scores: { overall: 90 }, issues: [] };
    },
  } as never);

  assert.equal(tool.requiresApproval, true);
  assert.deepEqual(tool.allowedModes, ['act']);
  assert.deepEqual(tool.sideEffects, ['create_quality_report']);
  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 65_000);
  assert.ok(tool.executionTimeoutMs > DEFAULT_LLM_TIMEOUT_MS * 2);
  await assert.rejects(() => tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }), /Act 模式/);
  await assert.rejects(() => tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} }), /需要用户审批/);

  const output = await tool.run(
    { draftId: 'd1' },
    {
      agentRunId: 'run1',
      projectId: 'p1',
      mode: 'act',
      approved: true,
      outputs: {},
      policy: {},
      async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
    },
  );
  assert.equal(output.reportId, 'report-1');
  assert.equal(callCount, 1);
  assert.equal(progress[0].phase, 'calling_llm');
});

test('ChapterAutoRepairService reads warning issues from QualityReport when no issues are provided', async () => {
  let findManyArgs: { where: Record<string, unknown> } | undefined;
  const service = new ChapterAutoRepairService({} as never, {} as never) as unknown as {
    loadQualityReportIssues: (projectId: string, chapterId: string, draftId: string) => Promise<Array<{ severity: string; message: string }>>;
    prisma: unknown;
  };
  Object.assign(service, {
    prisma: {
      qualityReport: {
        async findMany(args: { where: Record<string, unknown> }) {
          findManyArgs = args;
          return [
            {
              reportType: 'generation_quality_gate',
              verdict: 'warn',
              summary: null,
              issues: [{ severity: 'warn', message: 'Scene card clue missing' }],
            },
          ];
        },
      },
    },
  });

  const issues = await service.loadQualityReportIssues('p1', 'c1', 'd1');
  assert.equal(findManyArgs?.where.projectId, 'p1');
  assert.equal(findManyArgs?.where.chapterId, 'c1');
  assert.equal(findManyArgs?.where.draftId, 'd1');
  assert.equal(findManyArgs?.where.sourceType, 'generation');
  assert.equal(findManyArgs?.where.reportType, 'generation_quality_gate');
  assert.equal(Object.prototype.hasOwnProperty.call(findManyArgs?.where ?? {}, 'OR'), false);
  assert.deepEqual(issues, [{ severity: 'warning', message: '[generation_quality_gate] Scene card clue missing', suggestion: undefined }]);
});

test('ChapterAutoRepairService ignores QualityReport fallback when issues are explicitly provided', async () => {
  let validationIssueCallCount = 0;
  let qualityReportCallCount = 0;
  let llmCallCount = 0;
  const prisma = {
    chapter: {
      async findFirst() {
        return { id: 'c1', chapterNo: 1, title: 'Explicit Issues', objective: null, conflict: null, outline: null };
      },
    },
    chapterDraft: {
      async findFirst() {
        return {
          id: 'd1',
          chapterId: 'c1',
          versionNo: 1,
          content: 'Draft text with no explicit repair issues. '.repeat(10),
          createdBy: 'u1',
          generationContext: {},
        };
      },
    },
    validationIssue: {
      async findMany() {
        validationIssueCallCount += 1;
        return [{ severity: 'error', message: 'Should not be loaded' }];
      },
    },
    qualityReport: {
      async findMany() {
        qualityReportCallCount += 1;
        return [{ sourceType: 'ai_review', reportType: 'ai_chapter_review', verdict: 'fail', issues: [{ severity: 'error', message: 'Should not be loaded' }] }];
      },
    },
  };
  const llm = {
    async chat() {
      llmCallCount += 1;
      return { text: 'unused' };
    },
  };
  const service = new ChapterAutoRepairService(prisma as never, llm as never);

  const result = await service.run('p1', 'c1', { draftId: 'd1', issues: [], maxRounds: 1 });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_repairable_issues');
  assert.equal(validationIssueCallCount, 0);
  assert.equal(qualityReportCallCount, 0);
  assert.equal(llmCallCount, 0);
});

test('ChapterAutoRepairService run merges QualityReport issues into repair prompt', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  let qualityReportFindArgs: { where: Record<string, unknown> } | undefined;
  const createdDrafts: Array<Record<string, unknown>> = [];
  const progress: Array<Record<string, unknown>> = [];
  const prisma = {
    chapter: {
      async findFirst() {
        return { id: 'c1', chapterNo: 8, title: '暗巷', objective: '推进追击', conflict: '线索断裂', outline: '主角在暗巷追查线索。' };
      },
      async update() {},
    },
    chapterDraft: {
      async findFirst(args: { where: Record<string, unknown> }) {
        if (args.where.id === 'd1' || args.where.isCurrent) {
          return {
            id: 'd1',
            chapterId: 'c1',
            versionNo: 1,
            content: '线索在雨里断开，主角沿着暗巷追逐敌人。'.repeat(8),
            createdBy: 'u1',
            generationContext: {},
          };
        }
        return { versionNo: 1 };
      },
      async updateMany() {},
      async create(args: { data: Record<string, unknown> }) {
        createdDrafts.push(args.data);
        return { id: 'd2', ...args.data };
      },
    },
    validationIssue: { async findMany() { return []; } },
    qualityReport: {
      async findMany(args: { where: Record<string, unknown> }) {
        qualityReportFindArgs = args;
        return [{
          reportType: 'generation_quality_gate',
          verdict: 'warn',
          summary: null,
          issues: [{ severity: 'warning', message: 'Scene card clue missing', suggestion: '补上线索落点。' }],
        }];
      },
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(prisma);
    },
  };
  const llm = {
    async chat(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages[1].content;
      receivedOptions = options;
      return { text: '线索在雨里断开，主角沿着暗巷追逐敌人，并在墙缝里发现缺失的线索落点。'.repeat(8), model: 'mock', usage: {}, rawPayloadSummary: {} };
    },
  };
  const service = new ChapterAutoRepairService(prisma as never, llm as never);

  const result = await service.run('p1', 'c1', {
    draftId: 'd1',
    maxRounds: 1,
    progress: {
      async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
      async heartbeat(patch) { if (patch) progress.push(patch as Record<string, unknown>); },
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.repairedIssueCount, 1);
  assert.equal(receivedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(receivedOptions?.retries, 1);
  assert.equal(qualityReportFindArgs?.where.sourceType, 'generation');
  assert.equal(qualityReportFindArgs?.where.reportType, 'generation_quality_gate');
  assert.equal(qualityReportFindArgs?.where.draftId, 'd1');
  assert.equal(Object.prototype.hasOwnProperty.call(qualityReportFindArgs?.where ?? {}, 'OR'), false);
  assert.match(promptText, /generation_quality_gate/);
  assert.match(promptText, /Scene card clue missing/);
  assert.equal(createdDrafts[0].source, 'agent_auto_repair');
  assert.equal(progress.some((item) => item.phase === 'calling_llm' && item.timeoutMs === DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000), true);
  assert.equal(progress.some((item) => item.phase === 'persisting' && item.timeoutMs === 60_000), true);
  assert.equal(progress.some((item) => item.phase === 'persisting' && item.progressCurrent === 1), true);
});

test('AutoRepairChapterTool propagates progress callbacks into service', async () => {
  const progress: Array<Record<string, unknown>> = [];
  let receivedProgress = false;
  const tool = new AutoRepairChapterTool({
    async run(_projectId: string, _chapterId: string, options: { progress?: { updateProgress?: (patch: Record<string, unknown>) => Promise<void>; heartbeat?: (patch?: Record<string, unknown>) => Promise<void> } }) {
      receivedProgress = Boolean(options.progress);
      await options.progress?.updateProgress?.({ phase: 'calling_llm' });
      await options.progress?.heartbeat?.({ phase: 'persisting' });
      return { skipped: false, draftId: 'draft-repair', chapterId: 'c1', repairedWordCount: 1000, repairedIssueCount: 1, maxRounds: 1 };
    },
  } as never);

  const result = await tool.run(
    { chapterId: 'c1', draftId: 'd1', issues: [{ severity: 'warning', message: '补线索' }], maxRounds: 1 },
    {
      agentRunId: 'run1',
      projectId: 'p1',
      mode: 'act',
      approved: true,
      outputs: {},
      policy: {},
      async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
      async heartbeat(patch) { if (patch) progress.push(patch as Record<string, unknown>); },
    },
  );

  assert.equal(tool.executionTimeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 65_000);
  assert.equal(receivedProgress, true);
  assert.equal(result.draftId, 'draft-repair');
  assert.deepEqual(progress.map((item) => item.phase), ['calling_llm', 'persisting']);
});

test('Phase4 CRUD DTO validation rejects null JSON and non-string arrays', async () => {
  const dto = plainToInstance(UpdateChapterPatternDto, {
    structure: null,
    applicableScenes: ['reveal', 7],
  });
  const qualityDto = plainToInstance(UpdateQualityReportDto, {
    scores: null,
    issues: {},
  });

  const errors = await validate(dto, { whitelist: true });
  const qualityErrors = await validate(qualityDto, { whitelist: true });

  assert.equal(errors.some((error) => error.property === 'structure'), true);
  assert.equal(errors.some((error) => error.property === 'applicableScenes'), true);
  assert.equal(qualityErrors.some((error) => error.property === 'scores'), true);
  assert.equal(qualityErrors.some((error) => error.property === 'issues'), true);
});

test('AppModule compiles with phase4 CRUD and phase5 quality modules registered', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(NovelCacheService)
    .useValue({ async deleteProjectRecallResults() {} })
    .compile();

  assert.ok(moduleRef.get(ScenesService, { strict: false }));
  assert.ok(moduleRef.get(ChapterPatternsService, { strict: false }));
  assert.ok(moduleRef.get(PacingBeatsService, { strict: false }));
  assert.ok(moduleRef.get(QualityReportsService, { strict: false }));
  assert.ok(moduleRef.get(AiQualityReviewService, { strict: false }));
  const registry = moduleRef.get(ToolRegistryService, { strict: false });
  registry.onModuleInit();
  assert.ok(registry.get('generate_story_bible_preview'));
  assert.ok(registry.get('validate_story_bible'));
  assert.ok(registry.get('persist_story_bible'));
  assert.ok(registry.get('generate_continuity_preview'));
  assert.ok(registry.get('validate_continuity_changes'));
  assert.ok(registry.get('persist_continuity_changes'));
  assert.ok(registry.get('generate_timeline_preview'));
  assert.ok(registry.get('align_chapter_timeline_preview'));
  assert.ok(registry.get('validate_timeline_preview'));
  assert.ok(registry.get('persist_timeline_events'));
  assert.ok(registry.get('list_scene_cards'));
  assert.ok(registry.get('generate_scene_cards_preview'));
  assert.ok(registry.get('validate_scene_cards'));
  assert.ok(registry.get('persist_scene_cards'));
  assert.ok(registry.get('update_scene_card'));
  assert.ok(registry.get('build_import_brief'));
  assert.ok(registry.get('merge_import_previews'));
  assert.ok(registry.get('cross_target_consistency_check'));
  assert.ok(registry.get('generate_volume_outline_preview'));
  assert.ok(registry.get('generate_story_units_preview'));
  assert.ok(registry.get('persist_story_units'));
  assert.ok(registry.get('generate_outline_preview'));
  assert.ok(registry.get('generate_chapter_outline_preview'));
  assert.ok(registry.get('merge_chapter_outline_previews'));
  assert.ok(registry.get('validate_outline'));
  assert.ok(registry.get('persist_outline'));
  assert.ok(registry.get('persist_volume_outline'));
  assert.ok(registry.get('persist_volume_character_candidates'));
  const manifests = registry.listManifestsForPlanner();
  const timelineGenerateManifest = manifests.find((item) => item.name === 'generate_timeline_preview');
  assert.ok(timelineGenerateManifest);
  assert.deepEqual(timelineGenerateManifest.allowedModes, ['plan', 'act']);
  assert.equal(timelineGenerateManifest.requiresApproval, false);
  assert.deepEqual(timelineGenerateManifest.sideEffects, []);
  assert.equal(timelineGenerateManifest.riskLevel, 'low');
  const timelineAlignManifest = manifests.find((item) => item.name === 'align_chapter_timeline_preview');
  assert.ok(timelineAlignManifest);
  assert.deepEqual(timelineAlignManifest.allowedModes, ['plan', 'act']);
  assert.equal(timelineAlignManifest.requiresApproval, false);
  assert.deepEqual(timelineAlignManifest.sideEffects, []);
  assert.equal(timelineAlignManifest.riskLevel, 'low');
  const timelineValidateManifest = manifests.find((item) => item.name === 'validate_timeline_preview');
  assert.ok(timelineValidateManifest);
  assert.deepEqual(timelineValidateManifest.allowedModes, ['plan', 'act']);
  assert.equal(timelineValidateManifest.requiresApproval, false);
  assert.deepEqual(timelineValidateManifest.sideEffects, []);
  assert.equal(timelineValidateManifest.riskLevel, 'low');
  const timelinePersistManifest = manifests.find((item) => item.name === 'persist_timeline_events');
  assert.ok(timelinePersistManifest);
  assert.deepEqual(timelinePersistManifest.allowedModes, ['act']);
  assert.equal(timelinePersistManifest.requiresApproval, true);
  assert.equal(timelinePersistManifest.riskLevel, 'high');
  assert.ok(timelinePersistManifest.sideEffects.some((item) => item.includes('TimelineEvent')));
  const builtinSkill = BUILTIN_SKILLS.find((skill) => skill.name === 'creative-agent-mvp');
  assert.ok(builtinSkill);
  assert.ok(builtinSkill.defaultTools.includes('generate_timeline_preview'));
  assert.ok(builtinSkill.defaultTools.includes('align_chapter_timeline_preview'));
  assert.ok(builtinSkill.defaultTools.includes('validate_timeline_preview'));
  assert.ok(builtinSkill.defaultTools.includes('persist_timeline_events'));
  assert.ok(builtinSkill.defaultTools.includes('generate_volume_outline_preview'));
  assert.ok(builtinSkill.defaultTools.includes('generate_story_units_preview'));
  assert.ok(builtinSkill.defaultTools.includes('persist_story_units'));
  assert.ok(builtinSkill.defaultTools.includes('generate_chapter_outline_preview'));
  assert.ok(builtinSkill.defaultTools.includes('merge_chapter_outline_previews'));
  assert.ok(builtinSkill.defaultTools.includes('validate_outline'));
  assert.ok(builtinSkill.defaultTools.includes('persist_outline'));
  assert.ok(builtinSkill.defaultTools.includes('persist_volume_outline'));
  assert.ok(builtinSkill.defaultTools.includes('persist_volume_character_candidates'));
  const briefManifest = manifests.find((item) => item.name === 'build_import_brief');
  assert.ok(briefManifest);
  assert.match(briefManifest.whenToUse.join('；'), /分目标导入预览/);
  assert.deepEqual(briefManifest.allowedModes, ['plan', 'act']);
  assert.equal(briefManifest.requiresApproval, false);
  assert.deepEqual(briefManifest.sideEffects, []);
  assert.equal(briefManifest.riskLevel, 'low');
  const consistencyManifest = manifests.find((item) => item.name === 'cross_target_consistency_check');
  assert.ok(consistencyManifest);
  assert.match(consistencyManifest.whenToUse.join('；'), /merge_import_previews|build_import_preview/);
  assert.deepEqual(consistencyManifest.allowedModes, ['plan', 'act']);
  assert.equal(consistencyManifest.requiresApproval, false);
  assert.deepEqual(consistencyManifest.sideEffects, []);
  assert.equal(consistencyManifest.riskLevel, 'low');
  const scenePreviewManifest = manifests.find((item) => item.name === 'generate_scene_cards_preview');
  assert.ok(scenePreviewManifest);
  assert.match(scenePreviewManifest.whenToUse.join(' | '), /scene cards|SceneCard/);
  assert.deepEqual(scenePreviewManifest.allowedModes, ['plan', 'act']);
  assert.equal(scenePreviewManifest.requiresApproval, false);
  assert.deepEqual(scenePreviewManifest.sideEffects, []);
  const scenePersistManifest = manifests.find((item) => item.name === 'persist_scene_cards');
  assert.ok(scenePersistManifest);
  assert.equal(scenePersistManifest.requiresApproval, true);
  assert.equal(scenePersistManifest.riskLevel, 'medium');
  const volumeCharacterPersistManifest = manifests.find((item) => item.name === 'persist_volume_character_candidates');
  assert.ok(volumeCharacterPersistManifest);
  assert.equal(volumeCharacterPersistManifest.requiresApproval, true);
  assert.equal(volumeCharacterPersistManifest.riskLevel, 'high');
  assert.match(volumeCharacterPersistManifest.description, /official Character/);
  const volumeOutlineManifest = manifests.find((item) => item.name === 'generate_volume_outline_preview');
  assert.ok(volumeOutlineManifest);
  assert.equal(volumeOutlineManifest.requiresApproval, false);
  assert.deepEqual(volumeOutlineManifest.sideEffects, []);
  assert.match(volumeOutlineManifest.whenToUse.join(' | '), /卷大纲|Volume\.narrativePlan/);
  assert.doesNotMatch(volumeOutlineManifest.description, /storyUnits/);
  const storyUnitsManifest = manifests.find((item) => item.name === 'generate_story_units_preview');
  assert.ok(storyUnitsManifest);
  assert.equal(storyUnitsManifest.requiresApproval, false);
  assert.deepEqual(storyUnitsManifest.sideEffects, []);
  assert.match(storyUnitsManifest.whenToUse.join(' | '), /单元故事|支线故事|generate_volume_outline_preview/);
  const storyUnitsPersistManifest = manifests.find((item) => item.name === 'persist_story_units');
  assert.ok(storyUnitsPersistManifest);
  assert.equal(storyUnitsPersistManifest.requiresApproval, true);
  assert.equal(storyUnitsPersistManifest.riskLevel, 'high');
  const volumeOutlinePersistManifest = manifests.find((item) => item.name === 'persist_volume_outline');
  assert.ok(volumeOutlinePersistManifest);
  assert.equal(volumeOutlinePersistManifest.requiresApproval, true);
  assert.equal(volumeOutlinePersistManifest.riskLevel, 'high');
  assert.match(volumeOutlinePersistManifest.whenNotToUse.join(' | '), /章节细纲|persist_outline/);
  const targetedImportTools = [
    ['generate_import_project_profile_preview', /项目资料|作品资料|书名/],
    ['generate_import_outline_preview', /剧情大纲|卷章结构|章节规划/],
    ['generate_import_characters_preview', /角色|人设|人物关系/],
    ['generate_import_worldbuilding_preview', /世界设定|地点|势力|规则/],
    ['generate_import_writing_rules_preview', /写作规则|文风|视角|节奏/],
  ] as const;
  for (const [toolName, targetPattern] of targetedImportTools) {
    assert.ok(registry.get(toolName));
    const manifest = manifests.find((item) => item.name === toolName);
    assert.ok(manifest);
    assert.match(manifest.whenToUse.join('；'), targetPattern);
    assert.match(manifest.whenNotToUse.join('；'), /专用导入预览 Tool/);
    assert.ok(manifest.parameterHints?.analysis);
    assert.ok(manifest.parameterHints?.importBrief);
    assert.ok(manifest.parameterHints?.instruction);
    assert.deepEqual(manifest.allowedModes, ['plan', 'act']);
    assert.equal(manifest.requiresApproval, false);
    assert.deepEqual(manifest.sideEffects, []);
    assert.equal(manifest.riskLevel, 'low');
  }
  await moduleRef.close();
});

test('AgentRuntime importTargetRegeneration writingRules creates scoped plan version preserving old target previews', async () => {
  const createdPlans: Array<Record<string, unknown>> = [];
  const createdArtifacts: Array<Record<string, unknown>> = [];
  const createdArtifactBatches: Array<Record<string, unknown>[]> = [];
  let updatedRun: Record<string, unknown> | undefined;
  let executedSteps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }> = [];
  const analysisOutput = { sourceText: 'source text', paragraphs: ['source text'], keywords: ['rule'] };
  const importBriefOutput = { theme: 'memory', tone: 'quiet', requestedAssetTypes: ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'] };
  const projectProfilePreview = { projectProfile: { title: 'Old Title', genre: 'mystery' }, risks: ['profile risk'] };
  const outlinePreview = { projectProfile: { outline: 'Old outline' }, volumes: [{ volumeNo: 1, title: 'Vol 1' }], chapters: [{ chapterNo: 1, title: 'Ch 1' }], risks: ['outline risk'] };
  const charactersPreview = { characters: [{ name: 'Lin', roleType: 'lead' }], risks: ['character risk'] };
  const worldbuildingPreview = { lorebookEntries: [{ title: 'Fog City', content: 'Old setting' }], risks: ['world risk'] };
  const writingRulesPreview = { writingRules: [{ title: 'Old POV', content: 'Old rule' }], risks: ['rule risk'] };
  const mergedPreview = {
    requestedAssetTypes: ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'],
    projectProfile: { title: 'Old Title', genre: 'mystery', outline: 'Old outline' },
    characters: charactersPreview.characters,
    lorebookEntries: worldbuildingPreview.lorebookEntries,
    writingRules: writingRulesPreview.writingRules,
    volumes: outlinePreview.volumes,
    chapters: outlinePreview.chapters,
    risks: [],
  };
  const previousSteps = [
    { stepNo: 1, id: 'read', name: 'Read', tool: 'read_source_document', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 2, id: 'analyze', name: 'Analyze', tool: 'analyze_source_text', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 3, id: 'brief', name: 'Brief', tool: 'build_import_brief', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 4, id: 'profile', name: 'Profile', tool: 'generate_import_project_profile_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 5, id: 'outline', name: 'Outline', tool: 'generate_import_outline_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 6, id: 'characters', name: 'Characters', tool: 'generate_import_characters_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 7, id: 'world', name: 'World', tool: 'generate_import_worldbuilding_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 8, id: 'rules', name: 'Rules', tool: 'generate_import_writing_rules_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 9, id: 'merge', name: 'Merge', tool: 'merge_import_previews', mode: 'act' as const, requiresApproval: false, args: { requestedAssetTypes: ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'], projectProfilePreview: '{{steps.4.output}}', outlinePreview: '{{steps.5.output}}', charactersPreview: '{{steps.6.output}}', worldbuildingPreview: '{{steps.7.output}}', writingRulesPreview: '{{steps.8.output}}' } },
    { stepNo: 10, id: 'cross', name: 'Cross', tool: 'cross_target_consistency_check', mode: 'act' as const, requiresApproval: false, args: { preview: '{{steps.9.output}}' } },
    { stepNo: 11, id: 'validate', name: 'Validate', tool: 'validate_imported_assets', mode: 'act' as const, requiresApproval: false, args: { preview: '{{steps.9.output}}' } },
    { stepNo: 12, id: 'persist', name: 'Persist', tool: 'persist_project_assets', mode: 'act' as const, requiresApproval: true, args: { preview: '{{steps.9.output}}' } },
  ];
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: 'Import selected targets', input: { contextSnapshot: { project: { id: 'p1', title: 'Project' } } } }; },
      async update(args: { data: Record<string, unknown> }) { updatedRun = args.data; return { id: 'run1', ...args.data }; },
    },
    agentPlan: {
      async findFirst() {
        return {
          id: 'plan2',
          version: 2,
          taskType: 'project_import_preview',
          summary: 'Import preview',
          assumptions: [],
          risks: [],
          requiredApprovals: [{ target: { stepNos: [12], tools: ['persist_project_assets'] } }],
          steps: previousSteps,
        };
      },
      async create(args: { data: Record<string, unknown> }) { createdPlans.push(args.data); return { id: 'plan3', version: args.data.version }; },
    },
    agentStep: {
      async findMany() {
        return [
          { stepNo: 2, toolName: 'analyze_source_text', input: {}, output: analysisOutput },
          { stepNo: 3, toolName: 'build_import_brief', input: {}, output: importBriefOutput },
          { stepNo: 4, toolName: 'generate_import_project_profile_preview', input: {}, output: projectProfilePreview },
          { stepNo: 5, toolName: 'generate_import_outline_preview', input: {}, output: outlinePreview },
          { stepNo: 6, toolName: 'generate_import_characters_preview', input: {}, output: charactersPreview },
          { stepNo: 7, toolName: 'generate_import_worldbuilding_preview', input: {}, output: worldbuildingPreview },
          { stepNo: 8, toolName: 'generate_import_writing_rules_preview', input: {}, output: writingRulesPreview },
          { stepNo: 9, toolName: 'merge_import_previews', input: {}, output: mergedPreview },
        ];
      },
    },
    agentArtifact: {
      async create(args: { data: Record<string, unknown> }) { createdArtifacts.push(args.data); return args.data; },
      async createMany(args: { data: Record<string, unknown>[] }) { createdArtifactBatches.push(args.data); return { count: args.data.length }; },
    },
  };
  const executor = {
    async execute(_agentRunId: string, steps: Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }>) {
      executedSteps = steps;
      return {
        1: { writingRules: [{ title: 'New POV', content: 'New rule' }], risks: [] },
        2: { ...mergedPreview, writingRules: [{ title: 'New POV', content: 'New rule' }] },
        3: { valid: true, issues: [] },
        4: { valid: true, issues: [] },
      };
    },
  };
  const trace = { async recordDecision() {} };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, executor as never, {} as never, trace as never);

  await runtime.replanImportTargetRegeneration('run1', 'writingRules', 'Regenerate writing rules only');

  assert.equal(createdPlans[0].version, 3);
  assert.equal(createdPlans[0].status, 'waiting_approval');
  const steps = createdPlans[0].steps as Array<{ tool: string; args: Record<string, unknown>; requiresApproval: boolean }>;
  assert.deepEqual(steps.map((step) => step.tool), [
    'generate_import_writing_rules_preview',
    'merge_import_previews',
    'cross_target_consistency_check',
    'validate_imported_assets',
    'persist_project_assets',
  ]);
  assert.equal(steps.some((step) => ['generate_import_outline_preview', 'generate_import_characters_preview', 'generate_import_worldbuilding_preview', 'generate_import_project_profile_preview'].includes(step.tool)), false);
  assert.deepEqual(steps[0].args.analysis, analysisOutput);
  assert.deepEqual(steps[0].args.importBrief, importBriefOutput);
  assert.deepEqual(steps[1].args.requestedAssetTypes, ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules']);
  assert.deepEqual(steps[1].args.projectProfilePreview, projectProfilePreview);
  assert.deepEqual(steps[1].args.outlinePreview, outlinePreview);
  assert.deepEqual(steps[1].args.charactersPreview, charactersPreview);
  assert.deepEqual(steps[1].args.worldbuildingPreview, worldbuildingPreview);
  assert.equal(steps[1].args.writingRulesPreview, '{{steps.1.output}}');
  assert.deepEqual(steps[3].args, { preview: '{{steps.2.output}}' });
  assert.deepEqual(steps[4].args, { preview: '{{steps.2.output}}' });
  assert.equal(steps[4].requiresApproval, true);
  assert.deepEqual(createdPlans[0].requiredApprovals, [{ approvalType: 'plan', target: { stepNos: [5], tools: ['persist_project_assets'] } }]);
  assert.deepEqual(executedSteps.map((step) => step.tool), steps.map((step) => step.tool));
  assert.equal(createdArtifacts[0].artifactType, 'agent_plan_preview');
  assert.ok(createdArtifactBatches[0].some((artifact) => artifact.artifactType === 'writing_rules_preview'));
  assert.equal(updatedRun?.status, 'waiting_approval');
});

test('AgentRuntime importTargetRegeneration rejects valid asset outside current import scope', async () => {
  let executorCalled = false;
  const previousSteps = [
    { stepNo: 1, id: 'analyze', name: 'Analyze', tool: 'analyze_source_text', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 2, id: 'rules', name: 'Rules', tool: 'generate_import_writing_rules_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    { stepNo: 3, id: 'merge', name: 'Merge', tool: 'merge_import_previews', mode: 'act' as const, requiresApproval: false, args: { requestedAssetTypes: ['writingRules'], writingRulesPreview: '{{steps.2.output}}' } },
    { stepNo: 4, id: 'validate', name: 'Validate', tool: 'validate_imported_assets', mode: 'act' as const, requiresApproval: false, args: { preview: '{{steps.3.output}}' } },
    { stepNo: 5, id: 'persist', name: 'Persist', tool: 'persist_project_assets', mode: 'act' as const, requiresApproval: true, args: { preview: '{{steps.3.output}}' } },
  ];
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: 'Import writing rules', input: {} }; },
      async update() { throw new Error('run update should not be called'); },
    },
    agentPlan: {
      async findFirst() {
        return {
          id: 'plan1',
          version: 1,
          taskType: 'project_import_preview',
          summary: 'Writing rules only',
          assumptions: [],
          risks: [],
          requiredApprovals: [{ target: { stepNos: [5], tools: ['persist_project_assets'] } }],
          steps: previousSteps,
        };
      },
      async create() { throw new Error('plan create should not be called'); },
    },
    agentStep: {
      async findMany() {
        return [
          { stepNo: 1, toolName: 'analyze_source_text', input: {}, output: { sourceText: 'source text' } },
          { stepNo: 2, toolName: 'generate_import_writing_rules_preview', input: {}, output: { writingRules: [{ title: 'POV', content: 'Rule' }] } },
          { stepNo: 3, toolName: 'merge_import_previews', input: {}, output: { requestedAssetTypes: ['writingRules'], writingRules: [{ title: 'POV', content: 'Rule' }] } },
        ];
      },
    },
  };
  const executor = {
    async execute() {
      executorCalled = true;
      return {};
    },
  };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, executor as never, {} as never, { async recordDecision() {} } as never);

  await assert.rejects(
    () => runtime.replanImportTargetRegeneration('run1', 'outline', 'Regenerate outline'),
    /outside the current import target scope/,
  );
  assert.equal(executorCalled, false);
});

test('AgentRunsService rejects invalid importTargetRegeneration assetType', async () => {
  let runtimeCalled = false;
  const prisma = {
    agentRun: { async findUnique() { return { id: 'run1', status: 'waiting_approval' }; } },
  };
  const runtime = {
    async replanImportTargetRegeneration() {
      runtimeCalled = true;
    },
  };
  const service = new AgentRunsService(prisma as never, runtime as never, {} as never);

  await assert.rejects(
    () => service.replan('run1', { importTargetRegeneration: { assetType: 'allAssets' as never } }),
    /importTargetRegeneration\.assetType/,
  );
  assert.equal(runtimeCalled, false);
});

test('Executor 将 LLM timeout 分类为 LLM_TIMEOUT Observation', () => {
  const executor = new AgentExecutorService({} as never, {} as never, {} as never, {} as never) as unknown as {
    classifyObservationCode: (message: string, error: unknown) => string;
  };
  const error = new LlmTimeoutError('LLM 在 450s 内未返回', 'planner', DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(executor.classifyObservationCode(error.message, error), 'LLM_TIMEOUT');
});

test('LlmGatewayService records provider context when HTTP transport fails', async () => {
  const server = createServer((req) => {
    req.socket.destroy(new Error('socket closed'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const logged: Array<{ event: string; error: unknown; payload: Record<string, unknown> }> = [];
  const gateway = new LlmGatewayService({
    resolveForStep() {
      return {
        providerName: 'rxinai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'gpt-5.5',
        params: {},
        source: 'default_provider',
      };
    },
  } as never);
  (gateway as unknown as { logger: { log: () => void; warn: () => void; error: (event: string, error: unknown, payload: Record<string, unknown>) => void } }).logger = {
    log() {},
    warn() {},
    error(event, error, payload) {
      logged.push({ event, error, payload });
    },
  };

  try {
    await assert.rejects(
      () => gateway.chat([{ role: 'user', content: 'hello' }], { appStep: 'planner', maxTokens: 123, timeoutMs: 1000, retries: 0 }),
      /socket|ECONNRESET|hang up/i,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'llm.gateway.chat.failed');
  assert.equal(logged[0].payload.appStep, 'planner');
  assert.equal(logged[0].payload.providerName, 'rxinai');
  assert.equal(logged[0].payload.source, 'default_provider');
  assert.equal(logged[0].payload.baseUrl, `http://127.0.0.1:${address.port}/v1`);
  assert.equal(logged[0].payload.model, 'gpt-5.5');
  assert.equal(logged[0].payload.requestedMaxTokens, 123);
  assert.equal(logged[0].payload.maxTokensSent, null);
  assert.equal(logged[0].payload.maxTokensOmitted, true);
  assert.equal(logged[0].payload.timeoutMs, 1000);
  assert.match(String((logged[0].payload.cause as Record<string, unknown>).message), /socket|ECONNRESET|hang up/i);
});

test('LlmGatewayService uses long-timeout transport without global fetch header deadline', async () => {
  let requestBody = '';
  const server = createServer((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      requestBody += String(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-chat-model', choices: [{ message: { content: 'OK' } }], usage: { completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const originalFetch = globalThis.fetch;
  const gateway = new LlmGatewayService({
    resolveForStep() {
      return {
        providerName: 'rxinai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'gpt-5.5',
        params: {},
        source: 'default_provider',
      };
    },
  } as never);

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error('global fetch should not be used');
  }) as typeof fetch;

  try {
    const result = await gateway.chat([{ role: 'user', content: 'hello' }], { appStep: 'planner', timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 0 });
    assert.equal(result.text, 'OK');
    assert.equal(result.model, 'mock-chat-model');
    assert.match(requestBody, /"model":"gpt-5\.5"/);
    assert.doesNotMatch(requestBody, /"max_tokens"/);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('LlmGatewayService sends OpenAI-compatible JSON mode when requested', async () => {
  let requestBody = '';
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      requestBody += String(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-chat-model', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const gateway = new LlmGatewayService({
    resolveForStep() {
      return {
        providerName: 'rxinai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'gpt-5.5',
        params: {},
        source: 'default_provider',
      };
    },
  } as never);
  (gateway as unknown as { logger: { log: (event: string, payload: Record<string, unknown>) => void; warn: () => void; error: () => void } }).logger = {
    log(event, payload) {
      logged.push({ event, payload });
    },
    warn() {},
    error() {},
  };

  try {
    const result = await gateway.chatJson<{ ok: boolean }>([{ role: 'user', content: 'Return JSON.' }], { appStep: 'planner', maxTokens: 777, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 0, jsonMode: true });
    assert.equal(result.data.ok, true);
    assert.equal(result.result.rawPayloadSummary.finishReason, 'stop');
    assert.match(requestBody, /"response_format":\{"type":"json_object"\}/);
    assert.doesNotMatch(requestBody, /"max_tokens"/);
    const requested = logged.find((item) => item.event === 'llm.gateway.chat.requested');
    assert.ok(requested);
    const loggedRequestBody = requested.payload.requestBody as Record<string, unknown>;
    assert.equal(loggedRequestBody.requestedMaxTokens, 777);
    assert.equal(loggedRequestBody.maxTokensSent, null);
    assert.equal(loggedRequestBody.maxTokensOmitted, true);
    assert.match(JSON.stringify(loggedRequestBody.messages), /Return JSON/);
    assert.doesNotMatch(JSON.stringify(loggedRequestBody), /test-key/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('LlmGatewayService logs full raw chat response text without truncation', async () => {
  const longContent = `prefix-${'x'.repeat(130_000)}-suffix`;
  let providerBody = '';
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const server = createServer((_req, res) => {
    providerBody = JSON.stringify({ model: 'mock-chat-model', choices: [{ finish_reason: 'stop', message: { content: longContent } }], usage: { completion_tokens: 3 } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(providerBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const gateway = new LlmGatewayService({
    resolveForStep() {
      return {
        providerName: 'rxinai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'gpt-5.5',
        params: {},
        source: 'default_provider',
      };
    },
  } as never);
  (gateway as unknown as { logger: { log: (event: string, payload: Record<string, unknown>) => void; warn: () => void; error: () => void } }).logger = {
    log(event, payload) { logged.push({ event, payload }); },
    warn() {},
    error() {},
  };

  try {
    const result = await gateway.chat([{ role: 'user', content: 'hello' }], { appStep: 'planner', timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 0 });
    assert.equal(result.text, longContent);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  const completed = logged.find((item) => item.event === 'llm.gateway.chat.completed');
  assert.ok(completed);
  assert.equal(completed.payload.rawResponseLength, longContent.length);
  assert.equal(completed.payload.rawResponseText, longContent);
  assert.equal(completed.payload.rawProviderResponseLength, providerBody.length);
  assert.equal(completed.payload.rawProviderResponseText, providerBody);
});

test('LlmGatewayService treats Undici headers timeout as LLM_TIMEOUT', () => {
  const gateway = new LlmGatewayService({} as never) as unknown as {
    normalizeLlmError: (error: unknown, options: { appStep?: string; timeoutMs?: number }) => unknown;
  };
  const headersTimeout = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  const fetchError = Object.assign(new TypeError('fetch failed'), { cause: headersTimeout });
  const normalized = gateway.normalizeLlmError(fetchError, { appStep: 'planner', timeoutMs: DEFAULT_LLM_TIMEOUT_MS });

  assert.ok(normalized instanceof LlmTimeoutError);
  assert.equal(normalized.code, 'LLM_TIMEOUT');
  assert.equal(normalized.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
});

test('LlmGatewayService chatJson extracts one complete JSON value before trailing prose', async () => {
  const gateway = new LlmGatewayService({} as never);
  (gateway as unknown as { chat: LlmGatewayService['chat'] }).chat = async () => ({
    text: [
      '```json',
      '{"outline":{"title":"Bridge aftermath","note":"string keeps } and [ literal chars"},"chapters":[{"chapterNo":4}]}',
      '```',
      'Extra prose after the fenced JSON should not poison the valid payload.',
    ].join('\n'),
    model: 'mock-json',
    rawPayloadSummary: {},
  });

  const { data } = await gateway.chatJson<{ outline: { title: string; note: string }; chapters: Array<{ chapterNo: number }> }>([], { appStep: 'planner' });

  assert.equal(data.outline.title, 'Bridge aftermath');
  assert.equal(data.outline.note, 'string keeps } and [ literal chars');
  assert.equal(data.chapters[0].chapterNo, 4);
});

test('LlmGatewayService chatJson keeps malformed JSON fail-fast', async () => {
  const gateway = new LlmGatewayService({} as never);
  const logged: Array<{ event: string; error: unknown; payload: Record<string, unknown> }> = [];
  (gateway as unknown as { logger: { log: () => void; warn: () => void; error: (event: string, error: unknown, payload: Record<string, unknown>) => void } }).logger = {
    log() {},
    warn() {},
    error(event, error, payload) {
      logged.push({ event, error, payload });
    },
  };
  const rawText = '{"outline":{"title":"bad shape"}]\nLater prose {"outline":{"title":"must not be parsed"}}';
  (gateway as unknown as { chat: LlmGatewayService['chat'] }).chat = async () => ({
    text: rawText,
    model: 'mock-json',
    usage: { completion_tokens: 9 },
    elapsedMs: 12,
    rawPayloadSummary: { finishReason: 'stop' },
  });

  await assert.rejects(
    () => gateway.chatJson([], { appStep: 'planner' }),
    (error) => {
      assert.ok(error instanceof LlmJsonInvalidError);
      assert.match(error.rawText, /bad shape/);
      return true;
    },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'llm.gateway.chat_json.parse_failed');
  assert.equal(logged[0].payload.appStep, 'planner');
  assert.equal(logged[0].payload.model, 'mock-json');
  assert.deepEqual(logged[0].payload.tokenUsage, { completion_tokens: 9 });
  assert.deepEqual(logged[0].payload.rawPayloadSummary, { finishReason: 'stop' });
  assert.equal(logged[0].payload.requestedMaxTokens, null);
  assert.equal(logged[0].payload.maxTokensSent, null);
  assert.equal(logged[0].payload.rawResponseLength, rawText.length);
  assert.equal(logged[0].payload.rawResponseTruncated, false);
  assert.equal(logged[0].payload.rawResponseText, rawText);
  assert.equal(logged[0].payload.jsonCandidateText, rawText);
  assert.match(String(logged[0].payload.parseErrorWindow), /bad shape/);
});

test('generate_outline_preview LLM timeout 直接抛错且不生成 fallback', async () => {
  const progress: Array<Record<string, unknown>> = [];
  const llm = {
    async chatJson() {
      throw new LlmTimeoutError('LLM 在 450s 内未返回', 'planner', DEFAULT_LLM_TIMEOUT_MS);
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      { instruction: '卷 1 细纲，目标 60 章节', volumeNo: 1, chapterCount: 60 },
      {
        agentRunId: 'run1',
        projectId: 'p1',
        mode: 'plan',
        approved: false,
        outputs: {},
        policy: {},
        async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
      },
    ),
    /LLM 在 450s 内未返回/,
  );

  assert.equal(progress[0].phase, 'calling_llm');
  assert.equal(progress[0].timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(progress.some((item) => String(item.phase) === 'fallback_generating'), false);
});

test('generate_outline_preview LLM 返回章节数不足时直接报错', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '完成卷主线', chapterCount: 1 },
          chapters: [],
          risks: [],
        },
        result: { model: 'mock-outline' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      { instruction: '卷 1 细纲，目标 1 章节', volumeNo: 1, chapterCount: 1 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /返回章节数 0\/1/,
  );
});

test('generate_outline_preview 缺少 chapterCount 时不调用 LLM', async () => {
  let calls = 0;
  const tool = new GenerateOutlinePreviewTool({
    async chatJson() {
      calls += 1;
      return { data: {}, result: { model: 'should-not-call' } };
    },
  } as never);

  await assert.rejects(
    () => tool.run(
      { instruction: '帮我重新编写卷1的大纲。', volumeNo: 1 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /缺少有效 chapterCount/,
  );
  assert.equal(calls, 0);
});

test('generate_volume_outline_preview 只生成卷纲且不固定单元故事章节', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      receivedMessages = messages;
      receivedOptions = options;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '## 全书主线阶段\n罪桥翻案开端\n## 本卷主线\n完成北逃生桥抢修\n## 本卷戏剧问题\n罪匠能否让裂潮营相信证据\n## 卷内支线\n父亲旧案与妹妹欠契交叉\n## 支线交叉点\n浮税盟料账压住亲情线\n## 卷末交接\n逃生桥胜利留下盐风峡压力',
            objective: '让陆沉舟完成北逃生桥抢修并建立工队雏形',
            chapterCount: 6,
            narrativePlan: {
              globalMainlineStage: '从个人翻案进入工程求生',
              volumeMainline: '验证活盐骨并修成北逃生桥',
              dramaticQuestion: '陆沉舟能否在罪名未清时争取施工权',
              startState: '陆沉舟被押入裂潮营',
              endState: '北逃生桥通行但旧案扩大',
              mainlineMilestones: ['拿到验桥权', '建立临时工规', '小归潮前通桥'],
              subStoryLines: [
                { name: '陆衡旧案', type: 'mystery', function: '牵出活盐骨来源', startState: '骨片刻号出现', progress: '料账和桥号逐步咬合', endState: '确认旧桥料被转运', relatedCharacters: ['陆沉舟', '曹钧'], chapterNodes: [1, 3, 6] },
                { name: '陆知微欠契', type: 'family', function: '压迫主角选择', startState: '欠契被发现', progress: '浮税盟拿亲情钳制陆沉舟', endState: '陆沉舟决定不闭嘴', relatedCharacters: ['陆沉舟', '罗简'], chapterNodes: [2, 5] },
              ],
              foreshadowPlan: ['第1-3章埋陆衡旧桥号，第6章回收为旧案入口'],
              endingHook: '盐风峡路权成为下一卷压力',
              handoffToNextVolume: '带着工队和旧案证据进入盐风峡争路权',
              characterPlan: createVccCharacterPlan(),
            },
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline', usage: { total_tokens: 88 }, rawPayloadSummary: { finishReason: 'stop' } },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  const result = await tool.run(
    { context: { project: { title: '逆潮脊梁', tone: '史诗厚重' }, characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '重写第一卷卷大纲，目标 6 章', volumeNo: 1, chapterCount: 6 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.volume.chapterCount, 6);
  assert.equal(result.volume.narrativePlan?.storyUnits, undefined);
  assert.equal(receivedOptions?.jsonMode, true);
  assert.match(receivedMessages[0].content, /故事性要求/);
  assert.match(receivedMessages[0].content, /不要在本工具中生成 narrativePlan\.storyUnits/);
});

test('generate_volume_outline_preview 未传 chapterCount 时沿用目标卷章节数', async () => {
  let userPrompt = '';
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      userPrompt = messages[1].content;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '## 全书主线阶段\n阶段\n## 本卷主线\n主线\n## 本卷戏剧问题\n问题\n## 卷内支线\n支线\n## 单元故事\n单元\n## 支线交叉点\n交叉\n## 卷末交接\n交接',
            objective: '完成卷目标',
            chapterCount: 6,
            narrativePlan: createVccNarrativePlanForChapterCount(6),
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline', usage: { total_tokens: 42 } },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  const result = await tool.run(
    { context: { project: { title: '逆潮脊梁' }, volumes: [{ volumeNo: 1, title: '罪桥初潮', chapterCount: 6 }], characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '帮我重新编写卷1的大纲。', volumeNo: 1 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.volume.chapterCount, 6);
  assert.match(userPrompt, /全卷章节数：6/);
});

test('generate_volume_outline_preview LLM timeout 直接抛错且不生成 fallback', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      throw new LlmTimeoutError('卷大纲超时', 'planner', DEFAULT_LLM_TIMEOUT_MS);
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      { context: { project: { title: '逆潮脊梁' } }, instruction: '生成第一卷卷大纲', volumeNo: 1, chapterCount: 6 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /卷大纲超时/,
  );
  assert.equal(calls, 1);
});

test('generate_volume_outline_preview 缺失 characterPlan 时直接报错', async () => {
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '卷简介',
            objective: '卷目标',
            chapterCount: 6,
            narrativePlan: {
              globalMainlineStage: '阶段',
              volumeMainline: '主线',
              dramaticQuestion: '问题',
              startState: '起点',
              endState: '终点',
              mainlineMilestones: ['节点'],
              subStoryLines: [
                { name: '支线一', type: 'mystery', function: '作用', startState: '起点', progress: '推进', endState: '结果', relatedCharacters: ['陆沉舟'], chapterNodes: [1] },
                { name: '支线二', type: 'family', function: '作用', startState: '起点', progress: '推进', endState: '结果', relatedCharacters: ['陆知微'], chapterNodes: [2] },
              ],
              foreshadowPlan: ['伏笔'],
              endingHook: '钩子',
              handoffToNextVolume: '交接',
            },
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline' },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      { context: { project: { title: '逆潮脊梁' } }, instruction: '生成第一卷卷大纲', volumeNo: 1, chapterCount: 6 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /characterPlan/,
  );
});

test('generate_volume_outline_preview accepts structured foreshadowPlan items', async () => {
  const narrativePlan = createVccNarrativePlanForChapterCount(6) as Record<string, unknown>;
  narrativePlan.foreshadowPlan = [
    {
      name: '残桥斜向受力线',
      appearRange: { start: 1, end: 3 },
      recoverRange: { start: 4, end: 6 },
      recoveryMethod: '陆沉舟在活盐骨试梁中发现同类斜向受力线，确认残桥并非自然老化。',
    },
  ];
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '卷简介',
            objective: '卷目标',
            chapterCount: 6,
            narrativePlan,
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline', usage: { total_tokens: 42 } },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  const result = await tool.run(
    { context: { project: { title: '逆潮脊梁' }, characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成第1卷卷大纲', volumeNo: 1, chapterCount: 6 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const foreshadowPlan = result.volume.narrativePlan?.foreshadowPlan as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(foreshadowPlan));
  assert.equal(foreshadowPlan.length, 1);
  assert.deepEqual(foreshadowPlan[0].appearRange, { start: 1, end: 3 });
  assert.deepEqual(foreshadowPlan[0].recoverRange, { start: 4, end: 6 });
  assert.match(String(foreshadowPlan[0].recoveryMethod), /活盐骨/);
});

test('generate_volume_outline_preview foreshadowPlan 局部缺字段可由 LLM 修复', async () => {
  const badNarrativePlan = createVccNarrativePlanForChapterCount(6) as Record<string, unknown>;
  badNarrativePlan.foreshadowPlan = [
    { name: '残桥斜向受力线', appearRange: { start: 1, end: 3 }, recoverRange: { start: 4, end: 6 } },
  ];
  const repairedNarrativePlan = createVccNarrativePlanForChapterCount(6) as Record<string, unknown>;
  repairedNarrativePlan.foreshadowPlan = [
    {
      name: '残桥斜向受力线',
      appearRange: { start: 1, end: 3 },
      recoverRange: { start: 4, end: 6 },
      recoveryMethod: '陆沉舟在活盐骨试梁中发现同类斜向受力线，确认残桥并非自然老化。',
    },
  ];
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateVolumeOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '卷简介',
            objective: '卷目标',
            chapterCount: 6,
            narrativePlan: calls.length === 1 ? badNarrativePlan : repairedNarrativePlan,
          },
          risks: [],
        },
        result: { model: `mock-volume-foreshadow-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    { context: { project: { title: '逆潮脊梁' }, characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成第1卷卷大纲', volumeNo: 1, chapterCount: 6 },
    { agentRunId: 'run-volume-repair-foreshadow', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const foreshadowPlan = result.volume.narrativePlan?.foreshadowPlan as Array<Record<string, unknown>>;
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /recoveryMethod/);
  assert.match(String(foreshadowPlan[0].recoveryMethod), /活盐骨/);
});

test('generate_volume_outline_preview rejects structured foreshadowPlan missing recoveryMethod', async () => {
  const narrativePlan = createVccNarrativePlanForChapterCount(6) as Record<string, unknown>;
  narrativePlan.foreshadowPlan = [
    { name: '残桥斜向受力线', appearRange: { start: 1, end: 3 }, recoverRange: { start: 4, end: 6 } },
  ];
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '卷简介',
            objective: '卷目标',
            chapterCount: 6,
            narrativePlan,
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline', usage: { total_tokens: 42 } },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      { context: { project: { title: '逆潮脊梁' }, characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成第1卷卷大纲', volumeNo: 1, chapterCount: 6 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /recoveryMethod/,
  );
});

test('generate_volume_outline_preview 校验失败前记录原始 LLM 返回原文', async () => {
  const logs: Array<{ event: string; payload: Record<string, unknown>; error?: unknown }> = [];
  const narrativePlan = createVccNarrativePlanForChapterCount(6) as Record<string, unknown>;
  narrativePlan.foreshadowPlan = [
    { name: '盐痕伏笔', setupRange: '1-2', payoffRange: '5-6', payoffMethod: '揭示活盐骨来源' },
  ];
  const characterPlan = narrativePlan.characterPlan as Record<string, unknown>;
  const newCharacterCandidates = characterPlan.newCharacterCandidates as Array<Record<string, unknown>>;
  newCharacterCandidates[0].roleType = 'key_missing_family';
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: '罪桥初潮',
            synopsis: '卷简介',
            objective: '卷目标',
            chapterCount: 6,
            narrativePlan,
          },
          risks: [],
        },
        result: { model: 'mock-volume-outline', usage: { total_tokens: 42 }, rawPayloadSummary: { finishReason: 'stop' } },
      };
    },
  };
  const tool = new GenerateVolumeOutlinePreviewTool(llm as never);
  (tool as unknown as { logger: { log: (event: string, payload: Record<string, unknown>) => void; error: (event: string, error: unknown, payload: Record<string, unknown>) => void } }).logger = {
    log(event, payload) { logs.push({ event, payload }); },
    error(event, error, payload) { logs.push({ event, payload, error }); },
  };

  await assert.rejects(
    () => tool.run(
      { context: { project: { title: '逆潮脊梁' }, characters: [{ name: '林澈' }, { name: '沈栖' }] }, instruction: '生成第1卷卷大纲', volumeNo: 1, chapterCount: 6 },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /roleType/,
  );

  const responseLog = logs.find((item) => item.event === 'volume_outline_preview.llm_response.received');
  assert.ok(responseLog);
  const rawResponse = responseLog.payload.rawResponse as Record<string, any>;
  assert.equal(rawResponse.foreshadowPlanType, 'array');
  assert.equal(rawResponse.foreshadowPlanLength, 1);
  assert.ok((rawResponse.narrativePlanKeys as string[]).includes('foreshadowPlan'));
  assert.match(String(rawResponse.rawResponseText), /setupRange/);
  assert.match(String(rawResponse.foreshadowPlanText), /setupRange/);
  assert.ok(logs.some((item) => item.event === 'volume_outline_preview.llm_request.failed'));
});

test('generate_chapter_outline_preview 生成单章细纲并保留上一章接力卡', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  let receivedOptions: Record<string, unknown> | undefined;
  const llmUsages: Array<{ model?: string }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      receivedMessages = messages;
      receivedOptions = options;
      return {
        data: {
          chapter: createOutlineChapter(3, 1, { title: '第三章细纲', objective: '承接第二章压力' }),
          risks: [],
        },
        result: { model: 'mock-chapter-outline', usage: { total_tokens: 77 }, rawPayloadSummary: { finishReason: 'stop' } },
      };
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '逆潮脊梁' }, volumes: [{ volumeNo: 1, title: '罪桥初潮', synopsis: '小归潮逃生', objective: '修成逃生桥' }], characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: {
        volumeNo: 1,
        title: '罪桥初潮',
        synopsis: '小归潮逃生',
        objective: '修成逃生桥',
        chapterCount: 60,
        narrativePlan: createVccNarrativePlanForChapterCount(60, {
          storyUnits: [
            { unitId: 'v1_unit_01', title: '三更验桥', chapterRange: { start: 1, end: 4 }, localGoal: '证明活盐骨吞力', localConflict: '浮税盟封账', serviceFunctions: ['mainline', 'engineering_diagnosis', 'foreshadow'], payoff: '换到验桥权', stateChangeAfterUnit: '成为死责验桥人' },
          ],
        }),
      },
      instruction: '为第 1 卷生成 60 章细纲',
      volumeNo: 1,
      chapterNo: 3,
      chapterCount: 60,
      previousChapter: createOutlineChapter(2, 1, { hook: '第二章钩子' }) as unknown as Record<string, unknown>,
    },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {}, recordLlmUsage: (usage) => llmUsages.push(usage) },
  );

  assert.equal(result.chapter.chapterNo, 3);
  assert.equal(result.chapters.length, 1);
  assert.equal(result.volume.chapterCount, 60);
  assert.equal(result.chapter.craftBrief?.storyUnit?.unitId, 'v1_unit_01');
  assert.equal(receivedOptions?.jsonMode, true);
  assert.equal(receivedOptions?.maxTokens, undefined);
  assert.doesNotMatch(receivedMessages[0].content, /"chapters"|chapters/);
  assert.match(receivedMessages[1].content, /目标章：第 3 章/);
  assert.match(receivedMessages[1].content, /上游卷大纲/);
  assert.match(receivedMessages[1].content, /三更验桥/);
  assert.match(receivedMessages[1].content, /不要输出章节数组/);
  assert.match(receivedMessages[1].content, /第二章钩子/);
  assert.equal(llmUsages[0].model, 'mock-chapter-outline');
});

test('generate_chapter_outline_preview 使用独立 storyUnitPlan 承接单元故事', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  const chapter = createOutlineChapter(2, 1, { title: '第二章细纲' });
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      receivedMessages = messages;
      return {
        data: { chapter, risks: [] },
        result: { model: 'mock-chapter-story-unit-plan' },
      };
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: {
        volumeNo: 1,
        title: '旧闸棚账册',
        synopsis: '卷简介',
        objective: '拿到账册证据',
        chapterCount: 4,
        narrativePlan: createVccNarrativePlanForChapterCount(4, { storyUnits: undefined }),
      },
      storyUnitPlan: createVccStoryUnitPlan(4),
      instruction: '生成第 2 章细纲',
      volumeNo: 1,
      chapterNo: 2,
      chapterCount: 4,
    },
    { agentRunId: 'run-chapter-story-unit-plan', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapter.chapterNo, 2);
  assert.equal(result.chapter.craftBrief?.storyUnit?.unitId, 'v1_unit_01');
  assert.deepEqual(result.chapter.craftBrief?.storyUnit?.chapterRange, { start: 1, end: 4 });
  assert.ok(result.volume.narrativePlan?.storyUnitPlan);
  assert.equal(result.volume.narrativePlan?.storyUnits, undefined);
  assert.match(receivedMessages[1].content, /上游单元故事计划/);
  assert.match(receivedMessages[1].content, /旧闸棚账册/);
  assert.match(receivedMessages[1].content, /旧闸棚账册入局/);
  assert.match(receivedMessages[1].content, /mainlineSegmentIds/);
  assert.match(receivedMessages[1].content, /不要在章节细纲里创造新的单元故事/);
});

test('generate_chapter_outline_preview 未传 volumeOutline 时承接 inspect_project_context 中的已持久化卷纲', async () => {
  let receivedMessages: Array<{ role: string; content: string }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      receivedMessages = messages;
      return {
        data: { chapter: createOutlineChapter(1, 1, { title: '第一章细纲' }), risks: [] },
        result: { model: 'mock-existing-volume-chapter-outline' },
      };
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  const result = await tool.run(
    {
      context: {
        project: { title: '旧档案' },
        volumes: [{
          volumeNo: 1,
          title: '旧闸棚账册',
          synopsis: '卷简介',
          objective: '拿到账册证据',
          chapterCount: 4,
          narrativePlan: createVccNarrativePlanForChapterCount(4, { storyUnits: undefined, storyUnitPlan: createVccStoryUnitPlan(4) }),
        }],
        characters: [{ name: '林澈' }, { name: '沈栖' }],
      },
      instruction: '帮我生成第一卷的章节细纲。',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-existing-volume-chapter-outline', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.volume.title, '旧闸棚账册');
  assert.equal(result.chapter.craftBrief?.storyUnit?.unitId, 'v1_unit_01');
  assert.equal(result.volume.narrativePlan?.storyUnitPlan !== undefined, true);
  assert.match(receivedMessages[1].content, /上游卷大纲/);
  assert.match(receivedMessages[1].content, /旧闸棚账册/);
  assert.match(receivedMessages[1].content, /旧闸棚账册入局/);
  assert.equal(receivedMessages[1].content.includes('characterExecution.cast source whitelist'), true);
  assert.equal(receivedMessages[1].content.includes('volume_candidate'), true);
  assert.equal(receivedMessages[1].content.includes(createVccCharacterPlan().newCharacterCandidates[0].name), true);
});

test('generate_chapter_outline_preview LLM timeout 直接抛错且不生成 fallback', async () => {
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      throw new LlmTimeoutError('单章细纲超时', 'planner', DEFAULT_LLM_TIMEOUT_MS);
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '逆潮脊梁' }, volumes: [{ volumeNo: 1, title: '罪桥初潮', synopsis: '小归潮逃生', objective: '修成逃生桥' }], characters: [{ name: '林澈' }, { name: '沈栖' }] },
        instruction: '为第 1 卷生成 60 章细纲',
        volumeNo: 1,
        chapterNo: 1,
        chapterCount: 60,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /单章细纲超时/,
  );
  assert.equal(calls, 1);
});

test('generate_chapter_outline_preview 缺失 craftBrief 字段时直接报错', async () => {
  const chapter = { ...createOutlineChapter(1, 1) } as Record<string, unknown>;
  delete chapter.craftBrief;
  const llm = {
    async chatJson() {
      return {
        data: {
          volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '完成卷主线', chapterCount: 60, narrativePlan: createVccNarrativePlanForChapterCount(60) },
          chapter,
          chapters: [chapter],
          risks: [],
        },
        result: { model: 'mock-chapter-outline' },
      };
    },
  };
  const tool = new GenerateChapterOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      {
        context: { project: { title: '逆潮脊梁' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
        instruction: '为第 1 卷生成 60 章细纲',
        volumeNo: 1,
        chapterNo: 1,
        chapterCount: 60,
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /缺少 craftBrief/,
  );
});

test('generate_chapter_outline_preview craftBrief 局部缺字段可由 LLM 修复', async () => {
  const badCraftBrief = createOutlineCraftBrief();
  delete (badCraftBrief as Record<string, unknown>).irreversibleConsequence;
  const badChapter = createOutlineChapter(1, 1, { craftBrief: badCraftBrief });
  const repairedChapter = createOutlineChapter(1, 1, {
    craftBrief: createOutlineCraftBrief({
      irreversibleConsequence: '林澈名字进入临检记录，之后所有东闸通行都必须面对巡检处盘问。',
    }),
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: { chapter: calls.length === 1 ? badChapter : repairedChapter, risks: [] },
        result: { model: `mock-chapter-outline-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: { volumeNo: 1, title: '旧闸棚账册', synopsis: '卷简介', objective: '拿到账册证据', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4) },
      instruction: '生成第 1 章细纲',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-chapter-outline-repair-craft-brief', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /irreversibleConsequence/);
  assert.match(String(result.chapter.craftBrief?.irreversibleConsequence), /临检记录/);
});

test('generate_chapter_outline_preview relationshipBeats 局部缺字段可由 LLM 修复', async () => {
  const badCraftBrief = createOutlineCraftBrief();
  const badExecution = badCraftBrief.characterExecution as Record<string, any>;
  badExecution.relationshipBeats = badExecution.relationshipBeats.map((beat: Record<string, unknown>) => {
    const incomplete = { ...beat };
    delete incomplete.publicStateBefore;
    return incomplete;
  });
  const badChapter = createOutlineChapter(1, 1, { craftBrief: badCraftBrief });
  const repairedChapter = createOutlineChapter(1, 1);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: { chapter: calls.length === 1 ? badChapter : repairedChapter, risks: [] },
        result: { model: `mock-chapter-outline-relationship-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: { volumeNo: 1, title: '旧闸棚账册', synopsis: '卷简介', objective: '拿到账册证据', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4) },
      instruction: '生成第 1 章细纲',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-chapter-outline-repair-relationship-beat', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /publicStateBefore/);
  assert.equal(result.chapter.craftBrief?.characterExecution?.relationshipBeats?.[0]?.publicStateBefore, '互相怀疑');
});

test('generate_chapter_outline_preview 卷级候选 source 标错可由 LLM 修复', async () => {
  const badCraftBrief = createOutlineCraftBrief();
  const badExecution = badCraftBrief.characterExecution as Record<string, any>;
  badExecution.cast = badExecution.cast.map((member: Record<string, unknown>) => (
    member.characterName === '邵衡' ? { ...member, source: 'existing' } : member
  ));
  const badChapter = createOutlineChapter(1, 1, { craftBrief: badCraftBrief });
  const repairedChapter = createOutlineChapter(1, 1);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: { chapter: calls.length === 1 ? badChapter : repairedChapter, risks: [] },
        result: { model: `mock-chapter-outline-source-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: { project: { title: '旧档案' }, characters: [{ name: '林澈' }, { name: '沈栖' }] },
      volumeOutline: { volumeNo: 1, title: '旧闸棚账册', synopsis: '卷简介', objective: '拿到账册证据', chapterCount: 4, narrativePlan: createVccNarrativePlanForChapterCount(4) },
      instruction: '生成第 1 章细纲',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-chapter-outline-repair-candidate-source', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const cast = result.chapter.craftBrief?.characterExecution?.cast ?? [];
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /source 必须与角色来源一致/);
  assert.equal(cast.some((member) => member.characterName === '邵衡' && member.source === 'volume_candidate'), true);
});

test('generate_chapter_outline_preview 修复阶段可从 inspect_project_context 卷纲读取卷级候选', async () => {
  const badCraftBrief = createOutlineCraftBrief();
  const badExecution = badCraftBrief.characterExecution as Record<string, any>;
  badExecution.cast = badExecution.cast.map((member: Record<string, unknown>) => (
    member.characterName === '邵衡' ? { ...member, source: 'existing' } : member
  ));
  const badChapter = createOutlineChapter(1, 1, { craftBrief: badCraftBrief });
  const repairedChapter = createOutlineChapter(1, 1);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlinePreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return {
        data: { chapter: calls.length === 1 ? badChapter : repairedChapter, risks: [] },
        result: { model: `mock-chapter-outline-context-source-repair-${calls.length}` },
      };
    },
  } as never);

  const result = await tool.run(
    {
      context: {
        project: { title: '旧档案' },
        volumes: [{
          volumeNo: 1,
          title: '旧闸棚账册',
          synopsis: '卷简介',
          objective: '拿到账册证据',
          chapterCount: 4,
          narrativePlan: createVccNarrativePlanForChapterCount(4),
        }],
        characters: [{ name: '林澈' }, { name: '沈栖' }],
      },
      instruction: '生成第 1 章细纲',
      volumeNo: 1,
      chapterNo: 1,
      chapterCount: 4,
    },
    { agentRunId: 'run-chapter-outline-context-repair-candidate-source', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const repairPayload = JSON.parse(calls[1].messages[1].content) as { volumeCandidateNames?: string[] };
  const cast = result.chapter.craftBrief?.characterExecution?.cast ?? [];
  assert.equal(calls.length, 2);
  assert.deepEqual(repairPayload.volumeCandidateNames, ['邵衡']);
  assert.equal(cast.some((member) => member.characterName === '邵衡' && member.source === 'volume_candidate'), true);
});

test('merge_chapter_outline_previews 合并单章输出并拦截缺章', async () => {
  const tool = new MergeChapterOutlinePreviewsTool();
  const previews = [1, 2, 3].map((chapterNo) => ({
    volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '完成卷主线', chapterCount: 3, narrativePlan: createVccNarrativePlanForChapterCount(3) },
    chapter: createOutlineChapter(chapterNo, 1),
    chapters: [createOutlineChapter(chapterNo, 1)],
    risks: chapterNo === 2 ? ['中段风险'] : [],
  }));

  await assert.rejects(
    () => tool.run({ previews, volumeNo: 1, chapterCount: 3 }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }),
    /未知既有角色|existingCharacterArcs/,
  );

  const result = await tool.run({ previews, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] }, volumeNo: 1, chapterCount: 3 }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} });

  assert.equal(result.volume.chapterCount, 3);
  assert.deepEqual(result.chapters.map((chapter) => chapter.chapterNo), [1, 2, 3]);
  assert.match(result.risks.join('\n'), /第 2 章：中段风险/);
  await assert.rejects(
    () => tool.run({ previews: previews.slice(0, 2), volumeNo: 1, chapterCount: 3 }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }),
    /2\/3/,
  );
});

test('generate_outline_preview 为 60 章逐章请求 LLM 并传递章节接力卡', async () => {
  const calls: Array<{ start: number; end: number; options: Record<string, unknown>; prompt: string }> = [];
  const progress: Array<Record<string, unknown>> = [];
  const llmUsages: Array<{ model?: string }> = [];
  const logs: Array<{ event: string; payload: Record<string, unknown>; error?: unknown }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      assert.ok(match, '逐章 prompt 应包含本次章节范围');
      const start = Number(match[1]);
      const end = Number(match[2]);
      calls.push({ start, end, options, prompt });
      return {
        data: {
          volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '完成卷主线', chapterCount: 60, narrativePlan: createVccNarrativePlanForChapterCount(60) },
          chapters: Array.from({ length: end - start + 1 }, (_item, index) => {
            const chapterNo = start + index;
            return createOutlineChapter(chapterNo, 1);
          }),
          risks: [],
        },
        result: { model: `mock-outline-${calls.length}` },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  (tool as unknown as { logger: { log: (event: string, payload: Record<string, unknown>) => void; error: (event: string, error: unknown, payload: Record<string, unknown>) => void } }).logger = {
    log(event, payload) { logs.push({ event, payload }); },
    error(event, error, payload) { logs.push({ event, payload, error }); },
  };
  const result = await tool.run(
    { instruction: '为第 1 卷生成 60 章细纲', volumeNo: 1, chapterCount: 60, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
    {
      agentRunId: 'run1',
      projectId: 'p1',
      mode: 'plan',
      approved: false,
      outputs: {},
      policy: {},
      recordLlmUsage: (usage) => llmUsages.push(usage),
      async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
      async heartbeat(patch) { if (patch) progress.push(patch as Record<string, unknown>); },
    },
  );

  assert.equal(calls.length, 60);
  assert.equal(calls.every((call, index) => call.start === index + 1 && call.end === index + 1), true);
  assert.equal(calls.every((call) => call.options.timeoutMs === DEFAULT_LLM_TIMEOUT_MS), true);
  assert.equal(calls.every((call) => call.options.retries === 0), true);
  assert.equal(calls.every((call) => call.options.jsonMode === true), true);
  assert.equal(calls.every((call) => call.options.maxTokens === undefined), true);
  assert.match(calls[1].prompt, /本次运行已生成章节短表/);
  assert.match(calls[1].prompt, /章节接力卡/);
  assert.match(calls[1].prompt, /"previousRequestLastChapterNo": 1/);
  assert.match(calls[1].prompt, /第 1 章钩子/);
  assert.match(calls[2].prompt, /"previousRequestLastChapterNo": 2/);
  assert.match(calls[2].prompt, /第 2 章钩子/);
  assert.equal(llmUsages.length, 60);
  assert.equal(result.chapters.length, 60);
  assert.equal(result.volume.chapterCount, 60);
  assert.equal(result.chapters[0].chapterNo, 1);
  assert.equal(result.chapters[59].chapterNo, 60);
  assert.equal(result.chapters.every((chapter) => chapter.volumeNo === 1), true);
  assert.equal(result.chapters.every((chapter) => Boolean(chapter.craftBrief?.visibleGoal)), true);
  assert.equal(progress.filter((item) => item.phase === 'calling_llm').length, 60);
  assert.equal(progress.some((item) => item.phase === 'merging_preview'), true);
  assert.equal(logs.filter((item) => item.event === 'outline_preview.llm_request.started').length, 60);
  assert.equal(logs.filter((item) => item.event === 'outline_preview.llm_request.completed').length, 60);
  assert.equal(logs[0].payload.requestChapterStart, 1);
  assert.equal(logs[0].payload.requestChapterEnd, 1);
  assert.equal(logs[0].payload.maxTokensSent, null);
  assert.equal(logs[0].payload.maxTokensOmitted, true);
  assert.equal(logs[2].payload.requestChapterStart, 2);
  assert.equal(logs[2].payload.previousChapterNo, 1);
  assert.equal(logs.every((item) => item.payload.totalMessageChars !== undefined), true);
});

test('generate_outline_preview 单章 timeout 直接抛错并停止后续章节请求', async () => {
  const calls: Array<[number, number]> = [];
  const progress: Array<Record<string, unknown>> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      assert.ok(match, '逐章 prompt 应包含本次章节范围');
      const start = Number(match[1]);
      const end = Number(match[2]);
      calls.push([start, end]);
      if (start === 2) throw new LlmTimeoutError('第二章超时', 'planner', DEFAULT_LLM_TIMEOUT_MS);
      return {
        data: {
          volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '完成卷主线', chapterCount: 60, narrativePlan: createVccNarrativePlanForChapterCount(60) },
          chapters: Array.from({ length: end - start + 1 }, (_item, index) => {
            const chapterNo = start + index;
            return createOutlineChapter(chapterNo, 1, {
              title: `LLM 第 ${chapterNo} 章`,
              objective: `LLM 第 ${chapterNo} 章目标`,
              conflict: `LLM 第 ${chapterNo} 章阻力`,
              hook: `LLM 第 ${chapterNo} 章钩子`,
              outline: `LLM 第 ${chapterNo} 章场景、行动和结果。`,
              expectedWordCount: 2600,
            });
          }),
          risks: [],
        },
        result: { model: 'mock-outline' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  await assert.rejects(
    () => tool.run(
      { instruction: '为第 1 卷生成 60 章细纲', volumeNo: 1, chapterCount: 60, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
      {
        agentRunId: 'run1',
        projectId: 'p1',
        mode: 'plan',
        approved: false,
        outputs: {},
        policy: {},
        async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
        async heartbeat(patch) { if (patch) progress.push(patch as Record<string, unknown>); },
      },
    ),
    /第二章超时/,
  );

  assert.deepEqual(calls, [[1, 1], [2, 2]]);
  assert.equal(progress.filter((item) => item.phase === 'calling_llm').length, 2);
  assert.equal(progress.some((item) => item.phase === 'fallback_generating'), false);
  assert.equal(progress.some((item) => item.phase === 'merging_preview'), true);
});

test('GenerateOutlinePreviewTool Manifest 声明执行卡预览和逐章 LLM 策略', () => {
  const tool = new GenerateOutlinePreviewTool({} as never);

  assert.match(tool.description, /卷\/章节细纲与执行卡预览/);
  assert.match(tool.manifest.description, /Chapter\.craftBrief/);
  assert.match(tool.manifest.description, /每章单独调用一次 LLM/);
  assert.equal(tool.manifest.whenToUse.some((item) => /60 章细纲/.test(item)), true);
  assert.equal(tool.manifest.whenNotToUse.some((item) => /写正文/.test(item) && /write_chapter/.test(item)), true);
  assert.equal(tool.manifest.whenNotToUse.some((item) => /SceneCard/.test(item)), true);
  assert.match(tool.manifest.parameterHints?.chapterCount.description ?? '', /每章单独调用一次 LLM/);
});

test('generate_outline_preview 保留 LLM craftBrief', async () => {
  const allChapters = [
    {
      chapterNo: 1,
      volumeNo: 2,
      title: '雨夜档案',
      objective: '拿到失踪档案',
      conflict: '馆长锁门并销毁调阅记录',
      hook: '档案袋里掉出湿钥匙',
      outline: '主角潜入档案室，逼问守夜人并拿到关键档案。',
      expectedWordCount: 3200,
      craftBrief: createOutlineCraftBrief({
        visibleGoal: '拿到失踪档案',
        hiddenEmotion: '害怕旧案牵连家人',
        coreConflict: '馆长锁门并销毁调阅记录',
        mainlineTask: '证明旧案没有结案',
        subplotTasks: ['守夜人隐瞒线'],
        actionBeats: ['主角从后窗潜入档案室', '馆长锁门并逼守夜人销毁调阅记录', '主角抢在记录烧毁前拿到湿钥匙'],
        concreteClues: [{ name: '湿钥匙', sensoryDetail: '带铁锈味', laterUse: '打开旧库房' }],
        dialogueSubtext: '守夜人用推脱掩盖恐惧。',
        characterShift: '主角从怀疑转为主动越界。',
        irreversibleConsequence: '主角拿走钥匙后被监控拍下。',
        progressTypes: ['info'],
      }),
    },
    {
      chapterNo: 2,
      volumeNo: 2,
      title: '空白卷宗',
      objective: '确认卷宗被替换',
      conflict: '同伴担心越界调查会失去职位',
      hook: '空白页浮出陌生签名',
      outline: '主角比对卷宗纸张，发现空白页上有隐形签名。',
      expectedWordCount: 2800,
      craftBrief: createOutlineCraftBrief({
        visibleGoal: '确认卷宗被替换',
        hiddenEmotion: '担心调查会毁掉同伴职位',
        coreConflict: '同伴担心越界调查会失去职位',
        mainlineTask: '证明卷宗被替换',
        subplotTasks: ['同伴职业风险线'],
        actionBeats: ['比对纸张', '同伴阻拦', '签名浮现'],
        concreteClues: [{ name: '陌生签名', sensoryDetail: '遇热浮现', laterUse: '指向旧案经手人' }],
        irreversibleConsequence: '同伴为掩护主角提交假调阅记录。',
      }),
    },
  ];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      assert.ok(match, '逐章 prompt 应包含本次章节范围');
      const start = Number(match[1]);
      const end = Number(match[2]);
      assert.equal(end, start);
      const chapter = allChapters.find((item) => item.chapterNo === start);
      if (!chapter) throw new Error(`缺少第 ${start} 章 mock`);
      return {
        data: {
          volume: { volumeNo: 2, title: '第二卷', synopsis: '卷简介', objective: '破解旧案', chapterCount: 2, narrativePlan: createVccNarrativePlanForChapterCount(2, { volumeMainline: '旧案升级' }) },
          chapters: [chapter],
          risks: [],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  const result = await tool.run(
    { instruction: '生成第二卷细纲', volumeNo: 2, chapterCount: 2, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.volume.narrativePlan?.volumeMainline, '旧案升级');
  assert.equal(result.chapters[0].volumeNo, 2);
  assert.equal(result.chapters[0].craftBrief?.visibleGoal, '拿到失踪档案');
  assert.equal(result.chapters[0].craftBrief?.concreteClues?.[0]?.name, '湿钥匙');
  assert.equal(result.chapters[0].craftBrief?.storyUnit?.unitId, 'v1_unit_01');
  assert.equal(result.chapters[1].craftBrief?.visibleGoal, '确认卷宗被替换');
  assert.equal(result.chapters[1].craftBrief?.coreConflict, '同伴担心越界调查会失去职位');
  assert.ok((result.chapters[1].craftBrief?.actionBeats?.length ?? 0) >= 3);
  assert.ok((result.chapters[1].craftBrief?.concreteClues?.length ?? 0) >= 1);
  assert.ok(result.chapters[1].craftBrief?.irreversibleConsequence);
});

test('generate_outline_preview 单章 craftBrief 局部缺字段可由 LLM 修复', async () => {
  const badCraftBrief = createOutlineCraftBrief();
  delete (badCraftBrief as Record<string, unknown>).irreversibleConsequence;
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const callNo = calls.length;
      const chapter = callNo === 1
        ? createOutlineChapter(1, 2, { title: '雨夜档案' })
        : callNo === 2
          ? createOutlineChapter(2, 2, { title: '空白卷宗', craftBrief: badCraftBrief })
          : createOutlineChapter(2, 2, {
            title: '空白卷宗',
            craftBrief: createOutlineCraftBrief({
              irreversibleConsequence: '沈栖提交假调阅记录，之后她在档案馆内的权限被巡检处盯上。',
            }),
          });
      return {
        data: {
          volume: { volumeNo: 2, title: '第二卷', synopsis: '卷简介', objective: '破解旧案', chapterCount: 2, narrativePlan: createVccNarrativePlanForChapterCount(2) },
          chapters: [chapter],
          risks: [],
        },
        result: { model: `mock-outline-repair-${callNo}` },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);
  const result = await tool.run(
    { instruction: '生成第二卷细纲', volumeNo: 2, chapterCount: 2, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
    { agentRunId: 'run-outline-repair-craft-brief', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(calls.length, 3);
  assert.match(calls[2].messages[1].content, /irreversibleConsequence/);
  assert.match(String(result.chapters[1].craftBrief?.irreversibleConsequence), /沈栖提交假调阅记录/);
});

test('generate_outline_preview 缺失 craftBrief 字段时直接报错', async () => {
  const allChapters = [
    createOutlineChapter(1, 2, { title: '雨夜档案' }),
    createOutlineChapter(2, 2, { title: '空白卷宗', craftBrief: { visibleGoal: '确认卷宗被替换' } }),
  ];
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/章节范围：第 (\d+)-(\d+) 章/);
      if (!match) {
        return {
          data: {
            volume: { volumeNo: 2, title: '第二卷', synopsis: '卷简介', objective: '破解旧案', chapterCount: 2, narrativePlan: createVccNarrativePlanForChapterCount(2) },
            chapters: [allChapters[1]],
            risks: [],
          },
          result: { model: 'mock-repair-still-invalid' },
        };
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      assert.equal(end, start);
      const chapter = allChapters.find((item) => item.chapterNo === start);
      if (!chapter) throw new Error(`缺少第 ${start} 章 mock`);
      return {
        data: {
          volume: { volumeNo: 2, title: '第二卷', synopsis: '卷简介', objective: '破解旧案', chapterCount: 2, narrativePlan: createVccNarrativePlanForChapterCount(2) },
          chapters: [chapter],
          risks: [],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      { instruction: '生成第二卷细纲', volumeNo: 2, chapterCount: 2, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /craftBrief/,
  );
});

test('generate_outline_preview 缺失 storyUnit 字段时直接报错', async () => {
  const llm = {
    async chatJson() {
      const craftBrief = createOutlineCraftBrief();
      delete (craftBrief as Record<string, unknown>).storyUnit;
      return {
        data: {
          volume: { volumeNo: 2, title: '第二卷', synopsis: '卷简介', objective: '破解旧案', chapterCount: 1, narrativePlan: createVccNarrativePlanForChapterCount(1) },
          chapters: [createOutlineChapter(1, 2, { title: '雨夜档案', craftBrief })],
          risks: [],
        },
        result: { model: 'mock' },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      { instruction: '生成第二卷细纲', volumeNo: 2, chapterCount: 1, context: { characters: [{ name: '林澈' }, { name: '沈栖' }] } },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /storyUnit/,
  );
});

test('Trace updateStepPhase 写入 phase、phaseMessage、timeoutAt 和 heartbeat', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const runUpdates: Array<Record<string, unknown>> = [];
  const prisma = {
    agentStep: {
      async updateMany(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        return { count: 1 };
      },
    },
    agentRun: {
      async updateMany(args: { data: Record<string, unknown> }) {
        runUpdates.push(args.data);
        return { count: 1 };
      },
    },
  };
  const trace = new AgentTraceService(prisma as never);

  await trace.updateStepPhase('run1', 2, { phase: 'calling_llm', phaseMessage: '正在生成卷章节预览', timeoutMs: DEFAULT_LLM_TIMEOUT_MS }, 'plan', 1);

  assert.equal(updates[0].phase, 'calling_llm');
  assert.equal(updates[0].phaseMessage, '正在生成卷章节预览');
  assert.ok(updates[0].heartbeatAt instanceof Date);
  assert.ok(updates[0].timeoutAt instanceof Date);
  assert.equal(runUpdates[0].currentPhase, 'calling_llm');
});

test('Executor 不再用 Tool executionTimeoutMs 作为外层业务超时', async () => {
  const finished: unknown[] = [];
  const prisma = {
    agentRun: {
      async findUnique(args?: { select?: { status?: boolean } }) {
        return args?.select?.status ? { status: 'planning' } : { id: 'run1', projectId: 'p1', chapterId: null, status: 'planning' };
      },
    },
  };
  const tool = createTool({
    name: 'slow_preview',
    allowedModes: ['plan'],
    requiresApproval: false,
    riskLevel: 'low',
    sideEffects: [],
    executionTimeoutMs: 1,
    outputSchema: { type: 'object' },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  });
  const tools = { get: (name: string) => name === 'slow_preview' ? tool : undefined };
  const policy = { assertPlanExecutable() {}, assertAllowed() {} };
  const trace = {
    startStep() {},
    updateStepPhase() {},
    heartbeatStep() {},
    finishStep(_agentRunId: string, _stepNo: number, output: unknown) { finished.push(output); },
    failStep() { throw new Error('不应触发外层工具执行超时'); },
  };
  const executor = new AgentExecutorService(prisma as never, tools as never, policy as never, trace as never);

  const outputs = await executor.execute('run1', [{ stepNo: 1, name: '慢预览', tool: 'slow_preview', mode: 'act', requiresApproval: false, args: {} }], { mode: 'plan', approved: false });

  assert.deepEqual(outputs[1], { ok: true });
  assert.deepEqual(finished[0], { ok: true });
});

test('AgentRunsService /plan 快速返回 planning 并后台启动 runtime.plan', async () => {
  let runtimeStarted = false;
  let createdInput: Record<string, unknown> | undefined;
  const prisma = {
    agentRun: {
      async findFirst() { return null; },
      async create(args: { data: { input: Record<string, unknown> } }) {
        createdInput = args.data.input;
        return { id: 'run-async-plan' };
      },
    },
  };
  const runtime = {
    async plan() {
      runtimeStarted = true;
      await new Promise(() => undefined);
    },
  };
  const service = new AgentRunsService(prisma as never, runtime as never, {} as never);

  const result = await service.createPlan({
    projectId: '11111111-1111-4111-8111-111111111111',
    message: '卷 1 细纲，目标 60 章节',
    context: { currentProjectId: '11111111-1111-4111-8111-111111111111' },
  });

  assert.equal(result.agentRunId, 'run-async-plan');
  assert.equal(result.status, 'planning');
  assert.equal(runtimeStarted, true);
  assert.equal((createdInput?.context as Record<string, unknown>).currentProjectId, '11111111-1111-4111-8111-111111111111');
});

test('AgentRuntime Plan 后台完成后可轮询到 waiting_approval 和 outline_preview Artifact', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const createdArtifacts: Array<Record<string, unknown>> = [];
  const artifactBatches: Array<Record<string, unknown>[]> = [];
  let previewOnly = false;
  const outlinePreview = {
    volume: { volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '卷目标', chapterCount: 60 },
    chapters: Array.from({ length: 60 }, (_item, index) => ({ chapterNo: index + 1, title: `第 ${index + 1} 章` })),
    risks: [],
  };
  const plan = {
    taskType: 'outline_design',
    summary: '生成第一卷 60 章细纲',
    assumptions: [],
    risks: [],
    requiredApprovals: [],
    steps: [
      { stepNo: 1, id: 'inspect', name: '巡检上下文', tool: 'inspect_project_context', mode: 'act' as const, requiresApproval: false, args: {} },
      { stepNo: 2, id: 'outline', name: '生成大纲预览', tool: 'generate_outline_preview', mode: 'act' as const, requiresApproval: false, args: {} },
    ],
    understanding: '生成卷 1 细纲',
    plannerDiagnostics: { source: 'test' },
  };
  const prisma = {
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: '卷 1 细纲，目标 60 章节', input: {} }; },
      async update(args: { data: Record<string, unknown> }) { updates.push(args.data); return { id: 'run1', ...args.data }; },
      async updateMany(args: { data: Record<string, unknown> }) { updates.push(args.data); return { count: 1 }; },
    },
    agentPlan: {
      async create(args: { data: Record<string, unknown> }) { return { id: 'plan1', version: 1, ...args.data }; },
    },
    agentArtifact: {
      async create(args: { data: Record<string, unknown> }) {
        createdArtifacts.push(args.data);
        return { id: `artifact-${createdArtifacts.length}`, ...args.data };
      },
      async createMany(args: { data: Record<string, unknown>[] }) {
        artifactBatches.push(args.data);
        return { count: args.data.length };
      },
      async findMany() {
        return [
          ...createdArtifacts.map((artifact, index) => ({ id: `artifact-${index + 1}`, ...artifact })),
          ...artifactBatches.flat().map((artifact, index) => ({ id: `batch-artifact-${index + 1}`, ...artifact })),
        ];
      },
    },
  };
  const planner = { async createPlan() { return plan; } };
  const contextBuilder = { async buildForPlan() { return { availableTools: [], session: {}, project: {} }; }, createDigest() { return 'digest'; } };
  const executor = {
    async execute(_agentRunId: string, _steps: unknown[], options: { previewOnly?: boolean }) {
      previewOnly = Boolean(options.previewOnly);
      return { 2: outlinePreview };
    },
  };
  const trace = { async recordDecision() {} };
  const runtime = new AgentRuntimeService(prisma as never, planner as never, contextBuilder as never, executor as never, {} as never, trace as never);

  const result = await runtime.plan('run1');

  assert.equal(previewOnly, true);
  assert.equal(updates.some((item) => item.status === 'waiting_approval'), true);
  assert.equal(artifactBatches.flat().some((artifact) => artifact.artifactType === 'outline_preview'), true);
  assert.equal(result.artifacts.some((artifact: { artifactType?: string }) => artifact.artifactType === 'outline_preview'), true);
});

test('AgentRuntime resumeFromFailedStep resumes failed Plan preview without entering Act', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const artifactBatches: Array<Record<string, unknown>[]> = [];
  let executorOptions: Record<string, unknown> | undefined;
  let currentRun: Record<string, unknown> = {
    id: 'run1',
    projectId: 'p1',
    chapterId: null,
    goal: 'generate 60 chapter outline',
    status: 'failed',
    input: { contextSnapshot: { schemaVersion: 2, session: { currentProjectId: 'p1' }, availableTools: [] } },
  };
  const plan = {
    id: 'plan1',
    version: 1,
    taskType: 'outline_design',
    steps: [
      { stepNo: 1, id: 'inspect', name: 'inspect context', tool: 'inspect_project_context', mode: 'act' as const, requiresApproval: false, args: {} },
      { stepNo: 2, id: 'outline', name: 'generate outline preview', tool: 'generate_outline_preview', mode: 'act' as const, requiresApproval: false, args: {} },
      { stepNo: 3, id: 'validate', name: 'validate outline', tool: 'validate_outline', mode: 'act' as const, requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
      { stepNo: 4, id: 'persist', name: 'persist outline', tool: 'persist_outline', mode: 'act' as const, requiresApproval: true, args: { preview: '{{steps.2.output}}', validation: '{{steps.3.output}}' } },
    ],
  };
  const prisma = {
    agentPlan: { async findFirst() { return plan; } },
    agentRun: {
      async findUnique() { return currentRun; },
      async updateMany(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        currentRun = { ...currentRun, ...args.data };
        return { count: 1 };
      },
    },
    agentStep: {
      async findFirst() { return { stepNo: 2, mode: 'plan', toolName: 'generate_outline_preview' }; },
    },
    agentArtifact: {
      async createMany(args: { data: Record<string, unknown>[] }) {
        artifactBatches.push(args.data);
        return { count: args.data.length };
      },
    },
  };
  const executor = {
    async execute(_agentRunId: string, _steps: unknown[], options: Record<string, unknown>) {
      executorOptions = options;
      return {
        1: { inspected: true },
        2: { volume: { volumeNo: 1, title: 'Volume 1', chapterCount: 60 }, chapters: [{ chapterNo: 1, title: 'Chapter 1' }], risks: [] },
        3: { valid: true },
      };
    },
  };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, executor as never, {} as never, {} as never);

  const result = await runtime.resumeFromFailedStep('run1', [4], { confirmHighRisk: true });

  assert.equal(executorOptions?.mode, 'plan');
  assert.equal(executorOptions?.previewOnly, true);
  assert.equal(executorOptions?.reuseSucceeded, true);
  assert.equal(executorOptions?.approved, false);
  assert.ok(result);
  assert.equal(result.status, 'waiting_approval');
  assert.equal(currentRun.mode, 'plan');
  assert.equal(updates.some((item) => item.status === 'acting'), false);
  assert.equal(updates.some((item) => item.status === 'succeeded'), false);
  assert.equal(artifactBatches.flat().some((artifact) => artifact.artifactType === 'outline_preview'), true);
});

test('AgentRuntime cancel 后迟到执行结果不会覆盖 cancelled', async () => {
  const updates: Array<Record<string, unknown>> = [];
  let createManyCalled = false;
  let findRunCount = 0;
  const prisma = {
    agentPlan: { async findFirst() { return { version: 1, taskType: 'chapter_write', steps: [] }; } },
    agentRun: {
      async findUnique() {
        findRunCount += 1;
        if (findRunCount === 1) return { id: 'run1', projectId: 'p1', chapterId: null, goal: '测试目标', input: { contextSnapshot: { schemaVersion: 2, session: { currentProjectId: 'p1' } } }, status: 'waiting_approval' };
        return { id: 'run1', status: 'cancelled' };
      },
      async updateMany(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        return { count: 1 };
      },
    },
    agentArtifact: {
      async createMany() {
        createManyCalled = true;
      },
    },
  };
  const executor = { async execute() { return { 1: { ok: true } }; } };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, {} as never, executor as never, {} as never, {} as never);

  const result = await runtime.act('run1');

  assert.equal(result?.status, 'cancelled');
  assert.equal(createManyCalled, false);
  assert.equal(updates.some((item) => item.status === 'succeeded'), false);
});

test('Watchdog 标记 heartbeat 停滞步骤为 TOOL_STUCK_TIMEOUT', async () => {
  const now = new Date('2026-05-06T00:05:00.000Z');
  const stepUpdates: Array<Record<string, unknown>> = [];
  const runUpdates: Array<Record<string, unknown>> = [];
  const staleStep = {
    id: 'step1',
    agentRunId: 'run1',
    stepNo: 2,
    mode: 'plan',
    planVersion: 1,
    toolName: 'never_return',
    phase: 'calling_llm',
    timeoutAt: null,
    deadlineAt: null,
    heartbeatAt: new Date('2026-05-06T00:00:00.000Z'),
  };
  let stepFindManyCount = 0;
  const prisma = {
    agentStep: {
      async findMany() {
        stepFindManyCount += 1;
        return stepFindManyCount === 1 ? [] : [staleStep];
      },
      async updateMany(args: { data: Record<string, unknown> }) {
        stepUpdates.push(args.data);
        return { count: 1 };
      },
    },
    agentRun: {
      async findMany() { return []; },
      async updateMany(args: { data: Record<string, unknown> }) {
        runUpdates.push(args.data);
        return { count: 1 };
      },
    },
  };
  const watchdog = new AgentRunWatchdogService(prisma as never);

  await watchdog.scanOnce(now);

  assert.equal(stepUpdates[0].errorCode, 'TOOL_STUCK_TIMEOUT');
  assert.equal(runUpdates[0].status, 'failed');
  assert.match(String(runUpdates[0].error), /步骤卡住/);
});

test('Watchdog 标记 phase timeout 为 TOOL_PHASE_TIMEOUT', async () => {
  const now = new Date('2026-05-06T00:02:00.000Z');
  const stepUpdates: Array<Record<string, unknown>> = [];
  const timedOutStep = {
    id: 'step1',
    agentRunId: 'run1',
    stepNo: 2,
    mode: 'plan',
    planVersion: 1,
    toolName: 'generate_outline_preview',
    phase: 'calling_llm',
    timeoutAt: new Date('2026-05-06T00:01:30.000Z'),
    deadlineAt: null,
    heartbeatAt: new Date('2026-05-06T00:01:00.000Z'),
  };
  let stepFindManyCount = 0;
  const prisma = {
    agentStep: {
      async findMany() {
        stepFindManyCount += 1;
        return stepFindManyCount === 1 ? [timedOutStep] : [];
      },
      async updateMany(args: { data: Record<string, unknown> }) {
        stepUpdates.push(args.data);
        return { count: 1 };
      },
    },
    agentRun: {
      async findMany() { return []; },
      async updateMany() { return { count: 1 }; },
    },
  };
  const watchdog = new AgentRunWatchdogService(prisma as never);

  await watchdog.scanOnce(now);

  assert.equal(stepUpdates[0].errorCode, 'TOOL_PHASE_TIMEOUT');
});

test('Watchdog 不再根据 AgentRun.deadlineAt 失败运行中的 Run', async () => {
  const now = new Date('2026-05-06T00:20:00.000Z');
  let stepScanCount = 0;
  const prisma = {
    agentStep: {
      async findMany() {
        stepScanCount += 1;
        return [];
      },
      async updateMany() { throw new Error('watchdog should not fail any step'); },
    },
    agentRun: {
      async findMany() { throw new Error('watchdog should not scan run deadlines'); },
      async updateMany() { throw new Error('watchdog should not fail any run'); },
    },
  };
  const watchdog = new AgentRunWatchdogService(prisma as never);

  await watchdog.scanOnce(now);

  assert.equal(stepScanCount, 2);
});

test('P3 import outline preview reports calling_llm with retry-aware phase timeout', async () => {
  const progress: Array<Record<string, unknown>> = [];
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(_messages: unknown, options: Record<string, unknown>) {
      receivedOptions = options;
      return {
        data: {
          projectProfile: { outline: 'outline' },
          volumes: [{ volumeNo: 1, title: 'Volume 1' }],
          chapters: [{ chapterNo: 1, volumeNo: 1, title: 'Chapter 1', objective: 'Find the missing page', conflict: 'Archive staff blocks access', hook: 'A wet key appears', outline: 'Beat 1', expectedWordCount: 3000 }],
          risks: [],
        },
        result: { model: 'mock-import-outline' },
      };
    },
  };
  const tool = new GenerateImportOutlinePreviewTool(llm as never);

  await tool.run(
    {
      analysis: { sourceText: 'source', length: 6, paragraphs: ['source'], keywords: ['source'] },
      instruction: 'outline only',
      chapterCount: 1,
    },
    {
      agentRunId: 'run1',
      projectId: 'p1',
      mode: 'plan',
      approved: false,
      outputs: {},
      policy: {},
      async updateProgress(patch) { progress.push(patch as Record<string, unknown>); },
    },
  );

  assert.equal(receivedOptions?.timeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(receivedOptions?.retries, 1);
  assert.equal(progress[0].phase, 'calling_llm');
  assert.equal(progress[0].timeoutMs, DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000);
  assert.equal(progress.some((item) => item.phase === 'validating'), true);
});

test('P3 write and polish chapter tools propagate progress callbacks into services', async () => {
  const progress: Array<Record<string, unknown>> = [];
  const progressContext = {
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: {},
    policy: {},
    async updateProgress(patch: unknown) { progress.push(patch as Record<string, unknown>); },
    async heartbeat(patch?: unknown) { if (patch) progress.push(patch as Record<string, unknown>); },
  };
  const writeTool = new WriteChapterTool({
    async run(_projectId: string, _chapterId: string, input: { progress?: { updateProgress?: (patch: Record<string, unknown>) => Promise<void>; heartbeat?: (patch?: Record<string, unknown>) => Promise<void> } }) {
      await input.progress?.updateProgress?.({ phase: 'calling_llm' });
      await input.progress?.heartbeat?.({ phase: 'persisting' });
      return { draftId: 'draft-write', chapterId: 'chapter1', versionNo: 1, actualWordCount: 100, summary: 'ok' };
    },
  } as never);
  const polishTool = new PolishChapterTool({
    async run(_projectId: string, _chapterId: string, _instruction?: string, _sourceDraftId?: string, options?: { progress?: { updateProgress?: (patch: Record<string, unknown>) => Promise<void>; heartbeat?: (patch?: Record<string, unknown>) => Promise<void> } }) {
      await options?.progress?.updateProgress?.({ phase: 'calling_llm' });
      await options?.progress?.heartbeat?.({ phase: 'persisting' });
      return { draftId: 'draft-polish', chapterId: 'chapter1', originalDraftId: 'draft0', originalWordCount: 100, polishedWordCount: 105, changed: true, summary: 'ok' };
    },
  } as never);

  await writeTool.run({ chapterId: 'chapter1', instruction: 'write' }, progressContext);
  await polishTool.run({ chapterId: 'chapter1', instruction: 'polish' }, progressContext);

  assert.equal(progress.filter((item) => item.phase === 'calling_llm').length, 2);
  assert.equal(progress.filter((item) => item.phase === 'persisting').length, 2);
});

test('Watchdog stale scan ignores steps with unexpired phase timeout', async () => {
  const now = new Date('2026-05-06T00:05:00.000Z');
  const stepFindManyArgs: Array<{ where?: Record<string, unknown> }> = [];
  const prisma = {
    agentStep: {
      async findMany(args: { where?: Record<string, unknown> }) {
        stepFindManyArgs.push(args);
        return [];
      },
      async updateMany() { throw new Error('watchdog should not fail any step'); },
    },
    agentRun: {
      async findMany() { return []; },
      async updateMany() { throw new Error('watchdog should not fail any run'); },
    },
  };
  const watchdog = new AgentRunWatchdogService(prisma as never);

  await watchdog.scanOnce(now);

  assert.deepEqual(stepFindManyArgs[1].where?.AND, [
    { OR: [{ timeoutAt: null }, { timeoutAt: { lt: now } }] },
  ]);
});

test('ResolveChapterTool prefers explicit chapterNo over current context chapterId', async () => {
  const queries: Array<{ where?: Record<string, unknown> }> = [];
  const prisma = {
    chapter: {
      async findFirst(args: { where?: Record<string, unknown> }) {
        queries.push(args);
        if (args.where?.chapterNo === 3) {
          return { id: 'c3', chapterNo: 3, title: 'Chapter 3', status: 'planned', objective: 'Target 3', conflict: 'Conflict 3', outline: 'Outline 3', expectedWordCount: 2500 };
        }
        if (args.where?.id === 'c1') {
          return { id: 'c1', chapterNo: 1, title: 'Chapter 1', status: 'planned', objective: 'Target 1', conflict: 'Conflict 1', outline: 'Outline 1', expectedWordCount: 2500 };
        }
        return null;
      },
    },
  };
  const tool = new ResolveChapterTool(prisma as never);

  const result = await tool.run(
    { chapterRef: '第 3 章', chapterNo: 3, currentChapterId: 'c1' },
    { agentRunId: 'run1', projectId: 'p1', chapterId: 'c1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.chapterId, 'c3');
  assert.equal(result.chapterNo, 3);
  assert.deepEqual(queries[0].where, { chapterNo: 3, projectId: 'p1' });
});

test('AgentRuntime maps chapter craft brief preview and validation artifacts in plan mode', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildPreviewArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'craft_1', chapterNo: 3, proposedFields: { craftBrief: { visibleGoal: 'Open the sealed archive' } } }] };
  const validation = { valid: true, accepted: [{ candidateId: 'craft_1', chapterNo: 3, action: 'update' }], writePreview: { chapters: [] } };
  const artifacts = runtime.buildPreviewArtifacts(
    'chapter_craft_brief',
    { 1: { chapterId: 'c3' }, 3: preview, 4: validation },
    [
      { stepNo: 1, tool: 'resolve_chapter' },
      { stepNo: 2, tool: 'collect_chapter_context' },
      { stepNo: 3, tool: 'generate_chapter_craft_brief_preview' },
      { stepNo: 4, tool: 'validate_chapter_craft_brief' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['chapter_craft_brief_preview', 'chapter_craft_brief_validation_report']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation]);
});

test('AgentRuntime maps chapter craft brief preview, validation and persist artifacts in act mode', () => {
  const runtime = new AgentRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    buildExecutionArtifacts: (taskType: string, outputs: Record<number, unknown>, steps: Array<{ stepNo: number; tool: string }>) => Array<{ artifactType: string; title: string; content: unknown }>;
  };
  const preview = { candidates: [{ candidateId: 'craft_1', chapterNo: 3, proposedFields: { craftBrief: { visibleGoal: 'Open the sealed archive' } } }] };
  const validation = { valid: true, accepted: [{ candidateId: 'craft_1', chapterNo: 3, action: 'update' }], writePreview: { chapters: [] } };
  const persist = { updatedCount: 1, skippedCount: 0, updatedChapters: [{ id: 'c3', chapterNo: 3, status: 'planned' }] };
  const artifacts = runtime.buildExecutionArtifacts(
    'chapter_progress_card',
    { 1: { chapterId: 'c3' }, 3: preview, 4: validation, 5: persist },
    [
      { stepNo: 1, tool: 'resolve_chapter' },
      { stepNo: 2, tool: 'collect_chapter_context' },
      { stepNo: 3, tool: 'generate_chapter_craft_brief_preview' },
      { stepNo: 4, tool: 'validate_chapter_craft_brief' },
      { stepNo: 5, tool: 'persist_chapter_craft_brief' },
    ],
  );

  assert.deepEqual(artifacts.map((item) => item.artifactType), ['chapter_craft_brief_preview', 'chapter_craft_brief_validation_report', 'chapter_craft_brief_persist_result']);
  assert.deepEqual(artifacts.map((item) => item.content), [preview, validation, persist]);
});

test('Planner 为 rewrite_chapter 强制追加章节质量门禁链路', () => {
  const toolNames = ['resolve_chapter', 'collect_chapter_context', 'rewrite_chapter', 'polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'];
  const tools = { list: () => toolNames.map((name) => createTool({ name, requiresApproval: !['resolve_chapter', 'collect_chapter_context'].includes(name), sideEffects: name === 'resolve_chapter' || name === 'collect_chapter_context' ? [] : ['write'] })) } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as {
    validateAndNormalizeLlmPlan: (data: unknown, baseline: { taskType: string; summary: string; assumptions: string[]; risks: string[] }) => { steps: Array<{ stepNo: number; tool: string; args: Record<string, unknown>; runIf?: { ref: string; operator: string; value?: unknown } }> };
  };

  const plan = planner.validateAndNormalizeLlmPlan(
    {
      taskType: 'chapter_write',
      summary: '重写章节正文计划',
      assumptions: [],
      risks: [],
      steps: [
        { stepNo: 1, name: '解析章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { chapterNo: 1 } },
        { stepNo: 2, name: '收集上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
        { stepNo: 3, name: '重写正文', tool: 'rewrite_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: '重写第一章，不沿用旧稿' } },
      ],
    },
    { taskType: 'general', summary: 'fallback', assumptions: [], risks: [] },
  );

  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'resolve_chapter',
    'collect_chapter_context',
    'rewrite_chapter',
    'polish_chapter',
    'fact_validation',
    'auto_repair_chapter',
    'polish_chapter',
    'fact_validation',
    'auto_repair_chapter',
    'extract_chapter_facts',
    'rebuild_memory',
    'review_memory',
  ]);
  assert.equal(plan.steps[3].args.draftId, '{{runtime.currentDraftId}}');
  assert.deepEqual(plan.steps[6].runIf, { ref: '{{steps.5.output.createdCount}}', operator: 'gt', value: 0 });
});

test('RewriteChapterTool 调用生成服务时使用 rewrite mode', async () => {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  const generateChapter = {
    async run(projectId: string, chapterId: string, input: Record<string, unknown>) {
      calls.push([projectId, chapterId, input]);
      return { draftId: 'd1', chapterId, versionNo: 1, actualWordCount: 1200 };
    },
  };
  const tool = new RewriteChapterTool(generateChapter as never);

  const result = await tool.run(
    { chapterId: 'c1', instruction: '重写第一章', wordCount: 2000 },
    { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {}, userId: 'u1' },
  );

  assert.equal(result.draftId, 'd1');
  assert.equal(calls[0][0], 'p1');
  assert.equal(calls[0][1], 'c1');
  assert.equal(calls[0][2].mode, 'rewrite');
  assert.equal(calls[0][2].instruction, '重写第一章');
  assert.equal(calls[0][2].wordCount, 2000);
});

test('ChapterRewriteCleanupService 删除章节正文派生产物并清理缓存', async () => {
  const deletes: Array<{ model: string; args: Record<string, unknown> }> = [];
  const updates: Record<string, unknown>[] = [];
  const cacheCalls: string[] = [];
  const deleteMany = (model: string, count: number) => async (args: Record<string, unknown>) => {
    deletes.push({ model, args });
    return { count };
  };
  const tx = {
    qualityReport: { deleteMany: deleteMany('qualityReport', 1) },
    validationIssue: { deleteMany: deleteMany('validationIssue', 2) },
    memoryChunk: { deleteMany: deleteMany('memoryChunk', 3) },
    storyEvent: { deleteMany: deleteMany('storyEvent', 4) },
    characterStateSnapshot: { deleteMany: deleteMany('characterStateSnapshot', 5) },
    foreshadowTrack: { deleteMany: deleteMany('foreshadowTrack', 6) },
    character: { deleteMany: deleteMany('character', 7) },
    lorebookEntry: { deleteMany: deleteMany('lorebookEntry', 8) },
    chapterDraft: { deleteMany: deleteMany('chapterDraft', 9) },
    chapter: { async update(args: Record<string, unknown>) { updates.push(args); return {}; } },
  };
  const prisma = {
    chapter: {
      async findFirst() {
        return { id: 'c1', chapterNo: 1 };
      },
    },
    async $transaction(fn: (txArg: typeof tx) => Promise<unknown>) {
      return fn(tx);
    },
  };
  const cache = {
    async deleteChapterContext(projectId: string, chapterId: string) { cacheCalls.push(`chapter:${projectId}:${chapterId}`); },
    async deleteProjectRecallResults(projectId: string) { cacheCalls.push(`recall:${projectId}`); },
  };
  const service = new ChapterRewriteCleanupService(prisma as never, cache as never);

  const result = await service.cleanupChapter('p1', 'c1');

  assert.equal(result.deletedDrafts, 9);
  assert.equal(result.deletedMemoryChunks, 3);
  assert.deepEqual(deletes.find((item) => item.model === 'memoryChunk')?.args.where, { projectId: 'p1', sourceType: 'chapter', sourceId: 'c1' });
  assert.deepEqual(deletes.find((item) => item.model === 'chapterDraft')?.args.where, { chapterId: 'c1' });
  assert.deepEqual(updates[0], { where: { id: 'c1' }, data: { status: 'planned', actualWordCount: null } });
  assert.deepEqual(cacheCalls.sort(), ['chapter:p1:c1', 'recall:p1']);
});

test('VCC generate_outline_preview rejects batched chapters that reference batch-only candidates', async () => {
  const basePlan = createVccCharacterPlanForChapterCount(2);
  const existingNames = basePlan.existingCharacterArcs.map((arc) => arc.characterName);
  const batchOnlyCandidate = {
    ...(basePlan.newCharacterCandidates[0] as Record<string, unknown>),
    candidateId: 'cand_batch_only',
    name: 'BatchOnlyCandidate',
    firstAppearChapter: 2,
  };
  const createSecondBatchNarrativePlan = () => createVccNarrativePlanForChapterCount(2, {
    characterPlan: createVccCharacterPlanForChapterCount(2, {
      newCharacterCandidates: [
        ...(basePlan.newCharacterCandidates as Array<Record<string, unknown>>),
        batchOnlyCandidate,
      ],
    }),
  });
  const createChapterUsingCandidate = (chapterNo: number, candidateName: string) => {
    const craftBrief = createOutlineCraftBrief();
    const characterExecution = craftBrief.characterExecution as Record<string, unknown>;
    const previousCandidateName = (characterExecution.cast as Array<Record<string, unknown>>)
      .find((item) => item.source === 'volume_candidate')?.characterName;
    return createOutlineChapter(chapterNo, 1, {
      craftBrief: {
        ...craftBrief,
        characterExecution: {
          ...characterExecution,
          cast: (characterExecution.cast as Array<Record<string, unknown>>).map((item) => (
            item.source === 'volume_candidate' ? { ...item, characterName: candidateName } : item
          )),
          relationshipBeats: (characterExecution.relationshipBeats as Array<Record<string, unknown>>).map((beat) => ({
            ...beat,
            participants: Array.isArray(beat.participants)
              ? beat.participants.map((name) => name === previousCandidateName ? candidateName : name)
              : beat.participants,
          })),
        },
      },
    });
  };
  let calls = 0;
  const llm = {
    async chatJson() {
      calls += 1;
      const chapterNo = calls;
      return {
        data: {
          volume: {
            volumeNo: 1,
            title: 'Batch volume',
            synopsis: 'Batch synopsis',
            objective: 'Batch objective',
            chapterCount: 2,
            narrativePlan: chapterNo === 1 ? createVccNarrativePlanForChapterCount(2) : createSecondBatchNarrativePlan(),
          },
          chapters: [
            chapterNo === 1
              ? createOutlineChapter(1, 1)
              : createChapterUsingCandidate(2, 'BatchOnlyCandidate'),
          ],
          risks: [],
        },
        result: { model: `mock-outline-${chapterNo}` },
      };
    },
  };
  const tool = new GenerateOutlinePreviewTool(llm as never);

  await assert.rejects(
    () => tool.run(
      {
        instruction: 'generate two chapters',
        volumeNo: 1,
        chapterCount: 2,
        context: { characters: existingNames.map((name) => ({ name })) },
      },
      { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
    ),
    /逐章合并角色执行|BatchOnlyCandidate|volume_candidate|characterPlan/,
  );
  assert.equal(calls, 2);
});

test('VCC validate_guided_step_preview marks guided_chapter supportingCharacters as session only', async () => {
  const validVolume = createVccGuidedVolume();
  const existingNames = (validVolume.narrativePlan.characterPlan as ReturnType<typeof createVccCharacterPlan>)
    .existingCharacterArcs.map((arc) => arc.characterName);
  const prisma = {
    character: { async findMany() { return existingNames.map((name) => ({ name, alias: [] })); } },
    guidedSession: { async findUnique() { return { stepData: { guided_volume_result: { volumes: [validVolume] } } }; } },
    volume: { async findMany() { return [{ id: 'v1', volumeNo: 1, title: 'Volume 1' }]; } },
    chapter: { async findMany() { return []; } },
  };
  const tool = new ValidateGuidedStepPreviewTool(prisma as never);

  const result = await tool.run(
    {
      stepKey: 'guided_chapter',
      volumeNo: 1,
      structuredData: {
        chapters: [createVccGuidedChapter({ chapterNo: 1, volumeNo: 1 })],
        supportingCharacters: [{ name: 'SessionOnlyAlly' }],
      },
    },
    { agentRunId: 'run-vcc-validate-guided-supporting-preview', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  const writePreview = result.writePreview as Record<string, unknown>;
  const supporting = writePreview.supportingCharacters as Array<Record<string, unknown>>;
  assert.equal(result.valid, true);
  assert.equal(supporting[0].action, 'session_only');
  assert.doesNotMatch(String(writePreview.approvalMessage), /重建|create/i);
  assert.match(String(writePreview.approvalMessage), /不会创建正式角色|supportingCharacters/);
});

async function main() {
  const filter = process.env.AGENT_TEST_FILTER?.trim();
  const selectedTests = filter ? tests.filter((item) => item.name.includes(filter)) : tests;
  if (filter && !selectedTests.length) {
    throw new Error(`AGENT_TEST_FILTER did not match any tests: ${filter}`);
  }
  for (const item of selectedTests) {
    await item.run();
    console.log(`✓ ${item.name}`);
  }
  console.log(`Agent 服务测试通过：${selectedTests.length}/${tests.length} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
