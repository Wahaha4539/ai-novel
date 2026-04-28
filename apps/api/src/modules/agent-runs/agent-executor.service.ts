import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { ToolJsonSchema, ToolSchemaType } from '../agent-tools/base-tool';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { AgentContextV2 } from './agent-context-builder.service';
import { AgentExecutionObservationError, AgentObservation, AgentObservationErrorCode } from './agent-observation.types';
import { AgentPolicyService, AgentSecondConfirmationRequiredError } from './agent-policy.service';
import { AgentPlanStepSpec, AgentStepCondition } from './agent-planner.service';
import { AgentTraceService } from './agent-trace.service';

interface AgentExecuteOptions {
  mode?: 'plan' | 'act';
  planVersion?: number;
  approved?: boolean;
  approvedStepNos?: number[];
  confirmation?: { confirmHighRisk?: boolean; confirmedRiskIds?: string[] };
  previewOnly?: boolean;
  reuseSucceeded?: boolean;
  agentContext?: AgentContextV2;
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

interface RuntimeReferenceState {
  currentChapterId?: string;
  currentDraftId?: string;
}

/** 遍历已审批计划并执行 Tool，当前为同步进程内函数调用，不依赖外部 Worker。 */
@Injectable()
export class AgentExecutorService {
  private readonly logger = new StructuredLogger(AgentExecutorService.name);

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
    const runtimeState = this.deriveRuntimeState(outputs);
    const plannedTools = steps.map((step) => step.tool);
    const executeStartedAt = Date.now();
    this.logger.log('agent.executor.started', {
      agentRunId,
      mode,
      planVersion,
      stepCount: steps.length,
      plannedTools,
      approved: Boolean(options.approved),
      approvedStepNos: options.approvedStepNos,
      previewOnly: Boolean(options.previewOnly),
      reuseSucceeded: Boolean(options.reuseSucceeded),
      reusableStepNos: Object.keys(outputs).map(Number),
    });
    this.policy.assertPlanExecutable(steps);

    for (const step of steps) {
      await this.assertRunNotCancelled(agentRunId);
      const tool = this.tools.get(step.tool);
      if (!tool) throw new BadRequestException(`未注册工具：${step.tool}`);

      // Plan 阶段只允许执行无副作用且无需审批的预览步骤，遇到写入类步骤立即停止。
      if (options.previewOnly && (tool.requiresApproval || tool.sideEffects.length > 0)) {
        this.logger.log('agent.executor.preview_stopped', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: step.tool, requiresApproval: tool.requiresApproval, sideEffects: tool.sideEffects });
        break;
      }

      if (options.reuseSucceeded && outputs[step.stepNo] !== undefined) {
        this.logger.log('agent.step.reused', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: step.tool, output: this.summarizeValue(outputs[step.stepNo]) });
        continue;
      }

      if (!this.shouldRunStep(step.runIf, outputs, runtimeState)) {
        await this.trace.skipStep(agentRunId, step.stepNo, { stepType: 'tool', name: step.name, toolName: step.tool, mode, planVersion, input: { runIf: step.runIf } });
        this.logger.log('agent.step.skipped', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: step.tool, runIf: step.runIf, runtimeState });
        continue;
      }

      const hasExplicitApprovalScope = Array.isArray(options.approvedStepNos);
      const stepApproved = Boolean(options.approved) && (!hasExplicitApprovalScope || options.approvedStepNos!.includes(step.stepNo));
      if (tool.riskLevel === 'high' && !stepApproved) {
        this.logger.warn('agent.step.waiting_review.high_risk_approval_missing', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: tool.name, riskLevel: tool.riskLevel, approvedStepNos: options.approvedStepNos });
        throw new AgentWaitingReviewError(`高风险工具 ${tool.name} 需要显式审批步骤 ${step.stepNo}`);
      }

      const resolvedArgs = this.resolveValue(step.args, outputs, runtimeState, options.agentContext, steps, step.stepNo) as Record<string, unknown>;
      await this.trace.startStep(agentRunId, step.stepNo, { stepType: 'tool', name: step.name, toolName: step.tool, mode, planVersion, input: resolvedArgs });
      const stepStartedAt = Date.now();
      this.logger.log('agent.step.started', { agentRunId, mode, planVersion, stepNo: step.stepNo, stepName: step.name, tool: step.tool, approved: stepApproved, args: this.summarizeValue(resolvedArgs) });
      try {
        const context = { agentRunId, projectId: run.projectId, chapterId: run.chapterId ?? undefined, mode, approved: stepApproved, outputs, policy: { confirmation: options.confirmation } };
        this.policy.assertAllowed(tool, context, plannedTools);
        this.assertSchema(tool.inputSchema, resolvedArgs, `${tool.name}.input`);
        this.assertIdPolicy(tool, resolvedArgs, step.args, options.agentContext);
        const output = await this.withTimeout(tool.run(resolvedArgs, context), 120_000, `工具 ${tool.name} 执行超时`);
        this.assertSchema(tool.outputSchema, output, `${tool.name}.output`);
        outputs[step.stepNo] = output;
        this.updateRuntimeState(runtimeState, output);
        await this.trace.finishStep(agentRunId, step.stepNo, output, mode, planVersion);
        this.logger.log('agent.step.succeeded', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: step.tool, elapsedMs: Date.now() - stepStartedAt, output: this.summarizeValue(output), runtimeState });
      } catch (error) {
        if (error instanceof AgentSecondConfirmationRequiredError) {
          // 二次确认缺失是“等待用户复核”的暂停点，不应被记录成业务执行失败。
          await this.trace.reviewStep(agentRunId, step.stepNo, this.formatStepError(step.stepNo, tool.name, mode, error), mode, planVersion);
          this.logger.warn('agent.step.waiting_review.second_confirmation_required', { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: tool.name, elapsedMs: Date.now() - stepStartedAt, riskIds: error.riskIds });
          throw new AgentWaitingReviewError(error.message);
        }
        const observation = this.createObservation(step, tool.name, mode, resolvedArgs, outputs, error);
        await this.trace.failStep(agentRunId, step.stepNo, observation, mode, planVersion);
        this.logger.error('agent.step.failed', error, { agentRunId, mode, planVersion, stepNo: step.stepNo, tool: tool.name, elapsedMs: Date.now() - stepStartedAt, observation: this.summarizeValue(observation) });
        throw new AgentExecutionObservationError(observation);
      }
    }

    this.logger.log('agent.executor.completed', { agentRunId, mode, planVersion, elapsedMs: Date.now() - executeStartedAt, outputStepNos: Object.keys(outputs).map(Number) });
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

  /**
   * 把 Tool/Schema/Policy 异常转换为 AgentObservation，供 Runtime 写入诊断并触发有界 Replan。
   * 这里只做错误归类和缺参提取，不在 Executor 内直接修改计划，避免绕过审批边界。
   */
  private createObservation(step: AgentPlanStepSpec, toolName: string, mode: 'plan' | 'act', args: Record<string, unknown>, outputs: Record<number, unknown>, error: unknown): AgentObservation {
    const message = error instanceof Error ? error.message : String(error);
    const code = this.classifyObservationCode(message, error);
    return {
      stepId: step.id,
      stepNo: step.stepNo,
      tool: toolName,
      mode,
      args,
      error: {
        code,
        message,
        missing: code === 'MISSING_REQUIRED_ARGUMENT' ? this.extractMissingFields(message) : undefined,
        candidates: this.extractCandidates(error),
        retryable: this.isRetryableObservation(code),
      },
      previousOutputs: { ...outputs },
    };
  }

  private classifyObservationCode(message: string, error: unknown): AgentObservationErrorCode {
    if (/是必填字段/.test(message)) return 'MISSING_REQUIRED_ARGUMENT';
    if (/Tool Schema|类型不符合|不是允许的字段|格式不符合|不在允许枚举值|长度不能|不能小于|不能大于|必须是整数/.test(message)) return 'SCHEMA_VALIDATION_FAILED';
    // 自然语言直接进入 *.Id 字段属于可由 resolver 修复的参数问题，不能归为不可重试的策略阻断。
    // 例如 chapterId='第十二章' 应触发 Replanner 插入 resolve_chapter，而不是裸失败。
    if (/不能使用自然语言|伪造 ID/.test(message) && /Id/.test(message)) return 'SCHEMA_VALIDATION_FAILED';
    if (/不存在|未找到|找不到/.test(message)) return 'ENTITY_NOT_FOUND';
    if (/歧义|多个候选|不确定|AMBIGUOUS/i.test(message)) return 'AMBIGUOUS_ENTITY';
    if (/需要用户审批|需要显式审批/.test(message)) return 'APPROVAL_REQUIRED';
    if (/Policy|禁止|不允许|不能使用自然语言|伪造 ID/.test(message)) return 'POLICY_BLOCKED';
    if (/超时/.test(message)) return 'TOOL_TIMEOUT';
    return error instanceof BadRequestException ? 'VALIDATION_FAILED' : 'TOOL_INTERNAL_ERROR';
  }

  private extractMissingFields(message: string): string[] | undefined {
    const matches = [...message.matchAll(/\.([A-Za-z][\w]*) 是必填字段/g)].map((match) => match[1]);
    return matches.length ? matches : undefined;
  }

  private extractCandidates(error: unknown): unknown[] | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as Record<string, unknown>;
    return Array.isArray(record.candidates) ? record.candidates : undefined;
  }

  private isRetryableObservation(code: AgentObservationErrorCode): boolean {
    return ['MISSING_REQUIRED_ARGUMENT', 'SCHEMA_VALIDATION_FAILED', 'ENTITY_NOT_FOUND', 'AMBIGUOUS_ENTITY', 'TOOL_TIMEOUT', 'VALIDATION_FAILED'].includes(code);
  }

  /**
   * 生成日志安全摘要：输入任意 Tool 参数/输出，返回可 JSON 序列化的原值或截断预览。
   * 副作用：无；避免章节正文、召回上下文等大对象把本地日志刷爆。
   */
  private summarizeValue(value: unknown, maxLength = 2000): unknown {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    try {
      const json = JSON.stringify(value);
      if (json.length <= maxLength) return value;
      return { truncated: true, length: json.length, preview: json.slice(0, maxLength) };
    } catch {
      return { unserializable: true, valueType: typeof value };
    }
  }

  private resolveValue(value: unknown, outputs: Record<number, unknown>, runtimeState: RuntimeReferenceState = {}, agentContext?: AgentContextV2, steps: AgentPlanStepSpec[] = [], currentStepNo = Number.MAX_SAFE_INTEGER): unknown {
    if (typeof value === 'string') {
      const runtimeMatch = value.match(/^{{runtime\.(currentDraftId|currentChapterId)}}$/);
      if (runtimeMatch) return runtimeState[runtimeMatch[1] as keyof RuntimeReferenceState];

      const contextMatch = value.match(/^{{context\.([\w.]+)}}$/);
      if (contextMatch) return this.readPath(agentContext, contextMatch[1].split('.'));

      // 支持把前序步骤的完整输出对象作为 Tool 参数传递，避免对象被保留为模板字符串后触发 Schema 类型错误。
      const wholeOutputMatch = value.match(/^{{steps\.(\d+)\.output}}$/);
      if (wholeOutputMatch) {
        const refStepNo = Number(wholeOutputMatch[1]);
        if (refStepNo >= currentStepNo) throw new BadRequestException(`步骤 ${currentStepNo} 不能引用当前或未来步骤 ${refStepNo}`);
        return outputs[refStepNo];
      }

      const wholeNamedOutputMatch = value.match(/^{{steps\.([A-Za-z][\w-]*)\.output}}$/);
      if (wholeNamedOutputMatch) {
        const refStepNo = this.findStepNoById(steps, wholeNamedOutputMatch[1]);
        if (!refStepNo || refStepNo >= currentStepNo) throw new BadRequestException(`步骤 ${currentStepNo} 不能引用未知、当前或未来步骤 ID：${wholeNamedOutputMatch[1]}`);
        return outputs[refStepNo];
      }

      const match = value.match(/^{{steps\.(\d+)\.output\.([\w.]+)}}$/);
      if (match) {
        const refStepNo = Number(match[1]);
        if (refStepNo >= currentStepNo) throw new BadRequestException(`步骤 ${currentStepNo} 不能引用当前或未来步骤 ${refStepNo}`);
        return this.readPath(outputs[refStepNo], match[2].split('.'));
      }

      const namedMatch = value.match(/^{{steps\.([A-Za-z][\w-]*)\.output\.([\w.]+)}}$/);
      if (!namedMatch) return value;
      const refStepNo = this.findStepNoById(steps, namedMatch[1]);
      if (!refStepNo || refStepNo >= currentStepNo) throw new BadRequestException(`步骤 ${currentStepNo} 不能引用未知、当前或未来步骤 ID：${namedMatch[1]}`);
      return this.readPath(outputs[refStepNo], namedMatch[2].split('.'));
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, outputs, runtimeState, agentContext, steps, currentStepNo));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveValue(item, outputs, runtimeState, agentContext, steps, currentStepNo)]));
    }
    return value;
  }

  /** 根据 runIf 条件决定是否执行步骤，用于“有问题才二次润色/校验/修复”的有界分支。 */
  private shouldRunStep(condition: AgentStepCondition | undefined, outputs: Record<number, unknown>, runtimeState: RuntimeReferenceState): boolean {
    if (!condition) return true;
    const actual = this.resolveValue(condition.ref, outputs, runtimeState);
    switch (condition.operator) {
      case 'exists': return actual !== undefined && actual !== null;
      case 'not_exists': return actual === undefined || actual === null;
      case 'truthy': return Boolean(actual);
      case 'falsy': return !actual;
      case 'eq': return actual === condition.value;
      case 'neq': return actual !== condition.value;
      case 'gt': return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
      case 'gte': return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
      case 'lt': return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
      case 'lte': return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
      default: return false;
    }
  }

  /** 从已复用输出恢复当前草稿指针，保证失败续跑时后续 Tool 仍使用最新 draftId/chapterId。 */
  private deriveRuntimeState(outputs: Record<number, unknown>): RuntimeReferenceState {
    const state: RuntimeReferenceState = {};
    Object.keys(outputs).map(Number).sort((a, b) => a - b).forEach((stepNo) => this.updateRuntimeState(state, outputs[stepNo]));
    return state;
  }

  /** 写章、润色、修复和事实抽取都会返回 draftId/chapterId；后续步骤用运行时指针读取最新草稿。 */
  private updateRuntimeState(state: RuntimeReferenceState, output: unknown) {
    if (!output || typeof output !== 'object') return;
    const record = output as Record<string, unknown>;
    if (typeof record.chapterId === 'string' && record.chapterId.trim()) state.currentChapterId = record.chapterId;
    if (typeof record.draftId === 'string' && record.draftId.trim()) state.currentDraftId = record.draftId;
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

  /**
   * 执行前兜底检查 ID 来源：Resolver 和 context 引用允许通过，明显自然语言或伪造 ID 会被阻断。
   * 这是对 Planner 约束的运行时加固，避免 LLM 把“第十二章”直接塞进 chapterId。
   */
  private assertIdPolicy(tool: { name: string; manifest?: { idPolicy?: { allowedSources: string[] } } }, resolvedArgs: Record<string, unknown>, rawArgs: Record<string, unknown>, agentContext?: AgentContextV2) {
    const idEntries = this.collectIdEntries(resolvedArgs);
    for (const entry of idEntries) {
      if (typeof entry.value !== 'string' || !entry.value.trim()) continue;
      const rawValue = this.readPath(rawArgs, entry.path);
      const inheritedRawValue = rawValue ?? this.findNearestTemplateSource(rawArgs, entry.path);
      if (this.isAllowedIdSource(inheritedRawValue, tool.manifest?.idPolicy?.allowedSources ?? [], agentContext)) continue;
      if (!this.looksLikeUuid(entry.value)) throw new BadRequestException(`${tool.name}.${entry.path.join('.')} 必须来自上下文或 resolver，不能使用自然语言/伪造 ID：${entry.value}`);
    }
  }

  private collectIdEntries(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPath = [...path, key];
      const isIdField = /(^id$|Id$)/.test(key);
      return [
        ...(isIdField ? [{ path: childPath, value: child }] : []),
        ...this.collectIdEntries(child, childPath),
      ];
    });
  }

  private isAllowedIdSource(rawValue: unknown, allowedSources: string[], agentContext?: AgentContextV2) {
    if (typeof rawValue !== 'string') return false;
    if (rawValue.startsWith('{{runtime.')) return true;
    if (rawValue.startsWith('{{steps.')) return true;
    const contextMatch = rawValue.match(/^{{context\.([\w.]+)}}$/);
    if (!contextMatch) return false;
    const source = `context.${contextMatch[1]}`;
    const value = this.readPath(agentContext, contextMatch[1].split('.'));
    return value !== undefined && (!allowedSources.length || allowedSources.some((item) => item === source || item.endsWith(contextMatch[1])));
  }

  /** 当整个对象来自 {{steps.N.output}} 时，其内部 *.Id 字段继承该 resolver/前序步骤来源。 */
  private findNearestTemplateSource(rawArgs: Record<string, unknown>, path: string[]) {
    for (let length = path.length - 1; length >= 1; length -= 1) {
      const candidate = this.readPath(rawArgs, path.slice(0, length));
      if (typeof candidate === 'string' && candidate.startsWith('{{')) return candidate;
    }
    return undefined;
  }

  private readPath(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
  }

  private findStepNoById(steps: AgentPlanStepSpec[], stepId: string) {
    return steps.find((step) => step.id === stepId)?.stepNo;
  }

  private looksLikeUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}