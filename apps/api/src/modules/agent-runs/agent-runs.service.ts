import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAgentPlanDto, ReplanAgentRunDto } from './dto/create-agent-plan.dto';
import { ExecuteAgentRunDto } from './dto/execute-agent-run.dto';
import { AgentRuntimeService } from './agent-runtime.service';

@Injectable()
export class AgentRunsService {
  constructor(private readonly prisma: PrismaService, private readonly runtime: AgentRuntimeService) {}

  /**
   * 从现有 Run/Plan/Step/Approval/Artifact 表派生审计事件。
   * 当前不新增审计表，避免生产化早期引入额外写路径；后续可按同一输出契约落库。
   */
  async auditTrail(id: string) {
    const run = await this.prisma.agentRun.findUnique({
      where: { id },
      include: {
        plans: { orderBy: { version: 'asc' } },
        steps: { orderBy: [{ planVersion: 'asc' }, { mode: 'asc' }, { stepNo: 'asc' }] },
        approvals: { orderBy: { createdAt: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);

    const events: Array<Record<string, unknown>> = [
      {
        id: `${run.id}:run_created`,
        eventType: 'run_created',
        title: '创建 AgentRun',
        severity: 'info',
        timestamp: run.createdAt,
        status: run.status,
        detail: { goal: run.goal, taskType: run.taskType, input: run.input },
      },
      {
        id: `${run.id}:current_status`,
        eventType: 'current_status',
        title: `当前状态：${run.status}`,
        severity: run.status === 'failed' ? 'danger' : run.status === 'succeeded' ? 'ok' : run.status === 'cancelled' ? 'warn' : 'info',
        timestamp: run.updatedAt,
        status: run.status,
        detail: { error: run.error, output: run.output },
      },
    ];

    for (const plan of run.plans) {
      events.push({
        id: `${plan.id}:plan_created`,
        eventType: 'plan_created',
        title: `生成计划 v${plan.version}`,
        severity: 'info',
        timestamp: plan.createdAt,
        status: plan.status,
        planVersion: plan.version,
        detail: { taskType: plan.taskType, summary: plan.summary, risks: plan.risks, requiredApprovals: plan.requiredApprovals },
      });
    }

    for (const approval of run.approvals) {
      events.push({
        id: `${approval.id}:approval`,
        eventType: 'approval_recorded',
        title: `记录审批：${approval.approvalType}`,
        severity: 'warn',
        timestamp: approval.approvedAt ?? approval.createdAt,
        status: approval.status,
        detail: { target: approval.target, comment: approval.comment },
      });
    }

    for (const step of run.steps) {
      const failed = step.status === 'failed';
      events.push({
        id: `${step.id}:step_${step.status}`,
        eventType: `step_${step.status}`,
        title: failed ? `步骤失败：${step.name}` : `步骤${step.status === 'succeeded' ? '完成' : '记录'}：${step.name}`,
        severity: failed ? 'danger' : step.status === 'succeeded' ? 'ok' : 'info',
        timestamp: step.finishedAt ?? step.startedAt ?? step.createdAt,
        status: step.status,
        planVersion: step.planVersion,
        mode: step.mode,
        stepNo: step.stepNo,
        toolName: step.toolName,
        detail: { input: step.input, output: step.output, error: step.error },
      });
    }

    for (const artifact of run.artifacts) {
      events.push({
        id: `${artifact.id}:artifact_created`,
        eventType: 'artifact_created',
        title: `生成产物：${artifact.title}`,
        severity: artifact.status === 'final' ? 'ok' : 'info',
        timestamp: artifact.createdAt,
        status: artifact.status,
        stepNo: artifact.sourceStepNo,
        detail: { artifactType: artifact.artifactType },
      });
    }

    // 统一按时间升序输出，前端可直接形成排障时间线；相同时间用 id 保持稳定排序。
    return events.sort((a, b) => {
      const timeA = new Date(a.timestamp as Date).getTime();
      const timeB = new Date(b.timestamp as Date).getTime();
      return timeA === timeB ? String(a.id).localeCompare(String(b.id)) : timeA - timeB;
    });
  }

  /** Prisma Json 字段需要普通对象；DTO 类实例先投影为纯 JSON，避免 class 实例缺少 index signature。 */
  private buildApprovalTarget(approvedStepNos: number[] | undefined, confirmation: ExecuteAgentRunDto['confirmation'], fallback: 'all' | number[]): Prisma.InputJsonValue {
    return {
      approvedStepNos: approvedStepNos ?? fallback,
      confirmation: confirmation ? { confirmHighRisk: Boolean(confirmation.confirmHighRisk), confirmedRiskIds: confirmation.confirmedRiskIds ?? [] } : null,
    };
  }

  /** 返回已有 Run 的最新可展示结果，用于前端重试 createPlan 时实现请求级幂等。 */
  private async buildExistingRunResponse(agentRunId: string) {
    const record = await this.get(agentRunId);
    if (!record) throw new NotFoundException(`AgentRun 不存在：${agentRunId}`);
    return { agentRunId, status: record.status, plan: record.plans[0] ?? null, artifacts: record.artifacts, reused: true };
  }

  async createPlan(dto: CreateAgentPlanDto) {
    const clientRequestId = dto.clientRequestId?.trim();
    if (clientRequestId) {
      const existing = await this.prisma.agentRun.findFirst({
        where: { projectId: dto.projectId, input: { path: ['clientRequestId'], equals: clientRequestId } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return this.buildExistingRunResponse(existing.id);
    }

    // DTO 类实例没有 JSON index signature，显式转为普通对象再写入 Prisma Json 字段。
    const input = { projectId: dto.projectId, message: dto.message, context: dto.context ?? {}, attachments: dto.attachments ?? [], ...(clientRequestId ? { clientRequestId } : {}) };
    const run = await this.prisma.agentRun.create({
      data: { projectId: dto.projectId, chapterId: dto.context?.currentChapterId, agentType: 'CreativeAgent', status: 'planning', mode: 'plan', goal: dto.message, input: input as Prisma.InputJsonValue },
    });
    const result = await this.runtime.plan(run.id);
    return { agentRunId: run.id, status: 'waiting_approval', ...result };
  }

  get(id: string) {
    return this.prisma.agentRun.findUnique({
      where: { id },
      // 明确排序，保证前端总能把最新 Plan、对应 trace 和最新 Artifact 展示在正确位置。
      include: { plans: { orderBy: { version: 'desc' } }, steps: { orderBy: [{ planVersion: 'desc' }, { mode: 'asc' }, { stepNo: 'asc' }] }, artifacts: { orderBy: { createdAt: 'asc' } }, approvals: true },
    });
  }

  listByProject(projectId: string) {
    return this.prisma.agentRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: { plans: { take: 1, orderBy: { version: 'desc' } } } });
  }

  async act(id: string, dto: ExecuteAgentRunDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (!dto.approval) throw new BadRequestException('执行 Act 前必须审批计划');
    if (!['waiting_approval', 'waiting_review'].includes(run.status)) throw new BadRequestException(`当前状态 ${run.status} 不能执行 Act，请重新规划或使用重试入口`);

    await this.prisma.agentApproval.create({ data: { agentRunId: id, approvalType: 'plan', status: 'approved', target: this.buildApprovalTarget(dto.approvedStepNos, dto.confirmation, 'all'), approvedAt: new Date(), comment: dto.comment } });
    return this.runtime.act(id, dto.approvedStepNos, dto.confirmation);
  }

  async retry(id: string, dto: ExecuteAgentRunDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (!['failed', 'waiting_review'].includes(run.status)) throw new BadRequestException('只有 failed 或 waiting_review 状态可以重试执行');
    if (!dto.approval) throw new BadRequestException('重试 Act 前必须重新审批计划');

    await this.prisma.agentApproval.create({ data: { agentRunId: id, approvalType: 'retry', status: 'approved', target: this.buildApprovalTarget(dto.approvedStepNos, dto.confirmation, 'all'), approvedAt: new Date(), comment: dto.comment } });
    return this.runtime.act(id, dto.approvedStepNos, dto.confirmation);
  }

  /** 兼容设计文档中的步骤级审批接口：记录审批范围，真正执行仍由 /act 触发。 */
  async approveStep(id: string, dto: ExecuteAgentRunDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (!dto.approval) throw new BadRequestException('步骤审批必须显式 approval=true');

    await this.prisma.agentApproval.create({ data: { agentRunId: id, approvalType: 'step', status: 'approved', target: this.buildApprovalTarget(dto.approvedStepNos, dto.confirmation, []), approvedAt: new Date(), comment: dto.comment } });
    return this.get(id);
  }

  async replan(id: string, dto: ReplanAgentRunDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (run.status === 'acting') throw new BadRequestException('acting 状态不能重新规划，请等待执行结束或取消');

    await this.runtime.replan(id, dto.message);
    return this.get(id);
  }

  async cancel(id: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) throw new BadRequestException(`当前状态 ${run.status} 不能取消`);
    return this.prisma.agentRun.update({ where: { id }, data: { status: 'cancelled' } });
  }
}