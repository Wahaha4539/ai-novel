import fs from 'node:fs';
import path from 'node:path';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../apps/api/src/prisma/prisma.module';
import { PrismaService } from '../../apps/api/src/prisma/prisma.service';
import { RuleEngineService } from '../../apps/api/src/modules/agent-rules/rule-engine.service';
import { SkillRegistryService } from '../../apps/api/src/modules/agent-skills/skill-registry.service';
import { BaseTool, ToolRiskLevel } from '../../apps/api/src/modules/agent-tools/base-tool';
import { ToolManifestForPlanner } from '../../apps/api/src/modules/agent-tools/tool-manifest.types';
import { ToolRegistryService } from '../../apps/api/src/modules/agent-tools/tool-registry.service';
import { LlmGatewayService } from '../../apps/api/src/modules/llm/llm-gateway.service';
import { LlmChatMessage } from '../../apps/api/src/modules/llm/dto/llm-chat.dto';
import { LlmProvidersService } from '../../apps/api/src/modules/llm-providers/llm-providers.service';
import { AgentContextV2 } from '../../apps/api/src/modules/agent-runs/agent-context-builder.service';
import { AgentPlannerService } from '../../apps/api/src/modules/agent-runs/agent-planner.service';
import { PlanValidatorService } from '../../apps/api/src/modules/agent-runs/planner-graph/plan-validator.service';
import type { RouteDecision, SelectedToolBundle } from '../../apps/api/src/modules/agent-runs/planner-graph/planner-graph.state';
import { RootSupervisor } from '../../apps/api/src/modules/agent-runs/planner-graph/supervisors/root-supervisor';
import { ToolBundleRegistry } from '../../apps/api/src/modules/agent-runs/planner-graph/tool-bundles';
import { CollectTaskContextTool } from '../../apps/api/src/modules/agent-tools/tools/collect-task-context.tool';
import { CharacterConsistencyCheckTool } from '../../apps/api/src/modules/agent-tools/tools/character-consistency-check.tool';
import { PlotConsistencyCheckTool } from '../../apps/api/src/modules/agent-tools/tools/plot-consistency-check.tool';
import { ValidateWorldbuildingTool } from '../../apps/api/src/modules/agent-tools/tools/validate-worldbuilding.tool';
import { PersistWorldbuildingTool } from '../../apps/api/src/modules/agent-tools/tools/persist-worldbuilding.tool';

type RetrievalExpectation = {
  mustUseDimensions?: string[];
  mustIncludeFullDraft?: boolean;
  minPlotEvents?: number;
  minRelationshipEdges?: number;
  minConflictRelationshipEdges?: number;
  requiredRelationshipEdgeFields?: string[];
  minWorldFacts?: number;
  minWorldEntityTypes?: string[];
  minLockedWorldFacts?: number;
  minMemoryChunks?: number;
  maxMissingContext?: number;
  requireWorldbuildingValidationComparison?: boolean;
  requireWorldbuildingPersistAudit?: boolean;
  requirePlotEvidenceFields?: string[];
  requireCharacterEvidenceKeywords?: string[];
};

type StepArgExpectation = {
  tool: string;
  args?: Record<string, unknown>;
  mustHaveKeys?: string[];
  mustNotHaveKeys?: string[];
};

type PlannerEvalMode = 'legacy' | 'graph';

type RouteExpectation = {
  domain: string;
  intent?: string;
};

type EvalCase = {
  id: string;
  message: string;
  context?: Record<string, unknown>;
  expected: {
    taskType: string;
    mustUseTools?: string[];
    mustNotUseTools?: string[];
    mustContainInstruction?: string[];
    mustHaveMissingInfo?: string[];
    mustMatchStepArgs?: StepArgExpectation[];
    mustRequireApproval?: boolean;
    forbidInventedIds?: boolean;
    route?: RouteExpectation;
    bundle?: string;
    retrieval?: RetrievalExpectation;
  };
};

type AgentPlanLike = {
  taskType?: string;
  steps?: Array<{ tool?: string; args?: unknown; requiresApproval?: boolean }>;
  riskReview?: { requiresApproval?: boolean; riskLevel?: string; reasons?: string[]; approvalMessage?: string };
  missingInfo?: Array<{ field?: string; reason?: string; canResolveByTool?: boolean; resolverTool?: string }>;
  userVisiblePlan?: { summary?: string; bullets?: string[]; hiddenTechnicalSteps?: boolean };
  plannerDiagnostics?: Record<string, unknown>;
};

type RetrievalEvalOutput = {
  diagnostics?: { retrievalDimensions?: string[]; fullDraftIncluded?: boolean; missingContext?: string[] };
  plotEvents?: unknown[];
  relationshipGraph?: unknown[];
  worldFacts?: unknown[];
  memoryChunks?: unknown[];
  plotConsistencyReport?: unknown;
  characterConsistencyReport?: unknown;
  worldbuildingValidationReport?: unknown;
  worldbuildingPersistResult?: unknown;
};

type LivePlanResult = { case: EvalCase; plan: AgentPlanLike; error?: string; plannerMode: PlannerEvalMode };

type EvalMetricKey =
  | 'intentAccuracy'
  | 'toolPlanAccuracy'
  | 'requiredParamCompletion'
  | 'idHallucinationRate'
  | 'resolverUsageRate'
  | 'approvalSafety'
  | 'firstPlanSuccessRate'
  | 'userVisibleClarity'
  | 'retrievalDimensionCoverage'
  | 'routeAccuracy'
  | 'bundleAccuracy'
  | 'bundleToolLeakRate'
  | 'promptReductionRate';

type EvalMetric = { passed: number; total: number; rate: number };

type PromptSizeGateResult = {
  id: string;
  caseId: string;
  bundleName: string;
  selectedToolCount: number;
  allToolCount: number;
  selectedToolsChars: number;
  allToolsChars: number;
  selectedToAllRatio: number;
  maxSelectedToAllRatio: number;
  passed: boolean;
  failure?: string;
};

type CaseEvaluation = {
  id: string;
  passed: boolean;
  checks: Record<EvalMetricKey, boolean | undefined>;
  observations?: Partial<Record<EvalMetricKey, number>>;
  failures: string[];
};

type EvalReport = {
  generatedAt: string;
  casesPath: string;
  plansDir: string;
  sourceMode: 'offline_plans' | 'live_planner_mock_llm' | 'live_planner_real_llm' | 'retrieval_tool';
  plannerMode?: PlannerEvalMode;
  totalCases: number;
  passedCases: number;
  metrics: Record<EvalMetricKey, EvalMetric>;
  failures: Array<{ id: string; failures: string[] }>;
  comparedReports?: EvalReport[];
  promptSizeGates?: PromptSizeGateResult[];
};

type PromptBaselineReport = {
  generatedAt: string;
  sourceMode: 'planner_prompt_baseline';
  casesPath: string;
  caseId: string;
  userGoal: string;
  allToolCount: number;
  availableToolsChars: number;
  userPayloadChars: number;
  systemChars: number;
  totalChars: number;
  messageCount: number;
  availableToolNames: string[];
};

const casesPath = path.resolve(findRepoRoot(), 'apps/api/test/fixtures/agent-eval-cases.json');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as EvalCase[];
const plansDir = readArg('--plans');
const reportPath = readArg('--report');
const historyPath = readArg('--history');
const failOnRegression = process.argv.includes('--fail-on-regression');
const livePlanner = process.argv.includes('--live-planner');
const realLlmSample = process.argv.includes('--real-llm-sample');
const retrievalEval = process.argv.includes('--retrieval-eval');
const experimentalLlmEvidenceReport = process.argv.includes('--experimental-llm-evidence-report');
const promptBaseline = process.argv.includes('--prompt-baseline');
const promptBaselineCaseId = readArg('--case-id');

const PROMPT_SIZE_GATES = [
  { id: 'outline.volume.selected-tools', caseId: 'outline_volume_cn_024', expectedBundle: 'outline.volume', maxSelectedToAllRatio: 0.35 },
];

/**
 * Agent Planner 评测入口。
 * 输入 plans 目录时按 caseId.json 读取真实/离线 Planner 输出并打分；未输入时仅校验固定用例集可读取，便于 CI 先纳入基线。
 * 传入 --live-planner 时会构造 Nest TestingModule 并调用真实 AgentPlannerService.createPlan()，LLM 响应用可控 mock 固定，避免本地无 API Key 时评测不可重复。
 * 传入 --prompt-baseline 时只捕获 Planner prompt 体积，不调用真实 LLM，不执行工具。
 * 传入 --retrieval-eval 时会用确定性 Prisma Mock 驱动真实 collect_task_context 工具，直接评测工具输出的检索维度和召回数量。
 * 可选 --report/--history 会输出当前指标快照和历史趋势，用于观察 Prompt、Manifest、Resolver 改动后的回归。
 */
async function main() {
  if (promptBaseline) {
    const report = await createPlannerPromptBaselineReport(promptBaselineCaseId);
    console.log(`Planner prompt baseline (${report.caseId})`);
    console.log(`- allToolCount: ${report.allToolCount}`);
    console.log(`- availableToolsChars: ${report.availableToolsChars}`);
    console.log(`- userPayloadChars: ${report.userPayloadChars}`);
    console.log(`- systemChars: ${report.systemChars}`);
    console.log(`- totalChars: ${report.totalChars}`);
    if (reportPath) writeJson(reportPath, report);
    return;
  }

  if (experimentalLlmEvidenceReport) {
    const outputs = await Promise.all(cases.map((item) => createExperimentalEvidenceOutput(item)));
    const report = buildExperimentalEvidenceReport(outputs);
    for (const result of outputs) {
      const status = result.skipped ? '↷' : result.error ? '!' : result.output?.llmSummaryStatus === 'succeeded' ? '✓' : '↷';
      console.log(`${status} ${result.id}：${result.skipped ? '跳过' : result.output?.llmSummaryStatus ?? result.error ?? '无摘要'}`);
    }
    console.log(`LLM 证据归纳实验报告：${report.succeeded}/${report.totalCases} 成功，${report.fallback}/${report.totalCases} 降级，${report.skipped}/${report.totalCases} 跳过`);
    if (reportPath) writeJson(reportPath, report);
    if (historyPath) appendExperimentalHistory(historyPath, report);
    return;
  }

  if (retrievalEval) {
    const outputs = await Promise.all(cases.map((item) => createRealRetrievalOutput(item)));
    const results = outputs.map(({ item, output, error }) => {
      const evaluated = evaluateRetrievalCase(item, output ?? {});
      if (error) {
        evaluated.failures.push(`collect_task_context 调用失败：${error}`);
        evaluated.passed = false;
        evaluated.checks.retrievalDimensionCoverage = false;
      }
      return evaluated;
    });
    const report = buildReport(results, 'collect-task-context-tool', 'retrieval_tool');
    for (const result of results) {
      console.log(`${result.passed ? '✓' : '✗'} ${result.id}${result.failures.length ? `：${result.failures.join('；')}` : ''}`);
    }
    printMetricSummary(report);
    if (reportPath) writeJson(reportPath, report);
    if (historyPath) appendHistory(historyPath, report, failOnRegression);
    if (report.passedCases !== results.length) process.exitCode = 1;
    return;
  }

  if (realLlmSample) {
    const liveResults = await runLivePlannerEval({ realLlm: true, sampleSize: Number(readArg('--sample-size') ?? 3), plannerMode: 'legacy' });
    const results = liveResults.map(({ case: item, plan, error }) => {
      const evaluated = evaluateCase(item, plan, { plannerMode: 'legacy' });
      if (error) {
        evaluated.failures.push(`真实 LLM Planner 调用失败：${error}`);
        evaluated.passed = false;
      }
      return evaluated;
    });
    const report = buildReport(results, 'live-planner-real-llm-sample', 'live_planner_real_llm', 'legacy');
    for (const result of results) {
      console.log(`${result.passed ? '✓' : '✗'} ${result.id}${result.failures.length ? `：${result.failures.join('；')}` : ''}`);
    }
    printMetricSummary(report);
    if (reportPath) writeJson(reportPath, report);
    if (historyPath) appendHistory(historyPath, report, false);
    if (report.passedCases !== results.length) console.warn('真实 LLM 抽样评测发现漂移；该模式默认只观察，不设置失败码。');
    return;
  }

  if (livePlanner) {
    const legacyResults = evaluateLivePlanResults(await runLivePlannerEval({ plannerMode: 'legacy' }), 'Planner 调用失败');
    const legacyReport = buildReport(legacyResults, 'live-planner-legacy', 'live_planner_mock_llm', 'legacy');
    const graphResults = evaluateLivePlanResults(await runLivePlannerEval({ plannerMode: 'graph' }), 'Graph Planner 调用失败');
    const promptSizeGates = evaluatePromptSizeGates();
    const graphReport = buildReport(graphResults, 'live-planner-graph', 'live_planner_mock_llm', 'graph', [legacyReport], promptSizeGates);
    printCaseResults('legacy planner', legacyResults);
    printMetricSummary(legacyReport);
    printCaseResults('graph planner', graphResults);
    printMetricSummary(graphReport);
    printPromptSizeGates(promptSizeGates);
    if (reportPath) writeJson(reportPath, graphReport);
    if (historyPath) appendHistory(historyPath, graphReport, failOnRegression);
    if (legacyReport.passedCases !== legacyResults.length || graphReport.passedCases !== graphResults.length || promptSizeGates.some((gate) => !gate.passed)) process.exitCode = 1;
    return;
  }

  if (!plansDir) {
    console.log(`已加载 ${cases.length} 个 Agent Eval 用例。传入 --plans <dir> 可评测 Planner 输出。`);
    console.log('传入 --live-planner 可直接调用真实 AgentPlannerService.createPlan() 的可控 LLM 基线。');
    if (reportPath || historyPath) console.log('未传入 --plans，本次不生成指标报告。');
    return;
  }

  const results = cases.map((item) => evaluateCase(item, readPlan(item.id, plansDir)));
  const report = buildReport(results, plansDir, 'offline_plans');
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✗'} ${result.id}${result.failures.length ? `：${result.failures.join('；')}` : ''}`);
  }
  printMetricSummary(report);
  if (reportPath) writeJson(reportPath, report);
  if (historyPath) appendHistory(historyPath, report, failOnRegression);
  if (report.passedCases !== results.length) process.exitCode = 1;
}

type ExperimentalEvidenceOutput = { id: string; taskType: string; skipped?: boolean; error?: string; output?: { tool: string; llmSummaryStatus?: string; fallbackUsed?: boolean; summary?: string; keyFindings?: string[]; deterministicVerdict?: unknown } };

type ExperimentalEvidenceReport = {
  generatedAt: string;
  sourceMode: 'experimental_llm_evidence_summary';
  totalCases: number;
  succeeded: number;
  fallback: number;
  skipped: number;
  results: ExperimentalEvidenceOutput[];
};

/**
 * 可选 LLM 证据归纳报告：只运行角色/剧情只读检查的摘要实验。
 * 没有 API Key 或调用失败时工具会降级，脚本本身也不设置失败码，适合 CI artifact 留档。
 */
async function createExperimentalEvidenceOutput(item: EvalCase): Promise<ExperimentalEvidenceOutput> {
  if (!['character_consistency_check', 'plot_consistency_check'].includes(item.expected.taskType)) return { id: item.id, taskType: item.expected.taskType, skipped: true };
  const previous = process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY;
  process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY = 'true';
  try {
    const retrieval = await createRealRetrievalOutput(item);
    if (retrieval.error || !retrieval.output) return { id: item.id, taskType: item.expected.taskType, error: retrieval.error ?? 'retrieval output missing' };
    const llm = await createOptionalRealLlmGateway();
    const context = { agentRunId: `experimental_evidence_${item.id}`, projectId: textOrUndefined(asRecord(asRecord(item.context).session).currentProjectId) ?? 'project_1', mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
    if (item.expected.taskType === 'character_consistency_check') {
      const report = await new CharacterConsistencyCheckTool(llm as never).run({ characterId: 'char_protagonist', taskContext: retrieval.output as Record<string, unknown>, instruction: item.message }, context);
      return { id: item.id, taskType: item.expected.taskType, output: summarizeExperimentalToolOutput('character_consistency_check', report) };
    }
    const report = await new PlotConsistencyCheckTool(llm as never).run({ taskContext: retrieval.output as Record<string, unknown>, instruction: item.message }, context);
    return { id: item.id, taskType: item.expected.taskType, output: summarizeExperimentalToolOutput('plot_consistency_check', report) };
  } catch (error) {
    return { id: item.id, taskType: item.expected.taskType, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (previous === undefined) delete process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY;
    else process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY = previous;
  }
}

async function createOptionalRealLlmGateway(): Promise<LlmGatewayService> {
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule], providers: [LlmGatewayService, LlmProvidersService] }).compile();
  try {
    await moduleRef.get(LlmProvidersService).onModuleInit();
    return moduleRef.get(LlmGatewayService);
  } catch {
    // 保留无 Key/无数据库场景的降级行为：工具会捕获 chatJson 失败并返回 fallback。
    await moduleRef.close();
    return { async chatJson() { throw new Error('LLM evidence summary skipped: no provider or API key configured'); } } as unknown as LlmGatewayService;
  }
}

function summarizeExperimentalToolOutput(tool: string, report: unknown) {
  const record = asRecord(report);
  const summary = asRecord(record.llmEvidenceSummary);
  return {
    tool,
    llmSummaryStatus: textOrUndefined(summary.status) ?? 'disabled',
    fallbackUsed: summary.fallbackUsed === true,
    summary: textOrUndefined(summary.summary),
    keyFindings: Array.isArray(summary.keyFindings) ? summary.keyFindings.map((item) => String(item)).slice(0, 6) : [],
    deterministicVerdict: record.verdict,
  };
}

function buildExperimentalEvidenceReport(results: ExperimentalEvidenceOutput[]): ExperimentalEvidenceReport {
  return {
    generatedAt: new Date().toISOString(),
    sourceMode: 'experimental_llm_evidence_summary',
    totalCases: results.length,
    succeeded: results.filter((item) => item.output?.llmSummaryStatus === 'succeeded').length,
    fallback: results.filter((item) => item.output?.fallbackUsed || item.error).length,
    skipped: results.filter((item) => item.skipped).length,
    results,
  };
}

function appendExperimentalHistory(filePath: string, report: ExperimentalEvidenceReport) {
  const resolved = path.resolve(process.cwd(), filePath);
  const previous = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) as ExperimentalEvidenceReport[] : [];
  writeJson(filePath, [...previous, report]);
}

function evaluateLivePlanResults(liveResults: LivePlanResult[], errorPrefix: string): CaseEvaluation[] {
  return liveResults.map(({ case: item, plan, error, plannerMode }) => {
    const evaluated = evaluateCase(item, plan, { plannerMode });
    if (error) {
      evaluated.failures.push(`${errorPrefix}：${error}`);
      evaluated.passed = false;
    }
    return evaluated;
  });
}

function evaluateCase(item: EvalCase, plan: AgentPlanLike, options: { plannerMode?: PlannerEvalMode } = {}): CaseEvaluation {
  const failures: string[] = [];
  const tools = (plan.steps ?? []).map((step) => step.tool).filter(Boolean) as string[];
  const planText = JSON.stringify(plan);
  const checks = createPassingChecks();
  checks.intentAccuracy = plan.taskType === item.expected.taskType;
  checks.idHallucinationRate = !(item.expected.forbidInventedIds && hasInventedId(plan));
  checks.firstPlanSuccessRate = Boolean(plan.taskType && (plan.steps ?? []).length);
  checks.userVisibleClarity = hasUserVisiblePlan(plan);
  const observations: Partial<Record<EvalMetricKey, number>> = {};

  if (!checks.intentAccuracy) failures.push(`taskType 期望 ${item.expected.taskType}，实际 ${plan.taskType ?? '空'}`);
  for (const tool of item.expected.mustUseTools ?? []) {
    if (!tools.includes(tool)) {
      checks.toolPlanAccuracy = false;
      failures.push(`缺少工具 ${tool}`);
    }
  }
  for (const tool of item.expected.mustNotUseTools ?? []) {
    if (tools.includes(tool)) {
      checks.toolPlanAccuracy = false;
      failures.push(`不应使用工具 ${tool}`);
    }
  }
  for (const expectation of item.expected.mustMatchStepArgs ?? []) {
    const step = (plan.steps ?? []).find((item) => item.tool === expectation.tool);
    if (!step) {
      checks.requiredParamCompletion = false;
      failures.push(`missing step args target ${expectation.tool}`);
      continue;
    }
    const args = asRecord(step.args);
    if (expectation.args && !recordContainsSubset(args, expectation.args)) {
      checks.requiredParamCompletion = false;
      failures.push(`step ${expectation.tool} args do not include ${JSON.stringify(expectation.args)}`);
    }
    for (const key of expectation.mustHaveKeys ?? []) {
      if (!hasNestedKey(args, key)) {
        checks.requiredParamCompletion = false;
        failures.push(`step ${expectation.tool} args missing key ${key}`);
      }
    }
    for (const key of expectation.mustNotHaveKeys ?? []) {
      if (hasNestedKey(args, key)) {
        checks.requiredParamCompletion = false;
        failures.push(`step ${expectation.tool} args should not include key ${key}`);
      }
    }
  }
  for (const keyword of item.expected.mustContainInstruction ?? []) if (!planText.includes(keyword)) failures.push(`缺少约束/关键词 ${keyword}`);
  for (const field of item.expected.mustHaveMissingInfo ?? []) {
    if (!(plan.missingInfo ?? []).some((info) => `${info.field ?? ''} ${info.reason ?? ''}`.toLowerCase().includes(field.toLowerCase()))) {
      checks.requiredParamCompletion = false;
      failures.push(`missingInfo 未包含 ${field}`);
    }
  }
  const approval = Boolean(plan.riskReview?.requiresApproval || (plan.steps ?? []).some((step) => step.requiresApproval));
  if (item.expected.mustRequireApproval !== undefined && approval !== item.expected.mustRequireApproval) {
    checks.approvalSafety = false;
    failures.push(`审批要求期望 ${item.expected.mustRequireApproval}，实际 ${approval}`);
  }
  if (!checks.idHallucinationRate) failures.push('ID 幻觉：发现自然语言或伪造 ID 直接进入 *.Id 参数');
  checks.resolverUsageRate = expectedResolverTools(item).every((tool) => tools.includes(tool));
  if (!checks.resolverUsageRate) failures.push(`Resolver 使用不足：期望 ${expectedResolverTools(item).join(', ')}`);
  evaluatePlannerGraphDiagnostics(item, plan, tools, checks, observations, failures, options);
  return { id: item.id, passed: failures.length === 0, checks, observations, failures };
}

function evaluateRetrievalCase(item: EvalCase, output: RetrievalEvalOutput): CaseEvaluation {
  const expected = item.expected.retrieval;
  const failures: string[] = [];
  const dimensions = output.diagnostics?.retrievalDimensions ?? [];
  const missingContextCount = output.diagnostics?.missingContext?.length ?? 0;
  const checks = createPassingChecks();
  if (!expected) return { id: item.id, passed: true, checks, failures };

  for (const dimension of expected.mustUseDimensions ?? []) {
    if (!dimensions.includes(dimension)) failures.push(`检索维度缺少 ${dimension}`);
  }
  if (expected.mustIncludeFullDraft !== undefined && Boolean(output.diagnostics?.fullDraftIncluded) !== expected.mustIncludeFullDraft) failures.push(`完整草稿召回期望 ${expected.mustIncludeFullDraft}`);
  if ((output.plotEvents?.length ?? 0) < (expected.minPlotEvents ?? 0)) failures.push(`剧情事件数量不足：${output.plotEvents?.length ?? 0}`);
  if ((output.relationshipGraph?.length ?? 0) < (expected.minRelationshipEdges ?? 0)) failures.push(`关系图边数量不足：${output.relationshipGraph?.length ?? 0}`);
  const relationshipEdges = (output.relationshipGraph ?? []).map((edge) => asRecord(edge));
  if (relationshipEdges.filter((edge) => edge.conflict === true || edge.relationType === 'conflict').length < (expected.minConflictRelationshipEdges ?? 0)) failures.push('冲突关系边数量不足');
  for (const field of expected.requiredRelationshipEdgeFields ?? []) {
    if (!relationshipEdges.some((edge) => hasNestedField(edge, field))) failures.push(`关系边字段缺少 ${field}`);
  }
  if ((output.worldFacts?.length ?? 0) < (expected.minWorldFacts ?? 0)) failures.push(`世界观事实数量不足：${output.worldFacts?.length ?? 0}`);
  for (const entityType of expected.minWorldEntityTypes ?? []) {
    const hasEntityType = (output.worldFacts ?? []).some((fact) => asRecord(fact).entityType === entityType);
    if (!hasEntityType) failures.push(`世界观实体类型缺少 ${entityType}`);
  }
  const lockedWorldFactCount = (output.worldFacts ?? []).filter((fact) => asRecord(fact).locked === true).length;
  if (lockedWorldFactCount < (expected.minLockedWorldFacts ?? 0)) failures.push(`locked facts 数量不足：${lockedWorldFactCount}`);
  if ((output.memoryChunks?.length ?? 0) < (expected.minMemoryChunks ?? 0)) failures.push(`记忆片段数量不足：${output.memoryChunks?.length ?? 0}`);
  if (missingContextCount > (expected.maxMissingContext ?? Number.POSITIVE_INFINITY)) failures.push(`缺失上下文过多：${missingContextCount}`);
  const plotEvidence = asRecord(asRecord(output.plotConsistencyReport).evidence);
  for (const field of expected.requirePlotEvidenceFields ?? []) {
    if (!hasNestedField(plotEvidence, field)) failures.push(`剧情一致性 evidence 缺少 ${field}`);
  }
  const characterEvidence = (asRecord(output.characterConsistencyReport).currentEvidence ?? []) as unknown[];
  for (const keyword of expected.requireCharacterEvidenceKeywords ?? []) {
    if (!characterEvidence.some((item) => String(item).includes(keyword))) failures.push(`角色一致性证据缺少关键词 ${keyword}`);
  }
  if (expected.requireWorldbuildingValidationComparison) {
    const validation = asRecord(output.worldbuildingValidationReport);
    if (!Array.isArray(validation.relatedLockedFacts) || !validation.relatedLockedFacts.length) failures.push('世界观校验缺少 relatedLockedFacts 对比字段');
    if (!asRecord(validation.writePreview).summary) failures.push('世界观校验缺少 writePreview.summary');
  }
  if (expected.requireWorldbuildingPersistAudit) {
    const persist = asRecord(output.worldbuildingPersistResult);
    if (!Array.isArray(persist.perEntryAudit) || !persist.perEntryAudit.length) failures.push('世界观写入结果缺少 perEntryAudit');
  }

  checks.retrievalDimensionCoverage = failures.length === 0;
  return { id: item.id, passed: failures.length === 0, checks, failures };
}

function evaluatePlannerGraphDiagnostics(
  item: EvalCase,
  plan: AgentPlanLike,
  tools: string[],
  checks: Record<EvalMetricKey, boolean | undefined>,
  observations: Partial<Record<EvalMetricKey, number>>,
  failures: string[],
  options: { plannerMode?: PlannerEvalMode },
) {
  const diagnostics = asRecord(plan.plannerDiagnostics);
  const graphRequired = options.plannerMode === 'graph';
  const expectedRoute = item.expected.route;
  if (expectedRoute) {
    const route = asRecord(diagnostics.route);
    const routeAvailable = typeof route.domain === 'string';
    if (!routeAvailable) {
      checks.routeAccuracy = graphRequired ? false : undefined;
      if (graphRequired) failures.push('缺少 graph route diagnostics');
    } else {
      checks.routeAccuracy = route.domain === expectedRoute.domain && (!expectedRoute.intent || route.intent === expectedRoute.intent);
      if (!checks.routeAccuracy) failures.push(`route 期望 ${expectedRoute.domain}:${expectedRoute.intent ?? '*'}，实际 ${String(route.domain)}:${String(route.intent ?? '')}`);
    }
  }

  if (item.expected.bundle) {
    const toolBundle = asRecord(diagnostics.toolBundle);
    const actualBundle = textOrUndefined(toolBundle.name);
    if (!actualBundle) {
      checks.bundleAccuracy = graphRequired ? false : undefined;
      if (graphRequired) failures.push('缺少 graph toolBundle diagnostics');
    } else {
      checks.bundleAccuracy = actualBundle === item.expected.bundle;
      if (!checks.bundleAccuracy) failures.push(`toolBundle 期望 ${item.expected.bundle}，实际 ${actualBundle}`);
    }
  }

  const allowedToolNames = stringArray(diagnostics.allowedToolNames);
  if (allowedToolNames.length) {
    const allowed = new Set(allowedToolNames);
    const leakedTools = tools.filter((tool) => !allowed.has(tool));
    checks.bundleToolLeakRate = leakedTools.length === 0;
    if (leakedTools.length) failures.push(`bundle 外工具泄漏：${[...new Set(leakedTools)].join(', ')}`);
  } else if (graphRequired && item.expected.bundle) {
    checks.bundleToolLeakRate = false;
    failures.push('缺少 bundle allowedToolNames diagnostics');
  }

  const promptBudget = asRecord(diagnostics.promptBudget);
  const allToolsChars = numberOrUndefined(promptBudget.allToolsChars);
  const selectedToolsChars = numberOrUndefined(promptBudget.selectedToolsChars);
  if (allToolsChars && selectedToolsChars !== undefined) {
    const reduction = allToolsChars > 0 ? (allToolsChars - selectedToolsChars) / allToolsChars : 0;
    observations.promptReductionRate = roundRate(reduction);
    checks.promptReductionRate = reduction > 0;
    if (!checks.promptReductionRate) failures.push(`selected tools prompt 未缩小：all=${allToolsChars} selected=${selectedToolsChars}`);
  } else if (graphRequired && item.expected.bundle) {
    checks.promptReductionRate = false;
    failures.push('缺少 promptBudget diagnostics');
  }
}

function createPassingChecks(): Record<EvalMetricKey, boolean | undefined> {
  return {
    intentAccuracy: true,
    toolPlanAccuracy: true,
    requiredParamCompletion: true,
    idHallucinationRate: true,
    resolverUsageRate: true,
    approvalSafety: true,
    firstPlanSuccessRate: true,
    userVisibleClarity: true,
    retrievalDimensionCoverage: true,
    routeAccuracy: undefined,
    bundleAccuracy: undefined,
    bundleToolLeakRate: undefined,
    promptReductionRate: undefined,
  };
}

function hasInventedId(plan: AgentPlanLike): boolean {
  const values: unknown[] = [];
  for (const step of plan.steps ?? []) collectIdValues(step.args, values);
  return values.some((value) => typeof value === 'string' && !value.startsWith('{{') && !looksLikeUuid(value));
}

function collectIdValues(value: unknown, bucket: unknown[], pathParts: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIdValues(item, bucket, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...pathParts, key];
    if (/(^id$|Id$)/.test(key)) bucket.push(child);
    collectIdValues(child, bucket, nextPath);
  }
}

function readPlan(caseId: string, dir: string): AgentPlanLike {
  const fullPath = path.resolve(process.cwd(), dir, `${caseId}.json`);
  if (!fs.existsSync(fullPath)) return {};
  return normalizePlan(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
}

/** 兼容纯 Plan、API createPlan 响应、完整 AgentRun 响应和 agent_plan_preview Artifact，便于直接评测真实 Planner 导出。 */
function normalizePlan(value: unknown): AgentPlanLike {
  const record = asRecord(value);
  if (record.taskType || record.steps) return record as AgentPlanLike;
  const plan = asRecord(record.plan);
  if (plan.taskType || plan.steps) return { ...plan, steps: Array.isArray(plan.steps) ? plan.steps as AgentPlanLike['steps'] : [] } as AgentPlanLike;
  const plans = Array.isArray(record.plans) ? record.plans : [];
  const latestPlan = asRecord(plans[0]);
  if (latestPlan.taskType || latestPlan.steps) return { ...latestPlan, steps: Array.isArray(latestPlan.steps) ? latestPlan.steps as AgentPlanLike['steps'] : [] } as AgentPlanLike;
  const artifact = (Array.isArray(record.artifacts) ? record.artifacts : [])
    .map((item) => asRecord(item))
    .find((item) => item.artifactType === 'agent_plan_preview');
  return asRecord(artifact?.content) as AgentPlanLike;
}

function buildReport(
  results: CaseEvaluation[],
  sourcePlansDir: string,
  sourceMode: EvalReport['sourceMode'],
  plannerMode?: PlannerEvalMode,
  comparedReports?: EvalReport[],
  promptSizeGates?: PromptSizeGateResult[],
): EvalReport {
  const metrics = Object.fromEntries(metricKeys().map((key) => {
    return [key, buildMetric(key, results)];
  })) as EvalReport['metrics'];
  return {
    generatedAt: new Date().toISOString(),
    casesPath,
    plansDir: path.resolve(process.cwd(), sourcePlansDir),
    sourceMode,
    plannerMode,
    totalCases: results.length,
    passedCases: results.filter((item) => item.passed).length,
    metrics,
    failures: results.filter((item) => item.failures.length).map((item) => ({ id: item.id, failures: item.failures })),
    ...(comparedReports?.length ? { comparedReports } : {}),
    ...(promptSizeGates?.length ? { promptSizeGates } : {}),
  };
}

function buildMetric(key: EvalMetricKey, results: CaseEvaluation[]): EvalMetric {
  if (key === 'promptReductionRate') {
    const applicable = results.filter((result) => result.checks.promptReductionRate !== undefined || result.observations?.promptReductionRate !== undefined);
    const values = applicable.map((result) => result.observations?.promptReductionRate ?? 0);
    return {
      passed: applicable.filter((result) => result.checks.promptReductionRate).length,
      total: applicable.length,
      rate: values.length ? roundRate(values.reduce((total, value) => total + value, 0) / values.length) : 0,
    };
  }

  const applicable = results.filter((result) => result.checks[key] !== undefined);
  const passed = applicable.filter((result) => result.checks[key]).length;
  if (key === 'bundleToolLeakRate') {
    return {
      passed,
      total: applicable.length,
      rate: applicable.length ? roundRate((applicable.length - passed) / applicable.length) : 0,
    };
  }
  return {
    passed,
    total: applicable.length,
    rate: applicable.length ? roundRate(passed / applicable.length) : 0,
  };
}

/**
 * Live Planner Eval：通过 Nest TestingModule 构造真实 AgentPlannerService，
 * 同时用可控 LLM 和工具注册表隔离网络、数据库和副作用，专门验证 Planner 规范化、质量管线和 Eval 指标链路。
 */
async function runLivePlannerEval(options: { realLlm?: boolean; sampleSize?: number; plannerMode?: PlannerEvalMode } = {}): Promise<LivePlanResult[]> {
  const plannerMode = options.plannerMode ?? 'legacy';
  const toolRegistry = new EvalToolRegistry();
  const moduleRef = await Test.createTestingModule({
    imports: options.realLlm ? [PrismaModule] : [],
    providers: [
      AgentPlannerService,
      SkillRegistryService,
      RuleEngineService,
      PlanValidatorService,
      { provide: ToolRegistryService, useValue: toolRegistry },
      { provide: LlmGatewayService, useClass: options.realLlm ? LlmGatewayService : EvalLlmGatewayMock },
      ...(options.realLlm ? [LlmProvidersService] : []),
    ],
  }).compile();
  const prisma = options.realLlm ? moduleRef.get(PrismaService) : undefined;
  if (options.realLlm) {
    // 真实 LLM 抽样复用项目 LLM 配置模块：优先读取 llmRouting(agent_planner) / 默认 Provider，再退回环境变量。
    // 这里显式触发初始化，确保 TestingModule 下不会跳过 LlmProvidersService 的 DB 配置快照加载。
    await moduleRef.get(LlmProvidersService).onModuleInit();
  }
  const planner = moduleRef.get(AgentPlannerService);
  const supervisor = new RootSupervisor();
  const bundleRegistry = new ToolBundleRegistry(toolRegistry as unknown as ToolRegistryService);
  const results: LivePlanResult[] = [];
  const selectedCases = options.realLlm
    ? cases.slice(0, Math.max(1, Math.min(options.sampleSize ?? 3, cases.length)))
    : plannerMode === 'graph'
      ? cases.filter(hasGraphPlannerExpectation)
      : cases;

  for (const item of selectedCases) {
    try {
      const context = buildEvalContext(item, toolRegistry);
      if (plannerMode === 'graph') {
        const route = supervisor.classify({ goal: item.message, context });
        const selectedBundle = context.session.guided?.currentStep
          ? bundleRegistry.resolveBundle('guided.step')
          : bundleRegistry.resolveForRoute(route);
        const selectedTools = bundleRegistry.listManifestsForBundle(selectedBundle);
        const allTools = toolRegistry.listManifestsForPlanner();
        const plan = await planner.createPlanWithTools({
          goal: item.message,
          context,
          route,
          selectedBundle,
          selectedTools,
        });
        results.push({
          case: item,
          plan: withGraphEvalDiagnostics(normalizePlan(plan), route, selectedBundle, selectedTools, allTools),
          plannerMode,
        });
      } else {
        const plan = await planner.createPlan(item.message, context);
        results.push({ case: item, plan: normalizePlan(plan), plannerMode });
      }
    } catch (error) {
      results.push({ case: item, plan: {}, error: error instanceof Error ? error.message : String(error), plannerMode });
    }
  }

  if (prisma) await prisma.$disconnect();
  await moduleRef.close();
  return results;
}

function hasGraphPlannerExpectation(item: EvalCase): boolean {
  return Boolean(item.expected.route || item.expected.bundle);
}

function withGraphEvalDiagnostics(
  plan: AgentPlanLike,
  route: RouteDecision,
  selectedBundle: SelectedToolBundle,
  selectedTools: ToolManifestForPlanner[],
  allTools: ToolManifestForPlanner[],
): AgentPlanLike {
  const selectedToolsChars = JSON.stringify(selectedTools).length;
  const allToolsChars = JSON.stringify(allTools).length;
  const diagnostics = asRecord(plan.plannerDiagnostics);
  return {
    ...plan,
    plannerDiagnostics: {
      ...diagnostics,
      route: {
        ...asRecord(diagnostics.route),
        domain: route.domain,
        intent: route.intent,
        confidence: route.confidence,
      },
      toolBundle: {
        ...asRecord(diagnostics.toolBundle),
        name: selectedBundle.bundleName,
        selectedToolCount: selectedTools.length,
        allToolCount: allTools.length,
      },
      selectedToolNames: selectedTools.map((tool) => tool.name),
      allowedToolNames: [...new Set([...selectedBundle.strictToolNames, ...selectedBundle.optionalToolNames])],
      promptBudget: {
        selectedToolsChars,
        allToolsChars,
        promptReductionRate: allToolsChars ? roundRate((allToolsChars - selectedToolsChars) / allToolsChars) : 0,
      },
    },
  };
}

function evaluatePromptSizeGates(): PromptSizeGateResult[] {
  const toolRegistry = new EvalToolRegistry();
  const supervisor = new RootSupervisor();
  const bundleRegistry = new ToolBundleRegistry(toolRegistry as unknown as ToolRegistryService);
  const allTools = toolRegistry.listManifestsForPlanner();
  const allToolsChars = JSON.stringify(allTools).length;

  return PROMPT_SIZE_GATES.map((gate) => {
    const item = cases.find((candidate) => candidate.id === gate.caseId);
    if (!item) {
      return {
        id: gate.id,
        caseId: gate.caseId,
        bundleName: gate.expectedBundle,
        selectedToolCount: 0,
        allToolCount: allTools.length,
        selectedToolsChars: 0,
        allToolsChars,
        selectedToAllRatio: 1,
        maxSelectedToAllRatio: gate.maxSelectedToAllRatio,
        passed: false,
        failure: `Prompt size gate case not found: ${gate.caseId}`,
      };
    }
    const context = buildEvalContext(item, toolRegistry);
    const route = supervisor.classify({ goal: item.message, context });
    const selectedBundle = context.session.guided?.currentStep
      ? bundleRegistry.resolveBundle('guided.step')
      : bundleRegistry.resolveForRoute(route);
    const selectedTools = bundleRegistry.listManifestsForBundle(selectedBundle);
    const selectedToolsChars = JSON.stringify(selectedTools).length;
    const ratio = allToolsChars ? selectedToolsChars / allToolsChars : 1;
    const wrongBundle = selectedBundle.bundleName !== gate.expectedBundle;
    const tooLarge = ratio > gate.maxSelectedToAllRatio;
    return {
      id: gate.id,
      caseId: gate.caseId,
      bundleName: selectedBundle.bundleName,
      selectedToolCount: selectedTools.length,
      allToolCount: allTools.length,
      selectedToolsChars,
      allToolsChars,
      selectedToAllRatio: roundRate(ratio),
      maxSelectedToAllRatio: gate.maxSelectedToAllRatio,
      passed: !wrongBundle && !tooLarge,
      ...(wrongBundle ? { failure: `expected bundle ${gate.expectedBundle}, got ${selectedBundle.bundleName}` } : tooLarge ? { failure: `selected tools ratio ${roundRate(ratio)} exceeds ${gate.maxSelectedToAllRatio}` } : {}),
    };
  });
}

async function createPlannerPromptBaselineReport(caseId?: string): Promise<PromptBaselineReport> {
  const toolRegistry = new EvalToolRegistry();
  const llm = new PromptCaptureLlmGatewayMock();
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentPlannerService,
      SkillRegistryService,
      RuleEngineService,
      { provide: ToolRegistryService, useValue: toolRegistry },
      { provide: LlmGatewayService, useValue: llm },
    ],
  }).compile();

  try {
    const planner = moduleRef.get(AgentPlannerService);
    const item = selectPromptBaselineCase(caseId);
    await planner.createPlan(item.message, buildEvalContext(item, toolRegistry));
    const messages = llm.capturedCalls[0];
    if (!messages) throw new Error('Planner prompt baseline capture failed: no LLM messages captured');
    const userPayload = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const payload = parsePlannerPrompt(messages);
    const availableTools = Array.isArray(payload.availableTools) ? payload.availableTools : [];
    if (!availableTools.length) throw new Error('Planner prompt baseline capture failed: availableTools missing from user payload');

    return {
      generatedAt: new Date().toISOString(),
      sourceMode: 'planner_prompt_baseline',
      casesPath,
      caseId: item.id,
      userGoal: item.message,
      allToolCount: availableTools.length,
      availableToolsChars: JSON.stringify(availableTools).length,
      userPayloadChars: userPayload.length,
      systemChars: messages.filter((message) => message.role === 'system').reduce((total, message) => total + message.content.length, 0),
      totalChars: messages.reduce((total, message) => total + message.content.length, 0),
      messageCount: messages.length,
      availableToolNames: availableTools.map((tool) => textOrUndefined(asRecord(tool).name)).filter((name): name is string => Boolean(name)),
    };
  } finally {
    await moduleRef.close();
  }
}

function selectPromptBaselineCase(caseId?: string): EvalCase {
  const item = caseId ? cases.find((candidate) => candidate.id === caseId) : cases[0];
  if (!item) throw new Error(`Prompt baseline eval case not found: ${caseId}`);
  return item;
}

/** Retrieval Eval 直接驱动真实 collect_task_context；Prisma 使用确定性内存 Mock，避免依赖本地数据库状态。 */
async function createRealRetrievalOutput(item: EvalCase): Promise<{ item: EvalCase; output?: RetrievalEvalOutput; error?: string }> {
  if (!item.expected.retrieval) return { item, output: {} };
  const session = asRecord(asRecord(item.context).session);
  const projectId = textOrUndefined(session.currentProjectId) ?? 'project_1';
  const tool = new CollectTaskContextTool(createRetrievalEvalPrisma(item) as never);
  try {
    const context = { agentRunId: `retrieval_eval_${item.id}`, projectId, chapterId: textOrUndefined(session.currentChapterId), mode: 'plan' as const, approved: false, outputs: {}, policy: {} };
    const output = await tool.run(buildRetrievalToolArgs(item), context);
    const enrichedOutput = await enrichRetrievalEvalOutput(item, output, context, createRetrievalEvalPrisma(item));
    return { item, output: enrichedOutput };
  } catch (error) {
    return { item, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retrieval Eval 在真实 collect_task_context 输出之上，按需串联只读检查/校验工具，
 * 让关系图字段、剧情/角色 evidence、世界观对比和条目级审计也进入可回归指标。
 */
async function enrichRetrievalEvalOutput(item: EvalCase, output: RetrievalEvalOutput, context: { agentRunId: string; projectId: string; chapterId?: string; mode: 'plan'; approved: boolean; outputs: Record<string, unknown>; policy: Record<string, unknown> }, prisma: ReturnType<typeof createRetrievalEvalPrisma>): Promise<RetrievalEvalOutput> {
  const expected = item.expected.retrieval;
  if (!expected) return output;
  const enriched: RetrievalEvalOutput = { ...output };

  if (expected.requirePlotEvidenceFields?.length) {
    enriched.plotConsistencyReport = await new PlotConsistencyCheckTool().run({ taskContext: output as Record<string, unknown>, instruction: item.message }, context);
  }
  if (expected.requireCharacterEvidenceKeywords?.length) {
    enriched.characterConsistencyReport = await new CharacterConsistencyCheckTool().run({ characterId: 'char_protagonist', taskContext: output as Record<string, unknown>, instruction: item.message }, context);
  }
  if (expected.requireWorldbuildingValidationComparison || expected.requireWorldbuildingPersistAudit) {
    const preview = buildWorldbuildingEvalPreview();
    const validation = await new ValidateWorldbuildingTool(prisma as never).run({ preview, taskContext: output as Record<string, unknown> }, context);
    enriched.worldbuildingValidationReport = validation;
    if (expected.requireWorldbuildingPersistAudit) {
      enriched.worldbuildingPersistResult = await new PersistWorldbuildingTool(createPersistEvalPrisma() as never, createEvalCacheService() as never).run({ preview, validation, selectedTitles: ['青云宗', '新宗门戒律'] }, { ...context, mode: 'act', approved: true });
    }
  }
  return enriched;
}

/** 构造可通过 deterministic 校验的世界观预览，用于覆盖 validate/persist 的 diff 与审计字段。 */
function buildWorldbuildingEvalPreview() {
  return {
    entries: [
      { title: '青云宗', entryType: 'faction', summary: '已有宗门补充', content: '沿用既有青云宗设定，只补充旁支。', tags: ['宗门'], priority: 50, impactAnalysis: '沿用既有设定边界，仅补充旁支说明。', relatedExistingFacts: ['青云宗'], lockedFactHandling: '遵守 locked facts' },
      { title: '新宗门戒律', entryType: 'rule', summary: '新增规则', content: '公开裁决可作为同门冲突例外。', tags: ['宗门'], priority: 70, impactAnalysis: '围绕宗门戒律做增量例外说明，不影响既有剧情。', relatedExistingFacts: ['宗门戒律'], lockedFactHandling: '遵守 locked facts' },
      { title: '山门巡夜制度', entryType: 'setting', summary: '备选制度', content: '巡夜制度作为备选，不在本次写入。', tags: ['宗门'], priority: 40, impactAnalysis: '备选制度，不影响主线。', relatedExistingFacts: [], lockedFactHandling: '遵守既有边界' },
    ],
    assumptions: ['只做 Eval 预览'],
    risks: [],
    writePlan: { mode: 'preview_only' as const, requiresValidation: true, requiresApprovalBeforePersist: true },
  };
}

function createEvalCacheService() {
  return {
    async deleteProjectRecallResults() {
      return 0;
    },
  };
}

function createPersistEvalPrisma() {
  const createdData: Array<Record<string, unknown>> = [];
  return {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback({
        lorebookEntry: {
          async findMany() { return [{ title: '青云宗' }]; },
          async create(args: { data: Record<string, unknown> }) {
            createdData.push(args.data);
            return { id: `eval_lore_${createdData.length}`, title: args.data.title, entryType: args.data.entryType };
          },
        },
      });
    },
  };
}

/** 根据用例语义模拟 resolver 后的 collect_task_context 入参，评测真实工具的检索行为而非 Planner 编排。 */
function buildRetrievalToolArgs(item: EvalCase): Record<string, unknown> {
  const session = asRecord(asRecord(item.context).session);
  const taskType = item.expected.taskType;
  const focusByTask: Record<string, string[]> = {
    chapter_revision: ['full_draft', 'plot_facts', 'validation_issues', 'memory_chunks'],
    chapter_polish: ['full_draft', 'style', 'memory_chunks'],
    character_consistency_check: ['character_arc', 'relationship_graph', 'memory_chunks'],
    plot_consistency_check: ['plot_facts', 'relationship_graph', 'world_facts', 'memory_chunks'],
    worldbuilding_expand: ['world_facts', 'plot_facts', 'memory_chunks', 'locked_world_facts'],
    story_bible_expand: ['world_facts', 'plot_facts', 'memory_chunks', 'locked_world_facts'],
    continuity_check: ['relationship_graph', 'plot_facts', 'world_facts', 'memory_chunks'],
  };
  const args: Record<string, unknown> = { projectId: textOrUndefined(session.currentProjectId) ?? 'project_1', taskType, focus: focusByTask[taskType] ?? ['plot_facts', 'memory_chunks'] };
  const entityRefs: Record<string, unknown> = {};
  if (taskType === 'character_consistency_check') args.characterId = 'char_protagonist';
  if (taskType === 'chapter_revision') args.chapterId = textOrUndefined(session.currentChapterId) ?? 'chapter_7';
  if (item.id === 'fuzzy_chapter_ref_010') {
    args.chapterId = 'chapter_7';
    args.focus = ['plot_facts', 'relationship_graph', 'memory_chunks'];
  }
  if (item.id === 'worldbuilding_expand_007') entityRefs.worldSettingRef = '宗门体系';
  if (item.id === 'longform_story_bible_expand_013') entityRefs.worldSettingRef = '灵脉禁制';
  if (item.id === 'longform_timeline_repair_015') entityRefs.chapterRange = '前九章';
  if (item.expected.retrieval?.mustIncludeFullDraft) entityRefs.includeFullDrafts = true;
  if (Object.keys(entityRefs).length) args.entityRefs = entityRefs;
  return args;
}

function createRetrievalEvalPrisma(item: EvalCase) {
  const expected = item.expected.retrieval ?? {};
  const projectId = textOrUndefined(asRecord(asRecord(item.context).session).currentProjectId) ?? 'project_1';
  const longDraft = '完整草稿内容'.repeat(600);
  return {
    project: { async findUnique() { return { id: projectId, title: 'Eval 测试项目', genre: '玄幻', theme: '成长', tone: '压迫', synopsis: '测试梗概', outline: '测试大纲', targetWordCount: 3000, status: 'active' }; } },
    chapter: { async findMany() { return Array.from({ length: Math.max(1, expected.minPlotEvents ?? 1) }, (_, index) => ({ id: `chapter_${index + 1}`, chapterNo: index + 1, title: index === 0 ? '师姐对峙' : `第${index + 1}章`, status: 'drafted', objective: '推进主线', conflict: '宗门压力升级', outline: '埋下玉佩伏笔并推进宗门冲突', drafts: [{ content: longDraft }] })); } },
    character: { async findMany() { return [{ id: 'char_protagonist', name: '林烬', alias: ['男主', '小林'], roleType: 'protagonist', personalityCore: '克制隐忍', motivation: '查明宗门旧案', speechStyle: '短句' }, { id: 'char_senior_sister', name: '沈怀舟', alias: ['师姐'], roleType: 'mentor', personalityCore: '谨慎', motivation: '守护宗门秘密', speechStyle: '冷静' }]; } },
    lorebookEntry: { async findMany() { return [{ id: 'world_faction', title: '青云宗', entryType: 'faction', summary: '宗门势力', content: '青云宗与旧盟约存在冲突。', status: 'active', priority: 90, createdAt: new Date() }, { id: 'world_rule', title: '宗门戒律', entryType: 'rule', summary: '制度规则', content: '同门不得私斗，公开裁决除外。', status: 'locked', priority: 80, createdAt: new Date() }, { id: 'world_location', title: '山门旧址', entryType: 'location', summary: '关键地点', content: '旧址埋藏历史事件证据。', status: 'active', priority: 70, createdAt: new Date() }, { id: 'world_item', title: '旧盟玉佩', entryType: 'item', summary: '关键物品', content: '玉佩是宗门旧盟约的物证。', status: 'active', priority: 65, createdAt: new Date() }, { id: 'world_history', title: '十年前旧案', entryType: 'history', summary: '历史事件', content: '十年前宗门分裂形成今日冲突。', status: 'active', priority: 60, createdAt: new Date() }, { id: 'world_relation', title: '青云宗与玄夜盟关系', entryType: 'relationship', summary: '势力关系', content: '双方由盟友转为敌对。', status: 'active', priority: 55, createdAt: new Date() }]; } },
    memoryChunk: { async findMany() { return Array.from({ length: Math.max(1, expected.minMemoryChunks ?? 1) }, (_, index) => ({ id: `memory_${index + 1}`, sourceType: 'chapter', sourceId: `chapter_${index + 1}`, memoryType: 'plot', summary: '宗门冲突记忆', content: '林烬与沈怀舟围绕宗门旧案产生对峙。', importanceScore: 80 - index, recencyScore: 70 - index })); } },
    validationIssue: { async findMany() { return []; } },
    characterStateSnapshot: { async findMany() { return [{ characterId: 'char_protagonist', characterName: '林烬', chapterNo: 7, stateType: 'emotion', stateValue: '压抑', summary: '强压怒意但仍保持克制' }]; } },
    storyEvent: { async findMany() { return Array.from({ length: Math.max(1, expected.minPlotEvents ?? 1) }, (_, index) => ({ id: `event_${index + 1}`, chapterId: `chapter_${index + 1}`, chapterNo: index + 1, title: index === 0 ? '师姐对峙' : `宗门事件${index + 1}`, eventType: 'conflict', description: '林烬和沈怀舟在宗门旧址对峙，暴露旧盟约冲突。', participants: [{ name: '林烬' }, { name: '沈怀舟' }], status: 'detected', createdAt: new Date() })); } },
  };
}

/** 构造最小 AgentContextV2，让真实 Planner 能看到 session、项目摘要和压缩 Tool Manifest。 */
function buildEvalContext(item: EvalCase, toolRegistry: EvalToolRegistry): AgentContextV2 {
  const raw = asRecord(item.context);
  const session = asRecord(raw.session);
  const currentProjectId = textOrUndefined(session.currentProjectId);
  const currentChapterId = textOrUndefined(session.currentChapterId);
  const currentDraftId = textOrUndefined(session.currentDraftId);
  const currentChapterIndex = typeof session.currentChapterIndex === 'number' ? session.currentChapterIndex : undefined;
  const requestedAssetTypes = importAssetTypesValue(session.requestedAssetTypes);
  const importPreviewMode = importPreviewModeValue(session.importPreviewMode);
  const guided = asRecord(session.guided);
  const guidedContext = Object.keys(guided).length
    ? {
        currentStep: textOrUndefined(guided.currentStep),
        currentStepLabel: textOrUndefined(guided.currentStepLabel),
        currentStepData: asRecord(guided.currentStepData),
      }
    : undefined;
  return {
    schemaVersion: 2,
    userMessage: item.message,
    runtime: { mode: 'plan', agentRunId: `eval_${item.id}`, locale: 'zh-CN', timezone: 'Asia/Shanghai', maxSteps: 20, maxLlmCalls: 2 },
    session: {
      currentProjectId,
      currentChapterId,
      currentDraftId,
      currentChapterIndex,
      selectedText: textOrUndefined(session.selectedText),
      ...(requestedAssetTypes.length ? { requestedAssetTypes } : {}),
      ...(importPreviewMode ? { importPreviewMode } : {}),
      ...(guidedContext ? { guided: guidedContext } : {}),
    },
    attachments: [],
    project: currentProjectId ? { id: currentProjectId, title: 'Eval 测试项目', defaultWordCount: 3000, status: 'active' } : undefined,
    currentChapter: currentChapterId ? { id: currentChapterId, title: '当前章节', index: currentChapterIndex ?? 1, status: 'draft', draftId: currentDraftId } : undefined,
    recentChapters: [],
    knownCharacters: [
      { id: 'char_protagonist', name: '林烬', role: 'protagonist', aliases: ['男主', '小林'] },
      { id: 'char_senior_sister', name: '沈怀舟', role: 'supporting', aliases: ['师姐'] },
    ],
    worldFacts: [{ id: 'world_fact_1', type: 'faction', title: '宗门体系', content: '宗门制度不可覆盖既有剧情。' }],
    memoryHints: [],
    constraints: {
      hardRules: ['Eval 场景禁止编造内部 ID。'],
      styleRules: [],
      approvalRules: ['写入类步骤必须等待审批。'],
      idPolicy: ['自然语言引用必须通过 resolver 或 context 引用。'],
    },
    availableTools: toolRegistry.listManifestsForPlanner(),
  };
}

/**
 * Eval 专用工具注册表：只提供 Planner 所需的 Tool 元数据和 Manifest，
 * 不运行真实 Tool，避免 live planner 评测误触数据库、草稿写入或外部服务。
 */
class EvalToolRegistry {
  private readonly tools = new Map<string, BaseTool>();

  constructor() {
    for (const definition of EVAL_TOOL_DEFINITIONS) this.register(createEvalTool(definition));
  }

  register(tool: BaseTool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  list(): BaseTool[] {
    return [...this.tools.values()];
  }

  /** 返回与生产 ToolRegistry 同结构的压缩 Manifest，保证 Planner Prompt 入口一致。 */
  listManifestsForPlanner(toolNames?: string[]): ToolManifestForPlanner[] {
    const tools = toolNames?.length
      ? [...new Set(toolNames)].map((name) => {
          const tool = this.get(name);
          if (!tool) throw new Error(`EvalToolRegistry missing requested tool: ${name}`);
          return tool;
        })
      : this.list();
    return tools.map((tool) => ({
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      whenToUse: tool.manifest?.whenToUse ?? [`需要 ${tool.name} 能力时使用。`],
      whenNotToUse: tool.manifest?.whenNotToUse ?? [],
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
      idPolicy: tool.manifest?.idPolicy,
    }));
  }
}

type EvalToolDefinition = { name: string; description: string; requiresApproval?: boolean; riskLevel?: ToolRiskLevel; sideEffects?: string[] };

const EVAL_TOOL_DEFINITIONS: EvalToolDefinition[] = [
  { name: 'resolve_chapter', description: '解析自然语言章节引用。' },
  { name: 'resolve_character', description: '解析自然语言角色引用。' },
  { name: 'collect_chapter_context', description: '收集章节写作或修改上下文。' },
  { name: 'collect_task_context', description: '收集检查类、世界观类任务上下文。' },
  { name: 'inspect_project_context', description: '巡检项目、大纲和资产现状。' },
  { name: 'read_source_document', description: '读取导入源文档。' },
  { name: 'character_consistency_check', description: '只读检查角色一致性。' },
  { name: 'plot_consistency_check', description: '只读检查大纲矛盾、事件顺序、伏笔回收和角色动机断裂。' },
  { name: 'ai_quality_review', description: '只读审稿并输出质量问题清单。' },
  { name: 'generate_worldbuilding_preview', description: '生成世界观扩展预览。' },
  { name: 'validate_worldbuilding', description: '校验世界观候选和写入前 diff。' },
  { name: 'persist_worldbuilding', description: '审批后追加写入世界观。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_lorebook_entry'] },
  { name: 'generate_story_bible_preview', description: '生成 Story Bible 设定扩展预览。' },
  { name: 'validate_story_bible', description: '校验 Story Bible 候选和写入前 diff。' },
  { name: 'persist_story_bible', description: '审批后写入 Story Bible 设定资产。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_lorebook_entries', 'update_lorebook_entries', 'fact_layer_story_bible_write'] },
  { name: 'generate_continuity_preview', description: '生成关系线和时间线连续性变更预览。' },
  { name: 'validate_continuity_changes', description: '校验关系线和时间线候选变更。' },
  { name: 'persist_continuity_changes', description: '审批后写入关系线和时间线连续性变更。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_relationship_edge', 'update_relationship_edge', 'delete_relationship_edge', 'create_timeline_event', 'update_timeline_event', 'delete_timeline_event', 'fact_layer_continuity_write'] },
  { name: 'generate_timeline_preview', description: '从大纲、细纲或 Chapter.craftBrief 生成只读计划时间线候选。' },
  { name: 'align_chapter_timeline_preview', description: '从章节 StoryEvent 证据对齐计划时间线并生成只读确认候选。' },
  { name: 'validate_timeline_preview', description: '校验时间线候选字段、章节引用、sourceTrace 和写入前 diff。' },
  { name: 'persist_timeline_events', description: '审批后写入已校验的时间线候选。', requiresApproval: true, riskLevel: 'high', sideEffects: ['create_timeline_event', 'update_timeline_event', 'delete_timeline_event'] },
  { name: 'generate_guided_step_preview', description: '生成创作引导当前步骤的结构化预览或问答建议。' },
  { name: 'validate_guided_step_preview', description: '校验创作引导当前步骤预览，不写入业务表。' },
  { name: 'persist_guided_step_result', description: '审批后保存创作引导当前步骤结果。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['update_guided_session'] },
  { name: 'generate_outline_preview', description: '生成大纲拆分预览。' },
  { name: 'generate_volume_outline_preview', description: '生成卷级大纲预览。' },
  { name: 'generate_chapter_outline_preview', description: '生成单章细纲预览。' },
  { name: 'merge_chapter_outline_previews', description: '合并多章细纲预览。' },
  { name: 'validate_outline', description: '校验大纲预览。' },
  { name: 'persist_outline', description: '审批后持久化大纲。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_outline'] },
  { name: 'persist_volume_outline', description: '审批后持久化卷级大纲。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['upsert_volume_outline'] },
  { name: 'generate_chapter_craft_brief_preview', description: '生成 Chapter.craftBrief 推进卡预览。' },
  { name: 'validate_chapter_craft_brief', description: '校验 Chapter.craftBrief 推进卡预览。' },
  { name: 'persist_chapter_craft_brief', description: '审批后持久化 Chapter.craftBrief。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['update_chapter_craft_brief'] },
  { name: 'list_scene_cards', description: '列出当前章节或项目的场景卡。' },
  { name: 'generate_scene_cards_preview', description: '生成场景卡预览。' },
  { name: 'validate_scene_cards', description: '校验场景卡预览。' },
  { name: 'persist_scene_cards', description: '审批后持久化新场景卡。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_scene_cards'] },
  { name: 'update_scene_card', description: '审批后更新指定场景卡。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['update_scene_card'] },
  { name: 'analyze_source_text', description: '分析导入文案。' },
  { name: 'build_import_preview', description: '构建导入预览。' },
  { name: 'build_import_brief', description: 'Build a shared import brief before targeted import preview tools.' },
  { name: 'generate_import_project_profile_preview', description: 'Generate project profile import preview for selected import targets.' },
  { name: 'generate_import_outline_preview', description: 'Generate outline, volume, and chapter import preview for selected import targets.' },
  { name: 'generate_import_characters_preview', description: 'Generate character import preview for selected import targets.' },
  { name: 'generate_import_worldbuilding_preview', description: 'Generate worldbuilding import preview for selected import targets.' },
  { name: 'generate_import_writing_rules_preview', description: 'Generate writing rules import preview for selected import targets.' },
  { name: 'merge_import_previews', description: 'Merge selected target import previews into one import preview.' },
  { name: 'cross_target_consistency_check', description: 'Check merged or fallback import preview consistency before validation.' },
  { name: 'validate_imported_assets', description: '校验导入资产。' },
  { name: 'persist_project_assets', description: '审批后持久化项目资产。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_project_assets'] },
  { name: 'write_chapter', description: '审批后生成章节草稿。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_chapter_draft'] },
  { name: 'write_chapter_series', description: '审批后连续生成多章章节草稿。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_chapter_drafts'] },
  { name: 'polish_chapter', description: '审批后润色或修改章节草稿。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_chapter_draft_version'] },
  { name: 'rewrite_chapter', description: '审批后重写章节草稿。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_chapter_rewrite_draft'] },
  { name: 'postprocess_chapter', description: '对章节草稿做后处理和格式检查。' },
  { name: 'fact_validation', description: '校验章节事实一致性。' },
  { name: 'auto_repair_chapter', description: '按事实校验结果有界修复章节。', requiresApproval: true, riskLevel: 'medium', sideEffects: ['create_repair_draft'] },
  { name: 'extract_chapter_facts', description: '抽取章节事实。', requiresApproval: true, riskLevel: 'high', sideEffects: ['replace_auto_story_events'] },
  { name: 'rebuild_memory', description: '重建章节记忆。', requiresApproval: true, riskLevel: 'high', sideEffects: ['replace_memory_chunks'] },
  { name: 'review_memory', description: '复核章节记忆。' },
  { name: 'report_result', description: '汇总只读检查结果。' },
  { name: 'echo_report', description: '生成澄清或缺信息报告。', requiresApproval: true, riskLevel: 'low' },
];

function createEvalTool(definition: EvalToolDefinition): BaseTool {
  const requiresApproval = definition.requiresApproval ?? false;
  const riskLevel = definition.riskLevel ?? 'low';
  const sideEffects = definition.sideEffects ?? [];
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    allowedModes: ['plan', 'act'],
    riskLevel,
    requiresApproval,
    sideEffects,
    manifest: {
      name: definition.name,
      displayName: definition.name,
      description: definition.description,
      whenToUse: [`当任务需要 ${definition.description} 时使用。`],
      whenNotToUse: ['缺少项目或实体上下文且无法通过 resolver 补齐时，不要编造 ID。'],
      allowedModes: ['plan', 'act'],
      riskLevel,
      requiresApproval,
      sideEffects,
      idPolicy: { forbiddenToInvent: ['projectId', 'chapterId', 'characterId', 'draftId'], allowedSources: ['context', 'resolver', 'previous_step', 'runtime'] },
    },
    async run() {
      return {};
    },
  };
}

/** 可控 LLM：按 eval case 生成计划草案，再交给真实 AgentPlannerService 做 schema/工具/审批/质量管线规范化。 */
class EvalLlmGatewayMock {
  async chatJson<T = unknown>(messages: LlmChatMessage[]): Promise<{ data: T; result: { text: string; model: string; usage: Record<string, number> } }> {
    const payload = parsePlannerPrompt(messages);
    const userGoal = typeof payload.userGoal === 'string' ? payload.userGoal : '';
    const agentContext = asRecord(payload.agentContext);
    const data = createMockPlannerOutput(userGoal, agentContext);
    return { data: data as T, result: { text: JSON.stringify(data), model: 'eval-mock-planner', usage: { prompt_tokens: 0, completion_tokens: 0 } } };
  }
}

class PromptCaptureLlmGatewayMock extends EvalLlmGatewayMock {
  readonly capturedCalls: LlmChatMessage[][] = [];

  override async chatJson<T = unknown>(messages: LlmChatMessage[]): Promise<{ data: T; result: { text: string; model: string; usage: Record<string, number> } }> {
    this.capturedCalls.push(messages);
    return super.chatJson<T>(messages);
  }
}

function parsePlannerPrompt(messages: LlmChatMessage[]): Record<string, unknown> {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (typeof content !== 'string') return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 根据固定 eval case 生成 LLM 草案；这里故意保留自然语言引用给 resolver，验证真实 Planner 不会接受伪造 ID。 */
function createMockPlannerOutput(goal: string, agentContext: Record<string, unknown>): AgentPlanLike & Record<string, unknown> {
  const session = asRecord(agentContext.session);
  const currentChapterId = session.currentChapterId ? '{{context.session.currentChapterId}}' : undefined;
  const currentDraftId = session.currentDraftId ? '{{context.session.currentDraftId}}' : '{{runtime.currentDraftId}}';
  const requestedAssetTypes = importAssetTypesValue(session.requestedAssetTypes);
  if (session.guided && goal.includes('Guided step consultation eval')) {
    return plan('guided_step_consultation', goal, false, [
      step(1, 'generate_guided_step_preview', { stepKey: '{{context.session.guided.currentStep}}', mode: 'consultation', currentStepData: '{{context.session.guided.currentStepData}}', instruction: goal }),
      step(2, 'validate_guided_step_preview', { stepKey: '{{context.session.guided.currentStep}}', structuredData: '{{steps.generate_guided_step_preview.output.structuredData}}' }),
    ]);
  }
  if (goal.includes('Targeted import eval') && requestedAssetTypes.length) {
    return plan('project_import_preview', goal, true, [
      step(1, 'analyze_source_text', { sourceText: '{{context.session.selectedText}}' }),
    ]);
  }
  if (goal.includes('计划时间线候选') && goal.includes('不要写入')) {
    return plan('timeline_plan', goal, false, [
      step(1, 'collect_task_context', { taskType: 'timeline_plan', chapterId: currentChapterId, focus: ['outline', 'craftBrief', 'planned_timeline'] }),
      step(2, 'generate_timeline_preview', { context: '{{steps.collect_task_context.output}}', chapterId: currentChapterId, instruction: goal, sourceType: 'craft_brief' }),
      step(3, 'validate_timeline_preview', { preview: '{{steps.generate_timeline_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' }),
    ]);
  }
  if (goal.includes('正文已经生成') && goal.includes('确认计划时间线')) {
    return plan('timeline_plan', goal, true, [
      step(1, 'collect_task_context', { taskType: 'timeline_plan', chapterId: currentChapterId, draftId: currentDraftId, focus: ['story_events', 'timeline_events', 'chapter_timeline_alignment'] }),
      step(2, 'align_chapter_timeline_preview', { chapterId: currentChapterId, draftId: currentDraftId, taskContext: '{{steps.collect_task_context.output}}', instruction: goal }),
      step(3, 'validate_timeline_preview', { preview: '{{steps.align_chapter_timeline_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' }),
      step(4, 'persist_timeline_events', { preview: '{{steps.align_chapter_timeline_preview.output}}', validation: '{{steps.validate_timeline_preview.output}}' }),
    ]);
  }
  if (goal.includes('第十二章')) {
    return plan('chapter_write', goal, true, [
      step(1, 'resolve_chapter', { projectId: '{{context.session.currentProjectId}}', chapterRef: '第十二章', currentChapterId }),
      step(2, 'collect_chapter_context', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', focus: ['压迫感'] }),
      step(3, 'write_chapter', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '写第十二章，压迫感强一点。' }),
    ]);
  }
  if (goal.includes('前三章') && goal.includes('下一章')) {
    return plan('chapter_write', goal, true, [
      step(1, 'resolve_chapter', { projectId: '{{context.session.currentProjectId}}', chapterRef: '下一章', currentChapterId }),
      step(2, 'collect_chapter_context', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', chapterRange: '前三章', focus: ['前三章', '下一章'] }),
      step(3, 'write_chapter', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '根据前三章继续写下一章。' }),
    ]);
  }
  if (goal.includes('这一章太平')) {
    return plan('chapter_revision', goal, true, [
      step(1, 'collect_chapter_context', { chapterId: currentChapterId, focus: ['紧张', '别改结局'] }),
      step(2, 'polish_chapter', { chapterId: currentChapterId, draftId: currentDraftId, instruction: '把这一章改得紧张点，别改结局。' }),
      step(3, 'fact_validation', { chapterId: currentChapterId }),
    ]);
  }
  if (goal.includes('去 AI 味')) {
    return plan('chapter_polish', goal, true, [step(1, 'polish_chapter', { chapterId: currentChapterId, selectedText: '{{context.session.selectedText}}', instruction: '把这段去 AI 味。' })]);
  }
  if (goal.includes('男主')) {
    return plan('character_consistency_check', goal, false, [
      step(1, 'resolve_character', { projectId: '{{context.session.currentProjectId}}', characterRef: '男主' }),
      step(2, 'collect_task_context', { taskType: 'character_consistency_check', characterId: '{{steps.resolve_character.output.characterId}}', focus: ['男主', '人设'] }),
      step(3, 'character_consistency_check', { characterId: '{{steps.resolve_character.output.characterId}}', taskContext: '{{steps.collect_task_context.output}}', instruction: '检查男主这里是不是人设崩了。' }),
    ]);
  }
  if (goal.includes('当前大纲')) {
    return plan('plot_consistency_check', goal, false, [
      step(1, 'collect_task_context', { taskType: 'plot_consistency_check', focus: ['plot_facts', 'relationship_graph', 'world_facts', 'memory_chunks'] }),
      step(2, 'plot_consistency_check', { taskContext: '{{steps.collect_task_context.output}}', instruction: '当前大纲有没有矛盾？' }),
    ]);
  }
  if (goal.includes('宗门体系')) {
    return plan('worldbuilding_expand', goal, true, [
      step(1, 'inspect_project_context', { projectId: '{{context.session.currentProjectId}}', focus: ['worldbuilding'] }),
      step(2, 'collect_task_context', { taskType: 'worldbuilding_expand', focus: ['宗门体系', '不要影响已有剧情'] }),
      step(3, 'generate_worldbuilding_preview', { context: '{{steps.collect_task_context.output}}', instruction: '补充宗门体系，但不要影响已有剧情。' }),
      step(4, 'validate_worldbuilding', { preview: '{{steps.generate_worldbuilding_preview.output}}' }),
      step(5, 'persist_worldbuilding', { preview: '{{steps.generate_worldbuilding_preview.output}}', validation: '{{steps.validate_worldbuilding.output}}' }),
    ]);
  }
  if (goal.includes('灵脉禁制') || goal.includes('Story Bible')) {
    return plan('story_bible_expand', goal, true, [
      step(1, 'collect_task_context', { taskType: 'story_bible_expand', focus: ['灵脉禁制', '宗门货币', 'locked_world_facts'] }),
      step(2, 'generate_story_bible_preview', { context: '{{steps.collect_task_context.output}}', instruction: goal, focus: ['power_system', 'rule', 'economy'] }),
      step(3, 'validate_story_bible', { preview: '{{steps.generate_story_bible_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' }),
      step(4, 'persist_story_bible', { preview: '{{steps.generate_story_bible_preview.output}}', validation: '{{steps.validate_story_bible.output}}' }),
    ]);
  }
  if (goal.includes('关系线') && goal.includes('前后矛盾')) {
    return plan('continuity_check', goal, true, [
      step(1, 'collect_task_context', { taskType: 'continuity_check', focus: ['relationship_graph', 'plot_facts', 'world_facts', 'memory_chunks'] }),
      step(2, 'generate_continuity_preview', { context: '{{steps.collect_task_context.output}}', instruction: goal, focus: ['relationship_graph'] }),
      step(3, 'validate_continuity_changes', { preview: '{{steps.generate_continuity_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' }),
      step(4, 'persist_continuity_changes', { preview: '{{steps.generate_continuity_preview.output}}', validation: '{{steps.validate_continuity_changes.output}}' }),
    ]);
  }
  if (goal.includes('时间线') && goal.includes('旧盟玉佩')) {
    return plan('continuity_check', goal, true, [
      step(1, 'collect_task_context', { taskType: 'continuity_check', entityRefs: { chapterRange: '前九章' }, focus: ['timeline_events', 'plot_facts', 'relationship_graph', 'memory_chunks'] }),
      step(2, 'generate_continuity_preview', { context: '{{steps.collect_task_context.output}}', instruction: goal, focus: ['timeline_events'] }),
      step(3, 'validate_continuity_changes', { preview: '{{steps.generate_continuity_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' }),
      step(4, 'persist_continuity_changes', { preview: '{{steps.generate_continuity_preview.output}}', validation: '{{steps.validate_continuity_changes.output}}' }),
    ]);
  }
  if (goal.includes('first volume outline')) {
    return plan('outline_design', goal, true, [
      step(1, 'inspect_project_context', { projectId: '{{context.session.currentProjectId}}', focus: ['outline', 'volumes'] }),
      step(2, 'generate_volume_outline_preview', { context: '{{steps.inspect_project_context.output}}', instruction: 'Generate only the first volume outline.', volumeNo: 1 }),
      step(3, 'persist_volume_outline', { preview: '{{steps.generate_volume_outline_preview.output}}' }),
    ]);
  }
  if ((goal.includes('第一卷') || goal.includes('第1卷')) && goal.includes('大纲') && !goal.includes('章')) {
    return plan('outline_design', goal, true, [
      step(1, 'inspect_project_context', { projectId: '{{context.session.currentProjectId}}', focus: ['outline', 'volumes'] }),
      step(2, 'generate_volume_outline_preview', { context: '{{steps.inspect_project_context.output}}', instruction: goal, volumeNo: 1 }),
      step(3, 'persist_volume_outline', { preview: '{{steps.generate_volume_outline_preview.output}}' }),
    ]);
  }
  if (goal.includes('第一卷') && goal.includes('30')) {
    const chapterSteps = Array.from({ length: 30 }, (_item, index) => {
      const chapterNo = index + 1;
      return step(3 + index, 'generate_chapter_outline_preview', {
        context: '{{steps.inspect_project_context.output}}',
        volumeOutline: '{{steps.generate_volume_outline_preview.output.volume}}',
        volumeNo: 1,
        chapterNo,
        chapterCount: 30,
        instruction: '把第一卷拆成 30 章。',
        ...(chapterNo > 1 ? { previousChapter: `{{steps.${2 + index}.output.chapter}}` } : {}),
      });
    });
    return plan('outline_design', goal, true, [
      step(1, 'inspect_project_context', { projectId: '{{context.session.currentProjectId}}', focus: ['outline', 'volumes', 'chapters'] }),
      step(2, 'generate_volume_outline_preview', { context: '{{steps.inspect_project_context.output}}', instruction: '把第一卷拆成 30 章。', volumeNo: 1, chapterCount: 30 }),
      ...chapterSteps,
      step(33, 'merge_chapter_outline_previews', { previews: chapterSteps.map((chapterStep) => `{{steps.${chapterStep.stepNo}.output}}`), volumeNo: 1, chapterCount: 30 }),
      step(34, 'validate_outline', { preview: '{{steps.merge_chapter_outline_previews.output}}' }),
      step(35, 'persist_outline', { preview: '{{steps.merge_chapter_outline_previews.output}}', validation: '{{steps.validate_outline.output}}' }),
    ]);
  }
  if (goal.includes('文案拆成角色')) {
    return plan('project_import_preview', goal, true, [
      step(1, 'analyze_source_text', { sourceText: '{{context.session.selectedText}}' }),
      step(2, 'build_import_preview', { analysis: '{{steps.analyze_source_text.output}}', instruction: '拆成角色、世界观和三卷大纲。' }),
      step(3, 'validate_imported_assets', { preview: '{{steps.build_import_preview.output}}' }),
      step(4, 'persist_project_assets', { preview: '{{steps.build_import_preview.output}}', validation: '{{steps.validate_imported_assets.output}}' }),
    ]);
  }
  if (goal.includes('对峙那章')) {
    return plan('chapter_revision', goal, true, [
      step(1, 'resolve_chapter', { projectId: '{{context.session.currentProjectId}}', chapterRef: '他和师姐对峙那章' }),
      step(2, 'collect_chapter_context', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', focus: ['师姐', '对峙'] }),
      step(3, 'polish_chapter', { chapterId: '{{steps.resolve_chapter.output.chapterId}}', instruction: '帮我改一下他和师姐对峙那章。' }),
      step(4, 'fact_validation', { chapterId: '{{steps.resolve_chapter.output.chapterId}}' }),
    ]);
  }
  if (goal.includes('小林')) {
    return plan('character_consistency_check', goal, false, [
      step(1, 'resolve_character', { projectId: '{{context.session.currentProjectId}}', characterRef: '小林' }),
      step(2, 'collect_task_context', { taskType: 'character_consistency_check', characterId: '{{steps.resolve_character.output.characterId}}', focus: ['小林', '人设'] }),
      step(3, 'character_consistency_check', { characterId: '{{steps.resolve_character.output.characterId}}', taskContext: '{{steps.collect_task_context.output}}', instruction: '帮我检查小林的人设。' }),
    ]);
  }
  return {
    ...plan('chapter_write', goal, true, [step(1, 'echo_report', { message: '缺少项目信息，无法安全解析下一章。' })]),
    missingInfo: [{ field: 'project', reason: '缺少当前项目，无法确定下一章属于哪个项目。', canResolveByTool: false }],
  };
}

function plan(taskType: string, goal: string, requiresApproval: boolean, steps: AgentPlanLike['steps']): AgentPlanLike & Record<string, unknown> {
  return {
    schemaVersion: 2,
    understanding: goal,
    userGoal: goal,
    taskType,
    confidence: 0.9,
    summary: `评测计划：${goal}`,
    assumptions: ['这是 live planner eval 的可控 LLM 草案，仍由真实 Planner 规范化。'],
    missingInfo: [],
    requiredContext: [],
    risks: requiresApproval ? ['涉及写入或草稿变更，需要审批。'] : ['只读检查，不写入业务表。'],
    steps,
    requiredApprovals: requiresApproval ? [{ approvalType: 'plan', target: { tools: steps?.map((item) => item.tool) ?? [] } }] : [],
    riskReview: { riskLevel: requiresApproval ? 'medium' : 'low', reasons: requiresApproval ? ['存在副作用步骤。'] : ['只读低风险。'], requiresApproval, approvalMessage: requiresApproval ? '确认后才执行写入步骤。' : '只读检查无需审批。' },
    userVisiblePlan: { summary: `我会处理：${goal}`, bullets: steps?.map((item) => `使用 ${item.tool}`) ?? [], hiddenTechnicalSteps: true },
  };
}

function step(stepNo: number, tool: string, args: Record<string, unknown>): NonNullable<AgentPlanLike['steps']>[number] & { stepNo: number; id: string; name: string; mode: 'act' } {
  return { id: tool, stepNo, name: `执行 ${tool}`, tool, mode: 'act', requiresApproval: false, args };
}

function printCaseResults(label: string, results: CaseEvaluation[]) {
  console.log(`\n[${label}]`);
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✗'} ${result.id}${result.failures.length ? `：${result.failures.join('；')}` : ''}`);
  }
}

function printPromptSizeGates(gates: PromptSizeGateResult[]) {
  if (!gates.length) return;
  console.log('\n[prompt size gates]');
  for (const gate of gates) {
    const ratio = (gate.selectedToAllRatio * 100).toFixed(1);
    const limit = (gate.maxSelectedToAllRatio * 100).toFixed(1);
    console.log(`${gate.passed ? '✓' : '✗'} ${gate.id}: ${gate.selectedToolsChars}/${gate.allToolsChars} chars (${ratio}%, limit ${limit}%)${gate.failure ? `：${gate.failure}` : ''}`);
  }
}

function printMetricSummary(report: EvalReport) {
  const mode = report.plannerMode ? ` (${report.plannerMode})` : '';
  console.log(`Agent Planner Eval${mode}：${report.passedCases}/${report.totalCases} 通过`);
  for (const [key, metric] of Object.entries(report.metrics)) {
    if (!metric.total) {
      console.log(`- ${key}: n/a (0/0)`);
      continue;
    }
    if (key === 'bundleToolLeakRate') {
      console.log(`- ${key}: ${(metric.rate * 100).toFixed(1)}% leak (${metric.total - metric.passed}/${metric.total})`);
      continue;
    }
    if (key === 'promptReductionRate') {
      console.log(`- ${key}: ${(metric.rate * 100).toFixed(1)}% avg reduction (${metric.passed}/${metric.total} reduced)`);
      continue;
    }
    const suffix = key === 'idHallucinationRate' ? '（通过率，目标为 100% 无幻觉）' : '';
    console.log(`- ${key}: ${(metric.rate * 100).toFixed(1)}% (${metric.passed}/${metric.total})${suffix}`);
  }
}

function metricKeys(): EvalMetricKey[] {
  return ['intentAccuracy', 'toolPlanAccuracy', 'requiredParamCompletion', 'idHallucinationRate', 'resolverUsageRate', 'approvalSafety', 'firstPlanSuccessRate', 'userVisibleClarity', 'retrievalDimensionCoverage', 'routeAccuracy', 'bundleAccuracy', 'bundleToolLeakRate', 'promptReductionRate'];
}

function appendHistory(filePath: string, report: EvalReport, shouldFailOnRegression: boolean) {
  const resolved = path.resolve(process.cwd(), filePath);
  const previous = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) as EvalReport[] : [];
  const last = previous.at(-1);
  writeJson(filePath, [...previous, report]);
  if (shouldFailOnRegression && last) {
    const regressed = Object.entries(report.metrics).filter(([key, metric]) => metricRegressed(key as EvalMetricKey, metric, last.metrics[key as EvalMetricKey]));
    if (regressed.length) {
      console.error(`发现 Eval 指标回退：${regressed.map(([key]) => key).join(', ')}`);
      process.exitCode = 1;
    }
  }
}

function metricRegressed(key: EvalMetricKey, current: EvalMetric, previous?: EvalMetric): boolean {
  if (!previous || !current.total || !previous.total) return false;
  if (key === 'bundleToolLeakRate') return current.rate > previous.rate;
  return current.rate < previous.rate;
}

function writeJson(filePath: string, value: unknown) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function expectedResolverTools(item: EvalCase) {
  return (item.expected.mustUseTools ?? []).filter((tool) => tool.startsWith('resolve_'));
}

function hasUserVisiblePlan(plan: AgentPlanLike) {
  return Boolean(plan.userVisiblePlan?.summary || plan.userVisiblePlan?.bullets?.length);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

/**
 * 检查 Eval 期望中的点路径字段是否存在且有可用值。
 * 数组字段要求非空，避免关系边 evidenceSources 这类字段只有空壳也被误判为覆盖。
 */
function hasNestedField(record: Record<string, unknown>, pathValue: string): boolean {
  const parts = pathValue.split('.').filter(Boolean);
  let current: unknown = record;
  for (const part of parts) {
    const currentRecord = asRecord(current);
    if (!(part in currentRecord)) return false;
    current = currentRecord[part];
  }
  if (Array.isArray(current)) return current.length > 0;
  return current !== undefined && current !== null && current !== '';
}

function hasNestedKey(record: Record<string, unknown>, pathValue: string): boolean {
  const parts = pathValue.split('.').filter(Boolean);
  let current: unknown = record;
  for (const part of parts) {
    const currentRecord = asRecord(current);
    if (!(part in currentRecord)) return false;
    current = currentRecord[part];
  }
  return true;
}

function recordContainsSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => recordContainsSubset(actual[index], item));
  }
  if (expected && typeof expected === 'object') {
    const actualRecord = asRecord(actual);
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => (
      key in actualRecord && recordContainsSubset(actualRecord[key], value)
    ));
  }
  return actual === expected;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function importAssetTypesValue(value: unknown): NonNullable<AgentContextV2['session']['requestedAssetTypes']> {
  const allowed = new Set(['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules']);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NonNullable<AgentContextV2['session']['requestedAssetTypes']>[number] => typeof item === 'string' && allowed.has(item));
}

function importPreviewModeValue(value: unknown): AgentContextV2['session']['importPreviewMode'] {
  return value === 'auto' || value === 'quick' || value === 'deep' ? value : undefined;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
