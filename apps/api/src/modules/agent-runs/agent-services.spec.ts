import assert from 'node:assert/strict';
import { BaseTool } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { AgentExecutorService, AgentWaitingReviewError } from './agent-executor.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentPlannerService } from './agent-planner.service';
import { AgentPolicyService, AgentSecondConfirmationRequiredError } from './agent-policy.service';
import { AgentTraceService } from './agent-trace.service';
import { AgentRunsService } from './agent-runs.service';
import { GenerateChapterService } from '../generation/generate-chapter.service';
import { ValidateOutlineTool } from '../agent-tools/tools/validate-outline.tool';
import { ValidateImportedAssetsTool } from '../agent-tools/tools/validate-imported-assets.tool';
import { PersistOutlineTool } from '../agent-tools/tools/persist-outline.tool';
import { CollectChapterContextTool } from '../agent-tools/tools/collect-chapter-context.tool';

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
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (content: string, actualWordCount: number, targetWordCount: number) => { blocked: boolean; blockers: string[]; warnings: string[]; score: number };
  };
  const result = service.assessGeneratedDraftQuality('作为AI，我无法完成这个请求。{{待补充正文}}', 24, 3500);
  assert.equal(result.blocked, true);
  assert.ok(result.blockers.length >= 2);
  assert.ok(result.score < 50);
});

test('GenerateChapterService 生成后质量门禁标记重复段落退化', () => {
  const service = new GenerateChapterService({} as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    assessGeneratedDraftQuality: (content: string, actualWordCount: number, targetWordCount: number) => { blocked: boolean; blockers: string[] };
  };
  const repeated = Array.from({ length: 5 }, () => '走廊尽头的灯忽明忽暗，脚步声一次次逼近，像有什么东西贴着墙面缓慢爬行。').join('\n');
  const result = service.assessGeneratedDraftQuality(repeated, 2200, 3000);
  assert.equal(result.blocked, true);
  assert.match(result.blockers.join('；'), /重复段落/);
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
      async updateMany(args: { data: Record<string, unknown> }) { updates.push(args.data); return { count: 1 }; },
      async update(args: { data: Record<string, unknown> }) { updates.push(args.data); return { id: 'run1', status: args.data.status, error: args.data.error }; },
    },
  };
  const executor = { async execute() { throw new AgentWaitingReviewError('工具 fact_validation 命中风险 destructive_side_effect, fact_layer_write，需要二次确认'); } };
  const runtime = new AgentRuntimeService(prisma as never, {} as never, executor as never, {} as never);

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

test('PersistOutlineTool 阻止重复章节编号写入', async () => {
  const tool = new PersistOutlineTool({} as never);
  await assert.rejects(
    () => tool.run({ preview: { volume: { volumeNo: 1, title: '卷一', synopsis: '卷简介', objective: '卷目标', chapterCount: 2 }, chapters: [{ chapterNo: 1, title: '一', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }, { chapterNo: 1, title: '重复', objective: '目标', conflict: '冲突', hook: '钩子', outline: '梗概', expectedWordCount: 2000 }], risks: [] } }, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }),
    /章节编号重复/,
  );
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
    extract_chapter_facts: { chapterId: 'c1', draftId: 'draft-polish', summary: '摘要', createdEvents: 1, createdCharacterStates: 0, createdForeshadows: 0 },
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