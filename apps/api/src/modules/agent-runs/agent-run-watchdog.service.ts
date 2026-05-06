import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { PrismaService } from '../../prisma/prisma.service';

const WATCHDOG_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 120_000;
const ACTIVE_RUN_STATUSES = ['planning', 'acting'] as const;

type WatchdogErrorCode = 'TOOL_PHASE_TIMEOUT' | 'TOOL_STUCK_TIMEOUT' | 'RUN_DEADLINE_EXCEEDED';

@Injectable()
export class AgentRunWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLogger(AgentRunWatchdogService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => this.logger.error('agent.watchdog.scan_failed', error));
    }, WATCHDOG_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async scanOnce(now = new Date()) {
    const phaseTimedOutSteps = await this.prisma.agentStep.findMany({
      where: { status: 'running', timeoutAt: { lt: now } },
      orderBy: { timeoutAt: 'asc' },
      take: 50,
    });
    for (const step of phaseTimedOutSteps) {
      await this.failStepAndRun(step, 'TOOL_PHASE_TIMEOUT', now, `${step.phase ?? 'unknown'} 阶段超过业务超时时间`);
    }

    const staleBefore = new Date(now.getTime() - HEARTBEAT_STALE_MS);
    const staleSteps = await this.prisma.agentStep.findMany({
      where: {
        status: 'running',
        AND: [
          { OR: [{ timeoutAt: null }, { timeoutAt: { lt: now } }] },
        ],
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, startedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { startedAt: 'asc' },
      take: 50,
    });
    for (const step of staleSteps) {
      await this.failStepAndRun(step, 'TOOL_STUCK_TIMEOUT', now, '系统检测到步骤卡住，长时间没有心跳');
    }

    const expiredRuns = await this.prisma.agentRun.findMany({
      where: { status: { in: [...ACTIVE_RUN_STATUSES] }, deadlineAt: { lt: now } },
      orderBy: { deadlineAt: 'asc' },
      take: 50,
    });
    for (const run of expiredRuns) {
      await this.failRunDeadline(run.id, now);
    }
  }

  private async failStepAndRun(
    step: { id: string; agentRunId: string; stepNo: number; mode: string; planVersion: number; toolName: string | null; phase: string | null; timeoutAt: Date | null; deadlineAt: Date | null; heartbeatAt: Date | null },
    code: WatchdogErrorCode,
    now: Date,
    message: string,
  ) {
    const detail = {
      code,
      message,
      stepNo: step.stepNo,
      mode: step.mode,
      planVersion: step.planVersion,
      toolName: step.toolName,
      phase: step.phase,
      timeoutAt: step.timeoutAt,
      deadlineAt: step.deadlineAt,
      heartbeatAt: step.heartbeatAt,
      detectedAt: now,
    };
    const updatedStep = await this.prisma.agentStep.updateMany({
      where: { id: step.id, status: 'running' },
      data: {
        status: 'failed',
        error: message,
        errorCode: code,
        errorDetail: detail as unknown as Prisma.InputJsonValue,
        output: detail as unknown as Prisma.InputJsonValue,
        finishedAt: now,
        heartbeatAt: now,
      },
    });
    if (updatedStep.count !== 1) return;
    await this.failRun(step.agentRunId, code, message, detail, now);
    this.logger.warn('agent.watchdog.step_failed', { agentRunId: step.agentRunId, stepNo: step.stepNo, mode: step.mode, planVersion: step.planVersion, code, phase: step.phase });
  }

  private async failRunDeadline(agentRunId: string, now: Date) {
    const message = 'AgentRun 超过系统执行期限';
    const detail = { code: 'RUN_DEADLINE_EXCEEDED', message, detectedAt: now };
    await this.prisma.agentStep.updateMany({
      where: { agentRunId, status: 'running' },
      data: {
        status: 'failed',
        error: message,
        errorCode: 'RUN_DEADLINE_EXCEEDED',
        errorDetail: detail as Prisma.InputJsonValue,
        finishedAt: now,
        heartbeatAt: now,
      },
    });
    await this.failRun(agentRunId, 'RUN_DEADLINE_EXCEEDED', message, detail, now);
  }

  private async failRun(agentRunId: string, code: WatchdogErrorCode, message: string, detail: Record<string, unknown>, now: Date) {
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: {
        status: 'failed',
        error: message,
        output: { latestObservation: { error: { code, message, retryable: true }, watchdog: detail } } as unknown as Prisma.InputJsonValue,
        currentPhase: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
      },
    });
  }
}
