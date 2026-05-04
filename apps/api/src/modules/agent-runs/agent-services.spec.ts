import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
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
import { ChapterAutoRepairService } from '../generation/chapter-auto-repair.service';
import { ValidateOutlineTool } from '../agent-tools/tools/validate-outline.tool';
import { ValidateImportedAssetsTool } from '../agent-tools/tools/validate-imported-assets.tool';
import { PersistOutlineTool } from '../agent-tools/tools/persist-outline.tool';
import { CollectChapterContextTool } from '../agent-tools/tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from '../agent-tools/tools/collect-task-context.tool';
import { CharacterConsistencyCheckTool } from '../agent-tools/tools/character-consistency-check.tool';
import { PlotConsistencyCheckTool } from '../agent-tools/tools/plot-consistency-check.tool';
import { GenerateGuidedStepPreviewTool } from '../agent-tools/tools/generate-guided-step-preview.tool';
import { ValidateGuidedStepPreviewTool } from '../agent-tools/tools/validate-guided-step-preview.tool';
import { PersistGuidedStepResultTool } from '../agent-tools/tools/persist-guided-step-result.tool';
import { BuildImportPreviewTool } from '../agent-tools/tools/build-import-preview.tool';
import { GenerateWorldbuildingPreviewTool } from '../agent-tools/tools/generate-worldbuilding-preview.tool';
import { ValidateWorldbuildingTool } from '../agent-tools/tools/validate-worldbuilding.tool';
import { PersistWorldbuildingTool } from '../agent-tools/tools/persist-worldbuilding.tool';
import { RelationshipGraphService } from '../agent-tools/relationship-graph.service';
import { FactExtractorService } from '../facts/fact-extractor.service';
import { WriteChapterSeriesTool } from '../agent-tools/tools/write-chapter-series.tool';
import { RetrievalService } from '../memory/retrieval.service';

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
      return createTool({ name, requiresApproval: false, riskLevel: 'low', sideEffects: [], inputSchema: { type: 'object', properties: { context: { type: 'object' } } }, outputSchema: { type: 'object' }, async run(args: Record<string, unknown>) { receivedContext = args.context; return { ok: true }; } });
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
    volume: { async findMany() { return [{ volumeNo: 1 }]; } },
    chapter: { async findMany() { return [{ chapterNo: 1, status: 'drafted', title: '旧章' }]; } },
  };
  const tool = new ValidateImportedAssetsTool(prisma as never);
  const result = await tool.run(
    { preview: { projectProfile: { title: '项目' }, characters: [{ name: '林岚' }, { name: '林岚' }, { name: '沈砚' }], lorebookEntries: [{ title: '雾城', entryType: 'location', content: '旧城' }, { title: '灯塔', entryType: 'place', content: '信号' }], volumes: [{ volumeNo: 1, title: '卷一' }], chapters: [{ chapterNo: 1, title: '一' }, { chapterNo: 2, title: '二' }], risks: [] } },
    { agentRunId: 'run1', projectId: 'p1', mode: 'plan', approved: false, outputs: {}, policy: {} },
  );
  assert.equal(result.writePreview?.summary.characterCreateCount, 1);
  assert.equal(result.writePreview?.summary.characterSkipCount, 2);
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

test('PersistOutlineTool 阻止重复章节编号写入', async () => {
  const tool = new PersistOutlineTool({} as never);
  await assert.rejects(
    () => tool.run({ preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 2 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }, { chapterNo: 1, title: '重复', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
    /章节编号重复/,
  );
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
        return { id: 'c1', projectId: 'p1', chapterNo: 12, title: '雨夜', objective: '推进冲突', conflict: '师徒对峙', timelineSeq: 12, project: { title: '测试书' } };
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
  const service = new FactExtractorService(prisma as never, llm as never, memoryWriter as never);

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
        return [{ id: 'l1', title: '雾城', entryType: 'location', summary: '雾城秘钥', content: '雾城秘钥藏在旧档案库。', tags: ['雾城'], priority: 80 }];
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
    input: { clarificationState: { latestChoice: { id: 'char_1', label: '林烬', payload: { characterId: 'char_1' } }, history: [{ roundNo: 1, question: '你说的小林是哪位？', selectedChoice: { id: 'char_1', label: '林烬' }, answeredAt: '2026-04-28T00:00:00.000Z' }] } } as never,
  });

  assert.equal(context.session.clarification?.history.length, 1);
  assert.equal(context.session.clarification?.latestChoice?.label, '林烬');
  assert.deepEqual(context.session.clarification?.latestChoice?.payload, { characterId: 'char_1' });
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
