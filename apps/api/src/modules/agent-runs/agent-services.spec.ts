import assert from 'node:assert/strict';
import { BaseTool } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { AgentExecutorService } from './agent-executor.service';
import { AgentPlannerService } from './agent-planner.service';
import { AgentPolicyService } from './agent-policy.service';

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

test('Policy 要求事实层/高风险 Tool 二次确认', () => {
  const policy = new AgentPolicyService(new RuleEngineService());
  const tool = createTool({ name: 'extract_chapter_facts', riskLevel: 'high', sideEffects: ['replace_auto_story_events'] });
  assert.throws(
    () => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: {} }, ['extract_chapter_facts']),
    /需要二次确认/,
  );
  assert.doesNotThrow(() => policy.assertAllowed(tool, { agentRunId: 'run1', projectId: 'p1', mode: 'act', approved: true, outputs: {}, policy: { confirmation: { confirmHighRisk: true } } }, ['extract_chapter_facts']));
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

test('Planner 确定性 baseline 优先识别大纲类目标', () => {
  const tools = { list: () => [createTool({ name: 'inspect_project_context', requiresApproval: false, sideEffects: [] }), createTool({ name: 'generate_outline_preview', requiresApproval: false, sideEffects: [] }), createTool({ name: 'validate_outline', requiresApproval: false, sideEffects: [] }), createTool({ name: 'persist_outline', riskLevel: 'high' }), createTool({ name: 'report_result', requiresApproval: false, sideEffects: [] })] } as unknown as ToolRegistryService;
  const planner = new AgentPlannerService(new SkillRegistryService(), tools, new RuleEngineService(), {} as LlmGatewayService) as unknown as { createDeterministicPlan: (goal: string) => { taskType: string; steps: Array<{ tool: string }> } };
  const plan = planner.createDeterministicPlan('帮我把第一卷拆成 30 章，每章有目标和冲突');
  assert.equal(plan.taskType, 'outline_design');
  assert.deepEqual(plan.steps.map((step) => step.tool), ['inspect_project_context', 'generate_outline_preview', 'validate_outline', 'persist_outline', 'report_result']);
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