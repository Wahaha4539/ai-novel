import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** 负责落库 AgentStep，保证每个决策、LLM 调用和工具调用都可追踪和排错。 */
@Injectable()
export class AgentTraceService {
  constructor(private readonly prisma: PrismaService) {}

  startStep(agentRunId: string, stepNo: number, data: { stepType: string; name: string; toolName?: string; mode: string; input?: unknown }) {
    const input = data.input === undefined ? undefined : (data.input as Prisma.InputJsonValue);
    return this.prisma.agentStep.upsert({
      where: { agentRunId_stepNo: { agentRunId, stepNo } },
      create: { agentRunId, stepNo, stepType: data.stepType, name: data.name, toolName: data.toolName, mode: data.mode, input, status: 'running', startedAt: new Date() },
      update: { stepType: data.stepType, name: data.name, toolName: data.toolName, mode: data.mode, input, status: 'running', startedAt: new Date(), error: null },
    });
  }

  finishStep(agentRunId: string, stepNo: number, output: unknown) {
    return this.prisma.agentStep.update({ where: { agentRunId_stepNo: { agentRunId, stepNo } }, data: { status: 'succeeded', output: output as Prisma.InputJsonValue, finishedAt: new Date() } });
  }

  failStep(agentRunId: string, stepNo: number, error: unknown) {
    const normalized = this.formatError(error);
    return this.prisma.agentStep.update({
      where: { agentRunId_stepNo: { agentRunId, stepNo } },
      data: { status: 'failed', error: normalized.message, output: normalized.detail as Prisma.InputJsonValue, finishedAt: new Date() },
    });
  }

  /** 记录非 Tool 型步骤，例如 Planner 的 LLM/fallback 决策，使用 stepNo=0 避免和计划步骤冲突。 */
  recordDecision(agentRunId: string, data: { stepNo?: number; name: string; mode: string; input?: unknown; output?: unknown; status?: 'succeeded' | 'failed'; error?: unknown }) {
    const stepNo = data.stepNo ?? 0;
    const now = new Date();
    return this.prisma.agentStep.upsert({
      where: { agentRunId_stepNo: { agentRunId, stepNo } },
      create: {
        agentRunId,
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