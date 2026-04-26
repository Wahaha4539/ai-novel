import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAgentPlanDto, ReplanAgentRunDto } from './dto/create-agent-plan.dto';
import { ExecuteAgentRunDto } from './dto/execute-agent-run.dto';
import { AgentRuntimeService } from './agent-runtime.service';

@Injectable()
export class AgentRunsService {
  constructor(private readonly prisma: PrismaService, private readonly runtime: AgentRuntimeService) {}

  /** Prisma Json 字段需要普通对象；DTO 类实例先投影为纯 JSON，避免 class 实例缺少 index signature。 */
  private buildApprovalTarget(approvedStepNos: number[] | undefined, confirmation: ExecuteAgentRunDto['confirmation'], fallback: 'all' | number[]): Prisma.InputJsonValue {
    return {
      approvedStepNos: approvedStepNos ?? fallback,
      confirmation: confirmation ? { confirmHighRisk: Boolean(confirmation.confirmHighRisk), confirmedRiskIds: confirmation.confirmedRiskIds ?? [] } : null,
    };
  }

  async createPlan(dto: CreateAgentPlanDto) {
    // DTO 类实例没有 JSON index signature，显式转为普通对象再写入 Prisma Json 字段。
    const input = { projectId: dto.projectId, message: dto.message, context: dto.context ?? {}, attachments: dto.attachments ?? [] };
    const run = await this.prisma.agentRun.create({
      data: { projectId: dto.projectId, chapterId: dto.context?.currentChapterId, agentType: 'CreativeAgent', status: 'planning', mode: 'plan', goal: dto.message, input: input as Prisma.InputJsonValue },
    });
    const result = await this.runtime.plan(run.id);
    return { agentRunId: run.id, status: 'waiting_approval', ...result };
  }

  get(id: string) {
    return this.prisma.agentRun.findUnique({
      where: { id },
      // 明确排序，保证前端总能把最新 Plan 和最新 Artifact 展示在正确位置。
      include: { plans: { orderBy: { version: 'desc' } }, steps: { orderBy: { stepNo: 'asc' } }, artifacts: { orderBy: { createdAt: 'asc' } }, approvals: true },
    });
  }

  listByProject(projectId: string) {
    return this.prisma.agentRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: { plans: { take: 1, orderBy: { version: 'desc' } } } });
  }

  async act(id: string, dto: ExecuteAgentRunDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${id}`);
    if (!dto.approval) throw new BadRequestException('执行 Act 前必须审批计划');

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

  cancel(id: string) {
    return this.prisma.agentRun.update({ where: { id }, data: { status: 'cancelled' } });
  }
}