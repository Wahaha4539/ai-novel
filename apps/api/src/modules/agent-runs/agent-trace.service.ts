import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** 负责落库 AgentStep，保证每个决策、LLM 调用和工具调用都可追踪和排错。 */
@Injectable()
export class AgentTraceService {
  constructor(private readonly prisma: PrismaService) {}

  /** 开始或重置某个计划版本下的步骤 trace；同 stepNo 的 Plan/Act 记录不会互相覆盖。 */
  startStep(agentRunId: string, stepNo: number, data: { stepType: string; name: string; toolName?: string; mode: string; planVersion?: number; input?: unknown }) {
    const input = data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue);
    const planVersion = data.planVersion ?? 1;
    return this.prisma.agentStep.upsert({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode: data.mode, planVersion, stepNo } },
      create: { agentRunId, planVersion, stepNo, stepType: data.stepType, name: data.name, toolName: data.toolName, mode: data.mode, input, status: 'running', startedAt: new Date() },
      update: { stepType: data.stepType, name: data.name, toolName: data.toolName, input, status: 'running', startedAt: new Date(), error: null },
    });
  }

  /** 标记步骤成功，并把 Tool 输出保存为后续步骤和失败续跑的可校验输入。 */
  finishStep(agentRunId: string, stepNo: number, output: unknown, mode: string = 'act', planVersion = 1) {
    return this.prisma.agentStep.update({ where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } }, data: { status: 'succeeded', output: output as Prisma.InputJsonValue, finishedAt: new Date() } });
  }

  /** 标记步骤暂停等待人工复核；用于二次确认缺失等非失败型审批中断。 */
  reviewStep(agentRunId: string, stepNo: number, error: unknown, mode: string = 'act', planVersion = 1) {
    const normalized = this.formatError(error);
    return this.prisma.agentStep.update({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } },
      data: { status: 'waiting_review', error: normalized.message, output: normalized.detail as Prisma.InputJsonValue, finishedAt: new Date() },
    });
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
  failStep(agentRunId: string, stepNo: number, error: unknown, mode: string = 'act', planVersion = 1) {
    const normalized = this.formatError(error);
    return this.prisma.agentStep.update({
      where: { agentRunId_mode_planVersion_stepNo: { agentRunId, mode, planVersion, stepNo } },
      data: { status: 'failed', error: normalized.message, output: normalized.detail as Prisma.InputJsonValue, finishedAt: new Date() },
    });
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
  private formatError(error: unknown): { message: string; detail: Record<string, unknown> } {
    if (error && typeof error === 'object' && 'message' in error) {
      const record = error as Record<string, unknown>;
      const message = typeof record.message === 'string' ? record.message : JSON.stringify(record);
      return { message, detail: record };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { message, detail: { message, errorType: error instanceof Error ? error.name : typeof error } };
  }
}