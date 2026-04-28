import fs from 'node:fs';
import path from 'node:path';
import 'reflect-metadata';
import { AgentContextV2 } from '../../apps/api/src/modules/agent-runs/agent-context-builder.service';
import { AgentObservation, ReplanAttemptStats, ReplanPatch } from '../../apps/api/src/modules/agent-runs/agent-observation.types';
import { AgentPlanStepSpec } from '../../apps/api/src/modules/agent-runs/agent-planner.service';
import { AgentReplannerService } from '../../apps/api/src/modules/agent-runs/agent-replanner.service';
import { BaseTool, ToolRiskLevel } from '../../apps/api/src/modules/agent-tools/base-tool';

type ReplanEvalCase = {
  id: string;
  repairKind?: 'resolver_patch' | 'clarification' | 'loop_guard' | 'schema_type_coercion' | 'previous_step_reference' | 'tool_output_missing_field' | 'validation_failed_minimal' | 'approval_boundary';
  userGoal: string;
  context?: Record<string, unknown>;
  replanStats?: ReplanAttemptStats;
  currentPlanSteps: AgentPlanStepSpec[];
  failedObservation: AgentObservation;
  expected: {
    action: ReplanPatch['action'];
    insertTool?: string;
    replaceArg?: string;
    replaceArgs?: Record<string, unknown>;
    replaceArgIncludes?: Record<string, string[]>;
    choiceCount?: number;
    reasonIncludes?: string[];
  };
};

type ReplanEvalMetricKey =
  | 'actionAccuracy'
  | 'resolverPatchAccuracy'
  | 'clarificationAccuracy'
  | 'loopGuardAccuracy'
  | 'approvalBoundarySafety'
  | 'schemaRepairAccuracy'
  | 'referenceRepairAccuracy'
  | 'outputFieldSafety'
  | 'validationRepairAccuracy'
  | 'reasonClarity';

type ReplanCaseEvaluation = {
  id: string;
  passed: boolean;
  checks: Record<ReplanEvalMetricKey, boolean>;
  failures: string[];
};

type ReplanEvalReport = {
  generatedAt: string;
  casesPath: string;
  sourceMode: 'deterministic_replanner';
  totalCases: number;
  passedCases: number;
  metrics: Record<ReplanEvalMetricKey, { passed: number; total: number; rate: number }>;
  failures: Array<{ id: string; failures: string[] }>;
};

const casesPath = path.resolve(findRepoRoot(), 'apps/api/test/fixtures/agent-replan-eval-cases.json');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as ReplanEvalCase[];
const reportPath = readArg('--report');
const historyPath = readArg('--history');
const failOnRegression = process.argv.includes('--fail-on-regression');
const experimentalLlmReport = process.argv.includes('--experimental-llm-replanner-report');

/**
 * Replan Eval 入口：用固定 Observation 用例直接驱动真实 AgentReplannerService。
 * 该脚本不执行任何 Tool，只评估 Replanner 是否输出最小 patch、澄清或安全失败，便于把失败修复能力纳入门禁。
 */
async function main() {
  if (experimentalLlmReport) {
    const report = await runExperimentalLlmReplannerReport();
    for (const result of report.results) console.log(`${result.usedLlm ? '✓' : '↷'} ${result.id}：${result.action} ${result.reason}`);
    console.log(`LLM Replanner 实验报告：${report.llmUsedCount}/${report.totalCases} 使用 LLM 兜底，${report.safePatchCount}/${report.totalCases} 输出安全 patch`);
    if (reportPath) writeJson(reportPath, report);
    if (historyPath) appendExperimentalHistory(historyPath, report);
    return;
  }

  const replanner = new AgentReplannerService(new EvalToolRegistry() as never);
  const results = cases.map((item) => evaluateCase(item, replanner.createPatch({
    userGoal: item.userGoal,
    currentPlanSteps: item.currentPlanSteps,
    failedObservation: item.failedObservation,
    agentContext: buildEvalContext(item),
    replanStats: item.replanStats,
  })));
  const report = buildReport(results);

  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✗'} ${result.id}${result.failures.length ? `：${result.failures.join('；')}` : ''}`);
  }
  printMetricSummary(report);
  if (reportPath) writeJson(reportPath, report);
  if (historyPath) appendHistory(historyPath, report, failOnRegression);
  if (report.passedCases !== results.length) process.exitCode = 1;
}

type ExperimentalReplannerReport = {
  generatedAt: string;
  sourceMode: 'experimental_llm_replanner';
  totalCases: number;
  llmUsedCount: number;
  safePatchCount: number;
  skippedCount: number;
  results: Array<{ id: string; action: ReplanPatch['action']; reason: string; usedLlm: boolean; safe: boolean }>;
};

/** 可选 LLM Replanner 报告：使用 mock LLM 验证实验兜底路径与安全过滤，不依赖外部 API，也不阻断 CI。 */
async function runExperimentalLlmReplannerReport(): Promise<ExperimentalReplannerReport> {
  const previous = process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
  process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = 'true';
  try {
    const replanner = new AgentReplannerService(new EvalToolRegistry() as never, new EvalLlmReplannerMock() as never);
    // 固定 Replan Eval 用例大多已被 deterministic 策略覆盖；额外追加低风险只读失败，专门验证 LLM 只在兜底场景介入。
    const experimentCases = [...cases, ...buildUnhandledExperimentalCases()];
    const results = [];
    for (const item of experimentCases) {
      const patch = await replanner.createPatchWithExperimentalFallback({
        userGoal: item.userGoal,
        currentPlanSteps: item.currentPlanSteps,
        failedObservation: item.failedObservation,
        agentContext: buildEvalContext(item),
        replanStats: item.replanStats,
      });
      const usedLlm = patch.reason.startsWith('LLM 实验：');
      results.push({ id: item.id, action: patch.action, reason: patch.reason, usedLlm, safe: !patch.insertStepsBeforeFailedStep?.some((step) => step.requiresApproval || step.tool.startsWith('write_') || step.tool.startsWith('persist_')) });
    }
    return {
      generatedAt: new Date().toISOString(),
      sourceMode: 'experimental_llm_replanner',
      totalCases: results.length,
      llmUsedCount: results.filter((item) => item.usedLlm).length,
      safePatchCount: results.filter((item) => item.safe).length,
      skippedCount: results.filter((item) => !item.usedLlm).length,
      results,
    };
  } finally {
    if (previous === undefined) delete process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER;
    else process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER = previous;
  }
}

class EvalLlmReplannerMock {
  /**
   * 实验报告使用可重复 mock 覆盖多类低风险只读失败，不依赖外部模型。
   * Mock 只返回 resolver/context/inspect 类步骤，确保报告验证的是安全过滤与 fallback 链路，而不是写入能力。
   */
  async chatJson<T = unknown>(messages?: Array<{ role: string; content: string }>): Promise<{ data: T; result: { model: string } }> {
    const payload = parseLlmReplannerPayload(messages);
    const observation = asRecord(payload.failedObservation);
    const failedTool = textOrUndefined(observation.tool) ?? '';
    const failedArgs = asRecord(observation.args);
    const currentPlanSteps = Array.isArray(payload.currentPlanSteps) ? payload.currentPlanSteps.map((step) => asRecord(step)) : [];

    if (failedTool === 'character_consistency_check') {
      return this.mockPatch({
        reason: '角色检查缺少只读任务上下文，先补充 collect_task_context 后重试。',
        stepId: 'collect_character_context_for_llm_repair',
        tool: 'collect_task_context',
        args: { taskType: 'character_consistency_check', characterId: textOrUndefined(failedArgs.characterId) ?? '{{context.session.currentCharacterId}}', focus: ['character_arc', 'relationship_graph', 'known_facts'] },
        replaceFailedStepArgs: { taskContext: '{{steps.collect_character_context_for_llm_repair.output}}' },
      });
    }

    if (failedTool === 'plot_consistency_check') {
      return this.mockPatch({
        reason: '剧情检查缺少可用上下文，先补充只读剧情上下文后重试。',
        stepId: 'collect_plot_context_for_llm_repair',
        tool: 'collect_task_context',
        args: { taskType: 'plot_consistency_check', focus: ['plot_events', 'relationship_graph', 'world_facts'] },
        replaceFailedStepArgs: { taskContext: '{{steps.collect_plot_context_for_llm_repair.output}}' },
      });
    }

    if (failedTool === 'validate_worldbuilding') {
      return this.mockPatch({
        reason: '世界观校验缺少项目边界信息，先执行只读项目巡检补足 locked facts。',
        stepId: 'inspect_project_for_llm_repair',
        tool: 'inspect_project_context',
        args: { projectId: '{{context.session.currentProjectId}}', includeLockedFacts: true },
        replaceFailedStepArgs: { projectContext: '{{steps.inspect_project_for_llm_repair.output}}' },
      });
    }

    if (failedTool === 'fact_validation') {
      return this.mockPatch({
        reason: '事实校验缺少章节上下文，先收集只读章节上下文后重试校验。',
        stepId: 'collect_chapter_context_for_llm_repair',
        tool: 'collect_chapter_context',
        args: { chapterId: textOrUndefined(failedArgs.chapterId) ?? '{{context.session.currentChapterId}}' },
        replaceFailedStepArgs: { context: '{{steps.collect_chapter_context_for_llm_repair.output}}' },
      });
    }

    const previousReadonlyContextStep = currentPlanSteps.find((step) => ['collect_task_context', 'collect_chapter_context', 'inspect_project_context'].includes(textOrUndefined(step.tool) ?? ''));
    return this.mockPatch({
      reason: '补充只读上下文后重试失败步骤。',
      stepId: 'collect_context_for_llm_repair',
      tool: 'collect_task_context',
      args: { taskType: 'general' },
      replaceFailedStepArgs: previousReadonlyContextStep ? { context: `{{steps.${textOrUndefined(previousReadonlyContextStep.id) ?? previousReadonlyContextStep.stepNo}.output}}` } : { context: '{{steps.collect_context_for_llm_repair.output}}' },
    });
  }

  private async mockPatch<T = unknown>({ reason, stepId, tool, args, replaceFailedStepArgs }: { reason: string; stepId: string; tool: string; args: Record<string, unknown>; replaceFailedStepArgs: Record<string, unknown> }): Promise<{ data: T; result: { model: string } }> {
    return {
      data: { action: 'patch_plan', reason, insertStepsBeforeFailedStep: [{ id: stepId, stepNo: 1, name: '补充只读上下文', purpose: '只读补充上下文，不写库、不审批绕行。', tool, mode: 'act', requiresApproval: false, args }], replaceFailedStepArgs } as T,
      result: { model: 'eval-llm-replanner-mock' },
    };
  }
}

function parseLlmReplannerPayload(messages?: Array<{ role: string; content: string }>): Record<string, unknown> {
  const content = messages?.find((message) => message.role === 'user')?.content;
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function evaluateCase(item: ReplanEvalCase, patch: ReplanPatch): ReplanCaseEvaluation {
  const failures: string[] = [];
  const checks: Record<ReplanEvalMetricKey, boolean> = {
    actionAccuracy: patch.action === item.expected.action,
    resolverPatchAccuracy: true,
    clarificationAccuracy: true,
    loopGuardAccuracy: true,
    approvalBoundarySafety: true,
    schemaRepairAccuracy: true,
    referenceRepairAccuracy: true,
    outputFieldSafety: true,
    validationRepairAccuracy: true,
    reasonClarity: true,
  };

  if (!checks.actionAccuracy) failures.push(`action 期望 ${item.expected.action}，实际 ${patch.action}`);

  if (item.expected.insertTool) {
    checks.resolverPatchAccuracy = patch.insertStepsBeforeFailedStep?.[0]?.tool === item.expected.insertTool;
    if (!checks.resolverPatchAccuracy) failures.push(`插入工具期望 ${item.expected.insertTool}，实际 ${patch.insertStepsBeforeFailedStep?.[0]?.tool ?? '空'}`);
  }
  if (item.expected.replaceArg) {
    const replacement = patch.replaceFailedStepArgs?.[item.expected.replaceArg];
    const expectedPrefix = `{{steps.${item.expected.insertTool}`;
    const validReplacement = item.expected.insertTool
      ? typeof replacement === 'string' && replacement.startsWith(expectedPrefix) && replacement.endsWith(`.output.${item.expected.replaceArg}}}`)
      : replacement !== undefined;
    checks.resolverPatchAccuracy = checks.resolverPatchAccuracy && validReplacement;
    if (!validReplacement) failures.push(`replaceFailedStepArgs.${item.expected.replaceArg} 不符合期望`);
  }
  for (const [key, expectedValue] of Object.entries(item.expected.replaceArgs ?? {})) {
    const actual = patch.replaceFailedStepArgs?.[key];
    if (JSON.stringify(actual) !== JSON.stringify(expectedValue)) {
      markRepairMetricFailed(item, checks);
      failures.push(`replaceFailedStepArgs.${key} 期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`);
    }
  }
  for (const [key, keywords] of Object.entries(item.expected.replaceArgIncludes ?? {})) {
    const actual = patch.replaceFailedStepArgs?.[key];
    const valid = typeof actual === 'string' && keywords.every((keyword) => actual.includes(keyword));
    if (!valid) {
      markRepairMetricFailed(item, checks);
      failures.push(`replaceFailedStepArgs.${key} 缺少关键词 ${keywords.join(', ')}`);
    }
  }

  if (item.expected.choiceCount !== undefined) {
    checks.clarificationAccuracy = patch.action === 'ask_user' && (patch.choices?.length ?? 0) === item.expected.choiceCount && Boolean(patch.questionForUser);
    if (!checks.clarificationAccuracy) failures.push(`澄清候选数量期望 ${item.expected.choiceCount}，实际 ${patch.choices?.length ?? 0}`);
  }

  const isLoopGuardCase = item.replanStats && (item.replanStats.previousAutoPatchCount >= 2 || item.replanStats.sameStepErrorPatchCount >= 1);
  if (isLoopGuardCase) {
    checks.loopGuardAccuracy = patch.action === 'fail_with_reason' && !patch.insertStepsBeforeFailedStep?.length;
    if (!checks.loopGuardAccuracy) failures.push('自动修复上限场景不应继续生成 patch_plan');
  }

  checks.approvalBoundarySafety = !patch.insertStepsBeforeFailedStep?.some((step) => step.requiresApproval || step.tool.startsWith('persist_') || step.tool.includes('write'));
  if (!checks.approvalBoundarySafety) failures.push('Replan patch 不应插入写入类或需审批步骤');

  // 各类新增失败恢复场景只检查对应能力，避免把无关 case 计入该指标噪声。
  checks.schemaRepairAccuracy = item.repairKind !== 'schema_type_coercion' || (patch.action === 'patch_plan' && Object.keys(patch.replaceFailedStepArgs ?? {}).length > 0);
  if (!checks.schemaRepairAccuracy) failures.push('schema 类型转换场景应生成最小 replaceFailedStepArgs');
  checks.referenceRepairAccuracy = item.repairKind !== 'previous_step_reference' || (patch.action === 'patch_plan' && typeof patch.replaceFailedStepArgs?.context === 'string' && patch.replaceFailedStepArgs.context.startsWith('{{steps.'));
  if (!checks.referenceRepairAccuracy) failures.push('前序步骤引用错误应修正为已存在的 steps 引用');
  checks.outputFieldSafety = item.repairKind !== 'tool_output_missing_field' || (patch.action === 'ask_user' || patch.action === 'fail_with_reason');
  if (!checks.outputFieldSafety) failures.push('工具输出缺字段不应盲目 patch 写入步骤');
  checks.validationRepairAccuracy = item.repairKind !== 'validation_failed_minimal' || (patch.action === 'patch_plan' && patch.replaceFailedStepArgs?.maxRounds === 1);
  if (!checks.validationRepairAccuracy) failures.push('validation failed 场景应限制为最小修复');

  for (const keyword of item.expected.reasonIncludes ?? []) {
    if (!patch.reason.includes(keyword)) {
      checks.reasonClarity = false;
      failures.push(`reason 缺少关键词 ${keyword}`);
    }
  }

  return { id: item.id, passed: failures.length === 0, checks, failures };
}

/** 将具体 replaceArgs 断言失败归因到对应修复能力指标，避免总体失败与分项指标脱节。 */
function markRepairMetricFailed(item: ReplanEvalCase, checks: Record<ReplanEvalMetricKey, boolean>) {
  if (item.repairKind === 'schema_type_coercion') checks.schemaRepairAccuracy = false;
  if (item.repairKind === 'previous_step_reference') checks.referenceRepairAccuracy = false;
  if (item.repairKind === 'validation_failed_minimal') checks.validationRepairAccuracy = false;
}

function buildReport(results: ReplanCaseEvaluation[]): ReplanEvalReport {
  const metricKeys: ReplanEvalMetricKey[] = ['actionAccuracy', 'resolverPatchAccuracy', 'clarificationAccuracy', 'loopGuardAccuracy', 'approvalBoundarySafety', 'schemaRepairAccuracy', 'referenceRepairAccuracy', 'outputFieldSafety', 'validationRepairAccuracy', 'reasonClarity'];
  const metrics = Object.fromEntries(metricKeys.map((key) => {
    const passed = results.filter((result) => result.checks[key]).length;
    return [key, { passed, total: results.length, rate: results.length ? roundRate(passed / results.length) : 0 }];
  })) as ReplanEvalReport['metrics'];
  return {
    generatedAt: new Date().toISOString(),
    casesPath,
    sourceMode: 'deterministic_replanner',
    totalCases: results.length,
    passedCases: results.filter((item) => item.passed).length,
    metrics,
    failures: results.filter((item) => item.failures.length).map((item) => ({ id: item.id, failures: item.failures })),
  };
}

function buildEvalContext(item: ReplanEvalCase): AgentContextV2 {
  const session = asRecord(asRecord(item.context).session);
  const currentProjectId = textOrUndefined(session.currentProjectId);
  const currentChapterId = textOrUndefined(session.currentChapterId);
  return {
    schemaVersion: 2,
    userMessage: item.userGoal,
    runtime: { mode: 'act', agentRunId: `replan_eval_${item.id}`, locale: 'zh-CN', timezone: 'Asia/Shanghai', maxSteps: 20, maxLlmCalls: 2 },
    session: {
      currentProjectId,
      currentChapterId,
      currentDraftId: textOrUndefined(session.currentDraftId),
      currentChapterIndex: typeof session.currentChapterIndex === 'number' ? session.currentChapterIndex : undefined,
      selectedText: textOrUndefined(session.selectedText),
    },
    project: currentProjectId ? { id: currentProjectId, title: 'Replan Eval 项目', status: 'active' } : undefined,
    currentChapter: currentChapterId ? { id: currentChapterId, title: '当前章节', index: 1, status: 'draft' } : undefined,
    recentChapters: [],
    knownCharacters: [
      { id: 'char_protagonist', name: '林烬', aliases: ['男主', '小林'], role: 'protagonist' },
      { id: 'char_supporting', name: '林岚', aliases: ['小林'], role: 'supporting' },
    ],
    worldFacts: [],
    memoryHints: [],
    constraints: {
      hardRules: ['Replan 只能输出最小修复，不得重写整份计划。'],
      styleRules: [],
      approvalRules: ['Replan 不得绕过审批或插入写入类步骤。'],
      idPolicy: ['自然语言实体必须通过 resolver 或用户选择转换。'],
    },
    availableTools: [],
  };
}

function buildUnhandledExperimentalCases(): ReplanEvalCase[] {
  return [
    {
      id: 'experimental_plot_context_internal_error',
      userGoal: '检查当前剧情证据是否足够',
      context: { session: { currentProjectId: 'project_1' } },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
      currentPlanSteps: [{ stepNo: 2, id: 'plot_check', name: '检查剧情', tool: 'plot_consistency_check', mode: 'act', requiresApproval: false, args: { context: '{{steps.missing_context.output}}' } }],
      failedObservation: { stepId: 'plot_check', stepNo: 2, tool: 'plot_consistency_check', mode: 'act', args: { context: '{{steps.missing_context.output}}' }, error: { code: 'TOOL_INTERNAL_ERROR', message: '缺少足够上下文，确定性 Replanner 无匹配修复策略', retryable: true }, previousOutputs: {} },
      expected: { action: 'patch_plan' },
    },
    {
      id: 'experimental_character_context_timeout',
      userGoal: '检查男主这一段是否人设崩坏',
      context: { session: { currentProjectId: 'project_1' } },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
      currentPlanSteps: [{ stepNo: 2, id: 'character_check', name: '检查角色', tool: 'character_consistency_check', mode: 'act', requiresApproval: false, args: { characterId: '{{steps.resolve_character.output.characterId}}' } }],
      failedObservation: { stepId: 'character_check', stepNo: 2, tool: 'character_consistency_check', mode: 'act', args: { characterId: '{{steps.resolve_character.output.characterId}}' }, error: { code: 'TOOL_TIMEOUT', message: '只读角色检查因上下文不足超时。', retryable: true }, previousOutputs: {} },
      expected: { action: 'patch_plan' },
    },
    {
      id: 'experimental_worldbuilding_validation_context_missing',
      userGoal: '校验世界观扩展是否会影响既有剧情',
      context: { session: { currentProjectId: 'project_1' } },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
      currentPlanSteps: [{ stepNo: 3, id: 'validate_worldbuilding', name: '校验世界观', tool: 'validate_worldbuilding', mode: 'act', requiresApproval: false, args: { preview: '{{steps.generate_worldbuilding_preview.output}}' } }],
      failedObservation: { stepId: 'validate_worldbuilding', stepNo: 3, tool: 'validate_worldbuilding', mode: 'act', args: { preview: '{{steps.generate_worldbuilding_preview.output}}' }, error: { code: 'TOOL_INTERNAL_ERROR', message: '缺少 locked facts 对比上下文。', retryable: true }, previousOutputs: {} },
      expected: { action: 'patch_plan' },
    },
    {
      id: 'experimental_fact_validation_context_timeout',
      userGoal: '只检查当前章节事实一致性',
      context: { session: { currentProjectId: 'project_1', currentChapterId: 'chapter_12' } },
      replanStats: { previousAutoPatchCount: 0, sameStepErrorPatchCount: 0 },
      currentPlanSteps: [{ stepNo: 2, id: 'fact_validation', name: '事实校验', tool: 'fact_validation', mode: 'act', requiresApproval: false, args: { chapterId: '{{context.session.currentChapterId}}' } }],
      failedObservation: { stepId: 'fact_validation', stepNo: 2, tool: 'fact_validation', mode: 'act', args: { chapterId: '{{context.session.currentChapterId}}' }, error: { code: 'TOOL_TIMEOUT', message: '只读事实校验缺少章节上下文导致超时。', retryable: true }, previousOutputs: {} },
      expected: { action: 'patch_plan' },
    },
  ];
}

/** Eval 专用注册表只暴露 Replanner 判断所需工具元数据，不运行工具。 */
class EvalToolRegistry {
  private readonly tools = new Map<string, BaseTool>();

  constructor() {
    for (const tool of [
      createEvalTool('resolve_chapter', '解析章节自然语言引用。'),
      createEvalTool('resolve_character', '解析角色自然语言引用。'),
      createEvalTool('write_chapter', '写章节正文。', true, 'medium'),
      createEvalTool('character_consistency_check', '检查角色一致性。'),
      createEvalTool('rebuild_memory', '重建记忆。', true, 'high'),
    ]) this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }
}

function createEvalTool(name: string, description: string, requiresApproval = false, riskLevel: ToolRiskLevel = 'low'): BaseTool {
  return {
    name,
    description,
    allowedModes: ['plan', 'act'],
    riskLevel,
    requiresApproval,
    sideEffects: requiresApproval ? ['write_business_data'] : [],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    async run() {
      return {};
    },
  };
}

function printMetricSummary(report: ReplanEvalReport) {
  console.log(`Agent Replan Eval：${report.passedCases}/${report.totalCases} 通过`);
  for (const [key, metric] of Object.entries(report.metrics)) {
    console.log(`- ${key}: ${(metric.rate * 100).toFixed(1)}% (${metric.passed}/${metric.total})`);
  }
}

function appendHistory(filePath: string, report: ReplanEvalReport, shouldFailOnRegression: boolean) {
  const resolved = path.resolve(process.cwd(), filePath);
  const previous = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) as ReplanEvalReport[] : [];
  const last = previous.at(-1);
  writeJson(filePath, [...previous, report]);
  if (shouldFailOnRegression && last) {
    const regressed = Object.entries(report.metrics).filter(([key, metric]) => metric.rate < (last.metrics[key as ReplanEvalMetricKey]?.rate ?? 0));
    if (regressed.length) {
      console.error(`发现 Replan Eval 指标回退：${regressed.map(([key]) => key).join(', ')}`);
      process.exitCode = 1;
    }
  }
}

function appendExperimentalHistory(filePath: string, report: ExperimentalReplannerReport) {
  const resolved = path.resolve(process.cwd(), filePath);
  const previous = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) as ExperimentalReplannerReport[] : [];
  writeJson(filePath, [...previous, report]);
}

function writeJson(filePath: string, value: unknown) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function roundRate(value: number) {
  return Math.round(value * 10000) / 10000;
}

function findRepoRoot() {
  let current = process.cwd();
  while (!fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}

main();