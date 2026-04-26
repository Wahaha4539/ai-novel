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

export class AgentPlannerFailedError extends Error {
  constructor(message: string, readonly diagnostics: Record<string, unknown>) {
    super(message);
    this.name = 'AgentPlannerFailedError';
  }
}

/**
 * Agent Planner 负责把用户自然语言目标转换为受控 JSON Plan。
 * 当前先构造确定性 baseline 作为 schema 参考，再要求 LLM 输出计划；LLM 失败会报错，不再回退执行低质量计划。
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
    const baseline = this.createDeterministicPlan(goal);
    const llmBudget: PlannerLlmBudget = { used: 0, max: this.rules.getPolicy().limits.maxLlmCalls, failures: [] };
    try {
      return await this.createLlmPlan(goal, baseline, llmBudget);
    } catch (error) {
      const failures = [...llmBudget.failures, this.failureDetail('planner_failed', error)];
      const diagnostics = { llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, failures, baselineTaskType: baseline.taskType, baselineStepCount: baseline.steps.length };
      throw new AgentPlannerFailedError(`Agent Planner 生成高质量计划失败，已拒绝降级到确定性 baseline：${JSON.stringify(diagnostics)}`, diagnostics);
    }
  }

  private createDeterministicPlan(goal: string): AgentPlanSpec {
    const taskType = this.classify(goal);
    const skill = this.skills.select(taskType);
    const availableTools = this.tools.list().map((tool) => tool.name);
    const chapterNo = this.extractChapterNo(goal);

    if (taskType === 'chapter_polish') {
      return {
        taskType,
        summary: `使用 ${skill.name} 处理章节润色目标：${goal}`,
        assumptions: [`章节润色会先解析章节并收集上下文，用户审批后创建润色后的当前草稿版本。`, `可用工具：${availableTools.join(', ')}`],
        risks: this.rules.listHardRules(),
        steps: [
          { stepNo: 1, name: '解析目标章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { ...(chapterNo ? { chapterNo } : {}) } },
          { stepNo: 2, name: '收集章节上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
          { stepNo: 3, name: '润色章节草稿', tool: 'polish_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.1.output.chapterId}}', instruction: goal } },
          { stepNo: 4, name: '运行事实一致性校验', tool: 'fact_validation', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.3.output.chapterId}}' } },
          { stepNo: 5, name: '有界自动修复', tool: 'auto_repair_chapter', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.3.output.chapterId}}', draftId: '{{steps.3.output.draftId}}', issues: '{{steps.4.output.issues}}', instruction: goal, maxRounds: 1 } },
          { stepNo: 6, name: '抽取章节事实层', tool: 'extract_chapter_facts', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.3.output.chapterId}}', draftId: '{{steps.5.output.draftId}}' } },
          { stepNo: 7, name: '重建章节记忆', tool: 'rebuild_memory', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.3.output.chapterId}}', draftId: '{{steps.5.output.draftId}}' } },
          { stepNo: 8, name: '复核待确认记忆', tool: 'review_memory', mode: 'act', requiresApproval: true, args: { chapterId: '{{steps.3.output.chapterId}}' } },
          { stepNo: 9, name: '汇总执行结果', tool: 'report_result', mode: 'act', requiresApproval: false, args: { draftId: '{{steps.5.output.draftId}}', chapterId: '{{steps.3.output.chapterId}}', actualWordCount: '{{steps.5.output.repairedWordCount}}', summary: '{{steps.5.output.summary}}', polish: '{{steps.3.output}}', validation: '{{steps.4.output}}', autoRepair: '{{steps.5.output}}', facts: '{{steps.6.output}}', memory: '{{steps.7.output}}', memoryReview: '{{steps.8.output}}' } },
        ],
        requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [3, 4, 5, 6, 7, 8], tools: ['polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'] } }],
      };
    }

    if (taskType === 'chapter_write') {
      return {
        taskType,
        summary: `使用 ${skill.name} 处理章节写作目标：${goal}`,
        assumptions: [`章节写作会先解析章节并收集上下文，用户审批后创建新的当前草稿版本。`, `可用工具：${availableTools.join(', ')}`],
        risks: this.rules.listHardRules(),
        steps: [
          { stepNo: 1, name: '解析目标章节', tool: 'resolve_chapter', mode: 'act', requiresApproval: false, args: { ...(chapterNo ? { chapterNo } : {}) } },
          { stepNo: 2, name: '收集章节上下文', tool: 'collect_chapter_context', mode: 'act', requiresApproval: false, args: { chapterId: '{{steps.1.output.chapterId}}' } },
          {
            stepNo: 3,
            name: '生成章节正文草稿',
            tool: 'write_chapter',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.1.output.chapterId}}', context: '{{steps.2.output}}', instruction: goal, ...(this.extractWordCount(goal) ? { wordCount: this.extractWordCount(goal) } : {}) },
          },
          {
            stepNo: 4,
            name: '后处理章节草稿',
            tool: 'postprocess_chapter',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.3.output.chapterId}}', draftId: '{{steps.3.output.draftId}}' },
          },
          {
            stepNo: 5,
            name: '运行事实一致性校验',
            tool: 'fact_validation',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.4.output.chapterId}}' },
          },
          {
            stepNo: 6,
            name: '有界自动修复',
            tool: 'auto_repair_chapter',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.4.output.chapterId}}', draftId: '{{steps.4.output.draftId}}', issues: '{{steps.5.output.issues}}', instruction: goal, maxRounds: 1 },
          },
          {
            stepNo: 7,
            name: '抽取章节事实层',
            tool: 'extract_chapter_facts',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.4.output.chapterId}}', draftId: '{{steps.6.output.draftId}}' },
          },
          {
            stepNo: 8,
            name: '重建章节记忆',
            tool: 'rebuild_memory',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.4.output.chapterId}}', draftId: '{{steps.6.output.draftId}}' },
          },
          {
            stepNo: 9,
            name: '复核待确认记忆',
            tool: 'review_memory',
            mode: 'act',
            requiresApproval: true,
            args: { chapterId: '{{steps.4.output.chapterId}}' },
          },
          {
            stepNo: 10,
            name: '汇总执行结果',
            tool: 'report_result',
            mode: 'act',
            requiresApproval: false,
            args: { draftId: '{{steps.6.output.draftId}}', chapterId: '{{steps.4.output.chapterId}}', actualWordCount: '{{steps.6.output.repairedWordCount}}', summary: '{{steps.6.output.summary}}', postprocess: '{{steps.4.output}}', validation: '{{steps.5.output}}', autoRepair: '{{steps.6.output}}', facts: '{{steps.7.output}}', memory: '{{steps.8.output}}', memoryReview: '{{steps.9.output}}' },
          },
        ],
        requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [3, 4, 5, 6, 7, 8, 9], tools: ['write_chapter', 'postprocess_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'] } }],
      };
    }

    if (taskType === 'outline_design') {
      const volumeNo = this.extractVolumeNo(goal) ?? 1;
      const chapterCount = this.extractChapterCount(goal) ?? 10;
      return {
        taskType,
        summary: `使用 ${skill.name} 处理大纲设计目标：${goal}`,
        assumptions: [`大纲设计会先读取项目上下文并生成预览，用户审批后才写入卷和章节。`, `可用工具：${availableTools.join(', ')}`],
        risks: this.rules.listHardRules(),
        steps: [
          { stepNo: 1, name: '巡检项目上下文', tool: 'inspect_project_context', mode: 'act', requiresApproval: false, args: {} },
          { stepNo: 2, name: '生成大纲预览', tool: 'generate_outline_preview', mode: 'act', requiresApproval: false, args: { context: '{{steps.1.output}}', instruction: goal, volumeNo, chapterCount } },
          { stepNo: 3, name: '校验大纲预览', tool: 'validate_outline', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
          { stepNo: 4, name: '写入大纲到卷和章节', tool: 'persist_outline', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          { stepNo: 5, name: '汇总执行结果', tool: 'report_result', mode: 'act', requiresApproval: false, args: { taskType, summary: '大纲设计执行完成', outline: '{{steps.2.output}}', outlineValidation: '{{steps.3.output}}', persist: '{{steps.4.output}}' } },
        ],
        requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [4], tools: ['persist_outline'] } }],
      };
    }

    if (taskType === 'project_import_preview') {
      return {
        taskType,
        summary: `使用 ${skill.name} 处理文案拆解导入目标：${goal.slice(0, 120)}`,
        assumptions: [`文案拆解会先生成结构化预览，用户审批后才写入项目资料、角色、设定、卷和章节。`, `可用工具：${availableTools.join(', ')}`],
        risks: this.rules.listHardRules(),
        steps: [
          { stepNo: 1, name: '分析原始文案', tool: 'analyze_source_text', mode: 'act', requiresApproval: false, args: { sourceText: goal } },
          { stepNo: 2, name: '构建导入预览', tool: 'build_import_preview', mode: 'act', requiresApproval: false, args: { analysis: '{{steps.1.output}}', instruction: goal } },
          { stepNo: 3, name: '校验导入预览', tool: 'validate_imported_assets', mode: 'act', requiresApproval: false, args: { preview: '{{steps.2.output}}' } },
          { stepNo: 4, name: '写入项目资料', tool: 'persist_project_assets', mode: 'act', requiresApproval: true, args: { preview: '{{steps.2.output}}' } },
          { stepNo: 5, name: '汇总执行结果', tool: 'report_result', mode: 'act', requiresApproval: false, args: { taskType, summary: '文案拆解导入执行完成', importPreview: '{{steps.2.output}}', importValidation: '{{steps.3.output}}', persist: '{{steps.4.output}}' } },
        ],
        requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [4], tools: ['persist_project_assets'] } }],
      };
    }

    return {
      taskType,
      summary: `使用 ${skill.name} 处理目标：${goal}`,
      assumptions: [`当前为 Agent-Centric MVP，同步执行最小闭环。`, `可用工具：${availableTools.join(', ')}`],
      risks: this.rules.listHardRules(),
      steps: [{ stepNo: 1, name: '生成执行报告', tool: 'echo_report', mode: 'act', requiresApproval: true, args: { message: goal } }],
      requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [1], tools: ['echo_report'] } }],
    };
  }

  /**
   * 调用 LLM 生成结构化计划，但只接受 ToolRegistry 已注册工具，并重新派生审批清单。
   * 这样即使模型输出伪造工具、遗漏审批或返回脏 JSON，也不会绕过后端 Policy。
   */
  private async createLlmPlan(goal: string, baseline: AgentPlanSpec, llmBudget: PlannerLlmBudget): Promise<AgentPlanSpec> {
    const tools = this.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
    }));
    const skill = this.skills.select(baseline.taskType);
    const hardRules = this.rules.listHardRules();

    const messages = [
      {
        role: 'system' as const,
        content: [
          '你是 CreativeAgent Planner。你只能输出严格 JSON，不要 Markdown。',
          '你不能编造工具，steps[].tool 必须来自 Available Tools。',
          'Plan 阶段不写正式业务表；所有真实副作用只能在 act mode 的 Tool 中声明，并由后端审批。',
          '保留 baseline 的任务意图和安全边界，可优化 summary、assumptions、risks、step name 和 args。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify(
          {
            userGoal: goal,
            selectedSkill: skill,
            hardRules,
            availableTools: tools,
            baselinePlan: baseline,
            outputContract: {
              taskType: 'string',
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
      return { ...this.validateAndNormalizeLlmPlan(data, baseline), plannerDiagnostics: { source: 'llm', model: result.model, usage: result.usage, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 1 } };
    } catch (error) {
      llmBudget.failures.push(this.failureDetail('schema_validation', error));
      return this.repairLlmPlan(goal, baseline, data, error instanceof Error ? error.message : String(error), llmBudget);
    }
  }

  private async repairLlmPlan(goal: string, baseline: AgentPlanSpec, invalidPlan: unknown, validationError: string, llmBudget: PlannerLlmBudget): Promise<AgentPlanSpec> {
    const registeredTools = this.tools.list().map((tool) => ({ name: tool.name, requiresApproval: tool.requiresApproval, riskLevel: tool.riskLevel, sideEffects: tool.sideEffects }));
    this.consumeLlmCall(llmBudget, 'repair_plan');
    const { data, result } = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            '你是 CreativeAgent Planner 修复器。你只能输出严格 JSON，不要 Markdown。',
            '必须修复 invalidPlan，使 steps[].tool 全部来自 registeredTools，taskType 必须等于 baseline.taskType。',
            '如果无法安全修复，直接输出 baselinePlan。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              userGoal: goal,
              baselinePlan: baseline,
              invalidPlan,
              validationError,
              registeredTools,
            },
            null,
            2,
          ),
        },
      ],
      { appStep: 'agent_planner', maxTokens: 4500, timeoutMs: 90_000, retries: 1, temperature: 0.1 },
    );

    return { ...this.validateAndNormalizeLlmPlan(data, baseline), plannerDiagnostics: { source: 'llm_repair', model: result.model, usage: result.usage, repairedFromError: validationError, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 1 } };
  }

  private validateAndNormalizeLlmPlan(data: unknown, baseline: AgentPlanSpec): AgentPlanSpec {
    const record = this.asRecord(data);
    const registeredTools = new Set(this.tools.list().map((tool) => tool.name));
    const toolRequiresApproval = new Map(this.tools.list().map((tool) => [tool.name, tool.requiresApproval]));
    const rawSteps = Array.isArray(record.steps) ? record.steps : [];
    const maxSteps = this.rules.getPolicy().limits.maxSteps;
    if (!rawSteps.length || rawSteps.length > maxSteps) throw new Error(`LLM Plan steps 数量非法，最多 ${maxSteps} 步`);
    if (typeof record.taskType === 'string' && record.taskType !== baseline.taskType) throw new Error(`LLM Plan taskType 越界：${record.taskType}`);

    const steps = rawSteps.map((item, index): AgentPlanStepSpec => {
      const step = this.asRecord(item);
      if (!Object.keys(step).length) throw new Error(`LLM Plan 第 ${index + 1} 步不是对象`);
      if (step.stepNo !== undefined && typeof step.stepNo !== 'number') throw new Error(`LLM Plan 第 ${index + 1} 步 stepNo 非数字`);
      if (step.mode !== undefined && step.mode !== 'act') throw new Error(`LLM Plan 第 ${index + 1} 步 mode 必须为 act`);
      const tool = typeof step.tool === 'string' ? step.tool : '';
      if (!registeredTools.has(tool)) throw new Error(`LLM Plan 使用未注册工具：${tool}`);
      const args = this.asRecord(step.args);
      this.assertArgsOnlyReferencePreviousSteps(args, index + 1);
      return {
        stepNo: index + 1,
        name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : `执行 ${tool}`,
        tool,
        mode: 'act',
        // 审批需求以后端 Tool 元数据为准，避免模型把写入类工具降级为无需审批。
        requiresApproval: toolRequiresApproval.get(tool) ?? Boolean(step.requiresApproval),
        args,
      };
    });

    const approvalSteps = steps.filter((step) => step.requiresApproval);
    return {
      taskType: typeof record.taskType === 'string' && record.taskType === baseline.taskType ? record.taskType : baseline.taskType,
      summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : baseline.summary,
      assumptions: this.stringArray(record.assumptions, baseline.assumptions),
      risks: this.stringArray(record.risks, baseline.risks),
      steps,
      requiredApprovals: approvalSteps.length
        ? [{ approvalType: 'plan', target: { stepNos: approvalSteps.map((step) => step.stepNo), tools: approvalSteps.map((step) => step.tool) } }]
        : [],
    };
  }

  /** 统计 Planner 的模型调用次数，避免 JSON 修复循环失控。 */
  private consumeLlmCall(budget: PlannerLlmBudget, stage: string) {
    if (budget.used >= budget.max) throw new Error(`Planner LLM 调用超过上限：${budget.max}（阶段：${stage}）`);
    budget.used += 1;
  }

  /** 校验 Tool 参数中的变量引用只能读取前序步骤输出，避免计划形成循环依赖。 */
  private assertArgsOnlyReferencePreviousSteps(value: unknown, currentStepNo: number) {
    if (typeof value === 'string') {
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

  private classify(goal: string): string {
    // 大纲类语句常包含“章节”，需先于章节正文写作判断，避免“章节大纲”被误判为 chapter_write。
    if (/大纲|卷|拆成\s*\d+\s*章|分成\s*\d+\s*章|章节大纲/.test(goal)) return 'outline_design';
    if (/文案|拆解|角色|世界观/.test(goal)) return 'project_import_preview';
    if (/润色|修改|改稿|修稿|去AI味|去 AI 味|优化文风/.test(goal)) return 'chapter_polish';
    if (/第\s*\d+\s*章|章节|正文/.test(goal)) return 'chapter_write';
    return 'general';
  }

  private extractChapterNo(goal: string): number | undefined {
    const match = goal.match(/第\s*(\d+)\s*章/);
    return match ? Number(match[1]) : undefined;
  }

  private extractWordCount(goal: string): number | undefined {
    const match = goal.match(/(\d{3,5})\s*字/);
    return match ? Number(match[1]) : undefined;
  }

  private extractChapterCount(goal: string): number | undefined {
    const match = goal.match(/拆成\s*(\d+)\s*章|分成\s*(\d+)\s*章|(\d+)\s*章/);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    return value ? Number(value) : undefined;
  }

  private extractVolumeNo(goal: string): number | undefined {
    const match = goal.match(/第\s*(\d+)\s*卷/);
    return match ? Number(match[1]) : undefined;
  }
}