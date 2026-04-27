import { Injectable } from '@nestjs/common';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

export interface AgentPlanStepSpec {
  stepNo: number;
  name: string;
  tool: string;
  mode: 'act';
  requiresApproval: boolean;
  args: Record<string, unknown>;
  runIf?: AgentStepCondition;
}

export interface AgentStepCondition {
  ref: string;
  operator: 'exists' | 'not_exists' | 'truthy' | 'falsy' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value?: unknown;
}

export interface AgentPlanSpec {
  taskType: string;
  summary: string;
  assumptions: string[];
  risks: string[];
  steps: AgentPlanStepSpec[];
  requiredApprovals: Record<string, unknown>[];
  plannerDiagnostics?: Record<string, unknown>;
}

interface PlannerLlmBudget {
  used: number;
  max: number;
  failures: Array<{ stage: string; message: string }>;
}

interface PlannerOutputDefaults {
  taskType: string;
  summary: string;
  assumptions: string[];
  risks: string[];
}

export class AgentPlannerFailedError extends Error {
  constructor(message: string, readonly diagnostics: Record<string, unknown>) {
    super(message);
    this.name = 'AgentPlannerFailedError';
  }
}

/**
 * Agent Planner 负责把用户自然语言目标转换为受控 JSON Plan。
 * taskType 和步骤编排由 LLM 根据用户目标与 Tool Schema 决定；后端只校验工具白名单、审批和引用边界。
 */
@Injectable()
export class AgentPlannerService {
  constructor(
    private readonly skills: SkillRegistryService,
    private readonly tools: ToolRegistryService,
    private readonly rules: RuleEngineService,
    private readonly llm: LlmGatewayService,
  ) {}

  async createPlan(goal: string): Promise<AgentPlanSpec> {
    const defaults = this.createOutputDefaults(goal);
    const llmBudget: PlannerLlmBudget = { used: 0, max: this.rules.getPolicy().limits.maxLlmCalls, failures: [] };
    try {
      return await this.createLlmPlan(goal, defaults, llmBudget);
    } catch (error) {
      const failures = [...llmBudget.failures, this.failureDetail('planner_failed', error)];
      const diagnostics = { llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, failures };
      throw new AgentPlannerFailedError(`Agent Planner 生成高质量计划失败：${JSON.stringify(diagnostics)}`, diagnostics);
    }
  }

  /** 只提供非语义字段的默认展示文案，不参与 taskType 判定，也不会作为可执行计划回退。 */
  private createOutputDefaults(goal: string): PlannerOutputDefaults {
    return {
      taskType: 'general',
      summary: `处理目标：${goal}`,
      assumptions: ['Plan 阶段只生成可审批计划和只读预览。'],
      risks: this.rules.listHardRules(),
    };
  }

  private async createLlmPlan(goal: string, defaults: PlannerOutputDefaults, llmBudget: PlannerLlmBudget): Promise<AgentPlanSpec> {
    const tools = this.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    }));
    const availableTaskTypes = this.listTaskTypes();
    const skills = this.skills.list();
    const hardRules = this.rules.listHardRules();

    const messages = [
      {
        role: 'system' as const,
        content: [
          '你是 CreativeAgent Planner。你只能输出严格 JSON，不要 Markdown。',
          '当前用户选择的是 Agent 工作台 Plan 模式：只生成可审批计划和只读预览，不执行写入。',
          'taskType 必须由你根据 userGoal 语义判断，并且只能从 availableTaskTypes 中选择；不要依赖后端关键词分类。',
          '你不能编造工具，steps[].tool 必须来自 Available Tools。',
          '注意：outputContract.steps[].mode 是后端计划步骤字段，固定填 act；它不代表当前 UI 的 Plan/Act 开关。',
          'Plan 阶段不写正式业务表；运行时会用 mode=plan 只执行无副作用预览步骤，所有真实副作用必须等用户切到 Act 并审批后才允许。',
          '你需要根据 Available Tools 的 description/inputSchema/outputSchema 自主编排步骤和 args。',
          '引用前序步骤输出时，完整对象用 {{steps.N.output}}，对象字段用 {{steps.N.output.field}}；不要把对象序列化成字符串。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify(
          {
            userGoal: goal,
            currentAgentMode: 'plan',
            stepModeContract: 'steps[].mode 固定为 act；Plan/Act 运行时模式由后端 AgentRuntimeService 注入，不由 LLM 决定。',
            availableTaskTypes,
            taskTypeGuidance: {
              chapter_write: '写某一章正文、章节内容、目标字数、续写正文。',
              chapter_polish: '润色、修改、改稿、优化文风、去 AI 味。',
              outline_design: '设计大纲、拆卷、拆成/分成多章、章节规划。',
              project_import_preview: '拆解导入文案、生成角色/世界观/项目资料。',
              general: '无法归入以上创作任务时才使用。',
            },
            skills,
            hardRules,
            availableTools: tools,
            outputContract: {
              taskType: 'one_of_availableTaskTypes',
              summary: 'string',
              assumptions: ['string'],
              risks: ['string'],
              steps: [{ stepNo: 1, name: 'string', tool: 'registered_tool_name', mode: 'act', requiresApproval: true, args: {} }],
              requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [1], tools: ['tool_name'] } }],
            },
          },
          null,
          2,
        ),
      },
    ];

    this.consumeLlmCall(llmBudget, 'initial_plan');
    const { data, result } = await this.llm.chatJson<unknown>(
      messages,
      { appStep: 'agent_planner', maxTokens: 4500, timeoutMs: 90_000, retries: 1, temperature: 0.1 },
    );

    try {
      return { ...this.validateAndNormalizeLlmPlan(data, defaults), plannerDiagnostics: { source: 'llm', model: result.model, usage: result.usage, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 1 } };
    } catch (error) {
      llmBudget.failures.push(this.failureDetail('schema_validation', error));
      return this.repairLlmPlan(goal, defaults, data, error instanceof Error ? error.message : String(error), llmBudget);
    }
  }

  private async repairLlmPlan(goal: string, defaults: PlannerOutputDefaults, invalidPlan: unknown, validationError: string, llmBudget: PlannerLlmBudget): Promise<AgentPlanSpec> {
    const registeredTools = this.tools.list().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, requiresApproval: tool.requiresApproval, riskLevel: tool.riskLevel, sideEffects: tool.sideEffects }));
    const availableTaskTypes = this.listTaskTypes();
    this.consumeLlmCall(llmBudget, 'repair_plan');
    const { data, result } = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            '你是 CreativeAgent Planner 修复器。你只能输出严格 JSON，不要 Markdown。',
            '当前用户选择的是 Agent 工作台 Plan 模式：只修复可审批计划，不执行写入。',
            '必须修复 invalidPlan，使 taskType 来自 availableTaskTypes，steps[].tool 全部来自 registeredTools。',
            'taskType 由 userGoal 语义决定；不要依赖后端关键词分类。',
            'steps[].mode 是后端计划步骤字段，固定填 act；Plan/Act 运行时模式由后端注入，不由 LLM 决定。',
            '引用前序步骤输出时，完整对象用 {{steps.N.output}}，对象字段用 {{steps.N.output.field}}；不要把对象序列化成字符串。',
            '如果无法安全修复，仍必须输出符合 outputContract 的最小安全计划。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              userGoal: goal,
              currentAgentMode: 'plan',
              stepModeContract: 'steps[].mode 固定为 act；Plan/Act 运行时模式由后端 AgentRuntimeService 注入，不由 LLM 决定。',
              availableTaskTypes,
              invalidPlan,
              validationError,
              registeredTools,
              outputDefaults: defaults,
              outputContract: {
                taskType: 'one_of_availableTaskTypes',
                summary: 'string',
                assumptions: ['string'],
                risks: ['string'],
                steps: [{ stepNo: 1, name: 'string', tool: 'registered_tool_name', mode: 'act', requiresApproval: true, args: {} }],
                requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [1], tools: ['tool_name'] } }],
              },
            },
            null,
            2,
          ),
        },
      ],
      { appStep: 'agent_planner', maxTokens: 4500, timeoutMs: 90_000, retries: 1, temperature: 0.1 },
    );

    return { ...this.validateAndNormalizeLlmPlan(data, defaults), plannerDiagnostics: { source: 'llm_repair', model: result.model, usage: result.usage, repairedFromError: validationError, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 1 } };
  }

  private validateAndNormalizeLlmPlan(data: unknown, defaults: PlannerOutputDefaults): AgentPlanSpec {
    const record = this.asRecord(data);
    const availableTaskTypes = new Set(this.listTaskTypes());
    const registeredTools = new Set(this.tools.list().map((tool) => tool.name));
    const toolRequiresApproval = new Map(this.tools.list().map((tool) => [tool.name, tool.requiresApproval]));
    const rawSteps = Array.isArray(record.steps) ? record.steps : [];
    const maxSteps = this.rules.getPolicy().limits.maxSteps;
    if (typeof record.taskType !== 'string') throw new Error('LLM Plan taskType 必须由模型明确给出');
    if (!rawSteps.length || rawSteps.length > maxSteps) throw new Error(`LLM Plan steps 数量非法，最多 ${maxSteps} 步`);
    if (typeof record.taskType === 'string' && !availableTaskTypes.has(record.taskType)) throw new Error(`LLM Plan taskType 不在允许范围：${record.taskType}`);

    const steps = rawSteps.map((item, index): AgentPlanStepSpec => {
      const step = this.asRecord(item);
      if (!Object.keys(step).length) throw new Error(`LLM Plan 第 ${index + 1} 步不是对象`);
      if (step.stepNo !== undefined && typeof step.stepNo !== 'number') throw new Error(`LLM Plan 第 ${index + 1} 步 stepNo 非数字`);
      const tool = typeof step.tool === 'string' ? step.tool : '';
      if (!registeredTools.has(tool)) throw new Error(`LLM Plan 使用未注册工具：${tool}`);
      const args = this.asRecord(step.args);
      this.assertArgsOnlyReferencePreviousSteps(args, index + 1);
      const runIf = this.normalizeRunIf(step.runIf, index + 1);
      return {
        stepNo: index + 1,
        name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : `执行 ${tool}`,
        tool,
        mode: 'act',
        // 审批需求以后端 Tool 元数据为准，避免模型把写入类工具降级为无需审批。
        requiresApproval: toolRequiresApproval.get(tool) ?? Boolean(step.requiresApproval),
        args,
        ...(runIf ? { runIf } : {}),
      };
    });

    const normalizedSteps = this.enforceChapterWriteQualityPipeline(steps, (tool) => toolRequiresApproval.get(tool) ?? false);
    if (normalizedSteps.length > maxSteps) throw new Error(`规范化后的 Agent Plan steps 数量非法，最多 ${maxSteps} 步`);
    const missingTool = normalizedSteps.find((step) => !registeredTools.has(step.tool));
    if (missingTool) throw new Error(`规范化后的 Agent Plan 使用未注册工具：${missingTool.tool}`);
    const approvalSteps = normalizedSteps.filter((step) => step.requiresApproval);
    return {
      taskType: record.taskType,
      summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : defaults.summary,
      assumptions: this.stringArray(record.assumptions, defaults.assumptions),
      risks: this.stringArray(record.risks, defaults.risks),
      steps: normalizedSteps,
      requiredApprovals: approvalSteps.length
        ? [{ approvalType: 'plan', target: { stepNos: approvalSteps.map((step) => step.stepNo), tools: approvalSteps.map((step) => step.tool) } }]
        : [],
    };
  }

  /**
   * 章节写作必须走固定质量门禁：写稿后润色、事实校验、最多二轮修复，再沉淀事实和记忆。
   * 这里覆盖 LLM 在 write_chapter 之后给出的自由编排，避免漏掉后置校验或产生无限修复循环。
   */
  private enforceChapterWriteQualityPipeline(steps: AgentPlanStepSpec[], requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    const writeIndex = steps.findIndex((step) => step.tool === 'write_chapter');
    if (writeIndex < 0) return steps;

    const baseSteps = steps.slice(0, writeIndex + 1);
    const chapterId = '{{runtime.currentChapterId}}';
    const draftId = '{{runtime.currentDraftId}}';
    const firstValidationStepNo = baseSteps.length + 2;
    const secondValidationRunIf: AgentStepCondition = { ref: `{{steps.${firstValidationStepNo}.output.createdCount}}`, operator: 'gt', value: 0 };

    const followups: AgentPlanStepSpec[] = [
      this.createPlannedStep('初次润色章节草稿', 'polish_chapter', { chapterId, draftId, instruction: '在不改变剧情事实的前提下润色章节正文，统一文风、清理生硬表达，并保留章节目标和关键事件。' }, requiresApproval),
      this.createPlannedStep('初次事实一致性校验', 'fact_validation', { chapterId }, requiresApproval),
      this.createPlannedStep('按初次校验结果自动修复', 'auto_repair_chapter', { chapterId, draftId, issues: `{{steps.${firstValidationStepNo}.output.issues}}`, instruction: '根据事实校验问题做最小必要修复，不新增重大剧情、角色或设定。', maxRounds: 1 }, requiresApproval),
      this.createPlannedStep('二次润色修复后草稿', 'polish_chapter', { chapterId, draftId, instruction: '仅在初次校验发现问题后，对修复后的章节做第二轮轻量润色，保持剧情事实不变。' }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('二次事实一致性校验', 'fact_validation', { chapterId }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('按二次校验结果自动修复', 'auto_repair_chapter', { chapterId, draftId, issues: `{{steps.${firstValidationStepNo + 3}.output.issues}}`, instruction: '根据二次事实校验问题做最后一轮有界修复；若无可修复问题则跳过。', maxRounds: 1 }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('抽取章节事实', 'extract_chapter_facts', { chapterId, draftId }, requiresApproval),
      this.createPlannedStep('重建章节记忆', 'rebuild_memory', { chapterId, draftId }, requiresApproval),
      this.createPlannedStep('复核章节记忆', 'review_memory', { chapterId }, requiresApproval),
    ];

    return [...baseSteps, ...followups].map((step, index) => ({ ...step, stepNo: index + 1 }));
  }

  private createPlannedStep(name: string, tool: string, args: Record<string, unknown>, requiresApproval: (tool: string) => boolean, runIf?: AgentStepCondition): AgentPlanStepSpec {
    return { stepNo: 0, name, tool, mode: 'act', requiresApproval: requiresApproval(tool), args, ...(runIf ? { runIf } : {}) };
  }

  /** 统计 Planner 的模型调用次数，避免 JSON 修复循环失控。 */
  private consumeLlmCall(budget: PlannerLlmBudget, stage: string) {
    if (budget.used >= budget.max) throw new Error(`Planner LLM 调用超过上限：${budget.max}（阶段：${stage}）`);
    budget.used += 1;
  }

  /** 校验 Tool 参数中的变量引用只能读取前序步骤输出，避免计划形成循环依赖。 */
  private assertArgsOnlyReferencePreviousSteps(value: unknown, currentStepNo: number) {
    if (typeof value === 'string') {
      if (value.match(/^{{runtime\.(?:currentDraftId|currentChapterId)}}$/)) return;
      const match = value.match(/^{{steps\.(\d+)\.output(?:\.[\w.]+)?}}$/);
      if (match && Number(match[1]) >= currentStepNo) throw new Error(`LLM Plan 第 ${currentStepNo} 步引用了非前序步骤 ${match[1]}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.assertArgsOnlyReferencePreviousSteps(item, currentStepNo));
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => this.assertArgsOnlyReferencePreviousSteps(item, currentStepNo));
    }
  }

  /** 校验条件执行表达式只读取前序步骤或运行时当前草稿，避免条件分支形成循环依赖。 */
  private normalizeRunIf(value: unknown, currentStepNo: number): AgentStepCondition | undefined {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) return undefined;
    if (typeof record.ref !== 'string') throw new Error(`LLM Plan 第 ${currentStepNo} 步 runIf.ref 必须是字符串`);
    const operator = record.operator;
    const allowed = new Set<AgentStepCondition['operator']>(['exists', 'not_exists', 'truthy', 'falsy', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
    if (!allowed.has(operator as AgentStepCondition['operator'])) throw new Error(`LLM Plan 第 ${currentStepNo} 步 runIf.operator 非法`);
    this.assertArgsOnlyReferencePreviousSteps(record.ref, currentStepNo);
    return { ref: record.ref, operator: operator as AgentStepCondition['operator'], ...(record.value !== undefined ? { value: record.value } : {}) };
  }

  private failureDetail(stage: string, error: unknown) {
    return { stage, message: error instanceof Error ? error.message : String(error) };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private stringArray(value: unknown, fallback: string[]): string[] {
    const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
    return items.length ? items : fallback;
  }

  /** LLM 可以选择的任务类型白名单；后端只限制边界，不再做语义分类裁决。 */
  private listTaskTypes(): string[] {
    return [...new Set(this.skills.list().flatMap((skill) => skill.taskTypes))];
  }

}