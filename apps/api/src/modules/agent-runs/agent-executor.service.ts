import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolJsonSchema, ToolSchemaType } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { AgentPolicyService } from './agent-policy.service';
import { AgentPlanStepSpec } from './agent-planner.service';
import { AgentTraceService } from './agent-trace.service';

interface AgentExecuteOptions {
  mode?: 'plan' | 'act';
  planVersion?: number;
  approved?: boolean;
  approvedStepNos?: number[];
  confirmation?: { confirmHighRisk?: boolean; confirmedRiskIds?: string[] };
  previewOnly?: boolean;
  reuseSucceeded?: boolean;
}

export class AgentWaitingReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentWaitingReviewError';
  }
}

export class AgentCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCancelledError';
  }
}

interface AgentStepExecutionError {
  stepNo: number;
  toolName: string;
  mode: 'plan' | 'act';
  errorType: string;
  message: string;
}

/** 遍历已审批计划并执行 Tool，当前为同步进程内函数调用，不依赖外部 Worker。 */
@Injectable()
export class AgentExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: ToolRegistryService,
    private readonly policy: AgentPolicyService,
    private readonly trace: AgentTraceService,
  ) {}

  /**
   * 同步执行已审批 Plan。输入为计划步骤和审批范围，输出按 stepNo 汇总。
   * 副作用：会写入 AgentStep trace；高风险未显式审批时会中断并交回人工复核。
   */
  async execute(agentRunId: string, steps: AgentPlanStepSpec[], approvedOrOptions: boolean | AgentExecuteOptions = false, approvedStepNos?: number[]) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new BadRequestException(`AgentRun 不存在：${agentRunId}`);

    const options: AgentExecuteOptions = typeof approvedOrOptions === 'boolean' ? { mode: 'act', approved: approvedOrOptions, approvedStepNos } : approvedOrOptions;
    const mode = options.mode ?? 'act';
    const planVersion = options.planVersion ?? 1;
    const outputs: Record<number, unknown> = options.reuseSucceeded ? await this.loadReusableOutputs(agentRunId, mode, planVersion, steps) : {};
    const plannedTools = steps.map((step) => step.tool);
    this.policy.assertPlanExecutable(steps);

    for (const step of steps) {
      await this.assertRunNotCancelled(agentRunId);
      const tool = this.tools.get(step.tool);
      if (!tool) throw new BadRequestException(`未注册工具：${step.tool}`);

      // Plan 阶段只允许执行无副作用且无需审批的预览步骤，遇到写入类步骤立即停止。
      if (options.previewOnly && (tool.requiresApproval || tool.sideEffects.length > 0)) break;

      if (options.reuseSucceeded && outputs[step.stepNo] !== undefined) continue;

      const hasExplicitApprovalScope = Array.isArray(options.approvedStepNos);
      const stepApproved = Boolean(options.approved) && (!hasExplicitApprovalScope || options.approvedStepNos!.includes(step.stepNo));
      if (tool.riskLevel === 'high' && !stepApproved) {
        throw new AgentWaitingReviewError(`高风险工具 ${tool.name} 需要显式审批步骤 ${step.stepNo}`);
      }

      const resolvedArgs = this.resolveValue(step.args, outputs) as Record<string, unknown>;
      await this.trace.startStep(agentRunId, step.stepNo, { stepType: 'tool', name: step.name, toolName: step.tool, mode, planVersion, input: resolvedArgs });
      try {
        const context = { agentRunId, projectId: run.projectId, chapterId: run.chapterId ?? undefined, mode, approved: stepApproved, outputs, policy: { confirmation: options.confirmation } };
        this.policy.assertAllowed(tool, context, plannedTools);
        this.assertSchema(tool.inputSchema, resolvedArgs, `${tool.name}.input`);
        const output = await this.withTimeout(tool.run(resolvedArgs, context), 120_000, `工具 ${tool.name} 执行超时`);
        this.assertSchema(tool.outputSchema, output, `${tool.name}.output`);
        outputs[step.stepNo] = output;
        await this.trace.finishStep(agentRunId, step.stepNo, output, mode, planVersion);
      } catch (error) {
        await this.trace.failStep(agentRunId, step.stepNo, this.formatStepError(step.stepNo, tool.name, mode, error), mode, planVersion);
        throw error;
      }
    }

    return outputs;
  }

  /**
   * 失败重试/Act 执行时复用已成功输出，避免重复 LLM 预览、重复创建草稿或重复写入项目资产。
   * Act 优先复用同 mode 的成功输出；缺失时可复用同版本 Plan 阶段的无副作用预览输出，让审批看到的内容进入 Act 依赖链。
   */
  private async loadReusableOutputs(agentRunId: string, mode: 'plan' | 'act', planVersion: number, steps: AgentPlanStepSpec[]): Promise<Record<number, unknown>> {
    const records = await this.prisma.agentStep.findMany({ where: { agentRunId, mode, planVersion, status: 'succeeded' }, orderBy: { stepNo: 'asc' } });
    const plannedByStepNo = new Map(steps.map((step) => [step.stepNo, step.tool]));
    const outputs: Record<number, unknown> = {};
    this.mergeReusableStepOutputs(outputs, records, plannedByStepNo, false);

    if (mode === 'act') {
      const planPreviewRecords = await this.prisma.agentStep.findMany({ where: { agentRunId, mode: 'plan', planVersion, status: 'succeeded' }, orderBy: { stepNo: 'asc' } });
      this.mergeReusableStepOutputs(outputs, planPreviewRecords, plannedByStepNo, true);
    }

    return outputs;
  }

  /** 只复用“当前计划 stepNo + toolName 完全一致且输出仍符合 Tool Schema”的记录，防止 replan 后误用旧输出。 */
  private mergeReusableStepOutputs(outputs: Record<number, unknown>, records: Array<{ stepNo: number; toolName: string | null; output: unknown }>, plannedByStepNo: Map<number, string>, planPreviewOnly: boolean) {
    for (const record of records) {
      if (outputs[record.stepNo] !== undefined) continue;
      const plannedToolName = plannedByStepNo.get(record.stepNo);
      if (!plannedToolName || plannedToolName !== record.toolName || record.output === null) continue;
      const tool = this.tools.get(plannedToolName);
      if (!tool) continue;
      // Plan 预览输出只能来自无副作用、无需审批的工具，避免把写入类步骤当成已执行。
      if (planPreviewOnly && (tool.requiresApproval || tool.sideEffects.length > 0)) continue;
      // 旧 trace 可能来自早期版本；复用前重新校验输出契约，失败则跳过并让 Executor 重跑该步骤。
      try {
        this.assertSchema(tool.outputSchema, record.output, `${plannedToolName}.cachedOutput`);
        outputs[record.stepNo] = record.output;
      } catch {
        continue;
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BadRequestException(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => timer && clearTimeout(timer));
  }

  /** 每个步骤前读取最新 Run 状态，让用户取消请求能尽快阻止后续 Tool 写入。 */
  private async assertRunNotCancelled(agentRunId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId }, select: { status: true } });
    if (run?.status === 'cancelled') throw new AgentCancelledError('AgentRun 已取消，停止执行后续步骤');
  }

  /** 将 Tool/Policy 异常结构化写入 AgentStep，便于前端和排障脚本直接展示失败原因。 */
  private formatStepError(stepNo: number, toolName: string, mode: 'plan' | 'act', error: unknown): AgentStepExecutionError {
    return {
      stepNo,
      toolName,
      mode,
      errorType: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private resolveValue(value: unknown, outputs: Record<number, unknown>): unknown {
    if (typeof value === 'string') {
      // 支持把前序步骤的完整输出对象作为 Tool 参数传递，避免对象被保留为模板字符串后触发 Schema 类型错误。
      const wholeOutputMatch = value.match(/^{{steps\.(\d+)\.output}}$/);
      if (wholeOutputMatch) return outputs[Number(wholeOutputMatch[1])];

      const match = value.match(/^{{steps\.(\d+)\.output\.([\w.]+)}}$/);
      if (!match) return value;
      return match[2].split('.').reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), outputs[Number(match[1])]);
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, outputs));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveValue(item, outputs)]));
    }
    return value;
  }

  /**
   * 执行 Tool 声明的轻量 JSON Schema 校验。
   * 这里只覆盖 Agent Tool 契约需要的对象、数组、基础类型和必填字段，避免额外引入运行时依赖。
   */
  private assertSchema(schema: ToolJsonSchema | undefined, value: unknown, path: string) {
    if (!schema) return;
    if (!this.matchesType(schema.type, value)) {
      throw new BadRequestException(`${path} 类型不符合 Tool Schema：期望 ${this.formatExpectedType(schema.type)}`);
    }
    if (schema.enum && !schema.enum.some((item) => item === value)) {
      throw new BadRequestException(`${path} 不在允许枚举值中`);
    }
    if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
      throw new BadRequestException(`${path} 长度不能小于 ${schema.minLength}`);
    }
    if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new BadRequestException(`${path} 长度不能大于 ${schema.maxLength}`);
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new BadRequestException(`${path} 格式不符合 Tool Schema`);
    }
    if (typeof value === 'number') {
      if (schema.integer && !Number.isInteger(value)) throw new BadRequestException(`${path} 必须是整数`);
      if (schema.minimum !== undefined && value < schema.minimum) throw new BadRequestException(`${path} 不能小于 ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new BadRequestException(`${path} 不能大于 ${schema.maximum}`);
    }

    if (this.schemaIncludesType(schema.type, 'object') && value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined || record[key] === null) throw new BadRequestException(`${path}.${key} 是必填字段`);
      }
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
        if (record[key] !== undefined) this.assertSchema(childSchema, record[key], `${path}.${key}`);
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        const extra = Object.keys(record).find((key) => !allowed.has(key));
        if (extra) throw new BadRequestException(`${path}.${extra} 不是允许的字段`);
      }
    }

    if (this.schemaIncludesType(schema.type, 'array') && Array.isArray(value) && schema.items) {
      if (schema.minItems !== undefined && value.length < schema.minItems) throw new BadRequestException(`${path} 数组长度不能小于 ${schema.minItems}`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new BadRequestException(`${path} 数组长度不能大于 ${schema.maxItems}`);
      value.forEach((item, index) => this.assertSchema(schema.items, item, `${path}[${index}]`));
    }
  }

  private matchesType(type: ToolJsonSchema['type'], value: unknown) {
    if (!type) return true;
    return (Array.isArray(type) ? type : [type]).some((item) => {
      if (item === 'array') return Array.isArray(value);
      if (item === 'null') return value === null;
      if (item === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
      return typeof value === item;
    });
  }

  private schemaIncludesType(type: ToolJsonSchema['type'], target: ToolSchemaType) {
    if (!type) return target === 'object';
    return (Array.isArray(type) ? type : [type]).includes(target);
  }

  private formatExpectedType(type: ToolJsonSchema['type']) {
    return Array.isArray(type) ? type.join(' | ') : type ?? 'any';
  }
}