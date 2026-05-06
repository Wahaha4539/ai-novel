import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolProgressPatch } from '../agent-tools/base-tool';

const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
const RUN_LEASE_RENEW_MS = 120_000;

/** 负责落库 AgentStep，保证每个决策、LLM 调用和工具调用都可追踪和排错。 */
@Injectable()
export class AgentTraceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 开始或重置某个计划版本下的步骤 trace；同 stepNo 的 Plan/Act 记录不会互相覆盖。 */
  async startStep(agentRunId: string, stepNo: number, data: { stepType: string; name: string; toolName?: string; mode: string; planVersion?: number; input?: unknown; deadlineMs?: number }) {
    const input = data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue);
    const planVersion = data.planVersion ?? 1;
    const now = new Date();
    const deadlineAt = data.deadlineMs ? new Date(now.getTime() + data.deadlineMs) : null;
    const createData: Record<string, unknown> = {
      agentRunId,
      planVersion,
      stepNo,
      stepType: data.stepType,
      name: data.name,
      toolName: data.toolName,
      mode: data.mode,
      input,
      status: 'running',
      phase: null,
      phaseMessage: null,
      progressCurrent: null,
      progressTotal: null,
      startedAt: now,
      heartbeatAt: now,
      timeoutAt: null,
      deadlineAt,
      finishedAt: null,
      error: null,
      errorCode: null,
      errorDetail: undefined,
      metadata: {},
    };
    const updateData: Record<string, unknown> = {
      stepType: data.stepType,
      name: data.name,
      toolName: data.toolName,
      input,
      status: 'running',
      phase: null,
      phaseMessage: null,
      progressCurrent: null,
      progressTotal: null,
      startedAt: now,
      heartbeatAt: now,
      timeoutAt: null,
      deadlineAt,
      finishedAt: null,
      error: null,
      errorCode: null,
      errorDetail: undefined,
      metadata: {},
    };
    const step = await this.prisma.agentStep.upsert({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode: data.mode, planVersion, stepNo } },
      create: createData as never,
      update: updateData as never,
    });
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
      data: {
        currentStepNo: stepNo,
        currentTool: data.toolName ?? null,
        currentPhase: null,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_RENEW_MS),
      },
    });
    return step;
  }

  async updateStepPhase(agentRunId: string, stepNo: number, patch: ToolProgressPatch, mode: string = 'act', planVersion = 1) {
    const now = new Date();
    const data = this.buildProgressData(patch, now);
    await this.prisma.agentStep.updateMany({
      where: { agentRunId, stepNo, mode, planVersion, status: 'running' },
      data: data as never,
    });
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
      data: {
        ...(patch.phase !== undefined ? { currentPhase: patch.phase } : {}),
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_RENEW_MS),
      },
    });
  }

  async heartbeatStep(agentRunId: string, stepNo: number, patch?: ToolProgressPatch, mode: string = 'act', planVersion = 1) {
    if (patch && Object.keys(patch).length) {
      await this.updateStepPhase(agentRunId, stepNo, patch, mode, planVersion);
      return;
    }
    const now = new Date();
    await this.prisma.agentStep.updateMany({
      where: { agentRunId, stepNo, mode, planVersion, status: 'running' },
      data: { heartbeatAt: now },
    });
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_RENEW_MS) },
    });
  }

  /** 标记步骤成功，并把 Tool 输出保存为后续步骤和失败续跑的可校验输入。 */
  async finishStep(agentRunId: string, stepNo: number, output: unknown, mode: string = 'act', planVersion = 1, metadata?: unknown) {
    const data: Record<string, unknown> = { status: 'succeeded', output: output as Prisma.InputJsonValue, finishedAt: new Date(), heartbeatAt: new Date() };
    if (metadata !== undefined) data.metadata = metadata as Prisma.InputJsonValue;
    const result = await this.prisma.agentStep.updateMany({ where: { agentRunId, stepNo, mode, planVersion, status: 'running' }, data: data as never });
    if (result.count === 1) return this.prisma.agentStep.findUnique({ where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } } });
    return this.prisma.agentStep.findUnique({ where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } } });
  }

  /** 标记步骤暂停等待人工复核；用于二次确认缺失等非失败型审批中断。 */
  async reviewStep(agentRunId: string, stepNo: number, error: unknown, mode: string = 'act', planVersion = 1, metadata?: unknown) {
    const normalized = this.formatError(error);
    const data: Record<string, unknown> = {
      status: 'waiting_review',
      error: normalized.message,
      output: normalized.detail as Prisma.InputJsonValue,
      errorCode: this.extractErrorCode(error, normalized),
      errorDetail: normalized.detail as Prisma.InputJsonValue,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
    };
    if (metadata !== undefined) data.metadata = metadata as Prisma.InputJsonValue;
    await this.prisma.agentStep.updateMany({
      where: { agentRunId, stepNo, mode, planVersion, status: 'running' },
      data: data as never,
    });
    return this.prisma.agentStep.findUnique({ where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } } });
  }

  /** 记录条件分支跳过的步骤，保留 runIf 输入，方便用户理解为什么二次修复链路没有执行。 */
  skipStep(agentRunId: string, stepNo: number, data: { stepType: string; name: string; toolName?: string; mode: string; planVersion?: number; input?: unknown }) {
    const planVersion = data.planVersion ?? 1;
    const now = new Date();
    return this.prisma.agentStep.upsert({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode: data.mode, planVersion, stepNo } },
      create: { agentRunId, planVersion, stepNo, stepType: data.stepType, name: data.name, toolName: data.toolName, mode: data.mode, input: data.input as Prisma.InputJsonValue, status: 'skipped', startedAt: now, finishedAt: now },
      update: { stepType: data.stepType, name: data.name, toolName: data.toolName, input: data.input as Prisma.InputJsonValue, status: 'skipped', startedAt: now, finishedAt: now, error: null },
    });
  }

  /** 标记步骤失败，同时保留结构化错误详情，便于前端展示和生产排障。 */
  async failStep(agentRunId: string, stepNo: number, error: unknown, mode: string = 'act', planVersion = 1, metadata?: unknown) {
    const normalized = this.formatError(error);
    const data: Record<string, unknown> = {
      status: 'failed',
      error: normalized.message,
      output: normalized.detail as Prisma.InputJsonValue,
      errorCode: this.extractErrorCode(error, normalized),
      errorDetail: normalized.detail as Prisma.InputJsonValue,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
    };
    if (metadata !== undefined) data.metadata = metadata as Prisma.InputJsonValue;
    await this.prisma.agentStep.updateMany({
      where: { agentRunId, stepNo, mode, planVersion, status: 'running' },
      data: data as never,
    });
    return this.prisma.agentStep.findUnique({ where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } } });
  }

  /** 记录非 Tool 型步骤，例如 Planner 的 LLM/fallback 决策，使用 stepNo=0 避免和计划步骤冲突。 */
  recordDecision(agentRunId: string, data: { stepNo?: number; planVersion?: number; name: string; mode: string; input?: unknown; output?: unknown; status?: 'succeeded' | 'failed'; error?: unknown }) {
    const stepNo = data.stepNo ?? 0;
    const planVersion = data.planVersion ?? 1;
    const now = new Date();
    return this.prisma.agentStep.upsert({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode: data.mode, planVersion, stepNo } },
      create: {
        agentRunId,
        planVersion,
        stepNo,
        stepType: 'decision',
        name: data.name,
        status: data.status ?? (data.error ? 'failed' : 'succeeded'),
        mode: data.mode,
        input: data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue),
        output: data.output === undefined ? undefined : (data.output as Prisma.InputJsonValue),
        error: data.error === undefined ? undefined : data.error instanceof Error ? data.error.message : String(data.error),
        startedAt: now,
        finishedAt: now,
      },
      update: {
        name: data.name,
        status: data.status ?? (data.error ? 'failed' : 'succeeded'),
        mode: data.mode,
        input: data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue),
        output: data.output === undefined ? undefined : (data.output as Prisma.InputJsonValue),
        error: data.error === undefined ? null : data.error instanceof Error ? data.error.message : String(data.error),
        startedAt: now,
        finishedAt: now,
      },
    });
  }

  /** 同时保留短错误文本和结构化详情，兼顾列表展示与排障分析。 */
  private buildProgressData(patch: ToolProgressPatch, now: Date): Record<string, unknown> {
    return {
      heartbeatAt: now,
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.phaseMessage !== undefined ? { phaseMessage: patch.phaseMessage } : {}),
      ...(patch.progressCurrent !== undefined ? { progressCurrent: patch.progressCurrent } : {}),
      ...(patch.progressTotal !== undefined ? { progressTotal: patch.progressTotal } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutAt: new Date(now.getTime() + patch.timeoutMs) } : patch.phase !== undefined ? { timeoutAt: null } : {}),
      ...(patch.deadlineMs !== undefined ? { deadlineAt: new Date(now.getTime() + patch.deadlineMs) } : {}),
    };
  }

  private extractErrorCode(error: unknown, normalized: { detail: Record<string, unknown> }) {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    if (typeof record.code === 'string') return record.code;
    if (typeof record.errorCode === 'string') return record.errorCode;
    const nested = this.asRecord(record.error);
    if (typeof nested?.code === 'string') return nested.code;
    const detailError = this.asRecord(normalized.detail.error);
    if (typeof detailError?.code === 'string') return detailError.code;
    return undefined;
  }

  private formatError(error: unknown): { message: string; detail: Record<string, unknown> } {
    if (error && typeof error === 'object' && 'message' in error) {
      const record = error as Record<string, unknown>;
      const message = typeof record.message === 'string' ? record.message : JSON.stringify(record);
      return { message, detail: record };
    }
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const nested = this.asRecord(record.error);
      const message = typeof nested?.message === 'string' ? nested.message : JSON.stringify(record);
      return { message, detail: record };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { message, detail: { message, errorType: error instanceof Error ? error.name : typeof error } };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }
}
