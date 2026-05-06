import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseTool } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { AgentExecutorService, AgentWaitingReviewError } from './agent-executor.service';
import { AgentExecutionObservationError } from './agent-observation.types';
import { AgentReplannerService } from './agent-replanner.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentPlannerService } from './agent-planner.service';
import { AgentPolicyService, AgentSecondConfirmationRequiredError } from './agent-policy.service';
import { AgentTraceService } from './agent-trace.service';
import { AgentRunsService } from './agent-runs.service';
import { GenerateChapterService } from '../generation/generate-chapter.service';
import { GenerationProfileService } from '../generation-profile/generation-profile.service';
import { UpdateGenerationProfileDto } from '../generation-profile/dto/update-generation-profile.dto';
import { ChapterAutoRepairService } from '../generation/chapter-auto-repair.service';
import { PromptBuilderService } from '../generation/prompt-builder.service';
import { RetrievalPlannerService } from '../generation/retrieval-planner.service';
import { ValidateOutlineTool } from '../agent-tools/tools/validate-outline.tool';
import { ValidateImportedAssetsTool } from '../agent-tools/tools/validate-imported-assets.tool';
import { PersistOutlineTool } from '../agent-tools/tools/persist-outline.tool';
import { CollectChapterContextTool } from '../agent-tools/tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from '../agent-tools/tools/collect-task-context.tool';
import { InspectProjectContextTool } from '../agent-tools/tools/inspect-project-context.tool';
import { CharacterConsistencyCheckTool } from '../agent-tools/tools/character-consistency-check.tool';
import { PlotConsistencyCheckTool } from '../agent-tools/tools/plot-consistency-check.tool';
import { GenerateGuidedStepPreviewTool } from '../agent-tools/tools/generate-guided-step-preview.tool';
import { ValidateGuidedStepPreviewTool } from '../agent-tools/tools/validate-guided-step-preview.tool';
import { PersistGuidedStepResultTool } from '../agent-tools/tools/persist-guided-step-result.tool';
import { BuildImportPreviewTool } from '../agent-tools/tools/build-import-preview.tool';
import { GenerateImportOutlinePreviewTool } from '../agent-tools/tools/generate-import-outline-preview.tool';
import { MergeImportPreviewsTool } from '../agent-tools/tools/merge-import-previews.tool';
import { PersistProjectAssetsTool } from '../agent-tools/tools/persist-project-assets.tool';
import { GenerateWorldbuildingPreviewTool } from '../agent-tools/tools/generate-worldbuilding-preview.tool';
import { ValidateWorldbuildingTool } from '../agent-tools/tools/validate-worldbuilding.tool';
import { PersistWorldbuildingTool } from '../agent-tools/tools/persist-worldbuilding.tool';
import { GenerateStoryBiblePreviewTool } from '../agent-tools/tools/generate-story-bible-preview.tool';
import { ValidateStoryBibleTool } from '../agent-tools/tools/validate-story-bible.tool';
import { PersistStoryBibleTool } from '../agent-tools/tools/persist-story-bible.tool';
import { GenerateContinuityPreviewTool, PersistContinuityChangesTool, ValidateContinuityChangesTool } from '../agent-tools/tools/continuity-changes.tool';
import { RelationshipGraphService } from '../agent-tools/relationship-graph.service';
import { FactExtractorService } from '../facts/fact-extractor.service';
import { WriteChapterSeriesTool } from '../agent-tools/tools/write-chapter-series.tool';
import { AiQualityReviewTool } from '../agent-tools/tools/ai-quality-review.tool';
import { RetrievalService } from '../memory/retrieval.service';
import { GuidedService } from '../guided/guided.service';
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
  assert.equal(rules.getPolicy().limits.maxSteps, 20);
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
  const policy = new AgentPolicyService(new RuleEngineService());
  const tooManySteps = Array.from({ length: 21 }, (_, index) => ({ stepNo: index + 1, name: `步骤${index + 1}`, tool: 'echo_report', mode: 'act' as const, requiresApproval: false, args: {} }));
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
  assert.ok(result.missing.includes('concrete_clues'));
  assert.ok(result.missing.includes('irreversible_consequence'));
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
    craftBrief: {
      visibleGoal: '确认失踪者最后出现位置',
      coreConflict: '守井人阻止主角靠近',
      actionBeats: ['主角绕到井后', '守井人故意打翻灯油', '主角抢在火起前捡走湿红线'],
      concreteClues: [{ name: '湿红线', sensoryDetail: '冰凉，带井水泥腥味', laterUse: '证明失踪者来过井边' }],
      irreversibleConsequence: '主角拿走木珠后，井开始叫他的名字',
    },
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

test('GenerateChapterService run carries current chapter SceneCards through contextPack retrievalPayload and prompt trace', async () => {
  let sceneWhere: Record<string, unknown> | undefined;
  let draftCreateData: Record<string, unknown> | undefined;
  let qualityReportData: Record<string, unknown> | undefined;
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
    async chat() {
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
  const contextPack = result.retrievalPayload.contextPack as { planningContext: { sceneCards: Array<Record<string, unknown>> } };
  const promptTrace = result.promptDebug.sceneCardSourceTrace as Array<Record<string, unknown>>;
  const generationContext = draftCreateData?.generationContext as { retrievalPayload: { contextPack: { planningContext: { sceneCards: Array<Record<string, unknown>> } } } };

  assert.deepEqual(sceneWhere, { projectId: 'p1', chapterId: 'c1', NOT: { status: 'archived' } });
  assert.equal(contextPack.planningContext.sceneCards[0].id, 'scene-run');
  assert.deepEqual(contextPack.planningContext.sceneCards[0].relatedForeshadowIds, ['f-ledger']);
  assert.deepEqual(contextPack.planningContext.sceneCards[0].metadata, { beat: 'reveal' });
  assert.deepEqual(promptTrace[0], { sourceType: 'scene_card', sourceId: 'scene-run', projectId: 'p1', volumeId: null, chapterId: 'c1', chapterNo: 4, sceneNo: 1 });
  assert.equal(generationContext.retrievalPayload.contextPack.planningContext.sceneCards[0].id, 'scene-run');
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
  const prisma = {
    agentPlan: { async findFirst() { return { version: 1, taskType: 'chapter_write', steps: [] }; } },
    agentRun: {
      async findUnique() { return { id: 'run1', projectId: 'p1', chapterId: null, goal: '测试目标', input: { contextSnapshot: { schemaVersion: 2, session: { currentProjectId: 'p1' } } }, status: 'waiting_approval' }; },
      async updateMany(args: { data: Record<string, unknown> }) { updates.push(args.data); return { count: 1 }; },
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
  const updates: Array<{ agentRunId: string; stepNo: number; mode: string; planVersion: number }> = [];
  const prisma = {
    agentStep: {
      async upsert(args: { where: { agentRunId_mode_planVersion_stepNo: { agentRunId: string; stepNo: number; mode: string; planVersion: number } }; create: { mode: string } }) {
        upserts.push(args.where.agentRunId_mode_planVersion_stepNo);
      },
      async update(args: { where: { agentRunId_mode_planVersion_stepNo: { agentRunId: string; stepNo: number; mode: string; planVersion: number } } }) {
        updates.push(args.where.agentRunId_mode_planVersion_stepNo);
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
    { agentRunId: 'run1', stepNo: 2, mode: 'plan', planVersion: 2 },
    { agentRunId: 'run1', stepNo: 2, mode: 'act', planVersion: 2 },
  ]);
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
    context: { currentProjectId: '11111111-1111-4111-8111-111111111111', requestedAssetTypes: ['outline', 'writingRules', 'outline'] },
  });

  assert.deepEqual((createdInput?.context as Record<string, unknown>).requestedAssetTypes, ['outline', 'writingRules']);
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
  };
  const tool = new ValidateOutlineTool(prisma as never);
  const result = await tool.run(
    { preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '', objective: '', chapterCount: 1 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: { beats: ['起', '承'] } as unknown as string, expectedWordCount: 2000 }], risks: [] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.equal(result.valid, true);
  assert.equal(result.writePreview?.chapters[0].title, '一');
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
  assert.deepEqual(artifacts[1].content, { volumes: preview.volumes, chapters: preview.chapters, risks: preview.risks });
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

test('GenerateGuidedStepPreviewTool 生成全部 guided 步骤预览且保持只读', async () => {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
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
  const context = { agentRunId: 'run1', projectId: 'p1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };

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
  assert.match(calls[1].messages[0].content, /"pov"/);
  assert.match(calls[5].messages[0].content, /"chapters"/);
  assert.match(calls[6].messages[0].content, /"foreshadowTracks"/);
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
  assert.deepEqual(reads, ['character.findMany', 'volume.findMany', 'volume.findMany', 'chapter.findMany']);
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
  const llm = {
    async chatJson() {
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
    { agentRunId: 'run-cont', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
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

  const storyPreview = await storyPreviewTool.run({ instruction: 'Plan archive rules.' }, context);
  await storyValidationTool.run({ preview: storyPreview }, context);
  const continuityPreview = await continuityPreviewTool.run({ instruction: 'Check continuity.' }, context);
  await continuityValidationTool.run({ preview: continuityPreview }, context);
  await collectTool.run({ taskType: 'general' }, context);
  await inspectTool.run({}, context);
  await guidedPreviewTool.run({ stepKey: 'guided_chapter', volumeNo: 1, chapterNo: 1, projectContext: { seed: true } }, context);

  assert.deepEqual(writeCalls, []);
  for (const tool of [storyPreviewTool, storyValidationTool, continuityPreviewTool, continuityValidationTool, collectTool, inspectTool, guidedPreviewTool]) {
    assert.equal(tool.requiresApproval, false);
    assert.deepEqual(tool.sideEffects, []);
  }
  assert.equal(new PersistStoryBibleTool(prisma as never, { async deleteProjectRecallResults() {} } as never).requiresApproval, true);
  assert.equal(new PersistContinuityChangesTool(prisma as never, { async deleteProjectRecallResults() {} } as never).requiresApproval, true);
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
  const contextFor = (previewOutput: unknown = preview, validationOutput: unknown = validation) => ({
    agentRunId: 'run1',
    projectId: 'p1',
    mode: 'act' as const,
    approved: true,
    outputs: { 2: previewOutput, 3: validationOutput },
    stepTools: { 2: 'generate_continuity_preview', 3: 'validate_continuity_changes' },
    policy: {},
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

test('GenerateImportOutlinePreviewTool 只生成导入大纲预览并保持只读', async () => {
  let promptText = '';
  let receivedOptions: Record<string, unknown> | undefined;
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      promptText = messages.map((item) => item.content).join('\n\n');
      receivedOptions = options;
      return {
        data: {
          projectProfile: { outline: { mainline: '雾城档案员追查记忆篡改主线' }, title: '不应输出' },
          volumes: [{ volumeNo: 1, title: { primary: '灰楼旧灯' }, synopsis: ['发现异常'], objective: { goal: '确认旧案存在' } }],
          chapters: [
            { chapterNo: 1, volumeNo: 1, title: { primary: '失踪的页码' }, objective: ['发现缺页'], conflict: { pressure: '馆方阻止' }, hook: true, outline: { summary: '夜查档案库' }, expectedWordCount: 3200 },
          ],
          characters: [{ name: '不应出现' }],
          lorebookEntries: [{ title: '不应出现' }],
          writingRules: [{ title: '不应出现' }],
          risks: [{ message: '章节数需复核' }, '  保留风险  '],
        },
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
  assert.equal(tool.executionTimeoutMs, 500_000);
  assert.equal(receivedOptions?.timeoutMs, 450_000);
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
  assert.equal(output.projectProfile.synopsis, 'source synopsis');
  assert.deepEqual(output.characters[0], { name: 'Lu', roleType: 'lead、engineer', personalityCore: undefined, motivation: undefined, backstory: undefined });
  assert.deepEqual(output.lorebookEntries[0], { title: 'Sea', entryType: 'setting', content: 'inverted sea', summary: undefined, tags: ['sky', '{"value":"tide"}'] });
  assert.deepEqual(output.writingRules[0], { title: 'No Slang', ruleType: 'style', content: 'avoid memes', severity: 'warning', appliesFromChapterNo: undefined, appliesToChapterNo: undefined, entityType: undefined, entityRef: undefined, status: 'active' });
  assert.ok(output.projectProfile.outline?.includes('第 1 章：Escape'));
  assert.equal(output.volumes[0].title, 'First Tide');
  assert.equal(output.chapters[0].outline, 'fix bridge');
});

test('BuildImportPreviewTool 只保留 requestedAssetTypes 指定的目标产物', async () => {
  let promptText = '';
  const llm = {
    async chatJson(messages: Array<{ role: string; content: string }>) {
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
  const output = await tool.run(
    { analysis: { sourceText: 'source', length: 6, paragraphs: ['source'], keywords: [] }, instruction: '只生成故事大纲', requestedAssetTypes: ['outline'] },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );

  assert.match(promptText, /Requested asset types: outline/);
  assert.deepEqual(output.requestedAssetTypes, ['outline']);
  assert.equal(output.projectProfile.title, undefined);
  assert.equal(output.projectProfile.outline, 'main line');
  assert.deepEqual(output.characters, []);
  assert.deepEqual(output.lorebookEntries, []);
  assert.deepEqual(output.writingRules, []);
  assert.equal(output.chapters.length, 1);
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
    async run(_projectId: string, chapterId: string) {
      generatedChapterIds.push(chapterId);
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

  const result = await tool.run({ startChapterNo: 3, endChapterNo: 4, instruction: '连续写两章' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} });

  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
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

  generatedChapterIds.length = 0;
  pipelineCalls.length = 0;
  const maxChaptersResult = await tool.run({ startChapterNo: 3, maxChapters: 2, instruction: '从第 3 章开始连续写两章', qualityPipeline: 'draft_only' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} });
  assert.deepEqual(generatedChapterIds, ['c3', 'c4']);
  assert.deepEqual(pipelineCalls, []);
  assert.equal(maxChaptersResult.total, 2);
  assert.deepEqual(maxChaptersResult.chapters.map((item) => item.chapterNo), [3, 4]);

  await assert.rejects(
    () => tool.run({ startChapterNo: 1, endChapterNo: 6, instruction: '太多章' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
    /最多允许 5 章/,
  );
  await assert.rejects(
    () => tool.run({ maxChapters: 2, instruction: '缺少起始章节' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
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

test('FactExtractorService 抽取事实后同步生成 pending_review 记忆', async () => {
  const memoryInputs: Array<Record<string, unknown>> = [];
  const createdCharacters: Array<Record<string, unknown>> = [];
  const createdLorebookEntries: Array<Record<string, unknown>> = [];
  const prisma = {
    chapter: {
      async findFirst() {
        return { id: 'c1', projectId: 'p1', chapterNo: 12, title: '雨夜', objective: '推进冲突', conflict: '师徒对峙', timelineSeq: 12, project: { title: '测试书', generationProfile: { allowNewCharacters: true, allowNewLocations: true, allowNewForeshadows: true, preGenerationChecks: [] } } };
      },
    },
    chapterDraft: { async findFirst() { return { id: 'draft1', chapterId: 'c1', content: '林烬在雨夜得知真相，压下怒意，并注意到旧玉佩再次发光。' }; } },
    character: { async findMany() { return []; } },
    lorebookEntry: { async findMany() { return []; } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        storyEvent: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        characterStateSnapshot: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
        foreshadowTrack: { async deleteMany() { return { count: 0 }; }, async createMany(args: { data: unknown[] }) { return { count: args.data.length }; } },
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
    async act(_id: string, approvedStepNos?: number[]) {
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
      context: { requestedAssetTypes: ['outline', 'writingRules', 'unknown'] },
      clarificationState: { latestChoice: { id: 'char_1', label: '林烬', payload: { characterId: 'char_1' } }, history: [{ roundNo: 1, question: '你说的小林是哪位？', selectedChoice: { id: 'char_1', label: '林烬' }, answeredAt: '2026-04-28T00:00:00.000Z' }] },
    } as never,
  });

  assert.equal(context.session.clarification?.history.length, 1);
  assert.equal(context.session.clarification?.latestChoice?.label, '林烬');
  assert.deepEqual(context.session.clarification?.latestChoice?.payload, { characterId: 'char_1' });
  assert.deepEqual(context.session.requestedAssetTypes, ['outline', 'writingRules']);
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

  assert.deepEqual(bundle.structuredHits.map((hit) => hit.sourceId).sort(), ['rel-visible', 'rule-visible', 'time-visible']);
  assert.deepEqual(bundle.structuredHits.map((hit) => hit.sourceType).sort(), ['relationship_edge', 'timeline_event', 'writing_rule']);
  assert.equal(bundle.structuredHits.some((hit) => hit.sourceId === 'rel-future'), false);
  const timelineHit = bundle.structuredHits.find((hit) => hit.sourceType === 'timeline_event');
  assert.equal(timelineHit?.sourceTrace.chapterNo, 3);
  assert.equal(timelineHit?.metadata.chapterNo, 3);
  assert.equal(bundle.diagnostics.qualityStatus, 'ok');
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
  assert.match(result.user, /sourceType=writing_rule/);
  assert.match(result.user, /sourceId=rule-1/);
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
  const tool = new AiQualityReviewTool({
    async reviewAndCreate() {
      callCount += 1;
      return { reportId: 'report-1', projectId: 'p1', chapterId: 'c1', draftId: 'd1', sourceType: 'ai_review', reportType: 'ai_chapter_review', verdict: 'pass', summary: 'ok', scores: { overall: 90 }, issues: [] };
    },
  } as never);

  assert.equal(tool.requiresApproval, true);
  assert.deepEqual(tool.allowedModes, ['act']);
  assert.deepEqual(tool.sideEffects, ['create_quality_report']);
  assert.equal(tool.executionTimeoutMs, 300_000);
  assert.ok(tool.executionTimeoutMs > 240_000);
  await assert.rejects(() => tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} }), /Act 模式/);
  await assert.rejects(() => tool.run({ chapterId: 'c1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: false, outputs: {}, policy: {} }), /需要用户审批/);

  const output = await tool.run({ draftId: 'd1' }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} });
  assert.equal(output.reportId, 'report-1');
  assert.equal(callCount, 1);
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
  let qualityReportFindArgs: { where: Record<string, unknown> } | undefined;
  const createdDrafts: Array<Record<string, unknown>> = [];
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
    async chat(messages: Array<{ role: string; content: string }>) {
      promptText = messages[1].content;
      return { text: '线索在雨里断开，主角沿着暗巷追逐敌人，并在墙缝里发现缺失的线索落点。'.repeat(8), model: 'mock', usage: {}, rawPayloadSummary: {} };
    },
  };
  const service = new ChapterAutoRepairService(prisma as never, llm as never);

  const result = await service.run('p1', 'c1', { draftId: 'd1', maxRounds: 1 });

  assert.equal(result.skipped, false);
  assert.equal(result.repairedIssueCount, 1);
  assert.equal(qualityReportFindArgs?.where.sourceType, 'generation');
  assert.equal(qualityReportFindArgs?.where.reportType, 'generation_quality_gate');
  assert.equal(qualityReportFindArgs?.where.draftId, 'd1');
  assert.equal(Object.prototype.hasOwnProperty.call(qualityReportFindArgs?.where ?? {}, 'OR'), false);
  assert.match(promptText, /generation_quality_gate/);
  assert.match(promptText, /Scene card clue missing/);
  assert.equal(createdDrafts[0].source, 'agent_auto_repair');
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
  assert.ok(registry.get('merge_import_previews'));
  await moduleRef.close();
});

async function main() {
  for (const item of tests) {
    await item.run();
    console.log(`✓ ${item.name}`);
  }
  console.log(`Agent 服务测试通过：${tests.length} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
