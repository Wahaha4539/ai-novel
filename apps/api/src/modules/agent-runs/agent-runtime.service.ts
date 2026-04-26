import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentExecutorService, AgentWaitingReviewError } from './agent-executor.service';
import { AgentPlannerFailedError, AgentPlannerService, AgentPlanSpec } from './agent-planner.service';
import { AgentTraceService } from './agent-trace.service';

type AgentArtifactDraft = {
  artifactType: string;
  title: string;
  content: unknown;
};

/** 编排 AgentRun 状态机：Plan 阶段生成预览，Act 阶段执行已审批工具。 */
@Injectable()
export class AgentRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: AgentPlannerService,
    private readonly executor: AgentExecutorService,
    private readonly trace: AgentTraceService,
  ) {}

  async plan(agentRunId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);

    try {
      const plan = await this.planner.createPlan(run.goal);
      await this.trace.recordDecision(agentRunId, { name: '生成 Agent Plan', mode: 'plan', input: { goal: run.goal }, output: { taskType: plan.taskType, stepCount: plan.steps.length, plannerDiagnostics: plan.plannerDiagnostics } });
      const savedPlan = await this.prisma.agentPlan.create({
        data: {
          agentRunId,
          status: 'waiting_approval',
          taskType: plan.taskType,
          summary: plan.summary,
          assumptions: plan.assumptions as Prisma.InputJsonValue,
          risks: plan.risks as Prisma.InputJsonValue,
          steps: plan.steps as unknown as Prisma.InputJsonValue,
          requiredApprovals: plan.requiredApprovals as unknown as Prisma.InputJsonValue,
        },
      });

      const artifact = await this.prisma.agentArtifact.create({
        data: { agentRunId, artifactType: 'agent_plan_preview', title: 'Agent 执行计划预览', content: plan as unknown as Prisma.InputJsonValue, status: 'preview' },
      });

      const previewOutputs = await this.executor.execute(agentRunId, plan.steps, { mode: 'plan', approved: false, previewOnly: true });
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs);
      if (previewArtifacts.length) {
        await this.prisma.agentArtifact.createMany({
          data: previewArtifacts.map((preview) => ({
            agentRunId,
            artifactType: preview.artifactType,
            title: preview.title,
            content: preview.content as Prisma.InputJsonValue,
            status: 'preview',
          })),
        });
      }

      await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', taskType: plan.taskType, output: { planId: savedPlan.id } } });
      const artifacts = await this.prisma.agentArtifact.findMany({ where: { agentRunId }, orderBy: { createdAt: 'asc' } });
      return { plan: savedPlan, artifacts: artifacts.length ? artifacts : [artifact] };
    } catch (error) {
      await this.recordPlannerFailure(agentRunId, error);
      throw error;
    }
  }

  async act(agentRunId: string, approvedStepNos?: number[], confirmation?: { confirmHighRisk?: boolean; confirmedRiskIds?: string[] }) {
    const latestPlan = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    if (!latestPlan) throw new Error('缺少可执行计划');

    try {
      await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'acting', mode: 'act' } });
      const spec = { steps: latestPlan.steps } as unknown as Pick<AgentPlanSpec, 'steps'>;
      const outputs = await this.executor.execute(agentRunId, spec.steps, { mode: 'act', approved: true, approvedStepNos, confirmation, reuseSucceeded: true });
      const artifactDrafts = this.buildExecutionArtifacts(String(latestPlan.taskType), outputs);
      if (artifactDrafts.length) {
        await this.prisma.agentArtifact.createMany({
          data: artifactDrafts.map((artifact) => ({
            agentRunId,
            artifactType: artifact.artifactType,
            title: artifact.title,
            content: artifact.content as Prisma.InputJsonValue,
            status: 'final',
          })),
        });
      }
      const updated = await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'succeeded', output: { outputs } as unknown as Prisma.InputJsonValue } });
      return updated;
    } catch (error) {
      if (error instanceof AgentWaitingReviewError) {
        return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_review', error: error.message } });
      }
      await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }

  async replan(agentRunId: string, goal?: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);

    // 重新规划保留原 Run 和历史 Plan/Step/Artifact，新增 plan version 方便用户回看变化。
    const nextGoal = goal?.trim() || run.goal;
    const latest = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { goal: nextGoal, status: 'planning', mode: 'plan', error: null } });

    try {
      const plan = await this.planner.createPlan(nextGoal);
      await this.trace.recordDecision(agentRunId, { name: '重新生成 Agent Plan', mode: 'plan', input: { goal: nextGoal, replannedFromVersion: latest?.version ?? null }, output: { taskType: plan.taskType, stepCount: plan.steps.length, plannerDiagnostics: plan.plannerDiagnostics } });
      const savedPlan = await this.prisma.agentPlan.create({
        data: {
          agentRunId,
          version: (latest?.version ?? 0) + 1,
          status: 'waiting_approval',
          taskType: plan.taskType,
          summary: plan.summary,
          assumptions: plan.assumptions as Prisma.InputJsonValue,
          risks: plan.risks as Prisma.InputJsonValue,
          steps: plan.steps as unknown as Prisma.InputJsonValue,
          requiredApprovals: plan.requiredApprovals as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.agentArtifact.create({
        data: { agentRunId, artifactType: 'agent_plan_preview', title: `Agent 执行计划预览 v${savedPlan.version}`, content: plan as unknown as Prisma.InputJsonValue, status: 'preview' },
      });

      const previewOutputs = await this.executor.execute(agentRunId, plan.steps, { mode: 'plan', approved: false, previewOnly: true });
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs);
      if (previewArtifacts.length) {
        await this.prisma.agentArtifact.createMany({
          data: previewArtifacts.map((preview) => ({
            agentRunId,
            artifactType: preview.artifactType,
            title: `${preview.title} v${savedPlan.version}`,
            content: preview.content as Prisma.InputJsonValue,
            status: 'preview',
          })),
        });
      }

      return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', taskType: plan.taskType, output: { planId: savedPlan.id, replannedFromVersion: latest?.version ?? null } } });
    } catch (error) {
      await this.recordPlannerFailure(agentRunId, error);
      throw error;
    }
  }

  /** Planner 失败时同时写入结构化诊断 Artifact，方便前端直接回显失败阶段和修复建议。 */
  private async recordPlannerFailure(agentRunId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = error instanceof AgentPlannerFailedError ? error.diagnostics : { failures: [{ stage: 'unknown', message }] };
    await this.prisma.agentArtifact.create({
      data: {
        agentRunId,
        artifactType: 'planner_diagnostics',
        title: 'Planner 失败诊断',
        content: { message, diagnostics } as unknown as Prisma.InputJsonValue,
        status: 'final',
      },
    });
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'failed', error: message, output: { plannerDiagnostics: diagnostics } as unknown as Prisma.InputJsonValue } });
  }

  /** Plan 阶段执行只读预览步骤后，把可展示内容提前提升为 Artifact。 */
  private buildPreviewArtifacts(taskType: string, outputs: Record<number, unknown>): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      return [
        ...(outputs[2] ? [{ artifactType: 'outline_preview', title: '大纲预览', content: outputs[2] }] : []),
        ...(outputs[3] ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: outputs[3] }] : []),
      ];
    }

    if (taskType === 'project_import_preview') {
      const preview = outputs[2] as { projectProfile?: unknown; characters?: unknown; lorebookEntries?: unknown; volumes?: unknown; chapters?: unknown; risks?: unknown } | undefined;
      return [
        ...(preview ? [{ artifactType: 'project_profile_preview', title: '项目资料预览', content: preview.projectProfile ?? {} }] : []),
        ...(preview ? [{ artifactType: 'characters_preview', title: '角色预览', content: preview.characters ?? [] }] : []),
        ...(preview ? [{ artifactType: 'lorebook_preview', title: '设定预览', content: preview.lorebookEntries ?? [] }] : []),
        ...(preview ? [{ artifactType: 'outline_preview', title: '卷与章节预览', content: { volumes: preview.volumes ?? [], chapters: preview.chapters ?? [], risks: preview.risks ?? [] } }] : []),
        ...(outputs[3] ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: outputs[3] }] : []),
      ];
    }

    if (taskType === 'chapter_write' || taskType === 'chapter_polish') {
      return outputs[2] ? [{ artifactType: 'chapter_context_preview', title: '章节上下文预览', content: outputs[2] }] : [];
    }

    return [];
  }

  /**
   * 将关键 Tool 输出提升为 AgentArtifact，便于前端按业务类型预览，而不是只看原始 step JSON。
   * 这里不重新解释 LLM 内容，只按已审批执行结果做只读拆分，避免引入额外副作用。
   */
  private buildExecutionArtifacts(taskType: string, outputs: Record<number, unknown>): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      const preview = outputs[2];
      const validation = outputs[3];
      const persist = outputs[4];
      return [
        ...(preview ? [{ artifactType: 'outline_preview', title: '大纲预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: validation }] : []),
        ...(persist ? [{ artifactType: 'outline_persist_result', title: '大纲写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'project_import_preview') {
      const preview = outputs[2] as { projectProfile?: unknown; characters?: unknown; lorebookEntries?: unknown; volumes?: unknown; chapters?: unknown; risks?: unknown } | undefined;
      const validation = outputs[3];
      const persist = outputs[4];
      if (!preview) {
        return [
          ...(validation ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: validation }] : []),
          ...(persist ? [{ artifactType: 'import_persist_result', title: '导入写入结果', content: persist }] : []),
        ];
      }

      return [
        { artifactType: 'project_profile_preview', title: '项目资料预览', content: preview.projectProfile ?? {} },
        { artifactType: 'characters_preview', title: '角色预览', content: preview.characters ?? [] },
        { artifactType: 'lorebook_preview', title: '设定预览', content: preview.lorebookEntries ?? [] },
        { artifactType: 'outline_preview', title: '卷与章节预览', content: { volumes: preview.volumes ?? [], chapters: preview.chapters ?? [], risks: preview.risks ?? [] } },
        ...(validation ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: validation }] : []),
        ...(persist ? [{ artifactType: 'import_persist_result', title: '导入写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'chapter_write') {
      const draft = outputs[4] ?? outputs[3];
      const validation = outputs[5];
      const autoRepair = outputs[6];
      const facts = outputs[7];
      const memory = outputs[8];
      const memoryReview = outputs[9];
      return [
        ...(draft ? [{ artifactType: 'chapter_generation_quality_report', title: '生成前与召回质量报告', content: { preflight: this.readPath(draft, ['preflight']), retrievalDiagnostics: this.readPath(draft, ['retrievalPayload', 'diagnostics']) } }] : []),
        ...(draft ? [{ artifactType: 'chapter_draft_result', title: '章节草稿结果', content: draft }] : []),
        ...(validation ? [{ artifactType: 'fact_validation_report', title: '事实校验报告', content: validation }] : []),
        ...(autoRepair ? [{ artifactType: 'auto_repair_report', title: '有界自动修复报告', content: autoRepair }] : []),
        ...(facts ? [{ artifactType: 'fact_extraction_report', title: '事实抽取报告', content: facts }] : []),
        ...(memory ? [{ artifactType: 'memory_rebuild_report', title: '记忆重建报告', content: memory }] : []),
        ...(memoryReview ? [{ artifactType: 'memory_review_report', title: '记忆复核报告', content: memoryReview }] : []),
      ];
    }

    if (taskType === 'chapter_polish') {
      const polish = outputs[3];
      const validation = outputs[4];
      const autoRepair = outputs[5];
      const facts = outputs[6];
      const memory = outputs[7];
      const memoryReview = outputs[8];
      return [
        ...(polish ? [{ artifactType: 'chapter_polish_result', title: '章节润色结果', content: polish }] : []),
        ...(validation ? [{ artifactType: 'fact_validation_report', title: '事实校验报告', content: validation }] : []),
        ...(autoRepair ? [{ artifactType: 'auto_repair_report', title: '有界自动修复报告', content: autoRepair }] : []),
        ...(facts ? [{ artifactType: 'fact_extraction_report', title: '事实抽取报告', content: facts }] : []),
        ...(memory ? [{ artifactType: 'memory_rebuild_report', title: '记忆重建报告', content: memory }] : []),
        ...(memoryReview ? [{ artifactType: 'memory_review_report', title: '记忆复核报告', content: memoryReview }] : []),
      ];
    }

    return [];
  }

  private readPath(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
  }
}